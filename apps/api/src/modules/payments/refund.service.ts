import { Injectable } from '@nestjs/common';
import { Refund } from '@prisma/client';
import { reference } from '../../common/crypto';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AlertService, AuditService, PrismaService } from '../../common/infra';
import { formatMoney } from '../../common/util';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationService } from '../notifications/notification.service';
import { OrderService, PAID_STATES } from '../orders/order.service';
import { TicketService } from '../tickets/ticket.service';
import { LedgerService } from './ledger.service';
import { PaymentService } from './payment.service';
import { ProviderRegistry } from './providers';

export interface RefundRequestInput {
  orderId: string;
  /** Tickets to revoke. Omit (with no amount) to refund the whole remaining order. */
  ticketIds?: string[];
  /** Explicit amount. Defaults to the selected tickets' share, or the full remaining balance. */
  amountMinor?: bigint;
  reason: string;
  returnInventory?: boolean;
  idempotencyKey: string;
}
export interface RefundActor {
  type: 'USER' | 'CUSTOMER' | 'SYSTEM';
  id: string | null;
  label?: string;
  canSelfApprove?: boolean;
}

const OPEN = ['REQUESTED', 'APPROVED', 'PROCESSING'] as const;

/**
 * Refund workflow: REQUESTED → APPROVED → PROCESSING → SUCCEEDED | FAILED (or REJECTED).
 *
 * Double refunds are prevented at three levels: every request carries a unique idempotency
 * key; requests are validated under the order row lock against everything already refunded
 * or in flight; and each state change is a conditional UPDATE that only one caller can win.
 */
@Injectable()
export class RefundService {
  constructor(
    private prisma: PrismaService,
    private orders: OrderService,
    private payments: PaymentService,
    private registry: ProviderRegistry,
    private ledger: LedgerService,
    private tickets: TicketService,
    private inventory: InventoryService,
    private notifications: NotificationService,
    private audit: AuditService,
    private alerts: AlertService,
  ) {}

  async request(input: RefundRequestInput, actor: RefundActor): Promise<Refund> {
    const existing = await this.prisma.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;

    const refund = await this.prisma.tx(async (tx) => {
      const order = await this.orders.lock(tx, input.orderId);
      if (!PAID_STATES.includes(order.status) || order.status === 'REFUNDED') {
        throw new AppError('ORDER_NOT_REFUNDABLE', `A ${order.status} order cannot be refunded`, 409);
      }
      const payment = await tx.payment.findFirst({ where: { orderId: order.id, status: 'SUCCEEDED' } });
      if (!payment) throw new AppError('ORDER_NOT_REFUNDABLE', 'This order has no captured payment to refund', 409);

      const open = await tx.refund.findMany({ where: { orderId: order.id, status: { in: [...OPEN] } } });
      const inFlight = open.reduce((s, r) => s + r.amountMinor, 0n);
      const remaining = order.totalMinor - order.refundedMinor - inFlight;
      if (remaining <= 0n) throw new AppError('NOTHING_TO_REFUND', 'This order is already fully refunded or has refunds in progress', 409);

      const lockedTickets = new Set(open.flatMap((r) => r.ticketIds));
      const orderTickets = await tx.ticket.findMany({ where: { orderId: order.id }, include: { order: false } });
      const refundable = orderTickets.filter((t) => ['VALID', 'USED'].includes(t.status) && !lockedTickets.has(t.id));

      let ticketIds = input.ticketIds ?? [];
      let amount = input.amountMinor;
      if (ticketIds.length) {
        const bad = ticketIds.filter((id) => !refundable.some((t) => t.id === id));
        if (bad.length) throw new AppError('TICKET_NOT_REFUNDABLE', 'One or more tickets are not on this order, already refunded, or part of another refund', 409, { ticketIds: bad });
        if (amount === undefined) {
          // Each ticket's share of what the customer paid, including its share of fees and tax.
          const totalTickets = BigInt(orderTickets.length);
          const refundingAll = ticketIds.length === refundable.length;
          amount = refundingAll ? remaining : (order.totalMinor * BigInt(ticketIds.length)) / totalTickets;
        }
      } else if (amount === undefined) {
        amount = remaining;
        ticketIds = refundable.map((t) => t.id);
      }
      if (amount <= 0n) throw new AppError('REFUND_AMOUNT_INVALID', 'Refund amount must be greater than zero', 400);
      if (amount > remaining) {
        throw new AppError('REFUND_EXCEEDS_BALANCE', `Refund exceeds the refundable balance of ${formatMoney(remaining, order.currency)}`, 409, { remainingMinor: Number(remaining) });
      }

      const r = await tx.refund.create({
        data: {
          reference: reference('RFD', 10), orderId: order.id, paymentId: payment.id, brandId: order.brandId, amountMinor: amount, currency: order.currency,
          reason: input.reason, ticketIds, returnInventory: input.returnInventory ?? true, requestedByType: actor.type, requestedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await this.audit.record({
        actorType: actor.type, actorId: actor.id, actorLabel: actor.label, brandId: order.brandId, action: 'refund.request', entityType: 'refund', entityId: r.id,
        after: { orderReference: order.reference, amountMinor: amount, ticketIds, reason: input.reason },
      }, tx);
      return r;
    });
    return refund;
  }

  /** Approves and immediately processes a refund. Requesters cannot approve their own requests unless explicitly permitted. */
  async approve(refundId: string, approver: { id: string; label: string; canSelfApprove: boolean }): Promise<Refund> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw notFound('Refund');
    if (refund.requestedByType === 'USER' && refund.requestedById === approver.id && !approver.canSelfApprove) {
      throw forbidden('A refund must be approved by someone other than the person who requested it');
    }
    const claimed = await this.prisma.refund.updateMany({ where: { id: refundId, status: 'REQUESTED' }, data: { status: 'APPROVED', approvedById: approver.id, decidedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('REFUND_STATE', `This refund is already ${refund.status.toLowerCase()}`, 409);
    await this.audit.record({ actorType: 'USER', actorId: approver.id, actorLabel: approver.label, brandId: refund.brandId, action: 'refund.approve', entityType: 'refund', entityId: refundId, after: { amountMinor: refund.amountMinor } });
    return this.process(refundId, approver.id);
  }

  async reject(refundId: string, by: { id: string; label: string }, reason: string): Promise<Refund> {
    const claimed = await this.prisma.refund.updateMany({ where: { id: refundId, status: 'REQUESTED' }, data: { status: 'REJECTED', rejectedReason: reason, approvedById: by.id, decidedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('REFUND_STATE', 'Only a requested refund can be rejected', 409);
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    await this.audit.record({ actorType: 'USER', actorId: by.id, actorLabel: by.label, brandId: refund.brandId, action: 'refund.reject', entityType: 'refund', entityId: refundId, after: { reason } });
    return refund;
  }

  /** Puts a failed refund back in the queue after the cause has been fixed. */
  async retry(refundId: string, by: { id: string; label: string }): Promise<Refund> {
    const claimed = await this.prisma.refund.updateMany({ where: { id: refundId, status: 'FAILED' }, data: { status: 'APPROVED', failureReason: null } });
    if (claimed.count !== 1) throw new AppError('REFUND_STATE', 'Only a failed refund can be retried', 409);
    await this.audit.record({ actorType: 'USER', actorId: by.id, actorLabel: by.label, action: 'refund.retry', entityType: 'refund', entityId: refundId });
    return this.process(refundId, by.id);
  }

  /**
   * Sends an approved refund to the original payment provider and, once the provider
   * accepts it, records the result: ledger reversal, ticket revocation, inventory return,
   * promoter payable adjustment and the customer's confirmation email.
   */
  async process(refundId: string, actorId: string | null): Promise<Refund> {
    const claimed = await this.prisma.refund.updateMany({ where: { id: refundId, status: 'APPROVED' }, data: { status: 'PROCESSING' } });
    if (claimed.count !== 1) return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });

    let providerRefundId: string;
    try {
      const account = await this.payments.accountCtx(refund.payment.providerAccountId);
      const result = await this.registry.get(refund.payment.providerCode).refund(account, {
        reference: refund.payment.reference, providerTransactionId: refund.payment.providerTransactionId, amountMinor: refund.amountMinor,
        currency: refund.currency, refundReference: refund.reference, reason: refund.reason,
      });
      providerRefundId = result.providerRefundId;
      await this.prisma.paymentAttempt.create({ data: { paymentId: refund.paymentId, kind: 'REFUND', outcome: 'OK', detail: { refundReference: refund.reference, providerRefundId, providerStatus: result.status } } });
      await this.alerts.integration({ integration: refund.payment.providerCode, direction: 'OUTBOUND', operation: 'refund', status: 'OK', brandId: refund.brandId, reference: refund.reference });
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      await this.prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: error } });
      await this.prisma.paymentAttempt.create({ data: { paymentId: refund.paymentId, kind: 'REFUND', outcome: 'ERROR', detail: { refundReference: refund.reference, error } } });
      await this.alerts.integration({ integration: refund.payment.providerCode, direction: 'OUTBOUND', operation: 'refund', status: 'ERROR', brandId: refund.brandId, reference: refund.reference, error });
      await this.alerts.raise({ type: 'REFUND_FAILED', severity: 'CRITICAL', brandId: refund.brandId, entityType: 'refund', entityId: refundId, message: `Refund ${refund.reference} was refused by ${refund.payment.providerCode}: ${error}` });
      return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    }

    const done = await this.prisma.tx(async (tx) => {
      const order = await this.orders.lock(tx, refund.orderId);
      const full = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { event: true, commissions: true } });
      const orderAlloc = await this.payments.orderAllocation(tx, full);
      const alloc = this.ledger.refundAllocation(orderAlloc, await this.ledger.refundedSoFar(tx, order.id), refund.amountMinor);
      const organizerId = full.event.organizerId;

      await this.ledger.post(tx, {
        type: 'REFUND', description: `Refund ${refund.reference} for order ${order.reference}`, idempotencyKey: `refund:${refund.id}`, currency: refund.currency,
        brandId: order.brandId, legalEntityId: order.legalEntityId, orderId: order.id, paymentId: refund.paymentId, refundId: refund.id, createdBy: actorId,
        lines: this.ledger.refundLines(alloc, organizerId),
      });
      if (organizerId && alloc.promoterMinor > 0n) {
        await tx.promoterPayable.create({
          data: {
            organizerId, eventId: full.eventId, orderId: order.id, brandId: order.brandId, refundId: refund.id, kind: 'REFUND',
            grossMinor: -(alloc.promoterMinor + alloc.platformCommissionMinor + alloc.brandCommissionMinor),
            commissionMinor: -(alloc.platformCommissionMinor + alloc.brandCommissionMinor), amountMinor: -alloc.promoterMinor, currency: refund.currency,
            status: 'AVAILABLE', availableAt: new Date(),
          },
        });
      }

      // Revoke the refunded tickets and, where the event is still on sale, put them back in stock.
      const revoked = await this.tickets.invalidate(tx, refund.ticketIds, 'REFUNDED', `Refund ${refund.reference}`, { type: 'USER', id: actorId });
      const eventOpen = ['PUBLISHED', 'POSTPONED'].includes(full.event.status) && full.event.startsAt > new Date();
      if (refund.returnInventory && eventOpen) {
        const perCategory = new Map<string, number>();
        for (const t of revoked) perCategory.set(t.ticketCategoryId, (perCategory.get(t.ticketCategoryId) ?? 0) + 1);
        for (const [categoryId, qty] of [...perCategory].sort(([a], [b]) => a.localeCompare(b))) {
          await this.inventory.returnSold(tx, categoryId, qty, { orderId: order.id, brandId: order.brandId, actorId });
        }
      }

      const refundedMinor = order.refundedMinor + refund.amountMinor;
      const fully = refundedMinor >= order.totalMinor;
      await this.orders.transition(tx, order, fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED', { type: actorId ? 'USER' : 'SYSTEM', id: actorId }, `Refund ${refund.reference}`, {
        refundedMinor, paymentStatus: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED', needsAttention: fully ? false : undefined,
      }, { amountMinor: Number(refund.amountMinor), ticketsRevoked: revoked.length });
      const updated = await tx.refund.update({ where: { id: refund.id }, data: { status: 'SUCCEEDED', providerRefundId, processedAt: new Date() } });
      await this.audit.record({
        actorType: actorId ? 'USER' : 'SYSTEM', actorId, brandId: order.brandId, action: 'refund.processed', entityType: 'refund', entityId: refund.id,
        after: { amountMinor: refund.amountMinor, providerRefundId, ticketsRevoked: revoked.map((t) => t.reference) },
      }, tx);
      await this.notifications.enqueue({
        brandId: order.brandId, type: 'REFUND_CONFIRMATION', to: order.customerEmail, toName: order.customerName, customerId: order.customerId, orderId: order.id,
        payload: { name: order.customerName, orderReference: order.reference, amount: formatMoney(refund.amountMinor, refund.currency), refundReference: refund.reference, revokedCount: revoked.length || null },
        dedupeKey: `refund-confirmation:${refund.id}`,
      }, tx);
      return updated;
    });
    await this.notifications.kick();
    return done;
  }

  /** Flags brands with an unusual number of refunds in the last hour. */
  async detectUnusualActivity(threshold = Number(process.env.REFUND_ALERT_THRESHOLD ?? 20)) {
    const groups = await this.prisma.refund.groupBy({ by: ['brandId'], where: { requestedAt: { gt: new Date(Date.now() - 3600_000) } }, _count: true });
    for (const g of groups.filter((x) => x._count >= threshold)) {
      await this.alerts.raise({ type: 'UNUSUAL_REFUND_ACTIVITY', severity: 'WARNING', brandId: g.brandId, message: `${g._count} refunds were requested in the last hour`, dedupeKey: `refunds:${g.brandId}:${new Date().toISOString().slice(0, 13)}` });
    }
  }
}
