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
   *
   * The refund is shared in proportion to what is still left in each account (original
   * amount minus what earlier refunds already reversed), using largest-remainder rounding.
   * That guarantees: every share is >= 0, no account is reversed by more than it holds, the
   * shares add up to exactly the refund amount, and the final refund clears every account
   * to zero, however the order was refunded in pieces.
   */
  refundAllocation(order: Allocation, alreadyRefunded: Omit<Allocation, 'totalMinor'>, refundMinor: bigint): Allocation {
    const keys = ['feesMinor', 'taxMinor', 'platformCommissionMinor', 'brandCommissionMinor', 'promoterMinor'] as const;
    const remaining = keys.map((k) => order[k] - alreadyRefunded[k]);
    const remainingTotal = remaining.reduce((a, b) => a + b, 0n);
    if (refundMinor <= 0n || refundMinor > remainingTotal || remaining.some((r) => r < 0n)) {
      throw new Error(`Refund of ${refundMinor} cannot be allocated against a remaining balance of ${remainingTotal}`);
    }
    let shares: bigint[];
    if (refundMinor === remainingTotal) {
      shares = remaining;
    } else {
      shares = remaining.map((r) => (r * refundMinor) / remainingTotal);
      let leftover = refundMinor - shares.reduce((a, b) => a + b, 0n);
      const byFraction = remaining
        .map((r, i) => ({ i, fraction: (r * refundMinor) % remainingTotal }))
        .sort((a, b) => (a.fraction === b.fraction ? b.i - a.i : a.fraction > b.fraction ? -1 : 1));
      for (const { i } of byFraction) {
        if (leftover === 0n) break;
        if (shares[i] < remaining[i]) {
          shares[i] += 1n;
          leftover -= 1n;
        }
      }
      if (leftover !== 0n) throw new Error('Refund allocation did not converge'); // unreachable: leftover < number of non-zero fractions
    }
    const out = Object.fromEntries(keys.map((k, i) => [k, shares[i]])) as Omit<Allocation, 'totalMinor'>;
    return { totalMinor: refundMinor, ...out };
  }

  /** What earlier refunds on this order have already reversed, per account, read from the ledger itself. */
  async refundedSoFar(tx: Tx, orderId: string): Promise<Omit<Allocation, 'totalMinor'>> {
    const rows = await tx.$queryRaw<{ account: LedgerAccount; amount: bigint }[]>`
      SELECT e."account", COALESCE(SUM(e."amountMinor"), 0)::bigint AS amount
        FROM "financial_ledger_entries" e JOIN "ledger_transactions" t ON t."id" = e."transactionId"
       WHERE t."orderId" = ${orderId}::uuid AND t."type" = 'REFUND' AND e."direction" = 'DEBIT'
       GROUP BY e."account"`;
    const of = (account: LedgerAccount) => rows.find((r) => r.account === account)?.amount ?? 0n;
    return {
      feesMinor: of('SERVICE_FEE_REVENUE'), taxMinor: of('TAX_PAYABLE'), platformCommissionMinor: of('PLATFORM_COMMISSION_REVENUE'),
      brandCommissionMinor: of('BRAND_COMMISSION_PAYABLE'), promoterMinor: of('PROMOTER_PAYABLE'),
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
