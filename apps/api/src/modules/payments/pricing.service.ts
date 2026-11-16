import { Injectable } from '@nestjs/common';
import { CommissionRule, CommissionType, PromoCode } from '@prisma/client';
import { AppError } from '../../common/errors';
import { PrismaService, Tx } from '../../common/infra';
import { percentOf } from '../../common/util';
import { CatalogService, StorefrontEvent } from '../catalog/catalog.service';

export interface QuoteLine {
  ticketCategoryId: string;
  categoryName: string;
  quantity: number;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
}
export interface AppliedCharge {
  type: CommissionType;
  ruleId: string | null;
  ruleName: string | null;
  baseMinor: bigint;
  percentBps: number;
  fixedMinor: bigint;
  amountMinor: bigint;
}
export interface Quote {
  currency: string;
  lines: QuoteLine[];
  ticketCount: number;
  subtotalMinor: bigint;
  discountMinor: bigint;
  feesMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  promo: PromoCode | null;
  /** SERVICE_FEE and TAX are paid by the customer; the commissions are deducted from the promoter's share. */
  charges: AppliedCharge[];
  /** What the organizer is owed for this order once it is paid. */
  promoterNetMinor: bigint;
}

/**
 * All money maths for an order. Integer minor units throughout; percentages are basis
 * points with half-up rounding. The result is snapshotted on the order, so later rule
 * changes never alter an existing order's allocation.
 */
@Injectable()
export class PricingService {
  constructor(private prisma: PrismaService, private catalog: CatalogService) {}

  /** Most specific active rule wins: event > organizer > brand > platform default. */
  private pickRule(rules: CommissionRule[], type: CommissionType, ctx: { brandId: string; organizerId: string | null; eventId: string }, currency: string) {
    let best: CommissionRule | null = null;
    let bestScore = -1;
    for (const r of rules) {
      if (r.type !== type || !r.active) continue;
      if (r.eventId && r.eventId !== ctx.eventId) continue;
      if (r.organizerId && r.organizerId !== ctx.organizerId) continue;
      if (r.brandId && r.brandId !== ctx.brandId) continue;
      if (r.fixedMinor > 0n && r.currency !== currency) continue;
      const score = (r.eventId ? 4 : 0) + (r.organizerId ? 2 : 0) + (r.brandId ? 1 : 0);
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    return best;
  }

  private charge(rule: CommissionRule | null, type: CommissionType, baseMinor: bigint, ticketCount: number): AppliedCharge {
    const percentBps = rule?.percentBps ?? 0;
    const fixedMinor = rule?.fixedMinor ?? 0n;
    const amountMinor = rule ? percentOf(baseMinor, percentBps) + fixedMinor * BigInt(ticketCount) : 0n;
    return { type, ruleId: rule?.id ?? null, ruleName: rule?.name ?? null, baseMinor, percentBps, fixedMinor, amountMinor };
  }

  async findPromo(brandId: string, code: string, db: Tx | PrismaService = this.prisma) {
    return db.promoCode.findUnique({ where: { brandId_code: { brandId, code: code.trim().toUpperCase() } } });
  }

  private validatePromo(promo: PromoCode | null, eventId: string, subtotal: bigint, currency: string): bigint {
    const now = new Date();
    if (!promo || !promo.active) throw new AppError('PROMO_INVALID', 'This promo code is not valid', 422);
    if (promo.startsAt && promo.startsAt > now) throw new AppError('PROMO_NOT_STARTED', 'This promo code is not active yet', 422);
    if (promo.endsAt && promo.endsAt < now) throw new AppError('PROMO_EXPIRED', 'This promo code has expired', 422);
    if (promo.eventId && promo.eventId !== eventId) throw new AppError('PROMO_NOT_APPLICABLE', 'This promo code does not apply to this event', 422);
    if (promo.maxRedemptions !== null && promo.redeemedCount >= promo.maxRedemptions) throw new AppError('PROMO_EXHAUSTED', 'This promo code has been fully redeemed', 422);
    if (promo.minOrderMinor !== null && subtotal < promo.minOrderMinor) throw new AppError('PROMO_MIN_ORDER', 'Your order does not meet the minimum for this promo code', 422);
    let discount: bigint;
    if (promo.discountType === 'PERCENT') {
      discount = percentOf(subtotal, promo.percentBps ?? 0);
    } else {
      if (promo.currency !== currency) throw new AppError('PROMO_NOT_APPLICABLE', 'This promo code does not apply to this currency', 422);
      discount = promo.amountMinor ?? 0n;
    }
    return discount > subtotal ? subtotal : discount;
  }

  async quote(
    brand: { id: string; currencies: string[] },
    event: StorefrontEvent,
    items: { ticketCategoryId: string; quantity: number }[],
    promoCode?: string | null,
    db: Tx | PrismaService = this.prisma,
  ): Promise<Quote> {
    if (!items.length) throw new AppError('EMPTY_ORDER', 'Select at least one ticket', 400);
    const merged = new Map<string, number>();
    for (const i of items) merged.set(i.ticketCategoryId, (merged.get(i.ticketCategoryId) ?? 0) + i.quantity);

    const lines: QuoteLine[] = [];
    let currency: string | null = null;
    for (const [ticketCategoryId, quantity] of merged) {
      const cat = event.ticketCategories.find((c) => c.id === ticketCategoryId);
      if (!cat) throw new AppError('CATEGORY_NOT_FOUND', 'A selected ticket type does not belong to this event', 400, { ticketCategoryId });
      const blocker = this.catalog.saleBlocker(event, event.publication, cat);
      if (blocker) throw new AppError(blocker, `"${cat.name}" tickets cannot be purchased right now`, 409, { ticketCategoryId });
      if (quantity < cat.minPerOrder || quantity > cat.maxPerOrder) {
        throw new AppError('QUANTITY_OUT_OF_RANGE', `You can buy between ${cat.minPerOrder} and ${cat.maxPerOrder} "${cat.name}" tickets per order`, 400, {
          ticketCategoryId, min: cat.minPerOrder, max: cat.maxPerOrder,
        });
      }
      if (currency && currency !== cat.currency) throw new AppError('MIXED_CURRENCY', 'All tickets in an order must use the same currency', 400);
      currency = cat.currency;
      const unitPriceMinor = this.catalog.effectivePrice(cat, event.publication);
      lines.push({ ticketCategoryId, categoryName: cat.name, quantity, unitPriceMinor, lineTotalMinor: unitPriceMinor * BigInt(quantity) });
    }
    if (!currency || !brand.currencies.includes(currency)) {
      throw new AppError('CURRENCY_NOT_ENABLED', `This storefront does not sell in ${currency}`, 409);
    }

    const ticketCount = lines.reduce((s, l) => s + l.quantity, 0);
    const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0n);
    const promo = promoCode ? await this.findPromo(brand.id, promoCode, db) : null;
    const discountMinor = promoCode ? this.validatePromo(promo, event.id, subtotalMinor, currency) : 0n;
    const netFace = subtotalMinor - discountMinor;

    const ctx = { brandId: brand.id, organizerId: event.organizerId, eventId: event.id };
    const rules = await db.commissionRule.findMany({ where: { active: true } });
    const fee = this.charge(this.pickRule(rules, 'SERVICE_FEE', ctx, currency), 'SERVICE_FEE', netFace, netFace > 0n ? ticketCount : 0);
    const tax = this.charge(this.pickRule(rules, 'TAX', ctx, currency), 'TAX', netFace + fee.amountMinor, 0);
    const platform = this.charge(this.pickRule(rules, 'PLATFORM_COMMISSION', ctx, currency), 'PLATFORM_COMMISSION', netFace, netFace > 0n ? ticketCount : 0);
    const brandCut = this.charge(this.pickRule(rules, 'BRAND_COMMISSION', ctx, currency), 'BRAND_COMMISSION', netFace, 0);

    // Commissions can never exceed the face value they are taken from.
    if (platform.amountMinor > netFace) platform.amountMinor = netFace;
    if (platform.amountMinor + brandCut.amountMinor > netFace) brandCut.amountMinor = netFace - platform.amountMinor;

    return {
      currency, lines, ticketCount, subtotalMinor, discountMinor,
      feesMinor: fee.amountMinor,
      taxMinor: tax.amountMinor,
      totalMinor: netFace + fee.amountMinor + tax.amountMinor,
      promo: promoCode ? promo : null,
      charges: [fee, tax, platform, brandCut],
      promoterNetMinor: netFace - platform.amountMinor - brandCut.amountMinor,
    };
  }
}
