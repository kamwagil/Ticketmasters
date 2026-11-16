import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/infra';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { OrderService } from '../src/modules/orders/order.service';
import { buildFixture, checkout, createApp, deliverWebhook, Fixture, gatewayWebhook, purchase, resetDb, storefront } from './helpers';

describe('Purchase flow (acceptance scenarios 1, 4, 5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
  });
  afterAll(() => app.close());

  it('Scenario 1: an order from Website 1 is recorded centrally under Website 1 with its payment config, tickets and branded email', async () => {
    const w1 = fx.brands[0];
    const p = await purchase(app, w1, fx, { email: 'asha@example.com', name: 'Asha Mwende', quantity: 2 });

    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference }, include: { items: true, tickets: true, payments: true, history: true, commissions: true } });
    expect(order.brandId).toBe(w1.id);
    expect(order.sourceDomain).toBe(w1.domain);
    expect(order.legalEntityId).toBe(fx.legalEntityId);
    expect(order.status).toBe('TICKETS_ISSUED');
    expect(order.paymentStatus).toBe('PAID');
    expect(order.gatewayCode).toBe('sandbox');
    expect(order.policyVersions).toEqual({ TERMS: 1, REFUND: 2, PRIVACY: 1 });

    // 2 × 1,000.00 + 4% service fee
    expect(order.subtotalMinor).toBe(200000n);
    expect(order.feesMinor).toBe(8000n);
    expect(order.totalMinor).toBe(208000n);
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0].providerAccountId).toBe(fx.accountId);
    expect(order.payments[0].status).toBe('SUCCEEDED');
    expect(order.payments[0].amountMinor).toBe(208000n);

    expect(order.history.map((h) => h.toStatus)).toEqual(expect.arrayContaining(['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'PAID', 'TICKETS_ISSUED']));

    // Tickets: one per unit, each with an unpredictable QR token stored only as a hash.
    expect(order.tickets).toHaveLength(2);
    expect(order.tickets.every((t) => t.status === 'VALID' && t.brandId === w1.id && t.eventId === fx.eventId)).toBe(true);
    const tokens = await prisma.ticketQrToken.findMany({ where: { ticketId: { in: order.tickets.map((t) => t.id) } } });
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens.map((t) => t.tokenHash)).size).toBe(2);
    expect(tokens.every((t) => /^[0-9a-f]{64}$/.test(t.tokenHash) && t.tokenEnc.startsWith('v1.'))).toBe(true);

    // Inventory moved from reserved to sold.
    const inv = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(inv).toMatchObject({ total: 100, sold: 2, reserved: 0 });

    // Ledger: one balanced capture journal with the full allocation.
    const entries = await prisma.financialLedgerEntry.findMany({ where: { orderId: order.id } });
    const sum = (account: string, direction: string) => entries.filter((e) => e.account === account && e.direction === direction).reduce((s, e) => s + e.amountMinor, 0n);
    expect(sum('GATEWAY_CLEARING', 'DEBIT')).toBe(208000n);
    expect(sum('SERVICE_FEE_REVENUE', 'CREDIT')).toBe(8000n);
    expect(sum('PLATFORM_COMMISSION_REVENUE', 'CREDIT')).toBe(10000n); // 5% of 2,000.00
    expect(sum('PROMOTER_PAYABLE', 'CREDIT')).toBe(190000n);
    const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0n);
    const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0n);
    expect(debits).toBe(credits);

    // Emails are queued for the originating brand and rendered with that brand's identity.
    const jobs = await prisma.emailJob.findMany({ where: { orderId: order.id } });
    expect(jobs.map((j) => j.type).sort()).toEqual(['ORDER_CONFIRMATION', 'TICKET_DELIVERY']);
    expect(jobs.every((j) => j.brandId === w1.id && j.toAddress === 'asha@example.com')).toBe(true);
    const rendered = await app.get(NotificationService).render(w1.id, 'ORDER_CONFIRMATION', 'EMAIL', jobs[0].payload as Record<string, unknown>);
    expect(rendered.from).toBe('"Website 1 Tickets" <tickets@website1.test>');
    expect(rendered.html).toContain('Website 1');
    expect(rendered.html).toContain('#112211');
    expect(rendered.html).toContain('help@website1.test');
    expect(rendered.html).toContain('https://website1.test/refund-policy');
    expect(rendered.html).not.toContain('Website 2');
    expect(rendered.subject).toContain(order.reference);
  });

  it('never treats the storefront return page as proof of payment', async () => {
    const w2 = fx.brands[1];
    const c = await checkout(app, w2, fx, { email: 'unpaid@example.com' });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe('AWAITING_PAYMENT');
    expect(c.body.payment.checkoutUrl).toContain('/sandbox-gateway/pay/');

    // The buyer "returns" and the storefront asks the platform to verify: the gateway still says pending.
    const v = await storefront(app, w2).post(`/orders/${c.body.orderReference}/verify?email=unpaid@example.com`);
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('AWAITING_PAYMENT');
    expect(await prisma.ticket.count({ where: { order: { reference: c.body.orderReference } } })).toBe(0);
  });

  it('Scenario 4: a failed payment marks the order failed, releases the reservation and issues no ticket', async () => {
    const before = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    const c = await checkout(app, fx.brands[2], fx, { email: 'declined@example.com', quantity: 3 });
    expect(c.status).toBe(201);
    const held = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(held.reserved).toBe(before.reserved + 3);

    const res = await deliverWebhook(app, await gatewayWebhook(app, c.body.payment.reference, 'failed'));
    expect(res.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { reference: c.body.orderReference }, include: { tickets: true, payments: true, reservations: true } });
    expect(order.status).toBe('FAILED');
    expect(order.paymentStatus).toBe('FAILED');
    expect(order.tickets).toHaveLength(0);
    expect(order.payments[0].status).toBe('FAILED');
    expect(order.reservations.every((r) => r.status === 'RELEASED')).toBe(true);
    const after = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(after.reserved).toBe(before.reserved);
    expect(after.sold).toBe(before.sold);
    expect(await prisma.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('Scenario 4b: an unpaid reservation expires and its tickets return to the shared pool', async () => {
    const before = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    const c = await checkout(app, fx.brands[3], fx, { email: 'slow@example.com', quantity: 4 });
    await prisma.order.update({ where: { reference: c.body.orderReference }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    expect(await app.get(OrderService).expireStale()).toBe(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { reference: c.body.orderReference }, include: { reservations: true } });
    expect(order.status).toBe('EXPIRED');
    expect(order.reservations.every((r) => r.status === 'EXPIRED')).toBe(true);
    const after = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(after.reserved).toBe(before.reserved);
    expect(await prisma.ticket.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('Scenario 5: the same successful webhook delivered many times is processed exactly once', async () => {
    const p = await purchase(app, fx.brands[4], fx, { email: 'dupe@example.com', quantity: 2 });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference } });
    const snapshot = async () => ({
      tickets: await prisma.ticket.count({ where: { orderId: order.id } }),
      ledger: await prisma.financialLedgerEntry.count({ where: { orderId: order.id } }),
      journals: await prisma.ledgerTransaction.count({ where: { orderId: order.id } }),
      emails: await prisma.emailJob.count({ where: { orderId: order.id } }),
      payables: await prisma.promoterPayable.count({ where: { orderId: order.id } }),
      sold: (await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } })).sold,
    });
    const first = await snapshot();
    expect(first.tickets).toBe(2);

    // Sequential retries of the identical event, then a burst of concurrent ones.
    for (let i = 0; i < 3; i++) {
      const r = await deliverWebhook(app, p.webhook);
      expect(r.status).toBe(200);
      expect(r.body.duplicate).toBe(true);
    }
    const burst = await Promise.all(Array.from({ length: 8 }, () => deliverWebhook(app, p.webhook)));
    expect(burst.every((r) => r.status === 200)).toBe(true);

    // A second, distinct event for the same transaction (gateways do this too).
    const again = await gatewayWebhook(app, p.paymentReference, 'success');
    expect(again.rawBody).not.toBe(p.webhook.rawBody);
    expect((await deliverWebhook(app, again)).status).toBe(200);

    expect(await snapshot()).toEqual(first);
    expect(await prisma.payment.count({ where: { orderId: order.id, status: 'SUCCEEDED' } })).toBe(1);
  });

  it('rejects webhooks with a bad signature and records the rejection', async () => {
    const c = await checkout(app, fx.brands[0], fx, { email: 'forged@example.com' });
    const wh = await gatewayWebhook(app, c.body.payment.reference, 'success');
    const forged = await deliverWebhook(app, { ...wh, signature: 'deadbeef' });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    const tampered = await deliverWebhook(app, { ...wh, rawBody: wh.rawBody.replace('charge.success', 'charge.success ') });
    expect(tampered.status).toBe(401);
    expect(await prisma.paymentWebhookEvent.count({ where: { status: 'REJECTED', signatureValid: false } })).toBeGreaterThanOrEqual(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { reference: c.body.orderReference } })).status).toBe('AWAITING_PAYMENT');
  });

  it('refuses to issue tickets when the captured amount does not match the order', async () => {
    const c = await checkout(app, fx.brands[0], fx, { email: 'underpaid@example.com', quantity: 2 });
    // The gateway captured less than the order total.
    await prisma.sandboxGatewayTransaction.update({ where: { reference: c.body.payment.reference }, data: { amountMinor: 100n } });
    await deliverWebhook(app, await gatewayWebhook(app, c.body.payment.reference, 'success'));
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: c.body.orderReference }, include: { tickets: true } });
    expect(order.tickets).toHaveLength(0);
    expect(order.needsAttention).toBe(true);
    expect(order.paymentStatus).not.toBe('PAID');
    expect(await prisma.alert.count({ where: { type: 'PAYMENT_MISMATCH' } })).toBe(1);
  });

  it('replays an idempotent checkout instead of reserving twice', async () => {
    const before = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    const key = 'idem-key-123';
    const a = await checkout(app, fx.brands[1], fx, { email: 'retry@example.com', quantity: 2, idempotencyKey: key });
    const b = await checkout(app, fx.brands[1], fx, { email: 'retry@example.com', quantity: 2, idempotencyKey: key });
    expect(a.status).toBe(201);
    expect(b.body.orderReference).toBe(a.body.orderReference);
    const after = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(after.reserved).toBe(before.reserved + 2);
    const reused = await checkout(app, fx.brands[1], fx, { email: 'retry@example.com', quantity: 5, idempotencyKey: key });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
