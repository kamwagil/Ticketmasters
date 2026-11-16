import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Channel } from '@prisma/client';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { promises as dns } from 'dns';
import Handlebars from 'handlebars';
import { assertBrandAccess, assertPlatformWide, brandWhere, CurrentStaff, Permissions, Staff, StaffGuard } from '../../common/auth';
import { AppError, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { dateRange, paged, PageQuery, paging } from '../../common/util';
import { NotificationService } from './notification.service';
import { DEFAULT_TEMPLATES, NOTIFICATION_TYPES, NotificationType } from './templates';

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
const STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED', 'SKIPPED'] as const;

class TemplateDto {
  @IsString() @MinLength(1) @MaxLength(300) subject: string;
  @IsString() @MinLength(1) @MaxLength(200_000) bodyHtml: string;
  @IsOptional() @IsString() @MaxLength(2000) bodyText?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class PreviewDto {
  @IsUUID() brandId: string;
  @IsIn(NOTIFICATION_TYPES as unknown as string[]) type: NotificationType;
  @IsIn(CHANNELS as unknown as string[]) channel: Channel;
  /** Template variables. Realistic sample values are used for anything omitted. */
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
class TemplateQuery {
  @IsOptional() @IsUUID() brandId?: string;
}
class JobQuery extends PageQuery {
  @IsOptional() @IsIn(STATUSES as unknown as string[]) status?: (typeof STATUSES)[number];
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsIn(CHANNELS as unknown as string[]) channel?: Channel;
}

const sampleEvent = { name: 'Nairobi Highlife Festival', when: 'Saturday, 12 December 2026 at 14:00', venue: 'Carnivore Grounds, Nairobi' };
const SAMPLES: Record<NotificationType, Record<string, unknown>> = {
  REGISTRATION_CONFIRMATION: { name: 'Asha Mwende' },
  EMAIL_VERIFICATION: { name: 'Asha Mwende', verifyUrl: 'https://example.com/verify?token=sample' },
  PASSWORD_RESET: { name: 'Asha Mwende', resetUrl: 'https://example.com/reset?token=sample' },
  ORDER_CONFIRMATION: {
    name: 'Asha Mwende', email: 'asha@example.com', orderReference: 'ORD-7K2M9QXA4T', event: sampleEvent,
    items: [{ name: 'General Admission', quantity: 2, total: 'KES 6,000.00' }], fees: 'KES 240.00', tax: null, discount: null, total: 'KES 6,240.00',
    seller: 'Sample Seller Limited', policy: { terms: 1, refund: 1, privacy: 1 }, orderUrl: 'https://example.com/orders/ORD-7K2M9QXA4T',
  },
  PAYMENT_CONFIRMATION: { name: 'Asha Mwende', orderReference: 'ORD-7K2M9QXA4T', total: 'KES 6,240.00', paymentReference: 'PAY-SAMPLE00000000', paidAt: 'Monday, 16 November 2026 at 10:15' },
  TICKET_DELIVERY: { name: 'Asha Mwende', email: 'asha@example.com', orderReference: 'ORD-7K2M9QXA4T', ticketCount: 2, event: sampleEvent, orderUrl: 'https://example.com/orders/ORD-7K2M9QXA4T' },
  EVENT_REMINDER: { name: 'Asha Mwende', orderReference: 'ORD-7K2M9QXA4T', event: sampleEvent, orderUrl: 'https://example.com/orders/ORD-7K2M9QXA4T' },
  EVENT_POSTPONEMENT: { name: 'Asha Mwende', orderReference: 'ORD-7K2M9QXA4T', event: sampleEvent },
  EVENT_CANCELLATION: { name: 'Asha Mwende', orderReference: 'ORD-7K2M9QXA4T', event: sampleEvent, reason: 'The venue is unavailable on the planned date.' },
  REFUND_CONFIRMATION: { name: 'Asha Mwende', orderReference: 'ORD-7K2M9QXA4T', amount: 'KES 6,240.00', refundReference: 'RFD-SAMPLE0001', revokedCount: 2 },
  TICKET_TRANSFER: { fromName: 'Asha Mwende', event: sampleEvent, claimUrl: 'https://example.com/transfers/claim?token=sample', expiresAt: 'Friday, 11 December 2026 at 14:00' },
  SELLER_NOTIFICATION: { title: 'Your payout has been approved', message: 'Payout PYT-SAMPLE0001 of KES 190,000.00 has been approved and will be paid to your settlement account.' },
  SUPPORT_UPDATE: { name: 'Asha Mwende', ticketReference: 'SUP-SAMPLE0001', ticketSubject: 'Tickets not received', message: 'We have re-sent your tickets to asha@example.com. Please check your inbox and spam folder.' },
  MARKETING: { subject: 'New events this month', content: '<h2 style="margin:0 0 12px;">New events this month</h2><p>Hi Asha, here is what is coming up.</p>', unsubscribeUrl: 'https://example.com/unsubscribe/sample' },
};

function assertCompiles(dto: TemplateDto) {
  for (const [field, src] of [['subject', dto.subject], ['bodyHtml', dto.bodyHtml], ['bodyText', dto.bodyText ?? '']] as const) {
    try {
      Handlebars.precompile(src);
    } catch (e) {
      throw new AppError('TEMPLATE_INVALID', `The ${field} template has a syntax error`, 400, { field, error: (e as Error).message.slice(0, 400) });
    }
  }
}

function assertType(type: string, channel: string): asserts channel is Channel {
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) throw new AppError('UNKNOWN_TEMPLATE_TYPE', `Unknown notification type "${type}"`, 400);
  if (!(CHANNELS as readonly string[]).includes(channel)) throw new AppError('UNKNOWN_CHANNEL', `Unknown channel "${channel}"`, 400);
}

@ApiTags('Admin · Notifications')
@ApiBearerAuth()
@Controller('v1/admin/notifications')
@UseGuards(StaffGuard)
export class NotificationsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private notifications: NotificationService) {}

  /** Every notification template: the platform default, the brand's override (if any) and which one is in effect. */
  @Get('templates')
  @Permissions('integrations.read')
  async templates(@CurrentStaff() staff: Staff, @Query() q: TemplateQuery) {
    if (q.brandId) assertBrandAccess(staff, q.brandId);
    const [platform, overrides] = await Promise.all([
      this.prisma.emailTemplate.findMany(),
      q.brandId ? this.prisma.brandEmailTemplate.findMany({ where: { brandId: q.brandId } }) : Promise.resolve([]),
    ]);
    const out = [];
    for (const type of NOTIFICATION_TYPES) {
      for (const channel of CHANNELS) {
        const p = platform.find((t) => t.type === type && t.channel === channel);
        const o = overrides.find((t) => t.type === type && t.channel === channel);
        const builtin = DEFAULT_TEMPLATES[type];
        const builtinForChannel = channel === 'EMAIL' ? { subject: builtin.subject, bodyHtml: builtin.bodyHtml, bodyText: null } : builtin.sms ? { subject: type, bodyHtml: builtin.sms, bodyText: builtin.sms } : null;
        if (!p && !o && !builtinForChannel) continue;
        out.push({
          type, channel,
          platform: p ? { subject: p.subject, bodyHtml: p.bodyHtml, bodyText: p.bodyText, source: 'platform', updatedAt: p.updatedAt } : builtinForChannel ? { ...builtinForChannel, source: 'builtin', updatedAt: null } : null,
          brandOverride: o ? { subject: o.subject, bodyHtml: o.bodyHtml, bodyText: o.bodyText, active: o.active, updatedAt: o.updatedAt } : null,
          inEffect: o?.active ? 'brand' : p ? 'platform' : 'builtin',
          sampleVariables: Object.keys(SAMPLES[type]),
        });
      }
    }
    return out;
  }

  @Put('templates/platform/:type/:channel')
  @Permissions('integrations.manage')
  async putPlatform(@CurrentStaff() staff: Staff, @Param('type') type: string, @Param('channel') channel: string, @Body() dto: TemplateDto) {
    assertPlatformWide(staff);
    assertType(type, channel);
    assertCompiles(dto);
    const before = await this.prisma.emailTemplate.findUnique({ where: { type_channel: { type, channel } } });
    const data = { subject: dto.subject, bodyHtml: dto.bodyHtml, bodyText: dto.bodyText ?? null };
    const t = await this.prisma.emailTemplate.upsert({ where: { type_channel: { type, channel } }, create: { type, channel, ...data }, update: data });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'template.platform_update', entityType: 'email_template', entityId: t.id, before: before ? { subject: before.subject } : undefined, after: { type, channel, subject: dto.subject } });
    return t;
  }

  /** Creates or replaces a brand's own version of a template. Other brands are unaffected. */
  @Put('templates/brand/:brandId/:type/:channel')
  @Permissions('brands.manage')
  async putBrand(
    @CurrentStaff() staff: Staff, @Param('brandId', ParseUUIDPipe) brandId: string, @Param('type') type: string, @Param('channel') channel: string, @Body() dto: TemplateDto,
  ) {
    assertBrandAccess(staff, brandId);
    assertType(type, channel);
    assertCompiles(dto);
    const data = { subject: dto.subject, bodyHtml: dto.bodyHtml, bodyText: dto.bodyText ?? null, active: dto.active ?? true };
    const t = await this.prisma.brandEmailTemplate.upsert({
      where: { brandId_type_channel: { brandId, type, channel } }, create: { brandId, type, channel, ...data }, update: data,
    });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId, action: 'template.brand_update', entityType: 'brand_email_template', entityId: t.id, after: { type, channel, subject: dto.subject, active: data.active } });
    return t;
  }

  /** Removes a brand override; the platform default applies again. */
  @Delete('templates/brand/:brandId/:type/:channel')
  @Permissions('brands.manage')
  async deleteBrand(@CurrentStaff() staff: Staff, @Param('brandId', ParseUUIDPipe) brandId: string, @Param('type') type: string, @Param('channel') channel: string) {
    assertBrandAccess(staff, brandId);
    assertType(type, channel);
    const removed = await this.prisma.brandEmailTemplate.deleteMany({ where: { brandId, type, channel } });
    if (!removed.count) throw notFound('Template override');
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId, action: 'template.brand_delete', entityType: 'brand_email_template', entityId: `${type}:${channel}` });
    return { ok: true };
  }

  /** Renders a saved template with a brand's identity and sample (or supplied) values. Nothing is sent. */
  @Post('templates/preview')
  @HttpCode(200)
  @Permissions('integrations.read')
  async preview(@CurrentStaff() staff: Staff, @Body() dto: PreviewDto) {
    assertBrandAccess(staff, dto.brandId);
    try {
      const r = await this.notifications.render(dto.brandId, dto.type, dto.channel, { ...SAMPLES[dto.type], ...(dto.payload ?? {}) });
      return { subject: r.subject, html: r.html, text: r.text, from: r.from, replyTo: r.replyTo, templateSource: r.templateSource };
    } catch (e) {
      throw new AppError('TEMPLATE_RENDER_FAILED', 'The template could not be rendered', 422, { error: (e as Error).message.slice(0, 400) });
    }
  }

  // ── Outbox and delivery logs ──

  @Get('jobs')
  @Permissions('integrations.read')
  async jobs(@CurrentStaff() staff: Staff, @Query() q: JobQuery) {
    const where = {
      ...brandWhere(staff, q.brandId),
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.q ? { toAddress: { contains: q.q, mode: 'insensitive' as const } } : {}),
      ...(dateRange(q) ? { createdAt: dateRange(q) } : {}),
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.emailJob.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        select: {
          id: true, brandId: true, channel: true, type: true, toAddress: true, toName: true, customerId: true, orderId: true, campaignId: true,
          status: true, attempts: true, maxAttempts: true, nextAttemptAt: true, lastError: true, providerMessageId: true, createdAt: true, sentAt: true,
        },
      }),
      this.prisma.emailJob.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Puts a failed or skipped notification back in the queue with a fresh set of attempts. */
  @Post('jobs/:id/retry')
  @HttpCode(200)
  @Permissions('integrations.manage')
  async retry(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const job = await this.prisma.emailJob.findUnique({ where: { id } });
    if (!job || !(staff.allBrands || staff.brandIds.includes(job.brandId))) throw notFound('Notification');
    const n = await this.prisma.emailJob.updateMany({
      where: { id, status: { in: ['FAILED', 'SKIPPED'] } }, data: { status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (n.count !== 1) throw new AppError('JOB_NOT_RETRYABLE', `A ${job.status.toLowerCase()} notification cannot be retried`, 409);
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: job.brandId, action: 'notification.retry', entityType: 'email_job', entityId: id, metadata: { type: job.type, previousStatus: job.status } });
    await this.notifications.kick();
    return { id, status: 'QUEUED' };
  }

  @Get('logs')
  @Permissions('integrations.read')
  async logs(@CurrentStaff() staff: Staff, @Query() q: JobQuery) {
    const where = {
      ...brandWhere(staff, q.brandId),
      ...(q.type ? { type: q.type } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.q ? { toAddress: { contains: q.q, mode: 'insensitive' as const } } : {}),
      ...(dateRange(q) ? { createdAt: dateRange(q) } : {}),
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.notificationLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.notificationLog.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Delivery counts by status, channel and type for the selected brand scope and period. */
  @Get('summary')
  @Permissions('integrations.read')
  async summary(@CurrentStaff() staff: Staff, @Query() q: PageQuery) {
    const where = { ...brandWhere(staff, q.brandId), ...(dateRange(q) ? { createdAt: dateRange(q) } : {}) };
    const [byStatus, byType] = await Promise.all([
      this.prisma.emailJob.groupBy({ by: ['channel', 'status'], where, _count: true }),
      this.prisma.emailJob.groupBy({ by: ['type', 'status'], where, _count: true }),
    ]);
    const total = byStatus.reduce((s, r) => s + r._count, 0);
    const count = (st: string) => byStatus.filter((r) => r.status === st).reduce((s, r) => s + r._count, 0);
    return {
      total, sent: count('SENT') + count('DELIVERED'), failed: count('FAILED') + count('BOUNCED'), queued: count('QUEUED') + count('SENDING'), skipped: count('SKIPPED'),
      byChannel: byStatus.map((r) => ({ channel: r.channel, status: r.status, count: r._count })),
      byType: byType.map((r) => ({ type: r.type, status: r.status, count: r._count })),
    };
  }

  /** The SPF, DKIM and DMARC records to publish for a brand's sending domain, with a live check of what exists now. */
  @Get('dns-guidance/:brandId')
  @Permissions('brands.read')
  async dnsGuidance(@CurrentStaff() staff: Staff, @Param('brandId', ParseUUIDPipe) brandId: string) {
    assertBrandAccess(staff, brandId);
    const brand = await this.prisma.brand.findUnique({ where: { id: brandId } });
    if (!brand) throw notFound('Brand');
    const domain = brand.emailSenderAddr.split('@')[1]?.toLowerCase() ?? '';
    const settings = await this.prisma.systemSetting.findMany({ where: { key: { in: ['email.spfInclude', 'email.dkimSelector'] } } });
    const setting = (key: string, field: string) => (settings.find((s) => s.key === key)?.value as Record<string, string> | undefined)?.[field];
    const spfInclude = setting('email.spfInclude', 'include');
    const selector = setting('email.dkimSelector', 'selector') ?? 'selector1';

    const txt = async (host: string) => {
      try {
        return (await dns.resolveTxt(host)).map((r) => r.join(''));
      } catch {
        return [] as string[];
      }
    };
    const [root, dmarc] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`)]);
    const spfFound = root.filter((r) => /^v=spf1/i.test(r));
    const dmarcFound = dmarc.filter((r) => /^v=DMARC1/i.test(r));

    return {
      brandId, senderAddress: brand.emailSenderAddr, domain,
      records: [
        {
          purpose: 'SPF', type: 'TXT', host: domain,
          value: `v=spf1 include:${spfInclude ?? '<your email provider SPF include, e.g. the value shown in its domain setup page>'} -all`,
          explanation: 'Lists the servers allowed to send mail for this domain. Publish exactly one SPF record per domain; if one already exists, add the include to it instead of creating a second record.',
          configured: !!spfInclude,
        },
        {
          purpose: 'DKIM', type: 'CNAME or TXT', host: `${selector}._domainkey.${domain}`,
          value: '<the DKIM key or CNAME target issued by your email provider for this domain>',
          explanation: 'Lets receivers verify that messages were signed by this domain. The selector name and key are generated by the email provider when you add the domain there; each brand domain needs its own.',
          configured: false,
        },
        {
          purpose: 'DMARC', type: 'TXT', host: `_dmarc.${domain}`,
          value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; adkim=s; aspf=s`,
          explanation: 'Tells receivers what to do with mail that fails SPF and DKIM and where to send reports. Roll out in stages: start with p=none and read the reports, move to p=quarantine once all legitimate mail passes, then p=reject.',
          configured: true,
        },
      ],
      current: {
        checkedAt: new Date(),
        spf: { present: spfFound.length > 0, records: spfFound, problem: spfFound.length > 1 ? 'More than one SPF record is published; receivers treat that as a failure.' : null },
        dmarc: { present: dmarcFound.length > 0, records: dmarcFound },
        dkim: { note: `Not checked automatically: the selector depends on your email provider. Verify ${selector}._domainkey.${domain} after publishing.` },
      },
      notes: [
        'The From address domain must match the domain you authenticate, otherwise DMARC alignment fails.',
        'To set the SPF include and DKIM selector shown here, save system settings "email.spfInclude" as {"include":"..."} and "email.dkimSelector" as {"selector":"..."}.',
      ],
    };
  }
}
