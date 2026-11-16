import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { consentAction, logoutAction, resendVerificationAction, transferAction } from '@/app/actions';
import { ActionForm, Field, Notice } from '@/components/forms';
import { api, getBrand, getMe } from '@/lib/api';
import { humanize, money, when } from '@/lib/format';

export const metadata: Metadata = { title: 'My account', robots: { index: false } };

const CHANNELS: ['EMAIL' | 'SMS' | 'WHATSAPP', string][] = [['EMAIL', 'Email'], ['SMS', 'SMS'], ['WHATSAPP', 'WhatsApp']];

export default async function Account({ searchParams }: { searchParams: Promise<{ welcome?: string; verified?: string }> }) {
  const me = await getMe();
  if (!me) redirect('/account/login?next=/account');
  const [sp, brand, orders, tickets] = await Promise.all([
    searchParams, getBrand(),
    api<{ items: any[]; emailVerificationRequired: boolean }>('GET', '/customers/me/orders'),
    api<{ items: any[]; emailVerificationRequired: boolean }>('GET', '/customers/me/tickets'),
  ]);
  const brandName = brand.ok ? brand.data.name : 'this store';
  const now = Date.now();

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hello, {me.fullName.split(' ')[0]}</h1>
          <p className="text-sm text-slate-600">{me.email}{me.phone ? ` · ${me.phone}` : ''}</p>
        </div>
        <form action={logoutAction}><button className="btn-secondary h-10">Sign out</button></form>
      </header>

      {sp.welcome && <Notice kind="ok">Your account has been created. We have emailed you a link to confirm your address.</Notice>}
      {sp.verified && <Notice kind="ok">Thank you, your email address is confirmed.</Notice>}

      {!me.emailVerified && (
        <section className="card space-y-3 border-amber-200 bg-amber-50">
          <h2 className="font-semibold text-amber-900">Confirm your email address</h2>
          <p className="text-sm text-amber-900">
            To protect your orders, we only show orders and tickets once you have confirmed that {me.email} belongs to you. Open the link in the email we sent you.
          </p>
          <ActionForm action={resendVerificationAction} submit="Resend confirmation email" variant="secondary" className="space-y-3" />
        </section>
      )}

      <section aria-labelledby="tickets-h">
        <h2 id="tickets-h" className="mb-3 text-lg font-semibold">My tickets</h2>
        {!tickets.ok ? <Notice kind="error">{tickets.error.message}</Notice>
          : tickets.data.emailVerificationRequired ? <p className="card text-sm text-slate-600">Confirm your email address to see your tickets.</p>
          : tickets.data.items.length === 0 ? <p className="card text-sm text-slate-600">You have no tickets yet. <Link href="/" className="link">Browse events</Link>.</p>
          : (
            <ul className="grid gap-4 md:grid-cols-2">
              {tickets.data.items.map((t) => {
                const transferable = t.status === 'VALID' && new Date(t.event.startsAt).getTime() > now;
                return (
                  <li key={t.id} className="card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900">{t.event.name}</p>
                        <p className="text-sm text-slate-600">{when(t.event.startsAt, t.event.timezone, 'short')}{t.event.venue ? ` · ${t.event.venue}` : ''}</p>
                        <p className="mt-1 text-sm">{t.category} · <span className="font-mono text-xs">{t.reference}</span></p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${t.status === 'VALID' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{humanize(t.status)}</span>
                    </div>
                    {t.status === 'VALID' && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link href={`/tickets/${t.id}`} className="btn-primary h-10">Show QR code</Link>
                        <a href={`/tickets/${t.id}/pdf`} className="btn-secondary h-10">Download PDF</a>
                      </div>
                    )}
                    {transferable && (
                      <details className="mt-3 rounded-lg bg-slate-50 p-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-800">Transfer to someone</summary>
                        <p className="my-2 text-xs text-slate-600">They get an email with a link to accept. The ticket stays yours until they do; your QR code then stops working.</p>
                        <ActionForm action={transferAction} submit="Send transfer" variant="secondary" hideOnSuccess>
                          <input type="hidden" name="ticketId" value={t.id} />
                          <Field label="Their email address" name="toEmail" type="email" required />
                          <Field label="Their name" name="toName" />
                        </ActionForm>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </section>

      <section aria-labelledby="orders-h">
        <h2 id="orders-h" className="mb-3 text-lg font-semibold">My orders</h2>
        {!orders.ok ? <Notice kind="error">{orders.error.message}</Notice>
          : orders.data.emailVerificationRequired ? <p className="card text-sm text-slate-600">Confirm your email address to see your orders.</p>
          : orders.data.items.length === 0 ? <p className="card text-sm text-slate-600">You have not placed any orders with {brandName} yet.</p>
          : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
              {orders.data.items.map((o) => (
                <li key={o.reference}>
                  <Link href={`/orders/${o.reference}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{o.event.name}</p>
                      <p className="text-sm text-slate-600">{o.items.map((i: any) => `${i.quantity} × ${i.name}`).join(', ')} · <span className="font-mono text-xs">{o.reference}</span></p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums">{money(o.totalMinor, o.currency)}</p>
                      <p className="text-xs text-slate-500">{humanize(o.status)}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section id="preferences" aria-labelledby="prefs-h" className="card">
        <h2 id="prefs-h" className="text-lg font-semibold">News and offers from {brandName}</h2>
        <p className="mb-4 mt-1 text-sm text-slate-600">
          These choices apply to {brandName} only. Order confirmations and tickets are always sent, whatever you choose here.
        </p>
        <ul className="space-y-3">
          {CHANNELS.map(([channel, label]) => {
            const on = me.consents?.[channel] ?? false;
            return (
              <li key={channel} className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm"><strong>{label}</strong> · {on ? 'Subscribed' : 'Not subscribed'}</span>
                <ActionForm action={consentAction} submit={on ? 'Unsubscribe' : 'Subscribe'} variant="secondary" className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="channel" value={channel} />
                  <input type="hidden" name="granted" value={String(!on)} />
                </ActionForm>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
