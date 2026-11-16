import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { assertBrandAccess, brandWhere, CurrentStaff, Permissions, Staff, StaffGuard } from '../../common/auth';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { paged, PageQuery, paging } from '../../common/util';
import { PAID_STATES } from '../orders/order.service';
import { CampaignService } from './campaign.service';

const CUR = /^[A-Z]{3}$/;

class CampaignDto {
  @IsUUID() brandId: string;
  @IsString() @MinLength(2) @MaxLength(160) name: string;
  @IsIn(['EMAIL', 'SMS', 'WHATSAPP']) channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  /** Message body. Use {{name}} for the customer's first name. Links are tracked automatically. */
  @IsString() @MinLength(1) @MaxLength(200_000) bodyHtml: string;
  /** Audience segments. Every segment must belong to the campaign's brand. */
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsUUID('all', { each: true }) segmentIds: string[];
}
class UpdateCampaignDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200_000) bodyHtml?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsUUID('all', { each: true }) segmentIds?: string[];
}
class ScheduleDto {
  @IsISO8601() scheduledAt: string;
}
class TestDto {
  /** Email address (or phone number for SMS/WhatsApp) that receives the test copy. */
  @IsString() @MinLength(5) @MaxLength(200) to: string;
}
class CampaignQuery extends PageQuery {
  @IsOptional() @IsIn(['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED']) status?: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED';
}
class PromoDto {
  @IsUUID() brandId: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{3,40}$/) code: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsIn(['PERCENT', 'FIXED']) discountType: 'PERCENT' | 'FIXED';
  /** Required for PERCENT. 1000 = 10%. */
  @IsOptional() @IsInt() @Min(1) @Max(10000) percentBps?: number;
  /** Required for FIXED, in minor units. */
  @IsOptional() @IsInt() @Min(1) amountMinor?: number;
  @IsOptional() @Matches(CUR) currency?: string;
  @IsOptional() @IsUUID() eventId?: string;
  @IsOptional() @IsUUID() campaignId?: string;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(0) minOrderMinor?: number;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
}
class UpdatePromoDto {
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10000) percentBps?: number;
  @IsOptional() @IsInt() @Min(1) amountMinor?: number;
  @IsOptional() @IsUUID() eventId?: string | null;
  @IsOptional() @IsUUID() campaignId?: string | null;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number | null;
  @IsOptional() @IsInt() @Min(0) minOrderMinor?: number | null;
  @IsOptional() @IsISO8601() startsAt?: string | null;
  @IsOptional() @IsISO8601() endsAt?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

const d = (v?: string | null) => (v === undefined ? undefined : v === null ? null : new Date(v));
const big = (v?: number | null) => (v === undefined ? undefined : v === null ? null : BigInt(v));

@ApiTags('Admin · Marketing')
@ApiBearerAuth()
@Controller('v1/admin/marketing')
@UseGuards(StaffGuard)
export class MarketingController {
  constructor(private prisma: PrismaService, private audit: AuditService, private campaigns: CampaignService) {}

  private log(staff: Staff, action: string, brandId: string, entityType: string, entityId: string, before?: unknown, after?: unknown) {
    return this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId, action, entityType, entityId, before, after });
  }

  /**
   * The cross-brand barrier: a campaign's audience may only be built from segments of the
   * campaign's own brand, and the caller must be allowed to act for that brand.
   */
  private async assertSegments(staff: Staff, brandId: string, segmentIds: string[]) {
    assertBrandAccess(staff, brandId);
    const segments = await this.prisma.customerSegment.findMany({ where: { id: { in: segmentIds } }, select: { id: true, brandId: true } });
    if (segments.length !== segmentIds.length) throw new AppError('SEGMENT_NOT_FOUND', 'One or more segments do not exist', 400);
    if (segments.some((s) => s.brandId !== brandId)) {
      throw new AppError('CROSS_BRAND_AUDIENCE', 'A campaign can only target segments of its own brand', 403);
    }
  }

  private async load(staff: Staff, id: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id }, include: { audiences: true } });
    if (!c || !(staff.allBrands || staff.brandIds.includes(c.brandId))) throw notFound('Campaign');
    return c;
  }

  // ── Campaigns ──

  @Get('campaigns')
  @Permissions('marketing.read')
  async list(@CurrentStaff() staff: Staff, @Query() q: CampaignQuery) {
    const where = {
      ...brandWhere(staff, q.brandId),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { audiences: true } }),
      this.prisma.campaign.count({ where }),
    ]);
    const stats = await this.campaigns.performance(rows.map((r) => r.id));
    const brands = await this.prisma.brand.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.brandId))] } }, select: { id: true, name: true } });
    return paged(
      rows.map(({ audiences, bodyHtml: _body, ...c }) => ({
        ...c, brandName: brands.find((b) => b.id === c.brandId)?.name, segmentIds: audiences.map((a) => a.segmentId), stats: stats.get(c.id),
      })),
      total, q,
    );
  }

  /** Campaigns of one brand side by side with delivery, engagement and revenue metrics. */
  @Get('campaigns/compare')
  @Permissions('marketing.read')
  async compare(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const rows = await this.prisma.campaign.findMany({
      where: { ...brandWhere(staff, q.brandId), status: 'SENT', ...(q.from || q.to ? { sentAt: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } } : {}) },
      orderBy: { sentAt: 'desc' }, take: 50, select: { id: true, name: true, brandId: true, channel: true, sentAt: true },
    });
    const stats = await this.campaigns.performance(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, ...stats.get(r.id) }));
  }

  @Get('campaigns/:id')
  @Permissions('marketing.read')
  async get(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const { audiences, ...c } = await this.load(staff, id);
    const segments = await this.prisma.customerSegment.findMany({
      where: { id: { in: audiences.map((a) => a.segmentId) } }, select: { id: true, name: true, lastCount: true, lastEvaluatedAt: true },
    });
    return { ...c, segments, stats: (await this.campaigns.performance([id])).get(id) };
  }

  @Post('campaigns')
  @Permissions('marketing.manage')
  async create(@CurrentStaff() staff: Staff, @Body() dto: CampaignDto) {
    await this.assertSegments(staff, dto.brandId, dto.segmentIds);
    if (dto.channel === 'EMAIL' && !dto.subject?.trim()) throw new AppError('SUBJECT_REQUIRED', 'Email campaigns need a subject line', 400);
    const { segmentIds, ...rest } = dto;
    const c = await this.prisma.campaign.create({
      data: { ...rest, createdBy: staff.userId, audiences: { create: segmentIds.map((segmentId) => ({ segmentId })) } },
    });
    await this.log(staff, 'campaign.create', c.brandId, 'campaign', c.id, undefined, { name: c.name, channel: c.channel, segmentIds });
    return c;
  }

  @Patch('campaigns/:id')
  @Permissions('marketing.manage')
  async update(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    const before = await this.load(staff, id);
    if (!['DRAFT', 'SCHEDULED'].includes(before.status)) throw new AppError('CAMPAIGN_LOCKED', `A ${before.status.toLowerCase()} campaign cannot be edited`, 409);
    if (dto.segmentIds) await this.assertSegments(staff, before.brandId, dto.segmentIds);
    const { segmentIds, ...rest } = dto;
    const c = await this.prisma.$transaction(async (tx) => {
      if (segmentIds) {
        await tx.campaignAudience.deleteMany({ where: { campaignId: id } });
        await tx.campaignAudience.createMany({ data: segmentIds.map((segmentId) => ({ campaignId: id, segmentId })) });
      }
      const n = await tx.campaign.updateMany({ where: { id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: rest });
      if (n.count !== 1) throw new AppError('CAMPAIGN_LOCKED', 'This campaign has started sending and cannot be edited', 409);
      return tx.campaign.findUniqueOrThrow({ where: { id } });
    });
    await this.log(staff, 'campaign.update', c.brandId, 'campaign', id, { name: before.name, subject: before.subject }, { ...rest, segmentIds });
    return c;
  }

  @Post('campaigns/:id/schedule')
  @HttpCode(200)
  @Permissions('marketing.manage')
  async schedule(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleDto) {
    const c = await this.load(staff, id);
    const when = new Date(dto.scheduledAt);
    if (when <= new Date()) throw new AppError('SCHEDULE_IN_PAST', 'Choose a future date and time', 400);
    await this.assertSegments(staff, c.brandId, c.audiences.map((a) => a.segmentId));
    const n = await this.prisma.campaign.updateMany({ where: { id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'SCHEDULED', scheduledAt: when } });
    if (n.count !== 1) throw new AppError('CAMPAIGN_LOCKED', `A ${c.status.toLowerCase()} campaign cannot be scheduled`, 409);
    await this.log(staff, 'campaign.schedule', c.brandId, 'campaign', id, undefined, { scheduledAt: when });
    return this.prisma.campaign.findUniqueOrThrow({ where: { id } });
  }

  /** Starts sending immediately. Recipients without current consent for this brand and channel are skipped. */
  @Post('campaigns/:id/send-now')
  @HttpCode(200)
  @Permissions('marketing.manage')
  async sendNow(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.load(staff, id);
    if (!['DRAFT', 'SCHEDULED'].includes(c.status)) throw new AppError('CAMPAIGN_LOCKED', `This campaign is already ${c.status.toLowerCase()}`, 409);
    await this.assertSegments(staff, c.brandId, c.audiences.map((a) => a.segmentId));
    await this.prisma.campaign.updateMany({ where: { id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'SCHEDULED', scheduledAt: new Date() } });
    await this.log(staff, 'campaign.send', c.brandId, 'campaign', id);
    await this.campaigns.enqueueDispatch(id);
    return this.prisma.campaign.findUniqueOrThrow({ where: { id } });
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  @Permissions('marketing.manage')
  async cancel(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.load(staff, id);
    const n = await this.prisma.campaign.updateMany({ where: { id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'CANCELLED' } });
    if (n.count !== 1) throw new AppError('CAMPAIGN_LOCKED', `A ${c.status.toLowerCase()} campaign cannot be cancelled`, 409);
    await this.log(staff, 'campaign.cancel', c.brandId, 'campaign', id);
    return this.prisma.campaign.findUniqueOrThrow({ where: { id } });
  }

  /** Sends one copy, marked [TEST], to an address you supply. It is not counted in campaign results. */
  @Post('campaigns/:id/test')
  @HttpCode(200)
  @Permissions('marketing.manage')
  async test(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TestDto) {
    const c = await this.load(staff, id);
    if (c.channel === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dto.to)) throw new AppError('ADDRESS_INVALID', 'Enter a valid email address', 400);
    await this.campaigns.sendTest(c, dto.to.trim(), staff.fullName);
    await this.log(staff, 'campaign.test_send', c.brandId, 'campaign', id, undefined, { to: dto.to });
    return { queued: true, to: dto.to };
  }

  @Get('campaigns/:id/performance')
  @Permissions('marketing.read')
  async performance(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.load(staff, id);
    return { id: c.id, name: c.name, brandId: c.brandId, channel: c.channel, status: c.status, sentAt: c.sentAt, ...(await this.campaigns.performance([id])).get(id) };
  }

  // ── Promo codes ──

  @Get('promo-codes')
  @Permissions('marketing.read')
  async promos(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const where = { ...brandWhere(staff, q.brandId), ...(q.q ? { code: { contains: q.q.toUpperCase() } } : {}) };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.promoCode.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.promoCode.count({ where }),
    ]);
    const usage = await this.prisma.order.groupBy({
      by: ['promoCodeId', 'currency'], where: { promoCodeId: { in: rows.map((r) => r.id) }, status: { in: PAID_STATES } },
      _count: true, _sum: { totalMinor: true, refundedMinor: true, discountMinor: true },
    });
    return paged(
      rows.map((p) => {
        const u = usage.filter((x) => x.promoCodeId === p.id);
        return {
          ...p,
          paidOrders: u.reduce((s, x) => s + x._count, 0),
          revenueByCurrency: u.map((x) => ({
            currency: x.currency, orders: x._count, revenueMinor: (x._sum.totalMinor ?? 0n) - (x._sum.refundedMinor ?? 0n), discountMinor: x._sum.discountMinor ?? 0n,
          })),
        };
      }),
      total, q,
    );
  }

  private async assertPromoLinks(brandId: string, eventId?: string | null, campaignId?: string | null) {
    if (eventId && !(await this.prisma.event.count({ where: { id: eventId, publications: { some: { brandId } } } }))) {
      throw new AppError('EVENT_NOT_ON_BRAND', 'That event is not published on this brand', 400);
    }
    if (campaignId) {
      const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { brandId: true } });
      if (!c || c.brandId !== brandId) throw forbidden('A promo code can only be linked to a campaign of the same brand');
    }
  }

  @Post('promo-codes')
  @Permissions('marketing.manage')
  async createPromo(@CurrentStaff() staff: Staff, @Body() dto: PromoDto) {
    assertBrandAccess(staff, dto.brandId);
    if (dto.discountType === 'PERCENT' && !dto.percentBps) throw new AppError('PROMO_INVALID', 'A percentage discount needs percentBps (1-10000)', 400);
    if (dto.discountType === 'FIXED' && (!dto.amountMinor || !dto.currency)) throw new AppError('PROMO_INVALID', 'A fixed discount needs amountMinor and currency', 400);
    if (dto.startsAt && dto.endsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) throw new AppError('PROMO_INVALID', 'The end date must be after the start date', 400);
    await this.assertPromoLinks(dto.brandId, dto.eventId, dto.campaignId);
    const fixed = dto.discountType === 'FIXED';
    const p = await this.prisma.promoCode.create({
      data: {
        brandId: dto.brandId, code: dto.code.toUpperCase(), description: dto.description, discountType: dto.discountType,
        percentBps: fixed ? null : dto.percentBps, amountMinor: fixed ? BigInt(dto.amountMinor!) : null, currency: fixed ? dto.currency : null,
        eventId: dto.eventId, campaignId: dto.campaignId, maxRedemptions: dto.maxRedemptions, minOrderMinor: big(dto.minOrderMinor),
        startsAt: d(dto.startsAt), endsAt: d(dto.endsAt), createdBy: staff.userId,
      },
    });
    await this.log(staff, 'promo_code.create', p.brandId, 'promo_code', p.id, undefined, p);
    return p;
  }

  @Patch('promo-codes/:id')
  @Permissions('marketing.manage')
  async updatePromo(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromoDto) {
    const before = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!before || !(staff.allBrands || staff.brandIds.includes(before.brandId))) throw notFound('Promo code');
    if (dto.percentBps !== undefined && before.discountType !== 'PERCENT') throw new AppError('PROMO_INVALID', 'This is a fixed-amount code', 400);
    if (dto.amountMinor !== undefined && before.discountType !== 'FIXED') throw new AppError('PROMO_INVALID', 'This is a percentage code', 400);
    if (dto.maxRedemptions != null && dto.maxRedemptions < before.redeemedCount) throw new AppError('PROMO_INVALID', 'Maximum redemptions cannot be below the number already redeemed', 400);
    await this.assertPromoLinks(before.brandId, dto.eventId, dto.campaignId);
    const p = await this.prisma.promoCode.update({
      where: { id },
      data: {
        description: dto.description, percentBps: dto.percentBps, amountMinor: big(dto.amountMinor) ?? undefined, eventId: dto.eventId, campaignId: dto.campaignId,
        maxRedemptions: dto.maxRedemptions, minOrderMinor: big(dto.minOrderMinor), startsAt: d(dto.startsAt), endsAt: d(dto.endsAt), active: dto.active,
      },
    });
    await this.log(staff, 'promo_code.update', p.brandId, 'promo_code', id, before, dto);
    return p;
  }

  /** Deactivates a code. Orders that already used it keep their discount. */
  @Delete('promo-codes/:id')
  @Permissions('marketing.manage')
  async deactivatePromo(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const before = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!before || !(staff.allBrands || staff.brandIds.includes(before.brandId))) throw notFound('Promo code');
    await this.prisma.promoCode.update({ where: { id }, data: { active: false } });
    await this.log(staff, 'promo_code.deactivate', before.brandId, 'promo_code', id, { active: before.active }, { active: false });
    return { ok: true };
  }
}
