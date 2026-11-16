import {
  CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Brand } from '@prisma/client';
import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { config } from './config';
import { sha256 } from './crypto';
import { AppError, forbidden } from './errors';
import { PrismaService, RedisService } from './infra';

// ───────────────────────── Principals ─────────────────────────

export interface Staff {
  userId: string;
  email: string;
  fullName: string;
  sessionId: string;
  allBrands: boolean;
  brandIds: string[];
  permissions: Set<string>;
  /** True when every role the user holds is event-scoped: they only see assigned events. */
  eventScoped: boolean;
  eventIds: string[];
  roleKeys: string[];
}

export interface StorefrontCtx {
  brand: Brand;
  domain: string;
  apiKeyId: string;
}

export interface CustomerCtx {
  relationshipId: string;
  customerId: string;
  brandId: string;
}

// ───────────────────────── Tenant scoping ─────────────────────────
// Every admin query goes through these helpers; the UI brand selector is only a convenience.

/**
 * Resolves the brand filter for a list query.
 * @returns undefined when the caller may see every brand and asked for no filter,
 *          otherwise the list of brand ids the query must be restricted to.
 */
export function brandScope(staff: Staff, requestedBrandId?: string | null): string[] | undefined {
  if (requestedBrandId) {
    assertBrandAccess(staff, requestedBrandId);
    return [requestedBrandId];
  }
  return staff.allBrands ? undefined : staff.brandIds;
}

/** Prisma `where` fragment for a brandId column. */
export function brandWhere(staff: Staff, requestedBrandId?: string | null): { brandId?: { in: string[] } } {
  const scope = brandScope(staff, requestedBrandId);
  return scope ? { brandId: { in: scope } } : {};
}

export function canAccessBrand(staff: Staff, brandId: string | null | undefined): boolean {
  if (staff.allBrands) return true;
  return !!brandId && staff.brandIds.includes(brandId);
}

export function assertBrandAccess(staff: Staff, brandId: string | null | undefined) {
  if (!canAccessBrand(staff, brandId)) throw forbidden('You do not have access to this brand');
}

export function assertPlatformWide(staff: Staff) {
  if (!staff.allBrands) throw forbidden('This action requires platform-wide access');
}

export function assertEventAccess(staff: Staff, eventId: string) {
  if (staff.eventScoped && !staff.eventIds.includes(eventId)) throw forbidden('You are not assigned to this event');
}

export function hasPermission(staff: Staff, key: string) {
  return staff.permissions.has(key);
}

// ───────────────────────── Decorators ─────────────────────────

export const PERMS_KEY = 'ctp:permissions';
/** Requires ALL listed permissions. Used together with StaffGuard. */
export const Permissions = (...keys: string[]) => SetMetadata(PERMS_KEY, keys);
export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().staff as Staff);
export const Storefront = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().storefront as StorefrontCtx);
export const CurrentCustomer = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().customer as CustomerCtx);
export const ALLOW_SUSPENDED = 'ctp:allowSuspended';
/** Marks storefront endpoints that keep working while a brand is suspended (existing orders/tickets). */
export const AllowSuspendedBrand = () => SetMetadata(ALLOW_SUSPENDED, true);

// ───────────────────────── Tokens ─────────────────────────

export const signStaffToken = (userId: string, sessionId: string) =>
  jwt.sign({ sub: userId, sid: sessionId, typ: 'staff' }, config.jwtAccessSecret, { expiresIn: config.accessTokenTtlSec, algorithm: 'HS256' });

export const signCustomerToken = (c: CustomerCtx & { tokenVersion: number }) =>
  jwt.sign({ sub: c.relationshipId, cid: c.customerId, bid: c.brandId, ver: c.tokenVersion, typ: 'customer' }, config.jwtCustomerSecret, {
    expiresIn: config.customerTokenTtlSec,
    algorithm: 'HS256',
  });

function bearer(req: Request): string | null {
  const h = req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

// ───────────────────────── Staff guard (admin portal + scanner) ─────────────────────────

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { staff?: Staff }>();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException('Authentication required');
    let claims: any;
    try {
      claims = jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (claims.typ !== 'staff') throw new UnauthorizedException('Invalid token type');

    // The session and user are re-read on every request so revocation, suspension and
    // permission changes take effect immediately rather than at token expiry.
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      include: {
        user: {
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            brandAssignments: true,
            eventAssignments: true,
          },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== claims.sub) {
      throw new UnauthorizedException('Session is no longer valid');
    }
    const u = session.user;
    if (u.status !== 'ACTIVE' || u.deletedAt) throw new UnauthorizedException('Account is not active');
    if (u.mfaEnabled && !session.mfaVerified) throw new UnauthorizedException('Multi-factor verification required');

    const roles = u.roles.map((r) => r.role);
    const staff: Staff = {
      userId: u.id,
      email: u.email,
      fullName: u.fullName,
      sessionId: session.id,
      allBrands: u.allBrands,
      brandIds: u.brandAssignments.map((b) => b.brandId),
      permissions: new Set(roles.flatMap((r) => r.permissions.map((p) => p.permission.key))),
      eventScoped: roles.length > 0 && roles.every((r) => r.eventScoped),
      eventIds: u.eventAssignments.map((e) => e.eventId),
      roleKeys: roles.map((r) => r.key),
    };
    req.staff = staff;

    const required = this.reflector.getAllAndOverride<string[]>(PERMS_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const missing = required.filter((p) => !staff.permissions.has(p));
    if (missing.length) throw new AppError('FORBIDDEN', `Missing permission: ${missing.join(', ')}`, 403);
    return true;
  }
}

// ───────────────────────── Storefront guard ─────────────────────────

/**
 * Authenticates a storefront by its secret API key and derives the brand from it.
 * The brand is never taken from a request parameter. The claimed domain
 * (X-Storefront-Domain, or the browser Origin) must be a verified domain of that brand.
 */
@Injectable()
export class StorefrontGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector, private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { storefront?: StorefrontCtx }>();
    const key = req.header('x-storefront-key');
    if (!key) throw new UnauthorizedException('Storefront API key required');
    const keyHash = sha256(key);

    const record = await this.prisma.storefrontApiKey.findUnique({
      where: { keyHash },
      include: { brand: { include: { domains: true } } },
    });
    if (!record || record.revokedAt) throw new UnauthorizedException('Invalid storefront API key');

    const verified = record.brand.domains.filter((d) => d.verifiedAt);
    let claimed = req.header('x-storefront-domain')?.toLowerCase().trim();
    const origin = req.header('origin');
    if (!claimed && origin) {
      try {
        claimed = new URL(origin).host.toLowerCase();
      } catch {
        throw forbidden('Malformed Origin header');
      }
    }
    let domain: string;
    if (claimed) {
      const match = verified.find((d) => d.domain === claimed);
      if (!match) throw forbidden('Domain is not a verified domain of this storefront');
      domain = match.domain;
    } else {
      const primary = verified.find((d) => d.isPrimary) ?? verified[0];
      if (!primary) throw forbidden('Storefront has no verified domain');
      domain = primary.domain;
    }

    const allowSuspended = this.reflector.getAllAndOverride<boolean>(ALLOW_SUSPENDED, [ctx.getHandler(), ctx.getClass()]);
    if (record.brand.status !== 'ACTIVE' && !allowSuspended) {
      throw new AppError('BRAND_NOT_ACTIVE', 'This storefront is not currently accepting requests', 403, { status: record.brand.status });
    }

    const { domains: _domains, ...brand } = record.brand;
    req.storefront = { brand, domain, apiKeyId: record.id };
    if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 5 * 60_000) {
      this.prisma.storefrontApiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return true;
  }
}

/** Authenticates a storefront customer. Must run after StorefrontGuard; tokens are brand-bound. */
@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { storefront?: StorefrontCtx; customer?: CustomerCtx }>();
    const token = req.header('x-customer-token') ?? bearer(req);
    if (!token) throw new UnauthorizedException('Customer authentication required');
    let claims: any;
    try {
      claims = jwt.verify(token, config.jwtCustomerSecret, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired customer token');
    }
    if (claims.typ !== 'customer' || !req.storefront || claims.bid !== req.storefront.brand.id) {
      throw new UnauthorizedException('Token is not valid for this storefront');
    }
    const rel = await this.prisma.customerBrandRelationship.findUnique({ where: { id: claims.sub } });
    if (!rel || rel.status !== 'ACTIVE' || rel.brandId !== claims.bid) throw new UnauthorizedException('Account is not active');
    // Tokens issued before a password change or reset carry an older version and stop working at once.
    if (claims.ver !== rel.tokenVersion) throw new UnauthorizedException('Session has expired, please sign in again');
    // customerId is read from the DB: it changes when accounts are linked after verification.
    req.customer = { relationshipId: rel.id, customerId: rel.customerId, brandId: rel.brandId };
    return true;
  }
}

/** Like CustomerGuard, but lets guests through. Used on checkout, where signing in is optional. */
@Injectable()
export class OptionalCustomerGuard extends CustomerGuard {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.header('x-customer-token')) return true;
    return super.canActivate(ctx);
  }
}

// ───────────────────────── Rate limiting ─────────────────────────

export const RATE_KEY = 'ctp:rate';
export interface RateRule {
  limit: number;
  windowSec: number;
  /** ip (default) | storefront (per API key) | ip+path */
  by?: 'ip' | 'storefront';
}
export const RateLimit = (rule: RateRule) => SetMetadata(RATE_KEY, rule);

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();
/** Clears the in-process limiter state (used between automated tests; Redis-backed limits are unaffected). */
export const clearRateLimitBuckets = () => memoryBuckets.clear();

/** Fixed-window limiter. Redis-backed so limits hold across API replicas. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private reflector: Reflector, private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateRule>(RATE_KEY, [ctx.getHandler(), ctx.getClass()]) ?? {
      limit: Number(process.env.RATE_LIMIT_DEFAULT ?? 3000),
      windowSec: 60,
    };
    const req = ctx.switchToHttp().getRequest<Request>();
    const who = rule.by === 'storefront' ? sha256(req.header('x-storefront-key') ?? req.ip ?? '').slice(0, 16) : req.ip;
    const route = `${req.method}:${(req as any).route?.path ?? req.path}`;
    const window = Math.floor(Date.now() / (rule.windowSec * 1000));
    const key = `rl:${route}:${who}:${window}`;
    let count: number;
    if (this.redis.enabled) {
      try {
        count = await this.redis.client.incr(key);
        if (count === 1) await this.redis.client.expire(key, rule.windowSec + 1);
      } catch {
        return true; // fail open: a Redis outage must not take checkout down
      }
    } else {
      const now = Date.now();
      const b = memoryBuckets.get(key);
      if (!b || b.resetAt < now) memoryBuckets.set(key, { count: 1, resetAt: now + rule.windowSec * 1000 });
      else b.count++;
      count = memoryBuckets.get(key)!.count;
      if (memoryBuckets.size > 50_000) memoryBuckets.clear();
    }
    if (count > rule.limit) {
      ctx.switchToHttp().getResponse().setHeader('Retry-After', String(rule.windowSec));
      throw new AppError('RATE_LIMITED', 'Too many requests. Please retry shortly.', 429);
    }
    return true;
  }
}

// ───────────────────────── Idempotency ─────────────────────────

@Injectable()
export class IdempotencyService {
  constructor(private prisma: PrismaService) {}

  /**
   * Runs `fn` at most once per (scope, key). A replay with the same request returns the
   * stored response; the same key with a different request body is rejected.
   */
  async run<T>(scope: string, key: string | undefined, request: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    if (key.length > 200) throw new AppError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key is too long', 400);
    const requestHash = sha256(JSON.stringify(request ?? null));
    try {
      await this.prisma.idempotencyKey.create({ data: { scope, key, requestHash } });
    } catch {
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
      if (!existing) throw new AppError('IDEMPOTENCY_CONFLICT', 'Could not acquire idempotency key, retry', 409);
      if (existing.requestHash !== requestHash) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request', 422);
      }
      if (!existing.completedAt) {
        throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed', 409);
      }
      return existing.responseBody as T;
    }
    try {
      const result = await fn();
      await this.prisma.idempotencyKey.update({
        where: { scope_key: { scope, key } },
        data: { responseStatus: 200, responseBody: JSON.parse(JSON.stringify(result ?? null)), completedAt: new Date() },
      });
      return result;
    } catch (e) {
      // Failed requests release the key so the client can retry with the same key.
      await this.prisma.idempotencyKey.delete({ where: { scope_key: { scope, key } } }).catch(() => undefined);
      throw e;
    }
  }
}
