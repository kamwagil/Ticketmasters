'use client';

import { CalendarClock, Copy, Pencil } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { CategoriesTab, ImagesTab, InventoryTab, PerformanceTab, StorefrontsTab } from '@/components/events/detail-tabs';
import { eventFormBody, EventFormFields, eventFormValid, eventToForm, fromLocalInput, StockBar, toLocalInput } from '@/components/events/shared';
import {
  BrandChip, Button, Card, Checkbox, ConfirmButton, DateTime, ErrorState, Field, FormError, Input, KeyValue, Modal, PageHeader, Skeleton, StatusBadge, Tabs, Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { number } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

type Action = 'schedule' | 'postpone' | 'cancel';

function EditModal({ event, onClose, onSaved }: { event: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState(() => eventToForm(event));
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const save = async () => {
    setError(null);
    const res = await run(() => api.patch(`/v1/admin/events/${event.id}`, eventFormBody(form, 'update')), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Event updated');
      onSaved();
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Edit event details" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!eventFormValid(form)} onClick={save}>Save changes</Button></>}>
      {['PUBLISHED', 'POSTPONED'].includes(event.status) && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          This event is on sale. To move the date and tell ticket holders, use Postpone instead of editing the start time here.
        </p>
      )}
      <EventFormFields value={form} onChange={setForm} mode="update" />
      <FormError error={error} />
    </Modal>
  );
}

/** Schedule, postpone and cancel need extra input, so they get a dialog. */
function LifecycleModal({ event, action, onClose, onDone }: { event: any; action: Action; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [publishAt, setPublishAt] = useState('');
  const [newStartsAt, setNewStartsAt] = useState(toLocalInput(event.startsAt));
  const [newEndsAt, setNewEndsAt] = useState(toLocalInput(event.endsAt));
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();

  const valid = action === 'schedule' ? !!publishAt && new Date(publishAt) > new Date()
    : action === 'postpone' ? !!newStartsAt && (!newEndsAt || new Date(newEndsAt) > new Date(newStartsAt))
      : reason.trim().length >= 5 && confirmText.trim().toUpperCase() === 'CANCEL';

  const submit = async () => {
    setError(null);
    const body = action === 'schedule' ? { action, publishAt: fromLocalInput(publishAt) }
      : action === 'postpone' ? { action, newStartsAt: fromLocalInput(newStartsAt), ...(newEndsAt ? { newEndsAt: fromLocalInput(newEndsAt) } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}), notifyCustomers: notify }
        : { action, reason: reason.trim(), notifyCustomers: notify };
    const res = await run(() => api.post<{ notifiedOrders: number }>(`/v1/admin/events/${event.id}/status`, body), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(
        action === 'schedule' ? 'Publication scheduled'
          : `${action === 'cancel' ? 'Event cancelled' : 'Event postponed'}. ${res.notifiedOrders ? `${res.notifiedOrders} order${res.notifiedOrders === 1 ? '' : 's'} notified by their own brand.` : 'No customers were notified.'}`,
      );
      onDone();
      onClose();
    }
  };

  return (
    <Modal open onClose={onClose} size="sm"
      title={action === 'schedule' ? 'Schedule publication' : action === 'postpone' ? 'Postpone event' : 'Cancel event'}
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button variant={action === 'cancel' ? 'danger' : 'primary'} loading={loading} disabled={!valid} onClick={submit}>{action === 'schedule' ? 'Schedule' : action === 'postpone' ? 'Postpone event' : 'Cancel event'}</Button></>}>
      {action === 'schedule' && (
        <Field label="Publish at" hint="The event goes on sale automatically on every storefront it is listed on."><Input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} autoFocus /></Field>
      )}
      {action === 'postpone' && (
        <>
          <p className="text-sm text-slate-600">Existing tickets stay valid for the new date. Sales continue.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New start"><Input type="datetime-local" value={newStartsAt} onChange={(e) => setNewStartsAt(e.target.value)} autoFocus /></Field>
            <Field label="New end"><Input type="datetime-local" value={newEndsAt} min={newStartsAt} onChange={(e) => setNewEndsAt(e.target.value)} /></Field>
          </div>
          <Field label="Note (optional)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </>
      )}
      {action === 'cancel' && (
        <>
          <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-inset ring-red-200">
            <strong>This stops all sales on every storefront and cannot be undone.</strong> Tickets are not refunded automatically: refunds go through the refund approval workflow.
          </div>
          <Field label="Reason" hint="Included in the email to ticket holders and recorded in the audit log."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
          <Field label='Type "CANCEL" to confirm'><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></Field>
        </>
      )}
      {action !== 'schedule' && (
        <Checkbox checked={notify} onChange={setNotify} label="Email ticket holders" hint="Each customer is emailed by the brand they bought from." />
      )}
      <FormError error={error} />
    </Modal>
  );
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: e, loading, error, reload } = useQuery<any>(`/v1/admin/events/${id}`, undefined, { scoped: false });
  const [tab, setTabState] = useState(params.get('tab') ?? 'overview');
  const [editOpen, setEditOpen] = useState(false);
  const [dialog, setDialog] = useState<Action | null>(null);
  const { run, loading: acting } = useAction();

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !e) return <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-10 w-full" /><Skeleton className="h-72 w-full" /></div>;
  if (!e) return null;

  const setTab = (t: string) => {
    setTabState(t);
    router.replace(`/events/${id}?tab=${t}`, { scroll: false });
  };
  const simple = async (action: string, success: string) => {
    const res = await run(() => api.post(`/v1/admin/events/${id}/status`, { action }), { onError: (err) => toast.error(err.message) });
    if (res) {
      toast.success(success);
      reload();
    }
  };
  const lifecycle = e.canEditMaster && can('events.publish');
  const s = e.status as string;
  const capacity = e.ticketCategories.reduce((n: number, c: any) => n + (c.inventory?.total ?? 0), 0);
  const sold = e.ticketCategories.reduce((n: number, c: any) => n + (c.inventory?.sold ?? 0), 0);
  const reserved = e.ticketCategories.reduce((n: number, c: any) => n + (c.inventory?.reserved ?? 0), 0);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'categories', label: 'Ticket categories', count: e.ticketCategories.length },
    { id: 'storefronts', label: 'Storefronts', count: e.publications.length },
    { id: 'images', label: 'Images', count: e.images.length },
    ...(can('inventory.read') ? [{ id: 'inventory', label: 'Inventory & sales' }] : []),
    ...(can('reports.read') ? [{ id: 'performance', label: 'Performance' }] : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'overview';

  return (
    <>
      <PageHeader
        back="/events"
        title={<span className="flex flex-wrap items-center gap-3">{e.name}<StatusBadge status={s} /></span>}
        description={<><DateTime value={e.startsAt} /> · {e.venue ? `${e.venue.name}, ${e.venue.city}` : 'Venue to be announced'}{s === 'SCHEDULED' && e.publishAt && <> · publishes <DateTime value={e.publishAt} /></>}</>}
        actions={
          <>
            {e.canEditMaster && can('events.manage') && (
              <>
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>Edit</Button>
                <ConfirmButton label="Duplicate" icon={<Copy className="h-4 w-4" />} title="Duplicate this event?" confirmLabel="Create copy"
                  body="Creates a new draft with the same details and ticket categories, with fresh unsold inventory. Storefront listings are not copied."
                  onConfirm={() => api.post<{ id: string }>(`/v1/admin/events/${id}/duplicate`).then((copy) => { toast.success('Draft copy created'); router.push(`/events/${copy.id}`); })} />
              </>
            )}
            {lifecycle && (
              <>
                {['DRAFT', 'SCHEDULED', 'POSTPONED'].includes(s) && (
                  <ConfirmButton label={s === 'POSTPONED' ? 'Mark as on sale' : 'Publish now'} variant="primary" title="Publish this event?" confirmLabel="Publish"
                    body="The event goes on sale immediately on every storefront it is listed on."
                    onConfirm={() => api.post(`/v1/admin/events/${id}/status`, { action: 'publish' }).then(() => { toast.success('Event published'); reload(); })} />
                )}
                {['DRAFT', 'SCHEDULED'].includes(s) && <Button variant="secondary" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setDialog('schedule')}>{s === 'SCHEDULED' ? 'Reschedule' : 'Schedule'}</Button>}
                {['SCHEDULED', 'PUBLISHED'].includes(s) && (
                  <ConfirmButton label="Unpublish" title="Unpublish this event?" confirmLabel="Unpublish"
                    body="The event returns to draft and disappears from all storefronts. Existing orders and tickets are not affected."
                    onConfirm={() => api.post(`/v1/admin/events/${id}/status`, { action: 'unpublish' }).then(() => { toast.success('Event unpublished'); reload(); })} />
                )}
                {['PUBLISHED', 'POSTPONED'].includes(s) && (
                  <>
                    <Button variant="secondary" onClick={() => setDialog('postpone')}>Postpone</Button>
                    <Button variant="secondary" loading={acting} onClick={() => simple('complete', 'Event marked as completed')}>Complete</Button>
                    <Button variant="danger" onClick={() => setDialog('cancel')}>Cancel event</Button>
                  </>
                )}
                {['DRAFT', 'CANCELLED', 'COMPLETED'].includes(s) && (
                  <ConfirmButton label="Archive" variant="ghost" title="Archive this event?" confirmLabel="Archive" body="Archived events are hidden from the default event list. Orders, tickets and financial records are kept."
                    onConfirm={() => api.post(`/v1/admin/events/${id}/status`, { action: 'archive' }).then(() => { toast.success('Event archived'); reload(); })} />
                )}
                {s === 'ARCHIVED' && <Button variant="secondary" loading={acting} onClick={() => simple('unpublish', 'Event restored to draft')}>Restore to draft</Button>}
              </>
            )}
          </>
        }
      />

      <Tabs tabs={tabs} active={active} onChange={setTab} />

      {active === 'overview' && (
        <div className="grid gap-5 xl:grid-cols-3">
          <div className="space-y-5 xl:col-span-2">
            {!e.canEditMaster && (
              <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-inset ring-slate-200">
                This is a shared master event managed by the platform team or its owning brand. You can change how it appears on your storefront in the Storefronts tab.
              </div>
            )}
            {s === 'CANCELLED' && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-inset ring-red-200">
                <strong>Cancelled</strong> <DateTime value={e.cancelledAt} />. {e.cancelReason}
              </div>
            )}
            <Card title="Details">
              <KeyValue
                columns={3}
                items={[
                  { label: 'Starts', value: <DateTime value={e.startsAt} /> },
                  { label: 'Ends', value: <DateTime value={e.endsAt} /> },
                  { label: 'Doors open', value: <DateTime value={e.doorsAt} /> },
                  { label: 'Time zone', value: e.timezone },
                  { label: 'Category', value: e.category?.name ?? '-' },
                  { label: 'Organizer', value: e.organizer?.name ?? <span className="text-amber-700">Not set</span> },
                  { label: 'Venue', value: e.venue ? `${e.venue.name}, ${e.venue.city}, ${e.venue.country}` : 'To be announced' },
                  { label: 'Venue address', value: e.venue?.address ?? '-' },
                  { label: 'Owner', value: e.ownerBrandId ? (e.publications.find((p: any) => p.brandId === e.ownerBrandId)?.brand.name ?? 'Brand-owned') : 'Platform-managed' },
                  { label: 'Public link name', value: <span className="font-mono text-xs">{e.slug}</span> },
                ]}
              />
            </Card>
            <Card title="Description">
              <p className="whitespace-pre-wrap text-sm text-slate-700">{e.description || <span className="text-slate-400">No description yet.</span>}</p>
              {e.policies && (
                <div className="mt-4 border-t border-slate-100 pt-4">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Event policies</h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{e.policies}</p>
                </div>
              )}
            </Card>
            <Card title="Performers">
              {e.performers.length ? (
                <ul className="flex flex-wrap gap-2">
                  {e.performers.map((p: any) => (
                    <li key={p.performerId} className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">{p.performer.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">No performers added.</p>
              )}
            </Card>
          </div>
          <div className="space-y-5">
            {e.posterUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={e.posterUrl} alt={`${e.name} poster`} className="w-full rounded-xl border border-slate-200 object-cover shadow-card" />
            )}
            <Card title="Sales" description="Central inventory, all storefronts">
              <div className="flex items-end justify-between">
                <div><div className="text-2xl font-semibold tabular-nums text-slate-900">{number(sold)}</div><div className="text-xs text-slate-500">sold of {number(capacity)}</div></div>
                <div className="text-right text-xs text-slate-500">{number(reserved)} held in checkout<br />{number(capacity - sold - reserved)} available</div>
              </div>
              <StockBar className="mt-3" total={capacity} sold={sold} reserved={reserved} />
            </Card>
            <Card title="Listed on" padded={false}>
              <ul className="divide-y divide-slate-100">
                {e.publications.map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-5 py-2.5"><BrandChip brand={p.brand} />{!p.visible && <span className="text-xs text-slate-400">Hidden</span>}</li>
                ))}
                {!e.publications.length && <li className="px-5 py-6 text-center text-sm text-slate-500">Not listed on any storefront yet</li>}
              </ul>
            </Card>
          </div>
        </div>
      )}
      {active === 'categories' && <CategoriesTab event={e} reload={reload} />}
      {active === 'storefronts' && <StorefrontsTab event={e} reload={reload} />}
      {active === 'images' && <ImagesTab event={e} reload={reload} />}
      {active === 'inventory' && <InventoryTab event={e} />}
      {active === 'performance' && <PerformanceTab event={e} />}

      {editOpen && <EditModal event={e} onClose={() => setEditOpen(false)} onSaved={reload} />}
      {dialog && <LifecycleModal event={e} action={dialog} onClose={() => setDialog(null)} onDone={reload} />}
    </>
  );
}
