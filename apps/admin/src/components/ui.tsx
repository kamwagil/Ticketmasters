'use client';

/**
 * Shared interface kit for the admin portal. Pages compose these instead of writing ad-hoc
 * markup, so tables, forms, badges and money look and behave the same everywhere.
 */
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, Download, Inbox, Loader2, Search, X } from 'lucide-react';
import Link from 'next/link';
import {
  ButtonHTMLAttributes, createContext, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useCallback, useContext, useEffect,
  useState,
} from 'react';
import { api, ApiError, Params } from '@/lib/api';
import { dateTime, humanize, money, presetRange, RANGE_PRESETS, RangePreset, relative } from '@/lib/format';

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ───────────────────────── Buttons ─────────────────────────

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  loading?: boolean;
};
const BTN = {
  primary: 'bg-accent-600 text-white hover:bg-accent-700 shadow-sm',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
};
export function Button({ variant = 'primary', size = 'md', icon, loading, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        BTN[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'secondary', icon }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; icon?: ReactNode }) {
  return (
    <Link href={href} className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors', BTN[variant])}>
      {icon}
      {children}
    </Link>
  );
}

// ───────────────────────── Layout ─────────────────────────

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <Link href={back} className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </Link>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

const TONE_TEXT = { default: 'text-slate-900', good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700' };
export function StatCard({ label, value, hint, icon, tone = 'default', href }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: keyof typeof TONE_TEXT; href?: string }) {
  const body = (
    <div className={cn('h-full rounded-xl border border-slate-200 bg-white p-4 shadow-card transition-shadow', href && 'hover:shadow-md')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        {icon && <span className="text-slate-400">{icon}</span>}
      </div>
      <div className={cn('mt-2 text-2xl font-semibold tabular-nums tracking-tight', TONE_TEXT[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string; count?: number }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
            active === t.id ? 'border-accent-600 text-accent-700' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items, columns = 2 }: { items: { label: string; value: ReactNode }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium text-slate-500">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-slate-900">{i.value ?? '-'}</dd>
        </div>
      ))}
    </dl>
  );
}

// ───────────────────────── Badges and values ─────────────────────────

const TONES = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200',
};
export type Tone = keyof typeof TONES;
export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: Tone }) {
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone])}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'green', PAID: 'green', TICKETS_ISSUED: 'green', SUCCEEDED: 'green', VALID: 'green', PUBLISHED: 'green', SENT: 'green', DELIVERED: 'green', VERIFIED: 'green',
  ADMITTED: 'green', RESOLVED: 'green', APPROVED: 'blue', PROCESSED: 'green', RECONCILED: 'green', AVAILABLE: 'green', GRANTED: 'green', COMPLETED: 'gray', CONFIRMED: 'green',
  PENDING: 'amber', RESERVED: 'amber', AWAITING_PAYMENT: 'amber', PAYMENT_PROCESSING: 'amber', PROCESSING: 'amber', REQUESTED: 'amber', SCHEDULED: 'blue', QUEUED: 'amber',
  SENDING: 'amber', PENDING_APPROVAL: 'amber', INITIATED: 'amber', RECEIVED: 'amber', OPEN: 'amber', PENDING_CUSTOMER: 'blue', PENDING_INTERNAL: 'amber', POSTPONED: 'amber',
  IN_PAYOUT: 'blue', IN_PROGRESS: 'amber', INVITED: 'blue', PAUSED: 'amber', WARNING: 'amber', HIGH: 'amber', USED: 'indigo', TRANSFERRED: 'purple', PARTIALLY_REFUNDED: 'purple',
  REFUNDED: 'purple', DRAFT: 'gray', INFO: 'blue', NORMAL: 'gray', LOW: 'gray', CLOSED: 'gray', ARCHIVED: 'gray', INACTIVE: 'gray', IGNORED: 'gray', SKIPPED: 'gray',
  UNPAID: 'gray', EXPIRED: 'gray', RELEASED: 'gray', WITHDRAWN: 'gray', ANONYMIZED: 'gray', SOLD_OUT: 'purple',
  FAILED: 'red', CANCELLED: 'red', REJECTED: 'red', REVOKED: 'red', SUSPENDED: 'red', BLOCKED: 'red', BOUNCED: 'red', CRITICAL: 'red', URGENT: 'red', DISCREPANCY: 'red',
  ALREADY_USED: 'red', INVALID_TOKEN: 'red', WRONG_EVENT: 'red', NOT_VALID: 'red', OFFLINE_CONFLICT: 'red',
};
/** Coloured badge for any platform status value (orders, payments, tickets, refunds, events, ...). */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-slate-400">-</span>;
  return <Badge tone={STATUS_TONE[status] ?? 'gray'}>{humanize(status)}</Badge>;
}

export function BrandChip({ brand }: { brand: { name: string; primaryColor?: string | null } | null | undefined }) {
  if (!brand) return <span className="text-slate-400">-</span>;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap text-sm text-slate-700">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: brand.primaryColor ?? '#64748b' }} />
      <span className="truncate">{brand.name}</span>
    </span>
  );
}

export function Money({ minor, currency, className }: { minor: number | string | null | undefined; currency: string; className?: string }) {
  return <span className={cn('whitespace-nowrap tabular-nums', className)}>{money(minor, currency)}</span>;
}

/** One line per currency. Use wherever a total could span currencies: they are never summed. */
export function CurrencyList({ items, emptyLabel = '-', className }: { items: { currency: string; amountMinor: number | string }[] | null | undefined; emptyLabel?: string; className?: string }) {
  if (!items?.length) return <span className="text-slate-400">{emptyLabel}</span>;
  return (
    <span className={cn('flex flex-col', className)}>
      {items.map((i) => (
        <span key={i.currency} className="whitespace-nowrap tabular-nums">{money(i.amountMinor, i.currency)}</span>
      ))}
    </span>
  );
}

export function DateTime({ value, mode = 'datetime' }: { value: string | Date | null | undefined; mode?: 'datetime' | 'date' | 'relative' }) {
  if (!value) return <span className="text-slate-400">-</span>;
  return (
    <time dateTime={new Date(value).toISOString()} title={dateTime(value)} className="whitespace-nowrap">
      {mode === 'relative' ? relative(value) : dateTime(value, mode)}
    </time>
  );
}

// ───────────────────────── States ─────────────────────────

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('h-5 w-5 animate-spin text-slate-400', className)} />;
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('animate-pulse rounded-md bg-slate-100', className)} />;

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-400"><Inbox className="h-5 w-5" /></span>
      <p className="mt-3 text-sm font-medium text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-red-50 text-red-500"><AlertTriangle className="h-5 w-5" /></span>
      <p className="mt-3 text-sm font-medium text-slate-900">{denied ? 'You do not have access to this' : 'This could not be loaded'}</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{error?.message}</p>
      {onRetry && !denied && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// ───────────────────────── Data table ─────────────────────────

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  width?: string;
}

export function DataTable<T>({ columns, rows, loading, error, onRetry, empty, onRowClick, rowKey }: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  error?: ApiError | null;
  onRetry?: () => void;
  empty?: { title: string; description?: string; action?: ReactNode };
  onRowClick?: (row: T) => void;
  rowKey?: (row: T, index: number) => string;
}) {
  if (error && !rows.length) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/70">
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={cn('whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={cn('divide-y divide-slate-100', loading && rows.length > 0 && 'opacity-60')}>
          {loading && !rows.length
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3"><Skeleton className="h-4 w-full max-w-[9rem]" /></td>
                  ))}
                </tr>
              ))
            : rows.map((row, i) => (
                <tr
                  key={rowKey ? rowKey(row, i) : ((row as { id?: string }).id ?? i)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn('transition-colors', onRowClick && 'cursor-pointer hover:bg-slate-50')}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-3 align-middle text-slate-700', c.align === 'right' && 'text-right tabular-nums', c.align === 'center' && 'text-center', c.className)}>
                      {c.render ? c.render(row) : ((row as Record<string, ReactNode>)[c.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {!loading && !rows.length && <EmptyState title={empty?.title ?? 'Nothing to show'} description={empty?.description} action={empty?.action} />}
    </div>
  );
}

export function Pagination({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
      <span className="tabular-nums">{new Intl.NumberFormat('en-KE').format(total)} result{total === 1 ? '' : 's'}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft className="h-4 w-4" />} aria-label="Previous page" />
        <span className="tabular-nums">Page {page} of {pages}</span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} icon={<ChevronRight className="h-4 w-4" />} aria-label="Next page" />
      </div>
    </div>
  );
}

// ───────────────────────── Filters ─────────────────────────

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">{children}</div>;
}

export function SearchInput({ value, onChange, placeholder = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="relative block w-full sm:w-72">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 w-full rounded-lg border-0 bg-white pl-8 pr-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-accent-500"
      />
    </label>
  );
}

const fieldCls = 'h-9 w-full rounded-lg border-0 bg-white px-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:bg-slate-50 disabled:text-slate-500';

/** Compact filter dropdown. An empty value means "no filter". */
export function Select({ value, onChange, options, placeholder, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} className={cn(fieldCls, 'w-auto pr-8', className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export interface Range {
  preset: RangePreset;
  from: string;
  to: string;
}
export const initialRange = (preset: RangePreset = '30d'): Range => ({ preset, ...presetRange(preset) });

/** Today / Yesterday / Last 7 days / Last 30 days / This month / Previous month / Custom. */
export function DateRange({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const day = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.preset}
        onChange={(p) => onChange(p === 'custom' ? { ...value, preset: 'custom' } : { preset: p as RangePreset, ...presetRange(p as RangePreset) })}
        options={RANGE_PRESETS}
      />
      {value.preset === 'custom' && (
        <>
          <input type="date" aria-label="From" value={day(value.from)} max={day(value.to)} onChange={(e) => e.target.value && onChange({ ...value, from: new Date(`${e.target.value}T00:00:00`).toISOString() })} className={cn(fieldCls, 'w-auto')} />
          <span className="text-sm text-slate-400">to</span>
          <input type="date" aria-label="To" value={day(value.to)} min={day(value.from)} onChange={(e) => e.target.value && onChange({ ...value, to: new Date(`${e.target.value}T23:59:59`).toISOString() })} className={cn(fieldCls, 'w-auto')} />
        </>
      )}
    </div>
  );
}

/** CSV / Excel export of the list currently on screen (same filters). Needs the matching export permission. */
export function ExportMenu({ path, params, filename }: { path: string; params?: Params; filename: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    try {
      await api.download(path, { ...params, format, page: undefined, pageSize: undefined }, `${filename}.${format}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex items-center gap-1">
      <Button variant="secondary" size="sm" loading={busy === 'csv'} icon={<Download className="h-3.5 w-3.5" />} onClick={() => run('csv')}>CSV</Button>
      <Button variant="secondary" size="sm" loading={busy === 'xlsx'} icon={<Download className="h-3.5 w-3.5" />} onClick={() => run('xlsx')}>Excel</Button>
    </div>
  );
}

// ───────────────────────── Forms ─────────────────────────

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn(fieldCls, className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cn(fieldCls, 'h-auto min-h-[5.5rem] py-2', className)} {...p} />;
export function SelectInput({ className, options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select className={cn(fieldCls, className)} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
export function Checkbox({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <label className={cn('flex items-start gap-2.5 text-sm', disabled ? 'text-slate-400' : 'text-slate-700')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-accent-600 focus:ring-accent-500" />
      <span>
        {label}
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}
export function FormError({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">{error}</div>;
}

// ───────────────────────── Overlays ─────────────────────────

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/50" onClick={onClose} />
      <div className={cn('relative flex max-h-[92vh] w-full animate-fade-in flex-col rounded-t-2xl bg-white shadow-pop sm:rounded-2xl', size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-xl')}>
        <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/50" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl animate-slide-in flex-col bg-white shadow-pop">
        <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <h2 className="truncate text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">{footer}</footer>}
      </aside>
    </div>
  );
}

/**
 * A button that asks for confirmation (and optionally a written reason) before running a
 * sensitive action. Errors from the action are shown inside the dialog.
 */
export function ConfirmButton({ label, title, body, confirmLabel = 'Confirm', variant = 'secondary', size = 'md', requireReason, reasonLabel = 'Reason', icon, disabled, onConfirm }: {
  label: ReactNode;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  requireReason?: boolean;
  reasonLabel?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setReason('');
    setError(null);
  };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={variant} size={size} icon={icon} disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>
      <Modal
        open={open}
        onClose={close}
        title={title}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button variant={variant === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={requireReason && reason.trim().length < 5} onClick={go}>{confirmLabel}</Button>
          </>
        }
      >
        {body && <div className="text-sm text-slate-600">{body}</div>}
        {requireReason && (
          <Field label={reasonLabel} hint="Recorded in the audit log.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        )}
        <FormError error={error} />
      </Modal>
    </>
  );
}

// ───────────────────────── Toasts ─────────────────────────

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}
const ToastCtx = createContext<{ success: (m: string) => void; error: (m: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const value = { success: (m: string) => push('success', m), error: (m: string) => push('error', m) };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto flex animate-fade-in items-start gap-2.5 rounded-xl px-4 py-3 text-sm shadow-pop ring-1', t.kind === 'success' ? 'bg-white text-slate-800 ring-slate-200' : 'bg-red-600 text-white ring-red-700')}>
            {t.kind === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast must be used inside ToastProvider');
  return v;
}
