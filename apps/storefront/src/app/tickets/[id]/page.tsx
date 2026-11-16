import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '@/components/forms';
import { TicketCard } from '@/components/ticket-card';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

export const metadata: Metadata = { title: 'Your ticket', robots: { index: false } };

export default async function TicketPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ orderReference?: string; ticketReference?: string; email?: string; claimed?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const query = { orderReference: sp.orderReference, ticketReference: sp.ticketReference, email: sp.email };
  const res = /^[0-9a-f-]{36}$/i.test(id) ? await api<any>('GET', `/tickets/${id}`, { query }) : null;
  if (!res?.ok) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-2xl font-bold">Ticket not found</h1>
        <Notice kind="error">We could not open this ticket. Sign in to the account that holds it, or use the link from your email.</Notice>
        <p><Link href="/account" className="link">Go to my account</Link></p>
      </div>
    );
  }
  const t = res.data;
  const access = new URLSearchParams(Object.entries(query).filter(([, v]) => !!v) as [string, string][]).toString();
  return (
    <div className="mx-auto max-w-md space-y-5">
      {sp.claimed && <Notice kind="ok">The ticket is now yours. The previous QR code no longer works.</Notice>}
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t.event.name}</h1>
        <p className="text-sm text-slate-600">{when(t.event.startsAt, t.event.timezone)}</p>
        {t.event.venue && <p className="text-sm text-slate-600">{t.event.venue.name}, {t.event.venue.city}</p>}
      </header>
      <TicketCard ticket={t} pdfHref={t.status === 'VALID' ? `/tickets/${t.id}/pdf${access ? `?${access}` : ''}` : null} />
      <p className="text-sm text-slate-600">Show this QR code at the entrance. It admits one person and can be scanned once.</p>
    </div>
  );
}
