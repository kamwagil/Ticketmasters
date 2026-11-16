'use client';

import { useRouter } from 'next/navigation';
import { ReactNode, useActionState, useEffect, useState } from 'react';
import type { FormState } from '@/app/actions';

type Action = (state: FormState, data: FormData) => Promise<FormState>;

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: ReactNode }) {
  const cls = kind === 'error' ? 'bg-red-50 text-red-800 ring-red-200' : kind === 'ok' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-amber-50 text-amber-900 ring-amber-200';
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-lg px-4 py-3 text-sm ring-1 ring-inset ${cls}`}>{children}</div>;
}

/** A form bound to a server action, showing the action's error or success message. */
export function ActionForm({ action, children, submit, className, variant = 'primary', hideOnSuccess }: {
  action: Action;
  children?: ReactNode;
  submit: string;
  className?: string;
  variant?: 'primary' | 'secondary';
  hideOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  if (state.ok && hideOnSuccess) return <Notice kind="ok">{state.ok}</Notice>;
  return (
    <form action={formAction} className={className ?? 'space-y-4'}>
      {children}
      {state.error && <Notice kind="error">{state.error}</Notice>}
      {state.ok && <Notice kind="ok">{state.ok}</Notice>}
      <button type="submit" disabled={pending} className={variant === 'primary' ? 'btn-primary' : 'btn-secondary'}>
        {pending ? 'Please wait…' : submit}
      </button>
    </form>
  );
}

export function Field({ label, name, type = 'text', required, defaultValue, autoComplete, hint, minLength, placeholder }: {
  label: string; name: string; type?: string; required?: boolean; defaultValue?: string; autoComplete?: string; hint?: string; minLength?: number; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}{!required && <span className="font-normal text-slate-400"> (optional)</span>}</span>
      <input className="input" name={name} type={type} required={required} defaultValue={defaultValue} autoComplete={autoComplete} minLength={minLength} placeholder={placeholder} />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

/** Re-fetches the server-rendered page on an interval (order status while payment is pending). */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}

export function Countdown({ until }: { until: string }) {
  const left = () => Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000));
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  const s = left();
  return <span className="tabular-nums" suppressHydrationWarning>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}
