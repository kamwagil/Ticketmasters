import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { assertBrandAccess, brandWhere, CurrentStaff, hasPermission, Permissions, Staff, StaffGuard } from '../../common/auth';
import { reference } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { normEmail, paged, PageQuery, paging } from '../../common/util';
import { NotificationService } from '../notifications/notification.service';
import { RefundService } from '../payments/refund.service';

const STATUSES = ['OPEN', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const ISSUES = ['GENERAL_ENQUIRY', 'TICKET_DELIVERY', 'PAYMENT', 'REFUND_REQUEST', 'EVENT_CANCELLATION', 'ORDER_ENQUIRY'] as const;
type Status = (typeof STATUSES)[number];
type Priority = (typeof PRIORITIES)[number];
type Issue = (typeof ISSUES)[number];

class SupportQuery extends PageQuery {
  @IsOptional() @IsIn(STATUSES) status?: Status;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsIn(ISSUES) issueType?: Issue;
  /** A staff user id, or "me" / "unassigned". */
  @IsOptional() @IsString() @MaxLength(40) assignedToId?: string;
}
class BrandQuery {
  @IsOptional() @IsUUID() brandId?: string;
}
class CreateTicketDto {
  @IsUUID() brandId: string;
  @IsEmail() contactEmail: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsString() @MinLength(3) @MaxLength(200) subject: string;
  @IsString() @MinLength(1) @MaxLength(5000) message: string;
  @IsOptional() @IsIn(ISSUES) issueType?: Issue;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsString() @MaxLength(40) orderReference?: string;
}
class MessageDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
  /** Internal notes are visible to staff only and are never emailed. */
  @IsOptional() @IsBoolean() internal?: boolean;
}
class UpdateTicketDto {
  @IsOptional() @IsIn(STATUSES) status?: Status;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsIn(ISSUES) issueType?: Issue;
  /** Staff user id, or null to unassign. */
  @IsOptional() @IsUUID() assignedToId?: string | null;
}
class EscalateRefundDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) ticketIds?: string[];
  @IsOptional() @IsInt() @Min(1) amountMinor?: number;
}

@ApiTags('Admin · Customer Support')
@ApiBearerAuth()
@Controller('v1/admin/support')
@UseGuards(StaffGuard)
export class SupportController {
  constructor(private prisma: PrismaService, private audit: AuditService, private notifications: NotificationService, private refunds: RefundService) {}

  private async ticket(staff: Staff, id: string) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    // Tickets of brands outside the caller's scope do not exist for them.
    if (!t || !(staff.allBrands || staff.brandIds.includes(t.brandId))) throw notFound('Support ticket');
    return t;
  }

  /** Counts for the support dashboard, within the caller's brand scope. */
  @Get('summary')
  @Permissions('support.read')
  async summary(@CurrentStaff() staff: Staff, @Query() q: BrandQuery) {
    const where = brandWhere(staff, q.brandId);
    const open = { ...where, status: { in: ['OPEN', 'PENDING_INTERNAL', 'PENDING_CUSTOMER'] as Status[] } };
    const [byStatus, byPriority, byIssue, byBrand, unassigned, mine] = await Promise.all([
      this.prisma.supportTicket.groupBy({ by: ['status'], where, _count: true }),
      this.prisma.supportTicket.groupBy({ by: ['priority'], where: open, _count: true }),
      this.prisma.supportTicket.groupBy({ by: ['issueType'], where: open, _count: true }),
      this.prisma.supportTicket.groupBy({ by: ['brandId'], where: open, _count: true }),
      this.prisma.supportTicket.count({ where: { ...open, assignedToId: null } }),
      this.prisma.supportTicket.count({ where: { ...open, assignedToId: staff.userId } }),
    ]);
    const brands = await this.prisma.brand.findMany({ where: { id: { in: byBrand.map((b) => b.brandId) } }, select: { id: true, name: true } });
    return {
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      openByPriority: Object.fromEntries(byPriority.map((s) => [s.priority, s._count])),
      openByIssueType: Object.fromEntries(byIssue.map((s) => [s.issueType, s._count])),
      openByBrand: byBrand.map((b) => ({ brandId: b.brandId, brandName: brands.find((x) => x.id === b.brandId)?.name ?? null, count: b._count })),
      open: byStatus.filter((s) => ['OPEN', 'PENDING_INTERNAL', 'PENDING_CUSTOMER'].includes(s.status)).reduce((n, s) => n + s._count, 0),
      unassigned, assignedToMe: mine,
    };
  }

  @Get('tickets')
  @Permissions('support.read')
  async list(@CurrentStaff() staff: Staff, @Query() q: SupportQuery) {
    const text = q.q?.trim();
    const assigned =
      q.assignedToId === 'me' ? { assignedToId: staff.userId }
      : q.assignedToId === 'unassigned' ? { assignedToId: null }
      : q.assignedToId ? { assignedToId: q.assignedToId } : {};
    if (q.assignedToId && !['me', 'unassigned'].includes(q.assignedToId) && !/^[0-9a-f-]{36}$/i.test(q.assignedToId)) {
      throw new AppError('VALIDATION_FAILED', 'assignedToId must be a user id, "me" or "unassigned"', 400);
    }
    const where: Prisma.SupportTicketWhereInput = {
      ...brandWhere(staff, q.brandId), ...assigned,
      ...(q.status ? { status: q.status } : {}), ...(q.priority ? { priority: q.priority } : {}), ...(q.issueType ? { issueType: q.issueType } : {}),
      ...(q.from || q.to ? { createdAt: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } } : {}),
      ...(text
        ? { OR: [{ reference: { contains: text.toUpperCase() } }, { subject: { contains: text, mode: 'insensitive' } }, { contactEmail: { contains: text, mode: 'insensitive' } }, { contactName: { contains: text, mode: 'insensitive' } }] }
        : {}),
    };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where, orderBy: [{ updatedAt: 'desc' }], skip, take,
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true, authorType: true, internal: true } }, _count: { select: { messages: true } } },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    const [brands, users, orders] = await Promise.all([
      this.prisma.brand.findMany({ where: { id: { in: rows.map((r) => r.brandId) } }, select: { id: true, name: true, primaryColor: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.assignedToId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } }),
      this.prisma.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => !!x) } }, select: { id: true, reference: true } }),
    ]);
    const items = rows.map(({ messages, _count, ...t }) => ({
      ...t,
      brand: brands.find((b) => b.id === t.brandId) ?? null,
      assignedTo: users.find((u) => u.id === t.assignedToId) ?? null,
      orderReference: orders.find((o) => o.id === t.orderId)?.reference ?? null,
      messageCount: _count.messages,
      lastMessageAt: messages[0]?.createdAt ?? t.createdAt,
      lastMessageFrom: messages[0]?.authorType ?? null,
    }));
    return paged(items, total, q);
  }

  /** Full conversation (including internal notes) plus the brand identity the agent must reply as. */
  @Get('tickets/:id')
  @Permissions('support.read')
  async get(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const t = await this.ticket(staff, id);
    const [messages, brand, order, customer, assignedTo, refund] = await Promise.all([
      this.prisma.supportMessage.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.brand.findUniqueOrThrow({
        where: { id: t.brandId },
        select: { id: true, name: true, status: true, logoUrl: true, primaryColor: true, secondaryColor: true, emailSenderName: true, emailSenderAddr: true, contactEmail: true, supportPhone: true, supportUrl: true },
      }),
      t.orderId
        ? this.prisma.order.findFirst({
            where: { id: t.orderId, brandId: t.brandId },
            select: {
              id: true, reference: true, status: true, paymentStatus: true, currency: true, totalMinor: true, refundedMinor: true, createdAt: true, paidAt: true, needsAttention: true,
              event: { select: { id: true, name: true, startsAt: true, status: true } }, items: { select: { categoryName: true, quantity: true } },
              tickets: { select: { id: true, reference: true, status: true, ticketCategory: { select: { name: true } } }, orderBy: { reference: 'asc' } },
            },
          })
        : null,
      t.customerId
        ? this.prisma.customerBrandRelationship.findUnique({
            where: { brandId_customerId: { brandId: t.brandId, customerId: t.customerId } },
            select: { customerId: true, email: true, emailVerifiedAt: true, status: true, orderCount: true, lastOrderAt: true, customer: { select: { fullName: true, phone: true, country: true, status: true } } },
          })
        : null,
      t.assignedToId ? this.prisma.user.findUnique({ where: { id: t.assignedToId }, select: { id: true, fullName: true, email: true } }) : null,
      t.refundId ? this.prisma.refund.findFirst({ where: { id: t.refundId, brandId: t.brandId }, select: { id: true, reference: true, status: true, amountMinor: true, currency: true, requestedAt: true } }) : null,
    ]);
    return {
      ...t, messages, order, refund, assignedTo,
      customer: customer ? { id: customer.customerId, fullName: customer.customer.fullName, email: customer.email, phone: customer.customer.phone, country: customer.customer.country, emailVerified: !!customer.emailVerifiedAt, status: customer.status, orderCount: customer.orderCount, lastOrderAt: customer.lastOrderAt } : null,
      // Replies are sent with this identity, whichever brand the agent normally works on.
      replyAs: { brand: brand.name, fromName: brand.emailSenderName, fromAddress: brand.emailSenderAddr, replyTo: brand.contactEmail, supportPhone: brand.supportPhone, supportUrl: brand.supportUrl },
      brand,
    };
  }

  /** Opens a ticket on behalf of a customer (phone call, social media, walk-in). */
  @Post('tickets')
  @Permissions('support.manage')
  async create(@CurrentStaff() staff: Staff, @Body() dto: CreateTicketDto) {
    assertBrandAccess(staff, dto.brandId);
    const email = normEmail(dto.contactEmail);
    const rel = await this.prisma.customerBrandRelationship.findUnique({ where: { brandId_email: { brandId: dto.brandId, email } } });
    let orderId: string | null = null;
    if (dto.orderReference) {
      const order = await this.prisma.order.findFirst({ where: { reference: dto.orderReference.toUpperCase(), brandId: dto.brandId } });
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'No order with this reference exists for this brand', 400);
      orderId = order.id;
    }
    const t = await this.prisma.supportTicket.create({
      data: {
        reference: reference('SUP', 8), brandId: dto.brandId, customerId: rel?.customerId ?? null, orderId, contactEmail: email, contactName: dto.contactName?.trim() || null,
        issueType: dto.issueType ?? 'GENERAL_ENQUIRY', priority: dto.priority ?? 'NORMAL', subject: dto.subject.trim(), assignedToId: staff.userId, status: 'PENDING_INTERNAL',
        // Recorded as an internal note: it is the agent's summary of the enquiry, not something to email back to the customer.
        messages: { create: { authorType: 'STAFF', authorId: staff.userId, authorName: staff.fullName, body: dto.message, internal: true } },
      },
    });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: t.brandId, action: 'support.ticket_create', entityType: 'support_ticket', entityId: t.id, after: { reference: t.reference, subject: t.subject } });
    return t;
  }

  /** Adds an internal note, or replies to the customer as the ticket's originating brand. */
  @Post('tickets/:id/messages')
  @Permissions('support.manage')
  async addMessage(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MessageDto) {
    const t = await this.ticket(staff, id);
    const internal = dto.internal ?? false;
    const message = await this.prisma.tx(async (tx) => {
      const m = await tx.supportMessage.create({ data: { ticketId: id, authorType: 'STAFF', authorId: staff.userId, authorName: staff.fullName, body: dto.body, internal } });
      if (internal) {
        await tx.supportTicket.update({ where: { id }, data: { updatedAt: new Date() } });
        return m;
      }
      await tx.supportTicket.update({
        where: { id },
        data: { status: ['RESOLVED', 'CLOSED'].includes(t.status) ? t.status : 'PENDING_CUSTOMER', assignedToId: t.assignedToId ?? staff.userId },
      });
      await this.notifications.enqueue({
        brandId: t.brandId, // always the brand the customer contacted
        type: 'SUPPORT_UPDATE', to: t.contactEmail, toName: t.contactName, customerId: t.customerId, orderId: t.orderId,
        payload: { name: t.contactName ?? 'there', ticketReference: t.reference, ticketSubject: t.subject, message: dto.body },
        dedupeKey: `support-reply:${m.id}`,
      }, tx);
      return m;
    });
    if (!internal) await this.notifications.kick();
    return message;
  }

  @Patch('tickets/:id')
  @Permissions('support.manage')
  async update(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto) {
    const before = await this.ticket(staff, id);
    if (dto.assignedToId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: dto.assignedToId, status: 'ACTIVE', deletedAt: null, OR: [{ allBrands: true }, { brandAssignments: { some: { brandId: before.brandId } } }] },
        select: { id: true },
      });
      if (!assignee) throw new AppError('ASSIGNEE_INVALID', 'The assignee must be an active staff member with access to this ticket\'s brand', 400);
    }
    const closing = dto.status === 'RESOLVED' || dto.status === 'CLOSED';
    const t = await this.prisma.supportTicket.update({
      where: { id },
      data: {
        status: dto.status, priority: dto.priority, issueType: dto.issueType, assignedToId: dto.assignedToId,
        resolvedAt: dto.status ? (closing ? (before.resolvedAt ?? new Date()) : null) : undefined,
      },
    });
    await this.audit.record({
      actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: t.brandId, action: 'support.ticket_update', entityType: 'support_ticket', entityId: id,
      before: { status: before.status, priority: before.priority, issueType: before.issueType, assignedToId: before.assignedToId }, after: dto,
    });
    return t;
  }

  /** Raises a refund request for the ticket's order. It still goes through the normal refund approval workflow. */
  @Post('tickets/:id/escalate-refund')
  @Permissions('support.manage', 'refunds.request')
  async escalateRefund(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EscalateRefundDto) {
    const t = await this.ticket(staff, id);
    if (!t.orderId) throw new AppError('NO_ORDER_LINKED', 'This support ticket is not linked to an order', 409);
    const order = await this.prisma.order.findFirst({ where: { id: t.orderId, brandId: t.brandId }, select: { id: true, reference: true } });
    if (!order) throw new AppError('NO_ORDER_LINKED', 'This support ticket is not linked to an order', 409);
    const refund = await this.refunds.request(
      {
        orderId: order.id, ticketIds: dto.ticketIds, amountMinor: dto.amountMinor === undefined ? undefined : BigInt(dto.amountMinor),
        reason: `${dto.reason} (support ${t.reference})`, idempotencyKey: `support:${t.id}:${randomUUID()}`,
      },
      { type: 'USER', id: staff.userId, label: staff.email, canSelfApprove: hasPermission(staff, 'refunds.self_approve') },
    );
    await this.prisma.$transaction([
      this.prisma.supportTicket.update({ where: { id }, data: { refundId: refund.id, issueType: 'REFUND_REQUEST', status: ['RESOLVED', 'CLOSED'].includes(t.status) ? 'PENDING_INTERNAL' : t.status } }),
      this.prisma.supportMessage.create({
        data: { ticketId: id, authorType: 'SYSTEM', authorName: 'System', internal: true, body: `Refund request ${refund.reference} raised for order ${order.reference} by ${staff.fullName}. Awaiting approval.` },
      }),
    ]);
    await this.audit.record({
      actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: t.brandId, action: 'support.escalate_refund', entityType: 'support_ticket', entityId: id,
      after: { refundId: refund.id, refundReference: refund.reference, orderReference: order.reference },
    });
    return { refundId: refund.id, refundReference: refund.reference, status: refund.status, amountMinor: refund.amountMinor, currency: refund.currency };
  }
}
