'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AreaSeries, BarSeries, CHART_COLORS, Donut } from '@/components/charts';
import { Notice, useBrandLookup } from '@/components/platform/bits';
import {
  Badge, BrandChip, Card, Column, CurrencyList, DataTable, DateRange, DateTime, EmptyState, ErrorState, ExportMenu, initialRange, Money, PageHeader, Pagination, Range,
  SearchInput, Select, Skeleton, StatCard, StatusBadge, Tabs,
} from '@/components/ui';
import { Params } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, humanize, money, number, percent } from '@/lib/format';
import { useDebounced, usePaged, useQuery } from '@/lib/hooks';

const rev = (items: any[] | undefined) => (items ?? []).map((r) => ({ currency: r.currency, amountMinor: r.revenueMinor }));
const dayLabel = (iso: string) => dateTime(iso, 'date').replace(/ \d{4}$/, '');

/** Pivots per-currency points into one row per time bucket with a column per currency (major units). */
function pivotRevenue(points: any[] | undefined) {
  const currencies = [...new Set((points ?? []).map((p) => p.currency as string))].sort();
  const rows = new Map<string, Record<string, unknown>>();
  for (const p of points ?? []) {
    const row = rows.get(p.bucket) ?? { bucket: p.bucket };
    row[p.currency] = Number(p.value) / 100;
    rows.set(p.bucket, row);
  }
  return { currencies, data: [...rows.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))) };
}

function useExportParams(range: Range): Params {
  const { brandId } = useAuth();
  return { from: range.from, to: range.to, ...(brandId ? { brandId } : {}) };
}

function PlatformTab({ range }: { range: Range }) {
  const { can } = useAuth();
  const p = { from: range.from, to: range.to };
  const overview = useQuery<any>('/v1/admin/reports/overview', p);
  const revenue = useQuery<any>('/v1/admin/reports/timeseries', { ...p, metric: 'revenue', interval: 'day' });
  const customers = useQuery<any>('/v1/admin/reports/timeseries', { ...p, metric: 'customers', interval: 'day' });
  const brands = useQuery<any[]>('/v1/admin/reports/brands', p);
  const events = useQuery<any>('/v1/admin/reports/events', { ...p, pageSize: 10 });
  const categories = useQuery<any[]>('/v1/admin/reports/sales-by-category', p);
  const exportParams = useExportParams(range);
  const series = useMemo(() => pivotRevenue(revenue.data?.points), [revenue.data]);
  const o = overview.data;

  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.reload} />;
  const catColumns: Column<any>[] = [
    { key: 'category', header: 'Category' },
    { key: 'orders', header: 'Orders', align: 'right', render: (c) => number(c.orders) },
    { key: 'tickets', header: 'Tickets', align: 'right', render: (c) => number(c.tickets) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (c) => <Money minor={c.revenueMinor} currency={c.currency} /> },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {!o ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />) : (
          <>
            <StatCard label="Revenue" value={<CurrencyList items={rev(o.revenueByCurrency)} emptyLabel="No sales" className="text-xl" />} hint="Net of refunds, per currency" />
            <StatCard label="Orders" value={number(o.orders)} hint={`${number(o.paidOrders)} paid`} />
            <StatCard label="Tickets sold" value={number(o.ticketsSold)} />
            <StatCard label="New customers" value={number(o.newCustomers)} hint={`${number(o.customers)} in total`} />
            <StatCard label="Payment success rate" value={percent(o.paymentSuccessRate)} tone={o.paymentSuccessRate !== null && o.paymentSuccessRate < 0.8 ? 'warn' : 'good'} hint={`${o.payments.succeeded} succeeded, ${o.payments.failed} failed`} />
            <StatCard label="Refund rate" value={percent(o.refundRate)} tone={o.refundRate > 0.1 ? 'warn' : 'default'} />
            <StatCard label="Conversion rate" value={percent(o.conversionRate)} hint="Paid orders out of checkouts started" />
            <StatCard label="Average order value" value={<CurrencyList items={(o.averageOrderValueByCurrency ?? []).map((a: any) => ({ currency: a.currency, amountMinor: a.averageOrderValueMinor }))} className="text-xl" />} />
          </>
        )}
      </div>
      {o?.convertedRevenue && (
        <Notice>
          <strong>Converted estimate:</strong> {money(o.convertedRevenue.amountMinor, o.convertedRevenue.currency)}. {o.convertedRevenue.label}{' '}
          {o.convertedRevenue.ratesUsed.length > 0 && <>Rates: {o.convertedRevenue.ratesUsed.map((r: any) => `1 ${r.base} = ${r.rate} ${r.quote} (${dateTime(r.asOf, 'date')})`).join('; ')}.</>}
          {o.convertedRevenue.missingRates?.length > 0 && <> No rate recorded for {o.convertedRevenue.missingRates.join(', ')}, so those amounts are excluded.</>}
        </Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Revenue over time" description="One line per currency; currencies are never combined" actions={can('reports.export') && <ExportMenu path="/v1/admin/reports/timeseries" params={{ ...exportParams, metric: 'revenue', interval: 'day' }} filename="revenue" />}>
          {revenue.loading && !revenue.data ? <Skeleton className="h-64" /> : <AreaSeries data={series.data} xKey="bucket" series={series.currencies.map((c) => ({ key: c, label: c }))} formatX={dayLabel} format={(v) => number(Math.round(v))} />}
        </Card>
        <Card title="Customer growth" description="New customer relationships per day">
          {customers.loading && !customers.data ? <Skeleton className="h-64" /> : <BarSeries data={customers.data?.points ?? []} xKey="bucket" series={[{ key: 'value', label: 'New customers', color: CHART_COLORS[1] }]} formatX={dayLabel} />}
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Sales by brand" description="Tickets sold per storefront">
          {brands.loading && !brands.data ? <Skeleton className="h-56" /> : <Donut data={(brands.data ?? []).map((b) => ({ name: b.brand.name, value: b.ticketsSold, color: b.brand.primaryColor }))} />}
        </Card>
        <Card title="Sales by event category" padded={false} actions={can('reports.export') && <ExportMenu path="/v1/admin/reports/sales-by-category" params={exportParams} filename="sales-by-category" />}>
          <DataTable columns={catColumns} rows={categories.data ?? []} loading={categories.loading} error={categories.error} onRetry={categories.reload} rowKey={(c) => `${c.category}-${c.currency}`} empty={{ title: 'No sales in this period' }} />
        </Card>
      </div>

      <Card title="Top events" description="By tickets sold in this period" padded={false}>
        <DataTable
          columns={[
            { key: 'name', header: 'Event', render: (e: any) => <Link href={`/events/${e.id}`} className="font-medium text-accent-700 hover:underline">{e.name}</Link> },
            { key: 'sold', header: 'Sold', align: 'right', render: (e: any) => number(e.sold) },
            { key: 'revenue', header: 'Revenue', align: 'right', render: (e: any) => <CurrencyList items={rev(e.revenueByCurrency)} className="items-end" /> },
          ]}
          rows={[...(events.data?.items ?? [])].sort((a, b) => b.sold - a.sold)}
          loading={events.loading}
          error={events.error}
          onRetry={events.reload}
          empty={{ title: 'No events in this period' }}
        />
      </Card>
    </div>
  );
}

function BrandsTab({ range }: { range: Range }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/reports/brands', { from: range.from, to: range.to });
  const exportParams = useExportParams(range);
  const columns: Column<any>[] = [
    { key: 'brand', header: 'Brand', render: (b) => <div className="flex items-center gap-2"><BrandChip brand={b.brand} />{b.brand.status !== 'ACTIVE' && <StatusBadge status={b.brand.status} />}</div> },
    { key: 'orders', header: 'Orders', align: 'right', render: (b) => number(b.orders) },
    { key: 'paid', header: 'Paid', align: 'right', render: (b) => number(b.paidOrders) },
    { key: 'tickets', header: 'Tickets', align: 'right', render: (b) => number(b.ticketsSold) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (b) => <CurrencyList items={rev(b.revenueByCurrency)} className="items-end" /> },
    { key: 'aov', header: 'Avg order', align: 'right', render: (b) => <CurrencyList items={(b.averageOrderValueByCurrency ?? []).map((a: any) => ({ currency: a.currency, amountMinor: a.averageOrderValueMinor }))} className="items-end" /> },
    { key: 'conversion', header: 'Conversion', align: 'right', render: (b) => percent(b.conversionRate) },
    { key: 'refundRate', header: 'Refund rate', align: 'right', render: (b) => percent(b.refundRate) },
    { key: 'newCustomers', header: 'New customers', align: 'right', render: (b) => number(b.newCustomers) },
    { key: 'top', header: 'Top events', render: (b) => <div className="max-w-[16rem] space-y-0.5 text-xs text-slate-600">{b.topEvents.length ? b.topEvents.map((e: any) => <div key={`${e.eventId}-${e.currency}`} className="truncate">{e.name}</div>) : '-'}</div> },
  ];
  const chart = (data ?? []).map((b) => ({ name: b.brand.name, orders: b.paidOrders, tickets: b.ticketsSold, customers: b.newCustomers }));
  return (
    <div className="space-y-5">
      <Card title="Brand comparison" padded={false} actions={can('reports.export') && <ExportMenu path="/v1/admin/reports/brands" params={exportParams} filename="brand-performance" />}>
        <DataTable columns={columns} rows={data ?? []} loading={loading} error={error} onRetry={reload} rowKey={(b) => b.brand.id} empty={{ title: 'No brands in scope' }} />
      </Card>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Paid orders and tickets by brand">
          {loading && !data ? <Skeleton className="h-64" /> : <BarSeries data={chart} xKey="name" series={[{ key: 'orders', label: 'Paid orders' }, { key: 'tickets', label: 'Tickets sold' }]} />}
        </Card>
        <Card title="Customer acquisition by brand">
          {loading && !data ? <Skeleton className="h-64" /> : <BarSeries data={chart} xKey="name" horizontal series={[{ key: 'customers', label: 'New customers', color: CHART_COLORS[3] }]} />}
        </Card>
      </div>
    </div>
  );
}

function EventsTab({ range }: { range: Range }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const list = usePaged<any>('/v1/admin/reports/events', { from: range.from, to: range.to, q: useDebounced(q) });
  const columns: Column<any>[] = [
    { key: 'name', header: 'Event', render: (e) => <div className="max-w-[18rem]"><Link href={`/events/${e.id}`} className="block truncate font-medium text-accent-700 hover:underline">{e.name}</Link><div className="truncate text-xs text-slate-500">{e.venue ?? '-'}</div></div> },
    { key: 'startsAt', header: 'Date', render: (e) => <DateTime value={e.startsAt} mode="date" /> },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    { key: 'capacity', header: 'Inventory', align: 'right', render: (e) => number(e.capacity) },
    { key: 'sold', header: 'Sold', align: 'right', render: (e) => <span title={e.soldScope === 'ALL_BRANDS' ? 'Across all storefronts' : 'Your brands only'}>{number(e.sold)}</span> },
    { key: 'remaining', header: 'Remaining', align: 'right', render: (e) => number(e.remaining) },
    { key: 'sell', header: 'Sold %', align: 'right', render: (e) => (e.capacity ? percent(e.sold / e.capacity, 0) : '-') },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (e) => <CurrencyList items={rev(e.revenueByCurrency)} className="items-end" /> },
    { key: 'checkIns', header: 'Check-ins', align: 'right', render: (e) => number(e.checkIns) },
    { key: 'refunds', header: 'Refunds', align: 'right', render: (e) => <CurrencyList items={(e.refunds ?? []).map((r: any) => ({ currency: r.currency, amountMinor: r.refundedMinor ?? r.amountMinor ?? 0 }))} className="items-end" /> },
  ];
  return (
    <Card padded={false} actions={can('reports.export') && <ExportMenu path="/v1/admin/reports/events" params={list.params} filename="event-performance" />} title="Event performance">
      <div className="border-b border-slate-100 px-4 py-3"><SearchInput value={q} onChange={setQ} placeholder="Event name" /></div>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No events match' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

const FIN_ROWS: [string, string, string?][] = [
  ['grossSalesMinor', 'Gross sales (captured)'], ['serviceFeesMinor', 'Service fees'], ['taxesMinor', 'Taxes'], ['gatewayChargesMinor', 'Gateway charges'], ['refundsMinor', 'Refunds'],
  ['platformCommissionMinor', 'Platform commission'], ['brandCommissionMinor', 'Brand commission'], ['promoterPayableMinor', 'Promoter payable'], ['promoterPaidOutMinor', 'Paid out to promoters'],
  ['settledToBankMinor', 'Settled to bank'], ['netSettlementMinor', 'Net settlement', 'strong'],
];

function FinancialTab({ range }: { range: Range }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useQuery<any>('/v1/admin/reports/financial', { from: range.from, to: range.to });
  const exportParams = useExportParams(range);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton className="h-72" />;
  const balanceColumns: Column<any>[] = [
    { key: 'account', header: 'Account', render: (b) => humanize(b.account) },
    { key: 'currency', header: 'Currency' },
    { key: 'debit', header: 'Debits', align: 'right', render: (b) => <Money minor={b.debitMinor} currency={b.currency} /> },
    { key: 'credit', header: 'Credits', align: 'right', render: (b) => <Money minor={b.creditMinor} currency={b.currency} /> },
    { key: 'balance', header: 'Balance', align: 'right', render: (b) => <Money minor={b.balanceMinor} currency={b.currency} className="font-medium text-slate-900" /> },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-slate-500">{data.basis}</p>
        {can('reports.export') && <ExportMenu path="/v1/admin/reports/financial" params={exportParams} filename="financial-summary" />}
      </div>
      {data.summary.length === 0 && <Card><EmptyState title="No financial activity in this period" /></Card>}
      <div className="grid gap-5 lg:grid-cols-2">
        {data.summary.map((s: any) => (
          <Card key={s.currency} title={<span className="flex items-center gap-2">Financial summary <Badge tone="indigo">{s.currency}</Badge></span>}>
            <dl className="space-y-2 text-sm">
              {FIN_ROWS.map(([key, label, strong]) => (
                <div key={key} className={strong ? 'flex justify-between gap-3 border-t border-slate-200 pt-2 font-semibold text-slate-900' : 'flex justify-between gap-3'}>
                  <dt className={strong ? '' : 'text-slate-600'}>{label}</dt>
                  <dd><Money minor={s[key]} currency={s.currency} /></dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
      <Card title="Ledger account balances" description="Current balance of each account, per currency" padded={false}>
        <DataTable columns={balanceColumns} rows={data.balances} rowKey={(b) => `${b.account}-${b.currency}`} empty={{ title: 'No ledger entries yet' }} />
      </Card>
    </div>
  );
}

const JOURNAL_TYPES = ['PAYMENT_CAPTURE', 'GATEWAY_FEE', 'REFUND', 'SETTLEMENT', 'PAYOUT', 'ADJUSTMENT', 'REVERSAL'];

function LedgerTab({ range }: { range: Range }) {
  const { can } = useAuth();
  const brand = useBrandLookup();
  const [type, setType] = useState('');
  const [ref, setRef] = useState('');
  const orderReference = useDebounced(ref.trim());
  const list = usePaged<any>('/v1/admin/reports/ledger', { type, orderReference, ...(orderReference ? {} : { from: range.from, to: range.to }) });
  return (
    <Card padded={false} title="Journal" description="Immutable double-entry records. Corrections appear as new reversing journals." actions={can('reports.export') && <ExportMenu path="/v1/admin/reports/ledger" params={list.params} filename="ledger" />}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <SearchInput value={ref} onChange={setRef} placeholder="Order reference (ORD-...)" />
        <Select value={type} onChange={setType} placeholder="All journal types" options={JOURNAL_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
      </div>
      {list.error && !list.items.length ? <ErrorState error={list.error} onRetry={list.reload} /> : list.loading && !list.items.length ? <div className="p-5"><Skeleton className="h-48" /></div> : !list.items.length ? <EmptyState title="No journal entries match" /> : (
        <ul className="divide-y divide-slate-100">
          {list.items.map((j) => (
            <li key={j.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone="indigo">{humanize(j.type)}</Badge>
                <span className="text-sm font-medium text-slate-900">{j.description}</span>
                {j.brandId && <BrandChip brand={brand(j.brandId)} />}
                {j.orderId && can('orders.read') && <Link href={`/orders/${j.orderId}`} className="text-xs font-medium text-accent-700 hover:underline">View order</Link>}
                <span className="ml-auto text-xs text-slate-400"><DateTime value={j.createdAt} /></span>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[26rem] text-xs">
                  <tbody>
                    {j.entries.map((e: any) => (
                      <tr key={e.id} className="text-slate-600">
                        <td className={e.direction === 'CREDIT' ? 'py-0.5 pl-6' : 'py-0.5'}>{humanize(e.account)}</td>
                        <td className="w-32 py-0.5 text-right">{e.direction === 'DEBIT' && <Money minor={e.amountMinor} currency={e.currency} />}</td>
                        <td className="w-32 py-0.5 text-right">{e.direction === 'CREDIT' && <Money minor={e.amountMinor} currency={e.currency} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

function MarketingTab({ range }: { range: Range }) {
  const brand = useBrandLookup();
  const { data, loading, error, reload } = useQuery<any>('/v1/admin/reports/marketing', { from: range.from, to: range.to });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton className="h-72" />;
  const t = data.campaigns.totals;
  const promoColumns: Column<any>[] = [
    { key: 'code', header: 'Code', render: (p) => <span className="font-mono text-[13px] font-medium text-slate-900">{p.code}</span> },
    { key: 'brand', header: 'Brand', render: (p) => <BrandChip brand={brand(p.brandId)} /> },
    { key: 'redeemed', header: 'Redemptions', align: 'right', render: (p) => number(p.redeemedCount) },
    { key: 'orders', header: 'Paid orders', align: 'right', render: (p) => number((p.usage ?? []).reduce((s: number, u: any) => s + u.paidOrders, 0)) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (p) => <CurrencyList items={rev(p.usage)} className="items-end" /> },
    { key: 'discount', header: 'Discount given', align: 'right', render: (p) => <CurrencyList items={(p.usage ?? []).map((u: any) => ({ currency: u.currency, amountMinor: u.discountMinor }))} className="items-end" /> },
  ];
  const campaignColumns: Column<any>[] = [
    { key: 'name', header: 'Campaign', render: (c) => <Link href={`/marketing?campaign=${c.id}`} className="font-medium text-accent-700 hover:underline">{c.name}</Link> },
    { key: 'brand', header: 'Brand', render: (c) => <BrandChip brand={brand(c.brandId)} /> },
    { key: 'channel', header: 'Channel', render: (c) => humanize(c.channel) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'sentAt', header: 'Sent', render: (c) => <DateTime value={c.sentAt} /> },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Messages sent" value={number(t.sent)} hint={`${number(t.audience)} in audience, ${number(t.skipped)} skipped (no consent or address)`} />
        <StatCard label="Open rate" value={percent(t.openRate)} hint={`${number(t.opens)} opened`} />
        <StatCard label="Click rate" value={percent(t.clickRate)} hint={`${number(t.clicks)} clicked`} />
        <StatCard label="Unsubscribes" value={number(t.unsubscribes)} />
        <StatCard label="Conversions" value={number(t.conversions)} hint={`${percent(t.conversionRate)} of recipients`} />
        <StatCard label="Campaign revenue" value={<CurrencyList items={rev(t.revenueByCurrency)} emptyLabel="None yet" className="text-xl" />} hint="Paid orders attributed to campaigns" />
        <StatCard label="Delivery failures" value={number(t.failed)} tone={t.failed > 0 ? 'warn' : 'default'} />
        <StatCard label="Consent changes" value={<span className="text-base font-medium">{(data.consentChanges ?? []).map((c: any) => `${c.count} ${humanize(c.status).toLowerCase()} (${humanize(c.channel).toLowerCase()})`).join(', ') || 'None'}</span>} />
      </div>
      <Card title="Recent campaigns" padded={false}>
        <DataTable columns={campaignColumns} rows={data.campaigns.recent ?? []} empty={{ title: 'No campaigns in this period', description: 'Create campaigns under Marketing.' }} />
      </Card>
      <Card title="Promo code performance" padded={false}>
        <DataTable columns={promoColumns} rows={data.promoCodes ?? []} empty={{ title: 'No promo codes' }} />
      </Card>
    </div>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const [range, setRange] = useState(initialRange('30d'));
  const tabs = [
    { id: 'platform', label: 'Platform', show: can('reports.read') },
    { id: 'brands', label: 'Brands', show: can('reports.read') },
    { id: 'events', label: 'Events', show: can('reports.read') },
    { id: 'financial', label: 'Financial', show: can('reports.financial') },
    { id: 'ledger', label: 'Ledger', show: can('reports.financial') },
    { id: 'marketing', label: 'Marketing', show: can('marketing.read') },
  ].filter((t) => t.show);
  const active = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id;
  return (
    <>
      <PageHeader title="Reports & Analytics" description="Figures follow the brand chosen in the top bar. Revenue is always shown per currency." actions={<DateRange value={range} onChange={setRange} />} />
      {!tabs.length ? <EmptyState title="No reports available for your role" /> : (
        <>
          <Tabs tabs={tabs} active={active} onChange={(id) => router.replace(`/reports?tab=${id}`)} />
          {active === 'platform' && <PlatformTab range={range} />}
          {active === 'brands' && <BrandsTab range={range} />}
          {active === 'events' && <EventsTab range={range} />}
          {active === 'financial' && <FinancialTab range={range} />}
          {active === 'ledger' && <LedgerTab range={range} />}
          {active === 'marketing' && <MarketingTab range={range} />}
        </>
      )}
    </>
  );
}
