import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loginAction } from '@/app/actions';
import { ActionForm, Field, Notice } from '@/components/forms';
import { getBrand, getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Sign in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '';
  if (await getMe()) redirect(next || '/account');
  const brand = await getBrand();
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Use your {brand.ok ? brand.data.name : ''} account.</p>
      {sp.reset && <div className="mb-4"><Notice kind="ok">Your password has been changed. Please sign in with the new password.</Notice></div>}
      {next.startsWith('/verify-email') && <div className="mb-4"><Notice kind="info">Sign in to finish confirming your email address.</Notice></div>}
      <div className="card">
        <ActionForm action={loginAction} submit="Sign in">
          <input type="hidden" name="next" value={next} />
          <Field label="Email address" name="email" type="email" required autoComplete="email" />
          <Field label="Password" name="password" type="password" required autoComplete="current-password" />
        </ActionForm>
      </div>
      <p className="mt-4 text-sm text-slate-600">
        <Link href="/account/forgot-password" className="link">Forgot your password?</Link> · New here? <Link href="/account/register" className="link">Create an account</Link>
      </p>
    </div>
  );
}
