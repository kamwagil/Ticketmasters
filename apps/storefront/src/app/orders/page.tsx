import type { Metadata } from 'next';
import Link from 'next/link';
import { lookupOrderAction } from '@/app/actions';
import { ActionForm, Field } from '@/components/forms';

export const metadata: Metadata = { title: 'Find my order' };

export default function OrderLookup() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Find my order</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Enter the order reference from your confirmation email and the email address you used to buy.</p>
      <div className="card">
        <ActionForm action={lookupOrderAction} submit="Find order">
          <Field label="Order reference" name="reference" required placeholder="ORD-XXXXXXXXXX" autoComplete="off" />
          <Field label="Email address" name="email" type="email" required autoComplete="email" />
        </ActionForm>
      </div>
      <p className="mt-4 text-sm text-slate-600">Have an account? <Link href="/account" className="link">See all your orders and tickets</Link>.</p>
    </div>
  );
}
