import type { Metadata } from 'next';
import { supportAction } from '@/app/actions';
import { ActionForm, Field } from '@/components/forms';
import { getBrand, getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Contact support' };

const TYPES = [
  ['GENERAL_ENQUIRY', 'General question'], ['ORDER_ENQUIRY', 'Question about an order'], ['TICKET_DELIVERY', 'I have not received my tickets'], ['PAYMENT', 'Payment problem'],
  ['REFUND_REQUEST', 'Refund request'], ['EVENT_CANCELLATION', 'Cancelled or rescheduled event'],
];

export default async function Support({ searchParams }: { searchParams: Promise<{ order?: string }> }) {
  const [brand, me, sp] = await Promise.all([getBrand(), getMe(), searchParams]);
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold tracking-tight">Contact support</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">
        The {brand.ok ? brand.data.name : ''} team will reply by email.
        {brand.ok && brand.data.supportPhone ? ` You can also call ${brand.data.supportPhone}.` : ''}
      </p>
      <div className="card">
        <ActionForm action={supportAction} submit="Send request" hideOnSuccess>
          {me ? <p className="text-sm text-slate-600">Signed in as <strong>{me.email}</strong></p> : (
            <>
              <Field label="Your name" name="name" autoComplete="name" />
              <Field label="Email address" name="email" type="email" required autoComplete="email" />
            </>
          )}
          <label className="block">
            <span className="label">What is this about?</span>
            <select name="issueType" className="input" defaultValue={sp.order ? 'ORDER_ENQUIRY' : 'GENERAL_ENQUIRY'}>
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <Field label="Order reference" name="orderReference" defaultValue={sp.order ?? ''} placeholder="ORD-XXXXXXXXXX" />
          <Field label="Subject" name="subject" required minLength={3} />
          <label className="block">
            <span className="label">Message</span>
            <textarea name="message" required minLength={5} maxLength={5000} rows={6} className="input h-auto py-2" />
          </label>
        </ActionForm>
      </div>
    </div>
  );
}
