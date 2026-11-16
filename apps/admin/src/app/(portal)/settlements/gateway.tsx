'use client';

import { CheckCircle2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CURRENCY_RE, dayInput, Notice } from '@/components/platform/bits';
import {
  Badge, BrandChip, Button, Card, Checkbox, Column, DataTable, DateRange, DateTime, Field, FormError, initialRange, Input, Modal, Money, Pagination, Select,
  SelectInput, StatusBadge, Textarea, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize, money, toMinor } from '@/lib/format';
import { useAction, usePaged, useQuery } from '@/lib/hooks';

function RecordSettlement({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const accounts = useQuery<any[]>('/v1/admin/payment-accounts', undefined, { scoped: false });
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [f, setF] = useState({ providerAccountId: '', providerSettlementId: '', currency: '', gross: '', fees: '0.00', settledAt: dayInput(new Date()), refs: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const account = accounts.data?.find((a) => a.id === f.providerAccountId);
  const gross = toMinor(f.gross);
  const fees = toMinor(f.fees);
  const net = gross !== null && fees !== null ? gross - fees : null;
  const currency = f.currency || account?.currencies?.[0] || '';

  const submit = async () => {
    setError(null);
    if (!account) return setError('Choose the merchant account the settlement was paid from.');
    if (!CURRENCY_RE.test(currency)) return setError('Choose the settlement currency.');
    if (gross === null || fees === null) return setError('Enter gross and fees as amounts, for example 12500.00.');
    if (net === null || net < 0) return setError('Fees cannot be greater than the gross amount.');
    const paymentReferences = [...new Set(f.refs.split(/[\s,;]+/).map((r) => r.trim().toUpperCase()).filter(Boolean))];
    const res = await run(
      () => api.post('/v1/admin/gateway-settlements', {
        providerAccountId: account.id, providerSettlementId: f.providerSettlementId.trim(), currency, grossMinor: gross, feesMinor: fees, netMinor: net,
        settledAt: new Date(`${f.settledAt}T12:00:00`).toISOString(), paymentReferences, ...(f.note.trim() ? { note: f.note.trim() } : {}),
      }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      setResult(res);
      toast.success('Settlement recorded');
      onDone();
    }
  };

  if (result) {
    return (
      <Modal open onClose={onClose} title="Settlement recorded" footer={<Button onClick={onClose}>Done</Button>}>
        <div className="flex items-center gap-2 text-sm"><StatusBadge status={result.settlement.status} /><span className="text-slate-600">{result.linkedPayments} payment{result.linkedPayments === 1 ? '' : 's'} linked</span></div>
        {result.problems.length === 0 ? (
          <Notice tone="good">The settlement agrees with the payments it covers. The bank and gateway clearing accounts have been updated in the ledger.</Notice>
        ) : (
          <>
            <Notice tone="warn">The settlement was stored, but its figures do not fully agree with the platform's records. Review each point below.</Notice>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{result.problems.map((p: string) => <li key={p}>{p}</li>)}</ul>
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Record gateway settlement"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={loading} disabled={!f.providerAccountId || !f.providerSettlementId.trim()} onClick={submit}>Record settlement</Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">Enter a payout the gateway made to the bank account, exactly as shown on the provider's settlement report. It is matched against the payments it covers.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Merchant account">
          <SelectInput value={f.providerAccountId} onChange={(e) => setF((s) => ({ ...s, providerAccountId: e.target.value, currency: '' }))} placeholder={accounts.loading ? 'Loading accounts' : 'Choose account'} options={(accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.label} (${a.providerCode})` }))} />
        </Field>
        <Field label="Provider settlement ID"><Input value={f.providerSettlementId} onChange={set('providerSettlementId')} /></Field>
        <Field label="Currency">
          <SelectInput value={currency} onChange={set('currency')} options={(account?.currencies ?? []).map((c: string) => ({ value: c, label: c }))} placeholder={account ? undefined : 'Choose an account first'} disabled={!account} />
        </Field>
        <Field label="Settled on"><Input type="date" value={f.settledAt} max={dayInput(new Date())} onChange={set('settledAt')} /></Field>
        <Field label="Gross amount"><Input inputMode="decimal" value={f.gross} onChange={set('gross')} placeholder="0.00" /></Field>
        <Field label="Gateway fees"><Input inputMode="decimal" value={f.fees} onChange={set('fees')} placeholder="0.00" /></Field>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5 text-sm">
        <span className="text-slate-600">Net paid to bank (gross less fees)</span>
        <span className="font-semibold text-slate-900">{net !== null && net >= 0 && currency ? money(net, currency) : '-'}</span>
      </div>
      <Field label="Payment references covered" hint="One per line (PAY-...). Copy them from the provider's settlement report.">
        <Textarea value={f.refs} onChange={set('refs')} className="font-mono text-xs" rows={5} />
      </Field>
      <Field label="Note (optional)"><Input value={f.note} onChange={set('note')} /></Field>
      <FormError error={accounts.error?.message ?? error} />
    </Modal>
  );
}

export function GatewaySettlementsTab() {
  const [recording, setRecording] = useState(false);
  const list = usePaged<any>('/v1/admin/gateway-settlements', undefined, { scoped: false });
  const columns: Column<any>[] = [
    { key: 'id', header: 'Settlement', render: (s) => <span className="font-mono text-[13px] font-medium text-slate-900">{s.providerSettlementId}</span> },
    { key: 'account', header: 'Merchant account', render: (s) => <div><div className="text-slate-900">{s.providerAccount.label}</div><div className="text-xs capitalize text-slate-500">{s.providerAccount.providerCode}</div></div> },
    { key: 'settledAt', header: 'Settled', render: (s) => <DateTime value={s.settledAt} mode="date" /> },
    { key: 'gross', header: 'Gross', align: 'right', render: (s) => <Money minor={s.grossMinor} currency={s.currency} /> },
    { key: 'fees', header: 'Fees', align: 'right', render: (s) => <Money minor={s.feesMinor} currency={s.currency} /> },
    { key: 'net', header: 'Net to bank', align: 'right', render: (s) => <Money minor={s.netMinor} currency={s.currency} className="font-medium text-slate-900" /> },
    { key: 'payments', header: 'Payments', align: 'right', render: (s) => s._count.payments },
    { key: 'status', header: 'Status', render: (s) => <div><StatusBadge status={s.status} />{s.status === 'DISCREPANCY' && s.note && <div className="mt-1 max-w-[22rem] whitespace-normal text-xs text-red-600">{s.note}</div>}</div> },
  ];
  return (
    <Card padded={false} title="Gateway settlements" description="Money the payment providers have paid to the bank, matched against captured payments." actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRecording(true)}>Record settlement</Button>}>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No settlements recorded', description: 'Record each gateway payout as it reaches the bank so captured funds can be reconciled.' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      {recording && <RecordSettlement onClose={() => setRecording(false)} onDone={list.reload} />}
    </Card>
  );
}

const CHECK_LABEL: Record<string, string> = {
  ORDER_PAYMENT_COUNT: 'Paid orders without exactly one successful payment', ORDER_PAYMENT_AMOUNT: 'Order total differs from the payment', PAYMENT_WITHOUT_PAID_ORDER: 'Successful payment on an unpaid order',
  PAYMENT_LEDGER_MISMATCH: 'Payment not matched in the ledger', REFUND_MISMATCH: 'Refund records disagree', REFUND_STUCK: 'Refunds stuck in progress', TICKET_COUNT_MISMATCH: 'Tickets issued differ from tickets paid for',
  GATEWAY_RECORD_MISMATCH: 'Gateway record differs from internal record', GATEWAY_UNREACHABLE: 'Gateway could not be checked', SETTLEMENT_DISCREPANCY: 'Settlement figures disagree', UNSETTLED_PAYMENTS: 'Payments not yet settled',
  PROMOTER_PAYABLE_MISMATCH: 'Promoter payables differ from the ledger', LEDGER_UNBALANCED: 'Ledger out of balance',
};

function IssueList({ issues }: { issues: any[] }) {
  const { can } = useAuth();
  if (!issues.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-800">
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        <span><strong>All clear.</strong> Orders, payments, refunds, tickets, the ledger, settlements and promoter payables agree for this period.</span>
      </div>
    );
  }
  const groups = new Map<string, any[]>();
  for (const i of issues) groups.set(i.check, [...(groups.get(i.check) ?? []), i]);
  const link = (i: any) => (i.entityType === 'order' && can('orders.read') ? `/orders/${i.entityId}` : i.entityType === 'payment' && i.reference && can('payments.read') ? `/payments?q=${i.reference}` : i.entityType === 'refund' && i.reference ? `/refunds?q=${i.reference}` : null);
  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([check, list]) => (
        <div key={check} className="rounded-xl border border-slate-200">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
            <Badge tone={list[0].severity === 'CRITICAL' ? 'red' : 'amber'}>{list[0].severity.toLowerCase()}</Badge>
            <span className="text-sm font-semibold text-slate-900">{CHECK_LABEL[check] ?? humanize(check)}</span>
            <span className="text-xs text-slate-500">{list.length}</span>
          </div>
          <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
            {list.map((i, n) => {
              const href = link(i);
              return (
                <li key={`${i.entityId}-${n}`} className="px-4 py-2">
                  {i.reference && (href ? <Link href={href} className="mr-2 font-mono text-[13px] font-medium text-accent-700 hover:underline">{i.reference}</Link> : <span className="mr-2 font-mono text-[13px] font-medium text-slate-900">{i.reference}</span>)}
                  <span className="text-slate-600">{i.detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RunSummary({ summary }: { summary: any }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(summary.totals ?? []).map((t: any) => (
          <div key={t.currency} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Captured · {t.currency}</div>
            <div className="mt-1 font-semibold text-slate-900"><Money minor={t.capturedMinor} currency={t.currency} /></div>
            <div className="text-xs text-slate-500">{t.payments} payments · fees <Money minor={t.gatewayFeesMinor} currency={t.currency} /></div>
          </div>
        ))}
        {(summary.refunds ?? []).map((t: any) => (
          <div key={`r-${t.currency}`} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Refunded · {t.currency}</div>
            <div className="mt-1 font-semibold text-slate-900"><Money minor={t.refundedMinor} currency={t.currency} /></div>
            <div className="text-xs text-slate-500">{t.refunds} refunds</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Checked {summary.checked.paidOrders} paid orders, {summary.checked.payments} payments, {summary.checked.refundedOrders} refunded orders and {summary.checked.ticketedOrders} ticketed orders
        {summary.checked.gatewayVerified ? `; ${summary.checked.gatewayVerified} payments confirmed directly with the gateways` : ''}.
      </p>
      <IssueList issues={summary.issues ?? []} />
    </div>
  );
}

export function ReconciliationTab() {
  const { brands, brandId, user } = useAuth();
  const toast = useToast();
  const lookup = (id: string | null) => brands.find((b) => b.id === id) ?? null;
  const [range, setRange] = useState(initialRange('30d'));
  const [brand, setBrand] = useState(brandId ?? '');
  const [verify, setVerify] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [viewing, setViewing] = useState<any | null>(null);
  const { run, loading } = useAction();
  const runs = usePaged<any>('/v1/admin/reconciliation/runs', undefined, { scoped: false, pageSize: 10 });

  const start = async () => {
    const res = await run(
      () => api.post('/v1/admin/reconciliation/run', { from: range.from, to: range.to, ...(brand ? { brandId: brand } : {}), ...(verify ? { verifyWithGateway: true } : {}) }),
      { onError: (e) => toast.error(e.message) },
    );
    if (res) {
      setResult(res);
      runs.reload();
    }
  };
  const columns: Column<any>[] = [
    { key: 'createdAt', header: 'Run at', render: (r) => <DateTime value={r.createdAt} /> },
    { key: 'period', header: 'Period', render: (r) => <span><DateTime value={r.periodStart} mode="date" /> to <DateTime value={r.periodEnd} mode="date" /></span> },
    { key: 'brand', header: 'Scope', render: (r) => (r.brandId ? <BrandChip brand={lookup(r.brandId)} /> : 'All brands in scope') },
    { key: 'issues', header: 'Result', render: (r) => (r.issueCount === 0 ? <Badge tone="green">All clear</Badge> : <Badge tone="red">{r.issueCount} issue{r.issueCount === 1 ? '' : 's'}</Badge>) },
  ];

  return (
    <div className="space-y-5">
      <Card title="Run reconciliation" description="Compares orders, payments, refunds, issued tickets, the ledger, gateway settlements and promoter payables. It only reports: nothing is changed.">
        <div className="flex flex-wrap items-end gap-3">
          <DateRange value={range} onChange={setRange} />
          {(user.allBrands || brands.length > 1) && <Select value={brand} onChange={setBrand} placeholder="All brands" options={brands.map((b) => ({ value: b.id, label: b.name }))} />}
          <Button loading={loading} onClick={start}>Run reconciliation</Button>
        </div>
        <div className="mt-3"><Checkbox checked={verify} onChange={setVerify} label="Also verify a sample of payments directly with the payment gateways" hint="Slower: each sampled payment is confirmed with its provider." /></div>
        {result && <div className="mt-5 border-t border-slate-100 pt-5"><RunSummary summary={result} /></div>}
      </Card>
      <Card padded={false} title="Previous runs">
        <DataTable columns={columns} rows={runs.items} loading={runs.loading} error={runs.error} onRetry={runs.reload} onRowClick={setViewing} empty={{ title: 'No reconciliation runs yet' }} />
        <Pagination page={runs.page} pages={runs.pages} total={runs.total} onPage={runs.setPage} />
      </Card>
      {viewing && (
        <Modal open onClose={() => setViewing(null)} size="lg" title="Reconciliation run" footer={<Button variant="secondary" onClick={() => setViewing(null)}>Close</Button>}>
          <RunSummary summary={viewing.summary} />
        </Modal>
      )}
    </div>
  );
}
