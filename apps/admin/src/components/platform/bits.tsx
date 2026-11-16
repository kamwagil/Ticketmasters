'use client';

/** Small helpers shared by the finance, reporting, staff, integrations, audit and settings pages. */
import { Check, Copy } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { Button, Checkbox, cn } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard unavailable: the value stays selectable on screen */
    }
  };
  return (
    <Button variant="secondary" size="sm" onClick={copy} icon={done ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}>
      {done ? 'Copied' : label}
    </Button>
  );
}

/** A value shown in monospace with a copy button (webhook URLs, DNS records). */
export function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-800 ring-1 ring-inset ring-slate-200">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function JsonBlock({ value, empty = 'Nothing recorded' }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined) return <p className="text-sm text-slate-400">{empty}</p>;
  return <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">{JSON.stringify(value, null, 2)}</pre>;
}

/** Multi-select rendered as a scrollable checklist. */
export function CheckList({ options, value, onChange, empty = 'Nothing to choose from', className }: {
  options: { value: string; label: ReactNode; hint?: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  empty?: string;
  className?: string;
}) {
  if (!options.length) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className={cn('max-h-44 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3', className)}>
      {options.map((o) => (
        <Checkbox key={o.value} checked={value.includes(o.value)} onChange={(v) => onChange(v ? [...value, o.value] : value.filter((x) => x !== o.value))} label={o.label} hint={o.hint} />
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'good'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'bg-amber-50 text-amber-900 ring-amber-200' : tone === 'good' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-sky-50 text-sky-900 ring-sky-200';
  return <div className={cn('rounded-lg px-3.5 py-2.5 text-sm ring-1 ring-inset', cls)}>{children}</div>;
}

export function Dot({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
      <span className={cn('h-2 w-2 rounded-full', ok === null ? 'bg-slate-300' : ok ? 'bg-emerald-500' : 'bg-red-500')} />
      {label}
    </span>
  );
}

/** Resolves a brand id to its name and colour from the brands the user can access. */
export function useBrandLookup() {
  const { brands } = useAuth();
  return (id: string | null | undefined) => (id ? (brands.find((b) => b.id === id) ?? null) : null);
}

export const CURRENCY_RE = /^[A-Z]{3}$/;
export const dayInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
