'use client';

import { Plus, Settings2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { StockBar } from '@/components/events/shared';
import { Card, Column, DataTable, DateTime, LinkButton, PageHeader, Pagination, SearchInput, Select, StatusBadge, Toolbar } from '@/components/ui';
import { Can, useAuth } from '@/lib/auth';
import { number } from '@/lib/format';
import { useDebounced, usePaged, useQuery } from '@/lib/hooks';

interface EventRow {
  id: string;
  name: string;
  startsAt: string;
  status: string;
  ownerBrandId: string | null;
  venue: { name: string; city: string } | null;
  category: { name: string } | null;
  organizer: { id: string; name: string } | null;
  publications: { brandId: string; visible: boolean; brand: { name: string; primaryColor: string } }[];
  capacity: number;
  sold: number;
  reserved: number;
}

const STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'POSTPONED', 'CANCELLED', 'COMPLETED', 'ARCHIVED'];

export default function EventsPage() {
  const router = useRouter();
  const initial = useSearchParams();
  const { can } = useAuth();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [status, setStatus] = useState(initial.get('status') ?? '');
  const [organizerId, setOrganizerId] = useState(initial.get('organizerId') ?? '');
  const list = usePaged<EventRow>('/v1/admin/events', { q: useDebounced(q), status, organizerId });
  const organizers = useQuery<{ items: { id: string; name: string }[] }>(can('organizers.read') ? '/v1/admin/organizers' : null, { pageSize: 200 });

  const columns: Column<EventRow>[] = [
    {
      key: 'name', header: 'Event',
      render: (e) => (
        <div className="max-w-[20rem]">
          <div className="truncate font-medium text-slate-900">{e.name}</div>
          <div className="truncate text-xs text-slate-500">{e.category?.name ?? 'Uncategorised'}{e.ownerBrandId ? '' : ' · Platform-managed'}</div>
        </div>
      ),
    },
    { key: 'startsAt', header: 'Date', render: (e) => <DateTime value={e.startsAt} /> },
    { key: 'venue', header: 'Venue', render: (e) => (e.venue ? <span className="block max-w-[14rem] truncate">{e.venue.name}, {e.venue.city}</span> : <span className="text-slate-400">To be announced</span>) },
    { key: 'organizer', header: 'Organizer', render: (e) => <span className="block max-w-[12rem] truncate">{e.organizer?.name ?? '-'}</span> },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    {
      key: 'storefronts', header: 'Storefronts',
      render: (e) =>
        e.publications.length ? (
          <div className="flex items-center gap-1" title={e.publications.map((p) => `${p.brand.name}${p.visible ? '' : ' (hidden)'}`).join(', ')}>
            {e.publications.map((p) => (
              <span key={p.brandId} className={`h-3 w-3 rounded-full ring-1 ring-black/10 ${p.visible ? '' : 'opacity-30'}`} style={{ background: p.brand.primaryColor }} />
            ))}
            <span className="ml-1 text-xs text-slate-500">{e.publications.length}</span>
          </div>
        ) : (
          <span className="text-xs text-slate-400">Not published</span>
        ),
    },
    {
      key: 'sold', header: 'Sold / capacity', width: '11rem',
      render: (e) => (
        <div className="w-40">
          <div className="mb-1 flex justify-between text-xs tabular-nums text-slate-600"><span>{number(e.sold)} / {number(e.capacity)}</span>{e.reserved > 0 && <span className="text-amber-600">{number(e.reserved)} held</span>}</div>
          <StockBar total={e.capacity} sold={e.sold} reserved={e.reserved} />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Events"
        description="One master record and one inventory pool per event, published to any combination of storefronts."
        actions={
          <>
            <LinkButton href="/events/reference" icon={<Settings2 className="h-4 w-4" />}>Venues, performers & categories</LinkButton>
            <Can permission="events.manage"><LinkButton href="/events/new" variant="primary" icon={<Plus className="h-4 w-4" />}>New event</LinkButton></Can>
          </>
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Search events by name" />
          <Select value={status} onChange={setStatus} placeholder="Active events" options={STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
          {can('organizers.read') && (
            <Select value={organizerId} onChange={setOrganizerId} placeholder="All organizers" options={(organizers.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))} className="max-w-[14rem]" />
          )}
        </Toolbar>
        <DataTable
          columns={columns}
          rows={list.items}
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(e) => router.push(`/events/${e.id}`)}
          empty={{ title: 'No events found', description: status === '' ? 'Archived events are hidden unless you filter for them.' : 'Try a different status or search.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
    </>
  );
}
