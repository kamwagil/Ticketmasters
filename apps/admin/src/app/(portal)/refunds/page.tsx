'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  BrandChip, Card, Column, ConfirmButton, DataTable, DateTime, Drawer, KeyValue, Money, PageHeader, Pagination, SearchInput, StatusBadge, Tabs, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize, money } from '@/lib/format';
import { useDebounced, usePaged, useQuery } from '@/lib/hooks';

interface RefundRow {
  id: string; reference: string; amountMinor: number; currency: string; reason: string; status: string; ticketIds: string[]; returnInventory: boolean;
  requestedByType: string; requestedByName: string | null; decidedByName: string | null; rejectedReason: string | null; failureReason: string | null;
  providerRefundId: string | null; requestedAt: string; decidedAt: string | null; processedAt: string | null; canApprove: boolean;
  order: { id: string; reference: string; customerName: string; customerEmail: string; totalMinor: number; refundedMinor: number; brand: { id: string; name: string; primaryColor: string } };
  payment: { providerCode: string; reference: string };
}

const TABS = [
  { id: 'REQUESTED', label: 'Awaiting approval' }, { id: 'PROCESSING', label: 'Processing' }, { id: 'SUCCEEDED', label: 'Completed' }, { id: 'FAILED', label: 'Failed' },
  { id: 'REJECTED', label: 'Rejected' }, { id: 'ALL', label: 'All' },
];

const useCount = (status: string) => useQuery<{ total: number }>('/v1/admin/refunds', { status: status === 'ALL' ? undefined : status, pageSize: 1 });

export default function RefundsPage() {
  const router = useRouter();
  const initial = useSearchParams();
  const { can, user } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const urlStatus = initial.get('status');
  const [tab, setTab] = useState(urlStatus && TABS.some((t) => t.id === urlStatus) ? urlStatus : initial.get('q') ? 'ALL' : 'REQUESTED');
  const [openId, setOpenId] = useState<string | null>(null);
  const search = useDebounced(q);
  const list = usePaged<RefundRow>('/v1/admin/refunds', { q: search, status: tab === 'ALL' ? undefined : tab });
  const counts = {
    REQUESTED: useCount('REQUESTED'), PROCESSING: useCount('PROCESSING'), SUCCEEDED: useCount('SUCCEEDED'), FAILED: useCount('FAILED'), REJECTED: useCount('REJECTED'), ALL: useCount('ALL'),
  } as Record<string, ReturnType<typeof useCount>>;
  const refresh = () => {
    list.reload();
    Object.values(counts).forEach((c) => c.reload());
  };
  const open = list.items.find((r) => r.id === openId) ?? null;

  const changeTab = (t: string) => {
    setTab(t);
    router.replace(t === 'REQUESTED' ? '/refunds' : `/refunds?status=${t}`);
  };
  const done = (message: string) => () => {
    toast.success(message);
    setOpenId(null);
    refresh();
  };

  const columns: Column<RefundRow>[] = [
    { key: 'reference', header: 'Refund', render: (r) => <span className="font-mono text-[13px] font-medium text-slate-900">{r.reference}</span> },
    { key: 'order', header: 'Order', render: (r) => <Link href={`/orders/${r.order.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[13px] text-accent-700 hover:underline">{r.order.reference}</Link> },
    { key: 'brand', header: 'Brand', render: (r) => <BrandChip brand={r.order.brand} /> },
    { key: 'customer', header: 'Customer', render: (r) => <div className="max-w-[13rem]"><div className="truncate text-slate-900">{r.order.customerName}</div><div className="truncate text-xs text-slate-500">{r.order.customerEmail}</div></div> },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <Money minor={r.amountMinor} currency={r.currency} className="font-medium text-slate-900" /> },
    { key: 'reason', header: 'Reason', render: (r) => <span className="block max-w-[18rem] truncate" title={r.reason}>{r.reason}</span> },
    { key: 'by', header: 'Requested by', render: (r) => r.requestedByName ?? humanize(r.requestedByType) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'requestedAt', header: 'Requested', render: (r) => <DateTime value={r.requestedAt} /> },
  ];

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Refund requests are approved by a second person, sent to the original payment provider, and recorded in the ledger. Refunded tickets are revoked automatically."
      />
      <Tabs active={tab} onChange={changeTab} tabs={TABS.map((t) => ({ ...t, count: counts[t.id].data?.total }))} />
      <Card padded={false}>
        <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Refund or order reference, customer email" /></Toolbar>
        <DataTable
          columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={(r) => setOpenId(r.id)}
          empty={{ title: tab === 'REQUESTED' ? 'No refunds are waiting for approval' : 'No refunds here', description: 'Refunds are requested from an order or a support ticket.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>

      <Drawer
        open={!!open} onClose={() => setOpenId(null)} title={open ? <span className="flex items-center gap-3"><span className="font-mono">{open.reference}</span><StatusBadge status={open.status} /></span> : ''}
        footer={open && can('refunds.approve') && (
          <>
            {open.status === 'REQUESTED' && (
              <>
                <ConfirmButton
                  label="Reject" title="Reject this refund request?" confirmLabel="Reject request" requireReason reasonLabel="Reason for rejecting"
                  onConfirm={(reason) => api.post(`/v1/admin/refunds/${open.id}/reject`, { reason }).then(done('Refund request rejected'))}
                />
                <ConfirmButton
                  label="Approve and refund" variant="primary" disabled={!open.canApprove} title={`Refund ${money(open.amountMinor, open.currency)}?`} confirmLabel="Approve and send refund"
                  body={<>The refund is sent to <span className="capitalize">{open.payment.providerCode}</span> immediately and returned to the customer&apos;s original payment method. {open.ticketIds.length > 0 && `${open.ticketIds.length} ticket${open.ticketIds.length === 1 ? '' : 's'} will be revoked. `}This cannot be undone.</>}
                  onConfirm={() => api.post(`/v1/admin/refunds/${open.id}/approve`).then((r) => (r.status === 'SUCCEEDED' ? done('Refund approved and processed')() : (toast.error(`The payment provider refused the refund: ${r.failureReason ?? 'unknown reason'}`), done('Refund approved; processing failed and can be retried')())))}
                />
              </>
            )}
            {open.status === 'FAILED' && (
              <ConfirmButton
                label="Retry refund" variant="primary" title="Send this refund to the provider again?" confirmLabel="Retry"
                body="Retry once the cause of the failure has been fixed. The refund can only ever be applied once."
                onConfirm={() => api.post(`/v1/admin/refunds/${open.id}/retry`).then((r) => (r.status === 'SUCCEEDED' ? done('Refund processed')() : (toast.error(`Still failing: ${r.failureReason ?? 'unknown reason'}`), refresh())))}
              />
            )}
          </>
        )}
      >
        {open && (
          <>
            {open.status === 'REQUESTED' && can('refunds.approve') && !open.canApprove && (
              <div className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
                You requested this refund, so someone else must approve it. This separation of duties protects against mistaken or fraudulent refunds.
              </div>
            )}
            {open.failureReason && <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700 ring-1 ring-inset ring-red-200"><strong>Provider error:</strong> {open.failureReason}</div>}
            {open.rejectedReason && <div className="rounded-lg bg-slate-100 px-3 py-2.5 text-sm text-slate-700"><strong>Rejected:</strong> {open.rejectedReason}</div>}
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Refund amount</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900"><Money minor={open.amountMinor} currency={open.currency} /></div>
              <div className="mt-1 text-xs text-slate-500">
                Order total <Money minor={open.order.totalMinor} currency={open.currency} /> · already refunded <Money minor={open.order.refundedMinor} currency={open.currency} />
              </div>
            </div>
            <KeyValue
              items={[
                { label: 'Order', value: <Link href={`/orders/${open.order.id}`} className="font-mono text-[13px] text-accent-700 hover:underline">{open.order.reference}</Link> },
                { label: 'Brand', value: <BrandChip brand={open.order.brand} /> },
                { label: 'Customer', value: <>{open.order.customerName}<div className="text-xs text-slate-500">{open.order.customerEmail}</div></> },
                { label: 'Original payment', value: <><span className="capitalize">{open.payment.providerCode}</span><div className="font-mono text-xs text-slate-500">{open.payment.reference}</div></> },
                { label: 'Tickets to revoke', value: open.ticketIds.length ? `${open.ticketIds.length} ticket${open.ticketIds.length === 1 ? '' : 's'}` : 'None (amount only)' },
                { label: 'Return tickets to sale', value: open.returnInventory ? 'Yes, if the event is still on sale' : 'No' },
                { label: 'Requested by', value: open.requestedByName ?? humanize(open.requestedByType) },
                { label: 'Requested', value: <DateTime value={open.requestedAt} /> },
                { label: open.status === 'REJECTED' ? 'Rejected by' : 'Approved by', value: open.decidedByName ?? '-' },
                { label: 'Decided', value: <DateTime value={open.decidedAt} /> },
                { label: 'Processed', value: <DateTime value={open.processedAt} /> },
                { label: 'Provider refund ID', value: open.providerRefundId ? <span className="font-mono text-xs">{open.providerRefundId}</span> : '-' },
              ]}
            />
            <div>
              <div className="text-xs font-medium text-slate-500">Reason</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{open.reason}</p>
            </div>
            {!user.allBrands && <p className="text-xs text-slate-400">You see refunds for your assigned brands only.</p>}
          </>
        )}
      </Drawer>
    </>
  );
}
