'use client';

import { Check, Copy, KeyRound, Plus, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, Checkbox, Column, ConfirmButton, DataTable, DateTime, ErrorState, Field, FormError, Input, KeyValue, Modal, PageHeader, SelectInput, Skeleton,
  StatusBadge, Tabs, Textarea, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function CopyBox({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable: the value stays selectable */
    }
  };
  return (
    <div>
      {label && <div className="mb-1 text-xs font-medium text-slate-500">{label}</div>}
      <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-slate-100">{value}</code>
        <button onClick={copy} aria-label="Copy" className="shrink-0 rounded p-1 text-slate-300 hover:bg-slate-700 hover:text-white">
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── Profile ─────────────────────────

function ProfileTab({ brand, canEdit, onSaved }: { brand: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const { reloadUser } = useAuth();
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const init = () => ({
    name: brand.name ?? '', logoUrl: brand.logoUrl ?? '', primaryColor: brand.primaryColor, secondaryColor: brand.secondaryColor, contactEmail: brand.contactEmail ?? '',
    supportPhone: brand.supportPhone ?? '', supportUrl: brand.supportUrl ?? '', businessAddress: brand.businessAddress ?? '', emailSenderName: brand.emailSenderName ?? '',
    emailSenderAddr: brand.emailSenderAddr ?? '', defaultCurrency: brand.defaultCurrency, currencies: (brand.currencies ?? []).join(', '), timezone: brand.timezone ?? '',
    enabledPaymentMethods: (brand.enabledPaymentMethods ?? []).join(', '), reservationTtlMinutes: String(Math.round((brand.reservationTtlSeconds ?? 900) / 60)),
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [brand.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof ReturnType<typeof init>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const currencies = csv(f.currencies.toUpperCase());
    const defaultCurrency = f.defaultCurrency.toUpperCase();
    if (!currencies.includes(defaultCurrency)) return setError('The default currency must be one of the selling currencies.');
    const ttl = Number(f.reservationTtlMinutes);
    if (!Number.isInteger(ttl) || ttl < 2 || ttl > 60) return setError('Reservation time must be between 2 and 60 minutes.');
    const body: Record<string, unknown> = {
      name: f.name.trim(), primaryColor: f.primaryColor, secondaryColor: f.secondaryColor, contactEmail: f.contactEmail.trim(), emailSenderName: f.emailSenderName.trim(),
      emailSenderAddr: f.emailSenderAddr.trim(), defaultCurrency, currencies, enabledPaymentMethods: csv(f.enabledPaymentMethods), reservationTtlSeconds: ttl * 60,
      logoUrl: f.logoUrl.trim(), supportPhone: f.supportPhone.trim(), supportUrl: f.supportUrl.trim(), businessAddress: f.businessAddress.trim(),
    };
    if (f.timezone.trim()) body.timezone = f.timezone.trim();
    const ok = await run(() => api.patch(`/v1/admin/brands/${brand.id}`, body), { onError: (er) => setError(er.message) });
    if (ok) {
      toast.success('Brand profile saved');
      onSaved();
      void reloadUser();
    }
  };

  return (
    <form onSubmit={save} className="grid gap-5 xl:grid-cols-3">
      <div className="space-y-5 xl:col-span-2">
        <Card title="Identity" description="How this storefront appears to customers and in emails">
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand name"><Input required minLength={2} value={f.name} onChange={set('name')} /></Field>
            <Field label="Logo URL" hint="Shown in emails. Leave empty to use the brand name."><Input value={f.logoUrl} onChange={set('logoUrl')} placeholder="https://" /></Field>
            <Field label="Primary colour">
              <div className="flex gap-2"><Input type="color" value={f.primaryColor} onChange={set('primaryColor')} className="w-14 p-1" /><Input value={f.primaryColor} onChange={set('primaryColor')} pattern="#[0-9a-fA-F]{6}" className="font-mono" /></div>
            </Field>
            <Field label="Secondary colour">
              <div className="flex gap-2"><Input type="color" value={f.secondaryColor} onChange={set('secondaryColor')} className="w-14 p-1" /><Input value={f.secondaryColor} onChange={set('secondaryColor')} pattern="#[0-9a-fA-F]{6}" className="font-mono" /></div>
            </Field>
          </fieldset>
        </Card>
        <Card title="Contact and email sender" description="Used on tickets, emails and customer support replies">
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer contact email"><Input type="email" required value={f.contactEmail} onChange={set('contactEmail')} /></Field>
            <Field label="Support phone"><Input value={f.supportPhone} onChange={set('supportPhone')} /></Field>
            <Field label="Support page URL"><Input value={f.supportUrl} onChange={set('supportUrl')} placeholder="https://" /></Field>
            <Field label="Time zone" hint="IANA name, for example Africa/Nairobi"><Input value={f.timezone} onChange={set('timezone')} /></Field>
            <Field label="Email sender name"><Input required minLength={2} value={f.emailSenderName} onChange={set('emailSenderName')} /></Field>
            <Field label="Email sender address" hint="Its domain needs SPF, DKIM and DMARC records (see Integrations)."><Input type="email" required value={f.emailSenderAddr} onChange={set('emailSenderAddr')} /></Field>
            <Field label="Business address" className="sm:col-span-2"><Textarea value={f.businessAddress} onChange={set('businessAddress')} /></Field>
          </fieldset>
        </Card>
        <Card title="Selling" description="Currencies, payment methods and checkout reservation time">
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Selling currencies" hint="Comma-separated ISO codes. Each needs an approved payment configuration."><Input required value={f.currencies} onChange={set('currencies')} className="uppercase" /></Field>
            <Field label="Default currency"><Input required maxLength={3} value={f.defaultCurrency} onChange={set('defaultCurrency')} className="uppercase" /></Field>
            <Field label="Payment methods offered" hint="Comma-separated, for example card, mobile_money"><Input value={f.enabledPaymentMethods} onChange={set('enabledPaymentMethods')} /></Field>
            <Field label="Checkout reservation (minutes)" hint="How long tickets are held while a customer pays."><Input type="number" min={2} max={60} required value={f.reservationTtlMinutes} onChange={set('reservationTtlMinutes')} /></Field>
          </fieldset>
        </Card>
        <FormError error={error} />
        {canEdit && <div className="flex justify-end"><Button type="submit" loading={loading}>Save changes</Button></div>}
      </div>
      <div className="space-y-5">
        <Card title="Email preview" description="Header of emails sent for this brand" padded={false}>
          <div className="px-5 py-5" style={{ background: f.primaryColor }}>
            {f.logoUrl ? <img src={f.logoUrl} alt={f.name} className="h-9 max-w-full object-contain" /> : <span className="text-xl font-bold text-white">{f.name || 'Brand name'}</span>}
          </div>
          <div className="h-1" style={{ background: f.secondaryColor }} />
          <div className="space-y-1 px-5 py-4 text-sm text-slate-600">
            <p>From: <span className="text-slate-900">{f.emailSenderName} &lt;{f.emailSenderAddr}&gt;</span></p>
            <p>Help: <span className="text-slate-900">{f.contactEmail}</span>{f.supportPhone && ` · ${f.supportPhone}`}</p>
          </div>
        </Card>
        <Card title="Record">
          <KeyValue columns={1} items={[
            { label: 'Brand ID', value: <span className="font-mono text-xs">{brand.id}</span> },
            { label: 'Identifier', value: <span className="font-mono text-xs">{brand.slug}</span> },
            { label: 'Created', value: <DateTime value={brand.createdAt} /> },
            { label: 'Last updated', value: <DateTime value={brand.updatedAt} /> },
          ]} />
        </Card>
      </div>
    </form>
  );
}

// ───────────────────────── Domains ─────────────────────────

function DomainsTab({ brand, platform, reload }: { brand: any; platform: boolean; reload: () => void }) {
  const toast = useToast();
  const { run, loading } = useAction();
  const [domain, setDomain] = useState('');
  const [primary, setPrimary] = useState(brand.domains.length === 0);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const ok = await run(() => api.post(`/v1/admin/brands/${brand.id}/domains`, { domain: domain.trim().toLowerCase(), isPrimary: primary }), { onError: (er) => setError(er.message) });
    if (ok) {
      toast.success('Domain added. Publish the TXT record, then verify it.');
      setDomain('');
      reload();
    }
  };
  const verify = async (id: string, manual: boolean) => {
    const ok = await run(() => api.post(`/v1/admin/domains/${id}/verify`, manual ? { manual: true } : {}), { onError: (er) => toast.error(er.message) });
    if (ok) {
      toast.success('Domain verified');
      reload();
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Storefront domains" description="The platform identifies the originating brand from its API key and verified domain. A brand ID sent by a browser is never trusted.">
        {!brand.domains.length && <p className="text-sm text-slate-500">No domains yet. The storefront cannot call the API until a domain is added and verified.</p>}
        <ul className="space-y-4">
          {brand.domains.map((d: any) => (
            <li key={d.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium text-slate-900">{d.domain}</span>
                  {d.isPrimary && <Badge tone="indigo">primary</Badge>}
                  {d.verifiedAt ? <Badge tone="green">verified</Badge> : <Badge tone="amber">not verified</Badge>}
                </div>
                {platform && (
                  <div className="flex flex-wrap gap-2">
                    {!d.verifiedAt && <Button size="sm" loading={loading} onClick={() => verify(d.id, false)}>Check DNS record</Button>}
                    {!d.verifiedAt && (
                      <ConfirmButton
                        size="sm" label="Confirm manually" title="Confirm ownership without DNS?" confirmLabel="Mark as verified"
                        body="Only do this when ownership has been confirmed another way, for example for a local development domain. The action is recorded in the audit log."
                        onConfirm={() => api.post(`/v1/admin/domains/${d.id}/verify`, { manual: true }).then(() => { toast.success('Domain verified'); reload(); })}
                      />
                    )}
                    <ConfirmButton
                      size="sm" variant="danger" label="Remove" title={`Remove ${d.domain}?`} confirmLabel="Remove domain"
                      body="Requests from this domain will be refused immediately."
                      onConfirm={() => api.delete(`/v1/admin/domains/${d.id}`).then(() => { toast.success('Domain removed'); reload(); })}
                    />
                  </div>
                )}
              </div>
              {d.verifiedAt ? (
                <p className="mt-2 text-xs text-slate-500">Verified <DateTime value={d.verifiedAt} /></p>
              ) : d.verificationRecord && (
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_2fr]">
                  <CopyBox label="DNS host" value={d.verificationRecord.host} />
                  <div><div className="mb-1 text-xs font-medium text-slate-500">Type</div><div className="rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs">{d.verificationRecord.type}</div></div>
                  <CopyBox label="Value" value={d.verificationRecord.value} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {platform && (
        <Card title="Add a domain">
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <Field label="Domain" hint="Host only, for example tickets.example.com" className="w-full sm:w-80">
              <Input required value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="tickets.example.com" />
            </Field>
            <div className="pb-2"><Checkbox checked={primary} onChange={setPrimary} label="Primary domain" /></div>
            <Button type="submit" loading={loading} icon={<Plus className="h-4 w-4" />}>Add domain</Button>
          </form>
          <div className="mt-3"><FormError error={error} /></div>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── API keys ─────────────────────────

function KeysTab({ brand, platform, reload }: { brand: any; platform: boolean; reload: () => void }) {
  const toast = useToast();
  const { run, loading } = useAction();
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<{ key: string; label: string } | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await run(() => api.post(`/v1/admin/brands/${brand.id}/api-keys`, { label: label.trim() }), { onError: (er) => toast.error(er.message) });
    if (res) {
      setIssued(res);
      setLabel('');
      reload();
    }
  };
  const columns: Column<any>[] = [
    { key: 'label', header: 'Label', render: (k) => <span className="font-medium text-slate-900">{k.label}</span> },
    { key: 'prefix', header: 'Key', render: (k) => <span className="font-mono text-xs">{k.keyPrefix}…</span> },
    { key: 'created', header: 'Created', render: (k) => <DateTime value={k.createdAt} /> },
    { key: 'used', header: 'Last used', render: (k) => (k.lastUsedAt ? <DateTime value={k.lastUsedAt} mode="relative" /> : <span className="text-slate-400">Never</span>) },
    { key: 'status', header: 'Status', render: (k) => (k.revokedAt ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>) },
    {
      key: 'actions', header: '', align: 'right',
      render: (k) => platform && !k.revokedAt && (
        <ConfirmButton
          size="sm" variant="danger" label="Revoke" title={`Revoke "${k.label}"?`} confirmLabel="Revoke key"
          body="Any storefront still using this key will stop working immediately. This cannot be undone."
          onConfirm={() => api.delete(`/v1/admin/api-keys/${k.id}`).then(() => { toast.success('Key revoked'); reload(); })}
        />
      ),
    },
  ];
  return (
    <div className="space-y-5">
      <Card title="Storefront API keys" description="Server-side secrets the storefront sends in X-Storefront-Key. The brand is derived from the key." padded={false}>
        <DataTable columns={columns} rows={brand.apiKeys} empty={{ title: 'No API keys', description: 'Create a key for the storefront server.' }} />
      </Card>
      {platform && (
        <Card title="Create a key">
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field label="Label" hint="Where the key is used, for example Production storefront" className="w-full sm:w-80">
              <Input required minLength={2} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Button type="submit" loading={loading} icon={<KeyRound className="h-4 w-4" />}>Create key</Button>
          </form>
        </Card>
      )}
      <Modal open={!!issued} onClose={() => setIssued(null)} title="Copy this key now" footer={<Button onClick={() => setIssued(null)}>I have stored it safely</Button>}>
        <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>This is the only time the full key for <strong>{issued?.label}</strong> is shown. Only a hash is stored. Keep it in the storefront server&apos;s secret configuration and never in browser code.</span>
        </div>
        {issued && <CopyBox value={issued.key} label="Storefront API key" />}
      </Modal>
    </div>
  );
}

// ───────────────────────── Policies ─────────────────────────

const POLICY_TYPES = [{ type: 'TERMS', label: 'Terms and conditions' }, { type: 'REFUND', label: 'Refund policy' }, { type: 'PRIVACY', label: 'Privacy policy' }];

function PoliciesTab({ brand, canEdit, reload }: { brand: any; canEdit: boolean; reload: () => void }) {
  const toast = useToast();
  const { run, loading } = useAction();
  const [editing, setEditing] = useState<{ type: string; label: string } | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  const publish = async () => {
    setError(null);
    const res = await run(() => api.post(`/v1/admin/brands/${brand.id}/policies`, { type: editing!.type, content: content.trim() }), { onError: (er) => setError(er.message) });
    if (res) {
      toast.success(`${editing!.label} version ${res.version} published`);
      setEditing(null);
      reload();
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      {POLICY_TYPES.map((p) => {
        const versions = brand.policies.filter((x: any) => x.type === p.type);
        const current = versions[0];
        return (
          <Card
            key={p.type} title={p.label}
            description={current ? `Version ${current.version}` : 'Not published'}
            actions={canEdit && <Button size="sm" variant="secondary" onClick={() => { setEditing(p); setContent(current?.content ?? ''); setError(null); }}>Publish new version</Button>}
          >
            {current ? (
              <>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-slate-700">{current.content}</p>
                <p className="mt-3 text-xs text-slate-500">Published <DateTime value={current.publishedAt} /></p>
                {versions.length > 1 && (
                  <button onClick={() => setHistory(history === p.type ? null : p.type)} className="mt-2 text-xs font-medium text-accent-700 hover:underline">
                    {history === p.type ? 'Hide' : 'Show'} {versions.length - 1} earlier version{versions.length === 2 ? '' : 's'}
                  </button>
                )}
                {history === p.type && (
                  <ul className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                    {versions.slice(1).map((v: any) => (
                      <li key={v.id}>
                        <div className="text-xs font-medium text-slate-700">Version {v.version} · <DateTime value={v.publishedAt} mode="date" /></div>
                        <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-slate-500">{v.content}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : <p className="text-sm text-slate-500">No version has been published for this brand.</p>}
          </Card>
        );
      })}
      <Modal
        open={!!editing} onClose={() => setEditing(null)} title={`Publish ${editing?.label ?? ''}`} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={loading} disabled={content.trim().length < 10} onClick={publish}>Publish version</Button></>}
      >
        <p className="text-sm text-slate-600">Publishing creates a new version. Existing orders keep the version the customer accepted at checkout; new orders record this one.</p>
        <Field label="Policy text"><Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[16rem]" /></Field>
        <FormError error={error} />
      </Modal>
    </div>
  );
}

// ───────────────────────── Payments ─────────────────────────

function PaymentsTab({ brand, reload }: { brand: any; reload: () => void }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const manage = user.allBrands && can('brands.payment_config');
  const accounts = useQuery<any[]>(manage ? '/v1/admin/payment-accounts' : null, undefined, { scoped: false });
  const entities = useQuery<any[]>(manage ? '/v1/admin/legal-entities' : null, undefined, { scoped: false });
  const { run, loading } = useAction();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ providerAccountId: '', currencies: '', priority: '100', providerApproved: false, approvalNote: '' });
  const [entity, setEntity] = useState('');
  const account = accounts.data?.find((a) => a.id === f.providerAccountId);

  const openFor = (cfg?: any) => {
    setError(null);
    setF(cfg
      ? { providerAccountId: cfg.providerAccountId, currencies: cfg.currencies.join(', '), priority: String(cfg.priority), providerApproved: cfg.providerApproved, approvalNote: cfg.approvalNote ?? '' }
      : { providerAccountId: '', currencies: '', priority: '100', providerApproved: false, approvalNote: '' });
    setOpen(true);
  };
  const save = async () => {
    setError(null);
    const res = await run(
      () => api.post(`/v1/admin/brands/${brand.id}/payment-configs`, {
        providerAccountId: f.providerAccountId, currencies: csv(f.currencies.toUpperCase()), priority: Number(f.priority) || 100, providerApproved: f.providerApproved,
        approvalNote: f.approvalNote.trim() || undefined, active: true,
      }),
      { onError: (er) => setError(er.message) },
    );
    if (res) {
      toast.success('Payment configuration saved');
      setOpen(false);
      reload();
    }
  };
  const assign = async (isDefault: boolean, legalEntityId = entity) => {
    const res = await run(() => api.post(`/v1/admin/brands/${brand.id}/legal-entities`, { legalEntityId, isDefault }), { onError: (er) => toast.error(er.message) });
    if (res) {
      toast.success(isDefault ? 'Default legal seller updated' : 'Legal entity linked');
      setEntity('');
      reload();
    }
  };

  const columns: Column<any>[] = [
    { key: 'account', header: 'Merchant account', render: (c) => <div><div className="font-medium text-slate-900">{c.providerAccount.label}</div><div className="text-xs capitalize text-slate-500">{c.providerAccount.providerCode}{!c.providerAccount.livemode && ' · test mode'}</div></div> },
    { key: 'seller', header: 'Legal seller', render: (c) => `${c.providerAccount.legalEntity.name} (${c.providerAccount.legalEntity.country})` },
    { key: 'currencies', header: 'Currencies', render: (c) => c.currencies.join(', ') },
    { key: 'priority', header: 'Priority', align: 'right', render: (c) => c.priority },
    { key: 'approved', header: 'Provider approval', render: (c) => <div className="max-w-[18rem]">{c.providerApproved ? <Badge tone="green">attested</Badge> : <Badge tone="red">not approved</Badge>}{c.approvalNote && <div className="mt-1 truncate text-xs text-slate-500" title={c.approvalNote}>{c.approvalNote}</div>}</div> },
    { key: 'status', header: 'Status', render: (c) => (c.active ? <Badge tone="green">active</Badge> : <Badge tone="gray">disabled</Badge>) },
    {
      key: 'actions', header: '', align: 'right',
      render: (c) => manage && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => openFor(c)}>{c.active ? 'Edit' : 'Re-enable'}</Button>
          {c.active && (
            <ConfirmButton
              size="sm" variant="danger" label="Disable" title="Disable this payment configuration?" confirmLabel="Disable"
              body="New checkouts in these currencies will be refused unless another approved configuration covers them. Existing orders and refunds are unaffected."
              onConfirm={() => api.delete(`/v1/admin/payment-configs/${c.id}`).then(() => { toast.success('Configuration disabled'); reload(); })}
            />
          )}
        </div>
      ),
    },
  ];
  const unlinked = (entities.data ?? []).filter((e) => !brand.legalEntities.some((l: any) => l.legalEntityId === e.id));

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        A merchant account belongs to one legal entity. A brand may only take payments through an account the payment provider has approved for that brand and domain.
        The legal entity that owns the selected account is recorded on every order as the legal seller.
      </div>
      <Card title="Payment configurations" description="Which merchant account this brand uses for which currencies. Lower priority number wins." padded={false} actions={manage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => openFor()}>Link merchant account</Button>}>
        <DataTable columns={columns} rows={brand.paymentConfigs} empty={{ title: 'No payment configuration', description: 'This storefront cannot take payments until an approved merchant account is linked.' }} />
      </Card>
      <Card title="Legal sellers" description="Legal entities that may sell under this brand">
        <ul className="divide-y divide-slate-100">
          {brand.legalEntities.map((l: any) => (
            <li key={l.legalEntityId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div>
                <div className="text-sm font-medium text-slate-900">{l.legalEntity.name} {l.isDefault && <Badge tone="indigo">default</Badge>}</div>
                <div className="text-xs text-slate-500">{[l.legalEntity.country, l.legalEntity.registrationNumber, l.legalEntity.address].filter(Boolean).join(' · ')}</div>
              </div>
              {manage && !l.isDefault && <Button size="sm" variant="secondary" loading={loading} onClick={() => assign(true, l.legalEntityId)}>Make default</Button>}
            </li>
          ))}
          {!brand.legalEntities.length && <li className="text-sm text-slate-500">No legal entity linked. Checkout is refused until one is configured.</li>}
        </ul>
        {manage && unlinked.length > 0 && (
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
            <Field label="Link another legal entity" className="w-full sm:w-80">
              <SelectInput value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="Choose a legal entity" options={unlinked.map((e) => ({ value: e.id, label: `${e.name} (${e.country})` }))} />
            </Field>
            <Button variant="secondary" disabled={!entity} loading={loading} onClick={() => assign(false)}>Link</Button>
          </div>
        )}
      </Card>
      {!manage && <p className="text-xs text-slate-500">Payment configuration is managed by platform administrators.</p>}

      <Modal
        open={open} onClose={() => setOpen(false)} title="Brand payment configuration"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={loading} disabled={!f.providerAccountId || !csv(f.currencies).length} onClick={save}>Save configuration</Button></>}
      >
        <Field label="Merchant account">
          <SelectInput
            value={f.providerAccountId} placeholder="Choose a merchant account"
            onChange={(e) => { const a = accounts.data?.find((x) => x.id === e.target.value); setF((s) => ({ ...s, providerAccountId: e.target.value, currencies: s.currencies || (a?.currencies ?? []).filter((c: string) => brand.currencies.includes(c)).join(', ') })); }}
            options={(accounts.data ?? []).filter((a) => a.active).map((a) => ({ value: a.id, label: `${a.label} · ${a.legalEntity.name}${a.livemode ? '' : ' (test)'}` }))}
          />
        </Field>
        {account && <p className="text-xs text-slate-500">Account supports {account.currencies.join(', ')}. Legal seller: {account.legalEntity.name}.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currencies for this brand" hint="Comma-separated"><Input value={f.currencies} onChange={(e) => setF((s) => ({ ...s, currencies: e.target.value }))} className="uppercase" /></Field>
          <Field label="Priority" hint="Lower wins when several match"><Input type="number" min={1} value={f.priority} onChange={(e) => setF((s) => ({ ...s, priority: e.target.value }))} /></Field>
        </div>
        <Checkbox
          checked={f.providerApproved} onChange={(v) => setF((s) => ({ ...s, providerApproved: v }))}
          label="The payment provider has approved this brand and its domain on this merchant account"
          hint="Without this attestation the configuration is saved but cannot be used for payments."
        />
        <Field label="Approval note" hint="Reference of the provider's approval, for the audit trail"><Textarea value={f.approvalNote} onChange={(e) => setF((s) => ({ ...s, approvalNote: e.target.value }))} /></Field>
        <FormError error={error} />
      </Modal>
    </div>
  );
}

// ───────────────────────── Page ─────────────────────────

export default function BrandDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const { can, user, reloadUser } = useAuth();
  const toast = useToast();
  const { data: brand, loading, error, reload } = useQuery<any>(`/v1/admin/brands/${id}`, undefined, { scoped: false });
  const tab = params.get('tab') ?? 'profile';
  const setTab = (t: string) => router.replace(`/brands/${id}?tab=${t}`);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !brand) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-10 w-full" /><Skeleton className="h-72 w-full" /></div>;

  const platform = user.allBrands && can('brands.manage');
  const canEdit = can('brands.manage');
  const setStatus = (status: string, done: string) => (reason: string) =>
    api.post(`/v1/admin/brands/${id}/status`, { status, reason }).then(() => { toast.success(done); reload(); void reloadUser(); });

  return (
    <>
      <PageHeader
        back="/brands"
        title={<span className="flex flex-wrap items-center gap-3"><span className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10" style={{ background: brand.primaryColor }} />{brand.name}<StatusBadge status={brand.status} /></span>}
        description={brand.domains.find((d: any) => d.isPrimary)?.domain ?? 'No primary domain'}
        actions={platform && (
          brand.status === 'ACTIVE' ? (
            <>
              <ConfirmButton
                label="Deactivate" title={`Deactivate ${brand.name}?`} confirmLabel="Deactivate brand" requireReason
                body="Use this when a storefront is being retired. It stops new purchases exactly like a suspension; existing orders, tickets and refunds remain fully manageable."
                onConfirm={setStatus('INACTIVE', 'Brand deactivated')}
              />
              <ConfirmButton
                label="Suspend" variant="danger" title={`Suspend ${brand.name}?`} confirmLabel="Suspend brand" requireReason
                body={<>Suspension immediately blocks <strong>new purchases</strong> on this storefront. Tickets already issued still scan at the gate, payments already in flight are still honoured, and staff can keep handling its orders, refunds and customer support.</>}
                onConfirm={setStatus('SUSPENDED', 'Brand suspended. New purchases are blocked.')}
              />
            </>
          ) : (
            <ConfirmButton
              label="Reactivate" variant="primary" title={`Reactivate ${brand.name}?`} confirmLabel="Reactivate brand" requireReason
              body="The storefront will be able to take new orders again."
              onConfirm={setStatus('ACTIVE', 'Brand reactivated')}
            />
          )
        )}
      />
      {brand.status !== 'ACTIVE' && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          This brand is {humanize(brand.status).toLowerCase()}. Its storefront cannot start new purchases. Existing tickets remain valid and its orders, refunds and support requests can still be handled.
        </div>
      )}
      <Tabs
        active={tab} onChange={setTab}
        tabs={[
          { id: 'profile', label: 'Profile' }, { id: 'domains', label: 'Domains', count: brand.domains.length },
          { id: 'keys', label: 'API keys', count: brand.apiKeys.filter((k: any) => !k.revokedAt).length }, { id: 'policies', label: 'Policies' },
          { id: 'payments', label: 'Payments', count: brand.paymentConfigs.filter((c: any) => c.active).length }, { id: 'staff', label: 'Staff', count: brand.staff.length },
        ]}
      />
      {tab === 'profile' && <ProfileTab brand={brand} canEdit={canEdit} onSaved={reload} />}
      {tab === 'domains' && <DomainsTab brand={brand} platform={platform} reload={reload} />}
      {tab === 'keys' && <KeysTab brand={brand} platform={platform} reload={reload} />}
      {tab === 'policies' && <PoliciesTab brand={brand} canEdit={canEdit} reload={reload} />}
      {tab === 'payments' && <PaymentsTab brand={brand} reload={reload} />}
      {tab === 'staff' && (
        <Card title="Assigned staff" description="People who can work on this brand. Platform-wide administrators are not listed." padded={false} actions={can('staff.read') && <Link href="/staff" className="text-xs font-medium text-accent-700 hover:underline">Manage in Staff &amp; Permissions</Link>}>
          <DataTable
            columns={[
              { key: 'name', header: 'Name', render: (s: any) => <span className="font-medium text-slate-900">{s.user.fullName}</span> },
              { key: 'email', header: 'Email', render: (s: any) => s.user.email },
              { key: 'status', header: 'Status', render: (s: any) => <StatusBadge status={s.user.status} /> },
            ]}
            rows={brand.staff} rowKey={(s: any) => s.user.id} empty={{ title: 'No staff assigned to this brand' }}
          />
        </Card>
      )}
    </>
  );
}
