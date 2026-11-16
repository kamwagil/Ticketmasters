'use client';

import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BarSeries } from '@/components/charts';
import { CampaignForm } from '@/components/crm/campaign-form';
import { BrandField, CHANNEL_LABEL, fromLocalInput, toLocalInput, useBrandChoice } from '@/components/crm/shared';
import {
  Badge, BrandChip, Button, Card, Column, ConfirmButton, CurrencyList, DataTable, DateTime, Field, FormError, Input, Modal, Money, PageHeader, Pagination, SearchInput,
  Select, SelectInput, StatusBadge, Tabs, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { bps, fromMinor, humanize, number, percent, toMinor } from '@/lib/format';
import { useAction, useDebounced, usePaged, useQuery } from '@/lib/hooks';

const revenue = (rows: any[] | undefined) => (rows ?? []).map((r) => ({ currency: r.currency, amountMinor: r.revenueMinor }));

// ───────────────────────── Campaigns ─────────────────────────

function CampaignsTab() {
  const router = useRouter();
  const { brands } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const search = useDebounced(q);
  const list = usePaged<any>('/v1/admin/marketing/campaigns', { q: search, status });
  const columns: Column<any>[] = [
    { key: 'name', header: 'Campaign', render: (c) => <div className="max-w-[18rem]"><div className="truncate font-medium text-slate-900">{c.name}</div><div className="truncate text-xs text-slate-500">{c.subject ?? CHANNEL_LABEL[c.channel]}</div></div> },
    { key: 'brand', header: 'Brand', render: (c) => <BrandChip brand={brands.find((b) => b.id === c.brandId) ?? (c.brandName ? { name: c.brandName } : null)} /> },
    { key: 'channel', header: 'Channel', render: (c) => CHANNEL_LABEL[c.channel] ?? c.channel },
    { key: 'status', header: 'Status', render: (c) => <div><StatusBadge status={c.status} />{c.status === 'SCHEDULED' && c.scheduledAt && <div className="mt-1 text-xs text-slate-500"><DateTime value={c.scheduledAt} /></div>}</div> },
    { key: 'audience', header: 'Audience', align: 'right', render: (c) => number(c.stats?.audience ?? 0) },
    { key: 'sent', header: 'Sent', align: 'right', render: (c) => number(c.stats?.sent ?? 0) },
    { key: 'opens', header: 'Opens', align: 'right', render: (c) => number(c.stats?.opens ?? 0) },
    { key: 'clicks', header: 'Clicks', align: 'right', render: (c) => number(c.stats?.clicks ?? 0) },
    { key: 'unsub', header: 'Unsubscribes', align: 'right', render: (c) => number(c.stats?.unsubscribes ?? 0) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (c) => <CurrencyList items={revenue(c.stats?.revenueByCurrency)} className="items-end" /> },
    { key: 'sentAt', header: 'Sent on', render: (c) => <DateTime value={c.sentAt} mode="date" /> },
  ];
  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Campaign name" />
        <Select value={status} onChange={setStatus} placeholder="Any status" options={['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED'].map((s) => ({ value: s, label: humanize(s) }))} />
        <Can permission="marketing.manage"><div className="ml-auto"><Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New campaign</Button></div></Can>
      </Toolbar>
      <DataTable
        columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={(c) => router.push(`/marketing/campaigns/${c.id}`)}
        empty={{ title: 'No campaigns yet', description: 'Create a campaign to email or message one of your customer segments.' }}
      />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      {creating && <CampaignForm onClose={() => setCreating(false)} onDone={(c) => router.push(`/marketing/campaigns/${c.id}`)} />}
    </Card>
  );
}

// ───────────────────────── Promo codes ─────────────────────────

function PromoDialog({ promo, onClose, onDone }: { promo: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { brands } = useAuth();
  const choice = useBrandChoice(promo?.brandId ?? '');
  const brandId: string = promo?.brandId ?? choice.brandId;
  const brand = brands.find((b) => b.id === brandId);
  const [code, setCode] = useState<string>(promo?.code ?? '');
  const [description, setDescription] = useState<string>(promo?.description ?? '');
  const [type, setType] = useState<string>(promo?.discountType ?? 'PERCENT');
  const [pct, setPct] = useState<string>(promo?.percentBps ? String(promo.percentBps / 100) : '');
  const [amount, setAmount] = useState<string>(promo?.amountMinor ? fromMinor(promo.amountMinor) : '');
  const [currency, setCurrency] = useState<string>(promo?.currency ?? '');
  const [eventId, setEventId] = useState<string>(promo?.eventId ?? '');
  const [max, setMax] = useState<string>(promo?.maxRedemptions ? String(promo.maxRedemptions) : '');
  const [minOrder, setMinOrder] = useState<string>(promo?.minOrderMinor ? fromMinor(promo.minOrderMinor) : '');
  const [startsAt, setStartsAt] = useState(toLocalInput(promo?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(promo?.endsAt));
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const events = useQuery<{ items: any[] }>(brandId ? '/v1/admin/events' : null, { brandId, pageSize: 100 }, { scoped: false });
  const cur = currency || brand?.defaultCurrency || '';

  const save = async () => {
    setError(null);
    const body: Record<string, unknown> = { description: description.trim() || undefined };
    if (type === 'PERCENT') {
      const n = Number(pct);
      if (!(n > 0 && n <= 100)) return setError('Enter a percentage between 0.01 and 100.');
      body.percentBps = Math.round(n * 100);
    } else {
      const minor = toMinor(amount);
      if (!minor) return setError('Enter the discount amount, for example 500 or 500.00.');
      if (!cur) return setError('Choose the currency of the fixed discount.');
      body.amountMinor = minor;
    }
    if (max && !(Number.isInteger(Number(max)) && Number(max) >= 1)) return setError('Maximum redemptions must be a whole number.');
    const minMinor = minOrder ? toMinor(minOrder) : null;
    if (minOrder && minMinor === null) return setError('Enter the minimum order as an amount.');
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) return setError('The end must be after the start.');
    const res = await run(
      () =>
        promo
          ? api.patch(`/v1/admin/marketing/promo-codes/${promo.id}`, {
              ...body, eventId: eventId || null, maxRedemptions: max ? Number(max) : null, minOrderMinor: minMinor, startsAt: fromLocalInput(startsAt), endsAt: fromLocalInput(endsAt),
            })
          : api.post('/v1/admin/marketing/promo-codes', {
              ...body, brandId, code: code.trim().toUpperCase(), discountType: type, ...(type === 'FIXED' ? { currency: cur } : {}), ...(eventId ? { eventId } : {}),
              ...(max ? { maxRedemptions: Number(max) } : {}), ...(minMinor !== null ? { minOrderMinor: minMinor } : {}),
              ...(startsAt ? { startsAt: fromLocalInput(startsAt) } : {}), ...(endsAt ? { endsAt: fromLocalInput(endsAt) } : {}),
            }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(promo ? 'Promo code updated' : 'Promo code created');
      onDone();
      onClose();
    }
  };

  return (
    <Modal
      open onClose={onClose} title={promo ? `Edit ${promo.code}` : 'New promo code'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!brandId || !/^[A-Za-z0-9_-]{3,40}$/.test(code.trim())} onClick={save}>{promo ? 'Save changes' : 'Create code'}</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <BrandField value={brandId} onChange={(v) => { choice.setBrandId(v); setEventId(''); }} locked={!!promo || choice.locked} hint="The code only works on this brand's storefront." />
        <Field label="Code" hint="3 to 40 letters, numbers, - or _"><Input value={code} disabled={!!promo} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono uppercase" placeholder="KARIBU10" /></Field>
      </div>
      <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown to staff only" /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Discount type" hint={promo ? 'The type cannot be changed after creation.' : undefined}>
          <SelectInput value={type} disabled={!!promo} onChange={(e) => setType(e.target.value)} options={[{ value: 'PERCENT', label: 'Percentage off' }, { value: 'FIXED', label: 'Fixed amount off' }]} />
        </Field>
        {type === 'PERCENT' ? (
          <Field label="Percentage off"><Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="10" /></Field>
        ) : (
          <Field label="Amount off">
            <div className="flex gap-2">
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500.00" />
              <SelectInput value={cur} disabled={!!promo} onChange={(e) => setCurrency(e.target.value)} placeholder="Currency" options={[...new Set([brand?.defaultCurrency, 'KES', 'USD', 'GBP', 'EUR'].filter(Boolean) as string[])].map((c) => ({ value: c, label: c }))} className="w-28" />
            </div>
          </Field>
        )}
      </div>
      <Field label="Limit to one event"><SelectInput value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="All events on this storefront" options={(events.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Maximum redemptions"><Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} placeholder="Unlimited" /></Field>
        <Field label={`Minimum order${cur ? ` (${cur})` : ''}`}><Input inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} placeholder="None" /></Field>
        <Field label="Valid from"><Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>
        <Field label="Valid until"><Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function PromoTab() {
  const toast = useToast();
  const { brands, can } = useAuth();
  const [q, setQ] = useState('');
  const search = useDebounced(q);
  const list = usePaged<any>('/v1/admin/marketing/promo-codes', { q: search });
  const [dialog, setDialog] = useState<{ promo: any | null } | null>(null);
  const expired = (p: any) => p.endsAt && new Date(p.endsAt) < new Date();
  const columns: Column<any>[] = [
    { key: 'code', header: 'Code', render: (p) => <div className="max-w-[16rem]"><div className="font-mono text-[13px] font-semibold text-slate-900">{p.code}</div>{p.description && <div className="truncate text-xs text-slate-500">{p.description}</div>}</div> },
    { key: 'brand', header: 'Brand', render: (p) => <BrandChip brand={brands.find((b) => b.id === p.brandId)} /> },
    { key: 'discount', header: 'Discount', render: (p) => (p.discountType === 'PERCENT' ? `${bps(p.percentBps ?? 0)} off` : <><Money minor={p.amountMinor} currency={p.currency} /> off</>) },
    { key: 'used', header: 'Redemptions', align: 'right', render: (p) => `${number(p.redeemedCount)}${p.maxRedemptions ? ` / ${number(p.maxRedemptions)}` : ''}` },
    { key: 'validity', header: 'Validity', render: (p) => (p.startsAt || p.endsAt ? <span className="text-xs"><DateTime value={p.startsAt} mode="date" /> → <DateTime value={p.endsAt} mode="date" /></span> : <span className="text-slate-500">No end date</span>) },
    { key: 'orders', header: 'Paid orders', align: 'right', render: (p) => number(p.paidOrders ?? 0) },
    { key: 'revenue', header: 'Attributed revenue', align: 'right', render: (p) => <CurrencyList items={revenue(p.revenueByCurrency)} className="items-end" /> },
    { key: 'active', header: 'Status', render: (p) => (!p.active ? <Badge tone="gray">Inactive</Badge> : expired(p) ? <Badge tone="gray">Expired</Badge> : <Badge tone="green">Active</Badge>) },
    {
      key: 'actions', header: '', align: 'right',
      render: (p) =>
        can('marketing.manage') && (
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setDialog({ promo: p })}>Edit</Button>
            {p.active ? (
              <ConfirmButton
                label="Deactivate" variant="ghost" size="sm" title={`Deactivate ${p.code}?`} confirmLabel="Deactivate" body="Customers will no longer be able to apply this code. Orders that already used it are unaffected."
                onConfirm={() => api.delete(`/v1/admin/marketing/promo-codes/${p.id}`).then(() => { toast.success(`${p.code} deactivated`); list.reload(); })}
              />
            ) : (
              <Button variant="ghost" size="sm" onClick={() => api.patch(`/v1/admin/marketing/promo-codes/${p.id}`, { active: true }).then(() => { toast.success(`${p.code} reactivated`); list.reload(); }).catch((e) => toast.error(e.message))}>Reactivate</Button>
            )}
          </div>
        ),
    },
  ];
  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Promo code" />
        <Can permission="marketing.manage"><div className="ml-auto"><Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ promo: null })}>New promo code</Button></div></Can>
      </Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No promo codes', description: 'Create a code to offer a discount on one brand’s storefront.' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      {dialog && <PromoDialog promo={dialog.promo} onClose={() => setDialog(null)} onDone={list.reload} />}
    </Card>
  );
}

// ───────────────────────── Performance ─────────────────────────

function PerformanceTab() {
  const router = useRouter();
  const { brands } = useAuth();
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/marketing/campaigns/compare');
  const rows = data ?? [];
  const columns: Column<any>[] = [
    { key: 'name', header: 'Campaign', render: (c) => <span className="block max-w-[16rem] truncate font-medium text-slate-900">{c.name}</span> },
    { key: 'brand', header: 'Brand', render: (c) => <BrandChip brand={brands.find((b) => b.id === c.brandId)} /> },
    { key: 'channel', header: 'Channel', render: (c) => CHANNEL_LABEL[c.channel] ?? c.channel },
    { key: 'sentAt', header: 'Sent', render: (c) => <DateTime value={c.sentAt} mode="date" /> },
    { key: 'audience', header: 'Audience', align: 'right', render: (c) => number(c.audience) },
    { key: 'sent', header: 'Sent', align: 'right', render: (c) => number(c.sent) },
    { key: 'skipped', header: 'Skipped', align: 'right', render: (c) => number(c.skipped) },
    { key: 'openRate', header: 'Open rate', align: 'right', render: (c) => (c.channel === 'EMAIL' ? percent(c.openRate) : '-') },
    { key: 'clickRate', header: 'Click rate', align: 'right', render: (c) => (c.channel === 'EMAIL' ? percent(c.clickRate) : '-') },
    { key: 'unsub', header: 'Unsubscribes', align: 'right', render: (c) => number(c.unsubscribes) },
    { key: 'conv', header: 'Orders', align: 'right', render: (c) => number(c.conversions) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (c) => <CurrencyList items={revenue(c.revenueByCurrency)} className="items-end" /> },
  ];
  return (
    <div className="space-y-5">
      <Card title="Delivery and engagement" description="The most recent sent campaigns, side by side">
        <BarSeries
          data={[...rows].reverse().slice(-12).map((c) => ({ name: c.name.length > 18 ? `${c.name.slice(0, 17)}…` : c.name, sent: c.sent, opens: c.opens, clicks: c.clicks }))}
          xKey="name"
          series={[{ key: 'sent', label: 'Sent' }, { key: 'opens', label: 'Opened' }, { key: 'clicks', label: 'Clicked' }]}
        />
      </Card>
      <Card title="Campaign comparison" description="Revenue is from paid orders attributed to the campaign, shown per currency" padded={false}>
        <DataTable columns={columns} rows={rows} loading={loading} error={error} onRetry={reload} onRowClick={(c) => router.push(`/marketing/campaigns/${c.id}`)} empty={{ title: 'No sent campaigns yet', description: 'Results appear here once a campaign has been sent.' }} />
      </Card>
    </div>
  );
}

export default function MarketingPage() {
  const wanted = useSearchParams().get('tab');
  const [tab, setTab] = useState(['campaigns', 'promos', 'performance'].includes(wanted ?? '') ? (wanted as string) : 'campaigns');
  return (
    <>
      <PageHeader title="Marketing" description="Campaigns and promo codes are run per brand. A brand can only message its own customers, and only those who consented to that brand." />
      <Tabs tabs={[{ id: 'campaigns', label: 'Campaigns' }, { id: 'promos', label: 'Promo codes' }, { id: 'performance', label: 'Performance' }]} active={tab} onChange={setTab} />
      {tab === 'campaigns' && <CampaignsTab />}
      {tab === 'promos' && <PromoTab />}
      {tab === 'performance' && <PerformanceTab />}
    </>
  );
}
