'use client';

import { ImagePlus, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button, Checkbox, cn, Field, FormError, Input, Modal, SelectInput, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useQuery } from '@/lib/hooks';

// ── datetime-local <-> ISO (the browser's local time zone) ──
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export const TIMEZONES = ['Africa/Nairobi', 'Africa/Kampala', 'Africa/Dar_es_Salaam', 'Africa/Lagos', 'Africa/Johannesburg', 'Europe/London', 'Europe/Paris', 'America/New_York', 'UTC'];

/** Sold / reserved / free bar for a pool of tickets. */
export function StockBar({ total, sold, reserved = 0, className }: { total: number; sold: number; reserved?: number; className?: string }) {
  const pct = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0);
  const full = total > 0 && sold + reserved >= total;
  return (
    <div className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100', className)} role="img" aria-label={`${sold} sold, ${reserved} reserved of ${total}`}>
      <div className={cn(full ? 'bg-purple-500' : 'bg-accent-600')} style={{ width: `${pct(sold)}%` }} />
      <div className="bg-amber-400" style={{ width: `${pct(reserved)}%` }} />
    </div>
  );
}

/** Image field: upload a file (type is verified by the API from its contents) or paste a URL. */
export function ImageField({ label, value, onChange, hint }: { label: string; value: string; onChange: (url: string) => void; hint?: string }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.upload<{ url: string }>('/v1/admin/uploads/image', form);
      onChange(res.url);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Field label={label} hint={hint ?? 'PNG, JPEG or WebP up to 5 MB, or paste an image URL.'}>
      <div className="flex items-center gap-2">
        {value && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover ring-1 ring-slate-200" />
        )}
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://..." />
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
        <Button variant="secondary" loading={busy} icon={<ImagePlus className="h-4 w-4" />} onClick={() => input.current?.click()}>Upload</Button>
      </div>
    </Field>
  );
}

export interface Venue { id: string; name: string; address: string | null; city: string; country: string; capacity: number | null; timezone: string }
export interface Performer { id: string; name: string; type: string; bio: string | null; imageUrl: string | null }
export interface EventCategory { id: string; slug: string; name: string }

export function VenueModal({ open, onClose, venue, onSaved }: { open: boolean; onClose: () => void; venue?: Venue | null; onSaved: (v: Venue) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: venue?.name ?? '', address: venue?.address ?? '', city: venue?.city ?? '', country: venue?.country ?? 'Kenya', capacity: venue?.capacity?.toString() ?? '', timezone: venue?.timezone ?? 'Africa/Nairobi' });
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    setError(null);
    const body = { name: f.name.trim(), city: f.city.trim(), country: f.country.trim(), timezone: f.timezone, ...(f.address.trim() ? { address: f.address.trim() } : {}), ...(f.capacity ? { capacity: Number(f.capacity) } : {}) };
    const res = await run(() => (venue ? api.patch<Venue>(`/v1/admin/venues/${venue.id}`, body) : api.post<Venue>('/v1/admin/venues', body)), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(venue ? 'Venue updated' : 'Venue added');
      onSaved(res);
      onClose();
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={venue ? 'Edit venue' : 'Add venue'} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={f.name.trim().length < 2 || f.city.trim().length < 2 || f.country.trim().length < 2} onClick={save}>Save venue</Button></>}>
      <Field label="Name"><Input value={f.name} onChange={set('name')} autoFocus /></Field>
      <Field label="Address"><Input value={f.address} onChange={set('address')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
        <Field label="Country"><Input value={f.country} onChange={set('country')} /></Field>
        <Field label="Capacity"><Input type="number" min={0} value={f.capacity} onChange={set('capacity')} /></Field>
        <Field label="Time zone"><SelectInput value={f.timezone} onChange={set('timezone')} options={TIMEZONES.map((t) => ({ value: t, label: t }))} /></Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

export function PerformerModal({ open, onClose, performer, onSaved }: { open: boolean; onClose: () => void; performer?: Performer | null; onSaved: (p: Performer) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: performer?.name ?? '', type: performer?.type ?? 'ARTIST', bio: performer?.bio ?? '', imageUrl: performer?.imageUrl ?? '' });
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const save = async () => {
    setError(null);
    const body = { name: f.name.trim(), type: f.type, ...(f.bio.trim() ? { bio: f.bio.trim() } : {}), ...(f.imageUrl.trim() ? { imageUrl: f.imageUrl.trim() } : {}) };
    const res = await run(() => (performer ? api.patch<Performer>(`/v1/admin/performers/${performer.id}`, body) : api.post<Performer>('/v1/admin/performers', body)), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(performer ? 'Performer updated' : 'Performer added');
      onSaved(res);
      onClose();
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={performer ? 'Edit performer' : 'Add performer'} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!f.name.trim()} onClick={save}>Save performer</Button></>}>
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      <Field label="Type"><SelectInput value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={[{ value: 'ARTIST', label: 'Artist' }, { value: 'TEAM', label: 'Team' }, { value: 'SPEAKER', label: 'Speaker' }]} /></Field>
      <Field label="Bio"><Textarea value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
      <ImageField label="Image" value={f.imageUrl} onChange={(imageUrl) => setF({ ...f, imageUrl })} />
      <FormError error={error} />
    </Modal>
  );
}

export interface EventFormValue {
  name: string; description: string; categoryId: string; venueId: string; organizerId: string; ownerBrandId: string; posterUrl: string;
  startsAt: string; endsAt: string; doorsAt: string; timezone: string; policies: string; performerIds: string[];
}
export const emptyEventForm = (): EventFormValue => ({
  name: '', description: '', categoryId: '', venueId: '', organizerId: '', ownerBrandId: '', posterUrl: '', startsAt: '', endsAt: '', doorsAt: '', timezone: 'Africa/Nairobi', policies: '', performerIds: [],
});
export const eventToForm = (e: any): EventFormValue => ({
  name: e.name ?? '', description: e.description ?? '', categoryId: e.categoryId ?? '', venueId: e.venueId ?? '', organizerId: e.organizerId ?? '', ownerBrandId: e.ownerBrandId ?? '',
  posterUrl: e.posterUrl ?? '', startsAt: toLocalInput(e.startsAt), endsAt: toLocalInput(e.endsAt), doorsAt: toLocalInput(e.doorsAt), timezone: e.timezone ?? 'Africa/Nairobi',
  policies: e.policies ?? '', performerIds: (e.performers ?? []).map((p: any) => p.performerId),
});

/** Request body for create (includes owner brand) or update (master fields only). Empty optional ids are left out. */
export function eventFormBody(f: EventFormValue, mode: 'create' | 'update') {
  const body: Record<string, unknown> = {
    name: f.name.trim(), description: f.description, startsAt: fromLocalInput(f.startsAt), timezone: f.timezone, performerIds: f.performerIds,
    ...(f.categoryId ? { categoryId: f.categoryId } : {}), ...(f.venueId ? { venueId: f.venueId } : {}), ...(f.organizerId ? { organizerId: f.organizerId } : {}),
    ...(f.posterUrl.trim() ? { posterUrl: f.posterUrl.trim() } : {}), ...(f.policies.trim() ? { policies: f.policies } : {}),
  };
  if (mode === 'create') {
    if (f.endsAt) body.endsAt = fromLocalInput(f.endsAt);
    if (f.doorsAt) body.doorsAt = fromLocalInput(f.doorsAt);
    if (f.ownerBrandId) body.ownerBrandId = f.ownerBrandId;
  } else {
    body.endsAt = fromLocalInput(f.endsAt);
    body.doorsAt = fromLocalInput(f.doorsAt);
  }
  return body;
}

/** Master event fields, shared by the create page and the edit dialog. */
export function EventFormFields({ value, onChange, mode }: { value: EventFormValue; onChange: (v: EventFormValue) => void; mode: 'create' | 'update' }) {
  const { brands, user, can } = useAuth();
  const venues = useQuery<Venue[]>('/v1/admin/venues', undefined, { scoped: false });
  const performers = useQuery<Performer[]>('/v1/admin/performers', undefined, { scoped: false });
  const categories = useQuery<EventCategory[]>('/v1/admin/event-categories', undefined, { scoped: false });
  const organizers = useQuery<{ items: { id: string; name: string }[] }>(can('organizers.read') ? '/v1/admin/organizers' : null, { pageSize: 200 }, { scoped: false });
  const [venueOpen, setVenueOpen] = useState(false);
  const [performerOpen, setPerformerOpen] = useState(false);
  const set = <K extends keyof EventFormValue>(k: K, v: EventFormValue[K]) => onChange({ ...value, [k]: v });
  const text = (k: keyof EventFormValue) => (e: { target: { value: string } }) => set(k, e.target.value as never);
  const ownerRequired = !user.allBrands && brands.length > 1;

  return (
    <div className="space-y-4">
      <Field label="Event name"><Input value={value.name} onChange={text('name')} maxLength={200} required /></Field>
      <Field label="Description" hint="The master description. Each storefront can override it with its own wording."><Textarea value={value.description} onChange={text('description')} rows={4} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category"><SelectInput value={value.categoryId} onChange={text('categoryId')} placeholder="No category" options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Organizer / promoter" hint="Needed for promoter settlement.">
          <SelectInput value={value.organizerId} onChange={text('organizerId')} placeholder="No organizer" options={(organizers.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))} />
        </Field>
        <Field label="Venue">
          <div className="flex gap-2">
            <SelectInput value={value.venueId} onChange={text('venueId')} placeholder="To be announced" options={(venues.data ?? []).map((v) => ({ value: v.id, label: `${v.name}, ${v.city}` }))} />
            <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setVenueOpen(true)} aria-label="Add venue" />
          </div>
        </Field>
        {mode === 'create' && (user.allBrands || brands.length > 1) && (
          <Field label="Owning brand" hint={ownerRequired ? 'Choose the brand that owns this event.' : 'Leave empty for a platform-managed master event.'}>
            <SelectInput value={value.ownerBrandId} onChange={text('ownerBrandId')} placeholder={ownerRequired ? 'Select a brand' : 'Platform-managed'} options={brands.map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Starts" hint="In your local time."><Input type="datetime-local" value={value.startsAt} onChange={text('startsAt')} required /></Field>
        <Field label="Ends"><Input type="datetime-local" value={value.endsAt} min={value.startsAt} onChange={text('endsAt')} /></Field>
        <Field label="Doors open"><Input type="datetime-local" value={value.doorsAt} max={value.startsAt || undefined} onChange={text('doorsAt')} /></Field>
      </div>
      <Field label="Event time zone" hint="Used on tickets and in customer emails.">
        <SelectInput value={value.timezone} onChange={text('timezone')} options={[...new Set([value.timezone, ...TIMEZONES])].map((t) => ({ value: t, label: t }))} />
      </Field>
      <ImageField label="Poster" value={value.posterUrl} onChange={(v) => set('posterUrl', v)} />
      <Field label="Performers">
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="grid max-h-44 gap-2 overflow-y-auto sm:grid-cols-2">
            {(performers.data ?? []).map((p) => (
              <Checkbox key={p.id} label={p.name} hint={p.type.charAt(0) + p.type.slice(1).toLowerCase()} checked={value.performerIds.includes(p.id)}
                onChange={(on) => set('performerIds', on ? [...value.performerIds, p.id] : value.performerIds.filter((x) => x !== p.id))} />
            ))}
            {!performers.loading && !performers.data?.length && <p className="text-sm text-slate-500">No performers yet.</p>}
          </div>
          <Button variant="ghost" size="sm" className="mt-2" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPerformerOpen(true)}>Add performer</Button>
        </div>
      </Field>
      <Field label="Event policies" hint="Entry rules shown on the event page."><Textarea value={value.policies} onChange={text('policies')} /></Field>
      {venueOpen && <VenueModal open onClose={() => setVenueOpen(false)} onSaved={(v) => { venues.reload(); set('venueId', v.id); }} />}
      {performerOpen && <PerformerModal open onClose={() => setPerformerOpen(false)} onSaved={(p) => { performers.reload(); set('performerIds', [...value.performerIds, p.id]); }} />}
    </div>
  );
}

export const eventFormValid = (f: EventFormValue) => f.name.trim().length >= 2 && !!f.startsAt;
