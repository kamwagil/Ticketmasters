'use client';

import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Notice } from '@/components/platform/bits';
import { OrganizerForm } from '@/components/platform/organizer-form';
import { CreatePayoutButton } from '@/components/platform/payout-actions';
import { Badge, Button, Card, Column, DataTable, DateTime, ErrorState, KeyValue, Money, PageHeader, Skeleton, StatusBadge } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { bps, humanize } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

const STATUSES = ['PENDING', 'AVAILABLE', 'IN_PAYOUT', 'PAID'] as const;

export default function OrganizerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const { data: o, loading, error, reload } = useQuery<any>(`/v1/admin/organizers/${id}`, undefined, { scoped: false });
  const [editing, setEditing] = useState(false);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !o) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /><Skeleton className="h-56 w-full" /></div>;

  const currencies: string[] = o.finance ? [...new Set<string>(o.finance.balances.map((b: any) => b.currency))].sort() : [];
  const amount = (currency: string, status: string) => Number(o.finance.balances.find((b: any) => b.currency === currency && b.status === status)?.amountMinor ?? 0);

  const eventColumns: Column<any>[] = [
    { key: 'name', header: 'Event', render: (e) => (can('events.read') ? <Link href={`/events/${e.id}`} className="font-medium text-accent-700 hover:underline">{e.name}</Link> : e.name) },
    { key: 'startsAt', header: 'Date', render: (e) => <DateTime value={e.startsAt} /> },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
  ];
  const payoutColumns: Column<any>[] = [
    { key: 'reference', header: 'Payout', render: (p) => <Link href={`/settlements?tab=payouts&q=${p.reference}`} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{p.reference}</Link> },
    { key: 'amount', header: 'Amount', align: 'right', render: (p) => <Money minor={p.amountMinor} currency={p.currency} /> },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'createdAt', header: 'Created', render: (p) => <DateTime value={p.createdAt} mode="date" /> },
    { key: 'paidAt', header: 'Paid', render: (p) => <DateTime value={p.paidAt} mode="date" /> },
    { key: 'paymentReference', header: 'Transfer reference', render: (p) => p.paymentReference ?? '-' },
  ];

  return (
    <>
      <PageHeader
        back="/organizers"
        title={<span className="flex flex-wrap items-center gap-3">{o.name}<StatusBadge status={o.verificationStatus} /></span>}
        description={o.legalName ?? undefined}
        actions={can('organizers.manage') && user.allBrands && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>}
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Profile and legal information">
            <KeyValue
              columns={3}
              items={[
                { label: 'Contact email', value: o.contactEmail },
                { label: 'Contact phone', value: o.contactPhone ?? '-' },
                { label: 'Country', value: o.country ?? '-' },
                { label: 'Legal name', value: o.legalName ?? '-' },
                { label: 'Registration number', value: o.registrationNumber ?? '-' },
                { label: 'Tax number', value: o.taxNumber ?? '-' },
              ]}
            />
          </Card>

          {o.finance && (
            <Card title="Balances" description="From the promoter payable ledger, per currency. Pending earnings become available after the payout hold.">
              {currencies.length === 0 ? (
                <p className="text-sm text-slate-500">No earnings recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-max text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <th className="py-2 pr-4">Currency</th>
                        {STATUSES.map((s) => <th key={s} className="px-4 py-2 text-right">{humanize(s)}</th>)}
                        <th className="py-2 pl-4" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {currencies.map((c) => (
                        <tr key={c}>
                          <td className="py-2.5 pr-4 font-medium text-slate-900">{c}</td>
                          {STATUSES.map((s) => <td key={s} className="px-4 py-2.5 text-right"><Money minor={amount(c, s)} currency={c} /></td>)}
                          <td className="py-2.5 pl-4 text-right">
                            {can('settlements.manage') && <CreatePayoutButton organizerId={o.id} organizerName={o.name} currency={c} availableMinor={amount(c, 'AVAILABLE')} onDone={reload} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {o.verificationStatus !== 'VERIFIED' && <div className="mt-4"><Notice tone="warn">This organizer is not verified. Payouts cannot be created until verification is complete.</Notice></div>}
            </Card>
          )}

          <Card title="Events" padded={false}>
            <DataTable columns={eventColumns} rows={o.events} empty={{ title: 'No events yet' }} />
          </Card>

          {o.finance && (
            <Card title="Payout history" padded={false}>
              <DataTable columns={payoutColumns} rows={o.finance.payouts} empty={{ title: 'No payouts yet' }} />
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Commercial agreement">
            <p className="whitespace-pre-wrap text-sm text-slate-700">{o.agreementNotes || 'No agreement notes recorded.'}</p>
          </Card>
          <Card title="Settlement arrangements">
            <KeyValue
              columns={1}
              items={[
                { label: 'Settlement currency', value: o.settlementCurrency },
                { label: 'Payout hold', value: `${o.payoutHoldDays} day${o.payoutHoldDays === 1 ? '' : 's'} after the event ends` },
                { label: 'Bank / mobile money details', value: o.hasSettlementDetails ? <Badge tone="green">On file (encrypted)</Badge> : <Badge tone="amber">Not provided</Badge> },
              ]}
            />
          </Card>
          {o.finance && (
            <Card title="Commission agreements" description="Rules specific to this organizer. Platform and brand defaults apply otherwise.">
              {o.finance.commissionRules.length === 0 ? (
                <p className="text-sm text-slate-500">No organizer-specific rules. Default commission rules apply.</p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {o.finance.commissionRules.map((r: any) => (
                    <li key={r.id} className="flex items-start justify-between gap-3">
                      <div><div className="text-slate-900">{r.name}</div><div className="text-xs text-slate-500">{humanize(r.type)}{!r.active && ' · inactive'}</div></div>
                      <div className="whitespace-nowrap text-right font-medium text-slate-900">
                        {bps(r.percentBps)}{Number(r.fixedMinor) > 0 && r.currency && <> + <Money minor={r.fixedMinor} currency={r.currency} /> / ticket</>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/settlements?tab=commissions" className="mt-4 inline-block text-sm font-medium text-accent-700 hover:underline">Manage commission rules</Link>
            </Card>
          )}
        </div>
      </div>

      {editing && <OrganizerForm organizer={o} onClose={() => setEditing(false)} onSaved={reload} />}
    </>
  );
}
