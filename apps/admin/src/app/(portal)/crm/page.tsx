'use client';

import { Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandField, BrandPrompt, CHANNEL_LABEL, CHANNELS, useBrandChoice } from '@/components/crm/shared';
import {
  Badge, BrandChip, Button, Card, Checkbox, Column, ConfirmButton, DataTable, DateTime, Drawer, EmptyState, ExportMenu, Field, FormError, Input, Modal, PageHeader,
  Pagination, Select, SelectInput, Tabs, Textarea, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { fromMinor, humanize, money, number, toMinor } from '@/lib/format';
import { useAction, usePaged, useQuery } from '@/lib/hooks';

// ───────────────────────── Segment rules <-> form ─────────────────────────

interface RuleForm {
  eventCategory: string; eventId: string; performerId: string; country: string; city: string; minOrders: string; minSpend: string; currency: string;
  purchasedAfter: string; purchasedBefore: string; inactiveDays: string; abandonedCheckout: boolean; tagIds: string[]; upcomingEventCategory: string; hasMarketingConsent: string;
}
const EMPTY: RuleForm = {
  eventCategory: '', eventId: '', performerId: '', country: '', city: '', minOrders: '', minSpend: '', currency: '', purchasedAfter: '', purchasedBefore: '',
  inactiveDays: '', abandonedCheckout: false, tagIds: [], upcomingEventCategory: '', hasMarketingConsent: '',
};

function toForm(rules: Record<string, any> | null | undefined): RuleForm {
  const r = rules ?? {};
  return {
    ...EMPTY,
    eventCategory: r.eventCategory ?? '', eventId: r.eventId ?? '', performerId: r.performerId ?? '', country: r.country ?? '', city: r.city ?? '',
    minOrders: r.minOrders ? String(r.minOrders) : '', minSpend: r.minSpendMinor ? fromMinor(r.minSpendMinor) : '', currency: r.currency ?? '',
    purchasedAfter: r.purchasedAfter ? String(r.purchasedAfter).slice(0, 10) : '', purchasedBefore: r.purchasedBefore ? String(r.purchasedBefore).slice(0, 10) : '',
    inactiveDays: r.inactiveDays ? String(r.inactiveDays) : '', abandonedCheckout: !!r.abandonedCheckout, tagIds: r.tagIds ?? [],
    upcomingEventCategory: r.upcomingEventCategory ?? '', hasMarketingConsent: r.hasMarketingConsent ?? '',
  };
}

/** Builds the API rules object. Returns an error message when the form is inconsistent. */
function toRules(f: RuleForm): { rules: Record<string, unknown>; error: string | null } {
  const rules: Record<string, unknown> = {};
  for (const k of ['eventCategory', 'eventId', 'performerId', 'country', 'city', 'upcomingEventCategory', 'hasMarketingConsent'] as const) if (f[k].trim()) rules[k] = f[k].trim();
  if (f.minOrders) {
    const n = Number(f.minOrders);
    if (!Number.isInteger(n) || n < 1) return { rules, error: 'Minimum orders must be a whole number of at least 1.' };
    rules.minOrders = n;
  }
  if (f.minSpend) {
    const minor = toMinor(f.minSpend);
    if (!minor) return { rules, error: 'Enter the minimum spend as an amount, for example 10000 or 10,000.00.' };
    if (!f.currency) return { rules, error: 'Choose the currency for the minimum spend. Amounts are never compared across currencies.' };
    rules.minSpendMinor = minor;
    rules.currency = f.currency;
  }
  if (f.purchasedAfter) rules.purchasedAfter = new Date(`${f.purchasedAfter}T00:00:00`).toISOString();
  if (f.purchasedBefore) rules.purchasedBefore = new Date(`${f.purchasedBefore}T23:59:59`).toISOString();
  if (f.inactiveDays) {
    const n = Number(f.inactiveDays);
    if (!Number.isInteger(n) || n < 1) return { rules, error: 'Inactive days must be a whole number of at least 1.' };
    rules.inactiveDays = n;
  }
  if (f.abandonedCheckout) rules.abandonedCheckout = true;
  if (f.tagIds.length) rules.tagIds = f.tagIds;
  return { rules, error: null };
}

/** Plain-language summary of a stored rule set for the list. */
function describe(rules: Record<string, any>, names: { category: (slug: string) => string }): string[] {
  const out: string[] = [];
  if (rules.eventCategory) out.push(`Bought ${names.category(rules.eventCategory)} tickets`);
  if (rules.eventId) out.push('Bought a specific event');
  if (rules.performerId) out.push('Follows an artist or team');
  if (rules.country) out.push(`Country: ${rules.country}`);
  if (rules.city) out.push(`City: ${rules.city}`);
  if (rules.minOrders) out.push(`${rules.minOrders}+ orders`);
  if (rules.minSpendMinor) out.push(`Spent ${money(rules.minSpendMinor, rules.currency)}+`);
  if (rules.purchasedAfter) out.push(`Purchased after ${String(rules.purchasedAfter).slice(0, 10)}`);
  if (rules.purchasedBefore) out.push(`Purchased before ${String(rules.purchasedBefore).slice(0, 10)}`);
  if (rules.inactiveDays) out.push(`No purchase in ${rules.inactiveDays} days`);
  if (rules.abandonedCheckout) out.push('Abandoned checkout');
  if (rules.tagIds?.length) out.push(`${rules.tagIds.length} tag${rules.tagIds.length === 1 ? '' : 's'}`);
  if (rules.upcomingEventCategory) out.push(`Upcoming ${names.category(rules.upcomingEventCategory)}`);
  if (rules.hasMarketingConsent) out.push(`Consents to ${CHANNEL_LABEL[rules.hasMarketingConsent] ?? rules.hasMarketingConsent}`);
  return out.length ? out : ['All active customers of the brand'];
}

// ───────────────────────── Segment builder ─────────────────────────

function SegmentBuilder({ segment, defaultBrandId, lockedBrand, onClose, onDone }: { segment: any | null; defaultBrandId: string; lockedBrand: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { brands } = useAuth();
  const [brandId, setBrandId] = useState<string>(segment?.brandId ?? defaultBrandId);
  const [name, setName] = useState(segment?.name ?? '');
  const [description, setDescription] = useState(segment?.description ?? '');
  const [f, setF] = useState<RuleForm>(toForm(segment?.rules));
  const [preview, setPreview] = useState<{ count: number; sample: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useAction();
  const previewing = useAction();

  const categories = useQuery<any[]>('/v1/admin/event-categories', undefined, { scoped: false });
  const performers = useQuery<any[]>('/v1/admin/performers', undefined, { scoped: false });
  const events = useQuery<{ items: any[] }>(brandId ? '/v1/admin/events' : null, { brandId, pageSize: 100 }, { scoped: false });
  const tags = useQuery<any[]>(brandId ? '/v1/admin/customer-tags' : null, { brandId }, { scoped: false });
  const brand = brands.find((b) => b.id === brandId);
  const currency = f.currency || brand?.defaultCurrency || '';

  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setPreview(null);
  };
  const slug = (...want: string[]) => categories.data?.find((c) => want.some((w) => c.slug.includes(w)))?.slug ?? '';
  const starters: { label: string; apply: () => Partial<RuleForm> & { name: string } }[] = [
    { label: 'Bought concert tickets', apply: () => ({ name: 'Bought concert tickets', eventCategory: slug('concert') }) },
    { label: 'Attended football events', apply: () => ({ name: 'Football fans', eventCategory: slug('football') }) },
    { label: 'Spent more than…', apply: () => ({ name: 'High-value customers', minSpend: '10000.00', currency: brand?.defaultCurrency ?? '' }) },
    { label: 'Purchased in a city', apply: () => ({ name: 'Purchased in Nairobi', city: 'Nairobi' }) },
    { label: 'No purchase in 6 months', apply: () => ({ name: 'Lapsed (6 months)', inactiveDays: '180' }) },
    { label: 'Interested in upcoming festivals', apply: () => ({ name: 'Upcoming festival goers', upcomingEventCategory: slug('festival') }) },
    { label: 'Abandoned checkout', apply: () => ({ name: 'Abandoned checkout', abandonedCheckout: true }) },
  ];

  const runPreview = async () => {
    setError(null);
    const { rules, error: bad } = toRules({ ...f, currency });
    if (bad) return setError(bad);
    if (!brandId) return setError('Choose a brand first.');
    const res = await previewing.run(() => api.post('/v1/admin/segments/preview', { brandId, rules }), { onError: (e) => setError(e.message) });
    if (res) setPreview(res);
  };
  const save = async () => {
    setError(null);
    const { rules, error: bad } = toRules({ ...f, currency });
    if (bad) return setError(bad);
    const body = { name: name.trim(), description: description.trim() || undefined, rules };
    const res = await saving.run(() => (segment ? api.patch(`/v1/admin/segments/${segment.id}`, body) : api.post('/v1/admin/segments', { brandId, ...body })), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(segment ? 'Segment updated' : 'Segment created');
      onDone();
      onClose();
    }
  };
  const catOptions = (categories.data ?? []).map((c) => ({ value: c.slug, label: c.name }));

  return (
    <Modal
      open onClose={onClose} size="lg" title={segment ? 'Edit segment' : 'New segment'}
      footer={
        <>
          <Button variant="secondary" loading={previewing.loading} icon={<Users className="h-4 w-4" />} onClick={runPreview}>Preview</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={saving.loading} disabled={name.trim().length < 2 || !brandId} onClick={save}>{segment ? 'Save segment' : 'Create segment'}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <BrandField value={brandId} onChange={(v) => { setBrandId(v); setPreview(null); set('tagIds', []); set('eventId', ''); }} locked={!!segment || lockedBrand} hint="A segment only ever looks at this brand's customers, orders and consent." />
        <Field label="Segment name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Festival goers" /></Field>
      </div>
      <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></Field>

      {!segment && (
        <div>
          <div className="mb-1.5 text-sm font-medium text-slate-700">Start from</div>
          <div className="flex flex-wrap gap-1.5">
            {starters.map((s) => (
              <button key={s.label} type="button" onClick={() => { const { name: n, ...rules } = s.apply(); setF({ ...EMPTY, ...rules }); setName((cur: string) => cur || n); setPreview(null); }} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-accent-50 hover:text-accent-700">
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 p-4">
        <p className="mb-3 text-xs text-slate-500">A customer must match every rule you fill in. Leave a rule empty to ignore it.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bought tickets in category"><SelectInput value={f.eventCategory} onChange={(e) => set('eventCategory', e.target.value)} placeholder="Any category" options={catOptions} /></Field>
          <Field label="Bought tickets for event"><SelectInput value={f.eventId} onChange={(e) => set('eventId', e.target.value)} placeholder="Any event" options={(events.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))} /></Field>
          <Field label="Artist or team followed" hint="Bought a ticket for an event featuring them"><SelectInput value={f.performerId} onChange={(e) => set('performerId', e.target.value)} placeholder="Any artist or team" options={(performers.data ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Field>
          <Field label="Interested in upcoming events in" hint="Holds a valid ticket for a future event in this category"><SelectInput value={f.upcomingEventCategory} onChange={(e) => set('upcomingEventCategory', e.target.value)} placeholder="Not used" options={catOptions} /></Field>
          <Field label="Country"><Input value={f.country} onChange={(e) => set('country', e.target.value)} placeholder="For example: Kenya" /></Field>
          <Field label="City" hint="Lives in, or bought tickets for an event in, this city"><Input value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="For example: London" /></Field>
          <Field label="Minimum number of purchases"><Input inputMode="numeric" value={f.minOrders} onChange={(e) => set('minOrders', e.target.value.replace(/\D/g, ''))} placeholder="Not used" /></Field>
          <Field label="Minimum total spending" hint="Net of refunds, in one currency">
            <div className="flex gap-2">
              <Input inputMode="decimal" value={f.minSpend} onChange={(e) => set('minSpend', e.target.value)} placeholder="Not used" />
              <SelectInput value={currency} onChange={(e) => set('currency', e.target.value)} placeholder="Currency" options={(brand?.defaultCurrency ? [...new Set([brand.defaultCurrency, 'KES', 'USD', 'GBP', 'EUR'])] : ['KES', 'USD', 'GBP', 'EUR']).map((c) => ({ value: c, label: c }))} className="w-28" />
            </div>
          </Field>
          <Field label="Purchased on or after"><Input type="date" value={f.purchasedAfter} onChange={(e) => set('purchasedAfter', e.target.value)} /></Field>
          <Field label="Purchased on or before"><Input type="date" value={f.purchasedBefore} onChange={(e) => set('purchasedBefore', e.target.value)} /></Field>
          <Field label="Inactive for at least (days)" hint="Bought before, but not in this many days. 180 is about six months."><Input inputMode="numeric" value={f.inactiveDays} onChange={(e) => set('inactiveDays', e.target.value.replace(/\D/g, ''))} placeholder="Not used" /></Field>
          <Field label="Has marketing consent on" hint="Campaigns re-check consent when sending regardless of this rule"><SelectInput value={f.hasMarketingConsent} onChange={(e) => set('hasMarketingConsent', e.target.value)} placeholder="Not used" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} /></Field>
        </div>
        <div className="mt-4 space-y-3">
          <Checkbox checked={f.abandonedCheckout} onChange={(v) => set('abandonedCheckout', v)} label="Abandoned a checkout" hint="Started but did not complete a purchase in the last 30 days" />
          {!!tags.data?.length && (
            <div>
              <div className="mb-1.5 text-sm font-medium text-slate-700">Has all of these tags</div>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {tags.data.map((t) => (
                  <Checkbox key={t.id} checked={f.tagIds.includes(t.id)} onChange={(v) => set('tagIds', v ? [...f.tagIds, t.id] : f.tagIds.filter((x) => x !== t.id))} label={<span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />{t.name}</span>} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {preview && (
        <div className="rounded-xl bg-accent-50 p-4">
          <div className="text-sm font-semibold text-accent-700">{number(preview.count)} customer{preview.count === 1 ? '' : 's'} match right now</div>
          {preview.sample.length > 0 && (
            <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
              {preview.sample.map((m) => <li key={m.id} className="truncate">{m.fullName} · {m.email ?? m.phone ?? 'no contact'}</li>)}
            </ul>
          )}
        </div>
      )}
      <FormError error={error} />
    </Modal>
  );
}

function MembersDrawer({ segment, onClose }: { segment: any; onClose: () => void }) {
  const list = usePaged<any>(`/v1/admin/segments/${segment.id}/members`, undefined, { scoped: false });
  return (
    <Drawer open onClose={onClose} title={`${segment.name} · members`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-slate-500">Evaluated live against current data.</span>
        <Can permission="reports.export"><ExportMenu path={`/v1/admin/segments/${segment.id}/members`} filename={`segment-${segment.name.replace(/\W+/g, '-').toLowerCase()}`} /></Can>
      </div>
      <div className="-mx-5 border-y border-slate-100">
        <DataTable
          rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload}
          columns={[
            { key: 'name', header: 'Customer', render: (m) => <Link href={`/customers/${m.id}`} className="font-medium text-accent-700 hover:underline">{m.fullName}</Link> },
            { key: 'email', header: 'Email', render: (m) => m.email ?? '-' },
            { key: 'phone', header: 'Phone', render: (m) => m.phone ?? '-' },
            { key: 'where', header: 'Location', render: (m) => [m.city, m.country].filter(Boolean).join(', ') || '-' },
          ]}
          empty={{ title: 'No customers match this segment' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </div>
    </Drawer>
  );
}

function SegmentsTab() {
  const toast = useToast();
  const choice = useBrandChoice();
  const { brands } = useAuth();
  const list = useQuery<any[]>('/v1/admin/segments', choice.locked ? undefined : choice.brandId ? { brandId: choice.brandId } : undefined);
  const categories = useQuery<any[]>('/v1/admin/event-categories', undefined, { scoped: false });
  const [builder, setBuilder] = useState<{ segment: any | null } | null>(null);
  const [members, setMembers] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const names = { category: (slug: string) => categories.data?.find((c) => c.slug === slug)?.name.toLowerCase() ?? slug };

  const evaluate = async (s: any) => {
    setBusy(s.id);
    try {
      const r = await api.post(`/v1/admin/segments/${s.id}/evaluate`);
      toast.success(`${s.name}: ${number(r.lastCount)} customers`);
      list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<any>[] = [
    { key: 'name', header: 'Segment', render: (s) => <div className="max-w-[18rem]"><div className="truncate font-medium text-slate-900">{s.name}</div>{s.description && <div className="truncate text-xs text-slate-500">{s.description}</div>}</div> },
    { key: 'brand', header: 'Brand', render: (s) => <BrandChip brand={brands.find((b) => b.id === s.brandId)} /> },
    { key: 'rules', header: 'Rules', render: (s) => <div className="flex max-w-[26rem] flex-wrap gap-1">{describe(s.rules ?? {}, names).map((d) => <Badge key={d} tone="indigo">{d}</Badge>)}</div> },
    { key: 'count', header: 'Customers', align: 'right', render: (s) => (s.lastCount === null ? <span className="text-slate-400">Not evaluated</span> : number(s.lastCount)) },
    { key: 'evaluated', header: 'Last evaluated', render: (s) => <DateTime value={s.lastEvaluatedAt} mode="relative" /> },
    {
      key: 'actions', header: '', align: 'right',
      render: (s) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" loading={busy === s.id} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => evaluate(s)}>Evaluate</Button>
          <Button variant="ghost" size="sm" onClick={() => setMembers(s)}>Members</Button>
          <Button variant="ghost" size="sm" onClick={() => setBuilder({ segment: s })}>Edit</Button>
          <ConfirmButton
            label="" icon={<Trash2 className="h-3.5 w-3.5" />} variant="ghost" size="sm" title={`Delete “${s.name}”?`} confirmLabel="Delete segment"
            body="Campaigns that already used this segment keep their results. A segment attached to a draft or scheduled campaign cannot be removed from it automatically."
            onConfirm={() => api.delete(`/v1/admin/segments/${s.id}`).then(() => { toast.success('Segment deleted'); list.reload(); })}
          />
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Customer segments" description="Reusable audiences. Each segment is evaluated inside one brand only." padded={false}
      actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setBuilder({ segment: null })}>New segment</Button>}
    >
      {!choice.locked && brands.length > 1 && (
        <Toolbar>
          <Select value={choice.brandId} onChange={choice.setBrandId} placeholder="All brands" options={brands.map((b) => ({ value: b.id, label: b.name }))} />
        </Toolbar>
      )}
      <DataTable columns={columns} rows={list.data ?? []} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No segments yet', description: 'Create a segment to target a campaign or export an audience.' }} />
      {builder && <SegmentBuilder segment={builder.segment} defaultBrandId={choice.brandId} lockedBrand={choice.locked} onClose={() => setBuilder(null)} onDone={list.reload} />}
      {members && <MembersDrawer segment={members} onClose={() => setMembers(null)} />}
    </Card>
  );
}

// ───────────────────────── Tags ─────────────────────────

function TagsTab() {
  const toast = useToast();
  const { can, brands } = useAuth();
  const choice = useBrandChoice();
  const list = useQuery<any[]>(choice.brandId ? '/v1/admin/customer-tags' : null, { brandId: choice.brandId }, { scoped: false });
  const [name, setName] = useState('');
  const [color, setColor] = useState('#64748b');
  const { run, loading } = useAction();
  const add = async () => {
    const res = await run(() => api.post('/v1/admin/customer-tags', { brandId: choice.brandId, name: name.trim(), color }), { onError: (e) => toast.error(e.message) });
    if (res) {
      setName('');
      toast.success('Tag created');
      list.reload();
    }
  };
  return (
    <Card title="Customer tags" description="Labels staff attach to customers. Tags belong to one brand and can be used as a segment rule." padded={false}>
      {!choice.locked && brands.length > 1 && <BrandPrompt value={choice.brandId} onChange={choice.setBrandId} what="Tags" />}
      {!choice.brandId ? (
        <EmptyState title="Choose a brand" description="Pick the brand whose tags you want to manage." />
      ) : (
        <>
          {can('customers.manage') && (
            <Toolbar>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag name" maxLength={40} className="w-full sm:w-64" onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} />
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Tag colour" className="h-9 w-10 cursor-pointer rounded-lg border-0 bg-white p-1 ring-1 ring-inset ring-slate-300" />
              <Button loading={loading} disabled={!name.trim()} icon={<Plus className="h-4 w-4" />} onClick={add}>Add tag</Button>
            </Toolbar>
          )}
          <DataTable
            rows={list.data ?? []} loading={list.loading} error={list.error} onRetry={list.reload}
            columns={[
              { key: 'name', header: 'Tag', render: (t) => <span className="inline-flex items-center gap-2 font-medium text-slate-900"><span className="h-3 w-3 rounded-full ring-1 ring-black/10" style={{ background: t.color }} />{t.name}</span> },
              { key: 'customers', header: 'Customers', align: 'right', render: (t) => number(t._count?.assignments ?? 0) },
              { key: 'createdAt', header: 'Created', render: (t) => <DateTime value={t.createdAt} mode="date" /> },
            ]}
            empty={{ title: 'No tags for this brand yet' }}
          />
        </>
      )}
    </Card>
  );
}

// ───────────────────────── Data requests ─────────────────────────

const DR_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'];

function DataRequestDialog({ request, onClose, onDone }: { request: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<string>(request.status);
  const [resolution, setResolution] = useState<string>(request.resolution ?? '');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const closing = ['COMPLETED', 'REJECTED'].includes(status);
  const save = async () => {
    setError(null);
    const res = await run(() => api.patch(`/v1/admin/data-requests/${request.id}`, { status, ...(resolution.trim() ? { resolution: resolution.trim() } : {}) }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Request updated');
      onDone();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title={`${humanize(request.type)} request`} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={loading} disabled={closing && resolution.trim().length < 3} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-2">
        <div><div className="text-xs text-slate-500">Customer</div><Link href={`/customers/${request.customerId}`} className="font-medium text-accent-700 hover:underline">{request.customerName ?? 'Customer'}</Link><div className="text-xs text-slate-500">{request.customerEmail}</div></div>
        <div><div className="text-xs text-slate-500">Brand</div><div className="text-slate-800">{request.brandName}</div></div>
        <div><div className="text-xs text-slate-500">Received</div><DateTime value={request.createdAt} /></div>
        <div><div className="text-xs text-slate-500">Respond by</div><span className={request.overdue ? 'font-semibold text-red-600' : ''}><DateTime value={request.dueAt} mode="date" />{request.overdue && ' · overdue'}</span></div>
      </div>
      {request.details && <Field label="What the customer asked"><p className="whitespace-pre-wrap rounded-lg border border-slate-200 p-3 text-sm text-slate-700">{request.details}</p></Field>}
      <p className="text-xs text-slate-500">
        {request.type === 'ACCESS' && 'Fulfil with “Export data” on the customer profile, then send the file to the customer through a secure channel.'}
        {request.type === 'CORRECTION' && 'Fulfil with “Edit details” on the customer profile.'}
        {request.type === 'DELETION' && 'Fulfil with “Anonymize” on the customer profile. Financial records are retained without personal details.'}
      </p>
      <Field label="Status"><SelectInput value={status} onChange={(e) => setStatus(e.target.value)} options={DR_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
      <Field label="Resolution" hint={closing ? 'Required when completing or rejecting: what was done, or why it was refused.' : 'Optional progress note.'}><Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

function DataRequestsTab() {
  const [status, setStatus] = useState('');
  const list = usePaged<any>('/v1/admin/data-requests', { status });
  const [open, setOpen] = useState<any | null>(null);
  const columns: Column<any>[] = [
    { key: 'type', header: 'Request', render: (r) => <span className="font-medium text-slate-900">{humanize(r.type)}</span> },
    { key: 'customer', header: 'Customer', render: (r) => <div className="max-w-[16rem]"><div className="truncate text-slate-900">{r.customerName ?? '-'}</div><div className="truncate text-xs text-slate-500">{r.customerEmail}</div></div> },
    { key: 'brand', header: 'Brand', render: (r) => r.brandName ?? '-' },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'COMPLETED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>{humanize(r.status)}</Badge> },
    { key: 'dueAt', header: 'Respond by', render: (r) => <span className={r.overdue ? 'font-semibold text-red-600' : ''}><DateTime value={r.dueAt} mode="date" />{r.overdue && <span className="ml-1.5"><Badge tone="red">Overdue</Badge></span>}</span> },
    { key: 'createdAt', header: 'Received', render: (r) => <DateTime value={r.createdAt} mode="date" /> },
  ];
  return (
    <Card title="Data subject requests" description="Access, correction and deletion requests made by customers under data protection law" padded={false}>
      <Toolbar><Select value={status} onChange={setStatus} placeholder="Any status" options={DR_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} /></Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={setOpen} empty={{ title: 'No requests', description: 'Requests customers submit from their account appear here.' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      {open && <DataRequestDialog request={open} onClose={() => setOpen(null)} onDone={list.reload} />}
    </Card>
  );
}

export default function CrmPage() {
  const { can } = useAuth();
  const tabs = [
    ...(can('crm.segments') ? [{ id: 'segments', label: 'Segments' }] : []),
    ...(can('customers.read') ? [{ id: 'tags', label: 'Tags' }] : []),
    ...(can('customers.privacy') ? [{ id: 'requests', label: 'Data requests' }] : []),
  ];
  const wanted = useSearchParams().get('tab');
  const [tab, setTab] = useState(tabs.some((t) => t.id === wanted) ? (wanted as string) : (tabs[0]?.id ?? ''));
  return (
    <>
      <PageHeader title="CRM" description="Segment customers, organise them with tags and handle privacy requests. Everything here is scoped to one brand at a time." />
      {tabs.length ? <Tabs tabs={tabs} active={tab} onChange={setTab} /> : <EmptyState title="You do not have access to CRM tools" />}
      {tab === 'segments' && <SegmentsTab />}
      {tab === 'tags' && <TagsTab />}
      {tab === 'requests' && <DataRequestsTab />}
    </>
  );
}
