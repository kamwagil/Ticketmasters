'use client';

import { Lock, Mail, RotateCcw, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, BrandChip, Button, Card, Checkbox, DateTime, ErrorState, Field, FormError, KeyValue, Modal, Money, PageHeader, SelectInput, Skeleton, StatusBadge, Textarea, cn, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize, money } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

const STATUSES = ['OPEN', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const ISSUES = ['GENERAL_ENQUIRY', 'TICKET_DELIVERY', 'PAYMENT', 'REFUND_REQUEST', 'EVENT_CANCELLATION', 'ORDER_ENQUIRY'];
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: humanize(x) }));

function EscalateDialog({ ticket, onClose, onDone }: { ticket: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const order = ticket.order;
  const refundable = (order?.tickets ?? []).filter((t: any) => ['VALID', 'USED'].includes(t.status));
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const whole = selected.length === 0 || selected.length === refundable.length;
  const go = async () => {
    setError(null);
    const res = await run(() => api.post(`/v1/admin/support/tickets/${ticket.id}/escalate-refund`, { reason: reason.trim(), ...(whole ? {} : { ticketIds: selected }) }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Refund request created. Finance must approve it before any money moves.');
      onDone();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Escalate a refund request" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={reason.trim().length < 3} onClick={go}>Send for approval</Button></>}>
      <p className="text-sm text-slate-600">
        Creates a refund request on order <span className="font-mono font-medium">{order.reference}</span> ({money(order.totalMinor - order.refundedMinor, order.currency)} refundable) and links it to this ticket. Support cannot approve refunds.
      </p>
      {refundable.length > 1 && (
        <div>
          <div className="mb-1.5 text-sm font-medium text-slate-700">Tickets to refund</div>
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            {refundable.map((t: any) => (
              <Checkbox key={t.id} checked={selected.includes(t.id)} onChange={(v) => setSelected((x) => (v ? [...x, t.id] : x.filter((i) => i !== t.id)))} label={<span className="font-mono text-[13px]">{t.reference}</span>} hint={`${t.ticketCategory.name} · ${humanize(t.status)}`} />
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Leave all unselected to request a refund of the whole remaining order.</p>
        </div>
      )}
      <Field label="Reason" hint="Shown to the approver and recorded in the audit log."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      <FormError error={error} />
    </Modal>
  );
}

export default function SupportTicketPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const toast = useToast();
  const { data: t, loading, error, reload } = useQuery<any>(`/v1/admin/support/tickets/${id}`, undefined, { scoped: false, refreshMs: 30_000 });
  const staff = useQuery<{ items: any[] }>(t && can('staff.read') ? '/v1/admin/staff' : null, { brandId: t?.brandId, pageSize: 100 }, { scoped: false });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [escalate, setEscalate] = useState(false);
  const sending = useAction();
  const updating = useAction();

  if (error && !t) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !t) return <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-96 w-full" /></div>;
  if (!t) return null;

  const manage = can('support.manage');
  const send = async () => {
    const res = await sending.run(() => api.post(`/v1/admin/support/tickets/${id}/messages`, { body: body.trim(), internal }), { onError: (e) => toast.error(e.message) });
    if (res) {
      setBody('');
      toast.success(internal ? 'Internal note added' : `Reply sent to ${t.contactEmail}`);
      reload();
    }
  };
  const patch = async (change: Record<string, unknown>, done: string) => {
    const res = await updating.run(() => api.patch(`/v1/admin/support/tickets/${id}`, change), { onError: (e) => toast.error(e.message) });
    if (res) {
      toast.success(done);
      reload();
    }
  };
  const assignees = [
    ...(staff.data?.items ?? []).filter((u) => u.status === 'ACTIVE').map((u) => ({ value: u.id, label: u.fullName })),
    ...(t.assignedTo && !(staff.data?.items ?? []).some((u) => u.id === t.assignedTo.id) ? [{ value: t.assignedTo.id, label: t.assignedTo.fullName }] : []),
    ...(!(staff.data?.items ?? []).some((u) => u.id === user.id) && t.assignedTo?.id !== user.id ? [{ value: user.id, label: `${user.fullName} (me)` }] : []),
  ];
  const canEscalate = manage && can('refunds.request') && t.order && !t.refund && ['PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED'].includes(t.order.status);

  return (
    <>
      <PageHeader
        back="/support"
        title={<span className="flex flex-wrap items-center gap-3"><span className="font-mono text-base text-slate-500">{t.reference}</span>{t.subject}</span>}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={t.status} /><StatusBadge status={t.priority} /><span>{humanize(t.issueType)}</span>· opened <DateTime value={t.createdAt} /></span>}
        actions={
          manage && (
            <>
              {t.assignedToId !== user.id && <Button variant="secondary" icon={<UserCheck className="h-4 w-4" />} loading={updating.loading} onClick={() => patch({ assignedToId: user.id }, 'Assigned to you')}>Assign to me</Button>}
              {!['RESOLVED', 'CLOSED'].includes(t.status) && <Button variant="secondary" loading={updating.loading} onClick={() => patch({ status: 'RESOLVED' }, 'Ticket resolved')}>Mark resolved</Button>}
              {canEscalate && <Button icon={<RotateCcw className="h-4 w-4" />} onClick={() => setEscalate(true)}>Escalate refund request</Button>}
            </>
          )
        }
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Conversation" padded={false}>
            <ol className="space-y-4 p-5">
              {t.messages.map((m: any) => {
                const customer = m.authorType === 'CUSTOMER';
                const system = m.authorType === 'SYSTEM';
                if (system) {
                  return <li key={m.id} className="text-center text-xs text-slate-500"><span className="rounded-full bg-slate-100 px-3 py-1">{m.body} · <DateTime value={m.createdAt} /></span></li>;
                }
                return (
                  <li key={m.id} className={cn('flex', customer ? 'justify-start' : 'justify-end')}>
                    <div className={cn('max-w-[85%] rounded-2xl px-4 py-3 text-sm', m.internal ? 'border border-dashed border-amber-300 bg-amber-50 text-amber-950' : customer ? 'bg-slate-100 text-slate-900' : 'bg-accent-600 text-white')}>
                      {m.internal && <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700"><Lock className="h-3 w-3" /> Internal note – not visible to customer</div>}
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <div className={cn('mt-1.5 text-[11px]', m.internal ? 'text-amber-700' : customer ? 'text-slate-500' : 'text-white/75')}>
                        {m.authorName ?? (customer ? t.contactName ?? 'Customer' : 'Staff')} · <DateTime value={m.createdAt} />
                      </div>
                    </div>
                  </li>
                );
              })}
              {!t.messages.length && <li className="py-6 text-center text-sm text-slate-500">No messages yet.</li>}
            </ol>

            {manage && (
              <div className="border-t border-slate-100 p-5">
                <div className="mb-3 inline-flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
                  <button onClick={() => setInternal(false)} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5', !internal ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}><Mail className="h-3.5 w-3.5" /> Reply to customer</button>
                  <button onClick={() => setInternal(true)} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5', internal ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}><Lock className="h-3.5 w-3.5" /> Internal note</button>
                </div>
                {internal ? (
                  <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">Only staff see this note. Nothing is sent to the customer.</div>
                ) : (
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
                    Replying as <BrandChip brand={t.brand} /> <span className="font-medium text-slate-800">{t.replyAs.fromName} &lt;{t.replyAs.fromAddress}&gt;</span> to {t.contactEmail}
                    {t.brand.status !== 'ACTIVE' && <Badge tone="red">Brand {t.brand.status.toLowerCase()}</Badge>}
                  </div>
                )}
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={internal ? 'Write a note for your colleagues' : `Write your reply as ${t.replyAs.brand}`} className="min-h-[7rem]" />
                <div className="mt-2 flex justify-end">
                  <Button loading={sending.loading} disabled={!body.trim()} onClick={send}>{internal ? 'Add internal note' : 'Send reply'}</Button>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Ticket">
            <div className="space-y-4">
              <Field label="Status"><SelectInput value={t.status} disabled={!manage || updating.loading} onChange={(e) => patch({ status: e.target.value }, 'Status updated')} options={opts(STATUSES)} /></Field>
              <Field label="Priority"><SelectInput value={t.priority} disabled={!manage || updating.loading} onChange={(e) => patch({ priority: e.target.value }, 'Priority updated')} options={opts(PRIORITIES)} /></Field>
              <Field label="Issue type"><SelectInput value={t.issueType} disabled={!manage || updating.loading} onChange={(e) => patch({ issueType: e.target.value }, 'Issue type updated')} options={opts(ISSUES)} /></Field>
              <Field label="Assignee" hint={can('staff.read') ? 'Staff with access to this brand' : undefined}>
                <SelectInput value={t.assignedToId ?? ''} disabled={!manage || updating.loading} onChange={(e) => patch({ assignedToId: e.target.value || null }, e.target.value ? 'Ticket assigned' : 'Ticket unassigned')} placeholder="Unassigned" options={assignees} />
              </Field>
              <KeyValue columns={1} items={[{ label: 'Originating brand', value: <BrandChip brand={t.brand} /> }, ...(t.resolvedAt ? [{ label: 'Resolved', value: <DateTime value={t.resolvedAt} /> }] : [])]} />
            </div>
          </Card>

          <Card title="Customer">
            <KeyValue
              columns={1}
              items={[
                { label: 'Name', value: t.customer && can('customers.read') ? <Link href={`/customers/${t.customer.id}`} className="text-accent-700 hover:underline">{t.customer.fullName}</Link> : (t.customer?.fullName ?? t.contactName ?? '-') },
                { label: 'Email', value: <span>{t.contactEmail}{t.customer && <span className="ml-2">{t.customer.emailVerified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>}</span>}</span> },
                ...(t.customer ? [{ label: 'Phone', value: t.customer.phone ?? '-' }, { label: `Orders with ${t.brand.name}`, value: t.customer.orderCount ?? 0 }] : []),
              ]}
            />
            {!t.customer && <p className="mt-3 text-xs text-slate-500">This email is not linked to a customer account on {t.brand.name}. Confirm the person&apos;s identity before sharing order details.</p>}
          </Card>

          <Card title="Linked order">
            {t.order ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  {can('orders.read') ? <Link href={`/orders/${t.order.id}`} className="font-mono font-medium text-accent-700 hover:underline">{t.order.reference}</Link> : <span className="font-mono font-medium">{t.order.reference}</span>}
                  <StatusBadge status={t.order.status} />
                </div>
                <div className="text-slate-700">{t.order.event.name}<div className="text-xs text-slate-500"><DateTime value={t.order.event.startsAt} /></div></div>
                <div className="text-xs text-slate-500">{t.order.items.map((i: any) => `${i.quantity} × ${i.categoryName}`).join(', ')}</div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2"><span className="text-slate-600">Total</span><Money minor={t.order.totalMinor} currency={t.order.currency} className="font-semibold text-slate-900" /></div>
                {t.order.refundedMinor > 0 && <div className="flex items-center justify-between text-purple-700"><span>Refunded</span><Money minor={t.order.refundedMinor} currency={t.order.currency} /></div>}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No order is linked to this ticket, so a refund cannot be escalated from here.</p>
            )}
          </Card>

          {t.refund && (
            <Card title="Refund request">
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  {can('refunds.read') ? <Link href={`/refunds?q=${t.refund.reference}`} className="font-mono font-medium text-accent-700 hover:underline">{t.refund.reference}</Link> : <span className="font-mono font-medium">{t.refund.reference}</span>}
                  <StatusBadge status={t.refund.status} />
                </div>
                <div className="flex items-center justify-between"><span className="text-slate-600">Amount</span><Money minor={t.refund.amountMinor} currency={t.refund.currency} className="font-semibold" /></div>
                <div className="text-xs text-slate-500">Requested <DateTime value={t.refund.requestedAt} /></div>
              </div>
            </Card>
          )}
        </div>
      </div>

      {escalate && <EscalateDialog ticket={t} onClose={() => setEscalate(false)} onDone={reload} />}
    </>
  );
}
