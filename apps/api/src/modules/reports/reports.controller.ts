import { Controller, Get, Param, ParseUUIDPipe, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { assertEventAccess, brandScope, CurrentStaff, hasPermission, Permissions, Staff, StaffGuard } from '../../common/auth';
import { AppError, forbidden } from '../../common/errors';
import { PrismaService } from '../../common/infra';
import { dateRange, EXPORT_LIMIT, ExportColumn, paged, PageQuery, paging, sendExport } from '../../common/util';
import { CatalogService } from '../catalog/catalog.service';
import { CampaignService } from '../marketing/campaign.service';
import { PAID_STATES } from '../orders/order.service';
import { LedgerService } from '../payments/ledger.service';

class ReportQuery extends PageQuery {
  @IsOptional() @IsIn(['orders', 'revenue', 'tickets', 'customers']) metric?: 'orders' | 'revenue' | 'tickets' | 'customers';
  @IsOptional() @IsIn(['day', 'hour']) interval?: 'day' | 'hour';
  /** Ledger journal type filter. */
  @IsOptional() @IsIn(['PAYMENT_CAPTURE', 'GATEWAY_FEE', 'REFUND', 'SETTLEMENT', 'PAYOUT', 'ADJUSTMENT', 'REVERSAL']) type?: string;
  @IsOptional() @IsString() @MaxLength(40) orderReference?: string;
}

type Range = { gte?: Date; lte?: Date } | undefined;
interface Ctx {
  /** Brand ids the caller is restricted to; undefined = all brands. */
  scope: string[] | undefined;
  /** Event ids an event-scoped staff member is restricted to; undefined = no restriction. */
  events: string[] | undefined;
  range: Range;
}

const sql = Prisma.sql;
const PAID = sql`('PAID','TICKETS_ISSUED','PARTIALLY_REFUNDED','REFUNDED')`;
const col = (c: string) => Prisma.raw(c);
const WHERE = (parts: (Prisma.Sql | null | undefined)[]) => {
  const p = parts.filter((x): x is Prisma.Sql => !!x);
  return p.length ? sql`WHERE ${Prisma.join(p, ' AND ')}` : Prisma.empty;
};
const inIds = (c: string, ids: string[] | undefined) => (ids ? sql`${col(c)} = ANY(${ids}::uuid[])` : null);
const within = (c: string, r: Range) => [r?.gte ? sql`${col(c)} >= ${r.gte}` : null, r?.lte ? sql`${col(c)} <= ${r.lte}` : null];
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : 0);
const major = (minor: bigint | number) => Number(minor) / 100;

interface OrderAgg {
  currency: string;
  orders: number;
  paid: number;
  refunded: number;
  grossMinor: bigint;
  refundedMinor: bigint;
}

/**
 * Reporting. Every figure is computed for the caller's brand scope on the server, money is
 * always reported per currency, and financial reports are derived from the ledger rather
 * than from order statuses.
 */
@ApiTags('Admin · Reports & Analytics')
@ApiBearerAuth()
@Controller('v1/admin/reports')
@UseGuards(StaffGuard)
export class ReportsController {
  constructor(private prisma: PrismaService, private catalog: CatalogService, private ledger: LedgerService, private campaigns: CampaignService) {}

  private ctx(staff: Staff, q: PageQuery): Ctx {
    return { scope: brandScope(staff, q.brandId), events: staff.eventScoped ? staff.eventIds : undefined, range: dateRange(q) };
  }

  private exportFormat(staff: Staff, q: PageQuery): 'csv' | 'xlsx' | null {
    if (!q.format) return null;
    if (q.format !== 'csv' && q.format !== 'xlsx') throw new AppError('FORMAT_UNSUPPORTED', 'format must be csv or xlsx', 400);
    if (!hasPermission(staff, 'reports.export')) throw forbidden('Missing permission: reports.export');
    return q.format;
  }

  private orderConds(c: Ctx, alias = 'o', dateCol = 'createdAt') {
    return [inIds(`${alias}."brandId"`, c.scope), inIds(`${alias}."eventId"`, c.events), ...within(`${alias}."${dateCol}"`, c.range)];
  }

  private orderAgg(c: Ctx, groupBrand: boolean) {
    const brandCol = groupBrand ? sql`o."brandId",` : Prisma.empty;
    return this.prisma.$queryRaw<(OrderAgg & { brandId?: string })[]>`
      SELECT ${brandCol} o."currency",
             COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE o."status" IN ${PAID})::int AS paid,
             COUNT(*) FILTER (WHERE o."status" IN ('REFUNDED','PARTIALLY_REFUNDED'))::int AS refunded,
             COALESCE(SUM(o."totalMinor") FILTER (WHERE o."status" IN ${PAID}), 0)::bigint AS "grossMinor",
             COALESCE(SUM(o."refundedMinor") FILTER (WHERE o."status" IN ${PAID}), 0)::bigint AS "refundedMinor"
        FROM "orders" o ${WHERE(this.orderConds(c))}
       GROUP BY ${brandCol} o."currency" ORDER BY o."currency"`;
  }

  private money(rows: OrderAgg[]) {
    return rows.filter((r) => r.paid > 0).map((r) => ({
      currency: r.currency, paidOrders: r.paid, grossMinor: r.grossMinor, refundedMinor: r.refundedMinor, revenueMinor: r.grossMinor - r.refundedMinor,
    }));
  }
  private aov(rows: OrderAgg[]) {
    return rows.filter((r) => r.paid > 0).map((r) => ({ currency: r.currency, averageOrderValueMinor: r.grossMinor / BigInt(r.paid) }));
  }

  /** Converts per-currency revenue into the configured reporting currency using recorded exchange rates. */
  private async converted(revenue: { currency: string; revenueMinor: bigint }[], asOf: Date) {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: 'reporting.baseCurrency' } });
    const base = (setting?.value as { code?: string } | null)?.code;
    if (!base) return null;
    let total = new Prisma.Decimal(0);
    const ratesUsed: { base: string; quote: string; rate: string; asOf: Date }[] = [];
    const missingRates: string[] = [];
    for (const r of revenue) {
      if (r.currency === base) {
        total = total.add(r.revenueMinor.toString());
        continue;
      }
      const direct = await this.prisma.exchangeRate.findFirst({ where: { base: r.currency, quote: base, asOf: { lte: asOf } }, orderBy: { asOf: 'desc' } });
      const inverse = direct ? null : await this.prisma.exchangeRate.findFirst({ where: { base, quote: r.currency, asOf: { lte: asOf } }, orderBy: { asOf: 'desc' } });
      if (direct) {
        total = total.add(new Prisma.Decimal(r.revenueMinor.toString()).mul(direct.rate));
        ratesUsed.push({ base: direct.base, quote: direct.quote, rate: direct.rate.toString(), asOf: direct.asOf });
      } else if (inverse && !inverse.rate.isZero()) {
        total = total.add(new Prisma.Decimal(r.revenueMinor.toString()).div(inverse.rate));
        ratesUsed.push({ base: inverse.base, quote: inverse.quote, rate: inverse.rate.toString(), asOf: inverse.asOf });
      } else {
        missingRates.push(r.currency);
      }
    }
    return {
      label: `Converted to ${base} using recorded exchange rates. An estimate for comparison only, not an accounting figure.`,
      currency: base, amountMinor: BigInt(total.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)), ratesUsed, missingRates,
      complete: missingRates.length === 0,
    };
  }

  // ───────────────────────── Platform / brand overview ─────────────────────────

  @Get('overview')
  @Permissions('reports.read')
  async overview(@CurrentStaff() staff: Staff, @Query() q: ReportQuery) {
    const c = this.ctx(staff, q);
    const brandIn = c.scope ? { brandId: { in: c.scope } } : {};
    const eventIn = c.events ? { eventId: { in: c.events } } : {};
    const [agg, ticketsSold, activeEvents, customers, newCustomers, organizers, brands, payments] = await Promise.all([
      this.orderAgg(c, false),
      this.prisma.ticket.count({ where: { ...brandIn, ...eventIn, status: { in: ['VALID', 'USED'] }, ...(c.range ? { issuedAt: c.range } : {}) } }),
      this.prisma.event.count({ where: { AND: [this.catalog.eventVisibility(staff, q.brandId), { status: { in: ['PUBLISHED', 'POSTPONED'] }, startsAt: { gte: new Date() } }] } }),
      this.prisma.customerBrandRelationship.count({ where: brandIn }),
      this.prisma.customerBrandRelationship.count({ where: { ...brandIn, ...(c.range ? { createdAt: c.range } : {}) } }),
      this.prisma.organizer.count({ where: c.scope || c.events ? { events: { some: this.catalog.eventVisibility(staff, q.brandId) } } : {} }),
      this.prisma.brand.count({ where: c.scope ? { id: { in: c.scope } } : {} }),
      this.prisma.payment.groupBy({
        by: ['status'], _count: true,
        where: { ...brandIn, ...(c.events ? { order: { eventId: { in: c.events } } } : {}), ...(c.range ? { createdAt: c.range } : {}) },
      }),
    ]);
    const orders = agg.reduce((s, r) => s + r.orders, 0);
    const paidOrders = agg.reduce((s, r) => s + r.paid, 0);
    const refundedOrders = agg.reduce((s, r) => s + r.refunded, 0);
    const pay = (st: string) => payments.find((p) => p.status === st)?._count ?? 0;
    const revenueByCurrency = this.money(agg);
    return {
      scope: { brandIds: c.scope ?? 'ALL', from: c.range?.gte ?? null, to: c.range?.lte ?? null },
      revenueByCurrency,
      convertedRevenue: await this.converted(revenueByCurrency, c.range?.lte ?? new Date()),
      orders, paidOrders, ticketsSold, activeEvents, customers, newCustomers, organizers, brands,
      payments: { succeeded: pay('SUCCEEDED'), failed: pay('FAILED'), pending: pay('PENDING') + pay('INITIATED'), cancelled: pay('CANCELLED') },
      paymentSuccessRate: ratio(pay('SUCCEEDED'), pay('SUCCEEDED') + pay('FAILED')),
      refundRate: ratio(refundedOrders, paidOrders),
      conversionRate: ratio(paidOrders, orders),
      averageOrderValueByCurrency: this.aov(agg),
    };
  }

  /** Side-by-side comparison of every storefront brand the caller can see. */
  @Get('brands')
  @Permissions('reports.read')
  async brands(@CurrentStaff() staff: Staff, @Query() q: ReportQuery, @Res() res: Response) {
    const format = this.exportFormat(staff, q);
    const c = this.ctx(staff, q);
    const brandIn = c.scope ? { brandId: { in: c.scope } } : {};
    const eventIn = c.events ? { eventId: { in: c.events } } : {};
    const [brands, agg, tickets, newCustomers, top] = await Promise.all([
      this.prisma.brand.findMany({ where: c.scope ? { id: { in: c.scope } } : {}, select: { id: true, name: true, slug: true, status: true, primaryColor: true }, orderBy: { name: 'asc' } }),
      this.orderAgg(c, true),
      this.prisma.ticket.groupBy({ by: ['brandId'], _count: true, where: { ...brandIn, ...eventIn, status: { in: ['VALID', 'USED'] }, ...(c.range ? { issuedAt: c.range } : {}) } }),
      this.prisma.customerBrandRelationship.groupBy({ by: ['brandId'], _count: true, where: { ...brandIn, ...(c.range ? { createdAt: c.range } : {}) } }),
      this.prisma.$queryRaw<{ brandId: string; eventId: string; name: string; currency: string; orders: number; revenueMinor: bigint }[]>`
        SELECT "brandId", "eventId", "name", "currency", orders, "revenueMinor" FROM (
          SELECT o."brandId", o."eventId", e."name", o."currency", COUNT(*)::int AS orders,
                 SUM(o."totalMinor" - o."refundedMinor")::bigint AS "revenueMinor",
                 ROW_NUMBER() OVER (PARTITION BY o."brandId" ORDER BY COUNT(*) DESC, SUM(o."totalMinor") DESC) AS rn
            FROM "orders" o JOIN "events" e ON e."id" = o."eventId"
            ${WHERE([sql`o."status" IN ${PAID}`, ...this.orderConds(c)])}
           GROUP BY o."brandId", o."eventId", e."name", o."currency") t
         WHERE rn <= 3 ORDER BY "brandId", rn`,
    ]);
    const data = brands.map((b) => {
      const rows = agg.filter((r) => r.brandId === b.id);
      const orders = rows.reduce((s, r) => s + r.orders, 0);
      const paidOrders = rows.reduce((s, r) => s + r.paid, 0);
      return {
        brand: b, orders, paidOrders,
        ticketsSold: tickets.find((t) => t.brandId === b.id)?._count ?? 0,
        revenueByCurrency: this.money(rows),
        averageOrderValueByCurrency: this.aov(rows),
        conversionRate: ratio(paidOrders, orders),
        refundRate: ratio(rows.reduce((s, r) => s + r.refunded, 0), paidOrders),
        newCustomers: newCustomers.find((n) => n.brandId === b.id)?._count ?? 0,
        topEvents: top.filter((t) => t.brandId === b.id).map(({ brandId: _b, ...t }) => t),
      };
    });
    if (!format) return res.json(data);
    type Row = { brand: string; currency: string; orders: number; paidOrders: number; tickets: number; revenue: number; aov: number; conversion: number; refundRate: number; newCustomers: number };
    const rows: Row[] = data.flatMap((d) =>
      (d.revenueByCurrency.length ? d.revenueByCurrency : [{ currency: '-', revenueMinor: 0n, paidOrders: 0, grossMinor: 0n, refundedMinor: 0n }]).map((r) => ({
        brand: d.brand.name, currency: r.currency, orders: d.orders, paidOrders: r.paidOrders, tickets: d.ticketsSold, revenue: major(r.revenueMinor),
        aov: major(d.averageOrderValueByCurrency.find((a) => a.currency === r.currency)?.averageOrderValueMinor ?? 0n),
        conversion: d.conversionRate, refundRate: d.refundRate, newCustomers: d.newCustomers,
      })),
    );
    const columns: ExportColumn<Row>[] = [
      { header: 'Brand', value: (r) => r.brand }, { header: 'Currency', value: (r) => r.currency }, { header: 'Orders (all currencies)', value: (r) => r.orders },
      { header: 'Paid orders', value: (r) => r.paidOrders }, { header: 'Tickets sold (all currencies)', value: (r) => r.tickets }, { header: 'Revenue', value: (r) => r.revenue },
      { header: 'Average order value', value: (r) => r.aov }, { header: 'Conversion rate', value: (r) => r.conversion }, { header: 'Refund rate', value: (r) => r.refundRate },
      { header: 'New customers', value: (r) => r.newCustomers },
    ];
    return sendExport(res, format, 'brand-performance', columns, rows);
  }

  /** Live activity feed for the dashboard. */
  @Get('live')
  @Permissions('reports.read')
  async live(@CurrentStaff() staff: Staff, @Query() q: ReportQuery) {
    const c = this.ctx(staff, q);
    const brandIn = c.scope ? { brandId: { in: c.scope } } : {};
    const eventIn = c.events ? { eventId: { in: c.events } } : {};
    const orderEvent = c.events ? { order: { eventId: { in: c.events } } } : {};
    const take = 10;
    const [recentOrders, recentPayments, recentTickets, recentScans, failedPayments, pendingRefunds, failedNotifications] = await Promise.all([
      this.prisma.order.findMany({
        where: { ...brandIn, ...eventIn }, orderBy: { createdAt: 'desc' }, take,
        select: { id: true, reference: true, brandId: true, status: true, paymentStatus: true, totalMinor: true, currency: true, customerName: true, createdAt: true, event: { select: { name: true } } },
      }),
      this.prisma.payment.findMany({
        where: { ...brandIn, ...orderEvent, status: 'SUCCEEDED' }, orderBy: { paidAt: 'desc' }, take,
        select: { id: true, reference: true, brandId: true, providerCode: true, amountMinor: true, currency: true, paidAt: true, order: { select: { reference: true } } },
      }),
      this.prisma.ticket.findMany({
        where: { ...brandIn, ...eventIn }, orderBy: { issuedAt: 'desc' }, take,
        select: { id: true, reference: true, brandId: true, status: true, issuedAt: true, event: { select: { name: true } }, ticketCategory: { select: { name: true } } },
      }),
      this.prisma.ticketScan.findMany({
        where: { ...eventIn, ...(c.scope ? { ticket: { brandId: { in: c.scope } } } : {}) }, orderBy: { receivedAt: 'desc' }, take,
        select: { id: true, result: true, gate: true, offline: true, scannedAt: true, eventId: true, ticket: { select: { reference: true, brandId: true } } },
      }),
      this.prisma.payment.findMany({
        where: { ...brandIn, ...orderEvent, status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, take,
        select: { id: true, reference: true, brandId: true, providerCode: true, amountMinor: true, currency: true, failureReason: true, updatedAt: true, order: { select: { reference: true } } },
      }),
      this.prisma.refund.findMany({
        where: { ...brandIn, ...orderEvent, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } }, orderBy: { requestedAt: 'desc' }, take,
        select: { id: true, reference: true, brandId: true, status: true, amountMinor: true, currency: true, reason: true, requestedAt: true, order: { select: { reference: true } } },
      }),
      c.events ? Promise.resolve([]) : this.prisma.emailJob.findMany({
        where: { ...brandIn, status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take,
        select: { id: true, brandId: true, type: true, channel: true, toAddress: true, lastError: true, attempts: true, createdAt: true },
      }),
    ]);
    return { asOf: new Date(), recentOrders, recentPayments, recentTickets, recentScans, failedPayments, pendingRefunds, failedNotifications };
  }

  /** Time series for charts. Revenue is one series per currency. Defaults to the last 30 days. */
  @Get('timeseries')
  @Permissions('reports.read')
  async timeseries(@CurrentStaff() staff: Staff, @Query() q: ReportQuery, @Res() res: Response) {
    const format = this.exportFormat(staff, q);
    const c = this.ctx(staff, q);
    c.range = { gte: c.range?.gte ?? new Date(Date.now() - 30 * 86400_000), lte: c.range?.lte };
    const metric = q.metric ?? 'orders';
    const interval = q.interval === 'hour' ? 'hour' : 'day';
    const unit = Prisma.raw(`'${interval}'`);
    type Point = { bucket: Date; currency?: string; value: bigint | number; paid?: number };
    let points: Point[];
    if (metric === 'revenue') {
      points = await this.prisma.$queryRaw<Point[]>`
        SELECT date_trunc(${unit}, o."createdAt") AS bucket, o."currency", SUM(o."totalMinor" - o."refundedMinor")::bigint AS value, COUNT(*)::int AS paid
          FROM "orders" o ${WHERE([sql`o."status" IN ${PAID}`, ...this.orderConds(c)])}
         GROUP BY 1, 2 ORDER BY 1, 2`;
    } else if (metric === 'tickets') {
      points = await this.prisma.$queryRaw<Point[]>`
        SELECT date_trunc(${unit}, t."issuedAt") AS bucket, COUNT(*)::int AS value
          FROM "tickets" t ${WHERE([sql`t."status" <> 'TRANSFERRED'`, inIds('t."brandId"', c.scope), inIds('t."eventId"', c.events), ...within('t."issuedAt"', c.range)])}
         GROUP BY 1 ORDER BY 1`;
    } else if (metric === 'customers') {
      points = c.events ? [] : await this.prisma.$queryRaw<Point[]>`
        SELECT date_trunc(${unit}, r."createdAt") AS bucket, COUNT(*)::int AS value
          FROM "customer_brand_relationships" r ${WHERE([inIds('r."brandId"', c.scope), ...within('r."createdAt"', c.range)])}
         GROUP BY 1 ORDER BY 1`;
    } else {
      points = await this.prisma.$queryRaw<Point[]>`
        SELECT date_trunc(${unit}, o."createdAt") AS bucket, COUNT(*)::int AS value, COUNT(*) FILTER (WHERE o."status" IN ${PAID})::int AS paid
          FROM "orders" o ${WHERE(this.orderConds(c))}
         GROUP BY 1 ORDER BY 1`;
    }
    if (!format) return res.json({ metric, interval, from: c.range.gte, to: c.range.lte ?? null, points });
    const columns: ExportColumn<Point>[] = [
      { header: 'Period start (UTC)', value: (p) => p.bucket }, { header: 'Currency', value: (p) => p.currency ?? '' },
      { header: metric === 'revenue' ? 'Revenue' : metric, value: (p) => (metric === 'revenue' ? major(p.value as bigint) : p.value) },
      { header: 'Paid orders', value: (p) => p.paid ?? '' },
    ];
    return sendExport(res, format, `timeseries-${metric}`, columns, points);
  }

  // ───────────────────────── Events ─────────────────────────

  @Get('events')
  @Permissions('reports.read')
  async events(@CurrentStaff() staff: Staff, @Query() q: ReportQuery, @Res() res: Response) {
    const format = this.exportFormat(staff, q);
    const c = this.ctx(staff, q);
    const where: Prisma.EventWhereInput = {
      AND: [
        this.catalog.eventVisibility(staff, q.brandId),
        { status: { not: 'ARCHIVED' } },
        q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {},
        c.range ? { startsAt: c.range } : {},
      ],
    };
    const { skip, take } = format ? { skip: 0, take: EXPORT_LIMIT } : paging(q);
    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where, skip, take, orderBy: { startsAt: 'desc' },
        select: { id: true, name: true, status: true, startsAt: true, venue: { select: { name: true, city: true } }, ticketCategories: { select: { inventory: true } } },
      }),
      this.prisma.event.count({ where }),
    ]);
    const ids = events.map((e) => e.id);
    const brandIn = c.scope ? { brandId: { in: c.scope } } : {};
    const [tickets, revenue, checkins, refunds] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['eventId'], _count: true, where: { eventId: { in: ids }, ...brandIn, status: { in: ['VALID', 'USED'] } } }),
      this.prisma.order.groupBy({ by: ['eventId', 'currency'], _count: true, _sum: { totalMinor: true, refundedMinor: true }, where: { eventId: { in: ids }, ...brandIn, status: { in: PAID_STATES } } }),
      this.prisma.$queryRaw<{ eventId: string; n: number }[]>`
        SELECT s."eventId", COUNT(*)::int AS n FROM "ticket_scans" s JOIN "tickets" t ON t."id" = s."ticketId"
        ${WHERE([sql`s."result" = 'ADMITTED'`, inIds('s."eventId"', ids), inIds('t."brandId"', c.scope)])} GROUP BY s."eventId"`,
      this.prisma.$queryRaw<{ eventId: string; currency: string; n: number; amountMinor: bigint }[]>`
        SELECT o."eventId", r."currency", COUNT(*)::int AS n, SUM(r."amountMinor")::bigint AS "amountMinor"
          FROM "refunds" r JOIN "orders" o ON o."id" = r."orderId"
        ${WHERE([sql`r."status" = 'SUCCEEDED'`, inIds('o."eventId"', ids), inIds('r."brandId"', c.scope)])} GROUP BY o."eventId", r."currency"`,
    ]);
    const items = events.map((e) => {
      const capacity = e.ticketCategories.reduce((s, x) => s + (x.inventory?.total ?? 0), 0);
      const centralSold = e.ticketCategories.reduce((s, x) => s + (x.inventory?.sold ?? 0), 0);
      const reserved = e.ticketCategories.reduce((s, x) => s + (x.inventory?.reserved ?? 0), 0);
      return {
        id: e.id, name: e.name, status: e.status, startsAt: e.startsAt, venue: e.venue ? `${e.venue.name}, ${e.venue.city}` : null,
        capacity,
        // Brand-scoped callers see their own brands' sales; platform staff see the central total.
        sold: c.scope ? (tickets.find((t) => t.eventId === e.id)?._count ?? 0) : centralSold,
        soldScope: c.scope ? 'SELECTED_BRANDS' : 'ALL_BRANDS',
        remaining: capacity - centralSold - reserved,
        revenueByCurrency: revenue.filter((r) => r.eventId === e.id).map((r) => ({ currency: r.currency, paidOrders: r._count, revenueMinor: (r._sum.totalMinor ?? 0n) - (r._sum.refundedMinor ?? 0n) })),
        checkIns: checkins.find((x) => x.eventId === e.id)?.n ?? 0,
        refunds: refunds.filter((r) => r.eventId === e.id).map((r) => ({ currency: r.currency, count: r.n, amountMinor: r.amountMinor })),
      };
    });
    if (!format) return res.json(paged(items, total, q));
    type Row = (typeof items)[number] & { currency: string; revenue: number; refunded: number };
    const rows: Row[] = items.flatMap((i) => {
      const currencies = [...new Set([...i.revenueByCurrency.map((r) => r.currency), ...i.refunds.map((r) => r.currency)])];
      return (currencies.length ? currencies : ['-']).map((cur) => ({
        ...i, currency: cur, revenue: major(i.revenueByCurrency.find((r) => r.currency === cur)?.revenueMinor ?? 0n), refunded: major(i.refunds.find((r) => r.currency === cur)?.amountMinor ?? 0n),
      }));
    });
    const columns: ExportColumn<Row>[] = [
      { header: 'Event', value: (r) => r.name }, { header: 'Starts', value: (r) => r.startsAt }, { header: 'Status', value: (r) => r.status }, { header: 'Venue', value: (r) => r.venue },
      { header: 'Capacity', value: (r) => r.capacity }, { header: 'Tickets sold', value: (r) => r.sold }, { header: 'Remaining', value: (r) => r.remaining },
      { header: 'Check-ins', value: (r) => r.checkIns }, { header: 'Currency', value: (r) => r.currency }, { header: 'Revenue', value: (r) => r.revenue }, { header: 'Refunded', value: (r) => r.refunded },
    ];
    return sendExport(res, format, 'event-performance', columns, rows);
  }

  @Get('events/:id')
  @Permissions('reports.read')
  async event(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQuery) {
    const event = await this.catalog.assertCanView(staff, id);
    assertEventAccess(staff, id);
    const scope = brandScope(staff, q.brandId);
    const brandIn = scope ? { brandId: { in: scope } } : {};
    const [categories, byCategory, byBrand, revenueByBrand, salesOverTime, checkinsByHour, refunds, scans] = await Promise.all([
      this.prisma.ticketCategory.findMany({ where: { eventId: id }, include: { inventory: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.ticket.groupBy({ by: ['ticketCategoryId'], _count: true, where: { eventId: id, ...brandIn, status: { in: ['VALID', 'USED'] } } }),
      this.prisma.ticket.groupBy({ by: ['brandId'], _count: true, where: { eventId: id, ...brandIn, status: { in: ['VALID', 'USED'] } } }),
      this.prisma.order.groupBy({ by: ['brandId', 'currency'], _count: true, _sum: { totalMinor: true, refundedMinor: true }, where: { eventId: id, ...brandIn, status: { in: PAID_STATES } } }),
      this.prisma.$queryRaw<{ bucket: Date; tickets: number }[]>`
        SELECT date_trunc('day', t."issuedAt") AS bucket, COUNT(*)::int AS tickets FROM "tickets" t
        ${WHERE([sql`t."eventId" = ${id}::uuid`, sql`t."status" <> 'TRANSFERRED'`, inIds('t."brandId"', scope)])} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ bucket: Date; admitted: number }[]>`
        SELECT date_trunc('hour', s."scannedAt") AS bucket, COUNT(*)::int AS admitted FROM "ticket_scans" s JOIN "tickets" t ON t."id" = s."ticketId"
        ${WHERE([sql`s."eventId" = ${id}::uuid`, sql`s."result" = 'ADMITTED'`, inIds('t."brandId"', scope)])} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ currency: string; status: string; n: number; amountMinor: bigint }[]>`
        SELECT r."currency", r."status"::text AS status, COUNT(*)::int AS n, SUM(r."amountMinor")::bigint AS "amountMinor"
          FROM "refunds" r JOIN "orders" o ON o."id" = r."orderId"
        ${WHERE([sql`o."eventId" = ${id}::uuid`, inIds('r."brandId"', scope)])} GROUP BY r."currency", r."status"`,
      this.prisma.$queryRaw<{ result: string; n: number }[]>`
        SELECT s."result"::text AS result, COUNT(*)::int AS n FROM "ticket_scans" s LEFT JOIN "tickets" t ON t."id" = s."ticketId"
        ${WHERE([sql`s."eventId" = ${id}::uuid`, scope ? sql`t."brandId" = ANY(${scope}::uuid[])` : null])} GROUP BY s."result"`,
    ]);
    const brands = await this.prisma.brand.findMany({ where: { id: { in: byBrand.map((b) => b.brandId) } }, select: { id: true, name: true, primaryColor: true } });
    const sold = byCategory.reduce((s, x) => s + x._count, 0);
    const admitted = scans.find((s) => s.result === 'ADMITTED')?.n ?? 0;
    return {
      event: { id: event.id, name: event.name, status: event.status, startsAt: event.startsAt, endsAt: event.endsAt, timezone: event.timezone },
      soldScope: scope ? 'SELECTED_BRANDS' : 'ALL_BRANDS',
      totals: {
        capacity: categories.reduce((s, x) => s + (x.inventory?.total ?? 0), 0),
        sold,
        remaining: categories.reduce((s, x) => s + (x.inventory ? x.inventory.total - x.inventory.sold - x.inventory.reserved : 0), 0),
        checkIns: admitted, checkInRate: ratio(admitted, sold),
      },
      byCategory: categories.map((cat) => ({
        ticketCategoryId: cat.id, name: cat.name, priceMinor: cat.priceMinor, currency: cat.currency, capacity: cat.inventory?.total ?? 0,
        sold: byCategory.find((x) => x.ticketCategoryId === cat.id)?._count ?? 0,
        remaining: cat.inventory ? cat.inventory.total - cat.inventory.sold - cat.inventory.reserved : 0,
      })),
      byBrand: byBrand.map((b) => ({
        brandId: b.brandId, brandName: brands.find((x) => x.id === b.brandId)?.name, color: brands.find((x) => x.id === b.brandId)?.primaryColor, tickets: b._count,
        revenueByCurrency: revenueByBrand.filter((r) => r.brandId === b.brandId).map((r) => ({ currency: r.currency, paidOrders: r._count, revenueMinor: (r._sum.totalMinor ?? 0n) - (r._sum.refundedMinor ?? 0n) })),
      })),
      revenueByCurrency: Object.values(
        revenueByBrand.reduce<Record<string, { currency: string; paidOrders: number; revenueMinor: bigint }>>((acc, r) => {
          const a = (acc[r.currency] ??= { currency: r.currency, paidOrders: 0, revenueMinor: 0n });
          a.paidOrders += r._count;
          a.revenueMinor += (r._sum.totalMinor ?? 0n) - (r._sum.refundedMinor ?? 0n);
          return acc;
        }, {}),
      ),
      salesOverTime, checkInsByHour: checkinsByHour, scanResults: scans,
      refunds: refunds.map((r) => ({ currency: r.currency, status: r.status, count: r.n, amountMinor: r.amountMinor })),
    };
  }

  @Get('sales-by-category')
  @Permissions('reports.read')
  async salesByCategory(@CurrentStaff() staff: Staff, @Query() q: ReportQuery, @Res() res: Response) {
    const format = this.exportFormat(staff, q);
    const c = this.ctx(staff, q);
    const rows = await this.prisma.$queryRaw<{ category: string; currency: string; orders: number; tickets: number; revenueMinor: bigint }[]>`
      SELECT COALESCE(ec."name", 'Uncategorised') AS category, o."currency", COUNT(DISTINCT o."id")::int AS orders,
             COALESCE(SUM(i.qty), 0)::int AS tickets, SUM(o."totalMinor" - o."refundedMinor")::bigint AS "revenueMinor"
        FROM "orders" o
        JOIN "events" e ON e."id" = o."eventId"
        LEFT JOIN "event_categories" ec ON ec."id" = e."categoryId"
        LEFT JOIN (SELECT "orderId", SUM("quantity") AS qty FROM "order_items" GROUP BY "orderId") i ON i."orderId" = o."id"
        ${WHERE([sql`o."status" IN ${PAID}`, ...this.orderConds(c)])}
       GROUP BY 1, 2 ORDER BY 1, 2`;
    if (!format) return res.json(rows);
    return sendExport(res, format, 'sales-by-category', [
      { header: 'Event category', value: (r) => r.category }, { header: 'Currency', value: (r) => r.currency }, { header: 'Paid orders', value: (r) => r.orders },
      { header: 'Tickets', value: (r) => r.tickets }, { header: 'Revenue', value: (r) => major(r.revenueMinor) },
    ], rows);
  }

  // ───────────────────────── Finance (from the ledger) ─────────────────────────

  @Get('financial')
  @Permissions('reports.financial')
  async financial(@CurrentStaff() staff: Staff, @Query() q: ReportQuery, @Res() res: Response) {
    const format = this.exportFormat(staff, q);
    const scope = brandScope(staff, q.brandId);
    const range = dateRange(q);
    const rows = await this.prisma.$queryRaw<{ currency: string; type: string; account: string; direction: string; amountMinor: bigint }[]>`
      SELECT e."currency", t."type"::text AS type, e."account"::text AS account, e."direction"::text AS direction, SUM(e."amountMinor")::bigint AS "amountMinor"
        FROM "financial_ledger_entries" e JOIN "ledger_transactions" t ON t."id" = e."transactionId"
        ${WHERE([inIds('e."brandId"', scope), ...within('e."createdAt"', range)])}
       GROUP BY 1, 2, 3, 4`;
    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    const summary = currencies.map((currency) => {
      const pick = (account: string, direction: string, type?: string) =>
        rows.filter((r) => r.currency === currency && r.account === account && r.direction === direction && (!type || r.type === type)).reduce((s, r) => s + r.amountMinor, 0n);
      const net = (account: string) => pick(account, 'CREDIT') - pick(account, 'DEBIT');
      const grossSalesMinor = pick('GATEWAY_CLEARING', 'DEBIT', 'PAYMENT_CAPTURE');
      const refundsMinor = pick('GATEWAY_CLEARING', 'CREDIT', 'REFUND');
      const gatewayChargesMinor = pick('GATEWAY_FEE_EXPENSE', 'DEBIT') - pick('GATEWAY_FEE_EXPENSE', 'CREDIT');
      return {
        currency, grossSalesMinor, refundsMinor, gatewayChargesMinor,
        serviceFeesMinor: net('SERVICE_FEE_REVENUE'), taxesMinor: net('TAX_PAYABLE'),
        platformCommissionMinor: net('PLATFORM_COMMISSION_REVENUE'), brandCommissionMinor: net('BRAND_COMMISSION_PAYABLE'),
        promoterPayableMinor: net('PROMOTER_PAYABLE'),
        promoterPaidOutMinor: pick('PROMOTER_PAYABLE', 'DEBIT', 'PAYOUT'),
        settledToBankMinor: pick('BANK', 'DEBIT', 'SETTLEMENT'),
        netSettlementMinor: grossSalesMinor - refundsMinor - gatewayChargesMinor,
      };
    });
    if (!format) {
      return res.json({
        basis: 'Derived from immutable ledger entries, not from order statuses.',
        from: range?.gte ?? null, to: range?.lte ?? null, summary,
        balances: await this.ledger.balances({ brandIds: scope }),
      });
    }
    type Row = (typeof summary)[number];
    const m = (f: (r: Row) => bigint) => (r: Row) => major(f(r));
    return sendExport<Row>(res, format, 'financial-summary', [
      { header: 'Currency', value: (r) => r.currency }, { header: 'Gross sales', value: m((r) => r.grossSalesMinor) }, { header: 'Service fees', value: m((r) => r.serviceFeesMinor) },
      { header: 'Taxes', value: m((r) => r.taxesMinor) }, { header: 'Gateway charges', value: m((r) => r.gatewayChargesMinor) }, { header: 'Refunds', value: m((r) => r.refundsMinor) },
      { header: 'Platform commission', value: m((r) => r.platformCommissionMinor) }, { header: 'Brand commission', value: m((r) => r.brandCommissionMinor) },
      { header: 'Promoter payable (net)', value: m((r) => r.promoterPayableMinor) }, { header: 'Paid out to promoters', value: m((r) => r.promoterPaidOutMinor) },
      { header: 'Settled to bank', value: m((r) => r.settledToBankMinor) }, { header: 'Net settlement', value: m((r) => r.netSettlementMinor) },
    ], summary);
  }

  /** The journal: every financial transaction with its debit and credit lines. */
  @Get('ledger')
  @Permissions('reports.financial')
  async ledgerList(@CurrentStaff() staff: Staff, @Query() q: ReportQuery, @Res() res: Response) {
    const format = this.exportFormat(staff, q);
    const scope = brandScope(staff, q.brandId);
    const range = dateRange(q);
    let orderId: string | undefined;
    if (q.orderReference) {
      const order = await this.prisma.order.findFirst({ where: { reference: q.orderReference.toUpperCase(), ...(scope ? { brandId: { in: scope } } : {}) }, select: { id: true } });
      orderId = order?.id ?? '00000000-0000-0000-0000-000000000000';
    }
    const where: Prisma.LedgerTransactionWhereInput = {
      ...(scope ? { brandId: { in: scope } } : {}),
      ...(q.type ? { type: q.type as Prisma.LedgerTransactionWhereInput['type'] } : {}),
      ...(orderId ? { orderId } : {}),
      ...(range ? { createdAt: range } : {}),
    };
    const { skip, take } = format ? { skip: 0, take: 10_000 } : paging(q);
    const [items, total] = await Promise.all([
      this.prisma.ledgerTransaction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { entries: { orderBy: { direction: 'desc' } } } }),
      this.prisma.ledgerTransaction.count({ where }),
    ]);
    if (!format) return res.json(paged(items, total, q));
    const rows = items.flatMap((t) => t.entries.map((e) => ({ t, e })));
    return sendExport(res, format, 'ledger', [
      { header: 'Date', value: (r) => r.t.createdAt }, { header: 'Journal', value: (r) => r.t.id }, { header: 'Type', value: (r) => r.t.type }, { header: 'Description', value: (r) => r.t.description },
      { header: 'Account', value: (r) => r.e.account }, { header: 'Currency', value: (r) => r.e.currency },
      { header: 'Debit', value: (r) => (r.e.direction === 'DEBIT' ? major(r.e.amountMinor) : '') }, { header: 'Credit', value: (r) => (r.e.direction === 'CREDIT' ? major(r.e.amountMinor) : '') },
      { header: 'Brand', value: (r) => r.e.brandId }, { header: 'Order', value: (r) => r.e.orderId }, { header: 'Organizer', value: (r) => r.e.organizerId },
    ], rows);
  }

  // ───────────────────────── Marketing ─────────────────────────

  @Get('marketing')
  @Permissions('marketing.read')
  async marketing(@CurrentStaff() staff: Staff, @Query() q: ReportQuery) {
    const scope = brandScope(staff, q.brandId);
    const range = dateRange(q);
    const brandIn = scope ? { brandId: { in: scope } } : {};
    const [byStatus, sent, promoOrders, consents] = await Promise.all([
      this.prisma.campaign.groupBy({ by: ['status'], _count: true, where: { ...brandIn, ...(range ? { createdAt: range } : {}) } }),
      this.prisma.campaign.findMany({
        where: { ...brandIn, status: 'SENT', ...(range ? { sentAt: range } : {}) }, orderBy: { sentAt: 'desc' }, take: 200,
        select: { id: true, name: true, brandId: true, channel: true, sentAt: true },
      }),
      this.prisma.order.groupBy({
        by: ['promoCodeId', 'currency'], _count: true, _sum: { totalMinor: true, refundedMinor: true, discountMinor: true },
        where: { ...brandIn, promoCodeId: { not: null }, status: { in: PAID_STATES }, ...(range ? { createdAt: range } : {}) },
      }),
      this.prisma.marketingConsent.groupBy({ by: ['channel', 'status'], _count: true, where: { ...brandIn, ...(range ? { createdAt: range } : {}) } }),
    ]);
    const stats = await this.campaigns.performance(sent.map((s) => s.id));
    const totals = this.campaigns.emptyStats();
    const revenue = new Map<string, { currency: string; orders: number; revenueMinor: bigint }>();
    for (const s of stats.values()) {
      for (const k of ['audience', 'sent', 'delivered', 'failed', 'pending', 'skipped', 'opens', 'clicks', 'totalClicks', 'unsubscribes', 'conversions'] as const) totals[k] += s[k];
      for (const r of s.revenueByCurrency) {
        const a = revenue.get(r.currency) ?? { currency: r.currency, orders: 0, revenueMinor: 0n };
        a.orders += r.orders;
        a.revenueMinor += r.revenueMinor;
        revenue.set(r.currency, a);
      }
    }
    const codes = await this.prisma.promoCode.findMany({ where: { id: { in: promoOrders.map((p) => p.promoCodeId!).filter(Boolean) } }, select: { id: true, code: true, brandId: true, redeemedCount: true } });
    return {
      campaigns: {
        byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
        totals: {
          ...totals, revenueByCurrency: [...revenue.values()],
          openRate: ratio(totals.opens, totals.sent), clickRate: ratio(totals.clicks, totals.sent), conversionRate: ratio(totals.conversions, totals.sent),
        },
        recent: sent.slice(0, 20).map((s) => ({ ...s, ...stats.get(s.id) })),
      },
      promoCodes: codes.map((p) => ({
        ...p,
        usage: promoOrders.filter((o) => o.promoCodeId === p.id).map((o) => ({
          currency: o.currency, paidOrders: o._count, revenueMinor: (o._sum.totalMinor ?? 0n) - (o._sum.refundedMinor ?? 0n), discountMinor: o._sum.discountMinor ?? 0n,
        })),
      })),
      consentChanges: consents.map((x) => ({ channel: x.channel, status: x.status, count: x._count })),
    };
  }
}
