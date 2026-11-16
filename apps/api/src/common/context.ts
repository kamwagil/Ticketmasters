import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';

interface Ctx {
  correlationId: string;
  ip?: string;
}
const als = new AsyncLocalStorage<Ctx>();

export const correlationId = () => als.getStore()?.correlationId;
export const requestIp = () => als.getStore()?.ip;
export const runWithContext = <T>(fn: () => T, id: string = randomUUID()) => als.run({ correlationId: id }, fn);

// ── Structured JSON logging ──
type Fields = Record<string, unknown>;
function write(level: string, msg: string, fields?: Fields) {
  if (config.isTest && level !== 'error' && !process.env.TEST_LOGS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, correlationId: correlationId(), ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
export const log = {
  info: (msg: string, f?: Fields) => write('info', msg, f),
  warn: (msg: string, f?: Fields) => write('warn', msg, f),
  error: (msg: string, f?: Fields) => write('error', msg, f),
};

// ── In-process request metrics, exposed via /metrics and the health dashboard ──
const WINDOW = 2000;
const durations: number[] = [];
export const metrics = {
  startedAt: Date.now(),
  requests: 0,
  errors5xx: 0,
  errors4xx: 0,
  byRoute: new Map<string, { count: number; totalMs: number; errors: number }>(),
  perMinute: new Map<number, number>(),
};

export function latencySnapshot() {
  const sorted = [...durations].sort((a, b) => a - b);
  const pick = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  return { samples: sorted.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

/** Assigns/propagates X-Request-Id, logs each request and records latency. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  const start = process.hrtime.bigint();
  als.run({ correlationId: id, ip: req.ip }, () => {
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = `${req.method} ${(req as any).route?.path ?? req.path}`;
      metrics.requests++;
      if (res.statusCode >= 500) metrics.errors5xx++;
      else if (res.statusCode >= 400) metrics.errors4xx++;
      const r = metrics.byRoute.get(route) ?? { count: 0, totalMs: 0, errors: 0 };
      r.count++;
      r.totalMs += ms;
      if (res.statusCode >= 500) r.errors++;
      metrics.byRoute.set(route, r);
      durations.push(ms);
      if (durations.length > WINDOW) durations.shift();
      const minute = Math.floor(Date.now() / 60000);
      metrics.perMinute.set(minute, (metrics.perMinute.get(minute) ?? 0) + 1);
      if (metrics.perMinute.size > 120) metrics.perMinute.delete(Math.min(...metrics.perMinute.keys()));
      if (req.path !== '/health/live') {
        log.info('http_request', { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) });
      }
    });
    next();
  });
}
