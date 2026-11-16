import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { log } from '../../common/context';
import { AppError } from '../../common/errors';
import { PrismaService, Tx } from '../../common/infra';
import { InventoryService } from '../inventory/inventory.service';

export interface Actor {
  type: 'SYSTEM' | 'USER' | 'CUSTOMER' | 'GATEWAY';
  id?: string | null;
}

/**
 * Allowed order transitions. Terminal unpaid states can still move to PAID because a
 * verified payment may legitimately arrive after a reservation expired; the payment
 * service then either allocates stock or flags the order for refund.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['RESERVED', 'FAILED', 'CANCELLED'],
  RESERVED: ['AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED'],
  AWAITING_PAYMENT: ['PAYMENT_PROCESSING', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED', 'AWAITING_PAYMENT'],
  PAYMENT_PROCESSING: ['PAID', 'FAILED', 'AWAITING_PAYMENT', 'EXPIRED'],
  PAID: ['TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  TICKETS_ISSUED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  REFUNDED: [],
  CANCELLED: ['PAID'],
  EXPIRED: ['PAID'],
  FAILED: ['PAID', 'AWAITING_PAYMENT'],
};

export const UNPAID_OPEN: OrderStatus[] = ['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING'];
export const PAID_STATES: OrderStatus[] = ['PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

@Injectable()
export class OrderService {
  constructor(private prisma: PrismaService, private inventory: InventoryService) {}

  /** Row-locks the order for the rest of the transaction. All money and ticket changes take this lock first. */
  async lock(tx: Tx, orderId: string): Promise<Order> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    if (!rows.length) throw new AppError('NOT_FOUND', 'Order not found', 404);
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  }

  /** Changes status and appends to the order's permanent history. */
  async transition(
    tx: Tx, order: Pick<Order, 'id' | 'status'>, to: OrderStatus, actor: Actor, reason?: string,
    extra: Prisma.OrderUncheckedUpdateInput & { paymentStatus?: PaymentStatus } = {}, metadata?: Prisma.InputJsonValue,
  ): Promise<Order> {
    if (!TRANSITIONS[order.status].includes(to)) {
      throw new AppError('INVALID_ORDER_TRANSITION', `An order cannot move from ${order.status} to ${to}`, 409);
    }
    const updated = await tx.order.update({ where: { id: order.id }, data: { ...extra, status: to } });
    await tx.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: order.status, toStatus: to, reason, actorType: actor.type, actorId: actor.id ?? null, metadata },
    });
    return updated;
  }

  /**
   * Closes an unpaid order and returns its held tickets (and promo redemption) to the pool.
   * @returns the updated order, or null if the order was no longer open.
   */
  async close(tx: Tx, orderId: string, to: 'CANCELLED' | 'EXPIRED' | 'FAILED', actor: Actor, reason: string): Promise<Order | null> {
    const order = await this.lock(tx, orderId);
    if (!UNPAID_OPEN.includes(order.status)) return null;
    await this.inventory.release(tx, order.id, order.brandId, to === 'EXPIRED' ? 'EXPIRE' : 'RELEASE');
    if (order.promoCodeId) {
      await tx.$executeRaw`UPDATE "promo_codes" SET "redeemedCount" = GREATEST("redeemedCount" - 1, 0) WHERE "id" = ${order.promoCodeId}::uuid`;
    }
    await tx.payment.updateMany({ where: { orderId, status: { in: ['INITIATED', 'PENDING'] } }, data: { status: to === 'FAILED' ? 'FAILED' : 'CANCELLED', failureReason: reason } });
    return this.transition(tx, order, to, actor, reason, {
      paymentStatus: to === 'FAILED' ? 'FAILED' : 'UNPAID',
      cancelledAt: to === 'CANCELLED' ? new Date() : undefined,
      reservationExpiresAt: null,
    });
  }

  /**
   * Expires checkouts whose reservation window has passed, releasing their tickets back to
   * every storefront. Orders whose payment is being confirmed get a grace period.
   */
  async expireStale(batch = 200): Promise<number> {
    const now = new Date();
    const stale = await this.prisma.order.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'RESERVED', 'AWAITING_PAYMENT'] }, reservationExpiresAt: { lt: now } },
          { status: 'PAYMENT_PROCESSING', reservationExpiresAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
        ],
      },
      select: { id: true },
      orderBy: { reservationExpiresAt: 'asc' },
      take: batch,
    });
    let expired = 0;
    for (const o of stale) {
      try {
        const r = await this.prisma.tx((tx) => this.close(tx, o.id, 'EXPIRED', { type: 'SYSTEM' }, 'Reservation window elapsed without payment'));
        if (r) expired++;
      } catch (e) {
        log.error('order_expire_failed', { orderId: o.id, error: (e as Error).message });
      }
    }
    return expired;
  }
}
