import { Injectable } from '@nestjs/common';
import { LedgerAccount, LedgerDirection, LedgerTransactionType, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../../common/infra';

export interface LedgerLine {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountMinor: bigint;
  organizerId?: string | null;
}
export interface JournalInput {
  type: LedgerTransactionType;
  description: string;
  /** One journal per business event: posting the same key twice is a no-op. */
  idempotencyKey: string;
  currency: string;
  brandId?: string | null;
  legalEntityId?: string | null;
  orderId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  payoutId?: string | null;
  settlementId?: string | null;
  reversesId?: string | null;
  createdBy?: string | null;
  lines: LedgerLine[];
}

/** Order amounts split into the ledger accounts they are booked to. */
export interface Allocation {
  totalMinor: bigint;
  feesMinor: bigint;
  taxMinor: bigint;
  platformCommissionMinor: bigint;
  brandCommissionMinor: bigint;
  promoterMinor: bigint;
}

/**
 * Double-entry financial ledger.
 *
 * Balances are always derived by summing ledger entries, never from order or payment
 * status. Entries are immutable (enforced by a database trigger) and every journal must
 * balance per currency (enforced by a deferred constraint trigger at COMMIT). Mistakes are
 * corrected with new reversing journals.
 *
 * Account model:
 *   GATEWAY_CLEARING (asset)      money captured by a gateway, not yet in the bank
 *   BANK (asset)                  money settled by the gateway
 *   PROMOTER_PAYABLE (liability)  owed to event organizers; customer funds held for them
 *   BRAND_COMMISSION_PAYABLE      owed to storefront brands
 *   TAX_PAYABLE (liability)
 *   PLATFORM_COMMISSION_REVENUE, SERVICE_FEE_REVENUE (income)
 *   GATEWAY_FEE_EXPENSE, REFUND_LOSS_EXPENSE (expense)
 */
@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async post(tx: Tx, j: JournalInput): Promise<string | null> {
    const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey: j.idempotencyKey }, select: { id: true } });
    if (existing) return existing.id;
    const lines = j.lines.filter((l) => l.amountMinor > 0n);
    if (!lines.length) return null;
    const debit = lines.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountMinor, 0n);
    const credit = lines.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountMinor, 0n);
    if (debit !== credit) throw new Error(`Unbalanced journal ${j.idempotencyKey}: debit ${debit} != credit ${credit}`);

    const t = await tx.ledgerTransaction.create({
      data: {
        type: j.type, description: j.description, idempotencyKey: j.idempotencyKey, brandId: j.brandId ?? null, orderId: j.orderId ?? null,
        paymentId: j.paymentId ?? null, refundId: j.refundId ?? null, payoutId: j.payoutId ?? null, settlementId: j.settlementId ?? null,
        reversesId: j.reversesId ?? null, createdBy: j.createdBy ?? null,
      },
    });
    await tx.financialLedgerEntry.createMany({
      data: lines.map((l) => ({
        transactionId: t.id, account: l.account, direction: l.direction, amountMinor: l.amountMinor, currency: j.currency,
        brandId: j.brandId ?? null, legalEntityId: j.legalEntityId ?? null, organizerId: l.organizerId ?? null, orderId: j.orderId ?? null,
      })),
    });
    return t.id;
  }

  /** Lines that book a captured payment into revenue, tax and third-party liabilities. */
  captureLines(a: Allocation, organizerId: string | null): LedgerLine[] {
    return [
      { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amountMinor: a.totalMinor },
      { account: 'SERVICE_FEE_REVENUE', direction: 'CREDIT', amountMinor: a.feesMinor },
      { account: 'TAX_PAYABLE', direction: 'CREDIT', amountMinor: a.taxMinor },
      { account: 'PLATFORM_COMMISSION_REVENUE', direction: 'CREDIT', amountMinor: a.platformCommissionMinor },
      { account: 'BRAND_COMMISSION_PAYABLE', direction: 'CREDIT', amountMinor: a.brandCommissionMinor },
      { account: 'PROMOTER_PAYABLE', direction: 'CREDIT', amountMinor: a.promoterMinor, organizerId },
    ];
  }

  /**
   * Splits a refund across the accounts the original capture was booked to.
   * Each component is refunded pro rata on the cumulative refunded amount, so rounding
   * never drifts and a full refund reverses every account exactly.
   */
  refundAllocation(order: Allocation, refundedBeforeMinor: bigint, refundMinor: bigint): Allocation {
    const after = refundedBeforeMinor + refundMinor;
    const share = (component: bigint) =>
      order.totalMinor === 0n ? 0n : (component * after) / order.totalMinor - (component * refundedBeforeMinor) / order.totalMinor;
    const feesMinor = share(order.feesMinor);
    const taxMinor = share(order.taxMinor);
    const platformCommissionMinor = share(order.platformCommissionMinor);
    const brandCommissionMinor = share(order.brandCommissionMinor);
    return {
      totalMinor: refundMinor, feesMinor, taxMinor, platformCommissionMinor, brandCommissionMinor,
      promoterMinor: refundMinor - feesMinor - taxMinor - platformCommissionMinor - brandCommissionMinor,
    };
  }

  refundLines(a: Allocation, organizerId: string | null): LedgerLine[] {
    return [
      { account: 'SERVICE_FEE_REVENUE', direction: 'DEBIT', amountMinor: a.feesMinor },
      { account: 'TAX_PAYABLE', direction: 'DEBIT', amountMinor: a.taxMinor },
      { account: 'PLATFORM_COMMISSION_REVENUE', direction: 'DEBIT', amountMinor: a.platformCommissionMinor },
      { account: 'BRAND_COMMISSION_PAYABLE', direction: 'DEBIT', amountMinor: a.brandCommissionMinor },
      { account: 'PROMOTER_PAYABLE', direction: 'DEBIT', amountMinor: a.promoterMinor, organizerId },
      { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amountMinor: a.totalMinor },
    ];
  }

  /** Account balances per currency. Positive = normal balance for the account type. */
  async balances(filter: { brandIds?: string[]; organizerId?: string; from?: Date; to?: Date } = {}) {
    const where: Prisma.Sql[] = [];
    if (filter.brandIds) where.push(Prisma.sql`"brandId" = ANY(${filter.brandIds}::uuid[])`);
    if (filter.organizerId) where.push(Prisma.sql`"organizerId" = ${filter.organizerId}::uuid`);
    if (filter.from) where.push(Prisma.sql`"createdAt" >= ${filter.from}`);
    if (filter.to) where.push(Prisma.sql`"createdAt" <= ${filter.to}`);
    const clause = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ account: LedgerAccount; currency: string; debit: bigint; credit: bigint }[]>`
      SELECT "account", "currency",
             COALESCE(SUM("amountMinor") FILTER (WHERE "direction" = 'DEBIT'), 0)::bigint AS debit,
             COALESCE(SUM("amountMinor") FILTER (WHERE "direction" = 'CREDIT'), 0)::bigint AS credit
        FROM "financial_ledger_entries" ${clause}
       GROUP BY "account", "currency" ORDER BY "currency", "account"`;
    const debitNormal = new Set<LedgerAccount>(['GATEWAY_CLEARING', 'BANK', 'GATEWAY_FEE_EXPENSE', 'REFUND_LOSS_EXPENSE']);
    return rows.map((r) => ({
      account: r.account, currency: r.currency, debitMinor: r.debit, creditMinor: r.credit,
      balanceMinor: debitNormal.has(r.account) ? r.debit - r.credit : r.credit - r.debit,
    }));
  }
}
