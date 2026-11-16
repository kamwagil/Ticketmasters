'use client';

import { ReactNode, useState } from 'react';
import { BrandChip, Field, SelectInput } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
export const CHANNEL_LABEL: Record<string, string> = { EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp' };

/**
 * Segments, tags, campaigns and promo codes always belong to ONE brand. This resolves the
 * brand to work in: the globally selected brand if there is one, otherwise a local choice.
 */
export function useBrandChoice(initial = '') {
  const { brandId, brands } = useAuth();
  const [local, setLocal] = useState(initial);
  const effective = brandId ?? (local || (brands.length === 1 ? brands[0].id : ''));
  return { brandId: effective, locked: !!brandId, setBrandId: setLocal, brands, brand: brands.find((b) => b.id === effective) ?? null };
}

/** Brand selector for forms. Read-only when the global brand selector already fixes the brand. */
export function BrandField({ value, onChange, locked, label = 'Brand', hint }: { value: string; onChange: (id: string) => void; locked?: boolean; label?: string; hint?: ReactNode }) {
  const { brands } = useAuth();
  const current = brands.find((b) => b.id === value);
  return (
    <Field label={label} hint={hint}>
      {locked && current ? (
        <div className="flex h-9 items-center rounded-lg bg-slate-50 px-3 ring-1 ring-inset ring-slate-200"><BrandChip brand={current} /></div>
      ) : (
        <SelectInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="Choose a brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} />
      )}
    </Field>
  );
}

/** Inline prompt shown in a page body when a brand must be chosen before anything can be listed. */
export function BrandPrompt({ value, onChange, what }: { value: string; onChange: (id: string) => void; what: string }) {
  const { brands } = useAuth();
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3 text-sm text-slate-600">
      <span>{what} belong to a single brand. Working in:</span>
      <SelectInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="Choose a brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} className="w-auto min-w-[12rem]" />
    </div>
  );
}

/** datetime-local value <-> ISO helpers. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
