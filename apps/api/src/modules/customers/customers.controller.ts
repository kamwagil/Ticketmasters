import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrderStatus, Prisma } from '@prisma/client';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { assertBrandAccess, brandScope, brandWhere, CurrentStaff, hasPermission, Permissions, Staff, StaffGuard } from '../../common/auth';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { EXPORT_LIMIT, ExportColumn, normPhone, paged, PageQuery, paging, sendExport } from '../../common/util';
import { CustomerService } from './customer.service';
import { normalizeRules, SegmentMember, SegmentService } from './segments';

const PAID: OrderStatus[] = ['PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;

class BrandQuery {
  @IsOptional() @IsUUID() brandId?: string;
}
class UpdateCustomerDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsIn(['ACTIVE', 'BLOCKED']) status?: 'ACTIVE' | 'BLOCKED';
}
class NoteDto {
  @IsUUID() brandId: string;
  @IsString() @MinLength(1) @MaxLength(4000) body: string;
}
class TagDto {
  @IsUUID() brandId: string;
  @IsString() @MinLength(1) @MaxLength(40) name: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string;
}
class AssignTagsDto {
  @IsUUID() brandId: string;
  @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) tagIds: string[];
}
class AdminConsentDto {
  @IsUUID() brandId: string;
  @IsIn(CHANNELS) channel: (typeof CHANNELS)[number];
  @IsBoolean() granted: boolean;
  /** Why staff changed consent on the customer's behalf (e.g. "phone request on 12 March"). */
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}
class SegmentDto {
  @IsUUID() brandId: string;
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsObject() rules: Record<string, unknown>;
}
class UpdateSegmentDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
}
class SegmentPreviewDto {
  @IsUUID() brandId: string;
  @IsObject() rules: Record<string, unknown>;
}
class DataRequestQuery extends PageQuery {
  @IsOptional() @IsIn(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED']) status?: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
}
class UpdateDataRequestDto {
  @IsIn(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED']) status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(2000) resolution?: string;
}
class ExportQuery {
  @IsUUID() brandId: string;
}
class AnonymizeDto {
  @IsUUID() brandId: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  /** Platform-wide administrators only: erase the customer across every brand. */
  @IsOptional() @IsBoolean() allBrands?: boolean;
}

const relView = {
  id: true, brandId: true, email: true, emailVerifiedAt: true, status: true, orderCount: true, firstOrderAt: true, lastOrderAt: true, lastLoginAt: true,
  createdAt: true, brand: { select: { id: true, name: true, primaryColor: true } },
} satisfies Prisma.CustomerBrandRelationshipSelect;

@ApiTags('Admin · Customers & CRM')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class CustomersController {
  constructor(private prisma: PrismaService, private audit: AuditService, private customers: CustomerService, private segments: SegmentService) {}

  private log(staff: Staff, action: string, brandId: string | null, entityType: string, entityId: string, before?: unknown, after?: unknown) {
    return this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId, action, entityType, entityId, before, after });
  }

  /** Brand filter fragment for a brandId column (empty = platform staff with no brand selected). */
  private bw(scope: string[] | undefined): { brandId?: { in: string[] } } {
    return scope ? { brandId: { in: scope } } : {};
  }

  /**
   * A customer exists for a staff member only through a relationship with a brand in their
   * scope. Returns those relationships, or answers 404 without revealing the record exists.
   */
  private async visible(staff: Staff, customerId: string, brandId?: string | null) {
    const scope = brandScope(staff, brandId);
    const relationships = await this.prisma.customerBrandRelationship.findMany({ where: { customerId, ...this.bw(scope) }, select: relView, orderBy: { createdAt: 'asc' } });
    if (!relationships.length) throw notFound('Customer');
    return { scope, relationships };
  }

  /** Asserts the brand is accessible AND the customer has a relationship with it. */
  private async inBrand(staff: Staff, customerId: string, brandId: string) {
    assertBrandAccess(staff, brandId);
    const rel = await this.prisma.customerBrandRelationship.findUnique({ where: { brandId_customerId: { brandId, customerId } } });
    if (!rel) throw notFound('Customer');
    return rel;
  }

  // ───────────────────────── Customer database ─────────────────────────

  /** Customers within the caller's brand scope. Totals are computed only from orders in that scope and kept per currency. */
  @Get('customers')
  @Permissions('customers.read')
  async list(@CurrentStaff() staff: Staff, @Query() q: PageQuery, @Res() res: Response) {
    const scope = brandScope(staff, q.brandId);
    const bw = this.bw(scope);
    const text = q.q?.trim();
    const where: Prisma.CustomerWhereInput = {
      mergedIntoId: null,
      relationships: { some: bw },
      ...(text
        ? {
            OR: [
              { fullName: { contains: text, mode: 'insensitive' } },
              { email: { contains: text, mode: 'insensitive' } },
              { phone: { contains: text.replace(/\s+/g, '') } },
              { relationships: { some: { ...bw, email: { contains: text, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const exporting = q.format === 'csv' || q.format === 'xlsx';
    if (exporting && !hasPermission(staff, 'reports.export')) throw forbidden('Missing permission: reports.export');
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: exporting ? 0 : skip, take: exporting ? EXPORT_LIMIT : take,
        select: {
          id: true, fullName: true, email: true, phone: true, country: true, city: true, status: true, createdAt: true,
          relationships: { where: bw, select: { brandId: true, email: true, status: true, emailVerifiedAt: true, brand: { select: { name: true, primaryColor: true } } } },
        },
      }),
      exporting ? Promise.resolve(0) : this.prisma.customer.count({ where }),
    ]);
    const stats = await this.prisma.order.groupBy({
      by: ['customerId', 'currency'],
      where: { ...bw, status: { in: PAID }, ...(exporting ? { customer: where } : { customerId: { in: rows.map((r) => r.id) } }) },
      _count: true, _sum: { totalMinor: true, refundedMinor: true }, _max: { paidAt: true },
    });
    const byCustomer = new Map<string, typeof stats>();
    for (const s of stats) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
    const items = rows.map((c) => {
      const s = byCustomer.get(c.id) ?? [];
      const last = s.map((x) => x._max.paidAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        ...c,
        // The contact address shown is the one the customer uses with a brand the caller can see.
        email: c.relationships[0]?.email ?? c.email,
        orderCount: s.reduce((n, x) => n + x._count, 0),
        spend: s.map((x) => ({ currency: x.currency, grossMinor: x._sum.totalMinor ?? 0n, refundedMinor: x._sum.refundedMinor ?? 0n, netMinor: (x._sum.totalMinor ?? 0n) - (x._sum.refundedMinor ?? 0n) })),
        lastOrderAt: last,
      };
    });
    if (exporting) {
      type Row = (typeof items)[number];
      const columns: ExportColumn<Row>[] = [
        { header: 'Customer ID', value: (r) => r.id }, { header: 'Name', value: (r) => r.fullName }, { header: 'Email', value: (r) => r.email },
        { header: 'Phone', value: (r) => r.phone }, { header: 'Country', value: (r) => r.country }, { header: 'City', value: (r) => r.city },
        { header: 'Status', value: (r) => r.status }, { header: 'Brands', value: (r) => r.relationships.map((x) => x.brand.name).join('; ') },
        { header: 'Paid orders', value: (r) => r.orderCount },
        { header: 'Net spend (minor units, per currency)', value: (r) => r.spend.map((x) => `${x.currency} ${x.netMinor}`).join('; ') },
        { header: 'Last order', value: (r) => r.lastOrderAt }, { header: 'Registered', value: (r) => r.createdAt },
      ];
      await this.log(staff, 'customers.export', q.brandId ?? null, 'customer', 'list', undefined, { rows: items.length, format: q.format, q: q.q });
      await sendExport(res, q.format as string, 'customers', columns, items);
      return;
    }
    res.json(paged(items, total, q));
  }

  /** Customer 360 profile, restricted to the caller's brand scope. */
  @Get('customers/:id')
  @Permissions('customers.read')
  async profile(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Query() q: BrandQuery) {
    const { scope, relationships } = await this.visible(staff, id, q.brandId);
    const bw = this.bw(scope);
    const now = new Date();
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id },
      select: { id: true, fullName: true, email: true, phone: true, country: true, city: true, preferredCurrency: true, status: true, anonymizedAt: true, createdAt: true, updatedAt: true },
    });
    const [totals, orders, tickets, refunds, supportTickets, consents, communications, notes, tags, preferences, dataRequests, identities] = await Promise.all([
      this.prisma.order.groupBy({ by: ['currency'], where: { customerId: id, ...bw, status: { in: PAID } }, _count: true, _sum: { totalMinor: true, refundedMinor: true } }),
      this.prisma.order.findMany({
        where: { customerId: id, ...bw }, orderBy: { createdAt: 'desc' }, take: 25,
        select: {
          id: true, reference: true, brandId: true, status: true, paymentStatus: true, currency: true, totalMinor: true, refundedMinor: true, createdAt: true, paidAt: true,
          sourceDomain: true, event: { select: { id: true, name: true, startsAt: true } }, items: { select: { categoryName: true, quantity: true } },
        },
      }),
      this.prisma.ticket.findMany({
        where: { customerId: id, ...bw }, orderBy: { issuedAt: 'desc' }, take: 200,
        select: {
          id: true, reference: true, brandId: true, status: true, issuedAt: true, usedAt: true, holderName: true,
          ticketCategory: { select: { name: true } }, order: { select: { reference: true } },
          event: { select: { id: true, name: true, startsAt: true, timezone: true, status: true, venue: { select: { name: true, city: true } }, category: { select: { name: true } } } },
        },
      }),
      this.prisma.refund.findMany({
        where: { ...bw, order: { customerId: id } }, orderBy: { requestedAt: 'desc' }, take: 50,
        select: { id: true, reference: true, brandId: true, amountMinor: true, currency: true, status: true, reason: true, requestedAt: true, processedAt: true, order: { select: { reference: true } } },
      }),
      this.prisma.supportTicket.findMany({
        where: { customerId: id, ...bw }, orderBy: { updatedAt: 'desc' }, take: 50,
        select: { id: true, reference: true, brandId: true, subject: true, issueType: true, priority: true, status: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
      }),
      this.customers.consentState(id, scope),
      this.prisma.notificationLog.findMany({
        where: { customerId: id, ...bw }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, brandId: true, channel: true, type: true, toAddress: true, subject: true, event: true, detail: true, createdAt: true },
      }),
      this.prisma.customerNote.findMany({ where: { customerId: id, ...bw }, orderBy: { createdAt: 'desc' } }),
      this.prisma.customerTagAssignment.findMany({ where: { customerId: id, tag: bw }, select: { tag: true } }),
      this.prisma.customerPreference.findMany({ where: { customerId: id, ...bw } }),
      this.prisma.dataSubjectRequest.findMany({ where: { customerId: id, ...bw }, orderBy: { createdAt: 'desc' } }),
      this.prisma.customerIdentity.findMany({ where: { customerId: id }, select: { type: true, value: true, verifiedAt: true, verifiedViaBrandId: true } }),
    ]);

    // Upcoming and past events are derived from the tickets the caller is allowed to see.
    const events = new Map<string, { id: string; name: string; startsAt: Date; venue: string | null; category: string | null; tickets: number; attended: number }>();
    for (const t of tickets) {
      if (!['VALID', 'USED'].includes(t.status)) continue;
      const e = events.get(t.event.id) ?? {
        id: t.event.id, name: t.event.name, startsAt: t.event.startsAt, venue: t.event.venue ? `${t.event.venue.name}, ${t.event.venue.city}` : null,
        category: t.event.category?.name ?? null, tickets: 0, attended: 0,
      };
      e.tickets++;
      if (t.status === 'USED') e.attended++;
      events.set(t.event.id, e);
    }
    const all = [...events.values()];
    return {
      customer,
      // Verified identities are shown to platform staff only: they reveal which other brand verified the address.
      identities: staff.allBrands ? identities : identities.map((i) => ({ type: i.type, value: i.value, verified: !!i.verifiedAt })),
      relationships,
      totals: {
        orders: totals.reduce((n, t) => n + t._count, 0),
        // One line per currency. Amounts in different currencies are never added together.
        spendByCurrency: totals.map((t) => ({ currency: t.currency, orders: t._count, grossMinor: t._sum.totalMinor ?? 0n, refundedMinor: t._sum.refundedMinor ?? 0n, netMinor: (t._sum.totalMinor ?? 0n) - (t._sum.refundedMinor ?? 0n) })),
        ticketsIssued: tickets.length,
        eventsAttended: all.filter((e) => e.attended > 0).length,
      },
      recentOrders: orders,
      upcomingEvents: all.filter((e) => e.startsAt > now).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
      pastEvents: all.filter((e) => e.startsAt <= now).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()),
      tickets,
      refunds,
      supportTickets,
      consents: consents.map((c) => ({ brandId: c.brandId, channel: c.channel, status: c.status, source: c.source, lawfulBasis: c.lawfulBasis, since: c.createdAt })),
      communications,
      notes,
      tags: tags.map((t) => t.tag),
      preferences,
      dataRequests,
    };
  }

  /** Corrects customer details (data-correction workflow) or blocks/unblocks the customer. */
  @Patch('customers/:id')
  @Permissions('customers.manage')
  async update(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    const { scope, relationships } = await this.visible(staff, id);
    const before = await this.prisma.customer.findUniqueOrThrow({ where: { id } });
    if (before.status === 'ANONYMIZED') throw new AppError('CUSTOMER_ANONYMIZED', 'An anonymised customer cannot be edited', 409);
    const { status, phone, ...rest } = dto;
    const customer = await this.prisma.tx(async (tx) => {
      if (status) {
        if (staff.allBrands) {
          await tx.customer.update({ where: { id }, data: { status } });
        } else {
          // Brand staff can only block the customer on their own brands, never platform-wide.
          await tx.customerBrandRelationship.updateMany({ where: { customerId: id, brandId: { in: scope ?? [] }, status: { in: ['ACTIVE', 'BLOCKED'] } }, data: { status } });
        }
      }
      return tx.customer.update({ where: { id }, data: { ...rest, fullName: rest.fullName?.trim(), phone: phone === undefined ? undefined : normPhone(phone) } });
    });
    await this.log(staff, status ? 'customer.status_change' : 'customer.update', staff.allBrands ? null : relationships[0].brandId, 'customer', id,
      { fullName: before.fullName, phone: before.phone, country: before.country, city: before.city, status: before.status },
      { ...dto, statusScope: status ? (staff.allBrands ? 'all brands' : relationships.map((r) => r.brandId)) : undefined });
    return { id: customer.id, fullName: customer.fullName, email: customer.email, phone: customer.phone, country: customer.country, city: customer.city, status: customer.status };
  }

  // ───────────────────────── Notes and tags ─────────────────────────

  @Post('customers/:id/notes')
  @Permissions('customers.manage')
  async addNote(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    await this.inBrand(staff, id, dto.brandId);
    return this.prisma.customerNote.create({ data: { customerId: id, brandId: dto.brandId, authorId: staff.userId, authorName: staff.fullName, body: dto.body } });
  }

  @Delete('customer-notes/:noteId')
  @Permissions('customers.manage')
  async deleteNote(@CurrentStaff() staff: Staff, @Param('noteId', ParseUUIDPipe) noteId: string) {
    const note = await this.prisma.customerNote.findUnique({ where: { id: noteId } });
    if (!note || !(staff.allBrands || staff.brandIds.includes(note.brandId))) throw notFound('Note');
    await this.prisma.customerNote.delete({ where: { id: noteId } });
    await this.log(staff, 'customer.note_delete', note.brandId, 'customer', note.customerId, { noteId, authorName: note.authorName });
    return { ok: true };
  }

  @Get('customer-tags')
  @Permissions('customers.read')
  tags(@CurrentStaff() staff: Staff, @Query() q: BrandQuery) {
    return this.prisma.customerTag.findMany({ where: brandWhere(staff, q.brandId), include: { _count: { select: { assignments: true } } }, orderBy: { name: 'asc' } });
  }

  @Post('customer-tags')
  @Permissions('customers.manage')
  async createTag(@CurrentStaff() staff: Staff, @Body() dto: TagDto) {
    assertBrandAccess(staff, dto.brandId);
    return this.prisma.customerTag.create({ data: { brandId: dto.brandId, name: dto.name.trim(), color: dto.color } });
  }

  /** Replaces the customer's tags for one brand. Tags of other brands are untouched. */
  @Put('customers/:id/tags')
  @Permissions('customers.manage')
  async setTags(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTagsDto) {
    await this.inBrand(staff, id, dto.brandId);
    const valid = await this.prisma.customerTag.count({ where: { id: { in: dto.tagIds }, brandId: dto.brandId } });
    if (valid !== dto.tagIds.length) throw new AppError('TAG_NOT_FOUND', 'One or more tags do not belong to this brand', 400);
    await this.prisma.tx(async (tx) => {
      await tx.customerTagAssignment.deleteMany({ where: { customerId: id, tag: { brandId: dto.brandId } } });
      await tx.customerTagAssignment.createMany({ data: dto.tagIds.map((tagId) => ({ customerId: id, tagId })) });
    });
    return this.prisma.customerTag.findMany({ where: { brandId: dto.brandId, assignments: { some: { customerId: id } } }, orderBy: { name: 'asc' } });
  }

  /** Records a consent change made by staff on the customer's instruction, for one brand and channel. */
  @Post('customers/:id/consents')
  @Permissions('customers.manage')
  async setConsent(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminConsentDto) {
    await this.inBrand(staff, id, dto.brandId);
    await this.customers.recordConsent(this.prisma, id, dto.brandId, dto.channel, dto.granted ? 'GRANTED' : 'WITHDRAWN', 'admin', dto.reason);
    await this.log(staff, 'customer.consent_change', dto.brandId, 'customer', id, undefined, dto);
    return this.customers.consentState(id, [dto.brandId]);
  }

  // ───────────────────────── Segments ─────────────────────────

  @Get('segments')
  @Permissions('crm.segments')
  segmentList(@CurrentStaff() staff: Staff, @Query() q: BrandQuery) {
    return this.prisma.customerSegment.findMany({ where: brandWhere(staff, q.brandId), orderBy: [{ brandId: 'asc' }, { name: 'asc' }] });
  }

  private async segment(staff: Staff, id: string) {
    const s = await this.prisma.customerSegment.findUnique({ where: { id } });
    if (!s || !(staff.allBrands || staff.brandIds.includes(s.brandId))) throw notFound('Segment');
    return s;
  }

  @Post('segments')
  @Permissions('crm.segments')
  async createSegment(@CurrentStaff() staff: Staff, @Body() dto: SegmentDto) {
    assertBrandAccess(staff, dto.brandId);
    const rules = normalizeRules(dto.rules);
    const lastCount = await this.segments.count(dto.brandId, rules);
    const s = await this.prisma.customerSegment.create({
      data: { brandId: dto.brandId, name: dto.name.trim(), description: dto.description, rules: rules as Prisma.InputJsonValue, lastCount, lastEvaluatedAt: new Date(), createdBy: staff.userId },
    });
    await this.log(staff, 'segment.create', s.brandId, 'customer_segment', s.id, undefined, { name: s.name, rules });
    return s;
  }

  @Patch('segments/:id')
  @Permissions('crm.segments')
  async updateSegment(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSegmentDto) {
    const before = await this.segment(staff, id);
    const rules = dto.rules ? normalizeRules(dto.rules) : undefined;
    const s = await this.prisma.customerSegment.update({
      where: { id },
      data: {
        name: dto.name?.trim(), description: dto.description, rules: rules as Prisma.InputJsonValue | undefined,
        ...(rules ? { lastCount: await this.segments.count(before.brandId, rules), lastEvaluatedAt: new Date() } : {}),
      },
    });
    await this.log(staff, 'segment.update', s.brandId, 'customer_segment', id, { name: before.name, rules: before.rules }, { name: s.name, rules: s.rules });
    return s;
  }

  @Delete('segments/:id')
  @Permissions('crm.segments')
  async deleteSegment(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.segment(staff, id);
    const used = await this.prisma.campaignAudience.count({ where: { segmentId: id, campaign: { status: { in: ['DRAFT', 'SCHEDULED', 'SENDING'] } } } });
    if (used) throw new AppError('SEGMENT_IN_USE', 'This segment is the audience of a campaign that has not been sent yet', 409);
    await this.prisma.customerSegment.delete({ where: { id } });
    await this.log(staff, 'segment.delete', s.brandId, 'customer_segment', id, { name: s.name, rules: s.rules });
    return { ok: true };
  }

  /** Evaluates rules without saving them: the audience size and a small sample. */
  @Post('segments/preview')
  @Permissions('crm.segments')
  preview(@CurrentStaff() staff: Staff, @Body() dto: SegmentPreviewDto) {
    assertBrandAccess(staff, dto.brandId);
    return this.segments.preview(dto.brandId, normalizeRules(dto.rules), 10);
  }

  @Post('segments/:id/evaluate')
  @Permissions('crm.segments')
  async evaluate(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.segment(staff, id);
    const lastCount = await this.segments.count(s.brandId, normalizeRules(s.rules));
    return this.prisma.customerSegment.update({ where: { id }, data: { lastCount, lastEvaluatedAt: new Date() } });
  }

  @Get('segments/:id/members')
  @Permissions('crm.segments')
  async members(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery, @Res() res: Response) {
    const s = await this.segment(staff, id);
    const rules = normalizeRules(s.rules);
    if (q.format === 'csv' || q.format === 'xlsx') {
      if (!hasPermission(staff, 'reports.export')) throw forbidden('Missing permission: reports.export');
      const rows = await this.segments.members(s.brandId, rules, { take: EXPORT_LIMIT });
      const columns: ExportColumn<SegmentMember>[] = [
        { header: 'Customer ID', value: (r) => r.id }, { header: 'Name', value: (r) => r.fullName }, { header: 'Email', value: (r) => r.email },
        { header: 'Phone', value: (r) => r.phone }, { header: 'Country', value: (r) => r.country }, { header: 'City', value: (r) => r.city },
      ];
      await this.log(staff, 'segment.export', s.brandId, 'customer_segment', id, undefined, { rows: rows.length, format: q.format });
      await sendExport(res, q.format, `segment-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, columns, rows);
      return;
    }
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([this.segments.members(s.brandId, rules, { skip, take }), this.segments.count(s.brandId, rules)]);
    res.json(paged(items, total, q));
  }

  // ───────────────────────── Privacy: data subject requests ─────────────────────────

  @Get('data-requests')
  @Permissions('customers.privacy')
  async dataRequests(@CurrentStaff() staff: Staff, @Query() q: DataRequestQuery) {
    const where = { ...brandWhere(staff, q.brandId), ...(q.status ? { status: q.status } : {}) };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.dataSubjectRequest.findMany({ where, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }], skip, take }),
      this.prisma.dataSubjectRequest.count({ where }),
    ]);
    const [customers, brands] = await Promise.all([
      this.prisma.customerBrandRelationship.findMany({
        where: { OR: rows.map((r) => ({ customerId: r.customerId, brandId: r.brandId })).concat(rows.length ? [] : [{ customerId: '00000000-0000-0000-0000-000000000000', brandId: '00000000-0000-0000-0000-000000000000' }]) },
        select: { customerId: true, brandId: true, email: true, customer: { select: { fullName: true } } },
      }),
      this.prisma.brand.findMany({ where: { id: { in: rows.map((r) => r.brandId) } }, select: { id: true, name: true } }),
    ]);
    const items = rows.map((r) => {
      const c = customers.find((x) => x.customerId === r.customerId && x.brandId === r.brandId);
      return { ...r, overdue: ['OPEN', 'IN_PROGRESS'].includes(r.status) && r.dueAt < new Date(), customerName: c?.customer.fullName ?? null, customerEmail: c?.email ?? null, brandName: brands.find((b) => b.id === r.brandId)?.name ?? null };
    });
    return paged(items, total, q);
  }

  @Patch('data-requests/:id')
  @Permissions('customers.privacy')
  async updateDataRequest(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDataRequestDto) {
    const before = await this.prisma.dataSubjectRequest.findUnique({ where: { id } });
    if (!before || !(staff.allBrands || staff.brandIds.includes(before.brandId))) throw notFound('Data request');
    const closing = dto.status === 'COMPLETED' || dto.status === 'REJECTED';
    if (closing && !(dto.resolution ?? before.resolution)) throw new AppError('RESOLUTION_REQUIRED', 'Describe how the request was resolved before closing it', 400);
    const r = await this.prisma.dataSubjectRequest.update({
      where: { id }, data: { status: dto.status, resolution: dto.resolution, handledBy: staff.userId, completedAt: closing ? new Date() : null },
    });
    await this.log(staff, 'data_request.update', r.brandId, 'data_subject_request', id, { status: before.status }, dto);
    return r;
  }

  /** Data-access fulfilment: everything held about the customer within one brand, as a JSON bundle. */
  @Get('customers/:id/export')
  @Permissions('customers.privacy')
  async exportData(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Query() q: ExportQuery) {
    const rel = await this.inBrand(staff, id, q.brandId);
    const brandId = q.brandId;
    const [customer, brand, orders, tickets, consents, preferences, communications, supportTickets, refunds, dataRequests, tags] = await Promise.all([
      this.prisma.customer.findUniqueOrThrow({ where: { id }, select: { id: true, fullName: true, email: true, phone: true, country: true, city: true, preferredCurrency: true, status: true, createdAt: true } }),
      this.prisma.brand.findUniqueOrThrow({ where: { id: brandId }, select: { id: true, name: true, contactEmail: true } }),
      this.prisma.order.findMany({
        where: { customerId: id, brandId }, orderBy: { createdAt: 'asc' },
        select: {
          reference: true, status: true, paymentStatus: true, currency: true, subtotalMinor: true, feesMinor: true, taxMinor: true, discountMinor: true, totalMinor: true,
          refundedMinor: true, customerName: true, customerEmail: true, customerPhone: true, customerCountry: true, sourceDomain: true, policyVersions: true, createdAt: true, paidAt: true,
          event: { select: { name: true, startsAt: true } }, items: { select: { categoryName: true, quantity: true, unitPriceMinor: true, lineTotalMinor: true } },
        },
      }),
      this.prisma.ticket.findMany({
        where: { customerId: id, brandId }, orderBy: { issuedAt: 'asc' },
        select: { reference: true, status: true, holderName: true, holderEmail: true, issuedAt: true, usedAt: true, event: { select: { name: true, startsAt: true } }, ticketCategory: { select: { name: true } } },
      }),
      this.prisma.marketingConsent.findMany({ where: { customerId: id, brandId }, orderBy: { createdAt: 'asc' }, select: { channel: true, status: true, source: true, lawfulBasis: true, wording: true, createdAt: true } }),
      this.prisma.customerPreference.findMany({ where: { customerId: id, brandId }, select: { key: true, value: true, updatedAt: true } }),
      this.prisma.notificationLog.findMany({ where: { customerId: id, brandId }, orderBy: { createdAt: 'asc' }, select: { channel: true, type: true, toAddress: true, subject: true, event: true, createdAt: true } }),
      this.prisma.supportTicket.findMany({
        where: { customerId: id, brandId }, orderBy: { createdAt: 'asc' },
        select: { reference: true, subject: true, issueType: true, status: true, createdAt: true, messages: { where: { internal: false }, orderBy: { createdAt: 'asc' }, select: { authorType: true, body: true, createdAt: true } } },
      }),
      this.prisma.refund.findMany({ where: { brandId, order: { customerId: id } }, orderBy: { requestedAt: 'asc' }, select: { reference: true, amountMinor: true, currency: true, status: true, reason: true, requestedAt: true, processedAt: true } }),
      this.prisma.dataSubjectRequest.findMany({ where: { customerId: id, brandId }, orderBy: { createdAt: 'asc' }, select: { type: true, status: true, details: true, resolution: true, createdAt: true, completedAt: true } }),
      this.prisma.customerTagAssignment.findMany({ where: { customerId: id, tag: { brandId } }, select: { tag: { select: { name: true } } } }),
    ]);
    await this.log(staff, 'customer.data_export', brandId, 'customer', id, undefined, { orders: orders.length, tickets: tickets.length });
    return {
      generatedAt: new Date(), controller: brand,
      customer,
      account: { email: rel.email, emailVerifiedAt: rel.emailVerifiedAt, status: rel.status, hasPassword: !!rel.passwordHash, createdAt: rel.createdAt, lastLoginAt: rel.lastLoginAt },
      orders, tickets, refunds, marketingConsentHistory: consents, preferences, communications, supportRequests: supportTickets, dataRequests,
      tags: tags.map((t) => t.tag.name),
    };
  }

  /**
   * Erasure. Personal data held for the given brand is removed or replaced with
   * placeholders; orders, payments and ledger entries are retained (without personal
   * details) because financial records must be kept. The central customer record is scrubbed
   * once no brand relationship remains.
   */
  @Post('customers/:id/anonymize')
  @Permissions('customers.privacy')
  async anonymize(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AnonymizeDto) {
    await this.inBrand(staff, id, dto.brandId);
    if (dto.allBrands && !staff.allBrands) throw forbidden('Only platform-wide administrators can erase a customer across all brands');

    const result = await this.prisma.tx(async (tx) => {
      const rels = await tx.customerBrandRelationship.findMany({ where: { customerId: id, ...(dto.allBrands ? {} : { brandId: dto.brandId }) } });
      const placeholder = `anonymized+${id}@invalid.local`;
      for (const rel of rels) {
        const brandId = rel.brandId;
        await tx.customerToken.deleteMany({ where: { relationshipId: rel.id } });
        // The relationship row is kept (orders reference it) but can no longer sign in or be contacted.
        await tx.customerBrandRelationship.update({
          where: { id: rel.id },
          data: { passwordHash: null, email: `anonymized+${rel.id}@invalid.local`, emailVerifiedAt: null, status: 'ANONYMIZED' },
        });
        // Withdraw (not delete) consent, so the record shows marketing stopped and when.
        const granted = (await this.customers.consentState(id, [brandId])).filter((c) => c.status === 'GRANTED');
        for (const c of granted) {
          await tx.marketingConsent.create({ data: { customerId: id, brandId, channel: c.channel, status: 'WITHDRAWN', source: 'admin', wording: 'Withdrawn by erasure request' } });
        }
        await tx.order.updateMany({ where: { customerId: id, brandId }, data: { customerName: 'Anonymized', customerEmail: placeholder, customerPhone: null } });
        await tx.ticket.updateMany({ where: { customerId: id, brandId }, data: { holderName: null, holderEmail: null } });
        await tx.emailJob.updateMany({ where: { customerId: id, brandId, status: { in: ['QUEUED', 'SENDING'] } }, data: { status: 'SKIPPED', lastError: 'Customer anonymised' } });
        await tx.emailJob.updateMany({ where: { customerId: id, brandId }, data: { toAddress: placeholder, toName: null, payload: {} } });
        await tx.notificationLog.updateMany({ where: { customerId: id, brandId }, data: { toAddress: placeholder } });
        await tx.campaignDelivery.updateMany({ where: { customerId: id, campaign: { brandId } }, data: { toAddress: placeholder } });
        await tx.supportTicket.updateMany({ where: { customerId: id, brandId }, data: { contactEmail: placeholder, contactName: null } });
        await tx.customerNote.deleteMany({ where: { customerId: id, brandId } });
        await tx.customerPreference.deleteMany({ where: { customerId: id, brandId } });
        await tx.customerTagAssignment.deleteMany({ where: { customerId: id, tag: { brandId } } });
        await tx.ticketTransfer.updateMany({ where: { fromCustomerId: id, brandId, status: 'PENDING' }, data: { status: 'CANCELLED', completedAt: new Date() } });
      }
      const remaining = await tx.customerBrandRelationship.count({ where: { customerId: id, status: { not: 'ANONYMIZED' } } });
      if (remaining === 0) {
        await tx.customerIdentity.deleteMany({ where: { customerId: id } });
        await tx.customer.update({
          where: { id },
          data: { fullName: 'Anonymized customer', email: null, phone: null, country: null, city: null, preferredCurrency: null, status: 'ANONYMIZED', anonymizedAt: new Date() },
        });
      }
      for (const rel of rels) {
        await this.audit.record({
          actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: rel.brandId, action: 'customer.anonymize', entityType: 'customer', entityId: id,
          metadata: { reason: dto.reason, centralRecordScrubbed: remaining === 0 },
        }, tx);
      }
      return { brandsAnonymized: rels.map((r) => r.brandId), centralRecordScrubbed: remaining === 0 };
    });
    return { ok: true, ...result, retained: 'Orders, payments, refunds and ledger entries are retained without personal details.' };
  }
}
