import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { assertPlatformWide, brandWhere, CurrentStaff, hasPermission, Permissions, Staff, StaffGuard } from '../../common/auth';
import { config } from '../../common/config';
import { latencySnapshot, metrics } from '../../common/context';
import { safeEqual } from '../../common/crypto';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService, QueueService, RedisService } from '../../common/infra';
import { StorageService } from '../../common/storage';
import { dateRange, EXPORT_LIMIT, paged, PageQuery, paging, sendExport } from '../../common/util';
import { NotificationService } from '../notifications/notification.service';

const CUR = /^[A-Z]{3}$/;

class AlertQuery extends PageQuery {
  @IsOptional() @IsIn(['INFO', 'WARNING', 'CRITICAL']) severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  @IsOptional() @IsString() @MaxLength(60) type?: string;
  /** true = unresolved only, false = resolved only. */
  @IsOptional() @IsIn(['true', 'false']) open?: string;
}
class AuditQuery extends PageQuery {
  /** Action prefix, e.g. "refund." */
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsString() @MaxLength(80) actorId?: string;
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @IsOptional() @IsString() @MaxLength(80) entityId?: string;
}
class IntegrationLogQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(40) integration?: string;
  @IsOptional() @IsIn(['OK', 'ERROR']) status?: string;
}
class SettingDto {
  @IsObject() value: Record<string, unknown>;
}
class CurrencyDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(4) minorUnits?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class ExchangeRateDto {
  @Matches(CUR) base: string;
  @Matches(CUR) quote: string;
  /** Decimal as a string, e.g. "129.25": one unit of base equals this many units of quote. */
  @Matches(/^\d{1,10}(\.\d{1,10})?$/) rate: string;
  @IsOptional() @IsISO8601() asOf?: string;
  @IsOptional() @IsString() @MaxLength(60) source?: string;
}

function currentRpm() {
  const minute = Math.floor(Date.now() / 60000);
  const current = metrics.perMinute.get(minute) ?? 0;
  let trailing = 0;
  for (let i = 1; i <= 10; i++) trailing += metrics.perMinute.get(minute - i) ?? 0;
  const average = trailing / 10;
  return { current, lastMinute: metrics.perMinute.get(minute - 1) ?? 0, trailing10MinuteAverage: Math.round(average), unusualSpike: current > 300 && current > 3 * average };
}

// ───────────────────────── Probes and metrics (no staff session) ─────────────────────────

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  /** Liveness: the process is up. Used by the container orchestrator. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the instance can serve traffic (database reachable). 503 takes it out of the load balancer. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    let database = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    const redis = this.redis.enabled ? await this.redis.ping() : null;
    if (!database) res.status(503);
    // Redis being down degrades queues and rate limiting but checkout reads and writes still work.
    return { status: database ? (redis === false ? 'degraded' : 'ok') : 'unavailable', database, redis };
  }

  /** Prometheus scrape endpoint for this instance's request metrics. */
  @Get('metrics')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metricsText(@Req() req: Request) {
    const token = process.env.METRICS_TOKEN;
    if (token) {
      const given = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(given, token)) throw new AppError('UNAUTHENTICATED', 'Metrics token required', 401);
    } else if (config.isProd) {
      throw new AppError('NOT_FOUND', 'Not found', 404);
    }
    const l = latencySnapshot();
    const label = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
    const lines = [
      '# HELP ctp_uptime_seconds Seconds since this API process started', '# TYPE ctp_uptime_seconds gauge', `ctp_uptime_seconds ${Math.round((Date.now() - metrics.startedAt) / 1000)}`,
      '# HELP ctp_http_requests_total HTTP requests handled', '# TYPE ctp_http_requests_total counter', `ctp_http_requests_total ${metrics.requests}`,
      '# HELP ctp_http_errors_total HTTP error responses by class', '# TYPE ctp_http_errors_total counter',
      `ctp_http_errors_total{class="4xx"} ${metrics.errors4xx}`, `ctp_http_errors_total{class="5xx"} ${metrics.errors5xx}`,
      '# HELP ctp_http_request_duration_ms Request latency over the most recent requests', '# TYPE ctp_http_request_duration_ms summary',
      `ctp_http_request_duration_ms{quantile="0.5"} ${l.p50.toFixed(2)}`, `ctp_http_request_duration_ms{quantile="0.95"} ${l.p95.toFixed(2)}`, `ctp_http_request_duration_ms{quantile="0.99"} ${l.p99.toFixed(2)}`,
      '# HELP ctp_http_requests_current_minute Requests received in the current minute', '# TYPE ctp_http_requests_current_minute gauge', `ctp_http_requests_current_minute ${currentRpm().current}`,
      '# HELP ctp_http_route_requests_total Requests by route', '# TYPE ctp_http_route_requests_total counter',
      ...[...metrics.byRoute].map(([route, r]) => `ctp_http_route_requests_total{route="${label(route)}"} ${r.count}`),
      '# HELP ctp_http_route_duration_ms_sum Total latency by route', '# TYPE ctp_http_route_duration_ms_sum counter',
      ...[...metrics.byRoute].map(([route, r]) => `ctp_http_route_duration_ms_sum{route="${label(route)}"} ${r.totalMs.toFixed(1)}`),
      '# HELP ctp_http_route_errors_total 5xx responses by route', '# TYPE ctp_http_route_errors_total counter',
      ...[...metrics.byRoute].filter(([, r]) => r.errors).map(([route, r]) => `ctp_http_route_errors_total{route="${label(route)}"} ${r.errors}`),
    ];
    return lines.join('\n') + '\n';
  }
}

// ───────────────────────── Operations (staff) ─────────────────────────

@ApiTags('Admin · Operations')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class OpsController {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private queue: QueueService,
    private storage: StorageService,
    private notifications: NotificationService,
    private audit: AuditService,
  ) {}

  /** System health dashboard: API, database, Redis, queues, webhooks, email, storage and traffic. */
  @Get('system/health')
  @Permissions('system.health')
  async health() {
    const day = new Date(Date.now() - 86400_000);
    const dbStart = Date.now();
    let database: Record<string, unknown>;
    try {
      const [row] = await this.prisma.$queryRaw<{ connections: number; active: number; maxConnections: number }[]>`
        SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active')::int AS active,
               current_setting('max_connections')::int AS "maxConnections"`;
      database = { ok: true, latencyMs: Date.now() - dbStart, ...row, utilisation: row.maxConnections ? Math.round((row.connections / row.maxConnections) * 100) / 100 : null };
    } catch (e) {
      database = { ok: false, error: (e as Error).message.slice(0, 300) };
    }
    const redisStart = Date.now();
    const redisOk = this.redis.enabled ? await this.redis.ping() : null;
    const [queues, storage, smtp, webhooks, webhookBacklog, emails, emailBacklog, openAlerts, stuckOrders] = await Promise.all([
      this.queue.stats().catch(() => [] as Awaited<ReturnType<QueueService['stats']>>),
      this.storage.health(),
      this.notifications.smtpHealth(),
      this.prisma.paymentWebhookEvent.groupBy({ by: ['status'], _count: true, where: { receivedAt: { gte: day } } }),
      this.prisma.paymentWebhookEvent.count({ where: { status: { in: ['RECEIVED', 'FAILED'] }, receivedAt: { lt: new Date(Date.now() - 60_000) } } }),
      this.prisma.emailJob.groupBy({ by: ['status'], _count: true, where: { createdAt: { gte: day } } }),
      this.prisma.emailJob.count({ where: { status: 'QUEUED', nextAttemptAt: { lt: new Date(Date.now() - 5 * 60_000) } } }),
      this.prisma.alert.groupBy({ by: ['severity'], _count: true, where: { resolvedAt: null } }),
      this.prisma.order.count({ where: { status: 'PAID', needsAttention: false, paidAt: { lt: new Date(Date.now() - 5 * 60_000) } } }),
    ]);
    const wh = (s: string) => webhooks.find((w) => w.status === s)?._count ?? 0;
    const em = (s: string) => emails.find((w) => w.status === s)?._count ?? 0;
    const queueFailed = queues.reduce((s, q) => s + ((q as { failed?: number }).failed ?? 0), 0);
    const traffic = currentRpm();
    const routes = [...metrics.byRoute].map(([route, r]) => ({ route, count: r.count, avgMs: Math.round(r.totalMs / r.count), errors: r.errors }));
    const problems: string[] = [];
    if (!database.ok) problems.push('database');
    if (redisOk === false) problems.push('redis');
    if (!storage.ok) problems.push('storage');
    if (!smtp) problems.push('smtp');
    if (webhookBacklog > 0) problems.push('webhook_backlog');
    if (stuckOrders > 0) problems.push('ticket_issuance');
    return {
      status: !database.ok ? 'down' : problems.length ? 'degraded' : 'healthy', problems, asOf: new Date(),
      api: {
        instanceScope: 'Request metrics are for the API instance that served this call.',
        uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000), startedAt: new Date(metrics.startedAt), environment: config.env,
        requests: metrics.requests, errors4xx: metrics.errors4xx, errors5xx: metrics.errors5xx, errorRate5xx: metrics.requests ? Math.round((metrics.errors5xx / metrics.requests) * 10000) / 10000 : 0,
        latencyMs: latencySnapshot(),
        slowestRoutes: [...routes].sort((a, b) => b.avgMs - a.avgMs).slice(0, 8),
        errorRoutes: routes.filter((r) => r.errors).sort((a, b) => b.errors - a.errors).slice(0, 8),
      },
      traffic: { ...traffic, perMinute: [...metrics.perMinute].sort(([a], [b]) => a - b).slice(-60).map(([minute, count]) => ({ at: new Date(minute * 60000), count })) },
      database,
      redis: { enabled: this.redis.enabled, ok: redisOk, latencyMs: redisOk ? Date.now() - redisStart : null },
      queues: { mode: config.queueMode, workersInThisProcess: config.runWorkers, queues, failedJobs: queueFailed },
      failedBackgroundJobs: { queueJobs: queueFailed, notifications: em('FAILED'), webhooks: wh('FAILED') },
      paymentWebhooks: { last24h: { received: webhooks.reduce((s, w) => s + w._count, 0), processed: wh('PROCESSED'), ignored: wh('IGNORED'), failed: wh('FAILED'), rejected: wh('REJECTED') }, unprocessedBacklog: webhookBacklog },
      notifications: { smtpHealthy: smtp, last24h: { sent: em('SENT') + em('DELIVERED'), failed: em('FAILED') + em('BOUNCED'), queued: em('QUEUED') + em('SENDING'), skipped: em('SKIPPED') }, overdueBacklog: emailBacklog },
      storage,
      ticketing: { paidOrdersAwaitingTickets: stuckOrders },
      openAlerts: openAlerts.map((a) => ({ severity: a.severity, count: a._count })),
    };
  }

  // ── Alerts ──

  private alertScope(staff: Staff): Prisma.AlertWhereInput {
    return staff.allBrands ? {} : { brandId: { in: staff.brandIds } };
  }

  @Get('alerts')
  @Permissions('system.health')
  async alerts(@CurrentStaff() staff: Staff, @Query() q: AlertQuery) {
    const where: Prisma.AlertWhereInput = {
      AND: [
        this.alertScope(staff),
        q.brandId ? brandWhere(staff, q.brandId) : {},
        q.severity ? { severity: q.severity } : {},
        q.type ? { type: q.type } : {},
        q.open === 'true' ? { resolvedAt: null } : q.open === 'false' ? { resolvedAt: { not: null } } : {},
        q.q ? { message: { contains: q.q, mode: 'insensitive' } } : {},
        dateRange(q) ? { createdAt: dateRange(q) } : {},
      ],
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.alert.findMany({ where, skip, take, orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }] }),
      this.prisma.alert.count({ where }),
    ]);
    return paged(items, total, q);
  }

  @Post('alerts/:id/resolve')
  @HttpCode(200)
  @Permissions('system.health')
  async resolveAlert(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const alert = await this.prisma.alert.findFirst({ where: { id, ...this.alertScope(staff) } });
    if (!alert) throw notFound('Alert');
    if (alert.resolvedAt) return alert;
    // Clearing the dedupe key lets the same condition raise a fresh alert if it happens again.
    const updated = await this.prisma.alert.update({ where: { id }, data: { resolvedAt: new Date(), resolvedBy: staff.userId, dedupeKey: null } });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: alert.brandId, action: 'alert.resolve', entityType: 'alert', entityId: id, metadata: { type: alert.type, severity: alert.severity } });
    return updated;
  }

  // ── Audit log ──

  @Get('audit-logs')
  @Permissions('audit.read')
  async auditLogs(@CurrentStaff() staff: Staff, @Query() q: AuditQuery, @Res() res: Response) {
    if (q.format && !['csv', 'xlsx'].includes(q.format)) throw new AppError('FORMAT_UNSUPPORTED', 'format must be csv or xlsx', 400);
    if (q.format && !hasPermission(staff, 'reports.export')) throw forbidden('Missing permission: reports.export');
    const where: Prisma.AuditLogWhereInput = {
      // Brand staff only ever see entries recorded against their own brands; platform-level entries stay hidden.
      ...brandWhere(staff, q.brandId),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.q ? { OR: [{ actorLabel: { contains: q.q, mode: 'insensitive' } }, { action: { contains: q.q, mode: 'insensitive' } }, { entityId: { contains: q.q } }] } : {}),
      ...(dateRange(q) ? { createdAt: dateRange(q) } : {}),
    };
    if (q.format) {
      const rows = await this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: EXPORT_LIMIT });
      return sendExport(res, q.format, 'audit-log', [
        { header: 'Time', value: (r) => r.createdAt }, { header: 'Actor type', value: (r) => r.actorType }, { header: 'Actor', value: (r) => r.actorLabel ?? r.actorId },
        { header: 'Action', value: (r) => r.action }, { header: 'Entity type', value: (r) => r.entityType }, { header: 'Entity', value: (r) => r.entityId },
        { header: 'Brand', value: (r) => r.brandId }, { header: 'IP', value: (r) => r.ip }, { header: 'Correlation id', value: (r) => r.correlationId },
        { header: 'Before', value: (r) => (r.before ? JSON.stringify(r.before) : '') }, { header: 'After', value: (r) => (r.after ? JSON.stringify(r.after) : '') },
        { header: 'Metadata', value: (r) => (r.metadata ? JSON.stringify(r.metadata) : '') },
      ], rows);
    }
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.auditLog.count({ where }),
    ]);
    return res.json(paged(items, total, q));
  }

  // ── Integrations ──

  /** Status of every external integration. Secrets are never returned. */
  @Get('integrations')
  @Permissions('integrations.read')
  async integrations(@CurrentStaff() staff: Staff) {
    const [providers, accounts, storage, smtp, recentErrors] = await Promise.all([
      this.prisma.paymentProvider.findMany({ orderBy: { name: 'asc' } }),
      staff.allBrands
        ? this.prisma.paymentProviderAccount.findMany({
            orderBy: { createdAt: 'asc' },
            select: {
              id: true, providerCode: true, label: true, livemode: true, currencies: true, active: true, merchantRef: true,
              legalEntity: { select: { id: true, name: true } },
              brandConfigs: { where: { active: true }, select: { providerApproved: true, currencies: true, brand: { select: { id: true, name: true } } } },
            },
          })
        : this.prisma.paymentProviderAccount.findMany({
            where: { brandConfigs: { some: { brandId: { in: staff.brandIds }, active: true } } },
            select: { id: true, providerCode: true, label: true, livemode: true, currencies: true, active: true },
          }),
      this.storage.health(),
      this.notifications.smtpHealth(),
      staff.allBrands
        ? this.prisma.integrationLog.groupBy({ by: ['integration'], _count: true, where: { status: 'ERROR', createdAt: { gte: new Date(Date.now() - 86400_000) } } })
        : Promise.resolve([] as { integration: string; _count: number }[]),
    ]);
    return {
      payments: {
        providers,
        merchantAccounts: accounts.map((a) => ({
          ...a,
          // The webhook URL is configured in the provider dashboard; only platform staff need it.
          webhookUrl: staff.allBrands ? `${config.apiPublicUrl}/v1/webhooks/${a.providerCode}/${a.id}` : undefined,
        })),
        sandboxAllowed: !config.isProd || config.allowSandboxProvider,
      },
      email: { transport: 'smtp', host: staff.allBrands ? config.smtp.host : undefined, port: staff.allBrands ? config.smtp.port : undefined, authenticated: !!config.smtp.user, healthy: smtp },
      sms: { provider: "Africa's Talking", configured: !!(config.sms.username && config.sms.apiKey), senderId: config.sms.senderId || null, requiredEnv: ['AT_USERNAME', 'AT_API_KEY', 'AT_SENDER_ID'] },
      whatsapp: { provider: 'Meta WhatsApp Cloud API', configured: !!(config.whatsapp.phoneNumberId && config.whatsapp.accessToken), requiredEnv: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'] },
      storage,
      queue: { mode: config.queueMode, redisEnabled: this.redis.enabled },
      errorsLast24h: recentErrors.map((e) => ({ integration: e.integration, count: e._count })),
    };
  }

  @Get('integration-logs')
  @Permissions('integrations.read')
  async integrationLogs(@CurrentStaff() staff: Staff, @Query() q: IntegrationLogQuery) {
    assertPlatformWide(staff);
    const where: Prisma.IntegrationLogWhereInput = {
      ...(q.integration ? { integration: q.integration } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.brandId ? { brandId: q.brandId } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q } }, { error: { contains: q.q, mode: 'insensitive' } }, { operation: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(dateRange(q) ? { createdAt: dateRange(q) } : {}),
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.integrationLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.integrationLog.count({ where }),
    ]);
    return paged(items, total, q);
  }

  // ── Platform settings ──

  @Get('settings')
  @Permissions('settings.manage')
  settings(@CurrentStaff() staff: Staff) {
    assertPlatformWide(staff);
    return this.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
  }

  @Get('settings/:key')
  @Permissions('settings.manage')
  async setting(@CurrentStaff() staff: Staff, @Param('key') key: string) {
    assertPlatformWide(staff);
    const s = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!s) throw notFound('Setting');
    return s;
  }

  @Put('settings/:key')
  @Permissions('settings.manage')
  async putSetting(@CurrentStaff() staff: Staff, @Param('key') key: string, @Body() dto: SettingDto) {
    assertPlatformWide(staff);
    if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,3}$/.test(key)) throw new AppError('SETTING_KEY_INVALID', 'Setting keys look like "group.name"', 400);
    const before = await this.prisma.systemSetting.findUnique({ where: { key } });
    const value = dto.value as Prisma.InputJsonValue;
    const s = await this.prisma.systemSetting.upsert({ where: { key }, create: { key, value, updatedBy: staff.userId }, update: { value, updatedBy: staff.userId } });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'setting.update', entityType: 'system_setting', entityId: key, before: before?.value ?? undefined, after: dto.value });
    return s;
  }

  @Get('currencies')
  @Permissions('settings.manage')
  currencies() {
    return this.prisma.currency.findMany({ orderBy: { code: 'asc' } });
  }

  @Put('currencies/:code')
  @Permissions('settings.manage')
  async putCurrency(@CurrentStaff() staff: Staff, @Param('code') code: string, @Body() dto: CurrencyDto) {
    assertPlatformWide(staff);
    code = code.toUpperCase();
    if (!CUR.test(code)) throw new AppError('CURRENCY_INVALID', 'Use a three-letter ISO 4217 code', 400);
    const before = await this.prisma.currency.findUnique({ where: { code } });
    if (!before && !dto.name) throw new AppError('CURRENCY_NAME_REQUIRED', 'A name is required when adding a currency', 400);
    if (before && dto.minorUnits !== undefined && dto.minorUnits !== before.minorUnits && (await this.prisma.order.count({ where: { currency: code } }))) {
      throw new AppError('CURRENCY_IN_USE', 'Minor units cannot change once orders exist in this currency', 409);
    }
    const c = await this.prisma.currency.upsert({ where: { code }, create: { code, name: dto.name ?? code, minorUnits: dto.minorUnits ?? 2, enabled: dto.enabled ?? true }, update: dto });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'currency.update', entityType: 'currency', entityId: code, before: before ?? undefined, after: dto });
    return c;
  }

  /** Recorded exchange rates, newest first. Used only for clearly labelled converted reporting figures. */
  @Get('exchange-rates')
  @Permissions('settings.manage')
  async exchangeRates(@Query() q: PageQuery) {
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.exchangeRate.findMany({ skip, take, orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.exchangeRate.count(),
    ]);
    return paged(items.map((r) => ({ ...r, rate: r.rate.toString() })), total, q);
  }

  /** Records a new rate. Rates are append-only so past converted figures stay reproducible. */
  @Post('exchange-rates')
  @Permissions('settings.manage')
  async addExchangeRate(@CurrentStaff() staff: Staff, @Body() dto: ExchangeRateDto) {
    assertPlatformWide(staff);
    if (dto.base === dto.quote) throw new AppError('RATE_INVALID', 'Base and quote currency must differ', 400);
    const rate = new Prisma.Decimal(dto.rate);
    if (rate.lte(0)) throw new AppError('RATE_INVALID', 'The rate must be greater than zero', 400);
    const known = await this.prisma.currency.count({ where: { code: { in: [dto.base, dto.quote] } } });
    if (known !== 2) throw new AppError('CURRENCY_UNKNOWN', 'Both currencies must exist in the currency list', 400);
    const r = await this.prisma.exchangeRate.create({ data: { base: dto.base, quote: dto.quote, rate, asOf: dto.asOf ? new Date(dto.asOf) : new Date(), source: dto.source ?? 'manual' } });
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, action: 'exchange_rate.create', entityType: 'exchange_rate', entityId: r.id, after: { ...dto } });
    return { ...r, rate: r.rate.toString() };
  }
}
