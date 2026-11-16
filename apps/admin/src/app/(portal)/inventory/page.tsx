'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ReconcileButton } from '@/components/events/reconcile';
import { StockBar } from '@/components/events/shared';
import { Badge, Card, Column, DataTable, DateTime, Money, PageHeader, Pagination, SearchInput, StatusBadge, Toolbar } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { number, percent } from '@/lib/format';
import { useDebounced, usePaged } from '@/lib/hooks';

interface Row {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  status: string;
  available: number;
  inventory: { total: number; sold: number; reserved: number } | null;
  event: { id: string; name: string; startsAt: string; status: string };
}

export default function InventoryPage() {
  const router = useRouter();
  const { can, user, brand } = useAuth();
  const [q, setQ] = useState('');
  const list = usePaged<Row>('/v1/admin/inventory', { q: useDebounced(q) });

  const columns: Column<Row>[] = [
    { key: 'event', header: 'Event', render: (r) => <div className="max-w-[18rem]"><div className="truncate font-medium text-slate-900">{r.event.name}</div><div className="text-xs text-slate-500"><DateTime value={r.event.startsAt} /></div></div> },
    { key: 'eventStatus', header: 'Event status', render: (r) => <StatusBadge status={r.event.status} /> },
    { key: 'name', header: 'Ticket category', render: (r) => <div><div className="text-slate-900">{r.name}</div><div className="text-xs text-slate-500"><Money minor={r.priceMinor} currency={r.currency} /></div></div> },
    { key: 'total', header: 'Total', align: 'right', render: (r) => number(r.inventory?.total ?? 0) },
    { key: 'sold', header: 'Sold', align: 'right', render: (r) => number(r.inventory?.sold ?? 0) },
    { key: 'reserved', header: 'Reserved', align: 'right', render: (r) => number(r.inventory?.reserved ?? 0) },
    {
      key: 'available', header: 'Available', align: 'right',
      render: (r) => {
        const total = r.inventory?.total ?? 0;
        const low = total > 0 && r.available > 0 && r.available / total <= 0.1;
        return (
          <span className="inline-flex items-center justify-end gap-2">
            {r.available === 0 && total > 0 ? <Badge tone="purple">Sold out</Badge> : low ? <Badge tone="amber">Low</Badge> : null}
            <span className={r.available === 0 ? 'font-medium text-purple-700' : low ? 'font-medium text-amber-700' : ''}>{number(r.available)}</span>
          </span>
        );
      },
    },
    {
      key: 'utilisation', header: 'Utilisation', width: '11rem',
      render: (r) => {
        const total = r.inventory?.total ?? 0;
        const used = (r.inventory?.sold ?? 0) + (r.inventory?.reserved ?? 0);
        return <div className="w-36"><div className="mb-1 text-right text-xs tabular-nums text-slate-500">{total ? percent(used / total, 0) : '-'}</div><StockBar total={total} sold={r.inventory?.sold ?? 0} reserved={r.inventory?.reserved ?? 0} /></div>;
      },
    },
    { key: 'status', header: 'Category', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        description={`The single inventory position each event sells from, across every storefront${brand ? `. Showing events listed on ${brand.name}; counts are for the whole shared pool.` : '.'}`}
        actions={can('inventory.manage') && user.allBrands && <ReconcileButton />}
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Search by event or ticket category" />
          <div className="ml-auto flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-600" /> Sold</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" /> Reserved in checkout</span>
          </div>
        </Toolbar>
        <DataTable
          columns={columns}
          rows={list.items}
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(r) => router.push(`/events/${r.event.id}?tab=inventory`)}
          empty={{ title: 'No inventory to show', description: 'Ticket categories of draft, scheduled and on-sale events appear here.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
    </>
  );
}
