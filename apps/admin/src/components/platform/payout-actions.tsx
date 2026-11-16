'use client';

import { useState } from 'react';
import { Button, Field, FormError, Modal, Textarea, useToast } from '@/components/ui';
import { api, idempotencyKey } from '@/lib/api';
import { money } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { Notice } from './bits';

/** Bundles an organizer's available balance in one currency into a payout that then needs approval. */
export function CreatePayoutButton({ organizerId, organizerName, currency, availableMinor, onDone, size = 'sm' }: {
  organizerId: string; organizerName: string; currency: string; availableMinor: number; onDone: () => void; size?: 'sm' | 'md';
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const submit = async () => {
    setError(null);
    const res = await run(() => api.post('/v1/admin/payouts', { organizerId, currency, ...(note.trim() ? { note: note.trim() } : {}) }, idempotencyKey()), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(`Payout ${res.reference} created and sent for approval`);
      setOpen(false);
      setNote('');
      onDone();
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" disabled={availableMinor <= 0} onClick={() => setOpen(true)}>Create payout</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Create payout"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={loading} onClick={submit}>Create for approval</Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          All available earnings for <strong>{organizerName}</strong> in {currency}, net of refunds, will be bundled into one payout of about{' '}
          <strong>{money(availableMinor, currency)}</strong>. The exact amount is calculated when the payout is created.
        </p>
        <Notice>Creating a payout does not move money. A second person must approve it, and it is marked as paid only after finance has transferred the funds outside this platform.</Notice>
        <Field label="Note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: post-event settlement" /></Field>
        <FormError error={error} />
      </Modal>
    </>
  );
}
