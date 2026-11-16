import type { Metadata } from 'next';
import Link from 'next/link';
import { requestResetAction } from '@/app/actions';
import { ActionForm, Field } from '@/components/forms';

export const metadata: Metadata = { title: 'Reset your password' };

export default function Forgot() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Reset your password</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Enter your email address and we will send you a link to choose a new password.</p>
      <div className="card">
        <ActionForm action={requestResetAction} submit="Send reset link" hideOnSuccess>
          <Field label="Email address" name="email" type="email" required autoComplete="email" />
        </ActionForm>
      </div>
      <p className="mt-4 text-sm"><Link href="/account/login" className="link">Back to sign in</Link></p>
    </div>
  );
}
