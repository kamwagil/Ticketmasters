'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandChip, Card, Column, CurrencyList, DataTable, DateTime, ExportMenu, PageHeader, Pagination, SearchInput, StatusBadge, Toolbar } from '@/components/ui';
import { Can, useAuth } from '@/lib/auth';
import { number } from '@/lib/format';
import { useDebounced, usePaged } from '@/lib/hooks';

interface CustomerRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  status: string;
  createdAt: string;
  relationships: { brandId: string; email: string; status: string; emailVerifiedAt: string | null; brand: { id: string; name: string; primaryColor: string } }[];
  orderCount: number;
  spend: { currency: string; netMinor: number }[];
  lastOrderAt: string | null;
}

export default function CustomersPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [q, setQ] = useState(useSearchParams().get('q') ?? '');
  const search = useDebounced(q);
  const list = usePaged<CustomerRow>('/v1/admin/customers', { q: search });

  const columns: Column<CustomerRow>[] = [
    {
      key: 'customer', header: 'Customer',
      render: (c) => (
        <div className="max-w-[16rem]">
          <div className="truncate font-medium text-slate-900">{c.fullName}</div>
          <div className="truncate text-xs text-slate-500">{[c.city, c.country].filter(Boolean).join(', ') || 'Location not given'}</div>
        </div>
      ),
    },
    {
      key: 'contact', header: 'Contact',
      render: (c) => (
        <div className="max-w-[16rem]">
          <div className="truncate text-slate-800">{c.email ?? '-'}</div>
          <div className="truncate text-xs text-slate-500">{c.phone ?? ''}</div>
        </div>
      ),
    },
    {
      key: 'brands', header: 'Brands',
      render: (c) => <div className="flex max-w-[14rem] flex-col gap-0.5">{c.relationships.map((r) => <BrandChip key={r.brandId} brand={r.brand} />)}</div>,
    },
    { key: 'orders', header: 'Orders', align: 'right', render: (c) => number(c.orderCount) },
    { key: 'spend', header: 'Total spending', align: 'right', render: (c) => <CurrencyList items={c.spend.map((s) => ({ currency: s.currency, amountMinor: s.netMinor }))} className="items-end font-medium text-slate-900" /> },
    { key: 'last', header: 'Last purchase', render: (c) => <DateTime value={c.lastOrderAt} mode="date" /> },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Customers"
        description={
          user.allBrands
            ? 'One central record per person, with a separate relationship, consent and purchase history for each brand.'
            : 'Customers of the brands you manage. Orders and spending shown are for those brands only.'
        }
        actions={<Can permission="reports.export"><ExportMenu path="/v1/admin/customers" params={list.params} filename="customers" /></Can>}
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Name, email or phone" />
        </Toolbar>
        <DataTable
          columns={columns}
          rows={list.items}
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(c) => router.push(`/customers/${c.id}`)}
          empty={{ title: search ? 'No customers match this search' : 'No customers yet', description: search ? 'Check the spelling, or try the email address or phone number.' : 'Customers appear here after their first checkout or registration.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
    </>
  );
}
