'use client';

import { Plus, RefreshCw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CopyField, CURRENCY_RE, Dot, Notice, useBrandLookup } from '@/components/platform/bits';
import {
  Badge, BrandChip, Button, Card, Checkbox, Column, ConfirmButton, DataTable, DateTime, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Pagination,
  SearchInput, Select, SelectInput, Skeleton, StatCard, StatusBadge, Tabs, Textarea, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize, number } from '@/lib/format';
import { useAction, useDebounced, usePaged, useQuery } from '@/lib/hooks';

// ───────────────────────── Overview ─────────────────────────

function OverviewTab() {
  const { data, loading, error, reload } = useQuery<any>('/v1/admin/integrations', undefined, { scoped: false });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton className="h-72" />;
  const accounts: any[] = data.payments.merchantAccounts ?? [];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card title="Email">
          <Dot ok={data.email.healthy} label={data.email.healthy ? 'SMTP reachable' : 'SMTP not reachable'} />
          <p className="mt-2 text-xs text-slate-500">{data.email.host}:{data.email.port} · {data.email.authenticated ? 'authenticated' : 'no authentication'}</p>
        </Card>
        <Card title="SMS">
          <Dot ok={data.sms.configured ? true : null} label={data.sms.configured ? 'Configured' : 'Not configured'} />
          <p className="mt-2 text-xs text-slate-500">{data.sms.provider}{!data.sms.configured && <>. Set {data.sms.requiredEnv.join(', ')} on the API. Until then SMS messages are recorded as skipped, never as sent.</>}</p>
        </Card>
        <Card title="WhatsApp">
          <Dot ok={data.whatsapp.configured ? true : null} label={data.whatsapp.configured ? 'Configured' : 'Not configured'} />
          <p className="mt-2 text-xs text-slate-500">{data.whatsapp.provider}{!data.whatsapp.configured && <>. Set {data.whatsapp.requiredEnv.join(', ')} on the API.</>}</p>
        </Card>
        <Card title="Storage and queues">
          <Dot ok={data.storage.ok} label={`Storage: ${data.storage.driver}`} />
          <div className="mt-1"><Dot ok={data.queue.mode === 'bullmq' ? data.queue.redisEnabled : null} label={`Queues: ${data.queue.mode === 'bullmq' ? 'Redis workers' : 'in-process'}`} /></div>
        </Card>
      </div>

      <Card title="Payment gateways" description="Each merchant account has its own webhook address. Paste it into that provider's dashboard so payment confirmations reach the platform.">
        <div className="mb-4 flex flex-wrap gap-2">
          {data.payments.providers.map((p: any) => (
            <Badge key={p.code} tone={p.enabled ? (p.isTestOnly ? 'amber' : 'green') : 'gray'}>{p.name}{p.isTestOnly ? '' : p.enabled ? ' · available' : ' · disabled'}</Badge>
          ))}
        </div>
        {accounts.length === 0 ? (
          <EmptyState title="No merchant accounts visible" description="Merchant accounts and their webhook addresses are shown to platform administrators." />
        ) : (
          <ul className="space-y-4">
            {accounts.map((a) => (
              <li key={a.id} className="rounded-lg border border-slate-200 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{a.label}</span>
                  <Badge tone={a.livemode ? 'green' : 'amber'}>{a.livemode ? 'Live' : 'Test'}</Badge>
                  {!a.active && <Badge tone="gray">Inactive</Badge>}
                  <span className="text-xs text-slate-500">{a.legalEntity?.name} · {a.currencies.join(', ')}</span>
                </div>
                {a.webhookUrl && <CopyField value={a.webhookUrl} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.errorsLast24h?.length > 0 && (
        <Card title="Integration errors in the last 24 hours">
          <ul className="space-y-1 text-sm text-slate-700">
            {data.errorsLast24h.map((e: any, i: number) => <li key={i}><span className="font-medium capitalize">{e.integration}</span>: {e.count ?? e._count ?? ''} error(s)</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── Payment accounts ─────────────────────────

const CRED_FIELDS: Record<string, { key: string; label: string; hint: string }[]> = {
  paystack: [{ key: 'secretKey', label: 'Secret key', hint: 'From the Paystack dashboard. Also used to verify webhook signatures.' }],
  flutterwave: [
    { key: 'secretKey', label: 'Secret key', hint: 'From the Flutterwave dashboard.' },
    { key: 'webhookHash', label: 'Webhook secret hash', hint: 'The secret hash you set under Webhooks in Flutterwave.' },
  ],
  sandbox: [{ key: 'webhookSecret', label: 'Webhook secret', hint: 'Any long random value. Test payments only.' }],
};

function AccountForm({ account, onClose, onDone }: { account?: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const providers = useQuery<any[]>('/v1/admin/payment-providers', undefined, { scoped: false });
  const entities = useQuery<any[]>('/v1/admin/legal-entities', undefined, { scoped: false });
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    providerCode: account?.providerCode ?? 'paystack', legalEntityId: account?.legalEntity?.id ?? '', label: account?.label ?? '', livemode: account?.livemode ?? false,
    currencies: (account?.currencies ?? ['KES']).join(', '), publicKey: account?.publicKey ?? '', merchantRef: account?.merchantRef ?? '', active: account?.active ?? true,
  });
  const [creds, setCreds] = useState<Record<string, string>>({});
  const fields = CRED_FIELDS[f.providerCode] ?? [];

  const submit = async () => {
    setError(null);
    const currencies = f.currencies.split(/[\s,]+/).map((c: string) => c.trim().toUpperCase()).filter(Boolean);
    if (!currencies.length || currencies.some((c: string) => !CURRENCY_RE.test(c))) return setError('Enter currencies as 3-letter codes separated by commas, for example KES, USD.');
    const filled = Object.fromEntries(fields.map((x) => [x.key, (creds[x.key] ?? '').trim()]).filter(([, v]) => v));
    const complete = fields.every((x) => filled[x.key]);
    if (!account && !complete) return setError('Enter every credential for this provider.');
    if (account && Object.keys(filled).length > 0 && !complete) return setError('To rotate credentials, enter all of them again.');
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const res = await run(
      () => account
        ? api.patch(`/v1/admin/payment-accounts/${account.id}`, { label: f.label.trim(), currencies, publicKey: opt(f.publicKey), merchantRef: opt(f.merchantRef), active: f.active, ...(complete ? { credentials: filled } : {}) })
        : api.post('/v1/admin/payment-accounts', { providerCode: f.providerCode, legalEntityId: f.legalEntityId, label: f.label.trim(), livemode: f.livemode, currencies, credentials: filled, publicKey: opt(f.publicKey), merchantRef: opt(f.merchantRef) }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(account ? 'Merchant account updated' : 'Merchant account created');
      onDone();
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={account ? `Edit ${account.label}` : 'New merchant account'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={f.label.trim().length < 2 || (!account && !f.legalEntityId)} onClick={submit}>{account ? 'Save changes' : 'Create account'}</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Payment provider">
          <SelectInput value={f.providerCode} disabled={!!account} onChange={(e) => { setF((s) => ({ ...s, providerCode: e.target.value, livemode: e.target.value === 'sandbox' ? false : s.livemode })); setCreds({}); }} options={(providers.data ?? []).filter((p) => p.enabled).map((p) => ({ value: p.code, label: p.name }))} />
        </Field>
        <Field label="Legal entity (merchant of record)" hint="The company that holds this account. It becomes the legal seller on orders paid through it.">
          <SelectInput value={f.legalEntityId} disabled={!!account} onChange={(e) => setF((s) => ({ ...s, legalEntityId: e.target.value }))} placeholder="Choose legal entity" options={(entities.data ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.country})` }))} />
        </Field>
        <Field label="Label"><Input value={f.label} onChange={(e) => setF((s) => ({ ...s, label: e.target.value }))} placeholder="Paystack - Company Ltd (KES)" /></Field>
        <Field label="Currencies"><Input value={f.currencies} onChange={(e) => setF((s) => ({ ...s, currencies: e.target.value }))} placeholder="KES, USD" /></Field>
        <Field label="Public key (optional)"><Input value={f.publicKey} onChange={(e) => setF((s) => ({ ...s, publicKey: e.target.value }))} /></Field>
        <Field label="Provider merchant ID (optional)"><Input value={f.merchantRef} onChange={(e) => setF((s) => ({ ...s, merchantRef: e.target.value }))} /></Field>
      </div>
      {!account && f.providerCode !== 'sandbox' && <Checkbox checked={f.livemode} onChange={(v) => setF((s) => ({ ...s, livemode: v }))} label="Live mode" hint="Tick only when using live keys. Live and test mode cannot be changed later." />}
      {account && <Checkbox checked={f.active} onChange={(v) => setF((s) => ({ ...s, active: v }))} label="Active" hint="Inactive accounts are not used for new payments." />}
      <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{account ? 'Rotate credentials (optional)' : 'Credentials'}</h3>
      {fields.map((x) => (
        <Field key={x.key} label={x.label} hint={x.hint}>
          <Input type="password" autoComplete="new-password" value={creds[x.key] ?? ''} onChange={(e) => setCreds((c) => ({ ...c, [x.key]: e.target.value }))} placeholder={account ? 'Leave blank to keep the current value' : ''} />
        </Field>
      ))}
      <Notice>Credentials are encrypted before they are stored and are never shown again, here or through the API. Linking a brand to this account is done on the brand's page and needs the provider's approval for that brand.</Notice>
      <FormError error={providers.error?.message ?? entities.error?.message ?? error} />
    </Modal>
  );
}

function AccountsTab() {
  const { data, loading, error, reload } = useQuery<any[]>('/v1/admin/payment-accounts', undefined, { scoped: false });
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const columns: Column<any>[] = [
    { key: 'label', header: 'Merchant account', render: (a) => <div><div className="font-medium text-slate-900">{a.label}</div><div className="text-xs capitalize text-slate-500">{a.providerCode}{a.merchantRef ? ` · ${a.merchantRef}` : ''}</div></div> },
    { key: 'entity', header: 'Legal entity', render: (a) => `${a.legalEntity.name} (${a.legalEntity.country})` },
    { key: 'mode', header: 'Mode', render: (a) => <Badge tone={a.livemode ? 'green' : 'amber'}>{a.livemode ? 'Live' : 'Test'}</Badge> },
    { key: 'currencies', header: 'Currencies', render: (a) => a.currencies.join(', ') },
    {
      key: 'brands', header: 'Linked brands',
      render: (a) => (
        <div className="max-w-[18rem] space-y-0.5">
          {a.brandConfigs.filter((c: any) => c.active).map((c: any) => (
            <div key={c.id} className="flex items-center gap-1.5 text-sm"><span className="truncate">{c.brand.name}</span>{!c.providerApproved && <Badge tone="amber">not approved</Badge>}</div>
          ))}
          {!a.brandConfigs.some((c: any) => c.active) && <span className="text-slate-400">None</span>}
        </div>
      ),
    },
    { key: 'active', header: 'Status', render: (a) => <Badge tone={a.active ? 'green' : 'gray'}>{a.active ? 'Active' : 'Inactive'}</Badge> },
  ];
  return (
    <Card padded={false} title="Merchant accounts" description="Accounts held with payment providers. A brand can only take payments through an account it is linked to and approved for." actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>New account</Button>}>
      <DataTable columns={columns} rows={data ?? []} loading={loading} error={error} onRetry={reload} onRowClick={setEditing} empty={{ title: 'No merchant accounts', description: 'Add a Paystack or Flutterwave account to start taking payments.' }} />
      {editing && <AccountForm account={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

// ───────────────────────── Notification templates ─────────────────────────

function TemplateEditor({ row, brandId, brandName, onClose, onDone }: { row: any; brandId: string; brandName: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can, user } = useAuth();
  const canPlatform = can('integrations.manage') && user.allBrands;
  const canBrand = can('brands.manage');
  const [target, setTarget] = useState<'brand' | 'platform'>(row.brandOverride || !canPlatform ? 'brand' : 'platform');
  const source = target === 'brand' ? (row.brandOverride ?? row.platform) : row.platform;
  const [subject, setSubject] = useState<string>(source?.subject ?? '');
  const [body, setBody] = useState<string>((row.channel === 'EMAIL' ? source?.bodyHtml : (source?.bodyText ?? source?.bodyHtml)) ?? '');
  const [preview, setPreview] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const editable = target === 'brand' ? canBrand : canPlatform;

  const loadPreview = () => api.post('/v1/admin/notifications/templates/preview', { brandId, type: row.type, channel: row.channel }).then(setPreview).catch((e) => setError(e.message));
  useEffect(() => {
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const switchTarget = (t: 'brand' | 'platform') => {
    const s = t === 'brand' ? (row.brandOverride ?? row.platform) : row.platform;
    setTarget(t);
    setSubject(s?.subject ?? '');
    setBody((row.channel === 'EMAIL' ? s?.bodyHtml : (s?.bodyText ?? s?.bodyHtml)) ?? '');
  };
  const path = target === 'brand' ? `/v1/admin/notifications/templates/brand/${brandId}/${row.type}/${row.channel}` : `/v1/admin/notifications/templates/platform/${row.type}/${row.channel}`;
  const save = async () => {
    setError(null);
    const res = await run(() => api.put(path, { subject: subject.trim(), bodyHtml: body, ...(row.channel !== 'EMAIL' ? { bodyText: body } : {}) }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(target === 'brand' ? `Saved for ${brandName}` : 'Platform default saved');
      onDone();
      await loadPreview();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${humanize(row.type)} · ${humanize(row.channel)}`}
      footer={
        <>
          {row.brandOverride && canBrand && (
            <ConfirmButton
              label="Remove brand override" variant="ghost" title="Remove this brand's override?" confirmLabel="Remove" body={`${brandName} will go back to using the platform default.`}
              onConfirm={() => api.delete(`/v1/admin/notifications/templates/brand/${brandId}/${row.type}/${row.channel}`).then(() => { toast.success('Override removed'); onDone(); onClose(); })}
            />
          )}
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {editable && <Button loading={loading} disabled={!subject.trim() || !body.trim()} onClick={save}>Save and refresh preview</Button>}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={target} onChange={(v) => switchTarget(v as 'brand' | 'platform')} options={[{ value: 'brand', label: `Override for ${brandName}` }, { value: 'platform', label: 'Platform default (all brands)' }]} />
        <span className="text-xs text-slate-500">In effect for {brandName}: {row.inEffect === 'brand' ? 'brand override' : 'platform default'}</span>
      </div>
      {!editable && <Notice>{target === 'platform' ? 'Only platform administrators can change the default template.' : 'You do not have permission to change brand templates.'}</Notice>}
      <Field label="Subject"><Input value={subject} disabled={!editable} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label={row.channel === 'EMAIL' ? 'Body (HTML with {{variables}})' : 'Message text'} hint={row.sampleVariables?.length ? `Variables: ${row.sampleVariables.map((v: string) => `{{${v}}}`).join(' ')} and {{brand.name}}. The brand's logo, colours and contact footer are added automatically.` : undefined}>
        <Textarea value={body} disabled={!editable} onChange={(e) => setBody(e.target.value)} rows={row.channel === 'EMAIL' ? 9 : 4} className="font-mono text-xs" spellCheck={false} />
      </Field>
      <FormError error={error} />
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Preview as {brandName}</h3>
          <span className="text-xs text-slate-500">Shows the saved template with sample data</span>
        </div>
        {!preview ? <Skeleton className="h-48" /> : (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <div className="space-y-0.5 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <div><span className="text-slate-400">From:</span> {preview.from}</div>
              <div><span className="text-slate-400">Subject:</span> {preview.subject}</div>
            </div>
            {row.channel === 'EMAIL'
              ? <iframe title="Template preview" sandbox="" srcDoc={preview.html} className="h-96 w-full bg-white" />
              : <p className="whitespace-pre-wrap px-3 py-3 text-sm text-slate-800">{preview.text}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function BrandPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { brands } = useAuth();
  return <Select value={value} onChange={onChange} options={brands.map((b) => ({ value: b.id, label: b.name }))} />;
}

function useBrandChoice() {
  const { brands, brandId } = useAuth();
  const [chosen, setChosen] = useState(brandId ?? brands[0]?.id ?? '');
  useEffect(() => {
    if (brandId) setChosen(brandId);
  }, [brandId]);
  return [chosen, setChosen, brands.find((b) => b.id === chosen)?.name ?? ''] as const;
}

function TemplatesTab() {
  const [brandId, setBrandId, brandName] = useBrandChoice();
  const { data, loading, error, reload } = useQuery<any[]>(brandId ? '/v1/admin/notifications/templates' : null, { brandId }, { scoped: false });
  const [editing, setEditing] = useState<any | null>(null);
  const columns: Column<any>[] = [
    { key: 'type', header: 'Notification', render: (t) => <span className="font-medium text-slate-900">{humanize(t.type)}</span> },
    { key: 'channel', header: 'Channel', render: (t) => humanize(t.channel) },
    { key: 'subject', header: 'Subject', render: (t) => <span className="block max-w-[26rem] truncate text-slate-600">{(t.brandOverride ?? t.platform)?.subject ?? '-'}</span> },
    { key: 'inEffect', header: 'In effect', render: (t) => <Badge tone={t.inEffect === 'brand' ? 'indigo' : 'gray'}>{t.inEffect === 'brand' ? 'Brand override' : t.inEffect === 'platform' ? 'Platform default' : humanize(t.inEffect)}</Badge> },
    { key: 'updated', header: 'Updated', render: (t) => <DateTime value={(t.brandOverride ?? t.platform)?.updatedAt} mode="date" /> },
  ];
  if (!brandId) return <Card><EmptyState title="No brand available" /></Card>;
  return (
    <Card padded={false} title="Notification templates" description="Every message is sent with the originating brand's logo, colours, sender and contact details. A brand override replaces the platform wording for that brand only." actions={<BrandPicker value={brandId} onChange={setBrandId} />}>
      <DataTable columns={columns} rows={data ?? []} loading={loading} error={error} onRetry={reload} onRowClick={setEditing} rowKey={(t) => `${t.type}-${t.channel}`} empty={{ title: 'No templates' }} />
      {editing && <TemplateEditor key={`${editing.type}-${editing.channel}-${brandId}`} row={editing} brandId={brandId} brandName={brandName} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

// ───────────────────────── Delivery ─────────────────────────

const JOB_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'];

function DeliveryTab() {
  const { can } = useAuth();
  const toast = useToast();
  const brand = useBrandLookup();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [channel, setChannel] = useState('');
  const summary = useQuery<any>('/v1/admin/notifications/summary');
  const list = usePaged<any>('/v1/admin/notifications/jobs', { q: useDebounced(q), status, type, channel });
  const { run, loading } = useAction();
  const retry = async (id: string) => {
    const res = await run(() => api.post(`/v1/admin/notifications/jobs/${id}/retry`), { onError: (e) => toast.error(e.message) });
    if (res !== undefined) {
      toast.success('Queued for another attempt');
      list.reload();
      summary.reload();
    }
  };
  const types: string[] = [...new Set<string>((summary.data?.byType ?? []).map((t: any) => t.type))].sort();
  const s = summary.data;
  const columns: Column<any>[] = [
    { key: 'createdAt', header: 'Queued', render: (j) => <DateTime value={j.createdAt} /> },
    { key: 'brand', header: 'Brand', render: (j) => <BrandChip brand={brand(j.brandId)} /> },
    { key: 'type', header: 'Notification', render: (j) => <div><div className="text-slate-900">{humanize(j.type)}</div><div className="text-xs text-slate-500">{humanize(j.channel)}</div></div> },
    { key: 'to', header: 'Recipient', render: (j) => <span className="block max-w-[16rem] truncate">{j.toAddress}</span> },
    { key: 'status', header: 'Status', render: (j) => <div><StatusBadge status={j.status} />{j.lastError && <div className="mt-1 max-w-[18rem] whitespace-normal text-xs text-red-600">{j.lastError}</div>}</div> },
    { key: 'attempts', header: 'Attempts', align: 'right', render: (j) => `${j.attempts} / ${j.maxAttempts}` },
    { key: 'sentAt', header: 'Sent', render: (j) => <DateTime value={j.sentAt} /> },
    { key: 'actions', header: '', align: 'right', render: (j) => ['FAILED', 'SKIPPED'].includes(j.status) && can('integrations.manage') && <Button size="sm" variant="secondary" loading={loading} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => retry(j.id)}>Retry</Button> },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Sent" value={s ? number(s.sent) : '-'} tone="good" />
        <StatCard label="Queued" value={s ? number(s.queued) : '-'} hint="Waiting for delivery or retry" />
        <StatCard label="Failed" value={s ? number(s.failed) : '-'} tone={s?.failed ? 'bad' : 'default'} hint="Gave up after all retries" />
        <StatCard label="Skipped" value={s ? number(s.skipped) : '-'} hint="No consent, or channel not configured" />
      </div>
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Recipient address" />
          <Select value={status} onChange={setStatus} placeholder="Any status" options={JOB_STATUSES.map((x) => ({ value: x, label: humanize(x) }))} />
          <Select value={type} onChange={setType} placeholder="Any notification" options={types.map((x) => ({ value: x, label: humanize(x) }))} />
          <Select value={channel} onChange={setChannel} placeholder="Any channel" options={['EMAIL', 'SMS', 'WHATSAPP'].map((x) => ({ value: x, label: humanize(x) }))} />
        </Toolbar>
        <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No notifications match' }} />
        <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      </Card>
    </div>
  );
}

// ───────────────────────── Sender domains ─────────────────────────

function DomainsTab() {
  const [brandId, setBrandId, brandName] = useBrandChoice();
  const { data, loading, error, reload } = useQuery<any>(brandId ? `/v1/admin/notifications/dns-guidance/${brandId}` : null, undefined, { scoped: false });
  if (!brandId) return <Card><EmptyState title="No brand available" /></Card>;
  const live = (purpose: string) => (purpose === 'SPF' ? data.current.spf : purpose === 'DMARC' ? data.current.dmarc : null);
  return (
    <Card
      title="Sender domain authentication"
      description="Publish these DNS records for each brand's sending domain so its emails are trusted and not marked as spam."
      actions={<><BrandPicker value={brandId} onChange={setBrandId} /><Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reload}>Check again</Button></>}
    >
      {error ? <ErrorState error={error} onRetry={reload} /> : loading || !data ? <Skeleton className="h-64" /> : (
        <div className="space-y-5">
          <p className="text-sm text-slate-600">{brandName} sends from <strong>{data.senderAddress}</strong>. Records below are for <strong>{data.domain}</strong>.</p>
          {data.records.map((r: any) => {
            const cur = live(r.purpose);
            return (
              <div key={r.purpose} className="rounded-lg border border-slate-200 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{r.purpose}</span>
                  <Badge tone="gray">{r.type}</Badge>
                  {cur ? <Badge tone={cur.present && !cur.problem ? 'green' : cur.present ? 'amber' : 'red'}>{cur.present ? 'Record found' : 'Not published yet'}</Badge> : <Badge tone="gray">Not checked automatically</Badge>}
                </div>
                <div className="space-y-2">
                  <div><div className="mb-1 text-xs font-medium text-slate-500">Host</div><CopyField value={r.host} /></div>
                  <div><div className="mb-1 text-xs font-medium text-slate-500">Value</div><CopyField value={r.value} /></div>
                </div>
                <p className="mt-3 text-sm text-slate-600">{r.explanation}</p>
                {!r.configured && r.purpose !== 'DMARC' && <p className="mt-1 text-xs text-amber-700">Replace the placeholder with the value supplied by your email provider.</p>}
                {cur?.problem && <p className="mt-2 text-sm text-red-600">{cur.problem}</p>}
                {cur?.records?.length > 0 && <p className="mt-2 break-all font-mono text-xs text-slate-500">Currently published: {cur.records.join(' | ')}</p>}
                {r.purpose === 'DKIM' && <p className="mt-2 text-xs text-slate-500">{data.current.dkim.note}</p>}
              </div>
            );
          })}
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">{data.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
          <p className="text-xs text-slate-400">Checked <DateTime value={data.current.checkedAt} mode="relative" />. DNS changes can take up to 48 hours to appear.</p>
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── Integration logs ─────────────────────────

function LogsTab() {
  const brand = useBrandLookup();
  const [integration, setIntegration] = useState('');
  const [status, setStatus] = useState('');
  const list = usePaged<any>('/v1/admin/integration-logs', { integration, status }, { scoped: false });
  const columns: Column<any>[] = [
    { key: 'createdAt', header: 'Time', render: (l) => <DateTime value={l.createdAt} /> },
    { key: 'integration', header: 'Integration', render: (l) => <span className="capitalize">{l.integration}</span> },
    { key: 'direction', header: 'Direction', render: (l) => humanize(l.direction) },
    { key: 'operation', header: 'Operation', render: (l) => humanize(l.operation) },
    { key: 'status', header: 'Result', render: (l) => <Badge tone={l.status === 'OK' ? 'green' : 'red'}>{l.status === 'OK' ? 'OK' : 'Error'}</Badge> },
    { key: 'reference', header: 'Reference', render: (l) => <span className="font-mono text-xs">{l.reference ?? '-'}</span> },
    { key: 'brand', header: 'Brand', render: (l) => <BrandChip brand={brand(l.brandId)} /> },
    { key: 'duration', header: 'Duration', align: 'right', render: (l) => (l.durationMs === null ? '-' : `${l.durationMs} ms`) },
    { key: 'error', header: 'Error', render: (l) => <span className="block max-w-[22rem] truncate text-red-600" title={l.error ?? ''}>{l.error ?? ''}</span> },
  ];
  return (
    <Card padded={false} title="Integration logs" description="Calls to and from payment gateways and messaging providers.">
      <Toolbar>
        <Select value={integration} onChange={setIntegration} placeholder="All integrations" options={['paystack', 'flutterwave', 'sandbox', 'smtp', 'sms', 'whatsapp', 'storage'].map((x) => ({ value: x, label: humanize(x) }))} />
        <Select value={status} onChange={setStatus} placeholder="Any result" options={[{ value: 'OK', label: 'OK' }, { value: 'ERROR', label: 'Error' }]} />
      </Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No integration activity recorded' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

export default function IntegrationsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, user } = useAuth();
  const tabs = [
    { id: 'overview', label: 'Overview', show: can('integrations.read') },
    { id: 'accounts', label: 'Payment accounts', show: can('brands.payment_config') && user.allBrands },
    { id: 'templates', label: 'Notification templates', show: can('integrations.read') },
    { id: 'delivery', label: 'Email delivery', show: can('integrations.read') },
    { id: 'domains', label: 'Sender domains', show: can('brands.read') },
    { id: 'logs', label: 'Integration logs', show: can('integrations.read') && user.allBrands },
  ].filter((t) => t.show);
  const active = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id;
  return (
    <>
      <PageHeader title="Integrations" description="Payment gateways, email, SMS and WhatsApp delivery, branded notification templates and sender domain set-up." />
      {!tabs.length ? <EmptyState title="Nothing here for your role" /> : (
        <>
          <Tabs tabs={tabs} active={active} onChange={(id) => router.replace(`/integrations?tab=${id}`)} />
          {active === 'overview' && <OverviewTab />}
          {active === 'accounts' && <AccountsTab />}
          {active === 'templates' && <TemplatesTab />}
          {active === 'delivery' && <DeliveryTab />}
          {active === 'domains' && <DomainsTab />}
          {active === 'logs' && <LogsTab />}
        </>
      )}
    </>
  );
}
