import type { Metadata } from 'next';
import { claimTransferAction } from '@/app/actions';
import { ActionForm, Field, Notice } from '@/components/forms';

export const metadata: Metadata = { title: 'Accept your ticket', robots: { index: false } };

export default async function Claim({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? '';
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Accept your ticket</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Someone has sent you a ticket. Accepting it issues a new QR code in your name, and the code held by the sender stops working.</p>
      {!token ? <Notice kind="error">This link is incomplete. Please use the link from your email.</Notice> : (
        <div className="card">
          <ActionForm action={claimTransferAction} submit="Accept ticket">
            <input type="hidden" name="token" value={token} />
            <Field label="Your email address" name="email" type="email" required autoComplete="email" hint="The address this ticket was sent to. It is used to open the ticket afterwards." />
          </ActionForm>
        </div>
      )}
    </div>
  );
}
