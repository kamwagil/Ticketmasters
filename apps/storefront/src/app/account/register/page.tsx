import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { registerAction } from '@/app/actions';
import { ActionForm, Field } from '@/components/forms';
import { getBrand, getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Create an account' };

export default async function Register() {
  if (await getMe()) redirect('/account');
  const brand = await getBrand();
  const name = brand.ok ? brand.data.name : 'us';
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Create an account</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Keep your {name} orders and tickets in one place.</p>
      <div className="card">
        <ActionForm action={registerAction} submit="Create account">
          <Field label="Full name" name="fullName" required minLength={2} autoComplete="name" />
          <Field label="Email address" name="email" type="email" required autoComplete="email" hint="We will email you a link to confirm this address." />
          <Field label="Password" name="password" type="password" required minLength={10} autoComplete="new-password" hint="At least 10 characters." />
          <Field label="Phone" name="phone" type="tel" autoComplete="tel" />
          <Field label="Country" name="country" autoComplete="country-name" />
          <label className="flex items-start gap-2.5 text-sm text-slate-700">
            <input type="checkbox" name="marketingOptIn" className="mt-0.5 h-4 w-4" />
            <span>Send me news and offers from {name}. <span className="text-slate-500">Optional. You can change this at any time.</span></span>
          </label>
          <p className="text-xs text-slate-500">By creating an account you agree to our <Link href="/terms" className="link">terms</Link> and <Link href="/privacy" className="link">privacy policy</Link>.</p>
        </ActionForm>
      </div>
      <p className="mt-4 text-sm text-slate-600">Already have an account? <Link href="/account/login" className="link">Sign in</Link></p>
    </div>
  );
}
