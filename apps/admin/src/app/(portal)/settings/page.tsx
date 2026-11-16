'use client';

import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BarSeries } from '@/components/charts';
import { CURRENCY_RE, Dot, Notice, useBrandLookup } from '@/components/platform/bits';
import {
  Badge, BrandChip, Button, Card, Column, ConfirmButton, DataTable, DateTime, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Pagination, Select,
  Skeleton, StatCard, Tabs, Textarea, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, humanize, number, percent } from '@/lib/format';
import { useAction, usePaged, useQuery } from '@/lib/hooks';

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${Math.round(v)} ms`);
function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function AlertsCard() {
  const toast = useToast();
  const brand = useBrandLookup();
  const [severity, setSeverity] = useState('');
  const [open, setOpen] = useState('true');
  const list = usePaged<any>('/v1/admin/alerts', { severity, open }, { pageSize: 10 });
  const columns: Column<any>[] = [
    { key: 'severity', header: 'Severity', render: (a) => <Badge tone={a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARNING' ? 'amber' : 'blue'}>{humanize(a.severity)}</Badge> },
    { key: 'type', header: 'Alert', render: (a) => <div className="max-w-[34rem] whitespace-normal"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{humanize(a.type)}</div><div className="text-slate-800">{a.message}</div></div> },
    { key: 'brand', header: 'Brand', render: (a) => (a.brandId ? <BrandChip brand={brand(a.brandId)} /> : '-') },
    { key: 'createdAt', header: 'Raised', render: (a) => <DateTime value={a.createdAt} mode="relative" /> },
    {
      key: 'action', header: '', align: 'right',
      render: (a) => a.resolvedAt
        ? <span className="text-xs text-slate-400">Resolved <DateTime value={a.resolvedAt} mode="relative" /></span>
        : <ConfirmButton size="sm" label="Resolve" title="Mark this alert as resolved?" confirmLabel="Resolve" body="Do this once the cause has been dealt with. If the condition happens again a new alert is raised." onConfirm={() => api.post(`/v1/admin/alerts/${a.id}/resolve`).then(() => { toast.success('Alert resolved'); list.reload(); })} />,
    },
  ];
  return (
    <Card padded={false} title="Alerts">
      <Toolbar>
        <Select value={open} onChange={setOpen} options={[{ value: 'true', label: 'Open alerts' }, { value: 'false', label: 'Resolved alerts' }, { value: '', label: 'All alerts' }]} />
        <Select value={severity} onChange={setSeverity} placeholder="Any severity" options={['CRITICAL', 'WARNING', 'INFO'].map((s) => ({ value: s, label: humanize(s) }))} />
      </Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: open === 'true' ? 'No open alerts' : 'No alerts', description: open === 'true' ? 'Payments, inventory, webhooks, queues and email delivery are all behaving.' : undefined }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

function HealthTab() {
  const { data: h, error, reload } = useQuery<any>('/v1/admin/system/health', undefined, { scoped: false, refreshMs: 15_000 });
  if (error && !h) return <ErrorState error={error} onRetry={reload} />;
  if (!h) return <Skeleton className="h-96" />;
  const queueColumns: Column<any>[] = [
    { key: 'queue', header: 'Queue', render: (q) => <span className="font-mono text-[13px]">{q.queue}</span> },
    { key: 'waiting', header: 'Waiting', align: 'right', render: (q) => number(q.waiting) },
    { key: 'active', header: 'Active', align: 'right', render: (q) => number(q.active) },
    { key: 'delayed', header: 'Delayed', align: 'right', render: (q) => number(q.delayed) },
    { key: 'failed', header: 'Failed', align: 'right', render: (q) => <span className={q.failed ? 'font-semibold text-red-600' : ''}>{number(q.failed)}</span> },
    { key: 'completed', header: 'Completed', align: 'right', render: (q) => number(q.completed) },
  ];
  const routeColumns: Column<any>[] = [
    { key: 'route', header: 'Route', render: (r) => <span className="font-mono text-xs">{r.route}</span> },
    { key: 'count', header: 'Requests', align: 'right', render: (r) => number(r.count) },
    { key: 'avgMs', header: 'Average', align: 'right', render: (r) => ms(r.avgMs) },
    { key: 'errors', header: 'Errors', align: 'right', render: (r) => number(r.errors) },
  ];
  const wh = h.paymentWebhooks.last24h;
  const em = h.notifications.last24h;
  return (
    <div className="space-y-5">
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${h.status === 'healthy' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : h.status === 'degraded' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800'}`}>
        <span><strong>{h.status === 'healthy' ? 'All systems operational' : h.status === 'degraded' ? 'Degraded' : 'Down'}</strong>{h.problems.length > 0 && <>: {h.problems.map((p: string) => humanize(p).toLowerCase()).join(', ')}</>}</span>
        <span className="text-xs opacity-80">Updated {dateTime(h.asOf, 'time')} · refreshes every 15 seconds</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="API uptime" value={uptime(h.api.uptimeSeconds)} hint={`${h.api.environment} · started ${dateTime(h.api.startedAt)}`} />
        <StatCard label="Response time (p50 / p95 / p99)" value={<span className="text-xl">{ms(h.api.latencyMs.p50)} / {ms(h.api.latencyMs.p95)} / {ms(h.api.latencyMs.p99)}</span>} hint={`Last ${number(h.api.latencyMs.samples)} requests`} tone={h.api.latencyMs.p95 > 1500 ? 'warn' : 'default'} />
        <StatCard label="Requests" value={number(h.api.requests)} hint={`${number(h.traffic.current)} this minute${h.traffic.unusualSpike ? ' · unusual spike' : ''}`} tone={h.traffic.unusualSpike ? 'warn' : 'default'} />
        <StatCard label="Application errors (5xx)" value={number(h.api.errors5xx)} hint={`${percent(h.api.errorRate5xx, 2)} of requests since start`} tone={h.api.errors5xx ? 'bad' : 'good'} />
      </div>
      <p className="-mt-2 text-xs text-slate-400">{h.api.instanceScope}</p>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="Requests per minute" className="xl:col-span-2">
          <BarSeries data={h.traffic.perMinute} xKey="at" series={[{ key: 'count', label: 'Requests' }]} height={200} formatX={(v) => dateTime(v, 'time')} />
        </Card>
        <Card title="Dependencies">
          <ul className="space-y-3">
            <li><Dot ok={h.database.ok} label="Database" /><div className="pl-3.5 text-xs text-slate-500">{ms(h.database.latencyMs)} · {h.database.connections} of {h.database.maxConnections} connections ({percent(h.database.utilisation, 0)})</div></li>
            <li><Dot ok={h.redis.enabled ? h.redis.ok : null} label="Redis" /><div className="pl-3.5 text-xs text-slate-500">{h.redis.enabled ? ms(h.redis.latencyMs) : 'Not used in this mode'}</div></li>
            <li><Dot ok={h.storage.ok} label="File storage" /><div className="pl-3.5 text-xs text-slate-500">{h.storage.driver}{h.storage.detail ? ` · ${h.storage.detail}` : ''}</div></li>
            <li><Dot ok={h.notifications.smtpHealthy} label="Email (SMTP)" /></li>
            <li><Dot ok={h.ticketing.paidOrdersAwaitingTickets === 0} label="Ticket issuance" /><div className="pl-3.5 text-xs text-slate-500">{h.ticketing.paidOrdersAwaitingTickets} paid order(s) waiting for tickets</div></li>
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Webhook backlog" value={number(h.paymentWebhooks.unprocessedBacklog)} tone={h.paymentWebhooks.unprocessedBacklog ? 'bad' : 'good'} hint={`24h: ${wh.processed} processed, ${wh.failed} failed, ${wh.rejected} rejected`} />
        <StatCard label="Email failures (24h)" value={number(em.failed)} tone={em.failed ? 'warn' : 'good'} hint={`${number(em.sent)} sent, ${number(em.queued)} queued, ${number(em.skipped)} skipped`} />
        <StatCard label="Overdue notifications" value={number(h.notifications.overdueBacklog)} tone={h.notifications.overdueBacklog ? 'warn' : 'default'} />
        <StatCard label="Failed background jobs" value={number(h.failedBackgroundJobs.queueJobs)} tone={h.failedBackgroundJobs.queueJobs ? 'bad' : 'good'} hint={h.queues.mode === 'bullmq' ? `Redis workers${h.queues.workersInThisProcess ? ' in this process' : ' in separate containers'}` : 'In-process mode'} />
      </div>

      <Card title="Queues" padded={false}>
        <DataTable columns={queueColumns} rows={h.queues.queues} rowKey={(q) => q.queue} empty={{ title: 'Queues run in-process', description: 'Queue counters are available when the platform runs with Redis-backed workers.' }} />
      </Card>
      <Card title="Slowest routes" padded={false}>
        <DataTable columns={routeColumns} rows={h.api.slowestRoutes} rowKey={(r) => r.route} empty={{ title: 'No requests recorded yet' }} />
      </Card>
      <AlertsCard />
    </div>
  );
}

function SettingsTab() {
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/settings', undefined, { scoped: false });
  const [editing, setEditing] = useState<any | null>(null);
  const [text, setText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const { run, loading: saving } = useAction();
  const open = (s: any) => {
    setEditing(s);
    setText(JSON.stringify(s.value, null, 2));
    setFormError(null);
  };
  const save = async () => {
    setFormError(null);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return setFormError('This is not valid JSON.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return setFormError('The value must be a JSON object, for example { "days": 30 }.');
    const res = await run(() => api.put(`/v1/admin/settings/${encodeURIComponent(editing.key)}`, { value }), { onError: (e) => setFormError(e.message) });
    if (res !== undefined) {
      toast.success(`${editing.key} updated`);
      setEditing(null);
      reload();
    }
  };
  const columns: Column<any>[] = [
    { key: 'key', header: 'Setting', render: (s) => <span className="font-mono text-[13px] font-medium text-slate-900">{s.key}</span> },
    { key: 'value', header: 'Value', render: (s) => <code className="block max-w-[32rem] truncate font-mono text-xs text-slate-600">{JSON.stringify(s.value)}</code> },
    { key: 'updatedAt', header: 'Updated', render: (s) => <DateTime value={s.updatedAt} /> },
  ];
  return (
    <Card padded={false} title="Platform settings" description="Apply to every brand. Each change is recorded in the audit log with the previous value.">
      <DataTable columns={columns} rows={data ?? []} loading={loading} error={error} onRetry={reload} onRowClick={open} rowKey={(s) => s.key} empty={{ title: 'No settings defined' }} />
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.key ?? ''} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={saving} onClick={save}>Save setting</Button></>}>
        <Field label="Value (JSON object)"><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className="font-mono text-xs" spellCheck={false} /></Field>
        <FormError error={formError} />
      </Modal>
    </Card>
  );
}

function CurrenciesTab() {
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/currencies', undefined, { scoped: false });
  const { run, loading: saving } = useAction();
  const toggle = async (c: any) => {
    const res = await run(() => api.put(`/v1/admin/currencies/${c.code}`, { enabled: !c.enabled }), { onError: (e) => toast.error(e.message) });
    if (res !== undefined) {
      toast.success(`${c.code} ${c.enabled ? 'disabled' : 'enabled'}`);
      reload();
    }
  };
  const columns: Column<any>[] = [
    { key: 'code', header: 'Code', render: (c) => <span className="font-mono font-medium text-slate-900">{c.code}</span> },
    { key: 'name', header: 'Currency' },
    { key: 'minorUnits', header: 'Decimal places', align: 'right' },
    { key: 'enabled', header: 'Status', render: (c) => <Badge tone={c.enabled ? 'green' : 'gray'}>{c.enabled ? 'Enabled' : 'Disabled'}</Badge> },
    { key: 'action', header: '', align: 'right', render: (c) => <Button size="sm" variant="secondary" loading={saving} onClick={() => toggle(c)}>{c.enabled ? 'Disable' : 'Enable'}</Button> },
  ];
  return (
    <Card padded={false} title="Currencies" description="Currencies the platform recognises. A brand can only sell in a currency its payment provider and merchant account support.">
      <DataTable columns={columns} rows={data ?? []} loading={loading} error={error} onRetry={reload} rowKey={(c) => c.code} empty={{ title: 'No currencies' }} />
    </Card>
  );
}

function RatesTab() {
  const toast = useToast();
  const list = usePaged<any>('/v1/admin/exchange-rates', undefined, { scoped: false });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ base: '', quote: 'KES', rate: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const save = async () => {
    setFormError(null);
    if (!CURRENCY_RE.test(f.base) || !CURRENCY_RE.test(f.quote) || f.base === f.quote) return setFormError('Enter two different 3-letter currency codes.');
    if (!/^\d{1,10}(\.\d{1,10})?$/.test(f.rate) || Number(f.rate) <= 0) return setFormError('Enter the rate as a positive number, for example 129.25.');
    const res = await run(() => api.post('/v1/admin/exchange-rates', { base: f.base, quote: f.quote, rate: f.rate, source: 'manual' }), { onError: (e) => setFormError(e.message) });
    if (res) {
      toast.success(`Rate recorded: 1 ${f.base} = ${f.rate} ${f.quote}`);
      setAdding(false);
      setF({ base: '', quote: 'KES', rate: '' });
      list.reload();
    }
  };
  const columns: Column<any>[] = [
    { key: 'pair', header: 'Pair', render: (r) => <span className="font-mono font-medium text-slate-900">{r.base} / {r.quote}</span> },
    { key: 'rate', header: 'Rate', align: 'right', render: (r) => `1 ${r.base} = ${r.rate} ${r.quote}` },
    { key: 'asOf', header: 'As of', render: (r) => <DateTime value={r.asOf} /> },
    { key: 'source', header: 'Source' },
  ];
  return (
    <div className="space-y-5">
      <Notice>Exchange rates never change what a customer pays or what is owed to anyone. They are used only for reporting figures that are explicitly labelled as converted estimates. All other totals stay in their own currency.</Notice>
      <Card padded={false} title="Exchange rates" description="Rates are kept as a history; the most recent one before a report's end date is used." actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>Add rate</Button>}>
        <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No exchange rates recorded' }} />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={adding} onClose={() => setAdding(false)} size="sm" title="Add exchange rate" footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button loading={loading} onClick={save}>Record rate</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From currency"><Input value={f.base} maxLength={3} placeholder="USD" onChange={(e) => setF((s) => ({ ...s, base: e.target.value.toUpperCase() }))} autoFocus /></Field>
          <Field label="To currency"><Input value={f.quote} maxLength={3} onChange={(e) => setF((s) => ({ ...s, quote: e.target.value.toUpperCase() }))} /></Field>
        </div>
        <Field label="Rate" hint={`One unit of ${f.base || 'the first currency'} equals this many ${f.quote || 'units of the second'}.`}><Input inputMode="decimal" value={f.rate} onChange={(e) => setF((s) => ({ ...s, rate: e.target.value.trim() }))} placeholder="129.25" /></Field>
        <FormError error={formError} />
      </Modal>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, user } = useAuth();
  const platform = can('settings.manage') && user.allBrands;
  const tabs = [
    { id: 'health', label: 'System health', show: can('system.health') },
    { id: 'platform', label: 'Platform settings', show: platform },
    { id: 'currencies', label: 'Currencies', show: platform },
    { id: 'rates', label: 'Exchange rates', show: platform },
  ].filter((t) => t.show);
  const active = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id;
  return (
    <>
      <PageHeader title="Settings" description="Platform health, alerts and platform-wide configuration." />
      {!tabs.length ? (
        <Card>
          <EmptyState title="Platform settings are managed by platform administrators" description="Your brand's own configuration (identity, domains, policies and payment set-up) is under Brands. Notification templates and sender domains are under Integrations." />
        </Card>
      ) : (
        <>
          <Tabs tabs={tabs} active={active} onChange={(id) => router.replace(`/settings?tab=${id}`)} />
          {active === 'health' && <HealthTab />}
          {active === 'platform' && <SettingsTab />}
          {active === 'currencies' && <CurrenciesTab />}
          {active === 'rates' && <RatesTab />}
        </>
      )}
    </>
  );
}
