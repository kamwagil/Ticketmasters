/**
 * Client for the central API. Requests go to /api/* on this origin and are proxied to the API.
 * The access token lives only in memory; the refresh token is an httpOnly cookie the browser
 * script can never read. On a 401 the client refreshes once and retries.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public correlationId?: string) {
    super(message);
  }
}

export type Params = Record<string, string | number | boolean | null | undefined>;

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn);
export const hasToken = () => !!accessToken;

export function qs(params?: Params): string {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function toError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const e = body?.error;
  const details = Array.isArray(e?.details) ? e.details.join('. ') : null;
  return new ApiError(res.status, e?.code ?? 'ERROR', details ?? e?.message ?? `Request failed (${res.status})`, e?.details, e?.correlationId);
}

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/admin/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return false;
      accessToken = (await res.json()).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<Response> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (res.status === 401 && retry && !path.includes('/auth/login')) {
    if (await refresh()) return raw(method, path, body, headers, false);
    accessToken = null;
    onSignedOut?.();
  }
  return res;
}

async function json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await raw(method, path, body, headers);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T = any>(path: string, params?: Params) => json<T>('GET', path + qs(params)),
  post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => json<T>('POST', path, body ?? {}, headers),
  put: <T = any>(path: string, body?: unknown) => json<T>('PUT', path, body ?? {}),
  patch: <T = any>(path: string, body?: unknown) => json<T>('PATCH', path, body ?? {}),
  delete: <T = any>(path: string) => json<T>('DELETE', path),
  upload: <T = any>(path: string, form: FormData) => json<T>('POST', path, form),

  async login(email: string, password: string, totp?: string) {
    const res = await raw('POST', '/v1/admin/auth/login', { email, password, ...(totp ? { totp } : {}) }, {}, false);
    if (!res.ok) throw await toError(res);
    accessToken = (await res.json()).accessToken;
  },
  async logout() {
    await fetch('/api/v1/admin/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
    accessToken = null;
  },

  /** Downloads an authenticated file response (CSV / Excel export, ticket PDF). */
  async download(path: string, params: Params | undefined, fallbackName: string) {
    const res = await raw('GET', path + qs(params));
    if (!res.ok) throw await toError(res);
    const blob = await res.blob();
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

/** A fresh key per user action, so a double click or retry cannot repeat a refund or payout. */
export const idempotencyKey = () => ({ 'Idempotency-Key': crypto.randomUUID() });
