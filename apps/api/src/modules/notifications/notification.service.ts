import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Channel, Prisma } from '@prisma/client';
import Handlebars from 'handlebars';
import * as nodemailer from 'nodemailer';
import { config } from '../../common/config';
import { log } from '../../common/context';
import { AlertService, PrismaService, QueueService, Tx } from '../../common/infra';
import { TicketDocumentService } from '../tickets/ticket-document.service';
import { DEFAULT_TEMPLATES, LAYOUT, NotificationType, TRANSACTIONAL_TYPES } from './templates';

export interface NotificationInput {
  brandId: string;
  type: NotificationType;
  to: string;
  toName?: string | null;
  channel?: Channel;
  customerId?: string | null;
  orderId?: string | null;
  campaignId?: string | null;
  payload: Record<string, unknown>;
  attachTickets?: boolean;
  /** Guarantees a logical notification is queued once, however often the caller retries. */
  dedupeKey?: string;
}

const BACKOFF_SEC = [30, 120, 600, 1800, 7200, 21600];
const layoutTpl = Handlebars.compile(LAYOUT);
const cache = new Map<string, Handlebars.TemplateDelegate>();
const compile = (src: string) => {
  let t = cache.get(src);
  if (!t) {
    t = Handlebars.compile(src);
    if (cache.size > 500) cache.clear();
    cache.set(src, t);
  }
  return t;
};

interface SendResult {
  messageId?: string;
  skipped?: string;
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private transport?: nodemailer.Transporter;

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private alerts: AlertService,
    private docs: TicketDocumentService,
  ) {}

  onModuleInit() {
    this.queue.register('notification-deliver', (d) => this.deliver(d.jobId), 10);
    this.queue.register('notification-sweep', () => this.sweep(), 1);
  }

  onModuleDestroy() {
    this.transport?.close();
  }

  /**
   * Writes a notification to the outbox. Pass the business transaction so the notification
   * exists if and only if the change committed; delivery then happens asynchronously and can
   * never delay or roll back checkout or ticket issuance.
   */
  async enqueue(input: NotificationInput, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).emailJob.createMany({
      data: [{
        brandId: input.brandId,
        channel: input.channel ?? 'EMAIL',
        type: input.type,
        toAddress: input.to,
        toName: input.toName ?? null,
        customerId: input.customerId ?? null,
        orderId: input.orderId ?? null,
        campaignId: input.campaignId ?? null,
        payload: JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue,
        attachTickets: input.attachTickets ?? false,
        dedupeKey: input.dedupeKey ?? null,
      }],
      skipDuplicates: true,
    });
  }

  private sweeping: Promise<unknown> | null = null;
  private sweepAgain = false;

  /** Call after the transaction commits to start delivery immediately instead of waiting for the sweep. */
  async kick(): Promise<void> {
    if (this.queue.inline) {
      // In-process mode: deliver in the background, one sweep at a time, never on the request path.
      if (this.sweeping) {
        this.sweepAgain = true;
        return;
      }
      this.sweeping = (async () => {
        do {
          this.sweepAgain = false;
          await this.sweep().catch((e) => log.error('notification_sweep_failed', { error: (e as Error).message }));
        } while (this.sweepAgain);
        this.sweeping = null;
      })();
      return;
    }
    try {
      await this.queue.add('notification-sweep', {});
    } catch (e) {
      log.warn('notification_kick_failed', { error: (e as Error).message }); // the scheduled sweep will pick the jobs up
    }
  }

  /** Waits until every due notification has been attempted (used by tests and graceful shutdown). */
  async drain(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.sweeping) await this.sweeping;
      if ((await this.sweep()) === 0 && !this.sweeping) return;
    }
  }

  /** Hands due outbox rows to the delivery workers and recovers rows stuck in SENDING. */
  async sweep(): Promise<number> {
    await this.prisma.emailJob.updateMany({
      where: { status: 'SENDING', nextAttemptAt: { lt: new Date(Date.now() - 10 * 60_000) } },
      data: { status: 'QUEUED' },
    });
    const due = await this.prisma.emailJob.findMany({
      where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } },
      select: { id: true, attempts: true, nextAttemptAt: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: 500,
    });
    for (const j of due) {
      // The queue job id changes with every retry, so a finished job never blocks the next attempt.
      await this.queue.add('notification-deliver', { jobId: j.id }, { jobId: `${j.id}-${j.attempts}-${j.nextAttemptAt.getTime()}`, attempts: 1 });
    }
    return due.length;
  }

  async deliver(jobId: string): Promise<void> {
    // Claim the row so concurrent workers never send the same notification twice.
    const claimed = await this.prisma.emailJob.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: { status: 'SENDING', nextAttemptAt: new Date() },
    });
    if (claimed.count !== 1) return;
    const job = await this.prisma.emailJob.findUniqueOrThrow({ where: { id: jobId } });
    const logBase = { jobId: job.id, brandId: job.brandId, customerId: job.customerId, channel: job.channel, type: job.type, toAddress: job.toAddress };

    try {
      const rendered = await this.render(job.brandId, job.type, job.channel, job.payload as Record<string, unknown>);
      let result: SendResult;

      // Marketing is re-checked against consent at send time: a withdrawal after scheduling still wins.
      if (!TRANSACTIONAL_TYPES.has(job.type) && job.customerId && !(await this.hasConsent(job.customerId, job.brandId, job.channel))) {
        result = { skipped: 'No marketing consent for this brand and channel' };
      } else if (job.channel === 'EMAIL') {
        const attachments = job.attachTickets && job.orderId ? await this.docs.renderOrderTickets(job.orderId) : [];
        result = await this.sendEmail(rendered.from, job.toName ? `"${job.toName.replace(/"/g, '')}" <${job.toAddress}>` : job.toAddress, rendered, attachments);
      } else if (job.channel === 'SMS') {
        result = await this.sendSms(job.toAddress, rendered.text);
      } else {
        result = await this.sendWhatsApp(job.toAddress, rendered.text);
      }

      if (result.skipped) {
        await this.prisma.emailJob.update({ where: { id: job.id }, data: { status: 'SKIPPED', lastError: result.skipped } });
        await this.prisma.notificationLog.create({ data: { ...logBase, subject: rendered.subject, event: 'SKIPPED', detail: result.skipped } });
        await this.syncCampaignDelivery(job.campaignId, job.customerId, 'SKIPPED', result.skipped);
        return;
      }
      await this.prisma.emailJob.update({
        where: { id: job.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: job.attempts + 1, providerMessageId: result.messageId, lastError: null },
      });
      await this.prisma.notificationLog.create({ data: { ...logBase, subject: rendered.subject, event: 'SENT', detail: result.messageId } });
      await this.syncCampaignDelivery(job.campaignId, job.customerId, 'SENT');
    } catch (e) {
      const attempts = job.attempts + 1;
      const error = (e as Error).message.slice(0, 500);
      const exhausted = attempts >= job.maxAttempts;
      await this.prisma.emailJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? 'FAILED' : 'QUEUED',
          attempts,
          lastError: error,
          nextAttemptAt: new Date(Date.now() + BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)] * 1000),
        },
      });
      await this.prisma.notificationLog.create({ data: { ...logBase, event: 'FAILED', detail: `attempt ${attempts}: ${error}` } });
      await this.alerts.integration({ integration: job.channel === 'EMAIL' ? 'smtp' : job.channel.toLowerCase(), direction: 'OUTBOUND', operation: job.type, status: 'ERROR', brandId: job.brandId, reference: job.id, error });
      if (exhausted) {
        await this.syncCampaignDelivery(job.campaignId, job.customerId, 'FAILED', error);
        await this.alerts.raise({
          type: 'NOTIFICATION_FAILED', severity: 'WARNING', brandId: job.brandId, entityType: 'email_job', entityId: job.id,
          message: `${job.type} to ${job.toAddress} failed permanently after ${attempts} attempts: ${error}`,
        });
      }
    }
  }

  private async syncCampaignDelivery(campaignId: string | null, customerId: string | null, status: 'SENT' | 'FAILED' | 'SKIPPED', reason?: string) {
    if (!campaignId || !customerId) return;
    await this.prisma.campaignDelivery.updateMany({
      where: { campaignId, customerId },
      data: { status, sentAt: status === 'SENT' ? new Date() : undefined, skippedReason: reason },
    });
  }

  /** Latest consent row per (customer, brand, channel) decides. Consent never crosses brands. */
  async hasConsent(customerId: string, brandId: string, channel: Channel): Promise<boolean> {
    const latest = await this.prisma.marketingConsent.findFirst({ where: { customerId, brandId, channel }, orderBy: { createdAt: 'desc' } });
    return latest?.status === 'GRANTED';
  }

  /** Renders a notification with the originating brand's identity. */
  async render(brandId: string, type: string, channel: Channel, payload: Record<string, unknown>) {
    const brand = await this.prisma.brand.findUniqueOrThrow({ where: { id: brandId }, include: { domains: { where: { isPrimary: true } } } });
    const override = await this.prisma.brandEmailTemplate.findFirst({ where: { brandId, type, channel, active: true } });
    const platform = override ? null : await this.prisma.emailTemplate.findFirst({ where: { type, channel } });
    const fallback = DEFAULT_TEMPLATES[type as NotificationType];
    const tpl = override ?? platform ?? (fallback ? { subject: fallback.subject, bodyHtml: fallback.bodyHtml, bodyText: fallback.sms ?? null } : null);
    if (!tpl) throw new Error(`No template for notification type ${type}`);

    const domain = brand.domains[0]?.domain ?? '';
    const siteUrl = domain ? `${/^(localhost|[\w-]+\.localhost)(:\d+)?$/.test(domain) ? 'http' : 'https'}://${domain}` : '';
    const ctx = {
      ...payload,
      brand: {
        name: brand.name, logoUrl: brand.logoUrl, primaryColor: brand.primaryColor, secondaryColor: brand.secondaryColor,
        contactEmail: brand.contactEmail, supportPhone: brand.supportPhone, supportUrl: brand.supportUrl,
        businessAddress: brand.businessAddress, siteUrl,
      },
    };
    const subject = compile(tpl.subject)(ctx);
    const body = compile(tpl.bodyHtml)(ctx);
    const html = layoutTpl({ ...ctx, subject, body });
    const smsSrc = (tpl as { bodyText?: string | null }).bodyText ?? fallback?.sms;
    const text = channel === 'EMAIL'
      ? body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h\d|tr|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;|&middot;|&times;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
      : compile(smsSrc ?? tpl.subject)(ctx);
    return {
      subject, html, text,
      from: `"${brand.emailSenderName.replace(/"/g, '')}" <${brand.emailSenderAddr}>`,
      replyTo: brand.contactEmail,
      unsubscribeUrl: payload.unsubscribeUrl as string | undefined,
      templateSource: override ? 'brand' : platform ? 'platform' : 'builtin',
    };
  }

  private mailer(): nodemailer.Transporter {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        pool: true,
        maxConnections: 5,
        connectionTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return this.transport;
  }

  private async sendEmail(
    from: string, to: string,
    r: { subject: string; html: string; text: string; replyTo: string; unsubscribeUrl?: string },
    attachments: { filename: string; content: Buffer }[],
  ): Promise<SendResult> {
    const info = await this.mailer().sendMail({
      from, to, replyTo: r.replyTo, subject: r.subject, html: r.html, text: r.text,
      attachments: attachments.map((a) => ({ ...a, contentType: 'application/pdf' })),
      headers: r.unsubscribeUrl ? { 'List-Unsubscribe': `<${r.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    });
    return { messageId: info.messageId };
  }

  /** SMS through Africa's Talking. Without credentials the message is recorded as SKIPPED, never as sent. */
  private async sendSms(to: string, message: string): Promise<SendResult> {
    const { username, apiKey, senderId } = config.sms;
    if (!username || !apiKey) return { skipped: 'SMS provider not configured (AT_USERNAME / AT_API_KEY)' };
    const body = new URLSearchParams({ username, to, message });
    if (senderId) body.set('from', senderId);
    const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    const recipient = json?.SMSMessageData?.Recipients?.[0];
    if (!res.ok || !recipient || !/success/i.test(recipient.status ?? '')) {
      throw new Error(`SMS rejected: ${recipient?.status ?? json?.SMSMessageData?.Message ?? res.status}`);
    }
    return { messageId: recipient.messageId };
  }

  /** WhatsApp through the Meta WhatsApp Cloud API. Requires an approved business number. */
  private async sendWhatsApp(to: string, message: string): Promise<SendResult> {
    const { phoneNumberId, accessToken } = config.whatsapp;
    if (!phoneNumberId || !accessToken) return { skipped: 'WhatsApp provider not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN)' };
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { body: message } }),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp rejected: ${json?.error?.message ?? res.status}`);
    return { messageId: json?.messages?.[0]?.id };
  }

  async smtpHealth(): Promise<boolean> {
    try {
      await this.mailer().verify();
      return true;
    } catch {
      return false;
    }
  }
}
