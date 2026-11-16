import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

/**
 * The ONLY place this storefront talks to the central ticketing API.
 *
 * It runs on the server. The storefront key is chosen from the request's Host header using
 * server-side configuration and is never sent to the browser. The brand is never read from a
 * query parameter, cookie or form field: the central API derives it from the key and checks
 * that the host is one of that brand's verified domains.
 */
const API_URL = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const CUSTOMER_COOKIE = 'sf_ct';

let keyMap: Record<string, string> | null = null;
function keys(): Record<string, string> {
  if (!keyMap) {
    try {
      const parsed = JSON.parse(process.env.STOREFRONT_KEYS ?? '{}') as Record<string, string>;
      keyMap = Object.fromEntries(Object.entries(parsed).map(([host, key]) => [host.toLowerCase(), key]));
    } catch {
      console.error('STOREFRONT_KEYS is not valid JSON; no storefront is configured');
      keyMap = {};
    }
  }
  return keyMap;
}

export interface Site {
  host: string;
  /** Public origin of this storefront, e.g. https://tickets.example.com */
  origin: string;
  key: string;
}

/** Resolves the storefront for the current request, or null when the host is not configured. */
export const site = cache(async (): Promise<Site | null> => {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').toLowerCase().trim();
  const key = keys()[host];
  if (!key) return null;
  const local = /^(localhost|[\w-]+\.localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = h.get('x-forwarded-proto') ?? (local ? 'http' : 'https');
  return { host, origin: `${proto}://${host}`, key };
});

export interface ApiFailure {
  code: string;
  message: string;
  status: number;
  details?: unknown;
}
export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; error: ApiFailure; status: number };

interface CallOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  idempotencyKey?: string;
  /** Forward the signed-in customer's session (default true). */
  customer?: boolean;
}

async function request(method: string, path: string, opts: CallOptions = {}): Promise<Response | ApiFailure> {
  const s = await site();
  if (!s) return { code: 'STOREFRONT_NOT_CONFIGURED', message: 'This storefront is not configured', status: 503 };
  const url = new URL(`${API_URL}/v1/storefront${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const h: Record<string, string> = { 'X-Storefront-Key': s.key, 'X-Storefront-Domain': s.host, Accept: 'application/json' };
  if (opts.body !== undefined) h['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) h['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.customer !== false) {
    const token = (await cookies()).get(CUSTOMER_COOKIE)?.value;
    if (token) h['X-Customer-Token'] = token;
  }
  try {
    return await fetch(url, { method, headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch {
    return { code: 'API_UNREACHABLE', message: 'The ticketing service is temporarily unavailable. Please try again shortly.', status: 503 };
  }
}

async function failure(res: Response): Promise<ApiFailure> {
  const body = await res.json().catch(() => null);
  const e = body?.error;
  const details = Array.isArray(e?.details) ? (e.details as string[]).join('. ') : null;
  return { code: e?.code ?? 'ERROR', message: details ?? e?.message ?? `Request failed (${res.status})`, status: res.status, details: e?.details };
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, opts: CallOptions = {}): Promise<ApiResult<T>> {
  let res = await request(method, path, opts);
  // A stale or revoked customer session must not break public pages: retry once as a guest.
  if (res instanceof Response && res.status === 401 && opts.customer === undefined && (await cookies()).get(CUSTOMER_COOKIE)) {
    const guest = await request(method, path, { ...opts, customer: false });
    if (guest instanceof Response && guest.status !== 401) res = guest;
  }
  if (!(res instanceof Response)) return { ok: false, error: res, status: res.status };
  if (!res.ok) return { ok: false, error: await failure(res), status: res.status };
  const text = await res.text();
  return { ok: true, data: (text ? JSON.parse(text) : null) as T, status: res.status };
}

/** Streams a binary API response (ticket PDF) without exposing the API URL or key. */
export async function apiRaw(path: string, query?: CallOptions['query']): Promise<Response | ApiFailure> {
  const res = await request('GET', path, { query });
  if (!(res instanceof Response)) return res;
  return res.ok ? res : failure(res);
}

// ── Customer session: an httpOnly cookie scoped to this host ──

export async function setCustomerToken(token: string) {
  const s = await site();
  (await cookies()).set(CUSTOMER_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: !!s && s.origin.startsWith('https://'), path: '/', maxAge: 7 * 24 * 3600,
  });
}
export async function clearCustomerToken() {
  (await cookies()).delete(CUSTOMER_COOKIE);
}
export const hasCustomerToken = async () => !!(await cookies()).get(CUSTOMER_COOKIE)?.value;

// ── Cached per-request lookups ──

export interface Brand {
  id: string;
  slug: string;
  name: string;
  status: string;
  domain: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  contactEmail: string;
  supportPhone: string | null;
  supportUrl: string | null;
  businessAddress: string | null;
  defaultCurrency: string;
  currencies: string[];
  timezone: string;
  acceptingOrders: boolean;
}
export const getBrand = cache(async () => api<Brand>('GET', '/brand', { customer: false }));
export const getBrandSettings = cache(async () => {
  const r = await api<Record<string, any>>('GET', '/brand/settings', { customer: false });
  return r.ok ? r.data : {};
});

export interface Me {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  country: string | null;
  emailVerified: boolean;
  consents: Record<'EMAIL' | 'SMS' | 'WHATSAPP', boolean>;
}
/** The signed-in customer, or null for guests (and for sessions the API no longer accepts). */
export const getMe = cache(async (): Promise<Me | null> => {
  if (!(await hasCustomerToken())) return null;
  const r = await request('GET', '/customers/me');
  if (!(r instanceof Response) || !r.ok) return null;
  return (await r.json()) as Me;
});
