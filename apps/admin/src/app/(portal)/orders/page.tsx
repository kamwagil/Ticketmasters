'use client';

import { AlertTriangle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandChip, Card, Column, DataTable, DateRange, DateTime, ExportMenu, initialRange, Money, PageHeader, Pagination, SearchInput, Select, StatusBadge, Toolbar } from '@/components/ui';
import { Can } from '@/lib/auth';
import { useDebounced, usePaged, useQuery } from '@/lib/hooks';

interface OrderRow {
  id: string;
  reference: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  currency: string;
  totalMinor: number;
  status: string;
  paymentStatus: string;
  needsAttention: boolean;
  brand: { id: string; name: string; primaryColor: string };
  event: { id: string; name: string };
  items: { categoryName: string; quantity: number }[];
}

const ORDER_STATUSES = ['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID', 'TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'FAILED'];
const PAYMENT_STATUSES = ['UNPAID', 'PROCESSING', 'PAID', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export default function OrdersPage() {
  const router = useRouter();
  const initial = useSearchParams();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [status, setStatus] = useState(initial.get('status') ?? '');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [eventId, setEventId] = useState(initial.get('eventId') ?? '');
  const [attention, setAttention] = useState(initial.get('needsAttention') ?? '');
  const [range, setRange] = useState(initialRange('30d'));
  const search = useDebounced(q);
  // A search looks across all dates: someone pasting an order reference expects to find it.
  const list = usePaged<OrderRow>('/v1/admin/orders', {
    q: search, status, paymentStatus, eventId, needsAttention: attention, ...(search ? {} : { from: range.from, to: range.to }),
  });
  const events = useQuery<{ items: { id: string; name: string }[] }>('/v1/admin/events', { pageSize: 100 });

  const columns: Column<OrderRow>[] = [
    {
      key: 'reference', header: 'Order',
      render: (o) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-medium text-slate-900">{o.reference}</span>
          {o.needsAttention && <span title="Needs attention"><AlertTriangle className="h-4 w-4 text-amber-500" /></span>}
        </div>
      ),
    },
    { key: 'createdAt', header: 'Placed', render: (o) => <DateTime value={o.createdAt} /> },
    { key: 'brand', header: 'Brand', render: (o) => <BrandChip brand={o.brand} /> },
    {
      key: 'customer', header: 'Customer',
      render: (o) => (
        <div className="max-w-[14rem]">
          <div className="truncate text-slate-900">{o.customerName}</div>
          <div className="truncate text-xs text-slate-500">{o.customerEmail}</div>
        </div>
      ),
    },
    {
      key: 'event', header: 'Event',
      render: (o) => (
        <div className="max-w-[16rem]">
          <div className="truncate text-slate-900">{o.event.name}</div>
          <div className="truncate text-xs text-slate-500">{o.items.map((i) => `${i.quantity} × ${i.categoryName}`).join(', ')}</div>
        </div>
      ),
    },
    { key: 'total', header: 'Total', align: 'right', render: (o) => <Money minor={o.totalMinor} currency={o.currency} className="font-medium text-slate-900" /> },
    { key: 'paymentStatus', header: 'Payment', render: (o) => <StatusBadge status={o.paymentStatus} /> },
    { key: 'status', header: 'Order status', render: (o) => <StatusBadge status={o.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every purchase from every storefront, recorded centrally with its originating brand."
        actions={<Can permission="orders.export"><ExportMenu path="/v1/admin/orders" params={list.params} filename="orders" /></Can>}
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Order reference, email, phone or name" />
          <Select value={status} onChange={setStatus} placeholder="Any order status" options={ORDER_STATUSES.map((s) => ({ value: s, label: label(s) }))} />
          <Select value={paymentStatus} onChange={setPaymentStatus} placeholder="Any payment status" options={PAYMENT_STATUSES.map((s) => ({ value: s, label: label(s) }))} />
          <Select value={eventId} onChange={setEventId} placeholder="All events" options={(events.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))} className="max-w-[14rem]" />
          <Select value={attention} onChange={setAttention} placeholder="All orders" options={[{ value: 'true', label: 'Needs attention' }]} />
          <div className="ml-auto"><DateRange value={range} onChange={setRange} /></div>
        </Toolbar>
        <DataTable
          columns={columns}
          rows={list.items}
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(o) => router.push(`/orders/${o.id}`)}
          empty={{ title: 'No orders match these filters', description: search ? 'Check the reference or email, or clear the other filters.' : 'Try a wider date range.' }}
        />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
    </>
  );
}
