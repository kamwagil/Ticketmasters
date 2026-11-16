import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from './config';
import { log, requestIp, correlationId, runWithContext } from './context';

// BigInt money values serialise as JSON numbers (safe up to 2^53 minor units).
(BigInt.prototype as any).toJSON = function () {
  const n = Number(this);
  return Number.isSafeInteger(n) ? n : this.toString();
};

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
  /** Interactive transaction with sane defaults for checkout/payment paths. */
  tx<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeoutMs?: number; isolation?: Prisma.TransactionIsolationLevel }) {
    return this.$transaction(fn, { maxWait: 15000, timeout: opts?.timeoutMs ?? 20000, isolationLevel: opts?.isolation });
  }
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly enabled = config.queueMode === 'bullmq' || !config.isTest;
  private _client?: Redis;
  get client(): Redis {
    if (!this._client) {
      this._client = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
      this._client.on('error', (e) => log.error('redis_error', { error: e.message }));
    }
    return this._client;
  }
  async ping(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  /** Cache-aside helper for non-critical read models (never inventory or payment state). */
  async cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    if (!this.enabled) return load();
    try {
      const hit = await this.client.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch {
      return load();
    }
    const value = await load();
    this.client.set(key, JSON.stringify(value), 'EX', ttlSec).catch(() => undefined);
    return value;
  }
  async invalidate(prefix: string) {
    if (!this.enabled) return;
    try {
      const keys = await this.client.keys(`${prefix}*`);
      if (keys.length) await this.client.del(...keys);
    } catch {
      /* cache invalidation is best-effort; entries expire on their TTL */
    }
  }
  async onModuleDestroy() {
    if (this._client) await this._client.quit().catch(() => undefined);
  }
}

type Handler = (data: any) => Promise<unknown>;
interface JobOpts {
  jobId?: string;
  delayMs?: number;
  attempts?: number;
}

/**
 * Background jobs. `bullmq` mode uses Redis-backed queues so any number of API/worker
 * replicas can share the work; `inline` mode executes immediately and is used by tests.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private handlers = new Map<string, { handler: Handler; concurrency: number }>();
  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];
  private started = false;
  inline = config.queueMode === 'inline';

  private connection() {
    const u = new URL(config.redisUrl);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      password: u.password || undefined,
      username: u.username || undefined,
      maxRetriesPerRequest: null as null,
    };
  }

  register(name: string, handler: Handler, concurrency = 5) {
    this.handlers.set(name, { handler, concurrency });
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection(),
        prefix: config.queuePrefix,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 1000, age: 3600 },
          removeOnFail: { count: 5000 },
        },
      });
      q.on('error', (e) => log.error('queue_error', { queue: name, error: e.message }));
      this.queues.set(name, q);
    }
    return q;
  }

  async add(name: string, data: Record<string, unknown>, opts: JobOpts = {}) {
    if (this.inline) {
      const h = this.handlers.get(name);
      if (!h) throw new Error(`No handler registered for queue ${name}`);
      try {
        await h.handler(data);
      } catch (e) {
        // Mirrors a failed job: the durable DB row (outbox/webhook event) keeps the failure state.
        log.error('inline_job_failed', { queue: name, error: (e as Error).message });
      }
      return;
    }
    await this.queue(name).add(name, { ...data, _cid: correlationId() }, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: opts.attempts,
    });
  }

  /** Starts workers and repeatable schedules. Called once on boot when RUN_WORKERS=true. */
  async start(schedules: { queue: string; everyMs: number }[]) {
    if (this.inline || this.started) return;
    if (this.handlers.size === 0) throw new Error('QueueService.start() called before any job handler was registered (call app.init() first)');
    this.started = true;
    for (const [name, { handler, concurrency }] of this.handlers) {
      const w = new Worker(
        name,
        async (job) => runWithContext(() => handler(job.data), job.data?._cid),
        { connection: this.connection(), concurrency, prefix: config.queuePrefix },
      );
      w.on('failed', (job, err) => log.error('job_failed', { queue: name, jobId: job?.id, attempts: job?.attemptsMade, error: err.message }));
      w.on('error', (e) => log.error('worker_error', { queue: name, error: e.message }));
      this.workers.push(w);
    }
    for (const s of schedules) {
      await this.queue(s.queue).upsertJobScheduler(`${s.queue}-schedule`, { every: s.everyMs }, { name: s.queue, data: {} });
    }
    log.info('workers_started', { queues: [...this.handlers.keys()] });
  }

  async stats() {
    if (this.inline) return [];
    const out = [];
    for (const name of this.handlers.keys()) {
      const c = await this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      out.push({ queue: name, ...c });
    }
    return out;
  }

  async onModuleDestroy() {
    // Graceful shutdown: let in-flight jobs finish, then close connections.
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }
}

export interface AuditInput {
  actorType: 'USER' | 'CUSTOMER' | 'STOREFRONT' | 'SYSTEM';
  actorId?: string | null;
  actorLabel?: string | null;
  brandId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

const SENSITIVE = /password|secret|token|credential|hash|enc$/i;
function redact(v: unknown, depth = 0): any {
  if (v === null || v === undefined || depth > 6) return v ?? null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(val, depth + 1);
    return out;
  }
  return v;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}
  /** Appends an immutable audit record. Pass `tx` to make it atomic with the change it describes. */
  async record(input: AuditInput, tx?: Tx) {
    await (tx ?? this.prisma).auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        brandId: input.brandId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        before: input.before === undefined ? undefined : redact(input.before),
        after: input.after === undefined ? undefined : redact(input.after),
        metadata: input.metadata === undefined ? undefined : redact(input.metadata),
        ip: requestIp(),
        correlationId: correlationId(),
      },
    });
  }
}

@Injectable()
export class AlertService {
  constructor(private prisma: PrismaService) {}
  /** Raises an operational alert. `dedupeKey` keeps a recurring condition to one open alert. */
  async raise(a: {
    type: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    message: string;
    brandId?: string | null;
    entityType?: string;
    entityId?: string;
    metadata?: Prisma.InputJsonValue;
    dedupeKey?: string;
  }) {
    log.warn('alert_raised', { type: a.type, severity: a.severity, message: a.message });
    try {
      if (a.dedupeKey) {
        await this.prisma.alert.upsert({ where: { dedupeKey: a.dedupeKey }, create: a, update: { message: a.message, metadata: a.metadata } });
      } else {
        await this.prisma.alert.create({ data: a });
      }
    } catch (e) {
      log.error('alert_write_failed', { error: (e as Error).message });
    }
  }
  async integration(entry: Prisma.IntegrationLogCreateInput) {
    await this.prisma.integrationLog.create({ data: { ...entry, correlationId: correlationId() } }).catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [PrismaService, RedisService, QueueService, AuditService, AlertService],
  exports: [PrismaService, RedisService, QueueService, AuditService, AlertService],
})
export class InfraModule {}
