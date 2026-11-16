'use client';

import { useState } from 'react';
import { Button, Field, FormError, Input, Modal, SelectInput, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { CURRENCY_RE, Notice } from './bits';

/** Create or edit a seller / promoter. Settlement details are write-only. */
export function OrganizerForm({ organizer, onClose, onSaved }: { organizer?: any; onClose: () => void; onSaved: (o: any) => void }) {
  const toast = useToast();
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    name: organizer?.name ?? '', contactEmail: organizer?.contactEmail ?? '', contactPhone: organizer?.contactPhone ?? '', country: organizer?.country ?? '',
    legalName: organizer?.legalName ?? '', registrationNumber: organizer?.registrationNumber ?? '', taxNumber: organizer?.taxNumber ?? '',
    agreementNotes: organizer?.agreementNotes ?? '', settlementCurrency: organizer?.settlementCurrency ?? 'KES', payoutHoldDays: String(organizer?.payoutHoldDays ?? 3),
    verificationStatus: organizer?.verificationStatus ?? 'PENDING', settlementDetails: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    setError(null);
    const hold = Number(f.payoutHoldDays);
    if (!CURRENCY_RE.test(f.settlementCurrency)) return setError('Settlement currency must be a 3-letter code such as KES.');
    if (!Number.isInteger(hold) || hold < 0 || hold > 90) return setError('Payout hold must be between 0 and 90 days.');
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const body: Record<string, unknown> = {
      name: f.name.trim(), contactEmail: f.contactEmail.trim(), contactPhone: opt(f.contactPhone), country: opt(f.country), legalName: opt(f.legalName),
      registrationNumber: opt(f.registrationNumber), taxNumber: opt(f.taxNumber), agreementNotes: opt(f.agreementNotes), settlementCurrency: f.settlementCurrency,
      payoutHoldDays: hold, settlementDetails: opt(f.settlementDetails),
    };
    if (organizer) body.verificationStatus = f.verificationStatus;
    const res = await run(() => (organizer ? api.patch(`/v1/admin/organizers/${organizer.id}`, body) : api.post('/v1/admin/organizers', body)), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(organizer ? 'Organizer updated' : 'Organizer created');
      onSaved(res);
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={organizer ? `Edit ${organizer.name}` : 'New seller or promoter'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={loading} disabled={f.name.trim().length < 2 || !f.contactEmail.includes('@')} onClick={submit}>{organizer ? 'Save changes' : 'Create organizer'}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Trading name"><Input value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Contact email"><Input type="email" value={f.contactEmail} onChange={set('contactEmail')} /></Field>
        <Field label="Contact phone"><Input value={f.contactPhone} onChange={set('contactPhone')} /></Field>
        <Field label="Country"><Input value={f.country} onChange={set('country')} placeholder="KE" /></Field>
      </div>
      <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Legal business information</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Legal name"><Input value={f.legalName} onChange={set('legalName')} /></Field>
        <Field label="Registration number"><Input value={f.registrationNumber} onChange={set('registrationNumber')} /></Field>
        <Field label="Tax number"><Input value={f.taxNumber} onChange={set('taxNumber')} /></Field>
      </div>
      <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Commercial terms and settlement</h3>
      <Field label="Commercial agreement notes" hint="Summary of the signed agreement. Commission percentages are set under Settlements, Commission rules.">
        <Textarea value={f.agreementNotes} onChange={set('agreementNotes')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Settlement currency"><Input value={f.settlementCurrency} maxLength={3} onChange={(e) => setF((s) => ({ ...s, settlementCurrency: e.target.value.toUpperCase() }))} /></Field>
        <Field label="Payout hold (days)" hint="Days after the event ends before earnings can be paid out."><Input type="number" min={0} max={90} value={f.payoutHoldDays} onChange={set('payoutHoldDays')} /></Field>
        {organizer && (
          <Field label="Verification status" hint="Payouts can only be created for verified organizers.">
            <SelectInput value={f.verificationStatus} onChange={set('verificationStatus')} options={[{ value: 'PENDING', label: 'Pending' }, { value: 'VERIFIED', label: 'Verified' }, { value: 'REJECTED', label: 'Rejected' }]} />
          </Field>
        )}
      </div>
      <Field label={organizer?.hasSettlementDetails ? 'Replace settlement details' : 'Settlement details'} hint="Bank account or mobile money details used when paying this organizer.">
        <Textarea value={f.settlementDetails} onChange={set('settlementDetails')} placeholder={organizer?.hasSettlementDetails ? 'Leave blank to keep the details already on file' : 'Bank, branch, account name and number, or mobile money number'} autoComplete="off" />
      </Field>
      <Notice>Settlement details are stored encrypted and are never displayed again in this portal. To change them, enter the complete new details.</Notice>
      <FormError error={error} />
    </Modal>
  );
}
