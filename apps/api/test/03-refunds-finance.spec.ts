import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/infra';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { admin, buildFixture, createApp, Fixture, login, purchase, resetDb } from './helpers';

describe('Refunds, ledger, settlements and reconciliation (acceptance scenario 6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;
  let finance: string;
  let finance2: string;
  let support: string;
  let superadmin: string;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
    [finance, finance2, support, superadmin] = await Promise.all([
      login(app, fx.users.finance.email), login(app, fx.users.finance2.email), login(app, fx.users.support1.email), login(app, fx.users.superadmin.email),
    ]);
  });
  afterAll(() => app.close());

  const ledgerSum = async (orderId: string, account: string) => {
    const rows = await prisma.financialLedgerEntry.findMany({ where: { orderId, account: account as any } });
    return rows.reduce((s, e) => s + (e.direction === 'CREDIT' ? e.amountMinor : -e.amountMinor), 0n);
  };

  it('Scenario 6: an authorised full refund is recorded, revokes the tickets and keeps the ledger auditable', async () => {
    const p = await purchase(app, fx.brands[0], fx, { email: 'refund-me@example.com', quantity: 2 });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference }, include: { tickets: true } });
    const soldBefore = (await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } })).sold;

    // Support escalates; they cannot approve.
    const req = await admin(app, support).post(`/orders/${order.id}/refunds`, { reason: 'Customer cannot attend, approved by policy' }).set('Idempotency-Key', 'refund-1');
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ status: 'REQUESTED', amountMinor: 208000 });
    const again = await admin(app, support).post(`/orders/${order.id}/refunds`, { reason: 'Customer cannot attend, approved by policy' }).set('Idempotency-Key', 'refund-1');
    expect(again.body.id).toBe(req.body.id); // same click twice = one request
    expect((await admin(app, support).post(`/refunds/${req.body.id}/approve`)).status).toBe(403);

    // A second full refund request cannot be stacked on top of the first.
    const second = await admin(app, finance).post(`/orders/${order.id}/refunds`, { reason: 'Duplicate attempt to refund' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('NOTHING_TO_REFUND');

    // Nothing has changed yet: tickets still valid until an authorised approval.
    expect(await prisma.ticket.count({ where: { orderId: order.id, status: 'VALID' } })).toBe(2);

    const approved = await admin(app, finance).post(`/refunds/${req.body.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('SUCCEEDED');
    expect(approved.body.providerRefundId).toMatch(/^sbxr_/);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { tickets: true, history: true } });
    expect(after.status).toBe('REFUNDED');
    expect(after.paymentStatus).toBe('REFUNDED');
    expect(after.refundedMinor).toBe(208000n);
    expect(after.tickets.every((t) => t.status === 'REFUNDED')).toBe(true);
    expect(await prisma.ticketQrToken.count({ where: { ticketId: { in: after.tickets.map((t) => t.id) }, active: true } })).toBe(0);
    expect((await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } })).sold).toBe(soldBefore - 2);

    // Ledger: the original entries are untouched and a reversing journal nets every account to zero.
    expect(await prisma.ledgerTransaction.count({ where: { orderId: order.id, type: 'PAYMENT_CAPTURE' } })).toBe(1);
    expect(await prisma.ledgerTransaction.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(1);
    for (const account of ['SERVICE_FEE_REVENUE', 'PLATFORM_COMMISSION_REVENUE', 'PROMOTER_PAYABLE']) {
      expect(await ledgerSum(order.id, account)).toBe(0n);
    }
    const payables = await prisma.promoterPayable.findMany({ where: { orderId: order.id } });
    expect(payables.reduce((s, x) => s + x.amountMinor, 0n)).toBe(0n);

    // Audit trail and customer notification, sent as the originating brand.
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'refund', entityId: req.body.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['refund.request', 'refund.approve', 'refund.processed']));
    const email = await prisma.emailJob.findFirstOrThrow({ where: { orderId: order.id, type: 'REFUND_CONFIRMATION' } });
    expect(email.brandId).toBe(fx.brands[0].id);

    // Approving again, or refunding again, is refused.
    expect((await admin(app, finance).post(`/refunds/${req.body.id}/approve`)).status).toBe(409);
    expect((await admin(app, finance).post(`/orders/${order.id}/refunds`, { reason: 'Refund the order again' })).status).toBe(409);
    expect((await app.get(InventoryService).reconcile(fx.eventId)).issues).toEqual([]);
  });

  it('partial refunds revoke only the selected ticket and allocate proportionally with no rounding drift', async () => {
    const p = await purchase(app, fx.brands[1], fx, { email: 'partial@example.com', quantity: 3 });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference }, include: { tickets: true } });
    expect(order.totalMinor).toBe(312000n);

    const r1 = await admin(app, finance).post(`/orders/${order.id}/refunds`, { ticketIds: [order.tickets[0].id], reason: 'One guest cancelled' });
    expect(r1.body.amountMinor).toBe(104000);
    // The requester cannot approve their own request (segregation of duties).
    const self = await admin(app, finance).post(`/refunds/${r1.body.id}/approve`);
    expect(self.status).toBe(403);
    expect((await admin(app, finance2).post(`/refunds/${r1.body.id}/approve`)).body.status).toBe('SUCCEEDED');

    let o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { tickets: true } });
    expect(o.status).toBe('PARTIALLY_REFUNDED');
    expect(o.tickets.filter((t) => t.status === 'REFUNDED').map((t) => t.id)).toEqual([order.tickets[0].id]);
    expect(o.tickets.filter((t) => t.status === 'VALID')).toHaveLength(2);

    // An already-refunded ticket cannot be refunded again.
    const dup = await admin(app, finance).post(`/orders/${order.id}/refunds`, { ticketIds: [order.tickets[0].id], reason: 'Refund the same ticket twice' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TICKET_NOT_REFUNDABLE');
    // Nor can more than the remaining balance be refunded.
    const over = await admin(app, finance).post(`/orders/${order.id}/refunds`, { amountMinor: 300000, reason: 'Refund more than was paid' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');

    const r2 = await admin(app, finance).post(`/orders/${order.id}/refunds`, { reason: 'Event experience complaint, refund the rest' });
    expect(r2.body.amountMinor).toBe(208000);
    await admin(app, finance2).post(`/refunds/${r2.body.id}/approve`);
    o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { tickets: true } });
    expect(o.status).toBe('REFUNDED');
    expect(o.refundedMinor).toBe(o.totalMinor);
    for (const account of ['SERVICE_FEE_REVENUE', 'PLATFORM_COMMISSION_REVENUE', 'PROMOTER_PAYABLE', 'GATEWAY_CLEARING']) {
      const net = await ledgerSum(order.id, account);
      // Only the gateway's own charge remains in clearing; every revenue and liability account is back to zero.
      if (account === 'GATEWAY_CLEARING') expect(net).toBe(4680n); // 1.5% sandbox fee credited out of clearing
      else expect(net).toBe(0n);
    }
  });

  it('two people approving the same refund at once results in exactly one refund', async () => {
    const p = await purchase(app, fx.brands[2], fx, { email: 'race@example.com', quantity: 1 });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference } });
    // Brand 1's support agent cannot even see an order from Website 3.
    expect((await admin(app, support).post(`/orders/${order.id}/refunds`, { reason: 'Cross-brand refund attempt' })).status).toBe(404);
    const req = await admin(app, superadmin).post(`/orders/${order.id}/refunds`, { reason: 'Race condition test refund' });
    expect(req.status).toBe(201);
    const results = await Promise.all([admin(app, finance).post(`/refunds/${req.body.id}/approve`), admin(app, finance2).post(`/refunds/${req.body.id}/approve`), admin(app, superadmin).post(`/refunds/${req.body.id}/approve`)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.ledgerTransaction.count({ where: { refundId: req.body.id } })).toBe(1);
    const gw = await prisma.sandboxGatewayTransaction.findUniqueOrThrow({ where: { reference: p.paymentReference } });
    expect(gw.refundedMinor).toBe(order.totalMinor);
  });

  it('financial records are append-only at the database level', async () => {
    const entry = await prisma.financialLedgerEntry.findFirstOrThrow();
    await expect(prisma.financialLedgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } })).rejects.toThrow(/append-only/);
    await expect(prisma.financialLedgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    // An unbalanced journal cannot be committed.
    await expect(
      prisma.$transaction(async (tx) => {
        const t = await tx.ledgerTransaction.create({ data: { type: 'ADJUSTMENT', description: 'bad', idempotencyKey: 'unbalanced-test' } });
        await tx.financialLedgerEntry.create({ data: { transactionId: t.id, account: 'BANK', direction: 'DEBIT', amountMinor: 500n, currency: 'KES' } });
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('promoter settlement: payables accrue from the ledger, payout needs a second approver, and nothing is paid automatically', async () => {
    const p = await purchase(app, fx.brands[3], fx, { email: 'payout@example.com', quantity: 4 });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference } });
    // 4 x 1,000.00 face value less 5% platform commission.
    const payable = await prisma.promoterPayable.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payable).toMatchObject({ kind: 'SALE', grossMinor: 400000n, commissionMinor: 20000n, amountMinor: 380000n, status: 'PENDING' });

    // Funds become available only after the event (hold period); until then no payout can be created.
    const early = await admin(app, finance).post('/payouts', { organizerId: fx.organizerId, currency: 'KES' });
    expect(early.status).toBe(409);
    await prisma.promoterPayable.updateMany({ where: { status: 'PENDING' }, data: { status: 'AVAILABLE' } });

    const created = await admin(app, finance).post('/payouts', { organizerId: fx.organizerId, currency: 'KES', note: 'Post-event settlement' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING_APPROVAL');
    const expected = (await prisma.promoterPayable.aggregate({ where: { payoutId: created.body.id }, _sum: { amountMinor: true } }))._sum.amountMinor;
    expect(BigInt(created.body.amountMinor)).toBe(expected);

    expect((await admin(app, finance).post(`/payouts/${created.body.id}/approve`)).status).toBe(403); // creator cannot approve
    expect((await admin(app, finance).post(`/payouts/${created.body.id}/mark-paid`, { paymentReference: 'BANK-REF-1' })).status).toBe(409); // not approved yet
    expect((await admin(app, finance2).post(`/payouts/${created.body.id}/approve`)).status).toBe(200);
    const paid = await admin(app, finance).post(`/payouts/${created.body.id}/mark-paid`, { paymentReference: 'BANK-REF-1' });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');

    const balances = await app.get(LedgerService).balances();
    const promoter = balances.find((b) => b.account === 'PROMOTER_PAYABLE' && b.currency === 'KES')!;
    const open = (await prisma.promoterPayable.aggregate({ where: { status: { not: 'PAID' } }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
    expect(promoter.balanceMinor).toBe(open);

    const report = await admin(app, finance).get(`/payouts/${created.body.id}`);
    expect(report.body.summary.netPayableMinor).toBe(Number(expected));
  });

  it('reconciliation agrees when records are consistent and reports a tampered order', async () => {
    const range = { from: new Date(Date.now() - 86400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const clean = await admin(app, finance).post('/reconciliation/run', { ...range, verifyWithGateway: true });
    expect(clean.status).toBe(200);
    expect(clean.body.issues).toEqual([]);
    expect(clean.body.checked.gatewayVerified).toBeGreaterThan(0);

    const victim = await prisma.order.findFirstOrThrow({ where: { status: 'TICKETS_ISSUED' } });
    await prisma.$executeRaw`UPDATE "orders" SET "subtotalMinor" = "subtotalMinor" + 5000, "totalMinor" = "totalMinor" + 5000 WHERE "id" = ${victim.id}::uuid`;
    const dirty = await admin(app, finance).post('/reconciliation/run', range);
    expect(dirty.body.issues.map((i: any) => i.check)).toContain('ORDER_PAYMENT_AMOUNT');
    expect(dirty.body.issues.find((i: any) => i.check === 'ORDER_PAYMENT_AMOUNT').reference).toBe(victim.reference);
    await prisma.$executeRaw`UPDATE "orders" SET "subtotalMinor" = "subtotalMinor" - 5000, "totalMinor" = "totalMinor" - 5000 WHERE "id" = ${victim.id}::uuid`;
  });

  it('a gateway settlement is matched against the payments it covers', async () => {
    const payments = await prisma.payment.findMany({ where: { status: 'SUCCEEDED', settlementId: null, order: { status: 'TICKETS_ISSUED' } } });
    const gross = payments.reduce((s, p) => s + p.amountMinor, 0n);
    const fees = payments.reduce((s, p) => s + (p.gatewayFeeMinor ?? 0n), 0n);
    const res = await admin(app, finance).post('/gateway-settlements', {
      providerAccountId: fx.accountId, providerSettlementId: 'SETTLE-001', currency: 'KES', grossMinor: Number(gross), feesMinor: Number(fees), netMinor: Number(gross - fees),
      settledAt: new Date().toISOString(), paymentReferences: payments.map((p) => p.reference),
    });
    expect(res.status).toBe(201);
    expect(res.body.problems).toEqual([]);
    expect(res.body.settlement.status).toBe('RECONCILED');
    expect(res.body.linkedPayments).toBe(payments.length);

    const wrong = await admin(app, finance).post('/gateway-settlements', {
      providerAccountId: fx.accountId, providerSettlementId: 'SETTLE-002', currency: 'KES', grossMinor: 1000, feesMinor: 100, netMinor: 900,
      settledAt: new Date().toISOString(), paymentReferences: [payments[0].reference],
    });
    expect(wrong.body.settlement.status).toBe('DISCREPANCY');
    expect(wrong.body.problems.join(' ')).toContain('already settled');
  });
});
