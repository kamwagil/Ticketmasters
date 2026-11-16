import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { reference } from '../../common/crypto';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AlertService, AuditService, PrismaService } from '../../common/infra';
import { LedgerService } from './ledger.service';
import { PaymentService } from './payment.service';
import { ProviderRegistry } from './providers';

export interface ReconciliationIssue {
  check: string;
  severity: 'WARNING' | 'CRITICAL';
  entityType: string;
  entityId: string;
  reference?: string | null;
  detail: string;
}

const PAID = ['PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** Promoter settlements, gateway settlements and financial reconciliation. */
@Injectable()
export class FinanceService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private payments: PaymentService,
    private registry: ProviderRegistry,
    private audit: AuditService,
    private alerts: AlertService,
  ) {}

  // ───────────────────────── Promoter payables and payouts ─────────────────────────

  /** What each organizer is owed, per currency and payable status. Derived from payable lines, never from order status. */
  async payableSummary(organizerId?: string) {
    const rows = await this.prisma.promoterPayable.groupBy({
      by: ['organizerId', 'currency', 'status'],
      where: organizerId ? { organizerId } : {},
      _sum: { amountMinor: true, grossMinor: true, commissionMinor: true },
      _count: true,
    });
    const organizers = await this.prisma.organizer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizerId))] } }, select: { id: true, name: true, verificationStatus: true } });
    return rows.map((r) => ({
      organizerId: r.organizerId, organizer: organizers.find((o) => o.id === r.organizerId) ?? null, currency: r.currency, status: r.status,
      lines: r._count, grossMinor: r._sum.grossMinor ?? 0n, commissionMinor: r._sum.commissionMinor ?? 0n, amountMinor: r._sum.amountMinor ?? 0n,
    }));
  }

  /**
   * Bundles an organizer's AVAILABLE payables in one currency into a payout awaiting approval.
   * Refund reversals are netted in. Nothing is transferred: money only moves when finance pays
   * the organizer outside the platform and records the reference with markPaid.
   */
  async createPayout(organizerId: string, currency: string, creator: { id: string; label: string }, note?: string) {
    const organizer = await this.prisma.organizer.findUnique({ where: { id: organizerId } });
    if (!organizer) throw notFound('Organizer');
    if (organizer.verificationStatus !== 'VERIFIED') throw new AppError('ORGANIZER_NOT_VERIFIED', 'Payouts can only be created for verified organizers', 409);

    const payout = await this.prisma.tx(async (tx) => {
      // Serialise payout creation per organizer so two finance users cannot bundle the same lines.
      await tx.$queryRaw`SELECT "id" FROM "organizers" WHERE "id" = ${organizerId}::uuid FOR UPDATE`;
      const lines = await tx.promoterPayable.findMany({ where: { organizerId, currency, status: 'AVAILABLE', payoutId: null } });
      const amount = lines.reduce((s, l) => s + l.amountMinor, 0n);
      if (!lines.length || amount <= 0n) throw new AppError('NOTHING_TO_PAY', 'This organizer has no positive available balance in this currency', 409, { availableMinor: Number(amount) });
      const p = await tx.payout.create({
        data: { reference: reference('PYT', 10), organizerId, currency, amountMinor: amount, status: 'PENDING_APPROVAL', createdById: creator.id, note },
      });
      await tx.promoterPayable.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { status: 'IN_PAYOUT', payoutId: p.id } });
      await this.audit.record({ actorType: 'USER', actorId: creator.id, actorLabel: creator.label, action: 'payout.create', entityType: 'payout', entityId: p.id, after: { organizerId, currency, amountMinor: amount, lines: lines.length } }, tx);
      return p;
    });
    return payout;
  }

  async approvePayout(payoutId: string, approver: { id: string; label: string }) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw notFound('Payout');
    if (payout.createdById === approver.id) throw forbidden('A payout must be approved by someone other than the person who created it');
    const claimed = await this.prisma.payout.updateMany({ where: { id: payoutId, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED', approvedById: approver.id, approvedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('PAYOUT_STATE', `This payout is ${payout.status.toLowerCase().replace('_', ' ')}`, 409);
    await this.audit.record({ actorType: 'USER', actorId: approver.id, actorLabel: approver.label, action: 'payout.approve', entityType: 'payout', entityId: payoutId, after: { amountMinor: payout.amountMinor, currency: payout.currency } });
    return this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
  }

  /** Rejects or cancels a payout that has not been paid; its payable lines become available again. */
  async rejectPayout(payoutId: string, by: { id: string; label: string }, reason: string) {
    return this.prisma.tx(async (tx) => {
      const claimed = await tx.payout.updateMany({ where: { id: payoutId, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, data: { status: 'REJECTED', note: reason } });
      if (claimed.count !== 1) throw new AppError('PAYOUT_STATE', 'Only an unpaid payout can be rejected', 409);
      await tx.promoterPayable.updateMany({ where: { payoutId }, data: { status: 'AVAILABLE', payoutId: null } });
      await this.audit.record({ actorType: 'USER', actorId: by.id, actorLabel: by.label, action: 'payout.reject', entityType: 'payout', entityId: payoutId, after: { reason } }, tx);
      return tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
    });
  }

  /** Records that an approved payout was paid to the organizer (bank / mobile money reference required). */
  async markPayoutPaid(payoutId: string, by: { id: string; label: string }, paymentReference: string) {
    return this.prisma.tx(async (tx) => {
      const claimed = await tx.payout.updateMany({ where: { id: payoutId, status: 'APPROVED' }, data: { status: 'PAID', paidById: by.id, paidAt: new Date(), paymentReference } });
      if (claimed.count !== 1) throw new AppError('PAYOUT_STATE', 'Only an approved payout can be marked as paid', 409);
      const payout = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
      await tx.promoterPayable.updateMany({ where: { payoutId }, data: { status: 'PAID' } });
      await this.ledger.post(tx, {
        type: 'PAYOUT', description: `Payout ${payout.reference} paid (${paymentReference})`, idempotencyKey: `payout:${payout.id}`, currency: payout.currency,
        payoutId: payout.id, createdBy: by.id,
        lines: [
          { account: 'PROMOTER_PAYABLE', direction: 'DEBIT', amountMinor: payout.amountMinor, organizerId: payout.organizerId },
          { account: 'BANK', direction: 'CREDIT', amountMinor: payout.amountMinor },
        ],
      });
      await this.audit.record({ actorType: 'USER', actorId: by.id, actorLabel: by.label, action: 'payout.mark_paid', entityType: 'payout', entityId: payoutId, after: { paymentReference, amountMinor: payout.amountMinor } }, tx);
      return payout;
    });
  }

  /** Settlement statement for one payout: gross sales, commission withheld, refunds and the net paid. */
  async payoutReport(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId }, include: { organizer: { select: { id: true, name: true, legalName: true } }, payables: { orderBy: { createdAt: 'asc' } } } });
    if (!payout) throw notFound('Payout');
    const sales = payout.payables.filter((p) => p.kind === 'SALE');
    const refunds = payout.payables.filter((p) => p.kind === 'REFUND');
    const sum = (rows: typeof sales, k: 'grossMinor' | 'commissionMinor' | 'amountMinor') => rows.reduce((s, r) => s + r[k], 0n);
    const events = await this.prisma.event.findMany({ where: { id: { in: [...new Set(payout.payables.map((p) => p.eventId))] } }, select: { id: true, name: true, startsAt: true } });
    return {
      payout: { ...payout, payables: undefined },
      summary: {
        currency: payout.currency,
        grossTicketSalesMinor: sum(sales, 'grossMinor'),
        commissionWithheldMinor: sum(sales, 'commissionMinor'),
        refundsGrossMinor: -sum(refunds, 'grossMinor'),
        commissionReturnedMinor: -sum(refunds, 'commissionMinor'),
        netPayableMinor: payout.amountMinor,
        orders: new Set(sales.map((s) => s.orderId)).size,
      },
      byEvent: events.map((e) => ({ ...e, netMinor: payout.payables.filter((p) => p.eventId === e.id).reduce((s, p) => s + p.amountMinor, 0n) })),
      lines: payout.payables,
    };
  }

  // ───────────────────────── Gateway settlements ─────────────────────────

  /**
   * Records money a gateway settled to the bank and links the payments it covers.
   * Journals DR BANK / CR GATEWAY_CLEARING for the net amount. A settlement whose figures do
   * not agree with the linked payments is stored with status DISCREPANCY.
   */
  async recordSettlement(
    input: { providerAccountId: string; providerSettlementId: string; currency: string; grossMinor: bigint; feesMinor: bigint; netMinor: bigint; settledAt: Date; paymentReferences: string[]; note?: string },
    by: { id: string; label: string },
  ) {
    if (input.grossMinor - input.feesMinor !== input.netMinor) throw new AppError('SETTLEMENT_ARITHMETIC', 'Net must equal gross minus fees', 400);
    const account = await this.prisma.paymentProviderAccount.findUnique({ where: { id: input.providerAccountId } });
    if (!account) throw notFound('Merchant account');

    return this.prisma.tx(async (tx) => {
      const payments = await tx.payment.findMany({ where: { reference: { in: input.paymentReferences } } });
      const problems: string[] = [];
      const missing = input.paymentReferences.filter((r) => !payments.some((p) => p.reference === r));
      if (missing.length) problems.push(`unknown payment references: ${missing.join(', ')}`);
      for (const p of payments) {
        if (p.providerAccountId !== input.providerAccountId) problems.push(`${p.reference} belongs to a different merchant account`);
        if (p.status !== 'SUCCEEDED') problems.push(`${p.reference} is ${p.status}`);
        if (p.currency !== input.currency) problems.push(`${p.reference} is in ${p.currency}`);
        if (p.settlementId) problems.push(`${p.reference} is already settled`);
      }
      const linkable = payments.filter((p) => p.providerAccountId === input.providerAccountId && p.status === 'SUCCEEDED' && p.currency === input.currency && !p.settlementId);
      const refunds = await tx.refund.aggregate({ where: { paymentId: { in: linkable.map((p) => p.id) }, status: 'SUCCEEDED' }, _sum: { amountMinor: true } });
      const expectedGross = linkable.reduce((s, p) => s + p.amountMinor, 0n) - (refunds._sum.amountMinor ?? 0n);
      const expectedFees = linkable.reduce((s, p) => s + (p.gatewayFeeMinor ?? 0n), 0n);
      if (linkable.length && expectedGross !== input.grossMinor) problems.push(`gross ${input.grossMinor} differs from linked payments net of refunds ${expectedGross}`);
      if (linkable.length && expectedFees !== input.feesMinor) problems.push(`fees ${input.feesMinor} differ from recorded gateway charges ${expectedFees}`);

      const settlement = await tx.gatewaySettlement.create({
        data: {
          providerAccountId: input.providerAccountId, providerSettlementId: input.providerSettlementId, currency: input.currency, grossMinor: input.grossMinor,
          feesMinor: input.feesMinor, netMinor: input.netMinor, settledAt: input.settledAt, status: problems.length ? 'DISCREPANCY' : 'RECONCILED',
          note: [input.note, ...problems].filter(Boolean).join(' | ') || null, createdBy: by.id, raw: { paymentReferences: input.paymentReferences },
        },
      });
      await tx.payment.updateMany({ where: { id: { in: linkable.map((p) => p.id) } }, data: { settlementId: settlement.id } });
      await this.ledger.post(tx, {
        type: 'SETTLEMENT', description: `${account.providerCode} settlement ${input.providerSettlementId}`, idempotencyKey: `settlement:${settlement.id}`, currency: input.currency,
        legalEntityId: account.legalEntityId, settlementId: settlement.id, createdBy: by.id,
        lines: [{ account: 'BANK', direction: 'DEBIT', amountMinor: input.netMinor }, { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amountMinor: input.netMinor }],
      });
      // Fee variance between what the gateway kept and what was recorded per payment at capture time.
      const feeDiff = input.feesMinor - expectedFees;
      if (linkable.length && feeDiff !== 0n) {
        await this.ledger.post(tx, {
          type: 'ADJUSTMENT', description: `Gateway fee variance on settlement ${input.providerSettlementId}`, idempotencyKey: `settlement-fee:${settlement.id}`, currency: input.currency,
          legalEntityId: account.legalEntityId, settlementId: settlement.id, createdBy: by.id,
          lines: feeDiff > 0n
            ? [{ account: 'GATEWAY_FEE_EXPENSE', direction: 'DEBIT', amountMinor: feeDiff }, { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amountMinor: feeDiff }]
            : [{ account: 'GATEWAY_CLEARING', direction: 'DEBIT', amountMinor: -feeDiff }, { account: 'GATEWAY_FEE_EXPENSE', direction: 'CREDIT', amountMinor: -feeDiff }],
        });
      }
      await this.audit.record({ actorType: 'USER', actorId: by.id, actorLabel: by.label, action: 'settlement.record', entityType: 'gateway_settlement', entityId: settlement.id, after: { ...input, problems } }, tx);
      return { settlement, linkedPayments: linkable.length, problems };
    });
  }

  // ───────────────────────── Reconciliation ─────────────────────────

  /**
   * Compares internal orders, payments, refunds, the ledger, gateway records, gateway
   * settlements and promoter payables for a period and reports every disagreement.
   * Read-only: it never "fixes" data. Each run is stored for audit.
   */
  async reconcile(opts: { from: Date; to: Date; brandIds?: string[]; verifyWithGateway?: boolean; gatewaySample?: number }, by: { id: string; label: string } | null) {
    const issues: ReconciliationIssue[] = [];
    const brandFilter = opts.brandIds ? { brandId: { in: opts.brandIds } } : {};
    const brandSql = opts.brandIds ? Prisma.sql`AND o."brandId" = ANY(${opts.brandIds}::uuid[])` : Prisma.empty;
    const range = { gte: opts.from, lte: opts.to };

    // 1. Orders vs payments.
    const paidOrders = await this.prisma.order.findMany({
      where: { ...brandFilter, status: { in: PAID as any }, paidAt: range, totalMinor: { gt: 0 } },
      select: { id: true, reference: true, totalMinor: true, refundedMinor: true, currency: true, status: true, payments: { where: { status: 'SUCCEEDED' }, select: { id: true, reference: true, amountMinor: true, currency: true } } },
    });
    for (const o of paidOrders) {
      if (o.payments.length !== 1) {
        issues.push({ check: 'ORDER_PAYMENT_COUNT', severity: 'CRITICAL', entityType: 'order', entityId: o.id, reference: o.reference, detail: `Paid order has ${o.payments.length} successful payments (expected 1)` });
        continue;
      }
      const p = o.payments[0];
      if (p.amountMinor !== o.totalMinor || p.currency !== o.currency) {
        issues.push({ check: 'ORDER_PAYMENT_AMOUNT', severity: 'CRITICAL', entityType: 'order', entityId: o.id, reference: o.reference, detail: `Order total ${o.totalMinor} ${o.currency} but payment ${p.amountMinor} ${p.currency}` });
      }
    }
    const orphanPayments = await this.prisma.payment.findMany({
      where: { ...brandFilter, status: 'SUCCEEDED', paidAt: range, order: { status: { notIn: PAID as any } } },
      select: { id: true, reference: true, order: { select: { reference: true, status: true } } },
    });
    for (const p of orphanPayments) {
      issues.push({ check: 'PAYMENT_WITHOUT_PAID_ORDER', severity: 'CRITICAL', entityType: 'payment', entityId: p.id, reference: p.reference, detail: `Payment succeeded but order ${p.order.reference} is ${p.order.status}` });
    }

    // 2. Payments vs ledger capture journals.
    const captureGaps = await this.prisma.$queryRaw<{ id: string; reference: string; amountMinor: bigint; journaled: bigint | null }[]>`
      SELECT p."id", p."reference", p."amountMinor",
             (SELECT SUM(e."amountMinor")::bigint FROM "ledger_transactions" t JOIN "financial_ledger_entries" e ON e."transactionId" = t."id"
               WHERE t."paymentId" = p."id" AND t."type" = 'PAYMENT_CAPTURE' AND e."account" = 'GATEWAY_CLEARING' AND e."direction" = 'DEBIT') AS journaled
        FROM "payments" p JOIN "orders" o ON o."id" = p."orderId"
       WHERE p."status" = 'SUCCEEDED' AND p."paidAt" BETWEEN ${opts.from} AND ${opts.to} ${brandSql}`;
    for (const g of captureGaps.filter((x) => x.journaled === null || x.journaled !== x.amountMinor)) {
      issues.push({ check: 'PAYMENT_LEDGER_MISMATCH', severity: 'CRITICAL', entityType: 'payment', entityId: g.id, reference: g.reference, detail: `Payment ${g.amountMinor} but ledger capture is ${g.journaled ?? 'missing'}` });
    }

    // 3. Refunds vs orders vs ledger.
    const refundGaps = await this.prisma.$queryRaw<{ id: string; reference: string; refundedMinor: bigint; refunds: bigint | null; journaled: bigint | null }[]>`
      SELECT o."id", o."reference", o."refundedMinor",
             (SELECT SUM(r."amountMinor")::bigint FROM "refunds" r WHERE r."orderId" = o."id" AND r."status" = 'SUCCEEDED') AS refunds,
             (SELECT SUM(e."amountMinor")::bigint FROM "ledger_transactions" t JOIN "financial_ledger_entries" e ON e."transactionId" = t."id"
               WHERE t."orderId" = o."id" AND t."type" = 'REFUND' AND e."account" = 'GATEWAY_CLEARING' AND e."direction" = 'CREDIT') AS journaled
        FROM "orders" o
       WHERE (o."refundedMinor" > 0 OR EXISTS (SELECT 1 FROM "refunds" r WHERE r."orderId" = o."id" AND r."status" = 'SUCCEEDED'))
         AND o."updatedAt" BETWEEN ${opts.from} AND ${opts.to} ${brandSql}`;
    for (const g of refundGaps) {
      const refunds = g.refunds ?? 0n;
      const journaled = g.journaled ?? 0n;
      if (refunds !== g.refundedMinor || journaled !== g.refundedMinor) {
        issues.push({ check: 'REFUND_MISMATCH', severity: 'CRITICAL', entityType: 'order', entityId: g.id, reference: g.reference, detail: `Order refunded ${g.refundedMinor}, refund records ${refunds}, ledger ${journaled}` });
      }
    }
    const stuckRefunds = await this.prisma.refund.findMany({ where: { ...brandFilter, status: { in: ['PROCESSING', 'APPROVED'] }, updatedAt: { lt: new Date(Date.now() - 30 * 60_000) } }, select: { id: true, reference: true, status: true } });
    for (const r of stuckRefunds) issues.push({ check: 'REFUND_STUCK', severity: 'WARNING', entityType: 'refund', entityId: r.id, reference: r.reference, detail: `Refund has been ${r.status} for more than 30 minutes` });

    // 4. Issued tickets vs paid quantities.
    const ticketGaps = await this.prisma.$queryRaw<{ id: string; reference: string; qty: number; tickets: number }[]>`
      SELECT o."id", o."reference",
             (SELECT COALESCE(SUM(i."quantity"), 0)::int FROM "order_items" i WHERE i."orderId" = o."id") AS qty,
             (SELECT COUNT(*)::int FROM "tickets" t WHERE t."orderId" = o."id" AND t."status" <> 'TRANSFERRED') AS tickets
        FROM "orders" o
       WHERE o."status" IN ('TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND o."paidAt" BETWEEN ${opts.from} AND ${opts.to} ${brandSql}`;
    for (const g of ticketGaps.filter((x) => x.qty !== x.tickets)) {
      issues.push({ check: 'TICKET_COUNT_MISMATCH', severity: 'CRITICAL', entityType: 'order', entityId: g.id, reference: g.reference, detail: `Order paid for ${g.qty} tickets but ${g.tickets} exist` });
    }

    // 5. Gateway transaction records (optional live verification of a sample).
    let gatewayChecked = 0;
    if (opts.verifyWithGateway) {
      const sample = await this.prisma.payment.findMany({ where: { ...brandFilter, status: 'SUCCEEDED', paidAt: range }, orderBy: { paidAt: 'desc' }, take: Math.min(opts.gatewaySample ?? 50, 200) });
      for (const p of sample) {
        try {
          const v = await this.registry.get(p.providerCode).verify(await this.payments.accountCtx(p.providerAccountId), p.reference, p.providerTransactionId);
          gatewayChecked++;
          if (v.status !== 'SUCCEEDED' || v.amountMinor !== p.amountMinor || (v.currency ?? '').toUpperCase() !== p.currency) {
            issues.push({ check: 'GATEWAY_RECORD_MISMATCH', severity: 'CRITICAL', entityType: 'payment', entityId: p.id, reference: p.reference, detail: `Gateway reports ${v.status} ${v.amountMinor} ${v.currency}; internal record is SUCCEEDED ${p.amountMinor} ${p.currency}` });
          }
        } catch (e) {
          issues.push({ check: 'GATEWAY_UNREACHABLE', severity: 'WARNING', entityType: 'payment', entityId: p.id, reference: p.reference, detail: `Could not verify with gateway: ${(e as Error).message}`.slice(0, 300) });
        }
      }
    }

    // 6. Gateway settlements.
    const discrepant = await this.prisma.gatewaySettlement.findMany({ where: { status: 'DISCREPANCY', settledAt: range } });
    for (const s of discrepant) issues.push({ check: 'SETTLEMENT_DISCREPANCY', severity: 'WARNING', entityType: 'gateway_settlement', entityId: s.id, reference: s.providerSettlementId, detail: s.note ?? 'Settlement figures disagree with linked payments' });
    const unsettled = await this.prisma.payment.groupBy({
      by: ['currency'], where: { ...brandFilter, status: 'SUCCEEDED', livemode: true, settlementId: null, paidAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
      _count: true, _sum: { amountMinor: true },
    });
    for (const u of unsettled) issues.push({ check: 'UNSETTLED_PAYMENTS', severity: 'WARNING', entityType: 'payment', entityId: u.currency, detail: `${u._count} live payment(s) totalling ${u._sum.amountMinor} ${u.currency} are older than 7 days with no recorded settlement` });

    // 7. Promoter payables vs the ledger (platform-wide runs only: the liability account is not brand-partitioned by payout).
    let payableCheck: { currency: string; ledgerMinor: bigint; payablesMinor: bigint }[] = [];
    if (!opts.brandIds) {
      const ledgerBalances = (await this.ledger.balances()).filter((b) => b.account === 'PROMOTER_PAYABLE');
      const open = await this.prisma.promoterPayable.groupBy({ by: ['currency'], where: { status: { not: 'PAID' } }, _sum: { amountMinor: true } });
      const unattributed = await this.prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
        SELECT "currency", COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::bigint AS amount
          FROM "financial_ledger_entries" WHERE "account" = 'PROMOTER_PAYABLE' AND "organizerId" IS NULL GROUP BY "currency"`;
      const currencies = new Set([...ledgerBalances.map((b) => b.currency), ...open.map((o) => o.currency)]);
      for (const currency of currencies) {
        const ledgerMinor = (ledgerBalances.find((b) => b.currency === currency)?.balanceMinor ?? 0n) - (unattributed.find((u) => u.currency === currency)?.amount ?? 0n);
        const payablesMinor = open.find((o) => o.currency === currency)?._sum.amountMinor ?? 0n;
        payableCheck.push({ currency, ledgerMinor, payablesMinor });
        if (ledgerMinor !== payablesMinor) {
          issues.push({ check: 'PROMOTER_PAYABLE_MISMATCH', severity: 'CRITICAL', entityType: 'ledger', entityId: currency, detail: `Ledger shows ${ledgerMinor} ${currency} owed to promoters but open payable lines total ${payablesMinor}` });
        }
      }
    }

    // 8. The ledger as a whole must balance per currency.
    const unbalanced = await this.prisma.$queryRaw<{ currency: string; diff: bigint }[]>`
      SELECT "currency", SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END)::bigint AS diff
        FROM "financial_ledger_entries" GROUP BY "currency" HAVING SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END) <> 0`;
    for (const u of unbalanced) issues.push({ check: 'LEDGER_UNBALANCED', severity: 'CRITICAL', entityType: 'ledger', entityId: u.currency, detail: `Ledger is out of balance by ${u.diff} ${u.currency}` });

    const totals = await this.prisma.payment.groupBy({ by: ['currency'], where: { ...brandFilter, status: 'SUCCEEDED', paidAt: range }, _count: true, _sum: { amountMinor: true, gatewayFeeMinor: true } });
    const refundTotals = await this.prisma.refund.groupBy({ by: ['currency'], where: { ...brandFilter, status: 'SUCCEEDED', processedAt: range }, _count: true, _sum: { amountMinor: true } });
    const summary = {
      period: { from: opts.from, to: opts.to },
      checked: { paidOrders: paidOrders.length, payments: captureGaps.length, refundedOrders: refundGaps.length, ticketedOrders: ticketGaps.length, gatewayVerified: gatewayChecked },
      totals: totals.map((t) => ({ currency: t.currency, payments: t._count, capturedMinor: t._sum.amountMinor ?? 0n, gatewayFeesMinor: t._sum.gatewayFeeMinor ?? 0n })),
      refunds: refundTotals.map((t) => ({ currency: t.currency, refunds: t._count, refundedMinor: t._sum.amountMinor ?? 0n })),
      promoterPayables: payableCheck,
      issues,
    };
    const run = await this.prisma.reconciliationRun.create({
      data: {
        brandId: opts.brandIds?.length === 1 ? opts.brandIds[0] : null, periodStart: opts.from, periodEnd: opts.to, issueCount: issues.length, createdBy: by?.id ?? null,
        summary: JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonValue,
      },
    });
    if (issues.some((i) => i.severity === 'CRITICAL')) {
      await this.alerts.raise({ type: 'RECONCILIATION_ISSUES', severity: 'CRITICAL', entityType: 'reconciliation_run', entityId: run.id, message: `Reconciliation found ${issues.length} issue(s), ${issues.filter((i) => i.severity === 'CRITICAL').length} critical` });
    }
    if (by) await this.audit.record({ actorType: 'USER', actorId: by.id, actorLabel: by.label, action: 'reconciliation.run', entityType: 'reconciliation_run', entityId: run.id, metadata: { issues: issues.length, from: opts.from, to: opts.to } });
    return { runId: run.id, ...summary };
  }
}
