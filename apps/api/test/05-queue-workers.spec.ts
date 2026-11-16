import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../src/common/config';
import { PrismaService, QueueService } from '../src/common/infra';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { buildFixture, checkout, createApp, deliverWebhook, Fixture, gatewayWebhook, resetDb } from './helpers';

/**
 * The other suites run jobs in-process. This one switches the same application to the
 * production queue mode (BullMQ on Redis) to prove that webhooks, ticket issuance and email
 * delivery really flow through background workers.
 */
describe('Background workers on Redis (BullMQ)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;

  const waitFor = async <T>(fn: () => Promise<T | null | false>, ms = 20_000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error('Timed out waiting for background processing');
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  beforeAll(async () => {
    // Never share queues with a dev server that may be running against the same Redis.
    (config as { queuePrefix: string }).queuePrefix = `ctp-test-${randomUUID().slice(0, 8)}`;
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
    const queue = app.get(QueueService);
    queue.inline = false;
    await queue.start([{ queue: 'notification-sweep', everyMs: 1000 }]);
  });
  afterAll(() => app.close());

  it('registers a worker for every queue the platform uses', async () => {
    const queues = (await app.get(QueueService).stats()).map((s) => s.queue).sort();
    expect(queues).toEqual(
      expect.arrayContaining([
        'payment-webhook', 'notification-deliver', 'notification-sweep', 'campaign-dispatch',
        'maint-expire-orders', 'maint-payments', 'maint-lifecycle', 'maint-health',
      ]),
    );
  });

  it('processes a payment webhook, issues tickets and sends branded emails through the queue', async () => {
    const c = await checkout(app, fx.brands[0], fx, { email: 'queued@example.com', quantity: 2 });
    expect(c.status).toBe(201);
    const wh = await gatewayWebhook(app, c.body.payment.reference, 'success');
    const res = await deliverWebhook(app, wh);
    expect(res.status).toBe(200); // acknowledged immediately; the work happens on a worker

    const order = await waitFor(() => prisma.order.findFirst({ where: { reference: c.body.orderReference, status: 'TICKETS_ISSUED' } }));
    expect(await prisma.ticket.count({ where: { orderId: order.id, status: 'VALID' } })).toBe(2);
    const event = await waitFor(() => prisma.paymentWebhookEvent.findFirst({ where: { reference: c.body.payment.reference, status: 'PROCESSED' } }));
    expect(event.signatureValid).toBe(true);

    // Duplicate deliveries while workers are running still result in one set of tickets.
    await Promise.all([deliverWebhook(app, wh), deliverWebhook(app, wh), deliverWebhook(app, wh)]);
    await waitFor(async () => (await prisma.emailJob.count({ where: { orderId: order.id, status: 'SENT' } })) === 2);
    expect(await prisma.ticket.count({ where: { orderId: order.id } })).toBe(2);
    expect(await prisma.ledgerTransaction.count({ where: { orderId: order.id, type: 'PAYMENT_CAPTURE' } })).toBe(1);
    const logs = await prisma.notificationLog.findMany({ where: { brandId: fx.brands[0].id, event: 'SENT' } });
    expect(logs.map((l) => l.type).sort()).toEqual(['ORDER_CONFIRMATION', 'TICKET_DELIVERY']);
  });

  it('a failed email never affects the paid order, and is retried from the outbox', async () => {
    const c = await checkout(app, fx.brands[1], fx, { email: 'smtp-down@example.com' });
    // Simulate the email provider being down.
    const notifications = app.get(NotificationService) as unknown as { sendEmail: (...a: unknown[]) => Promise<unknown> };
    const original = notifications.sendEmail;
    let failures = 0;
    notifications.sendEmail = async () => {
      failures++;
      throw new Error('SMTP connection refused');
    };
    await deliverWebhook(app, await gatewayWebhook(app, c.body.payment.reference, 'success'));
    const order = await waitFor(() => prisma.order.findFirst({ where: { reference: c.body.orderReference, status: 'TICKETS_ISSUED' } }));
    await waitFor(async () => failures >= 2);
    await waitFor(async () => (await prisma.notificationLog.count({ where: { brandId: fx.brands[1].id, event: 'FAILED' } })) === 2);

    // The customer was charged once and has their ticket, whatever happens to the email.
    expect(await prisma.payment.count({ where: { orderId: order.id, status: 'SUCCEEDED' } })).toBe(1);
    expect(await prisma.ticket.count({ where: { orderId: order.id, status: 'VALID' } })).toBe(1);
    const jobs = await prisma.emailJob.findMany({ where: { orderId: order.id } });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === 'QUEUED' && j.attempts === 1 && j.lastError === 'SMTP connection refused' && j.nextAttemptAt > new Date())).toBe(true);

    // Provider recovers: the retry (made due now) is delivered by the scheduled sweep.
    notifications.sendEmail = original;
    await prisma.emailJob.updateMany({ where: { orderId: order.id }, data: { nextAttemptAt: new Date() } });
    await waitFor(async () => (await prisma.emailJob.count({ where: { orderId: order.id, status: 'SENT' } })) === 2);
  });
});
