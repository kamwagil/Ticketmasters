'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CURRENCY_RE, Notice } from '@/components/platform/bits';
import { Badge, Button, Card, Checkbox, Column, DataTable, Field, FormError, Input, Modal, Money, SelectInput, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { bps, fromMinor, humanize, toMinor } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

const TYPES = [
  { value: 'PLATFORM_COMMISSION', label: 'Platform commission (deducted from the promoter)' },
  { value: 'BRAND_COMMISSION', label: 'Brand commission (deducted from the promoter)' },
  { value: 'SERVICE_FEE', label: 'Service fee (added to the customer total)' },
  { value: 'TAX', label: 'Tax (added to the customer total)' },
];

function RuleForm({ rule, onClose, onDone }: { rule?: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { brands } = useAuth();
  const organizers = useQuery<{ items: any[] }>(rule ? null : '/v1/admin/organizers', { pageSize: 200 }, { scoped: false });
  const events = useQuery<{ items: any[] }>(rule ? null : '/v1/admin/events', { pageSize: 100 }, { scoped: false });
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    name: rule?.name ?? '', type: rule?.type ?? 'PLATFORM_COMMISSION', brandId: '', organizerId: '', eventId: '',
    percent: rule ? (rule.percentBps / 100).toString() : '', fixed: rule && Number(rule.fixedMinor) > 0 ? fromMinor(rule.fixedMinor) : '', currency: rule?.currency ?? '', active: rule?.active ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    setError(null);
    const pct = Number(f.percent || '0');
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return setError('Percentage must be between 0 and 100.');
    const percentBps = Math.round(pct * 100);
    const fixedMinor = f.fixed.trim() ? toMinor(f.fixed) : 0;
    if (fixedMinor === null) return setError('Enter the fixed amount as a number, for example 30.00.');
    if (fixedMinor > 0 && !CURRENCY_RE.test(f.currency)) return setError('A fixed amount needs a 3-letter currency code.');
    const common = { name: f.name.trim(), percentBps, fixedMinor, ...(fixedMinor > 0 ? { currency: f.currency } : {}), active: f.active };
    const res = await run(
      () => rule
        ? api.patch(`/v1/admin/commission-rules/${rule.id}`, common)
        : api.post('/v1/admin/commission-rules', { ...common, type: f.type, ...(f.brandId ? { brandId: f.brandId } : {}), ...(f.organizerId ? { organizerId: f.organizerId } : {}), ...(f.eventId ? { eventId: f.eventId } : {}) }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(rule ? 'Commission rule updated' : 'Commission rule created');
      onDone();
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={rule ? 'Edit commission rule' : 'New commission rule'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={loading} disabled={f.name.trim().length < 3} onClick={submit}>{rule ? 'Save changes' : 'Create rule'}</Button>
        </>
      }
    >
      <Field label="Name" hint="Describe the agreement, for example: Premier League negotiated commission."><Input value={f.name} onChange={set('name')} autoFocus /></Field>
      {rule ? (
        <p className="text-sm text-slate-600">{humanize(rule.type)} · applies to {rule.event?.name ?? rule.organizer?.name ?? rule.brand?.name ?? 'the whole platform'}. Type and scope cannot be changed; create a new rule instead.</p>
      ) : (
        <>
          <Field label="Type"><SelectInput value={f.type} onChange={set('type')} options={TYPES} /></Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Brand" hint="Leave empty for all brands."><SelectInput value={f.brandId} onChange={set('brandId')} placeholder="Any brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} /></Field>
            <Field label="Organizer"><SelectInput value={f.organizerId} onChange={set('organizerId')} placeholder="Any organizer" options={(organizers.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))} /></Field>
            <Field label="Event"><SelectInput value={f.eventId} onChange={set('eventId')} placeholder="Any event" options={(events.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))} /></Field>
          </div>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Percentage" hint="For example 2.5 for 2.5%."><Input inputMode="decimal" value={f.percent} onChange={set('percent')} placeholder="0" /></Field>
        <Field label="Fixed amount per ticket" hint="Optional."><Input inputMode="decimal" value={f.fixed} onChange={set('fixed')} placeholder="0.00" /></Field>
        <Field label="Currency of fixed amount"><Input value={f.currency} maxLength={3} onChange={(e) => setF((s) => ({ ...s, currency: e.target.value.toUpperCase() }))} placeholder="KES" /></Field>
      </div>
      <Checkbox checked={f.active} onChange={(v) => setF((s) => ({ ...s, active: v }))} label="Active" hint="Inactive rules are ignored at checkout." />
      <Notice>Changes apply to new orders only. Every existing order keeps the allocation that was recorded when it was placed.</Notice>
      <FormError error={error} />
    </Modal>
  );
}

export function CommissionRulesTab() {
  const { can, user } = useAuth();
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/commission-rules', undefined, { scoped: false });
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const canManage = can('commissions.manage') && user.allBrands;
  const columns: Column<any>[] = [
    { key: 'name', header: 'Rule', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'type', header: 'Type', render: (r) => humanize(r.type) },
    { key: 'scope', header: 'Applies to', render: (r) => <div><Badge tone={r.scope === 'PLATFORM' ? 'gray' : 'indigo'}>{humanize(r.scope)}</Badge><div className="mt-0.5 text-xs text-slate-500">{r.event?.name ?? r.organizer?.name ?? r.brand?.name ?? 'Default for everything'}</div></div> },
    { key: 'percent', header: 'Percentage', align: 'right', render: (r) => bps(r.percentBps) },
    { key: 'fixed', header: 'Fixed per ticket', align: 'right', render: (r) => (Number(r.fixedMinor) > 0 && r.currency ? <Money minor={r.fixedMinor} currency={r.currency} /> : '-') },
    { key: 'active', header: 'Status', render: (r) => <Badge tone={r.active ? 'green' : 'gray'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
  ];
  return (
    <div className="space-y-5">
      <Card title="How commission rules work">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li><strong>Most specific rule wins</strong> for each type: an event rule beats an organizer rule, which beats a brand rule, which beats the platform default.</li>
          <li><strong>Service fee and tax</strong> are added on top of the ticket price and paid by the customer.</li>
          <li><strong>Platform and brand commission</strong> are deducted from the promoter's share of the ticket price. The customer's total does not change.</li>
          <li>Each order stores the allocation that applied at checkout, so changing a rule never alters past orders or payables.</li>
        </ul>
      </Card>
      <Card padded={false} title="Commission rules" actions={canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>New rule</Button>}>
        <DataTable columns={columns} rows={data ?? []} loading={loading} error={error} onRetry={reload} onRowClick={canManage ? setEditing : undefined} empty={{ title: 'No commission rules', description: 'Without rules, no commission or service fee is charged.' }} />
      </Card>
      {editing && <RuleForm rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={reload} />}
    </div>
  );
}
