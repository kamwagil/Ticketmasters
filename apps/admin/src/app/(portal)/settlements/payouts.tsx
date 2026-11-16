'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Notice } from '@/components/platform/bits';
import { CreatePayoutButton } from '@/components/platform/payout-actions';
import {
  Button, Card, Column, ConfirmButton, DataTable, DateTime, Drawer, EmptyState, ErrorState, Field, FormError, Input, KeyValue, Modal, Money, Pagination, SearchInput,
  Spinner, StatusBadge, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { useAction, useDebounced, usePaged, useQuery } from '@/lib/hooks';

const STATUSES = ['PENDING', 'AVAILABLE', 'IN_PAYOUT', 'PAID'] as const;

/** What each organizer is owed, per currency, by stage. */
export function PayablesTab() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/settlements/payables', undefined, { scoped: false });
  const rows = useMemo(() => {
    const map = new Map<string, any>();
    for (const r of data ?? []) {
      const key = `${r.organizerId}:${r.currency}`;
      const row = map.get(key) ?? { key, organizerId: r.organizerId, organizer: r.organizer, currency: r.currency, PENDING: 0, AVAILABLE: 0, IN_PAYOUT: 0, PAID: 0 };
      row[r.status] = Number(r.amountMinor);
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => (a.organizer?.name ?? '').localeCompare(b.organizer?.name ?? '') || a.currency.localeCompare(b.currency));
  }, [data]);

  const columns: Column<any>[] = [
    {
      key: 'organizer', header: 'Organizer',
      render: (r) => (
        <div>
          <Link href={`/organizers/${r.organizerId}`} className="font-medium text-accent-700 hover:underline">{r.organizer?.name ?? 'Unknown organizer'}</Link>
          {r.organizer && r.organizer.verificationStatus !== 'VERIFIED' && <div className="mt-0.5"><StatusBadge status={r.organizer.verificationStatus} /></div>}
        </div>
      ),
    },
    { key: 'currency', header: 'Currency' },
    ...STATUSES.map((s): Column<any> => ({ key: s, header: humanize(s), align: 'right', render: (r) => <Money minor={r[s]} currency={r.currency} className={s === 'AVAILABLE' && r[s] > 0 ? 'font-semibold text-slate-900' : undefined} /> })),
    {
      key: 'action', header: '', align: 'right',
      render: (r) => can('settlements.manage') && r.organizer?.verificationStatus === 'VERIFIED'
        ? <CreatePayoutButton organizerId={r.organizerId} organizerName={r.organizer.name} currency={r.currency} availableMinor={r.AVAILABLE} onDone={reload} />
        : null,
    },
  ];
  return (
    <Card padded={false} title="Promoter payables" description="Derived from payable lines posted when payments are captured and refunds processed. Pending earnings become available after each organizer's payout hold.">
      <DataTable columns={columns} rows={rows} loading={loading} error={error} onRetry={reload} rowKey={(r) => r.key} empty={{ title: 'Nothing owed to organizers yet', description: 'Payables appear as soon as a ticket for an organizer event is paid for.' }} />
    </Card>
  );
}

function MarkPaid({ payout, onDone }: { payout: any; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const submit = async () => {
    setError(null);
    const res = await run(() => api.post(`/v1/admin/payouts/${payout.id}/mark-paid`, { paymentReference: ref.trim() }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(`Payout ${payout.reference} recorded as paid`);
      setOpen(false);
      onDone();
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>Mark as paid</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Record payment to organizer"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={loading} disabled={ref.trim().length < 3} onClick={submit}>Record as paid</Button>
          </>
        }
      >
        <Notice tone="warn">
          This platform does not move funds. Use this only after you have transferred <strong><Money minor={payout.amountMinor} currency={payout.currency} /></strong> to the
          organizer through your bank or mobile money service. It records that transfer and cannot be undone.
        </Notice>
        <Field label="Bank or mobile money transaction reference" hint="Kept on the payout and in the ledger for audit.">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} autoFocus />
        </Field>
        <FormError error={error} />
      </Modal>
    </>
  );
}

function PayoutDrawer({ id, row, onClose, onChanged }: { id: string; row: any; onClose: () => void; onChanged: () => void }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any>(`/v1/admin/payouts/${id}`, undefined, { scoped: false });
  const done = () => {
    reload();
    onChanged();
  };
  const p = data?.payout;
  const s = data?.summary;
  const ownPayout = p && p.createdById === user.id;

  return (
    <Drawer
      open
      onClose={onClose}
      title={p ? `Payout ${p.reference}` : 'Payout'}
      footer={
        p && (
          <>
            {['PENDING_APPROVAL', 'APPROVED'].includes(p.status) && can('payouts.approve') && (
              <ConfirmButton
                label="Reject" variant="danger" title="Reject this payout?" confirmLabel="Reject payout" requireReason
                body="Its payable lines become available again and can be included in a new payout."
                onConfirm={(reason) => api.post(`/v1/admin/payouts/${id}/reject`, { reason }).then(() => { toast.success('Payout rejected'); done(); })}
              />
            )}
            {p.status === 'PENDING_APPROVAL' && can('payouts.approve') && (
              <ConfirmButton
                label="Approve" variant="primary" disabled={ownPayout} title="Approve this payout?" confirmLabel="Approve"
                body={<>Approves <strong><Money minor={p.amountMinor} currency={p.currency} /></strong> for {p.organizer.name}. No money moves until finance pays the organizer and records it.</>}
                onConfirm={() => api.post(`/v1/admin/payouts/${id}/approve`).then(() => { toast.success('Payout approved'); done(); })}
              />
            )}
            {p.status === 'APPROVED' && can('settlements.manage') && <MarkPaid payout={p} onDone={done} />}
          </>
        )
      }
    >
      {error ? <ErrorState error={error} onRetry={reload} /> : loading || !p ? <div className="grid place-items-center py-16"><Spinner /></div> : (
        <>
          <KeyValue
            items={[
              { label: 'Organizer', value: <Link href={`/organizers/${p.organizer.id}`} className="text-accent-700 hover:underline">{p.organizer.name}</Link> },
              { label: 'Status', value: <StatusBadge status={p.status} /> },
              { label: 'Created', value: <DateTime value={p.createdAt} /> },
              { label: 'Approved', value: <DateTime value={p.approvedAt} /> },
              { label: 'Paid', value: <DateTime value={p.paidAt} /> },
              { label: 'Transfer reference', value: p.paymentReference ?? '-' },
            ]}
          />
          {p.note && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{p.note}</p>}
          {p.status === 'PENDING_APPROVAL' && ownPayout && (
            <Notice>You created this payout, so a different person with payout approval rights must approve it.</Notice>
          )}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Settlement statement</h3>
            <dl className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
              {[
                [`Gross ticket sales (${s.orders} order${s.orders === 1 ? '' : 's'})`, s.grossTicketSalesMinor],
                ['Commission withheld', -Number(s.commissionWithheldMinor)],
                ['Refunds', -Number(s.refundsGrossMinor)],
                ['Commission returned on refunds', s.commissionReturnedMinor],
              ].map(([l, v]) => (
                <div key={l as string} className="flex justify-between gap-3"><dt className="text-slate-600">{l}</dt><dd><Money minor={v as number} currency={s.currency} /></dd></div>
              ))}
              <div className="flex justify-between gap-3 border-t border-slate-200 pt-2 font-semibold text-slate-900"><dt>Net payable</dt><dd><Money minor={s.netPayableMinor} currency={s.currency} /></dd></div>
            </dl>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">By event</h3>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
              {data.byEvent.map((e: any) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0"><span className="block truncate text-slate-900">{e.name}</span><span className="text-xs text-slate-500"><DateTime value={e.startsAt} mode="date" /></span></span>
                  <Money minor={e.netMinor} currency={s.currency} />
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Lines ({data.lines.length})</h3>
            <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-max text-xs">
                <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2 text-right">Commission</th><th className="px-3 py-2 text-right">Net</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.lines.map((l: any) => (
                    <tr key={l.id}>
                      <td className="px-3 py-1.5"><DateTime value={l.createdAt} mode="date" /></td>
                      <td className="px-3 py-1.5">{can('orders.read') ? <Link href={`/orders/${l.orderId}`} className="text-accent-700 hover:underline">{humanize(l.kind)}</Link> : humanize(l.kind)}</td>
                      <td className="px-3 py-1.5 text-right"><Money minor={l.grossMinor} currency={l.currency} /></td>
                      <td className="px-3 py-1.5 text-right"><Money minor={l.commissionMinor} currency={l.currency} /></td>
                      <td className="px-3 py-1.5 text-right"><Money minor={l.amountMinor} currency={l.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {!row && !p && !loading && !error && <EmptyState title="Payout not found" />}
    </Drawer>
  );
}

export function PayoutsTab() {
  const initial = useSearchParams();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [open, setOpen] = useState<any | null>(null);
  const list = usePaged<any>('/v1/admin/payouts', { q: useDebounced(q) }, { scoped: false });
  const columns: Column<any>[] = [
    { key: 'reference', header: 'Payout', render: (p) => <span className="font-mono text-[13px] font-medium text-slate-900">{p.reference}</span> },
    { key: 'organizer', header: 'Organizer', render: (p) => p.organizer.name },
    { key: 'amount', header: 'Amount', align: 'right', render: (p) => <Money minor={p.amountMinor} currency={p.currency} className="font-medium text-slate-900" /> },
    { key: 'lines', header: 'Lines', align: 'right', render: (p) => p._count.payables },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'createdAt', header: 'Created', render: (p) => <DateTime value={p.createdAt} /> },
    { key: 'paidAt', header: 'Paid', render: (p) => <DateTime value={p.paidAt} mode="date" /> },
  ];
  return (
    <Card padded={false}>
      <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Payout reference or organizer" /></Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={setOpen} empty={{ title: 'No payouts yet', description: 'Create one from Promoter payables when an organizer has an available balance.' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      {open && <PayoutDrawer id={open.id} row={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </Card>
  );
}
