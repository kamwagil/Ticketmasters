import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Notice } from '@/components/forms';
import { Category, TicketPicker } from '@/components/ticket-picker';
import { api, getBrand, getMe } from '@/lib/api';
import { when } from '@/lib/format';

interface EventDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  category: { slug: string; name: string } | null;
  posterUrl: string | null;
  gallery: string[];
  startsAt: string;
  endsAt: string | null;
  doorsAt: string | null;
  timezone: string;
  venue: { name: string; address: string | null; city: string; country: string } | null;
  performers: { id: string; name: string; type: string }[];
  organizer: string | null;
  policies: string | null;
  ticketCategories: Category[];
}

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ ct?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await api<EventDetail>('GET', `/events/${encodeURIComponent((await params).slug)}`, { customer: false });
  return r.ok ? { title: r.data.name, description: r.data.description.slice(0, 160) } : { title: 'Event' };
}

export default async function EventPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { ct } = await searchParams;
  const [brand, res, me] = await Promise.all([getBrand(), api<EventDetail>('GET', `/events/${encodeURIComponent(slug)}`, { customer: false }), getMe()]);
  if (!brand.ok) return null;
  if (!res.ok) {
    if (res.status === 404) notFound();
    return <Notice kind={res.error.code === 'BRAND_NOT_ACTIVE' ? 'info' : 'error'}>{res.error.code === 'BRAND_NOT_ACTIVE' ? 'This event is not on sale at the moment.' : res.error.message}</Notice>;
  }
  const e = res.data;
  const closed = e.status === 'CANCELLED' || e.status === 'COMPLETED';

  return (
    <article>
      <p className="mb-3 text-sm"><Link href="/" className="link">← All events</Link></p>
      <div className="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid md:grid-cols-[2fr_3fr]">
        <div className="relative min-h-[12rem]" style={e.posterUrl ? undefined : { background: 'linear-gradient(135deg, var(--brand), var(--accent))' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {e.posterUrl ? <img src={e.posterUrl} alt="" className="h-full w-full object-cover" /> : <span aria-hidden className="absolute inset-0 grid place-items-center text-2xl font-bold text-brand-fg">{e.category?.name ?? brand.data.name}</span>}
        </div>
        <div className="p-6">
          {e.category && <p className="text-xs font-semibold uppercase tracking-wide text-brand-ink">{e.category.name}</p>}
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{e.name}</h1>
          <dl className="mt-4 space-y-2 text-sm">
            <div><dt className="font-semibold text-slate-900">When</dt><dd className="text-slate-700">{when(e.startsAt, e.timezone)}{e.doorsAt ? ` (doors ${when(e.doorsAt, e.timezone, 'short').split(', ').pop()})` : ''}</dd></div>
            {e.venue && <div><dt className="font-semibold text-slate-900">Where</dt><dd className="text-slate-700">{e.venue.name}{e.venue.address ? `, ${e.venue.address}` : `, ${e.venue.city}`}, {e.venue.country}</dd></div>}
            {e.performers.length > 0 && <div><dt className="font-semibold text-slate-900">Line-up</dt><dd className="text-slate-700">{e.performers.map((p) => p.name).join(' · ')}</dd></div>}
            {e.organizer && <div><dt className="font-semibold text-slate-900">Presented by</dt><dd className="text-slate-700">{e.organizer}</dd></div>}
          </dl>
        </div>
      </div>

      {e.status === 'CANCELLED' && <div className="mb-6"><Notice kind="error">This event has been cancelled. If you hold tickets, please see our <Link href="/refund-policy" className="underline">refund policy</Link> or <Link href="/support" className="underline">contact support</Link>.</Notice></div>}
      {e.status === 'POSTPONED' && <div className="mb-6"><Notice kind="info">This event has been rescheduled. The date shown above is the new date; existing tickets remain valid.</Notice></div>}
      {e.status === 'COMPLETED' && <div className="mb-6"><Notice kind="info">This event has taken place.</Notice></div>}

      {e.description && <section className="mb-8 max-w-3xl whitespace-pre-line text-slate-700">{e.description}</section>}

      {!closed && (
        <TicketPicker
          eventId={e.id}
          categories={e.ticketCategories}
          brandName={brand.data.name}
          acceptingOrders={brand.data.acceptingOrders}
          campaignToken={ct && /^[\w-]{8,100}$/.test(ct) ? ct : undefined}
          buyer={me ? { email: me.email, fullName: me.fullName, phone: me.phone ?? '', country: me.country ?? '' } : null}
        />
      )}

      {e.policies && (
        <section className="mt-8 max-w-3xl">
          <h2 className="mb-2 text-lg font-semibold">Good to know</h2>
          <p className="whitespace-pre-line text-sm text-slate-700">{e.policies}</p>
        </section>
      )}
    </article>
  );
}
