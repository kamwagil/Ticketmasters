import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { verifyEmailAction } from '@/app/actions';
import { ActionForm, Notice } from '@/components/forms';
import { getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Confirm your email', robots: { index: false } };

export default async function VerifyEmail({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? '';
  if (!token) return <div className="mx-auto max-w-md"><Notice kind="error">This confirmation link is incomplete.</Notice></div>;
  // The platform only accepts a confirmation from the signed-in owner of the account, so that
  // clicking a link in an unexpected email can never confirm somebody else's account.
  const me = await getMe();
  if (!me) redirect(`/account/login?next=${encodeURIComponent(`/verify-email?token=${token}`)}`);
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Confirm your email</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Confirm that <strong>{me.email}</strong> is your email address to see your orders and tickets.</p>
      <div className="card">
        <ActionForm action={verifyEmailAction} submit="Confirm email address">
          <input type="hidden" name="token" value={token} />
        </ActionForm>
      </div>
    </div>
  );
}
