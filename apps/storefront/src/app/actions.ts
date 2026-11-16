'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, clearCustomerToken, getMe, setCustomerToken, site } from '@/lib/api';

/** Result shape for forms using useActionState. */
export interface FormState {
  error?: string;
  code?: string;
  ok?: string;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
/** Only same-site paths are accepted as a post-login destination. */
const safeNext = (next: string, fallback: string) => (next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback);

// ───────────────────────── Checkout ─────────────────────────

export interface CartItem {
  ticketCategoryId: string;
  quantity: number;
}
export interface QuoteResult {
  ok: boolean;
  error?: string;
  code?: string;
  quote?: {
    currency: string;
    lines: { ticketCategoryId: string; categoryName: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
    subtotalMinor: number;
    discountMinor: number;
    feesMinor: number;
    taxMinor: number;
    totalMinor: number;
    promoCode: string | null;
  };
}

/** Prices the basket with the central API. The browser never calculates totals itself. */
export async function quoteAction(eventId: string, items: CartItem[], promoCode?: string): Promise<QuoteResult> {
  const r = await api('POST', '/checkout/quote', { body: { eventId, items, promoCode: promoCode || undefined }, customer: false });
  return r.ok ? { ok: true, quote: r.data } : { ok: false, error: r.error.message, code: r.error.code };
}

export interface CheckoutInput {
  eventId: string;
  items: CartItem[];
  promoCode?: string;
  customer: { email: string; fullName: string; phone?: string; country?: string };
  acceptPolicies: boolean;
  marketingOptIn: boolean;
  campaignToken?: string;
  /** Generated in the browser for this exact basket; resubmitting the same basket reuses it. */
  idempotencyKey: string;
}

/**
 * Creates the order and reserves tickets, then returns the hosted payment page to send the
 * buyer to. The return URL points back at this storefront's order page, which re-checks the
 * real status with the platform rather than trusting anything on the URL.
 */
export async function checkoutAction(input: CheckoutInput): Promise<{ ok: boolean; error?: string; code?: string; redirectTo?: string }> {
  const s = await site();
  if (!s) return { ok: false, error: 'This storefront is not configured' };
  if (!/^[\w-]{8,100}$/.test(input.idempotencyKey)) return { ok: false, error: 'Please reload the page and try again' };
  const email = input.customer.email.trim().toLowerCase();
  const r = await api('POST', '/checkout/orders', {
    idempotencyKey: input.idempotencyKey,
    body: {
      eventId: input.eventId,
      items: input.items,
      promoCode: input.promoCode || undefined,
      customer: { email, fullName: input.customer.fullName.trim(), phone: input.customer.phone?.trim() || undefined, country: input.customer.country?.trim() || undefined },
      acceptPolicies: input.acceptPolicies,
      marketingOptIn: input.marketingOptIn || undefined,
      campaignToken: input.campaignToken || undefined,
      // The order reference does not exist yet, so the gateway returns the buyer to /orders/return,
      // which finds the order from an httpOnly cookie set below (never from gateway URL parameters).
      returnUrl: `${s.origin}/orders/return`,
    },
  });
  if (!r.ok) return { ok: false, error: r.error.message.replace(/\bcustomer\.(\w+)/g, (_, k: string) => (k === 'fullName' ? 'full name' : k)), code: r.error.code };
  const orderUrl = `/orders/${r.data.orderReference}?email=${encodeURIComponent(email)}`;
  (await cookies()).set('sf_co', JSON.stringify({ ref: r.data.orderReference, email }), { httpOnly: true, sameSite: 'lax', secure: s.origin.startsWith('https://'), path: '/orders', maxAge: 2 * 3600 });
  return { ok: true, redirectTo: r.data.payment?.checkoutUrl ?? orderUrl };
}

export async function payAgainAction(_: FormState, f: FormData): Promise<FormState> {
  const ref = str(f, 'reference');
  const r = await api('POST', `/orders/${encodeURIComponent(ref)}/pay`, { query: { email: str(f, 'email') } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  redirect(r.data.checkoutUrl);
}

export async function cancelOrderAction(_: FormState, f: FormData): Promise<FormState> {
  const ref = str(f, 'reference');
  const email = str(f, 'email');
  const r = await api('POST', `/orders/${encodeURIComponent(ref)}/cancel`, { query: { email } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  redirect(`/orders/${encodeURIComponent(ref)}?email=${encodeURIComponent(email)}`);
}

export async function lookupOrderAction(_: FormState, f: FormData): Promise<FormState> {
  const ref = str(f, 'reference').toUpperCase();
  const email = str(f, 'email').toLowerCase();
  if (!ref || !email) return { error: 'Enter your order reference and email address' };
  const r = await api('GET', `/orders/${encodeURIComponent(ref)}`, { query: { email } });
  if (!r.ok) return { error: r.status === 404 ? 'We could not find an order with that reference and email address.' : r.error.message };
  redirect(`/orders/${encodeURIComponent(ref)}?email=${encodeURIComponent(email)}`);
}

// ───────────────────────── Account ─────────────────────────

export async function registerAction(_: FormState, f: FormData): Promise<FormState> {
  const r = await api('POST', '/customers/register', {
    customer: false,
    body: {
      email: str(f, 'email'), password: String(f.get('password') ?? ''), fullName: str(f, 'fullName'), phone: str(f, 'phone') || undefined,
      country: str(f, 'country') || undefined, marketingOptIn: f.get('marketingOptIn') === 'on' || undefined,
    },
  });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  await setCustomerToken(r.data.token);
  redirect('/account?welcome=1');
}

export async function loginAction(_: FormState, f: FormData): Promise<FormState> {
  const r = await api('POST', '/customers/login', { customer: false, body: { email: str(f, 'email'), password: String(f.get('password') ?? '') } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  await setCustomerToken(r.data.token);
  redirect(safeNext(str(f, 'next'), '/account'));
}

export async function logoutAction() {
  await clearCustomerToken();
  redirect('/');
}

export async function verifyEmailAction(_: FormState, f: FormData): Promise<FormState> {
  const r = await api('POST', '/customers/verify-email', { body: { token: str(f, 'token') } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  // Linking to an existing central identity changes the customer id inside the session token.
  await setCustomerToken(r.data.token);
  redirect('/account?verified=1');
}

export async function resendVerificationAction(_: FormState, _f: FormData): Promise<FormState> {
  const r = await api('POST', '/customers/resend-verification');
  if (!r.ok) return { error: r.error.message };
  return { ok: r.data.alreadyVerified ? 'Your email address is already confirmed.' : 'We have sent a new confirmation link. Please check your inbox.' };
}

export async function requestResetAction(_: FormState, f: FormData): Promise<FormState> {
  const r = await api('POST', '/customers/password-reset/request', { customer: false, body: { email: str(f, 'email') } });
  if (!r.ok) return { error: r.error.message };
  return { ok: 'If an account exists for that email address, we have sent a link to reset the password.' };
}

export async function confirmResetAction(_: FormState, f: FormData): Promise<FormState> {
  const password = String(f.get('password') ?? '');
  if (password !== String(f.get('confirm') ?? '')) return { error: 'The two passwords do not match' };
  const r = await api('POST', '/customers/password-reset/confirm', { customer: false, body: { token: str(f, 'token'), password } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  await clearCustomerToken(); // every earlier session was revoked by the reset
  redirect('/account/login?reset=1');
}

export async function consentAction(_: FormState, f: FormData): Promise<FormState> {
  const granted = str(f, 'granted') === 'true';
  const r = await api('PUT', '/customers/me/consents', { body: { channel: str(f, 'channel'), granted } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  redirect('/account#preferences');
}

export async function transferAction(_: FormState, f: FormData): Promise<FormState> {
  const r = await api('POST', `/tickets/${encodeURIComponent(str(f, 'ticketId'))}/transfer`, { body: { toEmail: str(f, 'toEmail'), toName: str(f, 'toName') || undefined } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  return { ok: `We have emailed ${r.data.toEmail} a link to accept the ticket. It stays yours until they accept.` };
}

export async function claimTransferAction(_: FormState, f: FormData): Promise<FormState> {
  const email = str(f, 'email').toLowerCase();
  const r = await api('POST', '/tickets/transfers/claim', { customer: false, body: { token: str(f, 'token') } });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  redirect(`/tickets/${r.data.ticketId}?ticketReference=${encodeURIComponent(r.data.ticketReference)}&email=${encodeURIComponent(email)}&claimed=1`);
}

// ───────────────────────── Support ─────────────────────────

export async function supportAction(_: FormState, f: FormData): Promise<FormState> {
  const me = await getMe();
  const r = await api('POST', '/support/tickets', {
    body: {
      email: me?.email ?? str(f, 'email'), name: str(f, 'name') || undefined, subject: str(f, 'subject'), message: str(f, 'message'),
      issueType: str(f, 'issueType') || undefined, orderReference: str(f, 'orderReference') || undefined,
    },
  });
  if (!r.ok) return { error: r.error.message, code: r.error.code };
  return { ok: `Thank you. Your request ${r.data.reference} has been received and our team will reply by email.` };
}
