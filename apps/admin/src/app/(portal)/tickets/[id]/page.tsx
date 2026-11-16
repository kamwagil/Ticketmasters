'use client';

import { Ban, Download } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, BrandChip, Button, Card, Column, ConfirmButton, DataTable, DateTime, ErrorState, KeyValue, PageHeader, Skeleton, StatusBadge, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const { data: t, loading, error, reload } = useQuery<any>(`/v1/admin/tickets/${id}`, undefined, { scoped: false });
  const { run, loading: downloading } = useAction();

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !t) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /><Skeleton className="h-56 w-full" /></div>;
  if (!t) return null;

  const scanCols: Column<any>[] = [
    { key: 'scannedAt', header: 'Scanned', render: (s) => <DateTime value={s.scannedAt} /> },
    { key: 'result', header: 'Result', render: (s) => <StatusBadge status={s.result} /> },
    { key: 'gate', header: 'Gate', render: (s) => s.gate ?? '-' },
    { key: 'deviceId', header: 'Device', render: (s) => <span className="font-mono text-xs text-slate-500">{s.deviceId ?? '-'}</span> },
    { key: 'offline', header: 'Mode', render: (s) => (s.offline ? <Badge tone="amber">Offline sync</Badge> : <span className="text-xs text-slate-500">Live</span>) },
  ];
  const transferCols: Column<any>[] = [
    { key: 'toEmail', header: 'Sent to', render: (x) => <div><div>{x.toName ?? '-'}</div><div className="text-xs text-slate-500">{x.toEmail}</div></div> },
    { key: 'status', header: 'Status', render: (x) => <StatusBadge status={x.status} /> },
    { key: 'createdAt', header: 'Started', render: (x) => <DateTime value={x.createdAt} /> },
    { key: 'completedAt', header: 'Completed', render: (x) => <DateTime value={x.completedAt} /> },
    { key: 'expiresAt', header: 'Link expires', render: (x) => <DateTime value={x.expiresAt} /> },
  ];

  return (
    <>
      <PageHeader
        back="/tickets"
        title={<span className="flex flex-wrap items-center gap-3"><span className="font-mono">{t.reference}</span><StatusBadge status={t.status} /></span>}
        description={<>{t.ticketCategory.name} · {t.event.name}</>}
        actions={
          <Can permission="tickets.manage">
            <Button variant="secondary" loading={downloading} icon={<Download className="h-4 w-4" />}
              onClick={() => run(() => api.download(`/v1/admin/tickets/${id}/pdf`, undefined, `ticket-${t.reference}.pdf`), { onError: (e) => toast.error(e.message) })}>
              Download PDF
            </Button>
            {['VALID', 'USED'].includes(t.status) && (
              <ConfirmButton
                label="Revoke ticket" variant="danger" icon={<Ban className="h-4 w-4" />} title="Revoke this ticket?" confirmLabel="Revoke ticket" requireReason
                body="The QR code stops working immediately. No money is refunded and the ticket is not put back on sale. Use a refund from the order if the customer should be reimbursed."
                onConfirm={(reason) => api.post(`/v1/admin/tickets/${id}/revoke`, { reason }).then(() => { toast.success('Ticket revoked'); reload(); })}
              />
            )}
          </Can>
        }
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Ticket">
            <KeyValue
              columns={3}
              items={[
                { label: 'Holder', value: t.holderName ?? '-' },
                { label: 'Holder email', value: t.holderEmail ?? '-' },
                { label: 'Brand (storefront)', value: <BrandChip brand={t.order.brand} /> },
                { label: 'Event', value: can('events.read') ? <Link href={`/events/${t.event.id}`} className="text-accent-700 hover:underline">{t.event.name}</Link> : t.event.name },
                { label: 'Event date', value: <DateTime value={t.event.startsAt} /> },
                { label: 'Venue', value: t.event.venue ? `${t.event.venue.name}, ${t.event.venue.city}` : '-' },
                { label: 'Order', value: can('orders.read') ? <Link href={`/orders/${t.order.id}`} className="font-mono text-[13px] text-accent-700 hover:underline">{t.order.reference}</Link> : <span className="font-mono text-[13px]">{t.order.reference}</span> },
                { label: 'Bought by', value: <>{t.order.customerName}<span className="block text-xs text-slate-500">{t.order.customerEmail}</span></> },
                { label: 'Issued', value: <DateTime value={t.issuedAt} /> },
                { label: 'Scanned at entry', value: <DateTime value={t.usedAt} /> },
              ]}
            />
            <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
              The QR code holds a random token that is stored only as a hash. It is never shown in this portal; staff with permission can download the PDF, which is recorded in the audit log.
            </p>
          </Card>
          <Card title="Scans" description="Every attempt to scan this ticket, including rejected ones" padded={false}>
            <DataTable columns={scanCols} rows={t.scans} empty={{ title: 'Not scanned yet' }} />
          </Card>
          <Card title="Transfers" padded={false}>
            <DataTable columns={transferCols} rows={t.transfers} empty={{ title: 'This ticket has not been transferred' }} />
          </Card>
        </div>
        <Card title="Status history">
          <ol className="relative space-y-4 border-l border-slate-200 pl-4">
            {t.history.map((h: any) => (
              <li key={h.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-300" />
                <div className="flex flex-wrap items-center gap-2"><StatusBadge status={h.toStatus} /><span className="text-xs text-slate-400"><DateTime value={h.createdAt} /></span></div>
                {h.reason && <p className="mt-1 text-xs text-slate-600">{h.reason}</p>}
                <p className="text-[11px] uppercase tracking-wide text-slate-400">{humanize(h.actorType)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
