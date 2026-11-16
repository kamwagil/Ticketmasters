'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  Badge, BrandChip, Button, Card, Column, CurrencyList, DataTable, DateRange, DateTime, ErrorState, ExportMenu, initialRange, Money, PageHeader, Pagination, SearchInput,
  Select, Skeleton, StatCard, StatusBadge, Tabs, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { humanize, number, percent } from '@/lib/format';
import { useAction, useDebounced, usePaged, useQuery } from '@/lib/hooks';

interface PaymentRow {
  id: string; reference: string; providerCode: string; providerTransactionId: string | null; amountMinor: number; currency: string; status: string; livemode: boolean;
  gatewayFeeMinor: number | null; netSettlementMinor: number | null; failureReason: string | null; createdAt: string; paidAt: string | null; channel: string | null;
  order: { id: string; reference: string; customerName: string; customerEmail: string; brand: { id: string; name: string; primaryColor: string } };
}
interface Summary {
  total: number; succeeded: number; failed: number; pending: number; cancelled: number; successRate: number | null;
  byCurrency: { currency: string; payments: number; grossMinor: number; gatewayFeesMinor: number; netSettlementMinor: number }[];
  refunds: { currency: string; refunds: number; refundedMinor: number }[];
  pendingRefundRequests: number;
}
interface WebhookRow {
  id: string; providerCode: string; eventType: string; reference: string | null; signatureValid: boolean; status: string; attempts: number; error: string | null;
  receivedAt: string; processedAt: string | null;
}

const STATUSES = ['INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
const PROVIDERS = [{ value: 'paystack', label: 'Paystack' }, { value: 'flutterwave', label: 'Flutterwave' }, { value: 'sandbox', label: 'Sandbox (test)' }];

function PaymentsTab() {
  const initial = useSearchParams();
  const { brands, brand } = useAuth();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [status, setStatus] = useState(initial.get('status') ?? '');
  const [provider, setProvider] = useState('');
  const [currency, setCurrency] = useState('');
  const [range, setRange] = useState(initialRange('30d'));
  const search = useDebounced(q);
  const period = { from: range.from, to: range.to };
  const summary = useQuery<Summary>('/v1/admin/payments/summary', period);
  const list = usePaged<PaymentRow>('/v1/admin/payments', { q: search, status, provider, currency, ...(search ? {} : period) });
  const currencies = [...new Set((brand ? [brand] : brands).flatMap((b) => [b.defaultCurrency]).concat(summary.data?.byCurrency.map((c) => c.currency) ?? []))].sort();
  const s = summary.data;

  const columns: Column<PaymentRow>[] = [
    { key: 'reference', header: 'Payment reference', render: (p) => <span className="font-mono text-[13px] font-medium text-slate-900">{p.reference}</span> },
    { key: 'gateway', header: 'Gateway', render: (p) => <span className="flex items-center gap-1.5 capitalize">{p.providerCode}{!p.livemode && <Badge tone="amber">test</Badge>}</span> },
    { key: 'txn', header: 'Gateway transaction ID', render: (p) => <span className="font-mono text-xs text-slate-500">{p.providerTransactionId ?? '-'}</span> },
    { key: 'brand', header: 'Brand', render: (p) => <BrandChip brand={p.order.brand} /> },
    { key: 'order', header: 'Order', render: (p) => <Link href={`/orders/${p.order.id}`} className="font-mono text-[13px] text-accent-700 hover:underline">{p.order.reference}</Link> },
    { key: 'customer', header: 'Customer', render: (p) => <div className="max-w-[13rem]"><div className="truncate text-slate-900">{p.order.customerName}</div><div className="truncate text-xs text-slate-500">{p.order.customerEmail}</div></div> },
    { key: 'amount', header: 'Amount', align: 'right', render: (p) => <Money minor={p.amountMinor} currency={p.currency} className="font-medium text-slate-900" /> },
    { key: 'fees', header: 'Fees', align: 'right', render: (p) => <Money minor={p.gatewayFeeMinor} currency={p.currency} /> },
    { key: 'net', header: 'Net settlement', align: 'right', render: (p) => <Money minor={p.netSettlementMinor} currency={p.currency} /> },
    { key: 'status', header: 'Status', render: (p) => <div><StatusBadge status={p.status} />{p.failureReason && <div className="mt-1 max-w-[14rem] truncate text-xs text-red-600" title={p.failureReason}>{p.failureReason}</div>}</div> },
    { key: 'date', header: 'Transaction date', render: (p) => <DateTime value={p.paidAt ?? p.createdAt} /> },
  ];

  return (
    <>
      {summary.error && !s ? <Card className="mb-5"><ErrorState error={summary.error} onRetry={summary.reload} /></Card> : (
        <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
          {!s ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[96px] w-full rounded-xl" />) : (
            <>
              <StatCard label="Total transactions" value={number(s.total)} />
              <StatCard label="Successful" value={number(s.succeeded)} tone="good" />
              <StatCard label="Failed" value={number(s.failed)} tone={s.failed ? 'bad' : 'default'} />
              <StatCard label="Pending" value={number(s.pending)} tone={s.pending ? 'warn' : 'default'} hint={s.cancelled ? `${number(s.cancelled)} cancelled or abandoned` : undefined} />
              <StatCard label="Success rate" value={percent(s.successRate)} hint="Succeeded / (succeeded + failed)" />
              <div className="col-span-2 lg:col-span-5">
                <Card title="Amounts by currency" description="Each currency is totalled separately" padded={false}>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-max text-sm">
                      <thead><tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {['Currency', 'Payments', 'Gross captured', 'Gateway fees', 'Net settlement', 'Refunds', 'Refunded'].map((h, i) => <th key={h} className={`px-4 py-2.5 ${i ? 'text-right' : 'text-left'}`}>{h}</th>)}
                      </tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {[...new Set([...s.byCurrency.map((c) => c.currency), ...s.refunds.map((r) => r.currency)])].map((cur) => {
                          const c = s.byCurrency.find((x) => x.currency === cur);
                          const r = s.refunds.find((x) => x.currency === cur);
                          return (
                            <tr key={cur}>
                              <td className="px-4 py-3 font-medium text-slate-900">{cur}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{number(c?.payments ?? 0)}</td>
                              <td className="px-4 py-3 text-right font-medium text-slate-900"><Money minor={c?.grossMinor ?? 0} currency={cur} /></td>
                              <td className="px-4 py-3 text-right"><Money minor={c?.gatewayFeesMinor ?? 0} currency={cur} /></td>
                              <td className="px-4 py-3 text-right"><Money minor={c?.netSettlementMinor ?? 0} currency={cur} /></td>
                              <td className="px-4 py-3 text-right tabular-nums">{number(r?.refunds ?? 0)}</td>
                              <td className="px-4 py-3 text-right text-purple-700"><Money minor={r?.refundedMinor ?? 0} currency={cur} /></td>
                            </tr>
                          );
                        })}
                        {!s.byCurrency.length && !s.refunds.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No successful payments in this period</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  {s.pendingRefundRequests > 0 && (
                    <div className="border-t border-slate-100 px-4 py-2.5 text-sm">
                      <Link href="/refunds?status=REQUESTED" className="font-medium text-accent-700 hover:underline">{s.pendingRefundRequests} refund request{s.pendingRefundRequests === 1 ? '' : 's'} awaiting approval</Link>
                    </div>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>
      )}
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Payment or order reference, gateway ID, email" />
          <Select value={status} onChange={setStatus} placeholder="Any status" options={STATUSES.map((x) => ({ value: x, label: humanize(x) }))} />
          <Select value={provider} onChange={setProvider} placeholder="Any gateway" options={PROVIDERS} />
          <Select value={currency} onChange={setCurrency} placeholder="Any currency" options={currencies.map((c) => ({ value: c, label: c }))} />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <DateRange value={range} onChange={setRange} />
            <Can permission="reports.export"><ExportMenu path="/v1/admin/payments" params={list.params} filename="payments" /></Can>
          </div>
        </Toolbar>
        <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No payments match these filters', description: search ? 'Check the reference, or clear the other filters.' : 'Try a wider date range.' }} />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
    </>
  );
}

function WebhooksTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const search = useDebounced(q);
  const list = usePaged<WebhookRow>('/v1/admin/webhook-events', { q: search, status }, { scoped: false });
  const { run } = useAction();
  const [busy, setBusy] = useState<string | null>(null);

  const reprocess = async (id: string) => {
    setBusy(id);
    const res = await run(() => api.post(`/v1/admin/webhook-events/${id}/reprocess`), { onError: (e) => toast.error(e.message) });
    setBusy(null);
    if (res) {
      toast.success(`Event reprocessed: ${humanize(res.status)}`);
      list.reload();
    }
  };

  const columns: Column<WebhookRow>[] = [
    { key: 'received', header: 'Received', render: (w) => <DateTime value={w.receivedAt} /> },
    { key: 'gateway', header: 'Gateway', render: (w) => <span className="capitalize">{w.providerCode}</span> },
    { key: 'type', header: 'Event', render: (w) => <span className="font-mono text-xs">{w.eventType}</span> },
    { key: 'reference', header: 'Payment reference', render: (w) => (w.reference ? <Link href={`/payments?q=${w.reference}`} className="font-mono text-[13px] text-accent-700 hover:underline">{w.reference}</Link> : '-') },
    { key: 'signature', header: 'Signature', render: (w) => (w.signatureValid ? <Badge tone="green">valid</Badge> : <Badge tone="red">invalid</Badge>) },
    { key: 'status', header: 'Status', render: (w) => <div><StatusBadge status={w.status} />{w.error && <div className="mt-1 max-w-[18rem] truncate text-xs text-slate-500" title={w.error}>{w.error}</div>}</div> },
    { key: 'attempts', header: 'Attempts', align: 'right', render: (w) => w.attempts },
    { key: 'processed', header: 'Processed', render: (w) => <DateTime value={w.processedAt} /> },
    {
      key: 'actions', header: '', align: 'right',
      render: (w) => can('payments.reconcile') && w.signatureValid && w.status !== 'REJECTED' && (
        <Button size="sm" variant="secondary" loading={busy === w.id} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => reprocess(w.id)}>Reprocess</Button>
      ),
    },
  ];
  return (
    <Card padded={false} title="Gateway webhook events" description="Every delivery is stored once. Reprocessing is safe to repeat: a payment is never applied twice. Events with an invalid signature can never be processed.">
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Payment reference or event key" />
        <Select value={status} onChange={setStatus} placeholder="Any status" options={['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'REJECTED'].map((x) => ({ value: x, label: humanize(x) }))} />
      </Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No webhook events' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

export default function PaymentsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuth();
  const tab = params.get('tab') === 'webhooks' && user.allBrands ? 'webhooks' : 'payments';
  return (
    <>
      <PageHeader title="Payments" description="Transactions from every storefront, confirmed server-side with the payment provider. Amounts are shown per currency." />
      {user.allBrands && (
        <Tabs active={tab} onChange={(t) => router.replace(t === 'webhooks' ? '/payments?tab=webhooks' : '/payments')} tabs={[{ id: 'payments', label: 'Payments' }, { id: 'webhooks', label: 'Webhook events' }]} />
      )}
      {tab === 'payments' ? <PaymentsTab /> : <WebhooksTab />}
    </>
  );
}
