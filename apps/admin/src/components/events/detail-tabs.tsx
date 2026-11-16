'use client';

import { Eye, EyeOff, Pencil, Plus, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AreaSeries, BarSeries } from '@/components/charts';
import {
  Badge, BrandChip, Button, Card, Checkbox, Column, ConfirmButton, CurrencyList, DataTable, DateTime, EmptyState, ErrorState, Field, FormError, Input, LinkButton,
  Modal, Money, SelectInput, Skeleton, StatCard, StatusBadge, Textarea, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, fromMinor, humanize, number, percent, toMinor } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';
import { ReconcileButton } from './reconcile';
import { fromLocalInput, ImageField, StockBar, toLocalInput } from './shared';

const CURRENCIES = ['KES', 'USD', 'GBP', 'EUR', 'UGX', 'TZS', 'NGN', 'ZAR'];

function ReadOnlyNote() {
  return (
    <div className="mb-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-inset ring-slate-200">
      This is a shared master event. Its details, ticket categories and capacity are managed by the platform team or the owning brand; you can manage how it appears on your own storefront.
    </div>
  );
}

// ───────────────────────── Ticket categories ─────────────────────────

function CategoryModal({ eventId, category, defaultCurrency, onClose, onSaved }: { eventId: string; category: any | null; defaultCurrency: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: category?.name ?? '', description: category?.description ?? '', price: category ? fromMinor(category.priceMinor) : '', currency: category?.currency ?? defaultCurrency,
    total: '', salesStartAt: toLocalInput(category?.salesStartAt), salesEndAt: toLocalInput(category?.salesEndAt), minPerOrder: String(category?.minPerOrder ?? 1),
    maxPerOrder: String(category?.maxPerOrder ?? 10), deliveryMethod: category?.deliveryMethod ?? 'E_TICKET', status: category?.status ?? 'ACTIVE',
  });
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const priceMinor = toMinor(f.price);
  const min = Number(f.minPerOrder);
  const max = Number(f.maxPerOrder);
  const valid = f.name.trim() && priceMinor !== null && min >= 1 && max >= min && (category || (/^\d+$/.test(f.total)));

  const save = async () => {
    setError(null);
    const common = {
      name: f.name.trim(), ...(f.description.trim() ? { description: f.description.trim() } : {}), priceMinor, minPerOrder: min, maxPerOrder: max,
    };
    const res = await run(
      () => category
        ? api.patch(`/v1/admin/ticket-categories/${category.id}`, { ...common, status: f.status, salesStartAt: fromLocalInput(f.salesStartAt), salesEndAt: fromLocalInput(f.salesEndAt) })
        : api.post(`/v1/admin/events/${eventId}/ticket-categories`, {
            ...common, currency: f.currency, totalQuantity: Number(f.total), deliveryMethod: f.deliveryMethod,
            ...(f.salesStartAt ? { salesStartAt: fromLocalInput(f.salesStartAt) } : {}), ...(f.salesEndAt ? { salesEndAt: fromLocalInput(f.salesEndAt) } : {}),
          }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(category ? 'Ticket category updated' : 'Ticket category created');
      onSaved();
      onClose();
    }
  };

  return (
    <Modal open onClose={onClose} title={category ? `Edit ${category.name}` : 'New ticket category'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!valid} onClick={save}>Save</Button></>}>
      <Field label="Ticket type" hint="For example General Admission, VIP, Early Bird."><Input value={f.name} onChange={set('name')} maxLength={80} autoFocus /></Field>
      <Field label="Description"><Input value={f.description} onChange={set('description')} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Price" error={f.price && priceMinor === null ? 'Enter an amount like 1500 or 1500.50' : null}><Input inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0.00" /></Field>
        <Field label="Currency" hint={category ? 'Fixed after creation.' : undefined}>
          <SelectInput value={f.currency} onChange={set('currency')} disabled={!!category} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
        </Field>
        {category ? (
          <Field label="Status"><SelectInput value={f.status} onChange={set('status')} options={['ACTIVE', 'PAUSED', 'SOLD_OUT', 'CLOSED'].map((s) => ({ value: s, label: humanize(s) }))} /></Field>
        ) : (
          <Field label="Total quantity" hint="Shared by all storefronts."><Input type="number" min={0} value={f.total} onChange={set('total')} /></Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sales start" hint="Empty: on sale as soon as the event is published."><Input type="datetime-local" value={f.salesStartAt} onChange={set('salesStartAt')} /></Field>
        <Field label="Sales end"><Input type="datetime-local" value={f.salesEndAt} min={f.salesStartAt} onChange={set('salesEndAt')} /></Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Minimum per order"><Input type="number" min={1} value={f.minPerOrder} onChange={set('minPerOrder')} /></Field>
        <Field label="Maximum per order" error={max < min ? 'Must be at least the minimum' : null}><Input type="number" min={1} value={f.maxPerOrder} onChange={set('maxPerOrder')} /></Field>
        {!category && (
          <Field label="Delivery"><SelectInput value={f.deliveryMethod} onChange={set('deliveryMethod')} options={[{ value: 'E_TICKET', label: 'E-ticket (email)' }, { value: 'WILL_CALL', label: 'Will call (collect)' }]} /></Field>
        )}
      </div>
      {category && <p className="text-xs text-slate-500">A price change applies to new orders only. Capacity is changed with "Adjust capacity", which is recorded in the inventory ledger.</p>}
      <FormError error={error} />
    </Modal>
  );
}

function CapacityModal({ category, onClose, onSaved }: { category: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const inv = category.inventory ?? { total: 0, sold: 0, reserved: 0 };
  const [total, setTotal] = useState(String(inv.total));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const committed = inv.sold + inv.reserved;
  const n = /^\d+$/.test(total) ? Number(total) : null;
  const save = async () => {
    setError(null);
    const res = await run(() => api.post<{ delta: number }>(`/v1/admin/ticket-categories/${category.id}/inventory`, { total: n, note: note.trim() }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(res.delta === 0 ? 'Capacity unchanged' : `Capacity ${res.delta > 0 ? 'increased' : 'reduced'} by ${Math.abs(res.delta)}`);
      onSaved();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title={`Adjust capacity: ${category.name}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={n === null || n < committed || note.trim().length < 3} onClick={save}>Apply</Button></>}>
      <p className="text-sm text-slate-600">
        {number(inv.sold)} sold and {number(inv.reserved)} held in checkouts across all storefronts. The new total cannot be lower than {number(committed)}.
      </p>
      <Field label="New total quantity" error={n !== null && n < committed ? `Must be at least ${committed}` : null}><Input type="number" min={committed} value={total} onChange={(e) => setTotal(e.target.value)} autoFocus /></Field>
      <Field label="Note" hint="Why the capacity is changing. Stored in the inventory ledger and audit log."><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

export function CategoriesTab({ event, reload }: { event: any; reload: () => void }) {
  const { can } = useAuth();
  const [edit, setEdit] = useState<any | null | 'new'>(null);
  const [capacity, setCapacity] = useState<any | null>(null);
  const editable = event.canEditMaster && can('events.manage');
  const columns: Column<any>[] = [
    { key: 'name', header: 'Ticket type', render: (c) => <div><div className="font-medium text-slate-900">{c.name}</div>{c.description && <div className="max-w-[16rem] truncate text-xs text-slate-500">{c.description}</div>}</div> },
    { key: 'price', header: 'Price', align: 'right', render: (c) => <Money minor={c.priceMinor} currency={c.currency} /> },
    { key: 'total', header: 'Total', align: 'right', render: (c) => number(c.inventory?.total ?? 0) },
    { key: 'sold', header: 'Sold', align: 'right', render: (c) => number(c.inventory?.sold ?? 0) },
    { key: 'reserved', header: 'Reserved', align: 'right', render: (c) => number(c.inventory?.reserved ?? 0) },
    {
      key: 'available', header: 'Remaining', align: 'right', width: '9rem',
      render: (c) => (
        <div><span className={c.available === 0 ? 'font-medium text-purple-700' : ''}>{number(c.available)}</span><StockBar className="mt-1" total={c.inventory?.total ?? 0} sold={c.inventory?.sold ?? 0} reserved={c.inventory?.reserved ?? 0} /></div>
      ),
    },
    { key: 'window', header: 'Sales window', render: (c) => (c.salesStartAt || c.salesEndAt ? <span className="text-xs">{c.salesStartAt ? dateTime(c.salesStartAt) : 'Now'} to {c.salesEndAt ? dateTime(c.salesEndAt) : 'event start'}</span> : <span className="text-slate-400">Always</span>) },
    { key: 'limits', header: 'Per order', render: (c) => `${c.minPerOrder} to ${c.maxPerOrder}` },
    { key: 'delivery', header: 'Delivery', render: (c) => (c.deliveryMethod === 'E_TICKET' ? 'E-ticket' : 'Will call') },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    {
      key: 'actions', header: '', align: 'right',
      render: (c) => (
        <div className="flex justify-end gap-1">
          {editable && <Button variant="ghost" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(c)}>Edit</Button>}
          {event.canEditMaster && can('inventory.manage') && <Button variant="ghost" size="sm" icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => setCapacity(c)}>Adjust capacity</Button>}
        </div>
      ),
    },
  ];
  return (
    <>
      {!event.canEditMaster && <ReadOnlyNote />}
      <Card title="Ticket categories" description="Each category has one inventory counter that every storefront sells from." padded={false}
        actions={editable && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>Add category</Button>}>
        <DataTable columns={columns} rows={event.ticketCategories} empty={{ title: 'No ticket categories yet', description: 'Add at least one category before publishing the event.' }} />
      </Card>
      {edit && <CategoryModal eventId={event.id} category={edit === 'new' ? null : edit} defaultCurrency={event.ticketCategories[0]?.currency ?? 'KES'} onClose={() => setEdit(null)} onSaved={reload} />}
      {capacity && <CapacityModal category={capacity} onClose={() => setCapacity(null)} onSaved={reload} />}
    </>
  );
}

// ───────────────────────── Storefronts (multi-brand publishing) ─────────────────────────

function PublicationModal({ event, brand, publication, onClose, onSaved }: { event: any; brand: { id: string; name: string }; publication: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    visible: publication.visible as boolean, featured: publication.featured as boolean, customTitle: publication.customTitle ?? '', customDescription: publication.customDescription ?? '',
    promoImageUrl: publication.promoImageUrl ?? '', salesStartAt: toLocalInput(publication.salesStartAt), salesEndAt: toLocalInput(publication.salesEndAt),
  });
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries((publication.priceOverrides ?? []).map((o: any) => [o.ticketCategoryId, fromMinor(o.priceMinor)])));
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const badPrice = Object.values(prices).some((p) => p.trim() && toMinor(p) === null);

  const save = async () => {
    setError(null);
    const body: Record<string, unknown> = {
      visible: f.visible, featured: f.featured, customTitle: f.customTitle.trim() || null, customDescription: f.customDescription.trim() || null,
      promoImageUrl: f.promoImageUrl.trim() || null, salesStartAt: fromLocalInput(f.salesStartAt), salesEndAt: fromLocalInput(f.salesEndAt),
    };
    if (event.canEditMaster) {
      body.priceOverrides = Object.entries(prices).filter(([, p]) => p.trim()).map(([ticketCategoryId, p]) => ({ ticketCategoryId, priceMinor: toMinor(p) }));
    }
    const res = await run(() => api.put(`/v1/admin/events/${event.id}/publications/${brand.id}`, body), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(`${brand.name} presentation saved`);
      onSaved();
      onClose();
    }
  };

  return (
    <Modal open onClose={onClose} title={`${event.name} on ${brand.name}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={badPrice} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Checkbox checked={f.visible} onChange={(v) => setF({ ...f, visible: v })} label="Visible on this storefront" hint="Hidden events cannot be found or bought here." />
        <Checkbox checked={f.featured} onChange={(v) => setF({ ...f, featured: v })} label="Featured" hint="Highlighted on this storefront's home page." />
      </div>
      <Field label="Custom title" hint={`Leave empty to use "${event.name}".`}><Input value={f.customTitle} onChange={(e) => setF({ ...f, customTitle: e.target.value })} /></Field>
      <Field label="Custom description" hint="Leave empty to use the master description."><Textarea value={f.customDescription} onChange={(e) => setF({ ...f, customDescription: e.target.value })} rows={4} /></Field>
      <ImageField label="Promotional image" value={f.promoImageUrl} onChange={(v) => setF({ ...f, promoImageUrl: v })} hint="Replaces the master poster on this storefront only." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand sales start" hint="Optional. Narrows the category sales window for this storefront."><Input type="datetime-local" value={f.salesStartAt} onChange={(e) => setF({ ...f, salesStartAt: e.target.value })} /></Field>
        <Field label="Brand sales end"><Input type="datetime-local" value={f.salesEndAt} min={f.salesStartAt} onChange={(e) => setF({ ...f, salesEndAt: e.target.value })} /></Field>
      </div>
      <div>
        <h3 className="text-sm font-medium text-slate-700">Brand-specific prices</h3>
        <p className="mb-2 mt-0.5 text-xs text-slate-500">
          {event.canEditMaster
            ? 'Only where contractually permitted. Leave a field empty to sell at the master price. Inventory stays shared whatever the price.'
            : 'Set by the platform team or the owning brand.'}
        </p>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {event.ticketCategories.map((c: any) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="text-slate-800">{c.name} <span className="text-xs text-slate-500">master <Money minor={c.priceMinor} currency={c.currency} /></span></span>
              {event.canEditMaster ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{c.currency}</span>
                  <Input className="w-32 text-right" inputMode="decimal" placeholder={fromMinor(c.priceMinor)} value={prices[c.id] ?? ''} onChange={(e) => setPrices({ ...prices, [c.id]: e.target.value })} aria-label={`${c.name} price on ${brand.name}`} />
                </span>
              ) : prices[c.id] ? (
                <Money minor={toMinor(prices[c.id])} currency={c.currency} className="font-medium" />
              ) : (
                <span className="text-xs text-slate-400">Master price</span>
              )}
            </div>
          ))}
          {!event.ticketCategories.length && <p className="px-3 py-3 text-sm text-slate-500">No ticket categories yet.</p>}
        </div>
        {badPrice && <p className="mt-1 text-xs text-red-600">Enter prices like 1500 or 1500.50.</p>}
      </div>
      <FormError error={error} />
    </Modal>
  );
}

export function StorefrontsTab({ event, reload }: { event: any; reload: () => void }) {
  const { brands, can } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState<{ brand: any; publication: any } | null>(null);
  const { run, loading } = useAction();
  const mayPublish = can('events.publish');
  const publish = async (brand: { id: string; name: string }) => {
    const res = await run(() => api.put(`/v1/admin/events/${event.id}/publications/${brand.id}`, { visible: true }), { onError: (e) => toast.error(e.message) });
    if (res) {
      toast.success(`Listed on ${brand.name}`);
      reload();
    }
  };
  const rows = brands.map((b) => ({ brand: b, publication: event.publications.find((p: any) => p.brandId === b.id) ?? null }));
  const live = ['PUBLISHED', 'POSTPONED'].includes(event.status);

  return (
    <>
      <div className="mb-4 rounded-lg bg-accent-50 px-4 py-3 text-sm text-accent-700 ring-1 ring-inset ring-accent-100">
        Every storefront below sells from the <strong>same central inventory</strong>. A ticket sold on one storefront is immediately unavailable on all the others, so combined sales can never exceed capacity.
        {!live && <> Storefront listings only become visible to customers once the event itself is published (currently {humanize(event.status).toLowerCase()}).</>}
      </div>
      <Card title="Storefronts" description="Where this event is listed, and how each brand presents it" padded={false}>
        <ul className="divide-y divide-slate-100">
          {rows.map(({ brand, publication: p }) => (
            <li key={brand.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <BrandChip brand={brand} />
                  {brand.status !== 'ACTIVE' && <StatusBadge status={brand.status} />}
                  {p ? (p.visible ? <Badge tone="green">Listed</Badge> : <Badge tone="gray">Hidden</Badge>) : <Badge tone="gray">Not listed</Badge>}
                  {p?.featured && <Badge tone="amber"><Star className="mr-1 h-3 w-3" />Featured</Badge>}
                  {p?.priceOverrides?.length > 0 && <Badge tone="indigo">{p.priceOverrides.length} custom price{p.priceOverrides.length === 1 ? '' : 's'}</Badge>}
                </div>
                {p && (p.customTitle || p.salesStartAt || p.salesEndAt) && (
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {p.customTitle && <>Shown as "{p.customTitle}". </>}
                    {(p.salesStartAt || p.salesEndAt) && <>Brand sales window: {p.salesStartAt ? dateTime(p.salesStartAt) : 'now'} to {p.salesEndAt ? dateTime(p.salesEndAt) : 'event start'}.</>}
                  </p>
                )}
              </div>
              {mayPublish && (
                <div className="flex items-center gap-1.5">
                  {p ? (
                    <>
                      <Button variant="secondary" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit({ brand, publication: p })}>Presentation</Button>
                      <Button variant="ghost" size="sm" loading={loading} icon={p.visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        onClick={async () => {
                          const res = await run(() => api.put(`/v1/admin/events/${event.id}/publications/${brand.id}`, { visible: !p.visible }), { onError: (e) => toast.error(e.message) });
                          if (res) { toast.success(p.visible ? `Hidden on ${brand.name}` : `Visible on ${brand.name}`); reload(); }
                        }}>
                        {p.visible ? 'Hide' : 'Show'}
                      </Button>
                      <ConfirmButton label="Remove" variant="ghost" size="sm" title={`Remove from ${brand.name}?`} confirmLabel="Remove listing"
                        body="The event disappears from this storefront and its brand-specific presentation and prices are deleted. Existing orders and tickets are not affected."
                        onConfirm={() => api.delete(`/v1/admin/events/${event.id}/publications/${brand.id}`).then(() => { toast.success(`Removed from ${brand.name}`); reload(); })} />
                    </>
                  ) : event.canEditMaster ? (
                    <Button size="sm" loading={loading} onClick={() => publish(brand)}>List on this storefront</Button>
                  ) : (
                    <span className="text-xs text-slate-500">Ask the platform team to list this event here</span>
                  )}
                </div>
              )}
            </li>
          ))}
          {!rows.length && <li><EmptyState title="No brands available" /></li>}
        </ul>
      </Card>
      {edit && <PublicationModal event={event} brand={edit.brand} publication={edit.publication} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

// ───────────────────────── Images ─────────────────────────

function ImageModal({ event, onClose, onSaved }: { event: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { brands } = useAuth();
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState('GALLERY');
  const [brandId, setBrandId] = useState(event.canEditMaster ? '' : (brands[0]?.id ?? ''));
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const save = async () => {
    setError(null);
    const res = await run(
      () => api.post(`/v1/admin/events/${event.id}/images`, { url: url.trim(), kind, sortOrder: event.images.length, ...(brandId ? { brandId } : {}) }),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success('Image added');
      onSaved();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Add image" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!url.trim()} onClick={save}>Add image</Button></>}>
      <ImageField label="Image" value={url} onChange={setUrl} />
      <Field label="Used as"><SelectInput value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: 'GALLERY', label: 'Gallery image' }, { value: 'POSTER', label: 'Poster' }, { value: 'PROMO', label: 'Promotional image' }]} /></Field>
      <Field label="Shown on" hint="Brand-specific images replace the shared gallery on that storefront.">
        <SelectInput value={brandId} onChange={(e) => setBrandId(e.target.value)} options={[...(event.canEditMaster ? [{ value: '', label: 'All storefronts (master gallery)' }] : []), ...brands.map((b) => ({ value: b.id, label: `${b.name} only` }))]} />
      </Field>
      <FormError error={error} />
    </Modal>
  );
}

export function ImagesTab({ event, reload }: { event: any; reload: () => void }) {
  const { can, brands } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const manage = can('events.manage');
  return (
    <Card title="Gallery" description="Shared images and brand-specific promotional images" actions={manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Add image</Button>}>
      {event.images.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {event.images.map((img: any) => {
            const brand = brands.find((b) => b.id === img.brandId);
            const removable = manage && (img.brandId ? !!brand : event.canEditMaster);
            return (
              <figure key={img.id} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="aspect-[4/3] w-full object-cover" loading="lazy" />
                <figcaption className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5"><Badge>{humanize(img.kind)}</Badge>{brand ? <BrandChip brand={brand} /> : <span className="text-slate-500">All storefronts</span>}</span>
                  {removable && (
                    <ConfirmButton label="" icon={<Trash2 className="h-3.5 w-3.5" />} variant="ghost" size="sm" title="Remove this image?" confirmLabel="Remove"
                      onConfirm={() => api.delete(`/v1/admin/event-images/${img.id}`).then(() => { toast.success('Image removed'); reload(); })} />
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No gallery images" description="The poster is set in the event details. Add gallery or brand-specific promotional images here." />
      )}
      {open && <ImageModal event={event} onClose={() => setOpen(false)} onSaved={reload} />}
    </Card>
  );
}

// ───────────────────────── Inventory & sales ─────────────────────────

export function InventoryTab({ event }: { event: any }) {
  const { can, user } = useAuth();
  const inv = useQuery<any>(`/v1/admin/events/${event.id}/inventory`, undefined, { scoped: false });
  if (inv.error) return <ErrorState error={inv.error} onRetry={inv.reload} />;
  if (!inv.data) return <Skeleton className="h-64 w-full" />;
  const { categories, salesByBrand, movements } = inv.data;
  const brandIds: string[] = [...new Set<string>(salesByBrand.map((s: any) => s.brandId))];
  const cell = (brandId: string, catId: string) => salesByBrand.find((s: any) => s.brandId === brandId && s.ticketCategoryId === catId)?.tickets ?? 0;

  const movementCols: Column<any>[] = [
    { key: 'createdAt', header: 'When', render: (m) => <DateTime value={m.createdAt} /> },
    { key: 'category', header: 'Category', render: (m) => m.ticketCategory?.name ?? '-' },
    { key: 'type', header: 'Movement', render: (m) => <Badge tone={m.type === 'CONFIRM' || m.type === 'LATE_PAYMENT_ALLOCATION' ? 'green' : m.type === 'RESERVE' ? 'amber' : m.type === 'ADJUSTMENT' || m.type === 'INITIAL' ? 'blue' : 'gray'}>{humanize(m.type)}</Badge> },
    { key: 'quantity', header: 'Qty', align: 'right', render: (m) => number(m.quantity) },
    { key: 'deltaSold', header: 'Sold', align: 'right', render: (m) => (m.deltaSold ? (m.deltaSold > 0 ? `+${m.deltaSold}` : m.deltaSold) : '') },
    { key: 'deltaReserved', header: 'Reserved', align: 'right', render: (m) => (m.deltaReserved ? (m.deltaReserved > 0 ? `+${m.deltaReserved}` : m.deltaReserved) : '') },
    { key: 'deltaTotal', header: 'Capacity', align: 'right', render: (m) => (m.deltaTotal ? (m.deltaTotal > 0 ? `+${m.deltaTotal}` : m.deltaTotal) : '') },
    { key: 'note', header: 'Note', render: (m) => <span className="block max-w-[16rem] truncate text-xs text-slate-500">{m.note ?? ''}</span> },
  ];

  return (
    <div className="space-y-5">
      <Card title="Central inventory" description="Live counters from the database" padded={false} actions={can('inventory.manage') && <ReconcileButton eventId={event.id} size="sm" />}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead><tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5 text-left">Category</th><th className="px-4 py-2.5 text-right">Total</th><th className="px-4 py-2.5 text-right">Sold</th><th className="px-4 py-2.5 text-right">Reserved</th><th className="px-4 py-2.5 text-right">Available</th><th className="w-48 px-4 py-2.5" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {categories.map((c: any) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{number(c.inventory?.total ?? 0)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{number(c.inventory?.sold ?? 0)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{number(c.inventory?.reserved ?? 0)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{number(c.available)}</td>
                  <td className="px-4 py-3"><StockBar total={c.inventory?.total ?? 0} sold={c.inventory?.sold ?? 0} reserved={c.inventory?.reserved ?? 0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!categories.length && <EmptyState title="No ticket categories" />}
        </div>
      </Card>

      <Card title="Tickets sold by storefront" description={user.allBrands ? 'Valid and used tickets, attributed to the storefront that sold them' : 'Your storefronts only'} padded={false}>
        {brandIds.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 text-left">Storefront</th>
                {categories.map((c: any) => <th key={c.id} className="px-4 py-2.5 text-right">{c.name}</th>)}
                <th className="px-4 py-2.5 text-right">All types</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {brandIds.map((bid) => (
                  <tr key={bid}>
                    <td className="px-4 py-3 text-slate-900">{salesByBrand.find((s: any) => s.brandId === bid)?.brandName ?? 'Unknown'}</td>
                    {categories.map((c: any) => <td key={c.id} className="px-4 py-3 text-right tabular-nums">{number(cell(bid, c.id))}</td>)}
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-900">{number(categories.reduce((s: number, c: any) => s + cell(bid, c.id), 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tickets sold yet" />
        )}
      </Card>

      <Card title="Recent inventory movements" description="Append-only ledger of every change to the counters (latest 100)" padded={false}>
        <DataTable columns={movementCols} rows={movements} empty={{ title: 'No movements yet' }} />
      </Card>
    </div>
  );
}

// ───────────────────────── Performance ─────────────────────────

export function PerformanceTab({ event }: { event: any }) {
  const { can } = useAuth();
  const r = useQuery<any>(`/v1/admin/reports/events/${event.id}`);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <div className="grid gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  const d = r.data;
  const revenue = (rows: any[]) => rows.map((x) => ({ currency: x.currency, amountMinor: x.revenueMinor }));
  const day = (v: string) => new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const hour = (v: string) => new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const refunded = d.refunds.filter((x: any) => x.status === 'SUCCEEDED');

  return (
    <div className="space-y-5">
      {d.soldScope !== 'ALL_BRANDS' && <p className="text-sm text-slate-500">Sales, revenue and check-ins below cover your storefronts only. Capacity and remaining tickets are for the whole event.</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tickets sold" value={number(d.totals.sold)} hint={`of ${number(d.totals.capacity)} capacity`} />
        <StatCard label="Remaining" value={number(d.totals.remaining)} hint="Across all storefronts" tone={d.totals.remaining === 0 ? 'warn' : 'default'} />
        <StatCard label="Revenue" value={<CurrencyList items={revenue(d.revenueByCurrency)} emptyLabel="None yet" />} hint="Net of refunds" />
        <StatCard label="Checked in" value={number(d.totals.checkIns)} hint={`${percent(d.totals.checkInRate)} of tickets sold`} />
      </div>

      <Card title="Ticket sales over time" actions={can('orders.read') && <LinkButton href={`/orders?eventId=${event.id}`}>View orders</LinkButton>}>
        <AreaSeries data={d.salesOverTime} xKey="bucket" series={[{ key: 'tickets', label: 'Tickets issued' }]} formatX={day} format={(v) => `${number(v)} tickets`} />
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="By ticket category" padded={false}>
          <DataTable
            rowKey={(c: any) => c.ticketCategoryId}
            columns={[
              { key: 'name', header: 'Category', render: (c: any) => <span className="font-medium text-slate-900">{c.name}</span> },
              { key: 'price', header: 'Price', align: 'right', render: (c: any) => <Money minor={c.priceMinor} currency={c.currency} /> },
              { key: 'sold', header: 'Sold', align: 'right', render: (c: any) => number(c.sold) },
              { key: 'capacity', header: 'Capacity', align: 'right', render: (c: any) => number(c.capacity) },
              { key: 'remaining', header: 'Remaining', align: 'right', render: (c: any) => number(c.remaining) },
            ]}
            rows={d.byCategory}
            empty={{ title: 'No ticket categories' }}
          />
        </Card>
        <Card title="By storefront" padded={false}>
          <DataTable
            rowKey={(b: any) => b.brandId}
            columns={[
              { key: 'brand', header: 'Brand', render: (b: any) => <BrandChip brand={{ name: b.brandName, primaryColor: b.color }} /> },
              { key: 'tickets', header: 'Tickets', align: 'right', render: (b: any) => number(b.tickets) },
              { key: 'orders', header: 'Paid orders', align: 'right', render: (b: any) => number(b.revenueByCurrency.reduce((s: number, x: any) => s + x.paidOrders, 0)) },
              { key: 'revenue', header: 'Revenue', align: 'right', render: (b: any) => <CurrencyList items={revenue(b.revenueByCurrency)} className="items-end" /> },
            ]}
            rows={d.byBrand}
            empty={{ title: 'No sales yet' }}
          />
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Check-ins by hour">
          <BarSeries data={d.checkInsByHour} xKey="bucket" series={[{ key: 'admitted', label: 'Admitted', color: '#0d9488' }]} formatX={hour} height={220} />
          {d.scanResults.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
              {d.scanResults.map((s: any) => <span key={s.result} className="flex items-center gap-1.5"><StatusBadge status={s.result} /> {number(s.n)}</span>)}
            </div>
          )}
        </Card>
        <Card title="Refunds" padded={false}>
          <DataTable
            rowKey={(x: any) => `${x.currency}-${x.status}`}
            columns={[
              { key: 'status', header: 'Status', render: (x: any) => <StatusBadge status={x.status} /> },
              { key: 'count', header: 'Refunds', align: 'right', render: (x: any) => number(x.count) },
              { key: 'amount', header: 'Amount', align: 'right', render: (x: any) => <Money minor={x.amountMinor} currency={x.currency} /> },
            ]}
            rows={d.refunds}
            empty={{ title: 'No refunds for this event' }}
          />
          {refunded.length > 0 && can('refunds.read') && <div className="border-t border-slate-100 px-4 py-2.5 text-right"><Link href="/refunds" className="text-sm font-medium text-accent-700 hover:underline">Open refunds</Link></div>}
        </Card>
      </div>
    </div>
  );
}
