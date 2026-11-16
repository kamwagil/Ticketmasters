import { Injectable, OnModuleInit } from '@nestjs/common';
import { log } from '../../common/context';
import { AlertService, PrismaService, QueueService, RedisService } from '../../common/infra';
import { formatWhen } from '../../common/util';
import { InventoryService } from '../inventory/inventory.service';
import { CampaignService } from '../marketing/campaign.service';
import { NotificationService } from '../notifications/notification.service';
import { OrderService } from '../orders/order.service';
import { PaymentService } from '../payments/payment.service';
import { RefundService } from '../payments/refund.service';

const DAY = 86400_000;

/**
 * Scheduled housekeeping. Each handler is a BullMQ repeatable job (see schedules.ts), so a
 * tick runs on exactly one worker however many replicas exist. Steps are isolated: one
 * failing step is logged and the rest still run.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private redis: RedisService,
    private alerts: AlertService,
    private orders: OrderService,
    private payments: PaymentService,
    private inventory: InventoryService,
    private refunds: RefundService,
    private campaigns: CampaignService,
    private notifications: NotificationService,
  ) {}

  onModuleInit() {
    this.queue.register('maint-expire-orders', () => this.expireOrders(), 1);
    this.queue.register('maint-payments', () => this.paymentSweeps(), 1);
    this.queue.register('maint-lifecycle', () => this.lifecycle(), 1);
    this.queue.register('maint-health', () => this.healthChecks(), 1);
  }

  private async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await fn();
      if (result && typeof result === 'object' ? Object.values(result).some((v) => typeof v === 'number' && v > 0) : typeof result === 'number' && result > 0) {
        log.info('maintenance_step', { step: name, result: result as unknown as Record<string, unknown> | number });
      }
      return result;
    } catch (e) {
      log.error('maintenance_step_failed', { step: name, error: (e as Error).message });
      return undefined;
    }
  }

  async expireOrders() {
    return this.step('expire_orders', () => this.orders.expireStale());
  }

  async paymentSweeps() {
    await this.step('webhook_sweep', () => this.payments.sweepWebhooks());
    await this.step('pending_payment_sweep', () => this.payments.sweepPendingPayments());
  }

  async lifecycle() {
    const now = new Date();
    await this.step('publish_scheduled_events', async () => {
      const r = await this.prisma.event.updateMany({ where: { status: 'SCHEDULED', publishAt: { lte: now } }, data: { status: 'PUBLISHED', publishAt: null } });
      if (r.count) await this.redis.invalidate('sf:events:');
      return r.count;
    });
    await this.step('complete_past_events', async () => {
      const cut = new Date(now.getTime() - 12 * 3600_000);
      const r = await this.prisma.event.updateMany({
        where: { status: { in: ['PUBLISHED', 'POSTPONED'] }, OR: [{ endsAt: { lt: cut } }, { endsAt: null, startsAt: { lt: cut } }] },
        data: { status: 'COMPLETED' },
      });
      if (r.count) await this.redis.invalidate('sf:events:');
      return r.count;
    });
    await this.step('release_promoter_payables', () =>
      // Payables become available after the hold period, never for a cancelled event (those are refunded instead).
      this.prisma.$executeRaw`
        UPDATE "promoter_payables" p SET "status" = 'AVAILABLE'
          FROM "events" e
         WHERE e."id" = p."eventId" AND p."status" = 'PENDING' AND p."availableAt" <= now() AND e."status" <> 'CANCELLED'`,
    );
    await this.step('dispatch_due_campaigns', () => this.campaigns.dispatchDue());
    await this.step('event_reminders', () => this.sendEventReminders(now));
    await this.step('expire_ticket_transfers', async () => {
      const r = await this.prisma.ticketTransfer.updateMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, data: { status: 'EXPIRED', completedAt: now } });
      return r.count;
    });
  }

  /** One reminder per order about 24 hours before the event, unless the customer switched reminders off for that brand. */
  private async sendEventReminders(now: Date): Promise<number> {
    const events = await this.prisma.event.findMany({
      where: { status: { in: ['PUBLISHED', 'POSTPONED'] }, startsAt: { gt: now, lte: new Date(now.getTime() + DAY) } },
      include: { venue: true },
    });
    let queued = 0;
    for (const event of events) {
      const orders = await this.prisma.order.findMany({
        where: { eventId: event.id, status: { in: ['TICKETS_ISSUED', 'PARTIALLY_REFUNDED'] }, tickets: { some: { status: 'VALID' } } },
        select: { id: true, reference: true, brandId: true, customerId: true, customerEmail: true, customerName: true },
        take: 5000,
      });
      if (!orders.length) continue;
      const already = new Set(
        (await this.prisma.emailJob.findMany({ where: { dedupeKey: { in: orders.map((o) => `reminder:${o.id}`) } }, select: { dedupeKey: true } })).map((j) => j.dedupeKey),
      );
      const pending = orders.filter((o) => !already.has(`reminder:${o.id}`));
      if (!pending.length) continue;
      const optedOut = new Set(
        (await this.prisma.customerPreference.findMany({ where: { key: 'event_reminders', customerId: { in: pending.map((o) => o.customerId) } } }))
          .filter((p) => (p.value as { enabled?: boolean } | null)?.enabled === false)
          .map((p) => `${p.customerId}:${p.brandId}`),
      );
      for (const o of pending) {
        if (optedOut.has(`${o.customerId}:${o.brandId}`)) continue;
        await this.notifications.enqueue({
          // Sent by the brand the customer bought from. Reminders are governed by the customer's
          // event_reminders preference (checked above), not by marketing consent.
          brandId: o.brandId, type: 'EVENT_REMINDER', to: o.customerEmail, toName: o.customerName, orderId: o.id,
          payload: {
            name: o.customerName, orderReference: o.reference,
            event: { name: event.name, when: formatWhen(event.startsAt, event.timezone), venue: event.venue ? `${event.venue.name}, ${event.venue.city}` : '' },
          },
          dedupeKey: `reminder:${o.id}`,
        });
        queued++;
      }
    }
    if (queued) await this.notifications.kick();
    return queued;
  }

  async healthChecks() {
    const hour = new Date().toISOString().slice(0, 13);
    await this.step('inventory_reconcile', async () => (await this.inventory.reconcile()).issues.length);
    await this.step('refund_activity', () => this.refunds.detectUnusualActivity());

    await this.step('queue_backlog', async () => {
      const stats = (await this.queue.stats()) as { queue: string; waiting?: number; failed?: number }[];
      const bad = stats.filter((s) => (s.waiting ?? 0) > 1000 || (s.failed ?? 0) > 50);
      for (const s of bad) {
        await this.alerts.raise({
          type: 'QUEUE_BACKLOG', severity: 'WARNING', message: `Queue "${s.queue}" has ${s.waiting ?? 0} waiting and ${s.failed ?? 0} failed jobs`,
          metadata: { queue: s.queue, waiting: s.waiting ?? 0, failed: s.failed ?? 0 }, dedupeKey: `queue:${s.queue}:${hour}`,
        });
      }
      return bad.length;
    });

    await this.step('ticket_issuance', async () => {
      const stuck = await this.prisma.order.findMany({
        where: { status: 'PAID', needsAttention: false, paidAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        select: { id: true, reference: true, brandId: true }, take: 50,
      });
      for (const o of stuck) {
        await this.alerts.raise({
          type: 'TICKET_ISSUANCE_FAILED', severity: 'CRITICAL', brandId: o.brandId, entityType: 'order', entityId: o.id,
          message: `Order ${o.reference} has been paid for more than 5 minutes but has no tickets issued`, dedupeKey: `issuance:${o.id}`,
        });
      }
      return stuck.length;
    });

    await this.step('email_failures', async () => {
      const failed = await this.prisma.emailJob.count({ where: { status: 'FAILED', createdAt: { gt: new Date(Date.now() - 3600_000) } } });
      if (failed > 20) {
        await this.alerts.raise({ type: 'EMAIL_DELIVERY_FAILURES', severity: 'CRITICAL', message: `${failed} notifications failed permanently in the last hour`, dedupeKey: `emailfail:${hour}` });
      }
      return failed > 20 ? failed : 0;
    });

    await this.step('retention_cleanup', () => this.retention());
  }

  /** Deletes operational data past its retention period. Financial, audit and order records are never touched. */
  private async retention() {
    const now = Date.now();
    const settings = await this.prisma.systemSetting.findMany({ where: { key: { in: ['retention.notificationLogDays', 'retention.webhookPayloadDays'] } } });
    const daysOf = (key: string, fallback: number) => {
      const d = Number((settings.find((s) => s.key === key)?.value as { days?: number } | undefined)?.days);
      return Number.isFinite(d) && d >= 30 ? d : fallback;
    };
    const [idempotency, sessions, tokens, logs, webhooks] = await Promise.all([
      this.prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now - 2 * DAY) } } }),
      this.prisma.session.deleteMany({ where: { OR: [{ revokedAt: { lt: new Date(now - 30 * DAY) } }, { expiresAt: { lt: new Date(now - 30 * DAY) } }] } }),
      this.prisma.customerToken.deleteMany({ where: { OR: [{ usedAt: { lt: new Date(now - 7 * DAY) } }, { expiresAt: { lt: new Date(now - 7 * DAY) } }] } }),
      this.prisma.notificationLog.deleteMany({ where: { createdAt: { lt: new Date(now - daysOf('retention.notificationLogDays', 730) * DAY) } } }),
      this.prisma.paymentWebhookEvent.deleteMany({
        where: { status: { in: ['REJECTED', 'PROCESSED'] }, receivedAt: { lt: new Date(now - daysOf('retention.webhookPayloadDays', 400) * DAY) } },
      }),
    ]);
    return { idempotencyKeys: idempotency.count, sessions: sessions.count, customerTokens: tokens.count, notificationLogs: logs.count, webhookEvents: webhooks.count };
  }
}
