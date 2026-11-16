'use client';

import { Globe, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Skeleton, StatusBadge, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { number } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

interface BrandRow {
  id: string; slug: string; name: string; status: string; primaryColor: string; secondaryColor: string; logoUrl: string | null; defaultCurrency: string; currencies: string[];
  contactEmail: string;
  domains: { id: string; domain: string; isPrimary: boolean; verifiedAt: string | null }[];
  _count: { orders: number; relationships: number; publications: number };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function NewBrand({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { reloadUser } = useAuth();
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', slug: '', contactEmail: '', emailSenderName: '', emailSenderAddr: '', defaultCurrency: 'KES', primaryColor: '#0f172a', secondaryColor: '#f59e0b' });
  const [slugTouched, setSlugTouched] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const created = await run(
      () => api.post('/v1/admin/brands', { ...f, slug: f.slug || slugify(f.name), emailSenderName: f.emailSenderName || f.name, defaultCurrency: f.defaultCurrency.toUpperCase(), currencies: [f.defaultCurrency.toUpperCase()] }),
      { onError: (er) => setError(er.message) },
    );
    if (created) {
      toast.success(`${created.name} created. Add its domain, API key and payment configuration next.`);
      await reloadUser();
      router.push(`/brands/${created.id}?tab=domains`);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Register a new brand" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="new-brand" loading={loading}>Create brand</Button></>}>
      <p className="text-sm text-slate-600">A brand is a storefront served by this platform. It is added by configuration only: after creating it, verify its domain, issue a storefront API key and link an approved merchant account.</p>
      <form id="new-brand" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand name"><Input required minLength={2} value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value, slug: slugTouched ? s.slug : slugify(e.target.value) }))} /></Field>
        <Field label="Identifier" hint="Lower-case letters, numbers and hyphens. Cannot be changed later.">
          <Input required pattern="[a-z0-9][a-z0-9-]{1,40}" value={f.slug} onChange={(e) => { setSlugTouched(true); set('slug')(e); }} />
        </Field>
        <Field label="Customer contact email"><Input type="email" required value={f.contactEmail} onChange={set('contactEmail')} /></Field>
        <Field label="Default currency" hint="ISO code, for example KES"><Input required pattern="[A-Za-z]{3}" maxLength={3} value={f.defaultCurrency} onChange={set('defaultCurrency')} className="uppercase" /></Field>
        <Field label="Email sender name" hint="Defaults to the brand name"><Input value={f.emailSenderName} onChange={set('emailSenderName')} placeholder={f.name} /></Field>
        <Field label="Email sender address"><Input type="email" required value={f.emailSenderAddr} onChange={set('emailSenderAddr')} placeholder="tickets@brand.com" /></Field>
        <Field label="Primary colour"><Input type="color" value={f.primaryColor} onChange={set('primaryColor')} className="p-1" /></Field>
        <Field label="Secondary colour"><Input type="color" value={f.secondaryColor} onChange={set('secondaryColor')} className="p-1" /></Field>
      </form>
      <FormError error={error} />
    </Modal>
  );
}

export default function BrandsPage() {
  const { user, can } = useAuth();
  const [creating, setCreating] = useState(false);
  // The brand list is the full set the user may manage, regardless of the selected brand.
  const { data, loading, error, reload } = useQuery<BrandRow[]>('/v1/admin/brands', undefined, { scoped: false });

  return (
    <>
      <PageHeader
        title="Brands"
        description="Each brand is an independent storefront with its own identity, domain, policies and payment configuration, all powered by this one platform."
        actions={user.allBrands && can('brands.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New brand</Button>}
      />
      {error ? <Card><ErrorState error={error} onRetry={reload} /></Card> : loading && !data ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-52 w-full rounded-xl" />)}</div>
      ) : !data?.length ? <Card><EmptyState title="No brands yet" description="Register the first storefront brand to start selling." /></Card> : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {data.map((b) => {
            const primary = b.domains.find((d) => d.isPrimary) ?? b.domains[0];
            return (
              <Link key={b.id} href={`/brands/${b.id}`} className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card transition-shadow hover:shadow-md">
                <div className="flex h-20 items-end justify-between px-5 pb-3" style={{ background: b.primaryColor }}>
                  <span className="truncate text-lg font-semibold text-white drop-shadow-sm">{b.name}</span>
                  <span className="h-1.5 w-10 rounded-full" style={{ background: b.secondaryColor }} />
                </div>
                <div className="space-y-3 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm text-slate-600">
                      <Globe className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate">{primary?.domain ?? 'No domain configured'}</span>
                    </span>
                    <StatusBadge status={b.status} />
                  </div>
                  {primary && !primary.verifiedAt && <p className="text-xs text-amber-700">Domain not verified: the storefront cannot call the API yet.</p>}
                  <dl className="grid grid-cols-3 gap-3 border-t border-slate-100 pt-3 text-center">
                    {[['Orders', b._count.orders], ['Customers', b._count.relationships], ['Events', b._count.publications]].map(([l, v]) => (
                      <div key={l as string}>
                        <dd className="text-base font-semibold tabular-nums text-slate-900">{number(v as number)}</dd>
                        <dt className="text-[11px] uppercase tracking-wide text-slate-500">{l}</dt>
                      </div>
                    ))}
                  </dl>
                  <p className="text-xs text-slate-500">Sells in {b.currencies.join(', ')} · {b.contactEmail}</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {creating && <NewBrand open onClose={() => setCreating(false)} />}
    </>
  );
}
