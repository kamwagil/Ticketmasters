'use client';

import { AlertTriangle, Mail, RefreshCw, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Badge, BrandChip, Button, Card, Checkbox, Column, ConfirmButton, DataTable, DateTime, ErrorState, Field, FormError, KeyValue, Modal, Money, PageHeader, Skeleton,
  StatusBadge, Textarea, useToast,
} from '@/components/ui';
import { api, idempotencyKey } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { humanize, money } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

const UNPAID = ['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING'];
const REFUNDABLE = ['PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED'];

function RefundDialog({ order, open, onClose, onDone }: { order: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const refundable = order.tickets.filter((t: any) => ['VALID', 'USED'].includes(t.status));
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [returnInventory, setReturnInventory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const whole = selected.length === 0 || selected.length === refundable.length;
  const remaining = order.totalMinor - order.refundedMinor;
  const estimate = whole ? remaining : Math.floor((order.totalMinor * selected.length) / order.tickets.length);

  const submit = async () => {
    setError(null);
    const res = await run(
      () => api.post(`/v1/admin/orders/${order.id}/refunds`, { reason: reason.trim(), returnInventory, ...(whole ? {} : { ticketIds: selected }) }, idempotencyKey()),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(`Refund request ${res.reference} created. It needs approval before any money moves.`);
      onDone();
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request a refund"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={loading} disabled={reason.trim().length < 5} onClick={submit}>Submit for approval</Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        Choose the tickets to refund, or leave all unselected to refund the whole remaining balance. Refunded tickets are revoked once the refund is approved and
        processed through {humanize(order.gatewayCode ?? 'the original gateway')}.
      </p>
      {refundable.length > 1 && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          {refundable.map((t: any) => (
            <Checkbox
              key={t.id}
              checked={selected.includes(t.id)}
              onChange={(v) => setSelected((s) => (v ? [...s, t.id] : s.filter((x) => x !== t.id)))}
              label={<span className="font-mono text-[13px]">{t.reference}</span>}
              hint={`${t.ticketCategory.name} · ${humanize(t.status)}`}
            />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5 text-sm">
        <span className="text-slate-600">{whole ? 'Full remaining balance' : `${selected.length} ticket${selected.length === 1 ? '' : 's'} incl. share of fees`}</span>
        <span className="font-semibold text-slate-900">{money(estimate, order.currency)}</span>
      </div>
      <Field label="Reason" hint="Shown to the approver and kept in the audit log.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this refund being made?" />
      </Field>
      <Checkbox checked={returnInventory} onChange={setReturnInventory} label="Put refunded tickets back on sale" hint="Applies only while the event is still on sale." />
      <FormError error={error} />
    </Modal>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const { data: o, loading, error, reload } = useQuery<any>(`/v1/admin/orders/${id}`, undefined, { scoped: false });
  const [refundOpen, setRefundOpen] = useState(false);
  const { run, loading: acting } = useAction();

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !o) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>;

  const act = async (fn: () => Promise<unknown>, success: string) => {
    const res = await run(fn, { onError: (e) => toast.error(e.message) });
    if (res !== undefined) {
      toast.success(success);
      reload();
    }
  };
  const a = o.allocation;

  const ticketColumns: Column<any>[] = [
    { key: 'reference', header: 'Ticket', render: (t) => <Link href={`/tickets/${t.id}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{t.reference}</Link> },
    { key: 'category', header: 'Type', render: (t) => t.ticketCategory.name },
    { key: 'holder', header: 'Holder', render: (t) => t.holderName ?? '-' },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'usedAt', header: 'Scanned', render: (t) => <DateTime value={t.usedAt} /> },
  ];
  const paymentColumns: Column<any>[] = [
    { key: 'reference', header: 'Payment reference', render: (p) => <span className="font-mono text-[13px]">{p.reference}</span> },
    { key: 'provider', header: 'Gateway', render: (p) => <span className="capitalize">{p.providerCode}{!p.livemode && <span className="ml-1.5"><Badge tone="amber">test</Badge></span>}</span> },
    { key: 'txn', header: 'Gateway transaction', render: (p) => <span className="font-mono text-xs text-slate-500">{p.providerTransactionId ?? '-'}</span> },
    { key: 'amount', header: 'Amount', align: 'right', render: (p) => <Money minor={p.amountMinor} currency={p.currency} /> },
    { key: 'fee', header: 'Gateway fee', align: 'right', render: (p) => <Money minor={p.gatewayFeeMinor} currency={p.currency} /> },
    { key: 'status', header: 'Status', render: (p) => <div><StatusBadge status={p.status} />{p.failureReason && <div className="mt-1 max-w-[16rem] text-xs text-red-600">{p.failureReason}</div>}</div> },
    { key: 'paidAt', header: 'Paid', render: (p) => <DateTime value={p.paidAt} /> },
  ];
  const refundColumns: Column<any>[] = [
    { key: 'reference', header: 'Refund', render: (r) => <Link href={`/refunds?q=${r.reference}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{r.reference}</Link> },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <Money minor={r.amountMinor} currency={r.currency} /> },
    { key: 'reason', header: 'Reason', render: (r) => <span className="block max-w-[20rem] truncate" title={r.reason}>{r.reason}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'requestedAt', header: 'Requested', render: (r) => <DateTime value={r.requestedAt} /> },
  ];

  return (
    <>
      <PageHeader
        back="/orders"
        title={<span className="flex flex-wrap items-center gap-3"><span className="font-mono">{o.reference}</span><StatusBadge status={o.status} /></span>}
        description={<>Placed <DateTime value={o.createdAt} /> on <span className="font-medium text-slate-700">{o.sourceDomain}</span></>}
        actions={
          <>
            {o.payments.some((p: any) => ['PENDING', 'INITIATED'].includes(p.status)) && can('payments.read') && (
              <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={acting} onClick={() => act(() => api.post(`/v1/admin/orders/${id}/verify-payment`), 'Checked with the payment provider')}>
                Check payment
              </Button>
            )}
            <Can permission="orders.manage">
              {o.tickets.some((t: any) => t.status === 'VALID') && (
                <ConfirmButton
                  label="Resend tickets" icon={<Mail className="h-4 w-4" />} title="Resend tickets?" confirmLabel="Send email"
                  body={<>The ticket email will be sent again to <strong>{o.customerEmail}</strong> using {o.brand.name} branding.</>}
                  onConfirm={() => api.post(`/v1/admin/orders/${id}/resend-tickets`).then(() => { toast.success('Ticket email queued'); reload(); })}
                />
              )}
              {UNPAID.includes(o.status) && (
                <ConfirmButton
                  label="Cancel order" variant="danger" title="Cancel this unpaid order?" confirmLabel="Cancel order" requireReason
                  body="The reserved tickets are released back to all storefronts immediately."
                  onConfirm={(reason) => api.post(`/v1/admin/orders/${id}/cancel`, { reason }).then(() => { toast.success('Order cancelled'); reload(); })}
                />
              )}
            </Can>
            {REFUNDABLE.includes(o.status) && can('refunds.request') && (
              <Button icon={<RotateCcw className="h-4 w-4" />} onClick={() => setRefundOpen(true)}>Request refund</Button>
            )}
          </>
        }
      />

      {o.needsAttention && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2.5 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>Needs attention.</strong> {o.attentionReason}</span>
          </div>
          <Can permission="orders.manage">
            <ConfirmButton
              label="Mark as handled" size="sm" title="Mark this issue as handled?" requireReason reasonLabel="What was done"
              onConfirm={(reason) => api.post(`/v1/admin/orders/${id}/resolve-attention`, { reason }).then(() => { toast.success('Marked as handled'); reload(); })}
            />
          </Can>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Order">
            <KeyValue
              columns={3}
              items={[
                { label: 'Brand (storefront)', value: <BrandChip brand={o.brand} /> },
                { label: 'Legal seller', value: `${o.legalEntity.name} (${o.legalEntity.country})` },
                { label: 'Event', value: <Link href={`/events/${o.event.id}`} className="text-accent-700 hover:underline">{o.event.name}</Link> },
                { label: 'Event date', value: <DateTime value={o.event.startsAt} /> },
                { label: 'Organizer', value: o.event.organizer?.name ?? '-' },
                { label: 'Payment status', value: <StatusBadge status={o.paymentStatus} /> },
                { label: 'Gateway', value: o.gatewayCode ? <span className="capitalize">{o.gatewayCode}</span> : '-' },
                { label: 'Gateway reference', value: o.gatewayReference ? <span className="font-mono text-xs">{o.gatewayReference}</span> : '-' },
                { label: 'Policies accepted', value: Object.entries(o.policyVersions ?? {}).map(([k, v]) => `${humanize(k)} v${v}`).join(', ') || '-' },
              ]}
            />
          </Card>

          <Card title="Items" padded={false}>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {o.items.map((i: any) => (
                  <tr key={i.id}>
                    <td className="px-5 py-3 text-slate-900">{i.quantity} × {i.categoryName}</td>
                    <td className="px-5 py-3 text-right text-slate-500"><Money minor={i.unitPriceMinor} currency={o.currency} /> each</td>
                    <td className="px-5 py-3 text-right font-medium text-slate-900"><Money minor={i.lineTotalMinor} currency={o.currency} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50/60 text-slate-600">
                {[['Subtotal', o.subtotalMinor], ['Discount', -o.discountMinor], ['Service fees', o.feesMinor], ['Tax', o.taxMinor]].filter(([l, v]) => l === 'Subtotal' || v !== 0).map(([l, v]) => (
                  <tr key={l as string}><td colSpan={2} className="px-5 py-1.5 text-right">{l}</td><td className="px-5 py-1.5 text-right"><Money minor={v as number} currency={o.currency} /></td></tr>
                ))}
                <tr className="font-semibold text-slate-900"><td colSpan={2} className="px-5 py-2.5 text-right">Total</td><td className="px-5 py-2.5 text-right"><Money minor={o.totalMinor} currency={o.currency} /></td></tr>
                {o.refundedMinor > 0 && <tr className="text-purple-700"><td colSpan={2} className="px-5 pb-2.5 text-right">Refunded</td><td className="px-5 pb-2.5 text-right"><Money minor={-o.refundedMinor} currency={o.currency} /></td></tr>}
              </tfoot>
            </table>
          </Card>

          <Card title="Tickets" description="Issued centrally after verified payment" padded={false}>
            <DataTable columns={ticketColumns} rows={o.tickets} empty={{ title: 'No tickets issued', description: 'Tickets are issued only after the payment provider confirms payment.' }} />
          </Card>
          <Card title="Payments" padded={false}>
            <DataTable columns={paymentColumns} rows={o.payments} empty={{ title: 'No payment attempts' }} />
          </Card>
          {o.refunds.length > 0 && (
            <Card title="Refunds" padded={false}><DataTable columns={refundColumns} rows={o.refunds} /></Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Customer">
            <KeyValue
              columns={1}
              items={[
                { label: 'Name', value: can('customers.read') ? <Link href={`/customers/${o.customer.id}`} className="text-accent-700 hover:underline">{o.customerName}</Link> : o.customerName },
                { label: 'Email', value: o.customerEmail },
                { label: 'Phone', value: o.customerPhone ?? '-' },
                { label: 'Country', value: o.customerCountry ?? '-' },
              ]}
            />
          </Card>

          <Card title="Financial allocation" description="Where the order total goes">
            <dl className="space-y-2 text-sm">
              {[
                ['Customer pays', a.customerPaysMinor, true],
                ['Ticket face value', a.ticketFaceValueMinor, false],
                ['Service fees (platform)', a.serviceFeesMinor, false],
                ['Tax', a.taxMinor, false],
                ['Platform commission', a.platformCommissionMinor, false],
                ['Brand commission', a.brandCommissionMinor, false],
                ['Promoter receives', a.promoterNetMinor, true],
              ].filter(([l, v]) => v !== 0 || l === 'Customer pays').map(([l, v, strong]) => (
                <div key={l as string} className="flex items-center justify-between gap-3">
                  <dt className={strong ? 'font-medium text-slate-900' : 'text-slate-600'}>{l}</dt>
                  <dd className={strong ? 'font-semibold text-slate-900' : 'text-slate-700'}><Money minor={v as number} currency={a.currency} /></dd>
                </div>
              ))}
              {a.gatewayChargeMinor !== null && (
                <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2 text-slate-500">
                  <dt>Gateway charge (borne by platform)</dt><dd><Money minor={a.gatewayChargeMinor} currency={a.currency} /></dd>
                </div>
              )}
            </dl>
          </Card>

          <Card title="History">
            <ol className="relative space-y-4 border-l border-slate-200 pl-4">
              {o.history.map((h: any) => (
                <li key={h.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-300" />
                  <div className="flex flex-wrap items-center gap-2"><StatusBadge status={h.toStatus} /><span className="text-xs text-slate-400"><DateTime value={h.createdAt} /></span></div>
                  {h.reason && <p className="mt-1 text-xs text-slate-600">{h.reason}</p>}
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{humanize(h.actorType)}</p>
                </li>
              ))}
            </ol>
          </Card>

          <Card title="Emails" padded={false}>
            <ul className="divide-y divide-slate-100 text-sm">
              {o.emails.map((e: any) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0"><div className="truncate text-slate-800">{humanize(e.type)}</div><div className="text-xs text-slate-400"><DateTime value={e.sentAt ?? e.createdAt} /></div></div>
                  <StatusBadge status={e.status} />
                </li>
              ))}
              {!o.emails.length && <li className="px-5 py-6 text-center text-sm text-slate-500">No emails yet</li>}
            </ul>
          </Card>
        </div>
      </div>

      {refundOpen && <RefundDialog order={o} open onClose={() => setRefundOpen(false)} onDone={reload} />}
    </>
  );
}
