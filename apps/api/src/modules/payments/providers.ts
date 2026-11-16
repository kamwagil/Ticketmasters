import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../../common/config';
import { hmac, safeEqual, sha256 } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/infra';

export interface ProviderAccountCtx {
  id: string;
  providerCode: string;
  livemode: boolean;
  merchantRef: string | null;
  credentials: Record<string, string>;
}

export interface InitializeInput {
  reference: string;
  amountMinor: bigint;
  currency: string;
  email: string;
  name: string;
  callbackUrl: string;
  metadata: Record<string, string>;
  channels?: string[];
}

export interface VerifiedPayment {
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  reference: string;
  providerTransactionId: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  feeMinor: bigint | null;
  channel: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  /** Sanitized subset of the provider response kept for audit. Never contains card data. */
  raw: Record<string, unknown>;
}

export interface WebhookParse {
  signatureValid: boolean;
  eventKey: string;
  eventType: string;
  kind: 'PAYMENT' | 'REFUND' | 'OTHER';
  reference: string | null;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'SUCCEEDED' | 'PENDING';
}

/**
 * Contract every payment gateway integration implements. The ticketing engine only talks
 * to this interface, so a new provider is added by writing one adapter and registering it.
 */
export interface PaymentProviderAdapter {
  readonly code: string;
  /** Creates a hosted-checkout session. Card data is collected by the provider, never by this platform. */
  initialize(account: ProviderAccountCtx, input: InitializeInput): Promise<{ checkoutUrl: string; providerReference?: string }>;
  /** Server-to-server confirmation of a transaction's true state. */
  verify(account: ProviderAccountCtx, reference: string, providerTransactionId?: string | null): Promise<VerifiedPayment>;
  /** Authenticates a webhook against this account's secret and extracts its identity. */
  parseWebhook(account: ProviderAccountCtx, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookParse;
  refund(account: ProviderAccountCtx, input: { reference: string; providerTransactionId: string | null; amountMinor: bigint; currency: string; refundReference: string; reason: string }): Promise<RefundResult>;
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

async function http(url: string, init: RequestInit & { timeoutMs?: number }): Promise<{ status: number; ok: boolean; json: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

/** Converts a provider's decimal major-unit amount to integer minor units without floating point. */
export function majorToMinor(amount: string | number, minorUnits = 2): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(minorUnits) : String(amount);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`Unparseable amount: ${amount}`);
  const frac = (m[3] ?? '').padEnd(minorUnits, '0');
  if (frac.length > minorUnits && /[1-9]/.test(frac.slice(minorUnits))) throw new Error(`Amount has more precision than the currency allows: ${amount}`);
  const v = BigInt(m[2]) * 10n ** BigInt(minorUnits) + BigInt(frac.slice(0, minorUnits) || '0');
  return m[1] ? -v : v;
}
export function minorToMajor(minor: bigint, minorUnits = 2): string {
  const div = 10n ** BigInt(minorUnits);
  return minorUnits ? `${minor / div}.${(minor % div).toString().padStart(minorUnits, '0')}` : minor.toString();
}

// ───────────────────────── Paystack ─────────────────────────
// Credentials: { secretKey }. Webhooks are signed HMAC-SHA512(rawBody, secretKey) in x-paystack-signature.

@Injectable()
export class PaystackAdapter implements PaymentProviderAdapter {
  readonly code = 'paystack';
  private base = 'https://api.paystack.co';

  private headers(a: ProviderAccountCtx) {
    if (!a.credentials.secretKey) throw new AppError('PROVIDER_NOT_CONFIGURED', 'Paystack secret key is not configured for this merchant account', 500);
    return { Authorization: `Bearer ${a.credentials.secretKey}`, 'Content-Type': 'application/json' };
  }

  async initialize(a: ProviderAccountCtx, i: InitializeInput) {
    const r = await http(`${this.base}/transaction/initialize`, {
      method: 'POST', headers: this.headers(a),
      body: JSON.stringify({
        email: i.email, amount: i.amountMinor.toString(), currency: i.currency, reference: i.reference, callback_url: i.callbackUrl,
        metadata: i.metadata, channels: i.channels?.length ? i.channels : undefined,
      }),
    });
    if (!r.ok || !r.json?.status || !r.json?.data?.authorization_url) throw new Error(`Paystack initialize failed: ${r.json?.message ?? r.status}`);
    return { checkoutUrl: r.json.data.authorization_url as string, providerReference: r.json.data.access_code as string };
  }

  async verify(a: ProviderAccountCtx, reference: string): Promise<VerifiedPayment> {
    const r = await http(`${this.base}/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET', headers: this.headers(a) });
    if (r.status === 400 || r.status === 404) {
      return { status: 'PENDING', reference, providerTransactionId: null, amountMinor: null, currency: null, feeMinor: null, channel: null, paidAt: null, failureReason: r.json?.message ?? null, raw: { message: r.json?.message } };
    }
    if (!r.ok || !r.json?.data) throw new Error(`Paystack verify failed: ${r.json?.message ?? r.status}`);
    const d = r.json.data;
    const status = d.status === 'success' ? 'SUCCEEDED' : ['failed', 'abandoned', 'reversed'].includes(d.status) ? 'FAILED' : 'PENDING';
    return {
      status, reference: d.reference, providerTransactionId: d.id != null ? String(d.id) : null,
      amountMinor: d.amount != null ? BigInt(d.amount) : null, currency: d.currency ?? null,
      feeMinor: d.fees != null ? BigInt(d.fees) : null, channel: d.channel ?? null,
      paidAt: d.paid_at ? new Date(d.paid_at) : null, failureReason: status === 'FAILED' ? (d.gateway_response ?? d.status) : null,
      raw: { id: d.id, status: d.status, gateway_response: d.gateway_response, amount: d.amount, currency: d.currency, channel: d.channel, fees: d.fees, paid_at: d.paid_at, domain: d.domain },
    };
  }

  parseWebhook(a: ProviderAccountCtx, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookParse {
    const sig = header(headers, 'x-paystack-signature') ?? '';
    const signatureValid = !!a.credentials.secretKey && safeEqual(hmac('sha512', a.credentials.secretKey, rawBody), sig);
    let body: any = {};
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* invalid JSON is reported as an unsigned event */ }
    const eventType = String(body?.event ?? 'unknown');
    const d = body?.data ?? {};
    const kind = eventType.startsWith('charge.') ? 'PAYMENT' : eventType.startsWith('refund.') ? 'REFUND' : 'OTHER';
    return {
      signatureValid, eventType, kind,
      reference: kind === 'REFUND' ? (d.transaction_reference ?? null) : (d.reference ?? null),
      eventKey: `${eventType}:${d.id ?? d.reference ?? sha256(rawBody.toString('utf8')).slice(0, 32)}`,
    };
  }

  async refund(a: ProviderAccountCtx, i: { reference: string; amountMinor: bigint; currency: string; reason: string }): Promise<RefundResult> {
    const r = await http(`${this.base}/refund`, {
      method: 'POST', headers: this.headers(a),
      body: JSON.stringify({ transaction: i.reference, amount: i.amountMinor.toString(), currency: i.currency, merchant_note: i.reason.slice(0, 200) }),
    });
    if (!r.ok || !r.json?.status) throw new Error(`Paystack refund failed: ${r.json?.message ?? r.status}`);
    return { providerRefundId: String(r.json.data?.id ?? ''), status: r.json.data?.status === 'processed' ? 'SUCCEEDED' : 'PENDING' };
  }
}

// ───────────────────────── Flutterwave (v3) ─────────────────────────
// Credentials: { secretKey, webhookHash }. Webhooks carry the configured secret hash in the verif-hash header.

@Injectable()
export class FlutterwaveAdapter implements PaymentProviderAdapter {
  readonly code = 'flutterwave';
  private base = 'https://api.flutterwave.com/v3';

  private headers(a: ProviderAccountCtx) {
    if (!a.credentials.secretKey) throw new AppError('PROVIDER_NOT_CONFIGURED', 'Flutterwave secret key is not configured for this merchant account', 500);
    return { Authorization: `Bearer ${a.credentials.secretKey}`, 'Content-Type': 'application/json' };
  }

  async initialize(a: ProviderAccountCtx, i: InitializeInput) {
    const r = await http(`${this.base}/payments`, {
      method: 'POST', headers: this.headers(a),
      body: JSON.stringify({
        tx_ref: i.reference, amount: minorToMajor(i.amountMinor), currency: i.currency, redirect_url: i.callbackUrl,
        customer: { email: i.email, name: i.name }, meta: i.metadata,
      }),
    });
    if (!r.ok || r.json?.status !== 'success' || !r.json?.data?.link) throw new Error(`Flutterwave initialize failed: ${r.json?.message ?? r.status}`);
    return { checkoutUrl: r.json.data.link as string };
  }

  async verify(a: ProviderAccountCtx, reference: string, providerTransactionId?: string | null): Promise<VerifiedPayment> {
    const url = providerTransactionId
      ? `${this.base}/transactions/${encodeURIComponent(providerTransactionId)}/verify`
      : `${this.base}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;
    const r = await http(url, { method: 'GET', headers: this.headers(a) });
    if (r.status === 400 || r.status === 404) {
      return { status: 'PENDING', reference, providerTransactionId: null, amountMinor: null, currency: null, feeMinor: null, channel: null, paidAt: null, failureReason: r.json?.message ?? null, raw: { message: r.json?.message } };
    }
    if (!r.ok || !r.json?.data) throw new Error(`Flutterwave verify failed: ${r.json?.message ?? r.status}`);
    const d = r.json.data;
    const status = d.status === 'successful' ? 'SUCCEEDED' : d.status === 'failed' ? 'FAILED' : 'PENDING';
    return {
      status, reference: d.tx_ref, providerTransactionId: d.id != null ? String(d.id) : null,
      // charged_amount can include customer-borne fees; `amount` is the value we asked to collect.
      amountMinor: d.amount != null ? majorToMinor(d.amount) : null, currency: d.currency ?? null,
      feeMinor: d.app_fee != null ? majorToMinor(Number(d.app_fee).toFixed(2)) : null, channel: d.payment_type ?? null,
      paidAt: d.created_at ? new Date(d.created_at) : null, failureReason: status === 'FAILED' ? (d.processor_response ?? d.status) : null,
      raw: { id: d.id, status: d.status, processor_response: d.processor_response, amount: d.amount, charged_amount: d.charged_amount, currency: d.currency, payment_type: d.payment_type, app_fee: d.app_fee, account_id: d.account_id },
    };
  }

  parseWebhook(a: ProviderAccountCtx, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookParse {
    const sig = header(headers, 'verif-hash') ?? '';
    const signatureValid = !!a.credentials.webhookHash && safeEqual(a.credentials.webhookHash, sig);
    let body: any = {};
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* invalid JSON is reported as an unsigned event */ }
    const eventType = String(body?.event ?? body?.['event.type'] ?? 'unknown');
    const d = body?.data ?? {};
    const kind = eventType.startsWith('charge.') ? 'PAYMENT' : eventType.startsWith('refund') ? 'REFUND' : 'OTHER';
    return { signatureValid, eventType, kind, reference: d.tx_ref ?? d.txRef ?? null, eventKey: `${eventType}:${d.id ?? d.tx_ref ?? sha256(rawBody.toString('utf8')).slice(0, 32)}:${d.status ?? ''}` };
  }

  async refund(a: ProviderAccountCtx, i: { providerTransactionId: string | null; amountMinor: bigint; reason: string }): Promise<RefundResult> {
    if (!i.providerTransactionId) throw new Error('Flutterwave refund requires the provider transaction id');
    const r = await http(`${this.base}/transactions/${encodeURIComponent(i.providerTransactionId)}/refund`, {
      method: 'POST', headers: this.headers(a), body: JSON.stringify({ amount: minorToMajor(i.amountMinor), comments: i.reason.slice(0, 200) }),
    });
    if (!r.ok || r.json?.status !== 'success') throw new Error(`Flutterwave refund failed: ${r.json?.message ?? r.status}`);
    return { providerRefundId: String(r.json.data?.id ?? ''), status: String(r.json.data?.status ?? '').startsWith('completed') ? 'SUCCEEDED' : 'PENDING' };
  }
}

// ───────────────────────── Sandbox (test-only) ─────────────────────────
// A self-contained stand-in gateway for development and automated tests. It has its own
// transaction table, a hosted checkout page and HMAC-SHA256 signed webhooks, so the platform
// exercises exactly the same code path as with a real provider. It never moves real money;
// orders paid through it are flagged livemode=false everywhere.

@Injectable()
export class SandboxAdapter implements PaymentProviderAdapter {
  readonly code = 'sandbox';
  constructor(private prisma: PrismaService) {}

  private assertAllowed() {
    if (config.isProd && !config.allowSandboxProvider) throw new AppError('SANDBOX_DISABLED', 'The sandbox payment provider is disabled in production', 500);
  }

  async initialize(a: ProviderAccountCtx, i: InitializeInput) {
    this.assertAllowed();
    await this.prisma.sandboxGatewayTransaction.create({
      data: { reference: i.reference, transactionId: `sbx_${randomUUID()}`, providerAccountId: a.id, amountMinor: i.amountMinor, currency: i.currency, email: i.email, callbackUrl: i.callbackUrl },
    });
    return { checkoutUrl: `${config.apiPublicUrl}/sandbox-gateway/pay/${encodeURIComponent(i.reference)}` };
  }

  async verify(a: ProviderAccountCtx, reference: string): Promise<VerifiedPayment> {
    this.assertAllowed();
    const t = await this.prisma.sandboxGatewayTransaction.findUnique({ where: { reference } });
    if (!t || t.providerAccountId !== a.id) {
      return { status: 'PENDING', reference, providerTransactionId: null, amountMinor: null, currency: null, feeMinor: null, channel: null, paidAt: null, failureReason: 'Unknown transaction', raw: {} };
    }
    const status = t.status === 'success' ? 'SUCCEEDED' : t.status === 'failed' ? 'FAILED' : 'PENDING';
    return {
      status, reference, providerTransactionId: t.transactionId, amountMinor: t.amountMinor, currency: t.currency,
      feeMinor: status === 'SUCCEEDED' ? (t.amountMinor * 150n + 5000n) / 10000n : null, // simulated 1.5% gateway charge
      channel: 'sandbox', paidAt: status === 'SUCCEEDED' ? new Date() : null, failureReason: status === 'FAILED' ? 'Declined in sandbox' : null,
      raw: { sandbox: true, status: t.status, amount: Number(t.amountMinor), currency: t.currency },
    };
  }

  signature(a: ProviderAccountCtx, rawBody: Buffer | string) {
    return hmac('sha256', a.credentials.webhookSecret ?? '', rawBody);
  }

  parseWebhook(a: ProviderAccountCtx, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookParse {
    const sig = header(headers, 'x-sandbox-signature') ?? '';
    const signatureValid = !!a.credentials.webhookSecret && safeEqual(this.signature(a, rawBody), sig);
    let body: any = {};
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* invalid JSON is reported as an unsigned event */ }
    const eventType = String(body?.event ?? 'unknown');
    return {
      signatureValid, eventType, kind: eventType.startsWith('charge.') ? 'PAYMENT' : eventType.startsWith('refund.') ? 'REFUND' : 'OTHER',
      reference: body?.data?.reference ?? null, eventKey: String(body?.id ?? sha256(rawBody.toString('utf8')).slice(0, 32)),
    };
  }

  async refund(a: ProviderAccountCtx, i: { reference: string; amountMinor: bigint }): Promise<RefundResult> {
    this.assertAllowed();
    const n = await this.prisma.$executeRaw`
      UPDATE "sandbox_gateway_transactions" SET "refundedMinor" = "refundedMinor" + ${i.amountMinor}
       WHERE "reference" = ${i.reference} AND "providerAccountId" = ${a.id}::uuid AND "status" = 'success'
         AND "refundedMinor" + ${i.amountMinor} <= "amountMinor"`;
    if (n !== 1) throw new Error('Sandbox gateway refused the refund (unknown transaction or amount exceeds captured funds)');
    return { providerRefundId: `sbxr_${randomUUID()}`, status: 'SUCCEEDED' };
  }
}

@Injectable()
export class ProviderRegistry {
  private adapters = new Map<string, PaymentProviderAdapter>();
  constructor(paystack: PaystackAdapter, flutterwave: FlutterwaveAdapter, readonly sandbox: SandboxAdapter) {
    for (const a of [paystack, flutterwave, sandbox]) this.adapters.set(a.code, a);
  }
  get(code: string): PaymentProviderAdapter {
    const a = this.adapters.get(code);
    if (!a) throw new AppError('PROVIDER_UNSUPPORTED', `No integration is registered for payment provider "${code}"`, 500);
    return a;
  }
}
