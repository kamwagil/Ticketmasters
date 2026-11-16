import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import {
  ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { assertPlatformWide, brandScope, brandWhere, CurrentStaff, hasPermission, Permissions, Staff, StaffGuard } from '../../common/auth';
import { encryptJson } from '../../common/crypto';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { dateRange, EXPORT_LIMIT, paged, PageQuery, paging, sendExport } from '../../common/util';
import { FinanceService } from './finance.service';
import { LedgerService } from './ledger.service';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';

const CUR = /^[A-Z]{3}$/;

class PaymentQuery extends PageQuery {
  @IsOptional() @IsIn(['INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']) status?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @Matches(CUR) currency?: string;
}
class WebhookQuery extends PageQuery {
  @IsOptional() @IsIn(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'REJECTED']) status?: string;
}
class RefundQuery extends PageQuery {
  @IsOptional() @IsIn(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'SUCCEEDED', 'FAILED']) status?: string;
}
class RefundRequestDto {
  /** Tickets to refund and revoke. Omit both this and amountMinor to refund the whole remaining order. */
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) ticketIds?: string[];
  @IsOptional() @IsInt() @Min(1) amountMinor?: number;
  @IsString() @MinLength(5) @MaxLength(500) reason: string;
  /** Put refunded tickets back on sale (when the event is still open). Default true. */
  @IsOptional() @IsBoolean() returnInventory?: boolean;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}
class CommissionRuleDto {
  @IsString() @MinLength(3) name: string;
  @IsIn(['PLATFORM_COMMISSION', 'BRAND_COMMISSION', 'SERVICE_FEE', 'TAX']) type: 'PLATFORM_COMMISSION' | 'BRAND_COMMISSION' | 'SERVICE_FEE' | 'TAX';
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @IsUUID() organizerId?: string;
  @IsOptional() @IsUUID() eventId?: string;
  /** Basis points: 250 = 2.5%. */
  @IsInt() @Min(0) @Max(10000) percentBps: number;
  /** Fixed amount per ticket in minor units. Requires currency. */
  @IsOptional() @IsInt() @Min(0) fixedMinor?: number;
  @IsOptional() @Matches(CUR) currency?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class UpdateCommissionRuleDto {
  @IsOptional() @IsString() @MinLength(3) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) percentBps?: number;
  @IsOptional() @IsInt() @Min(0) fixedMinor?: number;
  @IsOptional() @Matches(CUR) currency?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class OrganizerDto {
  @IsString() @MinLength(2) name: string;
  @IsEmail() contactEmail: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() registrationNumber?: string;
  @IsOptional() @IsString() taxNumber?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() agreementNotes?: string;
  @IsOptional() @Matches(CUR) settlementCurrency?: string;
  @IsOptional() @IsInt() @Min(0) @Max(90) payoutHoldDays?: number;
  /** Bank or mobile money details. Stored encrypted; never returned by the API. */
  @IsOptional() @IsString() @MaxLength(1000) settlementDetails?: string;
}
class UpdateOrganizerDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() registrationNumber?: string;
  @IsOptional() @IsString() taxNumber?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() agreementNotes?: string;
  @IsOptional() @Matches(CUR) settlementCurrency?: string;
  @IsOptional() @IsInt() @Min(0) @Max(90) payoutHoldDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) settlementDetails?: string;
  @IsOptional() @IsIn(['PENDING', 'VERIFIED', 'REJECTED']) verificationStatus?: string;
}
class PayoutDto {
  @IsUUID() organizerId: string;
  @Matches(CUR) currency: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class PaidDto {
  /** Bank or mobile money transaction reference of the transfer made to the organizer. */
  @IsString() @MinLength(3) @MaxLength(120) paymentReference: string;
}
class SettlementDto {
  @IsUUID() providerAccountId: string;
  @IsString() @MinLength(1) @MaxLength(120) providerSettlementId: string;
  @Matches(CUR) currency: string;
  @IsInt() @Min(0) grossMinor: number;
  @IsInt() @Min(0) feesMinor: number;
  @IsInt() @Min(0) netMinor: number;
  @IsISO8601() settledAt: string;
  @IsArray() @ArrayUnique() @IsString({ each: true }) paymentReferences: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ReconcileDto {
  @IsISO8601() from: string;
  @IsISO8601() to: string;
  @IsOptional() @IsUUID() brandId?: string;
  /** Also confirm a sample of payments directly with the payment providers. */
  @IsOptional() @IsBoolean() verifyWithGateway?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(200) gatewaySample?: number;
}

const organizerView = {
  id: true, name: true, legalName: true, registrationNumber: true, taxNumber: true, contactEmail: true, contactPhone: true, country: true,
  verificationStatus: true, agreementNotes: true, settlementCurrency: true, payoutHoldDays: true, createdAt: true, updatedAt: true,
} as const;

@ApiTags('Admin · Payments & Finance')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class FinanceController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private payments: PaymentService,
    private refunds: RefundService,
    private finance: FinanceService,
    private ledger: LedgerService,
  ) {}

  private actor(staff: Staff) {
    return { id: staff.userId, label: staff.email };
  }

  // ───────────────────────── Payments ─────────────────────────

  /** Payment transactions from every storefront in scope. `format=csv|xlsx` exports the filtered list. */
  @Get('payments')
  @Permissions('payments.read')
  async listPayments(@CurrentStaff() staff: Staff, @Query() q: PaymentQuery, @Res({ passthrough: true }) res: Response) {
    const term = q.q?.trim();
    const where: Prisma.PaymentWhereInput = {
      ...brandWhere(staff, q.brandId),
      ...(staff.eventScoped ? { order: { eventId: { in: staff.eventIds } } } : {}),
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.provider ? { providerCode: q.provider } : {}),
      ...(q.currency ? { currency: q.currency } : {}),
      ...(dateRange(q) ? { createdAt: dateRange(q) } : {}),
      ...(term ? { OR: [{ reference: { contains: term.toUpperCase() } }, { providerTransactionId: { contains: term } }, { order: { reference: { contains: term.toUpperCase() } } }, { order: { customerEmail: { contains: term.toLowerCase() } } }] } : {}),
    };
    const include = { order: { select: { id: true, reference: true, customerName: true, customerEmail: true, brand: { select: { id: true, name: true, primaryColor: true } } } } } satisfies Prisma.PaymentInclude;
    if (q.format) {
      if (!hasPermission(staff, 'reports.export')) throw forbidden('Missing permission: reports.export');
      const rows = await this.prisma.payment.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: EXPORT_LIMIT });
      await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: q.brandId, action: 'payments.export', metadata: { rows: rows.length } });
      await sendExport(res, q.format, 'payments', [
        { header: 'Payment reference', value: (p) => p.reference },
        { header: 'Gateway', value: (p) => p.providerCode },
        { header: 'Gateway transaction ID', value: (p) => p.providerTransactionId },
        { header: 'Brand', value: (p) => p.order.brand.name },
        { header: 'Order reference', value: (p) => p.order.reference },
        { header: 'Customer', value: (p) => p.order.customerName },
        { header: 'Email', value: (p) => p.order.customerEmail },
        { header: 'Currency', value: (p) => p.currency },
        { header: 'Amount', value: (p) => Number(p.amountMinor) / 100 },
        { header: 'Gateway fee', value: (p) => (p.gatewayFeeMinor === null ? '' : Number(p.gatewayFeeMinor) / 100) },
        { header: 'Net settlement', value: (p) => (p.netSettlementMinor === null ? '' : Number(p.netSettlementMinor) / 100) },
        { header: 'Status', value: (p) => p.status },
        { header: 'Live mode', value: (p) => (p.livemode ? 'yes' : 'no (test)') },
        { header: 'Created', value: (p) => p.createdAt },
        { header: 'Paid at', value: (p) => p.paidAt },
      ], rows);
      return;
    }
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.payment.count({ where }),
    ]);
    return paged(rows.map(({ verification: _v, checkoutUrl: _c, ...p }) => p), total, q);
  }

  /** Payment dashboard figures. Amounts are per currency and never added across currencies. */
  @Get('payments/summary')
  @Permissions('payments.read')
  async paymentSummary(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const scope = { ...brandWhere(staff, q.brandId), ...(dateRange(q) ? { createdAt: dateRange(q) } : {}) };
    const [byStatus, byCurrency, byProvider, refunds, pendingRefunds] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['status'], where: scope, _count: true }),
      this.prisma.payment.groupBy({ by: ['currency'], where: { ...scope, status: 'SUCCEEDED' }, _count: true, _sum: { amountMinor: true, gatewayFeeMinor: true, netSettlementMinor: true } }),
      this.prisma.payment.groupBy({ by: ['providerCode', 'status'], where: scope, _count: true }),
      this.prisma.refund.groupBy({ by: ['currency'], where: { ...brandWhere(staff, q.brandId), status: 'SUCCEEDED', ...(dateRange(q) ? { processedAt: dateRange(q) } : {}) }, _count: true, _sum: { amountMinor: true } }),
      this.prisma.refund.count({ where: { ...brandWhere(staff, q.brandId), status: 'REQUESTED' } }),
    ]);
    const count = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
    const succeeded = count('SUCCEEDED');
    const failed = count('FAILED');
    return {
      total: byStatus.reduce((s, b) => s + b._count, 0),
      succeeded, failed, pending: count('PENDING') + count('INITIATED'), cancelled: count('CANCELLED'),
      successRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
      byCurrency: byCurrency.map((c) => ({ currency: c.currency, payments: c._count, grossMinor: c._sum.amountMinor ?? 0n, gatewayFeesMinor: c._sum.gatewayFeeMinor ?? 0n, netSettlementMinor: c._sum.netSettlementMinor ?? 0n })),
      byProvider: byProvider.map((p) => ({ provider: p.providerCode, status: p.status, count: p._count })),
      refunds: refunds.map((r) => ({ currency: r.currency, refunds: r._count, refundedMinor: r._sum.amountMinor ?? 0n })),
      pendingRefundRequests: pendingRefunds,
    };
  }

  /** Gateway webhook deliveries, including rejected (bad signature) and failed ones. */
  @Get('webhook-events')
  @Permissions('payments.read')
  async webhookEvents(@CurrentStaff() staff: Staff, @Query() q: WebhookQuery) {
    assertPlatformWide(staff); // webhook events are per merchant account, which can serve several brands
    const where: Prisma.PaymentWebhookEventWhereInput = {
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q.toUpperCase() } }, { eventKey: { contains: q.q } }] } : {}),
      ...(dateRange(q) ? { receivedAt: dateRange(q) } : {}),
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, skip, take, select: { id: true, providerCode: true, eventType: true, reference: true, signatureValid: true, status: true, attempts: true, error: true, receivedAt: true, processedAt: true } }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Re-runs processing of a stored, signature-verified webhook event. Safe to repeat. */
  @Post('webhook-events/:id/reprocess')
  @HttpCode(200)
  @Permissions('payments.reconcile')
  async reprocessWebhook(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    assertPlatformWide(staff);
    const ev = await this.prisma.paymentWebhookEvent.findUnique({ where: { id } });
    if (!ev) throw notFound('Webhook event');
    if (!ev.signatureValid) throw new AppError('WEBHOOK_REJECTED', 'An event that failed signature verification can never be processed', 409);
    await this.prisma.paymentWebhookEvent.updateMany({ where: { id, status: { in: ['FAILED', 'IGNORED', 'PROCESSED'] } }, data: { status: 'RECEIVED' } });
    await this.payments.processWebhookEvent(id);
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'webhook.reprocess', entityType: 'payment_webhook_event', entityId: id });
    return this.prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, error: true, attempts: true, processedAt: true } });
  }

  // ───────────────────────── Refunds ─────────────────────────

  @Get('refunds')
  @Permissions('refunds.read')
  async listRefunds(@CurrentStaff() staff: Staff, @Query() q: RefundQuery) {
    const where: Prisma.RefundWhereInput = {
      ...brandWhere(staff, q.brandId),
      ...(staff.eventScoped ? { order: { eventId: { in: staff.eventIds } } } : {}),
      ...(q.status ? { status: q.status as any } : {}),
      ...(dateRange(q) ? { requestedAt: dateRange(q) } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q.toUpperCase() } }, { order: { reference: { contains: q.q.toUpperCase() } } }, { order: { customerEmail: { contains: q.q.toLowerCase() } } }] } : {}),
    };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.refund.findMany({
        where, orderBy: { requestedAt: 'desc' }, skip, take,
        include: { order: { select: { id: true, reference: true, customerName: true, customerEmail: true, totalMinor: true, refundedMinor: true, brand: { select: { id: true, name: true, primaryColor: true } } } }, payment: { select: { providerCode: true, reference: true } } },
      }),
      this.prisma.refund.count({ where }),
    ]);
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.approvedById]).filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds.filter((u) => /^[0-9a-f-]{36}$/i.test(u)) } }, select: { id: true, fullName: true } });
    const name = (id: string | null) => users.find((u) => u.id === id)?.fullName ?? null;
    return paged(rows.map((r) => ({ ...r, requestedByName: r.requestedByType === 'SYSTEM' ? 'System' : name(r.requestedById), decidedByName: name(r.approvedById), canApprove: r.status === 'REQUESTED' && (r.requestedById !== staff.userId || hasPermission(staff, 'refunds.self_approve')) })), total, q);
  }

  /** Creates a refund request for approval. Send `Idempotency-Key` so a retried click cannot create two requests. */
  @Post('orders/:orderId/refunds')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @Permissions('refunds.request')
  async requestRefund(@CurrentStaff() staff: Staff, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: RefundRequestDto, @Headers('idempotency-key') idem?: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, ...brandWhere(staff), ...(staff.eventScoped ? { eventId: { in: staff.eventIds } } : {}) } });
    if (!order) throw notFound('Order');
    return this.refunds.request(
      {
        orderId, ticketIds: dto.ticketIds, amountMinor: dto.amountMinor === undefined ? undefined : BigInt(dto.amountMinor), reason: dto.reason,
        returnInventory: dto.returnInventory, idempotencyKey: `staff:${staff.userId}:${idem ?? randomUUID()}`,
      },
      { type: 'USER', id: staff.userId, label: staff.email },
    );
  }

  private async loadRefund(staff: Staff, id: string) {
    const refund = await this.prisma.refund.findFirst({ where: { id, ...brandWhere(staff) } });
    if (!refund) throw notFound('Refund');
    return refund;
  }

  /** Approves a refund and sends it to the original payment provider. Requires a second person unless self-approval is granted. */
  @Post('refunds/:id/approve')
  @HttpCode(200)
  @Permissions('refunds.approve')
  async approveRefund(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    await this.loadRefund(staff, id);
    return this.refunds.approve(id, { id: staff.userId, label: staff.email, canSelfApprove: hasPermission(staff, 'refunds.self_approve') });
  }

  @Post('refunds/:id/reject')
  @HttpCode(200)
  @Permissions('refunds.approve')
  async rejectRefund(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    await this.loadRefund(staff, id);
    return this.refunds.reject(id, this.actor(staff), dto.reason);
  }

  @Post('refunds/:id/retry')
  @HttpCode(200)
  @Permissions('refunds.approve')
  async retryRefund(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    await this.loadRefund(staff, id);
    return this.refunds.retry(id, this.actor(staff));
  }

  // ───────────────────────── Commission rules ─────────────────────────

  @Get('commission-rules')
  @Permissions('commissions.read')
  async commissionRules(@CurrentStaff() staff: Staff) {
    const scope = brandScope(staff);
    const rules = await this.prisma.commissionRule.findMany({
      // Brand staff see the platform defaults that apply to them plus their own brand's agreements.
      where: scope ? { OR: [{ brandId: null }, { brandId: { in: scope } }] } : {},
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });
    const [brands, organizers, events] = await Promise.all([
      this.prisma.brand.findMany({ where: { id: { in: rules.map((r) => r.brandId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.organizer.findMany({ where: { id: { in: rules.map((r) => r.organizerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.event.findMany({ where: { id: { in: rules.map((r) => r.eventId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    return rules.map((r) => ({
      ...r, brand: brands.find((b) => b.id === r.brandId) ?? null, organizer: organizers.find((o) => o.id === r.organizerId) ?? null, event: events.find((e) => e.id === r.eventId) ?? null,
      scope: r.eventId ? 'EVENT' : r.organizerId ? 'ORGANIZER' : r.brandId ? 'BRAND' : 'PLATFORM',
    }));
  }

  @Post('commission-rules')
  @Permissions('commissions.manage')
  async createCommissionRule(@CurrentStaff() staff: Staff, @Body() dto: CommissionRuleDto) {
    assertPlatformWide(staff);
    if ((dto.fixedMinor ?? 0) > 0 && !dto.currency) throw new AppError('CURRENCY_REQUIRED', 'A fixed amount needs a currency', 400);
    const rule = await this.prisma.commissionRule.create({ data: { ...dto, fixedMinor: BigInt(dto.fixedMinor ?? 0), createdBy: staff.userId } });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: dto.brandId, action: 'commission_rule.create', entityType: 'commission_rule', entityId: rule.id, after: dto });
    return rule;
  }

  @Patch('commission-rules/:id')
  @Permissions('commissions.manage')
  async updateCommissionRule(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCommissionRuleDto) {
    assertPlatformWide(staff);
    const before = await this.prisma.commissionRule.findUnique({ where: { id } });
    if (!before) throw notFound('Commission rule');
    const rule = await this.prisma.commissionRule.update({ where: { id }, data: { ...dto, fixedMinor: dto.fixedMinor === undefined ? undefined : BigInt(dto.fixedMinor) } });
    // Existing orders keep the allocation snapshotted at checkout; only new orders use the new terms.
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: before.brandId, action: 'commission_rule.update', entityType: 'commission_rule', entityId: id, before, after: dto });
    return rule;
  }

  // ───────────────────────── Sellers & promoters ─────────────────────────

  @Get('organizers')
  @Permissions('organizers.read')
  async organizers(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const scope = brandScope(staff, q.brandId);
    const where: Prisma.OrganizerWhereInput = {
      // Brand staff only see organizers with events on their storefronts.
      ...(scope ? { events: { some: { OR: [{ ownerBrandId: { in: scope } }, { publications: { some: { brandId: { in: scope } } } }] } } } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { contactEmail: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.organizer.findMany({ where, select: { ...organizerView, _count: { select: { events: true, payouts: true } } }, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.organizer.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Organizer profile with events, commercial terms, balances by currency and payout history. */
  @Get('organizers/:id')
  @Permissions('organizers.read')
  async organizer(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const scope = brandScope(staff);
    const org = await this.prisma.organizer.findFirst({
      where: { id, ...(scope ? { events: { some: { OR: [{ ownerBrandId: { in: scope } }, { publications: { some: { brandId: { in: scope } } } }] } } } : {}) },
      select: { ...organizerView, settlementDetailsEnc: true },
    });
    if (!org) throw notFound('Organizer');
    const { settlementDetailsEnc, ...profile } = org;
    const events = await this.prisma.event.findMany({
      where: { organizerId: id, ...(scope ? { OR: [{ ownerBrandId: { in: scope } }, { publications: { some: { brandId: { in: scope } } } }] } : {}) },
      select: { id: true, name: true, startsAt: true, status: true }, orderBy: { startsAt: 'desc' }, take: 50,
    });
    // Balances, agreements and payouts are platform finance data.
    const finance = staff.allBrands && hasPermission(staff, 'settlements.read')
      ? {
          balances: await this.finance.payableSummary(id),
          payouts: await this.prisma.payout.findMany({ where: { organizerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
          commissionRules: await this.prisma.commissionRule.findMany({ where: { organizerId: id } }),
        }
      : null;
    return { ...profile, hasSettlementDetails: !!settlementDetailsEnc, events, finance };
  }

  @Post('organizers')
  @Permissions('organizers.manage')
  async createOrganizer(@CurrentStaff() staff: Staff, @Body() dto: OrganizerDto) {
    assertPlatformWide(staff);
    const { settlementDetails, ...rest } = dto;
    const org = await this.prisma.organizer.create({ data: { ...rest, settlementDetailsEnc: settlementDetails ? encryptJson({ details: settlementDetails }) : null }, select: organizerView });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'organizer.create', entityType: 'organizer', entityId: org.id, after: rest });
    return org;
  }

  @Patch('organizers/:id')
  @Permissions('organizers.manage')
  async updateOrganizer(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrganizerDto) {
    assertPlatformWide(staff);
    const before = await this.prisma.organizer.findUnique({ where: { id }, select: organizerView });
    if (!before) throw notFound('Organizer');
    const { settlementDetails, ...rest } = dto;
    const org = await this.prisma.organizer.update({
      where: { id }, data: { ...rest, settlementDetailsEnc: settlementDetails === undefined ? undefined : encryptJson({ details: settlementDetails }) }, select: organizerView,
    });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'organizer.update', entityType: 'organizer', entityId: id, before, after: { ...rest, settlementDetailsChanged: settlementDetails !== undefined } });
    return org;
  }

  // ───────────────────────── Settlements & payouts (platform finance) ─────────────────────────

  /** Amounts owed to each organizer by currency and status, from the payable ledger. */
  @Get('settlements/payables')
  @Permissions('settlements.read')
  payables(@CurrentStaff() staff: Staff, @Query('organizerId') organizerId?: string) {
    assertPlatformWide(staff);
    return this.finance.payableSummary(organizerId);
  }

  @Get('payouts')
  @Permissions('settlements.read')
  async payouts(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    assertPlatformWide(staff);
    const { skip, take } = paging(q);
    const where: Prisma.PayoutWhereInput = q.q ? { OR: [{ reference: { contains: q.q.toUpperCase() } }, { organizer: { name: { contains: q.q, mode: 'insensitive' } } }] } : {};
    const [rows, total] = await Promise.all([
      this.prisma.payout.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { organizer: { select: { id: true, name: true } }, _count: { select: { payables: true } } } }),
      this.prisma.payout.count({ where }),
    ]);
    return paged(rows.map((p) => ({ ...p, canApprove: p.status === 'PENDING_APPROVAL' && p.createdById !== staff.userId && hasPermission(staff, 'payouts.approve') })), total, q);
  }

  /** Settlement statement for a payout. */
  @Get('payouts/:id')
  @Permissions('settlements.read')
  payout(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    assertPlatformWide(staff);
    return this.finance.payoutReport(id);
  }

  @Post('payouts')
  @Permissions('settlements.manage')
  createPayout(@CurrentStaff() staff: Staff, @Body() dto: PayoutDto) {
    assertPlatformWide(staff);
    return this.finance.createPayout(dto.organizerId, dto.currency, this.actor(staff), dto.note);
  }

  @Post('payouts/:id/approve')
  @HttpCode(200)
  @Permissions('payouts.approve')
  approvePayout(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    assertPlatformWide(staff);
    return this.finance.approvePayout(id, this.actor(staff));
  }

  @Post('payouts/:id/reject')
  @HttpCode(200)
  @Permissions('payouts.approve')
  rejectPayout(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    assertPlatformWide(staff);
    return this.finance.rejectPayout(id, this.actor(staff), dto.reason);
  }

  /** Records that the organizer was paid outside the platform. The platform never moves funds by itself. */
  @Post('payouts/:id/mark-paid')
  @HttpCode(200)
  @Permissions('settlements.manage')
  markPaid(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaidDto) {
    assertPlatformWide(staff);
    return this.finance.markPayoutPaid(id, this.actor(staff), dto.paymentReference);
  }

  // ───────────────────────── Gateway settlements & reconciliation ─────────────────────────

  @Get('gateway-settlements')
  @Permissions('payments.reconcile')
  async gatewaySettlements(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    assertPlatformWide(staff);
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.gatewaySettlement.findMany({ orderBy: { settledAt: 'desc' }, skip, take, include: { providerAccount: { select: { label: true, providerCode: true } }, _count: { select: { payments: true } } } }),
      this.prisma.gatewaySettlement.count(),
    ]);
    return paged(items, total, q);
  }

  /** Records a gateway payout to the bank and matches it against the payments it covers. */
  @Post('gateway-settlements')
  @Permissions('payments.reconcile')
  recordSettlement(@CurrentStaff() staff: Staff, @Body() dto: SettlementDto) {
    assertPlatformWide(staff);
    return this.finance.recordSettlement(
      { ...dto, grossMinor: BigInt(dto.grossMinor), feesMinor: BigInt(dto.feesMinor), netMinor: BigInt(dto.netMinor), settledAt: new Date(dto.settledAt) },
      this.actor(staff),
    );
  }

  /** Runs reconciliation across orders, payments, refunds, ledger, gateway records, settlements and payables. */
  @Post('reconciliation/run')
  @HttpCode(200)
  @Permissions('payments.reconcile')
  reconcile(@CurrentStaff() staff: Staff, @Body() dto: ReconcileDto) {
    return this.finance.reconcile(
      { from: new Date(dto.from), to: new Date(dto.to), brandIds: brandScope(staff, dto.brandId), verifyWithGateway: dto.verifyWithGateway, gatewaySample: dto.gatewaySample },
      this.actor(staff),
    );
  }

  @Get('reconciliation/runs')
  @Permissions('payments.reconcile')
  async reconciliationRuns(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const scope = brandScope(staff, q.brandId);
    const where = scope ? { brandId: { in: scope } } : {};
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.reconciliationRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.reconciliationRun.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Ledger account balances per currency (derived from immutable entries). */
  @Get('ledger/balances')
  @Permissions('reports.financial')
  balances(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    return this.ledger.balances({ brandIds: brandScope(staff, q.brandId), from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
  }
}
