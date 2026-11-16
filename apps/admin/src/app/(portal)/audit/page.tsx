'use client';

import { useState } from 'react';
import { JsonBlock, useBrandLookup } from '@/components/platform/bits';
import { BrandChip, Card, Column, DataTable, DateRange, DateTime, Drawer, ExportMenu, initialRange, Input, KeyValue, PageHeader, Pagination, SearchInput, Toolbar } from '@/components/ui';
import { Can } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { useDebounced, usePaged } from '@/lib/hooks';

interface AuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  brandId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ip: string | null;
  correlationId: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const brand = useBrandLookup();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [range, setRange] = useState(initialRange('30d'));
  const [open, setOpen] = useState<AuditRow | null>(null);
  const list = usePaged<AuditRow>('/v1/admin/audit-logs', {
    q: useDebounced(q), action: useDebounced(action.trim()), entityType: useDebounced(entityType.trim()), from: range.from, to: range.to,
  });

  const columns: Column<AuditRow>[] = [
    { key: 'createdAt', header: 'Time', render: (a) => <DateTime value={a.createdAt} /> },
    { key: 'actor', header: 'Actor', render: (a) => <div className="max-w-[16rem]"><div className="truncate text-slate-900">{a.actorLabel ?? humanize(a.actorType)}</div><div className="text-xs text-slate-500">{humanize(a.actorType)}</div></div> },
    { key: 'brand', header: 'Brand', render: (a) => (a.brandId ? <BrandChip brand={brand(a.brandId)} /> : <span className="text-slate-400">Platform</span>) },
    { key: 'action', header: 'Action', render: (a) => <span className="font-mono text-[13px] text-slate-900">{a.action}</span> },
    { key: 'entity', header: 'Entity', render: (a) => (a.entityType ? <div><div className="text-slate-700">{humanize(a.entityType)}</div><div className="max-w-[12rem] truncate font-mono text-xs text-slate-400">{a.entityId}</div></div> : '-') },
    { key: 'ip', header: 'IP address', render: (a) => <span className="font-mono text-xs">{a.ip ?? '-'}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="A permanent record of every sensitive action: who did what, to which record, when and from where. Entries cannot be edited or deleted."
        actions={<Can permission="reports.export"><ExportMenu path="/v1/admin/audit-logs" params={list.params} filename="audit-log" /></Can>}
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Actor, action or record ID" />
          <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action starts with (e.g. refund.)" aria-label="Action prefix" className="w-56" />
          <Input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="Entity type (e.g. order)" aria-label="Entity type" className="w-48" />
          <div className="ml-auto"><DateRange value={range} onChange={setRange} /></div>
        </Toolbar>
        <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={setOpen} empty={{ title: 'No audit entries match', description: 'Try a wider date range or fewer filters.' }} />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.action ?? ''}>
        {open && (
          <>
            <KeyValue
              items={[
                { label: 'Time', value: <DateTime value={open.createdAt} /> },
                { label: 'Actor', value: `${open.actorLabel ?? '-'} (${humanize(open.actorType)})` },
                { label: 'Brand', value: open.brandId ? <BrandChip brand={brand(open.brandId)} /> : 'Platform' },
                { label: 'Entity', value: open.entityType ? `${humanize(open.entityType)} ${open.entityId ?? ''}` : '-' },
                { label: 'IP address', value: open.ip ?? '-' },
                { label: 'Request ID', value: <span className="font-mono text-xs">{open.correlationId ?? '-'}</span> },
              ]}
            />
            <div><h3 className="mb-1.5 text-sm font-semibold text-slate-900">Before</h3><JsonBlock value={open.before} /></div>
            <div><h3 className="mb-1.5 text-sm font-semibold text-slate-900">After</h3><JsonBlock value={open.after} /></div>
            <div><h3 className="mb-1.5 text-sm font-semibold text-slate-900">Details</h3><JsonBlock value={open.metadata} /></div>
            <p className="text-xs text-slate-400">Passwords, keys and tokens are redacted before an entry is written.</p>
          </>
        )}
      </Drawer>
    </>
  );
}
