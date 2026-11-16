'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { emptyEventForm, eventFormBody, EventFormFields, eventFormValid } from '@/components/events/shared';
import { Button, Card, ErrorState, FormError, LinkButton, PageHeader, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';

export default function NewEventPage() {
  const router = useRouter();
  const toast = useToast();
  const { can, brandId, user, brands } = useAuth();
  const [form, setForm] = useState(() => ({ ...emptyEventForm(), ownerBrandId: !user.allBrands && brandId ? brandId : '' }));
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();

  if (!can('events.manage')) return <ErrorState error={new ApiError(403, 'FORBIDDEN', 'Creating events requires the events.manage permission.')} />;
  const ownerMissing = !user.allBrands && brands.length > 1 && !form.ownerBrandId;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const created = await run(() => api.post<{ id: string }>('/v1/admin/events', eventFormBody(form, 'create')), { onError: (err) => setError(err.message) });
    if (created) {
      toast.success('Draft event created. Add ticket categories, then publish it to storefronts.');
      router.replace(`/events/${created.id}?tab=categories`);
    }
  };

  return (
    <form onSubmit={submit}>
      <PageHeader back="/events" title="New event" description="Creates a draft master event. Ticket categories, storefront publishing and images are added on the next screen." />
      <Card className="max-w-3xl">
        <EventFormFields value={form} onChange={setForm} mode="create" />
        <div className="mt-5 space-y-3">
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <LinkButton href="/events">Cancel</LinkButton>
            <Button type="submit" loading={loading} disabled={!eventFormValid(form) || ownerMissing}>Create draft event</Button>
          </div>
        </div>
      </Card>
    </form>
  );
}
