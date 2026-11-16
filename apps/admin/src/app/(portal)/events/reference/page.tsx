'use client';

import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { EventCategory, Performer, PerformerModal, Venue, VenueModal } from '@/components/events/shared';
import { Button, Card, Column, ConfirmButton, DataTable, Field, FormError, Input, Modal, PageHeader, Tabs, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize, number } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

function CategoryModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const auto = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const finalSlug = slug || auto;
  const save = async () => {
    setError(null);
    const res = await run(() => api.post('/v1/admin/event-categories', { name: name.trim(), slug: finalSlug }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Category added');
      onSaved();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Add event category" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={name.trim().length < 2 || !/^[a-z0-9-]{2,40}$/.test(finalSlug)} onClick={save}>Save category</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Slug" hint="Used in storefront URLs and filters. Lower-case letters, numbers and dashes."><Input value={finalSlug} onChange={(e) => setSlug(e.target.value.toLowerCase())} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

export default function ReferenceDataPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('venues');
  const venues = useQuery<Venue[]>('/v1/admin/venues', undefined, { scoped: false });
  const performers = useQuery<Performer[]>('/v1/admin/performers', undefined, { scoped: false });
  const categories = useQuery<EventCategory[]>('/v1/admin/event-categories', undefined, { scoped: false });
  const [venue, setVenue] = useState<Venue | null | 'new'>(null);
  const [performer, setPerformer] = useState<Performer | null | 'new'>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const manage = can('events.manage');
  // Shared reference data: anyone who manages events can add; only platform staff can change or remove.
  const platform = manage && user.allBrands;

  const venueCols: Column<Venue>[] = [
    { key: 'name', header: 'Venue', render: (v) => <span className="font-medium text-slate-900">{v.name}</span> },
    { key: 'address', header: 'Address', render: (v) => v.address ?? '-' },
    { key: 'city', header: 'City' },
    { key: 'country', header: 'Country' },
    { key: 'capacity', header: 'Capacity', align: 'right', render: (v) => number(v.capacity) },
    { key: 'timezone', header: 'Time zone' },
    {
      key: 'actions', header: '', align: 'right',
      render: (v) => platform && (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setVenue(v)}>Edit</Button>
          <ConfirmButton label="Remove" variant="ghost" size="sm" title={`Remove ${v.name}?`} confirmLabel="Remove venue" body="The venue is hidden from the list. Existing events keep their venue."
            onConfirm={() => api.delete(`/v1/admin/venues/${v.id}`).then(() => { toast.success('Venue removed'); venues.reload(); })} />
        </div>
      ),
    },
  ];
  const performerCols: Column<Performer>[] = [
    { key: 'name', header: 'Performer', render: (p) => <span className="font-medium text-slate-900">{p.name}</span> },
    { key: 'type', header: 'Type', render: (p) => humanize(p.type) },
    { key: 'bio', header: 'Bio', render: (p) => <span className="block max-w-[28rem] truncate">{p.bio ?? '-'}</span> },
    { key: 'actions', header: '', align: 'right', render: (p) => platform && <Button variant="ghost" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setPerformer(p)}>Edit</Button> },
  ];
  const categoryCols: Column<EventCategory>[] = [
    { key: 'name', header: 'Category', render: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
    { key: 'slug', header: 'Slug', render: (c) => <span className="font-mono text-xs">{c.slug}</span> },
  ];

  const add = tab === 'venues'
    ? manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setVenue('new')}>Add venue</Button>
    : tab === 'performers'
      ? manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setPerformer('new')}>Add performer</Button>
      : platform && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCategoryOpen(true)}>Add category</Button>;

  return (
    <>
      <PageHeader back="/events" title="Venues, performers & categories" description="Reference data shared by every brand's events." actions={add} />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'venues', label: 'Venues', count: venues.data?.length },
          { id: 'performers', label: 'Performers & teams', count: performers.data?.length },
          { id: 'categories', label: 'Event categories', count: categories.data?.length },
        ]}
      />
      <Card padded={false}>
        {tab === 'venues' && <DataTable columns={venueCols} rows={venues.data ?? []} loading={venues.loading} error={venues.error} onRetry={venues.reload} empty={{ title: 'No venues yet' }} />}
        {tab === 'performers' && <DataTable columns={performerCols} rows={performers.data ?? []} loading={performers.loading} error={performers.error} onRetry={performers.reload} empty={{ title: 'No performers yet' }} />}
        {tab === 'categories' && <DataTable columns={categoryCols} rows={categories.data ?? []} loading={categories.loading} error={categories.error} onRetry={categories.reload} empty={{ title: 'No categories yet' }} />}
      </Card>
      {venue && <VenueModal open venue={venue === 'new' ? null : venue} onClose={() => setVenue(null)} onSaved={venues.reload} />}
      {performer && <PerformerModal open performer={performer === 'new' ? null : performer} onClose={() => setPerformer(null)} onSaved={performers.reload} />}
      {categoryOpen && <CategoryModal onClose={() => setCategoryOpen(false)} onSaved={categories.reload} />}
    </>
  );
}
