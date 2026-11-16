import type { Metadata } from 'next';
import Link from 'next/link';
import { confirmResetAction } from '@/app/actions';
import { ActionForm, Field, Notice } from '@/components/forms';

export const metadata: Metadata = { title: 'Choose a new password', robots: { index: false } };

export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? '';
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Choose a new password</h1>
      {!token ? (
        <Notice kind="error">This link is incomplete. <Link href="/account/forgot-password" className="underline">Request a new one</Link>.</Notice>
      ) : (
        <div className="card">
          <ActionForm action={confirmResetAction} submit="Save new password">
            <input type="hidden" name="token" value={token} />
            <Field label="New password" name="password" type="password" required minLength={10} autoComplete="new-password" hint="At least 10 characters." />
            <Field label="Repeat new password" name="confirm" type="password" required minLength={10} autoComplete="new-password" />
            <p className="text-xs text-slate-500">For your security, you will be signed out everywhere and asked to sign in again.</p>
          </ActionForm>
        </div>
      )}
    </div>
  );
}
