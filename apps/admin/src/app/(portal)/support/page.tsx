'use client';

import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandField, useBrandChoice } from '@/components/crm/shared';
import {
  Badge, BrandChip, Button, Card, Column, DataTable, DateTime, Field, FormError, Input, Modal, PageHeader, Pagination, SearchInput, Select, SelectInput, StatCard, StatusBadge,
  Textarea, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Can } from '@/lib/auth';
import { humanize, number } from '@/lib/format';
import { useAction, useDebounced, usePaged, useQuery } from '@/lib/hooks';

export const SUPPORT_STATUSES = ['OPEN', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'RESOLVED', 'CLOSED'];
export const SUPPORT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const SUPPORT_ISSUES = ['GENERAL_ENQUIRY', 'TICKET_DELIVERY', 'PAYMENT', 'REFUND_REQUEST', 'EVENT_CANCELLATION', 'ORDER_ENQUIRY'];
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: humanize(x) }));

function NewTicketDialog({ onClose, onDone }: { onClose: () => void; onDone: (t: any) => void }) {
  const toast = useToast();
  const choice = useBrandChoice();
  const [form, setForm] = useState({ contactEmail: '', contactName: '', subject: '', message: '', issueType: 'GENERAL_ENQUIRY', priority: 'NORMAL', orderReference: '' });
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setError(null);
    const res = await run(
      () =>
        api.post('/v1/admin/support/tickets', {
          brandId: choice.brandId, contactEmail: form.contactEmail.trim(), subject: form.subject.trim(), message: form.message.trim(), issueType: form.issueType, priority: form.priority,
          ...(form.contactName.trim() ? { contactName: form.contactName.trim() } : {}), ...(form.orderReference.trim() ? { orderReference: form.orderReference.trim().toUpperCase() } : {}),
        }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(`Ticket ${res.reference} created`);
      onDone(res);
      onClose();
    }
  };
  const valid = choice.brandId && /\S+@\S+\.\S+/.test(form.contactEmail) && form.subject.trim().length >= 3 && form.message.trim();
  return (
    <Modal open onClose={onClose} title="New support ticket" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!valid} onClick={save}>Create ticket</Button></>}>
      <p className="text-sm text-slate-600">Log a request received by phone or in person. The first message is stored as an internal note; nothing is emailed to the customer until you reply.</p>
      <BrandField value={choice.brandId} onChange={choice.setBrandId} locked={choice.locked} hint="The storefront the customer contacted. Replies are sent with this brand's identity." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer email"><Input type="email" value={form.contactEmail} onChange={set('contactEmail')} /></Field>
        <Field label="Customer name"><Input value={form.contactName} onChange={set('contactName')} placeholder="Optional" /></Field>
        <Field label="Issue type"><SelectInput value={form.issueType} onChange={set('issueType')} options={opts(SUPPORT_ISSUES)} /></Field>
        <Field label="Priority"><SelectInput value={form.priority} onChange={set('priority')} options={opts(SUPPORT_PRIORITIES)} /></Field>
      </div>
      <Field label="Order reference" hint="Optional. Links the ticket to an order on this brand."><Input value={form.orderReference} onChange={set('orderReference')} placeholder="ORD-..." className="font-mono uppercase" /></Field>
      <Field label="Subject"><Input value={form.subject} onChange={set('subject')} maxLength={200} /></Field>
      <Field label="What the customer said"><Textarea value={form.message} onChange={set('message')} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

export default function SupportPage() {
  const router = useRouter();
  const initial = useSearchParams();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [status, setStatus] = useState(initial.get('status') ?? '');
  const [priority, setPriority] = useState('');
  const [issueType, setIssueType] = useState('');
  const [assigned, setAssigned] = useState('');
  const [creating, setCreating] = useState(false);
  const search = useDebounced(q);
  const summary = useQuery<any>('/v1/admin/support/summary');
  const list = usePaged<any>('/v1/admin/support/tickets', { q: search, status, priority, issueType, assignedToId: assigned });

  const s = summary.data;
  const pending = (s?.byStatus?.PENDING_CUSTOMER ?? 0) + (s?.byStatus?.PENDING_INTERNAL ?? 0);
  const urgent = (s?.openByPriority?.URGENT ?? 0) + (s?.openByPriority?.HIGH ?? 0);

  const columns: Column<any>[] = [
    { key: 'reference', header: 'Ticket', render: (t) => <span className="font-mono text-[13px] font-medium text-slate-900">{t.reference}</span> },
    {
      key: 'subject', header: 'Subject',
      render: (t) => (
        <div className="max-w-[20rem]">
          <div className="truncate text-slate-900">{t.subject}</div>
          <div className="truncate text-xs text-slate-500">{t.messageCount} message{t.messageCount === 1 ? '' : 's'}{t.orderReference && <> · <span className="font-mono">{t.orderReference}</span></>}</div>
        </div>
      ),
    },
    { key: 'brand', header: 'Brand', render: (t) => <BrandChip brand={t.brand} /> },
    { key: 'customer', header: 'Customer', render: (t) => <div className="max-w-[14rem]"><div className="truncate text-slate-900">{t.contactName ?? '-'}</div><div className="truncate text-xs text-slate-500">{t.contactEmail}</div></div> },
    { key: 'issueType', header: 'Issue', render: (t) => humanize(t.issueType) },
    { key: 'priority', header: 'Priority', render: (t) => <StatusBadge status={t.priority} /> },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'assignee', header: 'Assignee', render: (t) => t.assignedTo?.fullName ?? <span className="text-slate-400">Unassigned</span> },
    { key: 'last', header: 'Last activity', render: (t) => <div><DateTime value={t.lastMessageAt} mode="relative" />{t.lastMessageFrom === 'CUSTOMER' && <span className="ml-1.5"><Badge tone="blue">Customer replied</Badge></span>}</div> },
  ];

  return (
    <>
      <PageHeader
        title="Customer Support"
        description="Requests from every storefront in one inbox. Each ticket keeps its originating brand, and replies go out under that brand's identity."
        actions={<Can permission="support.manage"><Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New ticket</Button></Can>}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Open" value={number(s?.open ?? 0)} />
        <StatCard label="Waiting on someone" value={number(pending)} hint="Pending customer or internal" />
        <StatCard label="High or urgent" value={number(urgent)} tone={urgent ? 'bad' : 'default'} />
        <StatCard label="Unassigned" value={number(s?.unassigned ?? 0)} tone={s?.unassigned ? 'warn' : 'default'} />
        <StatCard label="Assigned to me" value={number(s?.assignedToMe ?? 0)} />
      </div>
      {s && Object.keys(s.openByIssueType ?? {}).length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <span>Open by issue:</span>
          {Object.entries(s.openByIssueType as Record<string, number>).map(([type, n]) => (
            <button key={type} onClick={() => setIssueType(issueType === type ? '' : type)} className={`rounded-full px-3 py-1 text-xs font-medium ${issueType === type ? 'bg-accent-600 text-white' : 'bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'}`}>
              {humanize(type)} · {n}
            </button>
          ))}
        </div>
      )}

      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Reference, subject, name or email" />
          <Select value={status} onChange={setStatus} placeholder="Any status" options={opts(SUPPORT_STATUSES)} />
          <Select value={priority} onChange={setPriority} placeholder="Any priority" options={opts(SUPPORT_PRIORITIES)} />
          <Select value={issueType} onChange={setIssueType} placeholder="Any issue type" options={opts(SUPPORT_ISSUES)} />
          <Select value={assigned} onChange={setAssigned} placeholder="Assigned to anyone" options={[{ value: 'me', label: 'Assigned to me' }, { value: 'unassigned', label: 'Unassigned' }]} />
        </Toolbar>
        <DataTable
          columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={(t) => router.push(`/support/${t.id}`)}
          empty={{ title: 'No tickets match these filters', description: 'Requests submitted on any storefront appear here.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
      {creating && <NewTicketDialog onClose={() => setCreating(false)} onDone={(t) => router.push(`/support/${t.id}`)} />}
    </>
  );
}
