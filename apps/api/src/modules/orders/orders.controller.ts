import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsBooleanString, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { Response } from 'express';
import { assertBrandAccess, brandWhere, CurrentStaff, hasPermission, Permissions, Staff, StaffGuard } from '../../common/auth';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { dateRange, EXPORT_LIMIT, paged, PageQuery, paging, sendExport } from '../../common/util';
import { PaymentService } from '../payments/payment.service';
import { OrderService } from './order.service';

const ORDER_STATUSES = ['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'FAILED'];

class OrderQuery extends PageQuery {
  @IsOptional() @IsIn(ORDER_STATUSES) status?: string;
  @IsOptional() @IsIn(['UNPAID', 'PROCESSING', 'PAID', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED']) paymentStatus?: string;
  @IsOptional() @IsUUID() eventId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsBooleanString() needsAttention?: string;
}
class ReasonDto {
  @IsString() @MinLength(3) reason: string;
}

@ApiTags('Admin · Orders')
@ApiBearerAuth()
@Controller('v1/admin/orders')
@UseGuards(StaffGuard)
export class OrdersController {
  constructor(private prisma: PrismaService, private orders: OrderService, private payments: PaymentService, private audit: AuditService) {}

  /** Tenant filter applied to every order query: brand scope plus, for event-scoped staff, their assigned events. */
  private scope(staff: Staff, brandId?: string): Prisma.OrderWhereInput {
    return { ...brandWhere(staff, brandId), ...(staff.eventScoped ? { eventId: { in: staff.eventIds } } : {}) };
  }

  private async load(staff: Staff, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, ...this.scope(staff) } });
    if (!order) throw notFound('Order'); // also the answer for another brand's order
    return order;
  }

  /**
   * All orders from every storefront the caller can access. Search matches order reference,
   * customer email, phone or name. Add `format=csv|xlsx` to export the filtered result.
   */
  @Get()
  @Permissions('orders.read')
  async list(@CurrentStaff() staff: Staff, @Query() q: OrderQuery, @Res({ passthrough: true }) res: Response) {
    const term = q.q?.trim();
    // Only treat the term as a phone number when it looks like one; otherwise the digits inside
    // an email or reference would match unrelated phone numbers.
    const phoneDigits = term && /^[\d\s+()-]{5,}$/.test(term) ? term.replace(/[^\d]/g, '') : null;
    const where: Prisma.OrderWhereInput = {
      ...this.scope(staff, q.brandId),
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.paymentStatus ? { paymentStatus: q.paymentStatus as any } : {}),
      ...(q.eventId ? { eventId: q.eventId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.needsAttention ? { needsAttention: q.needsAttention === 'true' } : {}),
      ...(dateRange(q) ? { createdAt: dateRange(q) } : {}),
      ...(term
        ? {
            OR: [
              { reference: { contains: term.toUpperCase() } },
              { customerEmail: { contains: term.toLowerCase() } },
              ...(phoneDigits ? [{ customerPhone: { contains: phoneDigits.replace(/^0/, '') } }] : []),
              { customerName: { contains: term, mode: 'insensitive' } },
              { gatewayReference: { equals: term.toUpperCase() } },
            ],
          }
        : {}),
    };
    const include = {
      brand: { select: { id: true, name: true, primaryColor: true } },
      event: { select: { id: true, name: true, startsAt: true } },
      items: { select: { categoryName: true, quantity: true } },
    } satisfies Prisma.OrderInclude;

    if (q.format) {
      if (!hasPermission(staff, 'orders.export')) throw forbidden('Missing permission: orders.export');
      const rows = await this.prisma.order.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: EXPORT_LIMIT });
      await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: q.brandId, action: 'orders.export', metadata: { rows: rows.length, format: q.format, filters: { ...q } } });
      await sendExport(res, q.format, 'orders', [
        { header: 'Order reference', value: (o) => o.reference },
        { header: 'Created', value: (o) => o.createdAt },
        { header: 'Brand', value: (o) => o.brand.name },
        { header: 'Source domain', value: (o) => o.sourceDomain },
        { header: 'Event', value: (o) => o.event.name },
        { header: 'Tickets', value: (o) => o.items.map((i) => `${i.quantity} x ${i.categoryName}`).join('; ') },
        { header: 'Customer', value: (o) => o.customerName },
        { header: 'Email', value: (o) => o.customerEmail },
        { header: 'Phone', value: (o) => o.customerPhone },
        { header: 'Currency', value: (o) => o.currency },
        { header: 'Subtotal', value: (o) => Number(o.subtotalMinor) / 100 },
        { header: 'Fees', value: (o) => Number(o.feesMinor) / 100 },
        { header: 'Tax', value: (o) => Number(o.taxMinor) / 100 },
        { header: 'Discount', value: (o) => Number(o.discountMinor) / 100 },
        { header: 'Total', value: (o) => Number(o.totalMinor) / 100 },
        { header: 'Refunded', value: (o) => Number(o.refundedMinor) / 100 },
        { header: 'Order status', value: (o) => o.status },
        { header: 'Payment status', value: (o) => o.paymentStatus },
        { header: 'Gateway', value: (o) => o.gatewayCode },
        { header: 'Gateway reference', value: (o) => o.gatewayReference },
        { header: 'Paid at', value: (o) => o.paidAt },
      ], rows);
      return;
    }

    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.order.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Full order record: items, status history, payments, tickets, refunds and the financial allocation. */
  @Get(':id')
  @Permissions('orders.read')
  async get(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    await this.load(staff, id);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: {
        brand: { select: { id: true, name: true, primaryColor: true, status: true } },
        legalEntity: { select: { id: true, name: true, country: true } },
        customer: { select: { id: true, fullName: true, email: true, phone: true } },
        event: { select: { id: true, name: true, startsAt: true, timezone: true, status: true, venue: { select: { name: true, city: true } }, organizer: { select: { id: true, name: true } } } },
        items: true,
        history: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' }, include: { attempts: { orderBy: { createdAt: 'desc' }, take: 20 }, providerAccount: { select: { label: true, livemode: true } } } },
        tickets: { orderBy: { reference: 'asc' }, include: { ticketCategory: { select: { name: true } } } },
        refunds: { orderBy: { requestedAt: 'desc' } },
        commissions: true,
        reservations: true,
      },
    });
    const canSeeFinance = hasPermission(staff, 'reports.financial');
    const [emails, ledger] = await Promise.all([
      this.prisma.emailJob.findMany({ where: { orderId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, channel: true, toAddress: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true } }),
      canSeeFinance
        ? this.prisma.ledgerTransaction.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' }, include: { entries: { select: { account: true, direction: true, amountMinor: true, currency: true } } } })
        : Promise.resolve(null),
    ]);
    const sum = (type: string) => order.commissions.filter((c) => c.type === type).reduce((s, c) => s + c.amountMinor, 0n);
    const platform = sum('PLATFORM_COMMISSION');
    const brandCut = sum('BRAND_COMMISSION');
    return {
      ...order,
      payments: order.payments.map(({ verification: _v, ...p }) => p),
      // Transparent breakdown of where every unit of the order total goes.
      allocation: {
        currency: order.currency,
        customerPaysMinor: order.totalMinor,
        ticketFaceValueMinor: order.subtotalMinor - order.discountMinor,
        serviceFeesMinor: order.feesMinor,
        taxMinor: order.taxMinor,
        platformCommissionMinor: platform,
        brandCommissionMinor: brandCut,
        promoterNetMinor: order.subtotalMinor - order.discountMinor - platform - brandCut,
        gatewayChargeMinor: order.payments.find((p) => p.status === 'SUCCEEDED')?.gatewayFeeMinor ?? null,
      },
      emails,
      ledger,
    };
  }

  /** Re-sends the ticket email using the brand the order was placed on. */
  @Post(':id/resend-tickets')
  @HttpCode(200)
  @Permissions('orders.manage')
  async resend(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const order = await this.load(staff, id);
    const result = await this.payments.resendTickets(id);
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: order.brandId, action: 'order.resend_tickets', entityType: 'order', entityId: id, metadata: result });
    return result;
  }

  /** Cancels an unpaid order and releases its inventory. Paid orders go through the refund workflow. */
  @Post(':id/cancel')
  @HttpCode(200)
  @Permissions('orders.manage')
  async cancel(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const order = await this.load(staff, id);
    const closed = await this.prisma.tx((tx) => this.orders.close(tx, id, 'CANCELLED', { type: 'USER', id: staff.userId }, dto.reason));
    if (!closed) throw new AppError('ORDER_NOT_CANCELLABLE', `A ${order.status} order cannot be cancelled. Use a refund for paid orders.`, 409);
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: order.brandId, action: 'order.cancel', entityType: 'order', entityId: id, before: { status: order.status }, after: { status: 'CANCELLED', reason: dto.reason } });
    return closed;
  }

  /** Asks the payment provider for the latest payment state right now (for an order stuck awaiting payment). */
  @Post(':id/verify-payment')
  @HttpCode(200)
  @Permissions('payments.read')
  async verifyPayment(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const order = await this.load(staff, id);
    const payment = await this.prisma.payment.findFirst({ where: { orderId: id, status: { in: ['PENDING', 'INITIATED'] } }, orderBy: { createdAt: 'desc' } });
    if (!payment) throw new AppError('NO_PENDING_PAYMENT', 'This order has no payment awaiting confirmation', 409);
    const outcome = await this.payments.confirmPayment(payment.reference, 'ADMIN');
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: order.brandId, action: 'order.verify_payment', entityType: 'order', entityId: id, metadata: { outcome, paymentReference: payment.reference } });
    return { outcome };
  }

  /** Clears the needs-attention flag once the underlying issue has been handled. */
  @Post(':id/resolve-attention')
  @HttpCode(200)
  @Permissions('orders.manage')
  async resolveAttention(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const order = await this.load(staff, id);
    assertBrandAccess(staff, order.brandId);
    await this.prisma.order.update({ where: { id }, data: { needsAttention: false } });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: order.brandId, action: 'order.resolve_attention', entityType: 'order', entityId: id, before: { attentionReason: order.attentionReason }, after: { resolution: dto.reason } });
    return { ok: true };
  }
}
