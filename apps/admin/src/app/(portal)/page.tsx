'use client';

import { Activity, CalendarDays, CreditCard, Handshake, Receipt, RotateCcw, Store, Ticket, TrendingUp, Users } from 'lucide-react';
import Link from 'next/link';
import { ReactNode, useMemo, useState } from 'react';
import { AreaSeries, BarSeries } from '@/components/charts';
import {
  Badge, BrandChip, Card, cn, Column, CurrencyList, DataTable, DateRange, DateTime, EmptyState, ErrorState, initialRange, Money, PageHeader, Select, Skeleton, StatCard,
  StatusBadge,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { humanize, number, percent } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

type Cur = { currency: string; revenueMinor: number; paidOrders?: number };
interface Overview {
  revenueByCurrency: Cur[];
  convertedRevenue: { label: string; currency: string; amountMinor: number; ratesUsed: { base: string; quote: string; rate: string; asOf: string }[]; missingRates: string[]; complete: boolean } | null;
  orders: number; paidOrders: number; ticketsSold: number; activeEvents: number; customers: number; newCustomers: number; organizers: number; brands: number;
  payments: { succeeded: number; failed: number; pending: number; cancelled: number };
  paymentSuccessRate: number | null; refundRate: number | null; conversionRate: number | null;
  averageOrderValueByCurrency: { currency: string; averageOrderValueMinor: number }[];
}
interface BrandRow {
  brand: { id: string; name: string; slug: string; status: string; primaryColor: string };
  orders: number; paidOrders: number; ticketsSold: number; revenueByCurrency: Cur[];
  averageOrderValueByCurrency: { currency: string; averageOrderValueMinor: number }[];
  conversionRate: number | null; refundRate: number | null; newCustomers: number;
  topEvents: { eventId: string; name: string; currency: string; orders: number; revenueMinor: number }[];
}
interface Series {
  metric: string; interval: string;
  points: { bucket: string; currency?: string; value: number; paid?: number }[];
}
interface EventRow {
  id: string; name: string; status: string; startsAt: string; venue: string | null; capacity: number; sold: number; remaining: number; checkIns: number;
  revenueByCurrency: Cur[];
}

const METRICS = [
  { value: 'revenue', label: 'Revenue' }, { value: 'orders', label: 'Orders' }, { value: 'tickets', label: 'Tickets issued' }, { value: 'customers', label: 'New customers' },
];
const revenue = (rows: Cur[] | undefined) => (rows ?? []).map((r) => ({ currency: r.currency, amountMinor: r.revenueMinor }));

function Feed<T>({ title, href, items, loading, render, empty }: { title: string; href: string; items: T[] | undefined; loading: boolean; render: (item: T) => { key: string; href: string; primary: ReactNode; secondary: ReactNode; right: ReactNode }; empty: string }) {
  return (
    <Card title={title} padded={false} actions={<Link href={href} className="text-xs font-medium text-accent-700 hover:underline">View all</Link>}>
      {loading && !items ? (
        <div className="space-y-2 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
      ) : !items?.length ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.slice(0, 6).map((it) => {
            const r = render(it);
            return (
              <li key={r.key}>
                <Link href={r.href} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-900">{r.primary}</div>
                    <div className="truncate text-xs text-slate-500">{r.secondary}</div>
                  </div>
                  <div className="shrink-0 text-right text-sm">{r.right}</div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default function OverviewPage() {
  const { brand, brandId, brands, setBrandId, user, can } = useAuth();
  const [range, setRange] = useState(initialRange('30d'));
  const [metric, setMetric] = useState('revenue');
  const [brandMetric, setBrandMetric] = useState('orders');
  const period = { from: range.from, to: range.to };
  const hours = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 3600_000;
  const interval = hours <= 48 ? 'hour' : 'day';

  const overview = useQuery<Overview>('/v1/admin/reports/overview', period);
  const series = useQuery<Series>('/v1/admin/reports/timeseries', { ...period, metric, interval });
  const comparing = !brandId && brands.length > 1;
  const comparison = useQuery<BrandRow[]>(comparing ? '/v1/admin/reports/brands' : null, period);
  const live = useQuery<any>('/v1/admin/reports/live', undefined, { refreshMs: 20_000 });
  // Event performance is not tied to the purchase period: upcoming events sell long before they start.
  const events = useQuery<{ items: EventRow[] }>('/v1/admin/reports/events', { pageSize: 50 });

  const brandName = (id: string) => brands.find((b) => b.id === id);

  const chart = useMemo(() => {
    const points = series.data?.points ?? [];
    const keys = metric === 'revenue' ? [...new Set(points.map((p) => p.currency ?? ''))].filter(Boolean) : ['value'];
    const byBucket = new Map<string, Record<string, unknown>>();
    for (const p of points) {
      const row = byBucket.get(p.bucket) ?? { bucket: p.bucket };
      // Revenue is charted in major units, one line per currency; currencies are never combined.
      row[metric === 'revenue' ? (p.currency as string) : 'value'] = metric === 'revenue' ? Number(p.value) / 100 : Number(p.value);
      byBucket.set(p.bucket, row);
    }
    const data = [...byBucket.values()].map((r) => ({ ...Object.fromEntries(keys.map((k) => [k, 0])), ...r }));
    return { data, series: keys.map((k) => ({ key: k, label: metric === 'revenue' ? k : (METRICS.find((m) => m.value === metric)?.label ?? k) })) };
  }, [series.data, metric]);

  const formatBucket = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat('en-GB', interval === 'hour' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' }).format(d);
  };

  const topEvents = useMemo(() => [...(events.data?.items ?? [])].filter((e) => e.sold > 0).sort((a, b) => b.sold - a.sold).slice(0, 6), [events.data]);

  const o = overview.data;
  const brandColumns: Column<BrandRow>[] = [
    { key: 'brand', header: 'Brand', render: (b) => <div className="flex items-center gap-2"><BrandChip brand={b.brand} />{b.brand.status !== 'ACTIVE' && <StatusBadge status={b.brand.status} />}</div> },
    { key: 'orders', header: 'Orders', align: 'right', render: (b) => <span title={`${number(b.paidOrders)} paid`}>{number(b.orders)}</span> },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (b) => <CurrencyList items={revenue(b.revenueByCurrency)} className="items-end font-medium text-slate-900" /> },
    { key: 'tickets', header: 'Tickets sold', align: 'right', render: (b) => number(b.ticketsSold) },
    { key: 'conversion', header: 'Conversion', align: 'right', render: (b) => percent(b.conversionRate) },
    { key: 'aov', header: 'Avg. order value', align: 'right', render: (b) => <CurrencyList items={b.averageOrderValueByCurrency.map((a) => ({ currency: a.currency, amountMinor: a.averageOrderValueMinor }))} className="items-end" /> },
    { key: 'top', header: 'Top events', render: (b) => b.topEvents.length ? <div className="max-w-[16rem] space-y-0.5">{b.topEvents.map((e) => <div key={e.eventId + e.currency} className="truncate text-xs text-slate-600">{e.name} <span className="text-slate-400">· {e.orders} orders</span></div>)}</div> : <span className="text-slate-400">-</span> },
    { key: 'customers', header: 'New customers', align: 'right', render: (b) => number(b.newCustomers) },
    { key: 'refunds', header: 'Refund rate', align: 'right', render: (b) => percent(b.refundRate) },
  ];

  const title = brand ? `${brand.name} overview` : user.allBrands ? 'Platform overview' : 'Overview';

  return (
    <>
      <PageHeader
        title={title}
        description={brand ? `Performance of the ${brand.name} storefront. Choose "All brands" in the selector to compare storefronts.` : 'The whole business across every storefront. Select a brand to drill down.'}
        actions={<DateRange value={range} onChange={setRange} />}
      />

      {overview.error && !o ? (
        <Card><ErrorState error={overview.error} onRetry={overview.reload} /></Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {!o ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[104px] w-full rounded-xl" />) : (
            <>
              <div className="col-span-2">
                <StatCard
                  label="Revenue (net of refunds)" icon={<TrendingUp className="h-4 w-4" />} href="/reports"
                  value={<CurrencyList items={revenue(o.revenueByCurrency)} emptyLabel="No sales in this period" />}
                  hint={o.revenueByCurrency.length > 1 ? 'Shown per currency. Currencies are not added together.' : `${number(o.paidOrders)} paid orders`}
                />
              </div>
              <StatCard label="Orders" value={number(o.orders)} hint={`${number(o.paidOrders)} paid · ${percent(o.conversionRate)} conversion`} icon={<Receipt className="h-4 w-4" />} href="/orders" />
              <StatCard label="Tickets sold" value={number(o.ticketsSold)} icon={<Ticket className="h-4 w-4" />} href="/tickets" />
              <StatCard label="Active events" value={number(o.activeEvents)} hint="Published and upcoming" icon={<CalendarDays className="h-4 w-4" />} href="/events" />
              <StatCard label="Customers" value={number(o.customers)} hint={`${number(o.newCustomers)} new in this period`} icon={<Users className="h-4 w-4" />} href="/customers" />
              <StatCard label="Registered sellers" value={number(o.organizers)} icon={<Handshake className="h-4 w-4" />} href="/organizers" />
              <StatCard label="Brands" value={number(o.brands)} icon={<Store className="h-4 w-4" />} href="/brands" />
              <StatCard
                label="Payment success rate" value={percent(o.paymentSuccessRate)} icon={<CreditCard className="h-4 w-4" />} href="/payments"
                tone={o.paymentSuccessRate === null ? 'default' : o.paymentSuccessRate >= 0.9 ? 'good' : o.paymentSuccessRate >= 0.75 ? 'warn' : 'bad'}
                hint={`${number(o.payments.succeeded)} succeeded · ${number(o.payments.failed)} failed · ${number(o.payments.pending)} pending`}
              />
              <StatCard label="Refund rate" value={percent(o.refundRate)} hint="Refunded orders / paid orders" icon={<RotateCcw className="h-4 w-4" />} href="/refunds" tone={o.refundRate !== null && o.refundRate > 0.1 ? 'warn' : 'default'} />
              {o.convertedRevenue && o.revenueByCurrency.length > 1 && (
                <div className="col-span-2 rounded-xl border border-dashed border-slate-300 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Converted reporting value</span>
                    <Badge tone="amber">estimate</Badge>
                    {!o.convertedRevenue.complete && <Badge tone="red">incomplete</Badge>}
                  </div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-slate-900"><Money minor={o.convertedRevenue.amountMinor} currency={o.convertedRevenue.currency} /></div>
                  <p className="mt-1 text-xs text-slate-500">{o.convertedRevenue.label}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {o.convertedRevenue.ratesUsed.map((r) => `1 ${r.base} = ${Number(r.rate).toFixed(4)} ${r.quote}`).join(' · ')}
                    {o.convertedRevenue.missingRates.length > 0 && <span className="text-red-600"> · No rate recorded for {o.convertedRevenue.missingRates.join(', ')} (excluded)</span>}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Sales over time"
          description={metric === 'revenue' ? 'Net revenue per currency, in major units' : METRICS.find((m) => m.value === metric)?.label}
          actions={
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {METRICS.map((m) => (
                <button key={m.value} onClick={() => setMetric(m.value)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', metric === m.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                  {m.label}
                </button>
              ))}
            </div>
          }
        >
          {series.error ? <ErrorState error={series.error} onRetry={series.reload} /> : series.loading && !series.data ? <Skeleton className="h-[260px] w-full" /> : (
            <AreaSeries data={chart.data} xKey="bucket" series={chart.series} formatX={formatBucket} format={(v) => new Intl.NumberFormat('en-KE', { maximumFractionDigits: metric === 'revenue' ? 2 : 0 }).format(v)} />
          )}
        </Card>

        <Card title="Top-performing events" description="By tickets sold" padded={false} actions={<Link href="/events" className="text-xs font-medium text-accent-700 hover:underline">All events</Link>}>
          {events.error ? <ErrorState error={events.error} onRetry={events.reload} /> : events.loading && !events.data ? (
            <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : !topEvents.length ? <EmptyState title="No ticket sales yet" /> : (
            <ul className="divide-y divide-slate-100">
              {topEvents.map((e) => {
                const pct = e.capacity ? Math.min(100, Math.round(((e.capacity - e.remaining) / e.capacity) * 100)) : 0;
                return (
                  <li key={e.id}>
                    <Link href={can('events.read') ? `/events/${e.id}` : '/reports'} className="block px-5 py-3 hover:bg-slate-50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">{e.name}</div>
                          <div className="text-xs text-slate-500"><DateTime value={e.startsAt} mode="date" /> · {number(e.sold)} sold</div>
                        </div>
                        <CurrencyList items={revenue(e.revenueByCurrency)} className="items-end text-sm font-medium text-slate-900" />
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" title={`${pct}% of capacity committed`}>
                        <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {comparing && (
        <div className="mt-5 grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2" title="Brand performance" description="Click a brand to drill into its dashboard" padded={false}>
            <DataTable
              columns={brandColumns} rows={comparison.data ?? []} loading={comparison.loading} error={comparison.error} onRetry={comparison.reload}
              rowKey={(b) => b.brand.id} onRowClick={(b) => setBrandId(b.brand.id)} empty={{ title: 'No brands to compare' }}
            />
          </Card>
          <Card
            title="By brand"
            actions={<Select value={brandMetric} onChange={setBrandMetric} options={[{ value: 'orders', label: 'Orders' }, { value: 'ticketsSold', label: 'Tickets sold' }, { value: 'newCustomers', label: 'New customers' }]} />}
          >
            {comparison.loading && !comparison.data ? <Skeleton className="h-[260px] w-full" /> : (
              <BarSeries
                horizontal height={Math.max(200, (comparison.data?.length ?? 0) * 46)}
                data={(comparison.data ?? []).map((b) => ({ name: b.brand.name, value: (b as unknown as Record<string, number>)[brandMetric] }))}
                xKey="name" series={[{ key: 'value', label: humanize(brandMetric === 'ticketsSold' ? 'Tickets sold' : brandMetric === 'newCustomers' ? 'New customers' : 'Orders') }]}
                format={(v) => number(v)}
              />
            )}
          </Card>
        </div>
      )}

      <div className="mb-3 mt-8 flex items-center gap-2">
        <Activity className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-semibold text-slate-900">Live activity</h2>
        <span className="text-xs text-slate-400">{live.data?.asOf ? <>updated <DateTime value={live.data.asOf} mode="relative" /> · refreshes every 20 seconds</> : 'loading'}</span>
      </div>
      {live.error && !live.data ? <Card><ErrorState error={live.error} onRetry={live.reload} /></Card> : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Feed
            title="Recent orders" href="/orders" items={live.data?.recentOrders} loading={live.loading} empty="No orders yet"
            render={(x: any) => ({ key: x.id, href: `/orders/${x.id}`, primary: <><span className="font-mono text-[13px]">{x.reference}</span> · {x.customerName}</>, secondary: <>{brandName(x.brandId)?.name ?? 'Brand'} · {x.event?.name} · <DateTime value={x.createdAt} mode="relative" /></>, right: <div className="flex flex-col items-end gap-1"><Money minor={x.totalMinor} currency={x.currency} className="font-medium text-slate-900" /><StatusBadge status={x.status} /></div> })}
          />
          <Feed
            title="Recent payments" href="/payments?status=SUCCEEDED" items={live.data?.recentPayments} loading={live.loading} empty="No successful payments yet"
            render={(x: any) => ({ key: x.id, href: `/payments?q=${x.reference}`, primary: <span className="font-mono text-[13px]">{x.reference}</span>, secondary: <>Order {x.order?.reference} · <span className="capitalize">{x.providerCode}</span> · <DateTime value={x.paidAt} mode="relative" /></>, right: <Money minor={x.amountMinor} currency={x.currency} className="font-medium text-emerald-700" /> })}
          />
          <Feed
            title="Recently issued tickets" href="/tickets" items={live.data?.recentTickets} loading={live.loading} empty="No tickets issued yet"
            render={(x: any) => ({ key: x.id, href: `/tickets/${x.id}`, primary: <span className="font-mono text-[13px]">{x.reference}</span>, secondary: <>{x.event?.name} · {x.ticketCategory?.name} · <DateTime value={x.issuedAt} mode="relative" /></>, right: <StatusBadge status={x.status} /> })}
          />
          <Feed
            title="Recent QR scans" href="/tickets?tab=scans" items={live.data?.recentScans} loading={live.loading} empty="No scans yet"
            render={(x: any) => ({ key: x.id, href: '/tickets?tab=scans', primary: <span className="font-mono text-[13px]">{x.ticket?.reference ?? 'Unrecognised code'}</span>, secondary: <>{x.gate ?? 'Gate not set'}{x.offline ? ' · offline' : ''} · <DateTime value={x.scannedAt} mode="relative" /></>, right: <StatusBadge status={x.result} /> })}
          />
          <Feed
            title="Failed payments" href="/payments?status=FAILED" items={live.data?.failedPayments} loading={live.loading} empty="No failed payments"
            render={(x: any) => ({ key: x.id, href: `/payments?q=${x.reference}`, primary: <><span className="font-mono text-[13px]">{x.reference}</span> · order {x.order?.reference}</>, secondary: <>{x.failureReason ?? 'Declined'} · <DateTime value={x.updatedAt} mode="relative" /></>, right: <Money minor={x.amountMinor} currency={x.currency} className="text-red-700" /> })}
          />
          <Feed
            title="Pending refunds" href="/refunds?status=REQUESTED" items={live.data?.pendingRefunds} loading={live.loading} empty="No refunds waiting"
            render={(x: any) => ({ key: x.id, href: `/refunds?q=${x.reference}`, primary: <><span className="font-mono text-[13px]">{x.reference}</span> · order {x.order?.reference}</>, secondary: <>{x.reason} · <DateTime value={x.requestedAt} mode="relative" /></>, right: <div className="flex flex-col items-end gap-1"><Money minor={x.amountMinor} currency={x.currency} className="font-medium text-slate-900" /><StatusBadge status={x.status} /></div> })}
          />
          <Feed
            title="Failed email notifications" href="/integrations?tab=jobs&status=FAILED" items={live.data?.failedNotifications} loading={live.loading} empty="No failed notifications"
            render={(x: any) => ({ key: x.id, href: '/integrations?tab=jobs&status=FAILED', primary: <>{humanize(x.type)} to {x.toAddress}</>, secondary: <>{x.lastError ?? 'Delivery failed'} · <DateTime value={x.createdAt} mode="relative" /></>, right: <Badge tone="red">{x.attempts} attempts</Badge> })}
          />
        </div>
      )}
    </>
  );
}
