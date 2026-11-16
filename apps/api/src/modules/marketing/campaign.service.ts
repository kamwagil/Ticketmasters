import { Injectable, OnModuleInit } from '@nestjs/common';
import { Campaign, Channel } from '@prisma/client';
import { config } from '../../common/config';
import { log } from '../../common/context';
import { randomToken } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { PrismaService, QueueService } from '../../common/infra';
import { SegmentRules, SegmentService } from '../customers/segments';
import { NotificationService } from '../notifications/notification.service';
import { PAID_STATES } from '../orders/order.service';

const CHUNK = 200;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|tr|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Member {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}

/**
 * Campaign sending. A campaign belongs to exactly one brand, is sent with that brand's
 * identity, and reaches only customers who currently consent to that brand on that channel.
 */
@Injectable()
export class CampaignService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private notifications: NotificationService,
    private segments: SegmentService,
  ) {}

  onModuleInit() {
    this.queue.register('campaign-dispatch', (d) => this.dispatch(d.campaignId), 2);
  }

  /** Personalises the body, wraps links for click tracking and appends the open pixel. */
  renderContent(campaign: Pick<Campaign, 'bodyHtml' | 'channel'>, firstName: string, trackingToken: string | null): string {
    const named = campaign.bodyHtml.replace(/\{\{\s*name\s*\}\}/g, esc(firstName));
    if (campaign.channel !== 'EMAIL') return htmlToText(named);
    if (!trackingToken) return named;
    const tracked = named.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (_m, quote: string, url: string) => {
      const original = url.replace(/&amp;/g, '&');
      return `href=${quote}${config.apiPublicUrl}/v1/public/c/${trackingToken}?u=${encodeURIComponent(original)}${quote}`;
    });
    return `${tracked}<img src="${config.apiPublicUrl}/v1/public/o/${trackingToken}.gif" width="1" height="1" alt="" style="display:none;border:0;">`;
  }

  payload(campaign: Pick<Campaign, 'bodyHtml' | 'channel' | 'subject' | 'name'>, firstName: string, trackingToken: string | null, subjectPrefix = '') {
    const content = this.renderContent(campaign, firstName, trackingToken);
    if (campaign.channel !== 'EMAIL') return { subject: `${subjectPrefix}${content}`, content };
    return {
      subject: `${subjectPrefix}${campaign.subject ?? campaign.name}`,
      content,
      unsubscribeUrl: trackingToken ? `${config.apiPublicUrl}/v1/public/unsubscribe/${trackingToken}` : undefined,
    };
  }

  /** Queues a campaign for sending by the background workers. */
  async enqueueDispatch(campaignId: string) {
    await this.queue.add('campaign-dispatch', { campaignId }, { jobId: `campaign-${campaignId}-${Date.now()}`, attempts: 3 });
  }

  /** Called by the lifecycle job: starts scheduled campaigns that are due and resumes interrupted sends. */
  async dispatchDue(): Promise<number> {
    const due = await this.prisma.campaign.findMany({
      where: {
        OR: [
          { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
          { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
        ],
      },
      select: { id: true },
      take: 50,
    });
    for (const c of due) await this.enqueueDispatch(c.id);
    return due.length;
  }

  /** Current consent for many customers at once (latest row per customer wins). */
  private async consenting(customerIds: string[], brandId: string, channel: Channel): Promise<Set<string>> {
    const rows = await this.prisma.marketingConsent.findMany({
      where: { customerId: { in: customerIds }, brandId, channel },
      orderBy: { createdAt: 'desc' },
      select: { customerId: true, status: true },
    });
    const seen = new Set<string>();
    const granted = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.customerId)) continue;
      seen.add(r.customerId);
      if (r.status === 'GRANTED') granted.add(r.customerId);
    }
    return granted;
  }

  /**
   * Sends a campaign. Only one caller can claim it; if a worker dies mid-send the campaign
   * stays in SENDING and a later run resumes it without sending anything twice (deliveries
   * and outbox rows are both unique per campaign and customer).
   */
  async dispatch(campaignId: string): Promise<{ audience: number; queued: number; skipped: number } | null> {
    const claimed = await this.prisma.campaign.updateMany({ where: { id: campaignId, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'SENDING' } });
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, include: { audiences: true } });
    if (!campaign) throw notFound('Campaign');
    if (claimed.count !== 1 && campaign.status !== 'SENDING') return null;

    const segmentRows = await this.prisma.customerSegment.findMany({ where: { id: { in: campaign.audiences.map((a) => a.segmentId) } } });
    const audience = new Map<string, Member>();
    for (const s of segmentRows) {
      // Defence in depth: a segment of another brand can never feed this campaign.
      if (s.brandId !== campaign.brandId) {
        log.error('campaign_cross_brand_segment_ignored', { campaignId, segmentId: s.id });
        continue;
      }
      for (const m of await this.segments.members(campaign.brandId, s.rules as unknown as SegmentRules)) audience.set(m.id, m);
    }

    const members = [...audience.values()];
    let queued = 0;
    let skipped = 0;
    for (let i = 0; i < members.length; i += CHUNK) {
      const chunk = members.slice(i, i + CHUNK);
      const granted = await this.consenting(chunk.map((m) => m.id), campaign.brandId, campaign.channel);
      await this.prisma.campaignDelivery.createMany({
        data: chunk.map((m) => {
          const address = campaign.channel === 'EMAIL' ? m.email : m.phone;
          const reason = !granted.has(m.id) ? 'NO_CONSENT' : !address ? 'NO_ADDRESS' : null;
          return {
            campaignId, customerId: m.id, toAddress: address ?? '', trackingToken: randomToken(24),
            status: reason ? ('SKIPPED' as const) : ('QUEUED' as const), skippedReason: reason,
          };
        }),
        skipDuplicates: true,
      });
      const deliveries = await this.prisma.campaignDelivery.findMany({ where: { campaignId, customerId: { in: chunk.map((m) => m.id) } } });
      for (const d of deliveries) {
        if (d.status === 'SKIPPED') {
          skipped++;
          continue;
        }
        if (d.status !== 'QUEUED') continue; // already handed over on an earlier run
        const m = audience.get(d.customerId)!;
        const firstName = (m.fullName || '').trim().split(/\s+/)[0] || 'there';
        await this.notifications.enqueue({
          brandId: campaign.brandId, type: 'MARKETING', channel: campaign.channel, to: d.toAddress, toName: m.fullName, customerId: m.id,
          campaignId, payload: this.payload(campaign, firstName, d.trackingToken), dedupeKey: `campaign:${campaignId}:${m.id}`,
        });
        queued++;
      }
    }

    await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', sentAt: new Date() } });
    await this.notifications.kick();
    log.info('campaign_dispatched', { campaignId, audience: members.length, queued, skipped });
    return { audience: members.length, queued, skipped };
  }

  /** Sends one rendered copy to a staff-supplied address. Not counted in campaign statistics. */
  async sendTest(campaign: Campaign, to: string, staffName: string) {
    if (campaign.channel !== 'EMAIL' && !/^\+?\d{7,15}$/.test(to)) throw new AppError('ADDRESS_INVALID', 'Enter a phone number in international format', 400);
    const firstName = staffName.trim().split(/\s+/)[0] || 'there';
    await this.notifications.enqueue({
      brandId: campaign.brandId, type: 'MARKETING', channel: campaign.channel, to, toName: staffName,
      payload: this.payload(campaign, firstName, null, '[TEST] '),
    });
    await this.notifications.kick();
  }

  /** Delivery, engagement and conversion metrics for a set of campaigns. Revenue is per currency. */
  async performance(campaignIds: string[]) {
    if (!campaignIds.length) return new Map<string, ReturnType<CampaignService['emptyStats']>>();
    const [byStatus, byReason, engagement, conversions] = await Promise.all([
      this.prisma.campaignDelivery.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: campaignIds } }, _count: true }),
      this.prisma.campaignDelivery.groupBy({ by: ['campaignId', 'skippedReason'], where: { campaignId: { in: campaignIds }, status: 'SKIPPED' }, _count: true }),
      this.prisma.$queryRaw<{ campaignId: string; opens: number; clicks: number; totalClicks: number; unsubscribes: number }[]>`
        SELECT "campaignId", COUNT("openedAt")::int AS opens, COUNT("clickedAt")::int AS clicks,
               COALESCE(SUM("clickCount"), 0)::int AS "totalClicks", COUNT("unsubscribedAt")::int AS unsubscribes
          FROM "campaign_deliveries" WHERE "campaignId" = ANY(${campaignIds}::uuid[]) GROUP BY "campaignId"`,
      this.prisma.order.groupBy({
        by: ['campaignId', 'currency'], where: { campaignId: { in: campaignIds }, status: { in: PAID_STATES } },
        _count: true, _sum: { totalMinor: true, refundedMinor: true },
      }),
    ]);
    const out = new Map<string, ReturnType<CampaignService['emptyStats']>>();
    for (const id of campaignIds) out.set(id, this.emptyStats());
    for (const r of byStatus) {
      const s = out.get(r.campaignId)!;
      s.audience += r._count;
      if (r.status === 'SENT' || r.status === 'DELIVERED') s.sent += r._count;
      if (r.status === 'DELIVERED') s.delivered += r._count;
      if (r.status === 'FAILED' || r.status === 'BOUNCED') s.failed += r._count;
      if (r.status === 'QUEUED' || r.status === 'SENDING') s.pending += r._count;
      if (r.status === 'SKIPPED') s.skipped += r._count;
    }
    for (const r of byReason) out.get(r.campaignId)!.skippedByReason[r.skippedReason ?? 'OTHER'] = r._count;
    for (const r of engagement) Object.assign(out.get(r.campaignId)!, { opens: r.opens, clicks: r.clicks, totalClicks: r.totalClicks, unsubscribes: r.unsubscribes });
    for (const r of conversions) {
      const s = out.get(r.campaignId!)!;
      s.conversions += r._count;
      s.revenueByCurrency.push({ currency: r.currency, orders: r._count, revenueMinor: (r._sum.totalMinor ?? 0n) - (r._sum.refundedMinor ?? 0n) });
    }
    for (const s of out.values()) {
      s.openRate = s.sent ? s.opens / s.sent : 0;
      s.clickRate = s.sent ? s.clicks / s.sent : 0;
      s.conversionRate = s.sent ? s.conversions / s.sent : 0;
    }
    return out;
  }

  emptyStats() {
    return {
      audience: 0, sent: 0, delivered: 0, failed: 0, pending: 0, skipped: 0, skippedByReason: {} as Record<string, number>,
      opens: 0, clicks: 0, totalClicks: 0, unsubscribes: 0, conversions: 0,
      revenueByCurrency: [] as { currency: string; orders: number; revenueMinor: bigint }[],
      openRate: 0, clickRate: 0, conversionRate: 0,
    };
  }
}
