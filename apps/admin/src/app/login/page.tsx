'use client';

import { ShieldCheck, Ticket } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, Field, FormError, Input } from '@/components/ui';
import { api, ApiError, refresh } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only same-site paths are accepted as a return target.
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  useEffect(() => {
    // Already signed in (valid refresh cookie)? Go straight in.
    refresh().then((ok) => ok && router.replace(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password, needsCode ? totp.trim() : undefined);
      router.replace(target);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.code === 'MFA_REQUIRED') {
        setNeedsCode(true);
      } else {
        setError(e2.message);
        if (needsCode) setTotp('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {!needsCode ? (
        <>
          <Field label="Work email">
            <Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-lg bg-accent-50 px-3 py-2.5 text-sm text-accent-700">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Enter the 6-digit code from your authenticator app to finish signing in as {email}.</span>
          </div>
          <Field label="Authentication code">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} className="text-center text-lg tracking-[0.4em]" />
          </Field>
        </>
      )}
      <FormError error={error} />
      <Button type="submit" loading={busy} className="h-10 w-full">{needsCode ? 'Verify and sign in' : 'Sign in'}</Button>
      {needsCode && (
        <button type="button" onClick={() => { setNeedsCode(false); setTotp(''); setError(null); }} className="block w-full text-center text-sm text-slate-500 hover:text-slate-800">
          Use a different account
        </button>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-ink-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-accent-600/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-[26rem] w-[26rem] rounded-full bg-teal-500/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-600"><Ticket className="h-5 w-5" /></span>
          <span className="text-lg font-semibold">Central Ticketing</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">One platform behind every storefront.</h1>
          <p className="mt-4 text-[15px] leading-relaxed text-slate-300">
            Events, shared inventory, orders, payments, tickets, customers and settlements for all brands, managed from a single place.
          </p>
        </div>
        <p className="relative text-xs text-slate-500">Authorised staff only. Activity is recorded in the audit log.</p>
      </div>
      <div className="flex items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-600 text-white"><Ticket className="h-4 w-4" /></span>
            <span className="font-semibold text-slate-900">Central Ticketing</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
          <p className="mb-6 mt-1.5 text-sm text-slate-500">Use your staff account to open the administration portal.</p>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
