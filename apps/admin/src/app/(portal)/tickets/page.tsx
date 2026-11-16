'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, BrandChip, Card, Column, DataTable, DateRange, DateTime, initialRange, PageHeader, Pagination, SearchInput, Select, StatusBadge, Tabs, Toolbar } from '@/components/ui';
import { humanize } from '@/lib/format';
import { useDebounced, usePaged, useQuery } from '@/lib/hooks';

const TICKET_STATUSES = ['VALID', 'USED', 'CANCELLED', 'REFUNDED', 'REVOKED', 'TRANSFERRED'];
const SCAN_RESULTS = ['ADMITTED', 'ALREADY_USED', 'INVALID_TOKEN', 'WRONG_EVENT', 'NOT_VALID', 'OFFLINE_CONFLICT'];

function useEvents() {
  const events = useQuery<{ items: { id: string; name: string }[] }>('/v1/admin/events', { pageSize: 100 });
  return (events.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }));
}

function TicketList() {
  const router = useRouter();
  const initial = useSearchParams();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [status, setStatus] = useState(initial.get('status') ?? '');
  const [eventId, setEventId] = useState(initial.get('eventId') ?? '');
  const [range, setRange] = useState(initialRange('30d'));
  const search = useDebounced(q);
  const events = useEvents();
  // Searching by reference looks across all dates.
  const list = usePaged<any>('/v1/admin/tickets', { q: search, status, eventId, ...(search ? {} : { from: range.from, to: range.to }) });

  const columns: Column<any>[] = [
    { key: 'reference', header: 'Ticket', render: (t) => <span className="font-mono text-[13px] font-medium text-slate-900">{t.reference}</span> },
    { key: 'event', header: 'Event', render: (t) => <span className="block max-w-[16rem] truncate">{t.event.name}</span> },
    { key: 'type', header: 'Type', render: (t) => t.ticketCategory.name },
    { key: 'holder', header: 'Holder', render: (t) => <div className="max-w-[14rem]"><div className="truncate text-slate-900">{t.holderName ?? '-'}</div><div className="truncate text-xs text-slate-500">{t.holderEmail}</div></div> },
    { key: 'brand', header: 'Brand', render: (t) => <BrandChip brand={t.order.brand} /> },
    { key: 'order', header: 'Order', render: (t) => <Link href={`/orders/${t.order.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[13px] text-accent-700 hover:underline">{t.order.reference}</Link> },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'issuedAt', header: 'Issued', render: (t) => <DateTime value={t.issuedAt} /> },
    { key: 'usedAt', header: 'Scanned', render: (t) => <DateTime value={t.usedAt} /> },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Ticket or order reference, holder name or email" />
        <Select value={status} onChange={setStatus} placeholder="Any status" options={TICKET_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
        <Select value={eventId} onChange={setEventId} placeholder="All events" options={events} className="max-w-[14rem]" />
        <div className="ml-auto"><DateRange value={range} onChange={setRange} /></div>
      </Toolbar>
      <DataTable
        columns={columns}
        rows={list.items}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        onRowClick={(t) => router.push(`/tickets/${t.id}`)}
        empty={{ title: 'No tickets match these filters', description: search ? 'Check the reference, or clear the other filters.' : 'Tickets are issued only after verified payment. Try a wider date range.' }}
      />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

function ScanLog() {
  const [result, setResult] = useState('');
  const [eventId, setEventId] = useState('');
  const [range, setRange] = useState(initialRange('7d'));
  const events = useEvents();
  const list = usePaged<any>('/v1/admin/ticket-scans', { result, eventId, from: range.from, to: range.to });

  const columns: Column<any>[] = [
    { key: 'scannedAt', header: 'Scanned', render: (s) => <DateTime value={s.scannedAt} /> },
    { key: 'result', header: 'Result', render: (s) => <StatusBadge status={s.result} /> },
    { key: 'ticket', header: 'Ticket', render: (s) => (s.ticket ? <Link href={`/tickets/${s.ticket.id}`} className="font-mono text-[13px] text-accent-700 hover:underline">{s.ticket.reference}</Link> : <span className="text-slate-400">Unrecognised code</span>) },
    { key: 'holder', header: 'Holder', render: (s) => s.ticket?.holderName ?? '-' },
    { key: 'type', header: 'Type', render: (s) => s.ticket?.ticketCategory.name ?? '-' },
    { key: 'event', header: 'Scanned for event', render: (s) => <span className="block max-w-[16rem] truncate">{s.event ?? '-'}</span> },
    { key: 'gate', header: 'Gate', render: (s) => s.gate ?? '-' },
    { key: 'scannedBy', header: 'Scanned by', render: (s) => <div><div>{s.scannedBy ?? '-'}</div>{s.deviceId && <div className="font-mono text-[11px] text-slate-400">{s.deviceId}</div>}</div> },
    { key: 'offline', header: 'Mode', render: (s) => (s.offline ? <Badge tone="amber">Offline sync</Badge> : <span className="text-xs text-slate-500">Live</span>) },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select value={result} onChange={setResult} placeholder="Any result" options={SCAN_RESULTS.map((s) => ({ value: s, label: humanize(s) }))} />
        <Select value={eventId} onChange={setEventId} placeholder="All events" options={events} className="max-w-[14rem]" />
        <div className="ml-auto"><DateRange value={range} onChange={setRange} /></div>
      </Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No scans in this period', description: 'Every scan attempt at the gate is recorded here, including rejected ones.' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

export default function TicketsPage() {
  const [tab, setTab] = useState('tickets');
  return (
    <>
      <PageHeader title="Tickets" description="Tickets issued centrally for every storefront, and every scan made against them." />
      <Tabs tabs={[{ id: 'tickets', label: 'Tickets' }, { id: 'scans', label: 'Scan log' }]} active={tab} onChange={setTab} />
      {tab === 'tickets' ? <TicketList /> : <ScanLog />}
    </>
  );
}
