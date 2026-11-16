import { Injectable } from '@nestjs/common';
import { Channel, OrderStatus, Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/infra';

/**
 * Declarative segment definition. All fields are optional and AND-ed together.
 * A segment always belongs to one brand and is evaluated only against that brand's
 * relationship, orders, tickets, tags and consent: another brand's data never
 * influences membership.
 */
export interface SegmentRules {
  /** Bought a ticket for an event in this category (slug). */
  eventCategory?: string;
  /** Bought a ticket for this event. */
  eventId?: string;
  /** Bought a ticket for an event featuring this artist or team. */
  performerId?: string;
  country?: string;
  /** Lives in, or bought tickets for an event held in, this city. */
  city?: string;
  /** At least this many paid orders. */
  minOrders?: number;
  /** Net spend (paid minus refunded) of at least this amount, in `currency`. */
  minSpendMinor?: number;
  currency?: string;
  /** ISO dates bounding when the matching purchase was made. */
  purchasedAfter?: string;
  purchasedBefore?: string;
  /** Has bought before, but not in the last N days. */
  inactiveDays?: number;
  /** Abandoned a checkout in the last 30 days and has not completed a purchase in that period. */
  abandonedCheckout?: boolean;
  tagIds?: string[];
  /** Holds a valid ticket for a future event in this category (slug). */
  upcomingEventCategory?: string;
  /** Currently consents to marketing on this channel (for this brand). */
  hasMarketingConsent?: Channel;
}

const PAID: OrderStatus[] = ['PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED'];
const ABANDONED: OrderStatus[] = ['EXPIRED', 'CANCELLED', 'FAILED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'];

/** Validates untrusted JSON into SegmentRules: unknown keys and malformed values are rejected. */
export function normalizeRules(input: unknown): SegmentRules {
  const bad = (m: string): never => {
    throw new AppError('SEGMENT_RULES_INVALID', m, 400);
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Segment rules must be an object');
  const src = input as Record<string, unknown>;
  const out: SegmentRules = {};
  const str = (k: string, max = 100) => {
    const v = src[k];
    if (typeof v !== 'string' || !v.trim() || v.length > max) bad(`"${k}" must be a non-empty string`);
    return (v as string).trim();
  };
  const int = (k: string, min: number, max: number) => {
    const v = src[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) bad(`"${k}" must be an integer between ${min} and ${max}`);
    return v as number;
  };
  const uuid = (k: string) => {
    const v = str(k);
    if (!UUID.test(v)) bad(`"${k}" must be a UUID`);
    return v;
  };
  const date = (k: string) => {
    const v = str(k);
    if (Number.isNaN(Date.parse(v))) bad(`"${k}" must be an ISO date`);
    return v;
  };
  for (const k of Object.keys(src)) {
    if (src[k] === null || src[k] === undefined || src[k] === '') continue;
    switch (k) {
      case 'eventCategory': out.eventCategory = str(k); break;
      case 'upcomingEventCategory': out.upcomingEventCategory = str(k); break;
      case 'eventId': out.eventId = uuid(k); break;
      case 'performerId': out.performerId = uuid(k); break;
      case 'country': out.country = str(k); break;
      case 'city': out.city = str(k); break;
      case 'minOrders': out.minOrders = int(k, 1, 100000); break;
      case 'minSpendMinor': out.minSpendMinor = int(k, 1, Number.MAX_SAFE_INTEGER); break;
      case 'currency': {
        const c = str(k).toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) bad('"currency" must be an ISO-4217 code');
        out.currency = c;
        break;
      }
      case 'purchasedAfter': out.purchasedAfter = date(k); break;
      case 'purchasedBefore': out.purchasedBefore = date(k); break;
      case 'inactiveDays': out.inactiveDays = int(k, 1, 3650); break;
      case 'abandonedCheckout':
        if (typeof src[k] !== 'boolean') bad('"abandonedCheckout" must be true or false');
        if (src[k]) out.abandonedCheckout = true;
        break;
      case 'tagIds': {
        const v = src[k];
        if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string' || !UUID.test(x))) bad('"tagIds" must be a list of UUIDs');
        if ((v as string[]).length) out.tagIds = v as string[];
        break;
      }
      case 'hasMarketingConsent': {
        const c = str(k).toUpperCase();
        if (!CHANNELS.includes(c)) bad('"hasMarketingConsent" must be EMAIL, SMS or WHATSAPP');
        out.hasMarketingConsent = c as Channel;
        break;
      }
      default:
        bad(`Unknown segment rule "${k}"`);
    }
  }
  if (out.minSpendMinor !== undefined && !out.currency) bad('"currency" is required with "minSpendMinor" (amounts are never compared across currencies)');
  return out;
}

/**
 * The part of a segment that can be expressed as a plain Prisma filter. Aggregate rules
 * (minOrders, minSpendMinor) and hasMarketingConsent are resolved by SegmentService, which
 * narrows this filter further with the matching customer ids.
 */
export function segmentWhere(brandId: string, rules: SegmentRules): Prisma.CustomerWhereInput {
  const and: Prisma.CustomerWhereInput[] = [
    // Only people with a live relationship with this brand; merged, blocked and anonymised records never qualify.
    { status: 'ACTIVE', mergedIntoId: null, relationships: { some: { brandId, status: 'ACTIVE' } } },
  ];
  const paidOrder = (extra: Prisma.OrderWhereInput = {}): Prisma.OrderWhereInput => ({ brandId, status: { in: PAID }, ...extra });

  // Conditions about "a purchase" must hold for the same order.
  const purchase: Prisma.OrderWhereInput = {};
  const event: Prisma.EventWhereInput = {};
  if (rules.eventCategory) event.category = { slug: rules.eventCategory };
  if (rules.performerId) event.performers = { some: { performerId: rules.performerId } };
  if (Object.keys(event).length) purchase.event = event;
  if (rules.eventId) purchase.eventId = rules.eventId;
  if (rules.purchasedAfter || rules.purchasedBefore) {
    purchase.paidAt = { gte: rules.purchasedAfter ? new Date(rules.purchasedAfter) : undefined, lte: rules.purchasedBefore ? new Date(rules.purchasedBefore) : undefined };
  }
  if (Object.keys(purchase).length) and.push({ orders: { some: paidOrder(purchase) } });

  if (rules.country) and.push({ country: { equals: rules.country, mode: 'insensitive' } });
  if (rules.city) {
    and.push({
      OR: [
        { city: { equals: rules.city, mode: 'insensitive' } },
        { orders: { some: paidOrder({ event: { venue: { city: { equals: rules.city, mode: 'insensitive' } } } }) } },
      ],
    });
  }
  if (rules.inactiveDays) {
    const cutoff = new Date(Date.now() - rules.inactiveDays * 86400_000);
    and.push({ orders: { some: paidOrder() } }, { orders: { none: paidOrder({ paidAt: { gte: cutoff } }) } });
  }
  if (rules.abandonedCheckout) {
    // Simplification: "no completed purchase since" is evaluated over the same 30-day window
    // rather than per abandoned order.
    const since = new Date(Date.now() - 30 * 86400_000);
    and.push({ orders: { some: { brandId, status: { in: ABANDONED }, createdAt: { gte: since } } } }, { orders: { none: paidOrder({ createdAt: { gte: since } }) } });
  }
  if (rules.tagIds?.length) and.push({ tags: { some: { tagId: { in: rules.tagIds }, tag: { brandId } } } });
  if (rules.upcomingEventCategory) {
    and.push({ tickets: { some: { brandId, status: 'VALID', event: { startsAt: { gt: new Date() }, category: { slug: rules.upcomingEventCategory } } } } });
  }
  return { AND: and };
}

export interface SegmentMember {
  id: string;
  fullName: string;
  /** The address this person uses with this brand. */
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
}

@Injectable()
export class SegmentService {
  constructor(private prisma: PrismaService) {}

  /** Customer ids meeting the aggregate rules, computed from this brand's paid orders only. */
  private async aggregateIds(brandId: string, rules: SegmentRules): Promise<string[] | null> {
    if (rules.minOrders === undefined && rules.minSpendMinor === undefined) return null;
    if (rules.minSpendMinor !== undefined && !rules.currency) {
      throw new AppError('SEGMENT_RULES_INVALID', '"currency" is required with "minSpendMinor"', 400);
    }
    // When a currency is given both thresholds apply within that currency; spend is net of refunds.
    const currency = rules.currency ? Prisma.sql`AND "currency" = ${rules.currency}` : Prisma.empty;
    const having: Prisma.Sql[] = [];
    if (rules.minOrders !== undefined) having.push(Prisma.sql`COUNT(*) >= ${rules.minOrders}`);
    if (rules.minSpendMinor !== undefined) having.push(Prisma.sql`SUM("totalMinor" - "refundedMinor") >= ${BigInt(rules.minSpendMinor)}`);
    const rows = await this.prisma.$queryRaw<{ customerId: string }[]>`
      SELECT "customerId" FROM "orders"
       WHERE "brandId" = ${brandId}::uuid AND "status"::text IN ('PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED') ${currency}
       GROUP BY "customerId" HAVING ${Prisma.join(having, ' AND ')}`;
    return rows.map((r) => r.customerId);
  }

  /**
   * Consent is an append-only history where the latest row per (customer, brand, channel)
   * is the current state, which a relational `some/none` filter cannot express. The current
   * holders of consent are therefore resolved in SQL (DISTINCT ON ... latest row) and
   * intersected with the rest of the segment.
   */
  private async consentingIds(brandId: string, channel: Channel): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ customerId: string }[]>`
      SELECT "customerId" FROM (
        SELECT DISTINCT ON ("customerId") "customerId", "status"
          FROM "marketing_consents"
         WHERE "brandId" = ${brandId}::uuid AND "channel" = ${channel}::"Channel"
         ORDER BY "customerId", "createdAt" DESC
      ) latest WHERE "status" = 'GRANTED'`;
    return rows.map((r) => r.customerId);
  }

  /** Full filter for a segment, including aggregate and consent rules. */
  async where(brandId: string, rules: SegmentRules): Promise<Prisma.CustomerWhereInput> {
    const base = segmentWhere(brandId, rules);
    let ids = await this.aggregateIds(brandId, rules);
    if (rules.hasMarketingConsent) {
      const consenting = await this.consentingIds(brandId, rules.hasMarketingConsent);
      if (ids) {
        const set = new Set(consenting);
        ids = ids.filter((id) => set.has(id));
      } else {
        ids = consenting;
      }
    }
    return ids ? { AND: [base, { id: { in: ids } }] } : base;
  }

  async count(brandId: string, rules: SegmentRules): Promise<number> {
    return this.prisma.customer.count({ where: await this.where(brandId, rules) });
  }

  async members(brandId: string, rules: SegmentRules, page?: { skip?: number; take?: number }): Promise<SegmentMember[]> {
    const rows = await this.prisma.customer.findMany({
      where: await this.where(brandId, rules),
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: page?.skip, take: page?.take,
      select: { id: true, fullName: true, email: true, phone: true, country: true, city: true, relationships: { where: { brandId }, select: { email: true } } },
    });
    return rows.map((c) => ({ id: c.id, fullName: c.fullName, email: c.relationships[0]?.email ?? c.email, phone: c.phone, country: c.country, city: c.city }));
  }

  async preview(brandId: string, rules: SegmentRules, take = 10): Promise<{ count: number; sample: SegmentMember[] }> {
    const [count, sample] = await Promise.all([this.count(brandId, rules), this.members(brandId, rules, { take })]);
    return { count, sample };
  }
}
