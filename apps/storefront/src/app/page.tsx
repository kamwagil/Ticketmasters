import Link from 'next/link';
import { Notice } from '@/components/forms';
import { api, getBrand, getBrandSettings } from '@/lib/api';
import { money, when } from '@/lib/format';

interface EventCard {
  id: string;
  slug: string;
  name: string;
  status: string;
  featured: boolean;
  posterUrl: string | null;
  startsAt: string;
  timezone: string;
  category: { slug: string; name: string } | null;
  venue: { name: string; city: string; country: string } | null;
  performers: string[];
  fromPriceMinor: number | null;
  currency: string | null;
}

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string; category?: string; page?: string; ct?: string }> }) {
  const sp = await searchParams;
  const brand = await getBrand();
  if (!brand.ok) return null;
  const settings = await getBrandSettings();
  const page = Math.max(1, Number(sp.page) || 1);
  const [events, categories] = await Promise.all([
    api<{ items: EventCard[]; total: number; pages: number }>('GET', '/events', { query: { q: sp.q, category: sp.category, page, pageSize: 24 }, customer: false }),
    api<{ slug: string; name: string }[]>('GET', '/events/categories', { customer: false }),
  ]);
  // Featured events first, then by date (the API returns date order).
  const items = events.ok ? [...events.data.items].sort((a, b) => Number(b.featured) - Number(a.featured)) : [];
  const ct = sp.ct ? `?ct=${encodeURIComponent(sp.ct)}` : '';
  const link = (o: { category?: string; page?: number }) => {
    const p = new URLSearchParams();
    if (sp.q) p.set('q', sp.q);
    const cat = 'category' in o ? o.category : sp.category;
    if (cat) p.set('category', cat);
    if (o.page && o.page > 1) p.set('page', String(o.page));
    const s = p.toString();
    return s ? `/?${s}` : '/';
  };

  return (
    <>
      <section className="-mx-4 -mt-8 mb-8 bg-brand px-4 pb-10 pt-8 text-brand-fg sm:-mx-6 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">{settings.tagline?.text ?? `Tickets from ${brand.data.name}`}</h1>
          <form action="/" method="get" role="search" className="mt-6 flex max-w-xl gap-2">
            <label className="sr-only" htmlFor="q">Search events</label>
            <input id="q" name="q" defaultValue={sp.q ?? ''} placeholder="Search events, artists, teams or venues" className="input" />
            {sp.category && <input type="hidden" name="category" value={sp.category} />}
            <button className="btn shrink-0 bg-brand-accent text-brand-accent-fg hover:opacity-90">Search</button>
          </form>
        </div>
      </section>

      {categories.ok && categories.data.length > 0 && (
        <nav aria-label="Categories" className="mb-6 flex flex-wrap gap-2">
          {[{ slug: '', name: 'All events' }, ...categories.data].map((c) => {
            const active = (sp.category ?? '') === c.slug;
            return (
              <Link key={c.slug || 'all'} href={link({ category: c.slug || undefined })} aria-current={active ? 'true' : undefined}
                className={`rounded-full px-4 py-1.5 text-sm font-medium ring-1 ring-inset ${active ? 'bg-brand text-brand-fg ring-transparent' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'}`}>
                {c.name}
              </Link>
            );
          })}
        </nav>
      )}

      {!events.ok ? (
        <Notice kind={events.error.code === 'BRAND_NOT_ACTIVE' ? 'info' : 'error'}>
          {events.error.code === 'BRAND_NOT_ACTIVE' ? 'Events are not on sale at the moment. You can still find an existing order or open your tickets.' : events.error.message}
        </Notice>
      ) : items.length === 0 ? (
        <div className="card text-center text-slate-600">
          <p className="font-medium text-slate-900">No events found</p>
          <p className="mt-1 text-sm">{sp.q || sp.category ? 'Try a different search or category.' : 'New events will appear here as soon as they go on sale.'}</p>
          {(sp.q || sp.category) && <p className="mt-3"><Link href="/" className="link">Show all events</Link></p>}
        </div>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((e) => (
            <li key={e.id}>
              <Link href={`/events/${e.slug}${ct}`} className="group flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
                <div className="relative aspect-[16/9] w-full overflow-hidden" style={e.posterUrl ? undefined : { background: 'linear-gradient(135deg, var(--brand), var(--accent))' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {e.posterUrl ? <img src={e.posterUrl} alt="" className="h-full w-full object-cover" /> : (
                    <span aria-hidden className="absolute inset-0 grid place-items-center px-6 text-center text-xl font-bold text-brand-fg opacity-90">{e.category?.name ?? brand.data.name}</span>
                  )}
                  {e.featured && <span className="absolute left-3 top-3 rounded-full bg-brand-accent px-2.5 py-1 text-xs font-semibold text-brand-accent-fg">Featured</span>}
                  {e.status === 'POSTPONED' && <span className="absolute right-3 top-3 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-900">New date</span>}
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <h2 className="text-base font-semibold text-slate-900 group-hover:underline">{e.name}</h2>
                  <p className="mt-1 text-sm text-slate-600">{when(e.startsAt, e.timezone, 'short')}</p>
                  {e.venue && <p className="text-sm text-slate-600">{e.venue.name}, {e.venue.city}</p>}
                  <p className="mt-auto pt-3 text-sm font-semibold text-brand-ink">
                    {e.fromPriceMinor !== null && e.currency ? `From ${money(e.fromPriceMinor, e.currency)}` : 'See tickets'}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {events.ok && events.data.pages > 1 && (
        <nav aria-label="Pages" className="mt-8 flex items-center justify-center gap-4 text-sm">
          {page > 1 ? <Link className="btn-secondary" href={link({ page: page - 1 })}>Previous</Link> : <span />}
          <span className="text-slate-600">Page {page} of {events.data.pages}</span>
          {page < events.data.pages ? <Link className="btn-secondary" href={link({ page: page + 1 })}>Next</Link> : <span />}
        </nav>
      )}
    </>
  );
}
