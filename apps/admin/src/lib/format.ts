/** Formats integer minor units. Amounts in different currencies are never added together. */
export function money(minor: number | string | null | undefined, currency: string, opts: { compact?: boolean } = {}): string {
  if (minor === null || minor === undefined) return '-';
  const value = Number(minor) / 100;
  try {
    return new Intl.NumberFormat('en-KE', {
      style: 'currency', currency, currencyDisplay: 'code',
      notation: opts.compact ? 'compact' : 'standard', maximumFractionDigits: opts.compact ? 1 : 2, minimumFractionDigits: opts.compact ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export const number = (n: number | null | undefined) => (n === null || n === undefined ? '-' : new Intl.NumberFormat('en-KE').format(n));
export const percent = (ratio: number | null | undefined, digits = 1) => (ratio === null || ratio === undefined ? '-' : `${(ratio * 100).toFixed(digits)}%`);
/** Basis points to a percentage label: 250 → "2.5%". */
export const bps = (v: number) => `${(v / 100).toFixed(v % 100 === 0 ? 0 : 2)}%`;

export function dateTime(value: string | Date | null | undefined, mode: 'datetime' | 'date' | 'time' = 'datetime'): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    ...(mode !== 'time' ? { day: '2-digit', month: 'short', year: 'numeric' } : {}),
    ...(mode !== 'date' ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

export function relative(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const diff = Date.now() - new Date(value).getTime();
  const abs = Math.abs(diff);
  const unit = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'} ${diff >= 0 ? 'ago' : 'from now'}`;
  if (abs < 60_000) return 'just now';
  if (abs < 3600_000) return unit(Math.round(abs / 60_000), 'minute');
  if (abs < 86400_000) return unit(Math.round(abs / 3600_000), 'hour');
  if (abs < 30 * 86400_000) return unit(Math.round(abs / 86400_000), 'day');
  return dateTime(value, 'date');
}

/** "TICKETS_ISSUED" → "Tickets issued". */
export const humanize = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/[_.]/g, ' ') : '-');

/** Major-unit text typed by a user ("1,250.50") to integer minor units. */
export function toMinor(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.replace(/[,\s]/g, ''));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}
export const fromMinor = (minor: number | string | null | undefined) => (minor === null || minor === undefined ? '' : (Number(minor) / 100).toFixed(2));

// ── Date range presets for dashboards and reports ──
export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'prev_month' | 'custom';
export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' }, { value: 'prev_month', label: 'Previous month' }, { value: 'custom', label: 'Custom range' },
];

export function presetRange(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = start(now);
  const day = 86400_000;
  let from = today;
  let to = now;
  if (preset === 'yesterday') { from = new Date(today.getTime() - day); to = new Date(today.getTime() - 1); }
  else if (preset === '7d') from = new Date(today.getTime() - 6 * day);
  else if (preset === '30d') from = new Date(today.getTime() - 29 * day);
  else if (preset === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (preset === 'prev_month') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, -1); }
  return { from: from.toISOString(), to: to.toISOString() };
}
