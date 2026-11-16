'use client';

import { Download, Pencil, ShieldAlert, Tag, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CHANNEL_LABEL, CHANNELS } from '@/components/crm/shared';
import {
  Badge, BrandChip, Button, Card, Checkbox, Column, ConfirmButton, CurrencyList, DataTable, DateTime, ErrorState, Field, FormError, Input, KeyValue, Modal, Money,
  PageHeader, SelectInput, Skeleton, StatCard, StatusBadge, Tabs, Textarea, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { humanize, number } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

type Rel = { id: string; brandId: string; email: string; emailVerifiedAt: string | null; status: string; orderCount: number; firstOrderAt: string | null; lastOrderAt: string | null; lastLoginAt: string | null; brand: { id: string; name: string; primaryColor: string } };

function EditDialog({ customer, onClose, onDone }: { customer: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ fullName: customer.fullName ?? '', phone: customer.phone ?? '', country: customer.country ?? '', city: customer.city ?? '' });
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setError(null);
    const body: Record<string, string> = { fullName: form.fullName.trim() };
    if (form.phone.trim()) body.phone = form.phone.trim();
    if (form.country.trim()) body.country = form.country.trim();
    if (form.city.trim()) body.city = form.city.trim();
    const res = await run(() => api.patch(`/v1/admin/customers/${customer.id}`, body), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Customer details corrected');
      onDone();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Correct customer details" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={form.fullName.trim().length < 2} onClick={save}>Save changes</Button></>}>
      <p className="text-sm text-slate-600">Use this to correct personal data at the customer&apos;s request. The previous and new values are recorded in the audit log.</p>
      <Field label="Full name"><Input value={form.fullName} onChange={set('fullName')} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} placeholder="+254..." /></Field>
        <Field label="Country"><Input value={form.country} onChange={set('country')} /></Field>
      </div>
      <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

function ConsentDialog({ customerId, target, onClose, onDone }: { customerId: string; target: { rel: Rel; channel: string; granted: boolean }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [granted, setGranted] = useState(!target.granted);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const save = async () => {
    setError(null);
    const res = await run(() => api.post(`/v1/admin/customers/${customerId}/consents`, { brandId: target.rel.brandId, channel: target.channel, granted, reason: reason.trim() }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Consent change recorded');
      onDone();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={`${CHANNEL_LABEL[target.channel]} marketing · ${target.rel.brand.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={reason.trim().length < 3} onClick={save}>Record change</Button></>}>
      <p className="text-sm text-slate-600">
        This changes consent for <strong>{target.rel.brand.name}</strong> only. Consent is recorded per brand and is never shared with, or assumed for, any other brand.
      </p>
      <SelectInput value={granted ? 'yes' : 'no'} onChange={(e) => setGranted(e.target.value === 'yes')} options={[{ value: 'yes', label: 'Customer consents to marketing' }, { value: 'no', label: 'Customer withdraws consent' }]} />
      <Field label="Reason" hint="How the customer asked for this, for example “phone request on 12 March”. Kept as evidence.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <FormError error={error} />
    </Modal>
  );
}

function TagsDialog({ customerId, rels, current, onClose, onDone }: { customerId: string; rels: Rel[]; current: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [brandId, setBrandId] = useState(rels[0]?.brandId ?? '');
  const tags = useQuery<any[]>(brandId ? '/v1/admin/customer-tags' : null, { brandId }, { scoped: false });
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const selected = picked[brandId] ?? current.filter((t) => t.brandId === brandId).map((t) => t.id);
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const save = async () => {
    setError(null);
    const res = await run(() => api.put(`/v1/admin/customers/${customerId}/tags`, { brandId, tagIds: selected }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Tags updated');
      onDone();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title="Customer tags" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!brandId} onClick={save}>Save tags</Button></>}>
      <Field label="Brand" hint="Tags belong to one brand and are only visible to that brand's staff.">
        <SelectInput value={brandId} onChange={(e) => setBrandId(e.target.value)} options={rels.map((r) => ({ value: r.brandId, label: r.brand.name }))} />
      </Field>
      <div className="space-y-2 rounded-lg border border-slate-200 p-3">
        {tags.loading && <Skeleton className="h-5 w-40" />}
        {tags.data?.map((t) => (
          <Checkbox key={t.id} checked={selected.includes(t.id)} onChange={(v) => setPicked((p) => ({ ...p, [brandId]: v ? [...selected, t.id] : selected.filter((x) => x !== t.id) }))} label={<span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />{t.name}</span>} />
        ))}
        {tags.data && !tags.data.length && <p className="text-sm text-slate-500">This brand has no tags yet. Create them in <Link href="/crm?tab=tags" className="text-accent-700 hover:underline">CRM → Tags</Link>.</p>}
      </div>
      <FormError error={error ?? tags.error?.message} />
    </Modal>
  );
}

function AnonymizeDialog({ customer, rels, onClose, onDone }: { customer: any; rels: Rel[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { user, brandId: selectedBrand } = useAuth();
  const [brandId, setBrandId] = useState(selectedBrand && rels.some((r) => r.brandId === selectedBrand) ? selectedBrand : rels.length === 1 ? rels[0].brandId : '');
  const [reason, setReason] = useState('');
  const [allBrands, setAllBrands] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const go = async () => {
    setError(null);
    const res = await run(() => api.post(`/v1/admin/customers/${customer.id}/anonymize`, { brandId, reason: reason.trim(), ...(allBrands ? { allBrands: true } : {}) }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Personal data anonymized');
      onDone();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Anonymize personal data" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={loading} disabled={!brandId || reason.trim().length < 3 || typed !== 'ANONYMIZE'} onClick={go}>Anonymize permanently</Button></>}>
      <div className="flex items-start gap-2.5 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-inset ring-red-200">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>This cannot be undone.</strong> The customer&apos;s name, email, phone, sign-in, consents, notes and tags for the chosen brand are erased and their order and ticket records are
          stripped of personal details. Orders, payments, refunds and ledger entries are kept, without personal data, because the law requires financial records to be retained.
        </span>
      </div>
      <Field label="Brand">
        <SelectInput value={brandId} onChange={(e) => setBrandId(e.target.value)} placeholder="Choose a brand" options={rels.map((r) => ({ value: r.brandId, label: r.brand.name }))} />
      </Field>
      {user.allBrands && rels.length > 1 && <Checkbox checked={allBrands} onChange={setAllBrands} label="Erase this customer across every brand" hint="Platform administrators only. Use for a deletion request that covers all storefronts." />}
      <Field label="Reason" hint="For example the data-deletion request reference. Recorded in the audit log."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label={`Type ANONYMIZE to confirm erasing ${customer.fullName}`}><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
      <FormError error={error} />
    </Modal>
  );
}

function ExportDialog({ customer, rels, onClose }: { customer: any; rels: Rel[]; onClose: () => void }) {
  const toast = useToast();
  const { brandId: selectedBrand } = useAuth();
  const [brandId, setBrandId] = useState(selectedBrand && rels.some((r) => r.brandId === selectedBrand) ? selectedBrand : (rels[0]?.brandId ?? ''));
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const go = async () => {
    setError(null);
    const data = await run(() => api.get(`/v1/admin/customers/${customer.id}/export`, { brandId }), { onError: (e) => setError(e.message) });
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-data-${customer.id.slice(0, 8)}-${rels.find((r) => r.brandId === brandId)?.brand.name.replace(/\W+/g, '-').toLowerCase() ?? 'brand'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Personal data exported');
    onClose();
  };
  return (
    <Modal open onClose={onClose} size="sm" title="Export personal data" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!brandId} icon={<Download className="h-4 w-4" />} onClick={go}>Download JSON</Button></>}>
      <p className="text-sm text-slate-600">Produces everything one brand holds about this customer, to fulfil a data-access request. Each brand is exported separately.</p>
      <Field label="Brand"><SelectInput value={brandId} onChange={(e) => setBrandId(e.target.value)} options={rels.map((r) => ({ value: r.brandId, label: r.brand.name }))} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

function Notes({ customerId, rels, notes, reload }: { customerId: string; rels: Rel[]; notes: any[]; reload: () => void }) {
  const toast = useToast();
  const { can, brandId: selectedBrand } = useAuth();
  const [brandId, setBrandId] = useState(selectedBrand && rels.some((r) => r.brandId === selectedBrand) ? selectedBrand : (rels[0]?.brandId ?? ''));
  const [body, setBody] = useState('');
  const { run, loading } = useAction();
  const add = async () => {
    const res = await run(() => api.post(`/v1/admin/customers/${customerId}/notes`, { brandId, body: body.trim() }), { onError: (e) => toast.error(e.message) });
    if (res) {
      setBody('');
      toast.success('Note added');
      reload();
    }
  };
  const brandOf = (id: string) => rels.find((r) => r.brandId === id)?.brand;
  return (
    <Card title="Customer notes" description="Internal. Never shown to the customer; visible only to staff of the note's brand.">
      {can('customers.manage') && (
        <div className="mb-5 space-y-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note about this customer" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {rels.length > 1 && <SelectInput value={brandId} onChange={(e) => setBrandId(e.target.value)} options={rels.map((r) => ({ value: r.brandId, label: r.brand.name }))} className="w-auto" aria-label="Brand" />}
            <Button loading={loading} disabled={!body.trim() || !brandId} onClick={add}>Add note</Button>
          </div>
        </div>
      )}
      <ul className="space-y-3">
        {notes.map((n) => (
          <li key={n.id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-700">{n.authorName}</span><DateTime value={n.createdAt} /><BrandChip brand={brandOf(n.brandId)} /></span>
              <Can permission="customers.manage">
                <ConfirmButton
                  label="" icon={<Trash2 className="h-3.5 w-3.5" />} variant="ghost" size="sm" title="Delete this note?" confirmLabel="Delete note"
                  onConfirm={() => api.delete(`/v1/admin/customer-notes/${n.id}`).then(() => { toast.success('Note deleted'); reload(); })}
                />
              </Can>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-800">{n.body}</p>
          </li>
        ))}
        {!notes.length && <li className="py-4 text-center text-sm text-slate-500">No notes yet.</li>}
      </ul>
    </Card>
  );
}

export default function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const { user, can, brand } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any>(`/v1/admin/customers/${id}`);
  const [tab, setTab] = useState('overview');
  const [dialog, setDialog] = useState<null | 'edit' | 'tags' | 'export' | 'anonymize'>(null);
  const [consent, setConsent] = useState<null | { rel: Rel; channel: string; granted: boolean }>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-24 w-full" /><Skeleton className="h-72 w-full" /></div>;
  if (!data) return null;

  const c = data.customer;
  const rels: Rel[] = data.relationships;
  const brandOf = (bid: string) => rels.find((r) => r.brandId === bid)?.brand ?? null;
  const anonymized = c.status === 'ANONYMIZED';

  const orderColumns: Column<any>[] = [
    { key: 'reference', header: 'Order', render: (o) => (can('orders.read') ? <Link href={`/orders/${o.id}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{o.reference}</Link> : <span className="font-mono text-[13px]">{o.reference}</span>) },
    { key: 'createdAt', header: 'Placed', render: (o) => <DateTime value={o.createdAt} /> },
    { key: 'brand', header: 'Brand', render: (o) => <BrandChip brand={brandOf(o.brandId)} /> },
    { key: 'event', header: 'Event', render: (o) => <div className="max-w-[16rem]"><div className="truncate text-slate-900">{o.event.name}</div><div className="truncate text-xs text-slate-500">{o.items.map((i: any) => `${i.quantity} × ${i.categoryName}`).join(', ')}</div></div> },
    { key: 'total', header: 'Total', align: 'right', render: (o) => <Money minor={o.totalMinor} currency={o.currency} /> },
    { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
  ];
  const eventColumns: Column<any>[] = [
    { key: 'name', header: 'Event', render: (e) => (can('events.read') ? <Link href={`/events/${e.id}`} className="font-medium text-accent-700 hover:underline">{e.name}</Link> : e.name) },
    { key: 'startsAt', header: 'Date', render: (e) => <DateTime value={e.startsAt} /> },
    { key: 'venue', header: 'Venue', render: (e) => e.venue ?? '-' },
    { key: 'category', header: 'Category', render: (e) => e.category ?? '-' },
    { key: 'tickets', header: 'Tickets', align: 'right' },
    { key: 'attended', header: 'Scanned in', align: 'right' },
  ];
  const ticketColumns: Column<any>[] = [
    { key: 'reference', header: 'Ticket', render: (t) => (can('tickets.read') ? <Link href={`/tickets/${t.id}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{t.reference}</Link> : <span className="font-mono text-[13px]">{t.reference}</span>) },
    { key: 'event', header: 'Event', render: (t) => <div className="max-w-[16rem]"><div className="truncate text-slate-900">{t.event.name}</div><div className="text-xs text-slate-500"><DateTime value={t.event.startsAt} mode="date" /></div></div> },
    { key: 'type', header: 'Type', render: (t) => t.ticketCategory.name },
    { key: 'brand', header: 'Brand', render: (t) => <BrandChip brand={brandOf(t.brandId)} /> },
    { key: 'order', header: 'Order', render: (t) => <span className="font-mono text-xs text-slate-500">{t.order.reference}</span> },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'issuedAt', header: 'Issued', render: (t) => <DateTime value={t.issuedAt} mode="date" /> },
  ];
  const refundColumns: Column<any>[] = [
    { key: 'reference', header: 'Refund', render: (r) => (can('refunds.read') ? <Link href={`/refunds?q=${r.reference}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{r.reference}</Link> : <span className="font-mono text-[13px]">{r.reference}</span>) },
    { key: 'order', header: 'Order', render: (r) => <span className="font-mono text-xs text-slate-500">{r.order.reference}</span> },
    { key: 'brand', header: 'Brand', render: (r) => <BrandChip brand={brandOf(r.brandId)} /> },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <Money minor={r.amountMinor} currency={r.currency} /> },
    { key: 'reason', header: 'Reason', render: (r) => <span className="block max-w-[18rem] truncate" title={r.reason}>{r.reason}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'requestedAt', header: 'Requested', render: (r) => <DateTime value={r.requestedAt} mode="date" /> },
  ];
  const supportColumns: Column<any>[] = [
    { key: 'reference', header: 'Request', render: (t) => (can('support.read') ? <Link href={`/support/${t.id}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{t.reference}</Link> : <span className="font-mono text-[13px]">{t.reference}</span>) },
    { key: 'subject', header: 'Subject', render: (t) => <span className="block max-w-[20rem] truncate">{t.subject}</span> },
    { key: 'brand', header: 'Brand', render: (t) => <BrandChip brand={brandOf(t.brandId)} /> },
    { key: 'issueType', header: 'Issue', render: (t) => humanize(t.issueType) },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'updatedAt', header: 'Last activity', render: (t) => <DateTime value={t.updatedAt} mode="relative" /> },
  ];
  const commColumns: Column<any>[] = [
    { key: 'createdAt', header: 'When', render: (m) => <DateTime value={m.createdAt} /> },
    { key: 'brand', header: 'Sent as', render: (m) => <BrandChip brand={brandOf(m.brandId)} /> },
    { key: 'channel', header: 'Channel', render: (m) => CHANNEL_LABEL[m.channel] ?? m.channel },
    { key: 'type', header: 'Message', render: (m) => <div className="max-w-[20rem]"><div className="truncate text-slate-900">{humanize(m.type)}</div>{m.subject && <div className="truncate text-xs text-slate-500">{m.subject}</div>}</div> },
    { key: 'to', header: 'To', render: (m) => <span className="text-xs text-slate-600">{m.toAddress}</span> },
    { key: 'event', header: 'Result', render: (m) => <div><StatusBadge status={m.event} />{['FAILED', 'SKIPPED', 'BOUNCED'].includes(m.event) && m.detail && <div className="mt-1 max-w-[16rem] truncate text-xs text-slate-500" title={m.detail}>{m.detail}</div>}</div> },
  ];
  const dataRequestColumns: Column<any>[] = [
    { key: 'type', header: 'Request', render: (r) => humanize(r.type) },
    { key: 'brand', header: 'Brand', render: (r) => <BrandChip brand={brandOf(r.brandId)} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'dueAt', header: 'Due', render: (r) => <DateTime value={r.dueAt} mode="date" /> },
    { key: 'createdAt', header: 'Received', render: (r) => <DateTime value={r.createdAt} mode="date" /> },
  ];

  return (
    <>
      <PageHeader
        back="/customers"
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            {c.fullName}
            <StatusBadge status={c.status} />
            {data.tags.map((t: any) => (
              <span key={t.id} className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700"><span className="h-2 w-2 rounded-full" style={{ background: t.color }} />{t.name}</span>
            ))}
          </span>
        }
        description={<>Customer since <DateTime value={c.createdAt} mode="date" />{!user.allBrands && ' · Showing activity for brands you manage'}{user.allBrands && brand && ` · Filtered to ${brand.name}`}</>}
        actions={
          !anonymized && (
            <>
              <Can permission="customers.manage">
                <Button variant="secondary" icon={<Tag className="h-4 w-4" />} onClick={() => setDialog('tags')}>Tags</Button>
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setDialog('edit')}>Edit details</Button>
                <ConfirmButton
                  label={c.status === 'BLOCKED' ? 'Unblock' : 'Block'} variant={c.status === 'BLOCKED' ? 'secondary' : 'danger'}
                  title={c.status === 'BLOCKED' ? 'Unblock this customer?' : 'Block this customer?'} confirmLabel={c.status === 'BLOCKED' ? 'Unblock' : 'Block customer'}
                  body={c.status === 'BLOCKED' ? 'They will be able to place orders again.' : 'A blocked customer cannot place new orders. Existing tickets stay valid.'}
                  onConfirm={() => api.patch(`/v1/admin/customers/${id}`, { status: c.status === 'BLOCKED' ? 'ACTIVE' : 'BLOCKED' }).then(() => { toast.success(c.status === 'BLOCKED' ? 'Customer unblocked' : 'Customer blocked'); reload(); })}
                />
              </Can>
              <Can permission="customers.privacy">
                <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => setDialog('export')}>Export data</Button>
                <Button variant="ghost" icon={<ShieldAlert className="h-4 w-4" />} onClick={() => setDialog('anonymize')}>Anonymize</Button>
              </Can>
            </>
          )
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Paid orders" value={number(data.totals.orders)} />
        <StatCard label="Total spending" value={<CurrencyList items={data.totals.spendByCurrency.map((s: any) => ({ currency: s.currency, amountMinor: s.netMinor }))} emptyLabel="None" />} hint="Net of refunds, per currency" />
        <StatCard label="Tickets issued" value={number(data.totals.ticketsIssued)} />
        <StatCard label="Events attended" value={number(data.totals.eventsAttended)} hint={`${data.upcomingEvents.length} upcoming`} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'purchases', label: 'Purchases', count: data.recentOrders.length },
          { id: 'tickets', label: 'Tickets', count: data.tickets.length },
          { id: 'consent', label: 'Consent & communication' },
          { id: 'support', label: 'Support', count: data.supportTickets.length },
          { id: 'notes', label: 'Notes', count: data.notes.length },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid gap-5 xl:grid-cols-3">
          <div className="space-y-5 xl:col-span-2">
            <Card title="Brand relationships" description="The customer has a separate account, purchase history and consent with each brand" padded={false}>
              <DataTable
                rows={rels}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'brand', header: 'Brand', render: (r) => <BrandChip brand={r.brand} /> },
                  { key: 'email', header: 'Account email', render: (r) => <div><div className="text-slate-800">{r.email}</div><div className="mt-0.5">{r.emailVerifiedAt ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>}</div></div> },
                  { key: 'orders', header: 'Orders', align: 'right', render: (r) => number(r.orderCount) },
                  { key: 'first', header: 'First order', render: (r) => <DateTime value={r.firstOrderAt} mode="date" /> },
                  { key: 'last', header: 'Last order', render: (r) => <DateTime value={r.lastOrderAt} mode="date" /> },
                  { key: 'login', header: 'Last sign-in', render: (r) => <DateTime value={r.lastLoginAt} mode="relative" /> },
                  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                ] as Column<Rel>[]}
              />
            </Card>
            <Card title="Upcoming events" padded={false}><DataTable columns={eventColumns} rows={data.upcomingEvents} empty={{ title: 'No upcoming events' }} /></Card>
            <Card title="Past events" padded={false}><DataTable columns={eventColumns} rows={data.pastEvents} empty={{ title: 'No past events' }} /></Card>
          </div>
          <div className="space-y-5">
            <Card title="Customer information">
              <KeyValue
                columns={1}
                items={[
                  { label: 'Full name', value: c.fullName },
                  { label: 'Email', value: c.email ?? '-' },
                  { label: 'Phone', value: c.phone ?? '-' },
                  { label: 'Location', value: [c.city, c.country].filter(Boolean).join(', ') || '-' },
                  { label: 'Preferred currency', value: c.preferredCurrency ?? '-' },
                  { label: 'Registered', value: <DateTime value={c.createdAt} /> },
                ]}
              />
            </Card>
            <Card title="Verified identity" description="Accounts on different brands are linked only after the customer verifies the address">
              <ul className="space-y-2 text-sm">
                {data.identities.map((i: any) => (
                  <li key={`${i.type}:${i.value}`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-slate-800">{i.value}</span>
                    {i.verifiedAt || i.verified ? <Badge tone="green">Verified</Badge> : <Badge tone="gray">Unverified</Badge>}
                  </li>
                ))}
                {!data.identities.length && <li className="text-slate-500">No contact points recorded.</li>}
              </ul>
            </Card>
            <Card title="Spending by currency">
              <ul className="space-y-2 text-sm">
                {data.totals.spendByCurrency.map((s: any) => (
                  <li key={s.currency} className="flex items-center justify-between gap-3">
                    <span className="text-slate-600">{s.orders} order{s.orders === 1 ? '' : 's'}{s.refundedMinor > 0 && <> · <Money minor={s.refundedMinor} currency={s.currency} /> refunded</>}</span>
                    <Money minor={s.netMinor} currency={s.currency} className="font-semibold text-slate-900" />
                  </li>
                ))}
                {!data.totals.spendByCurrency.length && <li className="text-slate-500">No paid orders.</li>}
              </ul>
            </Card>
          </div>
        </div>
      )}

      {tab === 'purchases' && (
        <div className="space-y-5">
          <Card title="Recent purchases" description="Each order keeps the brand it was placed on" padded={false}><DataTable columns={orderColumns} rows={data.recentOrders} empty={{ title: 'No orders' }} /></Card>
          <Card title="Refund history" padded={false}><DataTable columns={refundColumns} rows={data.refunds} empty={{ title: 'No refunds' }} /></Card>
        </div>
      )}

      {tab === 'tickets' && <Card title="Tickets issued" padded={false}><DataTable columns={ticketColumns} rows={data.tickets} empty={{ title: 'No tickets issued' }} /></Card>}

      {tab === 'consent' && (
        <div className="space-y-5">
          <Card title="Marketing consent" description="Recorded separately for every brand and channel. Consent given to one brand never applies to another." padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2.5">Brand</th>
                    {CHANNELS.map((ch) => <th key={ch} className="px-4 py-2.5">{CHANNEL_LABEL[ch]}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rels.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-3"><BrandChip brand={r.brand} /></td>
                      {CHANNELS.map((ch) => {
                        const state = data.consents.find((x: any) => x.brandId === r.brandId && x.channel === ch);
                        const granted = state?.status === 'GRANTED';
                        return (
                          <td key={ch} className="px-4 py-3 align-top">
                            <div className="flex items-center gap-2">
                              {state ? <StatusBadge status={state.status} /> : <Badge tone="gray">Not given</Badge>}
                              {!anonymized && can('customers.manage') && (
                                <button onClick={() => setConsent({ rel: r, channel: ch, granted })} className="text-xs font-medium text-accent-700 hover:underline">Change</button>
                              )}
                            </div>
                            {state && <div className="mt-1 text-xs text-slate-500">{humanize(state.source)} · <DateTime value={state.since} mode="date" /></div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Communication history" description="Messages sent to this customer and their delivery result" padded={false}><DataTable columns={commColumns} rows={data.communications} empty={{ title: 'No messages sent' }} /></Card>
          {data.preferences.length > 0 && (
            <Card title="Communication preferences">
              <KeyValue items={data.preferences.map((p: any) => ({ label: `${brandOf(p.brandId)?.name ?? 'Brand'} · ${humanize(p.key)}`, value: <code className="text-xs">{JSON.stringify(p.value)}</code> }))} />
            </Card>
          )}
        </div>
      )}

      {tab === 'support' && (
        <div className="space-y-5">
          <Card title="Support conversations" padded={false}><DataTable columns={supportColumns} rows={data.supportTickets} empty={{ title: 'No support requests' }} /></Card>
          <Card title="Privacy requests" description="Data access, correction and deletion requests made by the customer" padded={false}>
            <DataTable columns={dataRequestColumns} rows={data.dataRequests} empty={{ title: 'No privacy requests' }} />
          </Card>
        </div>
      )}

      {tab === 'notes' && <Notes customerId={id} rels={rels} notes={data.notes} reload={reload} />}

      {dialog === 'edit' && <EditDialog customer={c} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'tags' && <TagsDialog customerId={id} rels={rels} current={data.tags} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'export' && <ExportDialog customer={c} rels={rels} onClose={() => setDialog(null)} />}
      {dialog === 'anonymize' && <AnonymizeDialog customer={c} rels={rels} onClose={() => setDialog(null)} onDone={reload} />}
      {consent && <ConsentDialog customerId={id} target={consent} onClose={() => setConsent(null)} onDone={reload} />}
    </>
  );
}
