'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { OrganizerForm } from '@/components/platform/organizer-form';
import { Button, Card, Column, DataTable, PageHeader, Pagination, SearchInput, StatusBadge, Toolbar } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useDebounced, usePaged } from '@/lib/hooks';

interface OrganizerRow {
  id: string;
  name: string;
  legalName: string | null;
  contactEmail: string;
  country: string | null;
  verificationStatus: string;
  settlementCurrency: string;
  payoutHoldDays: number;
  _count: { events: number; payouts: number };
}

export default function OrganizersPage() {
  const router = useRouter();
  const { can, user } = useAuth();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = usePaged<OrganizerRow>('/v1/admin/organizers', { q: useDebounced(q) });
  const canManage = can('organizers.manage') && user.allBrands;

  const columns: Column<OrganizerRow>[] = [
    {
      key: 'name', header: 'Organizer',
      render: (o) => (
        <div className="max-w-[18rem]">
          <div className="truncate font-medium text-slate-900">{o.name}</div>
          <div className="truncate text-xs text-slate-500">{o.contactEmail}</div>
        </div>
      ),
    },
    { key: 'legalName', header: 'Legal name', render: (o) => o.legalName ?? '-' },
    { key: 'country', header: 'Country', render: (o) => o.country ?? '-' },
    { key: 'verificationStatus', header: 'Verification', render: (o) => <StatusBadge status={o.verificationStatus} /> },
    { key: 'events', header: 'Events', align: 'right', render: (o) => o._count.events },
    { key: 'settlementCurrency', header: 'Settles in' },
    { key: 'hold', header: 'Payout hold', render: (o) => `${o.payoutHoldDays} day${o.payoutHoldDays === 1 ? '' : 's'}` },
  ];

  return (
    <>
      <PageHeader
        title="Sellers & Promoters"
        description="Event organizers whose tickets are sold through the storefronts, with their legal details, commercial terms and settlement arrangements."
        actions={canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New organizer</Button>}
      />
      <Card padded={false}>
        <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Name or contact email" /></Toolbar>
        <DataTable
          columns={columns}
          rows={list.items}
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(o) => router.push(`/organizers/${o.id}`)}
          empty={{ title: 'No organizers found', description: 'Organizers appear here once they have events on a storefront you can access.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
      {creating && <OrganizerForm onClose={() => setCreating(false)} onSaved={(o) => router.push(`/organizers/${o.id}`)} />}
    </>
  );
}
