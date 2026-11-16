'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { quoteAction, QuoteResult } from '@/app/actions';
import { money } from '@/lib/format';
import { Notice } from './forms';

export interface Category {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  minPerOrder: number;
  maxPerOrder: number;
  onSale: boolean;
  unavailableReason: string | null;
  available?: number | null;
  lowStock?: boolean;
}

const REASONS: Record<string, string> = {
  SOLD_OUT: 'Sold out', SALES_NOT_STARTED: 'Not on sale yet', SALES_ENDED: 'Sales have ended', EVENT_ENDED: 'Event has ended', EVENT_NOT_ON_SALE: 'Not on sale',
  CATEGORY_CLOSED: 'Not available', NOT_AVAILABLE: 'Not available',
};

export function TicketPicker({ eventId, categories, brandName, acceptingOrders, campaignToken, buyer }: {
  eventId: string;
  categories: Category[];
  brandName: string;
  acceptingOrders: boolean;
  campaignToken?: string;
  buyer?: { email: string; fullName: string; phone: string; country: string } | null;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState('');
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [form, setForm] = useState({ email: buyer?.email ?? '', fullName: buyer?.fullName ?? '', phone: buyer?.phone ?? '', country: buyer?.country ?? '' });
  const [accept, setAccept] = useState(false);
  const [marketing, setMarketing] = useState(false); // consent is never pre-ticked
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const items = useMemo(() => Object.entries(qty).filter(([, q]) => q > 0).map(([ticketCategoryId, quantity]) => ({ ticketCategoryId, quantity })), [qty]);
  const basketKey = JSON.stringify([items, promo]);

  // Totals always come from the platform (fees, tax and promo rules live there).
  useEffect(() => {
    if (!items.length) {
      setQuote(null);
      return;
    }
    let stale = false;
    setQuoting(true);
    const t = setTimeout(async () => {
      const r = await quoteAction(eventId, items, promo || undefined);
      if (!stale) {
        setQuote(r);
        setQuoting(false);
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketKey, eventId]);

  // One idempotency key per distinct order request: a double click or a retry of the same
  // basket reuses it (so it cannot create two orders); changing anything gets a fresh key.
  const idem = useRef<{ signature: string; key: string } | null>(null);
  const keyFor = (signature: string) => {
    if (idem.current?.signature !== signature) idem.current = { signature, key: crypto.randomUUID() };
    return idem.current.key;
  };

  const step = (c: Category, delta: number) =>
    setQty((s) => {
      const cur = s[c.id] ?? 0;
      let next = cur + delta;
      if (delta > 0 && cur === 0) next = c.minPerOrder;
      if (delta < 0 && next < c.minPerOrder) next = 0;
      const cap = Math.min(c.maxPerOrder, c.available ?? c.maxPerOrder);
      return { ...s, [c.id]: Math.max(0, Math.min(cap, next)) };
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const payload = { eventId, items, promoCode: promo || undefined, customer: form, acceptPolicies: accept, marketingOptIn: marketing, campaignToken };
    let r: { ok: boolean; error?: string; code?: string; redirectTo?: string };
    try {
      const res = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, idempotencyKey: keyFor(JSON.stringify(payload)) }) });
      r = await res.json();
    } catch {
      // Network failure: keep the key so pressing the button again cannot create a second order.
      setError({ message: 'We could not reach the server. Check your connection and try again.' });
      setSubmitting(false);
      return;
    }
    if (r.ok && r.redirectTo) {
      window.location.assign(r.redirectTo); // hosted payment page of the gateway
      return;
    }
    idem.current = null; // a failed request released its key on the platform
    setError({ message: r.error ?? 'Something went wrong. Please try again.', code: r.code });
    setSubmitting(false);
  };

  const q = quote?.ok ? quote.quote! : null;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section aria-labelledby="tickets-h">
        <h2 id="tickets-h" className="mb-3 text-lg font-semibold">Tickets</h2>
        <ul className="space-y-3">
          {categories.map((c) => {
            const n = qty[c.id] ?? 0;
            const disabled = !c.onSale || !acceptingOrders;
            return (
              <li key={c.id} className={`card flex flex-wrap items-center justify-between gap-4 ${disabled ? 'opacity-70' : ''}`}>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900">{c.name}</div>
                  {c.description && <div className="text-sm text-slate-600">{c.description}</div>}
                  <div className="mt-1 text-sm font-semibold text-brand-ink">{money(c.priceMinor, c.currency)}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {c.minPerOrder > 1 ? `Minimum ${c.minPerOrder}, m` : 'M'}aximum {c.maxPerOrder} per order
                    {c.onSale && c.lowStock && c.available ? <span className="ml-2 font-semibold text-amber-700">Only {c.available} left</span> : null}
                  </div>
                </div>
                {disabled ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600">{!c.onSale ? (REASONS[c.unavailableReason ?? ''] ?? 'Not available') : 'Unavailable'}</span>
                ) : (
                  <div className="flex items-center gap-2" role="group" aria-label={`Quantity of ${c.name}`}>
                    <button type="button" onClick={() => step(c, -1)} disabled={n === 0} aria-label={`Fewer ${c.name} tickets`} className="grid h-10 w-10 place-items-center rounded-lg bg-white text-lg font-semibold ring-1 ring-inset ring-slate-300 disabled:opacity-40">−</button>
                    <span aria-live="polite" className="w-8 text-center font-semibold tabular-nums">{n}</span>
                    <button type="button" onClick={() => step(c, 1)} disabled={n >= Math.min(c.maxPerOrder, c.available ?? c.maxPerOrder)} aria-label={`More ${c.name} tickets`} className="grid h-10 w-10 place-items-center rounded-lg bg-brand text-lg font-semibold text-brand-fg disabled:opacity-40">+</button>
                  </div>
                )}
              </li>
            );
          })}
          {categories.length === 0 && <li className="card text-sm text-slate-600">Tickets for this event are not available yet.</li>}
        </ul>
      </section>

      <aside aria-labelledby="summary-h" className="card h-fit lg:sticky lg:top-4">
        <h2 id="summary-h" className="mb-3 text-lg font-semibold">Order summary</h2>
        {!items.length ? (
          <p className="text-sm text-slate-600">Choose your tickets to see the total.</p>
        ) : (
          <>
            {quote && !quote.ok && <Notice kind="error">{quote.error}</Notice>}
            {q && (
              <dl className={`space-y-1.5 text-sm ${quoting ? 'opacity-60' : ''}`}>
                {q.lines.map((l) => (
                  <div key={l.ticketCategoryId} className="flex justify-between gap-3"><dt>{l.quantity} × {l.categoryName}</dt><dd className="tabular-nums">{money(l.lineTotalMinor, q.currency)}</dd></div>
                ))}
                {q.discountMinor > 0 && <div className="flex justify-between gap-3 text-emerald-700"><dt>Discount{q.promoCode ? ` (${q.promoCode})` : ''}</dt><dd className="tabular-nums">−{money(q.discountMinor, q.currency)}</dd></div>}
                {q.feesMinor > 0 && <div className="flex justify-between gap-3 text-slate-600"><dt>Service fee</dt><dd className="tabular-nums">{money(q.feesMinor, q.currency)}</dd></div>}
                {q.taxMinor > 0 && <div className="flex justify-between gap-3 text-slate-600"><dt>Tax</dt><dd className="tabular-nums">{money(q.taxMinor, q.currency)}</dd></div>}
                <div className="flex justify-between gap-3 border-t border-slate-200 pt-2 text-base font-bold"><dt>Total</dt><dd className="tabular-nums">{money(q.totalMinor, q.currency)}</dd></div>
              </dl>
            )}
            {!quote && <p className="text-sm text-slate-500">Calculating…</p>}

            <div className="mt-4 flex gap-2">
              <label className="sr-only" htmlFor="promo">Promo code</label>
              <input id="promo" className="input h-10 uppercase" placeholder="Promo code" value={promoInput} onChange={(e) => setPromoInput(e.target.value)} />
              <button type="button" className="btn-secondary h-10 px-3" onClick={() => setPromo(promoInput.trim().toUpperCase())}>Apply</button>
            </div>
            {promo && quote && !quote.ok && <button type="button" className="link mt-1 text-xs" onClick={() => { setPromo(''); setPromoInput(''); }}>Remove promo code</button>}

            <form onSubmit={submit} className="mt-5 space-y-3 border-t border-slate-200 pt-4">
              <h3 className="font-semibold">Your details</h3>
              <label className="block"><span className="label">Email address</span><input className="input" type="email" required autoComplete="email" value={form.email} onChange={set('email')} readOnly={!!buyer} /></label>
              <label className="block"><span className="label">Full name</span><input className="input" required minLength={2} autoComplete="name" value={form.fullName} onChange={set('fullName')} /></label>
              <label className="block"><span className="label">Phone <span className="font-normal text-slate-400">(optional)</span></span><input className="input" type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} /></label>
              <label className="block"><span className="label">Country <span className="font-normal text-slate-400">(optional)</span></span><input className="input" autoComplete="country-name" value={form.country} onChange={set('country')} /></label>
              <label className="flex items-start gap-2.5 text-sm">
                <input type="checkbox" required checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>I accept the <Link href="/terms" target="_blank" className="link">terms and conditions</Link> and the <Link href="/refund-policy" target="_blank" className="link">refund policy</Link>.</span>
              </label>
              <label className="flex items-start gap-2.5 text-sm text-slate-700">
                <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>Send me news and offers from {brandName}. <span className="text-slate-500">Optional. You can unsubscribe at any time.</span></span>
              </label>
              {error && (
                <Notice kind="error">
                  {error.message}
                  {error.code === 'INSUFFICIENT_INVENTORY' && ' Please reduce the quantity or choose another ticket type.'}
                </Notice>
              )}
              <button type="submit" className="btn-primary w-full" disabled={submitting || !q || quoting}>
                {submitting ? 'Reserving your tickets…' : q ? (q.totalMinor === 0 ? 'Get tickets' : `Continue to payment · ${money(q.totalMinor, q.currency)}`) : 'Continue to payment'}
              </button>
              <p className="text-xs text-slate-500">Your tickets are held for a short time while you pay on our payment partner&apos;s secure page. We never see your card details.</p>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
