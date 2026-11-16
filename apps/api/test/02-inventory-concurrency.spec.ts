import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/infra';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { OrderService } from '../src/modules/orders/order.service';
import { buildFixture, checkout, concurrently, createApp, deliverWebhook, Fixture, gatewayWebhook, resetDb, storefront } from './helpers';

describe('Shared inventory under concurrency (acceptance scenarios 3 and 10)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb(prisma);
    fx = await buildFixture(prisma, { total: 100, maxPerOrder: 10 });
  });

  it('Scenario 3: 100 tickets, five storefronts selling at once, never more than 100 valid tickets', async () => {
    // 60 buyers x 3 tickets = 180 requested against 100 available, spread over all five websites.
    const attempts = await Promise.all(
      Array.from({ length: 60 }, (_, i) => checkout(app, fx.brands[i % 5], fx, { email: `buyer${i}@example.com`, quantity: 3 })),
    );
    const ok = attempts.filter((a) => a.status === 201);
    const rejected = attempts.filter((a) => a.status !== 201);
    expect(ok).toHaveLength(33); // 33 x 3 = 99; the 100th ticket cannot satisfy an order of 3
    expect(rejected.every((a) => a.status === 409 && a.body.error.code === 'INSUFFICIENT_INVENTORY')).toBe(true);

    let inv = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(inv).toMatchObject({ total: 100, sold: 0, reserved: 99 });

    // Every gateway confirmation lands at the same moment.
    const webhooks = await Promise.all(ok.map((a) => gatewayWebhook(app, a.body.payment.reference, 'success')));
    const delivered = await Promise.all(webhooks.map((w) => deliverWebhook(app, w)));
    expect(delivered.every((r) => r.status === 200)).toBe(true);

    inv = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(inv).toMatchObject({ total: 100, sold: 99, reserved: 0 });
    const valid = await prisma.ticket.count({ where: { ticketCategoryId: fx.categoryId, status: 'VALID' } });
    expect(valid).toBe(99);
    expect(valid).toBeLessThanOrEqual(100);

    // Sales are attributed per storefront and add up to the central total.
    const byBrand = await prisma.ticket.groupBy({ by: ['brandId'], where: { ticketCategoryId: fx.categoryId }, _count: true });
    expect(byBrand.reduce((s, b) => s + b._count, 0)).toBe(99);
    expect(byBrand.length).toBeGreaterThan(1);

    // The one remaining ticket is visible to every storefront and can be sold exactly once.
    for (const b of fx.brands) {
      const live = await storefront(app, b).get(`/events/${fx.eventId}/inventory`);
      expect(live.body.categories.find((c: any) => c.id === fx.categoryId).available).toBe(1);
    }
    const last = await Promise.all(fx.brands.map((b, i) => checkout(app, b, fx, { email: `last${i}@example.com`, quantity: 1 })));
    expect(last.filter((a) => a.status === 201)).toHaveLength(1);
    expect(last.filter((a) => a.status === 409)).toHaveLength(4);

    const recon = await app.get(InventoryService).reconcile(fx.eventId);
    expect(recon.issues).toEqual([]);
  });

  it('the database itself refuses to oversell even if application checks were bypassed', async () => {
    await expect(
      prisma.$executeRaw`UPDATE "ticket_inventory" SET "sold" = 101 WHERE "ticketCategoryId" = ${fx.categoryId}::uuid`,
    ).rejects.toThrow(/ticket_inventory_no_oversell/);
    await expect(
      prisma.$executeRaw`UPDATE "ticket_inventory" SET "reserved" = 60, "sold" = 50 WHERE "ticketCategoryId" = ${fx.categoryId}::uuid`,
    ).rejects.toThrow(/ticket_inventory_no_oversell/);
  });

  it('a payment that arrives after its reservation expired is allocated only if stock remains, otherwise queued for refund', async () => {
    await prisma.ticketInventory.update({ where: { ticketCategoryId: fx.categoryId }, data: { total: 2 } });
    await prisma.inventoryMovement.create({ data: { ticketCategoryId: fx.categoryId, type: 'ADJUSTMENT', quantity: 98, deltaTotal: -98 } });

    const slow = await checkout(app, fx.brands[0], fx, { email: 'slow@example.com', quantity: 2 });
    expect(slow.status).toBe(201);
    await prisma.order.update({ where: { reference: slow.body.orderReference }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await app.get(OrderService).expireStale();

    // Someone else buys both tickets on another website in the meantime.
    const fast = await checkout(app, fx.brands[1], fx, { email: 'fast@example.com', quantity: 2 });
    expect(fast.status).toBe(201);
    await deliverWebhook(app, await gatewayWebhook(app, fast.body.payment.reference, 'success'));

    // Now the slow buyer's payment succeeds at the gateway.
    await deliverWebhook(app, await gatewayWebhook(app, slow.body.payment.reference, 'success'));
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: slow.body.orderReference }, include: { tickets: true, refunds: true } });
    expect(order.status).toBe('PAID');
    expect(order.needsAttention).toBe(true);
    expect(order.tickets).toHaveLength(0);
    expect(order.refunds).toHaveLength(1);
    expect(order.refunds[0]).toMatchObject({ status: 'REQUESTED', amountMinor: order.totalMinor, requestedByType: 'SYSTEM' });
    expect(await prisma.ticket.count({ where: { ticketCategoryId: fx.categoryId, status: 'VALID' } })).toBe(2);
    expect(await prisma.alert.count({ where: { type: 'PAID_ORDER_UNFULFILLABLE' } })).toBe(1);
  });

  it('Scenario 10: a burst across storefronts keeps inventory, payments and the ledger consistent', async () => {
    await prisma.ticketInventory.update({ where: { ticketCategoryId: fx.categoryId }, data: { total: 400 } });
    await prisma.inventoryMovement.create({ data: { ticketCategoryId: fx.categoryId, type: 'ADJUSTMENT', quantity: 300, deltaTotal: 300 } });

    const started = Date.now();
    // 250 simultaneous checkouts of 1-4 tickets with browsing traffic in parallel.
    const browse = Array.from({ length: 100 }, (_, i) => () => storefront(app, fx.brands[i % 5]).get(i % 2 ? '/events' : `/events/${fx.eventId}`).then((r) => r));
    const buys = Array.from({ length: 250 }, (_, i) => () => checkout(app, fx.brands[i % 5], fx, { email: `spike${i}@example.com`, quantity: (i % 4) + 1 }));
    const [browsed, attempts] = await Promise.all([concurrently(browse, 30), concurrently(buys, 90)]);
    expect(browsed.every((r) => r.status === 200)).toBe(true);
    const ok = attempts.filter((a) => a.status === 201);
    expect(attempts.every((a) => a.status === 201 || a.status === 409)).toBe(true); // no 5xx under load

    // 70% pay, 20% are declined, 10% abandon; a third of the webhooks are delivered twice.
    await concurrently(
      ok.map((a, i) => async () => {
        if (i % 10 === 9) return;
        const wh = await gatewayWebhook(app, a.body.payment.reference, i % 10 >= 7 ? 'failed' : 'success');
        await Promise.all(i % 3 === 0 ? [deliverWebhook(app, wh), deliverWebhook(app, wh)] : [deliverWebhook(app, wh)]);
      }),
      60,
    );

    const inv = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    const validTickets = await prisma.ticket.count({ where: { ticketCategoryId: fx.categoryId, status: 'VALID' } });
    const paidQty = (await prisma.orderItem.aggregate({ where: { order: { status: 'TICKETS_ISSUED' } }, _sum: { quantity: true } }))._sum.quantity ?? 0;
    const heldQty = (await prisma.inventoryReservation.aggregate({ where: { status: 'ACTIVE' }, _sum: { quantity: true } }))._sum.quantity ?? 0;
    expect(inv.sold + inv.reserved).toBeLessThanOrEqual(400);
    expect(validTickets).toBe(inv.sold);
    expect(paidQty).toBe(inv.sold);
    expect(heldQty).toBe(inv.reserved);

    // Money: exactly one successful payment and one balanced capture journal per issued order.
    const issued = await prisma.order.findMany({ where: { status: 'TICKETS_ISSUED' }, select: { id: true, totalMinor: true } });
    expect(issued.length).toBeGreaterThan(0);
    expect(await prisma.payment.count({ where: { status: 'SUCCEEDED' } })).toBe(issued.length);
    expect(await prisma.ledgerTransaction.count({ where: { type: 'PAYMENT_CAPTURE' } })).toBe(issued.length);
    const clearing = await prisma.financialLedgerEntry.aggregate({ where: { account: 'GATEWAY_CLEARING', direction: 'DEBIT' }, _sum: { amountMinor: true } });
    expect(clearing._sum.amountMinor).toBe(issued.reduce((s, o) => s + o.totalMinor, 0n));
    const [{ diff }] = await prisma.$queryRaw<{ diff: bigint }[]>`
      SELECT COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::bigint AS diff FROM "financial_ledger_entries"`;
    expect(diff).toBe(0n);

    expect((await app.get(InventoryService).reconcile(fx.eventId)).issues).toEqual([]);
    console.log(`spike: ${attempts.length} checkouts (${ok.length} reserved), ${issued.length} paid orders, ${inv.sold} tickets sold, ${Date.now() - started} ms`);
  });
});
