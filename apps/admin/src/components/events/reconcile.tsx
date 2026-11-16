'use client';

import { CheckCircle2, ScanSearch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button, FormError, Modal } from '@/components/ui';
import { api } from '@/lib/api';
import { number } from '@/lib/format';
import { useAction } from '@/lib/hooks';

interface Result {
  checked: number;
  issues: { ticketCategoryId: string; eventId: string; name: string; problem: string }[];
}

/**
 * Runs the inventory reconciliation (counters vs movement ledger, active reservations and
 * issued tickets) for one event, or platform-wide when no event is given.
 */
export function ReconcileButton({ eventId, size = 'md' }: { eventId?: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const start = async () => {
    setOpen(true);
    setResult(null);
    setError(null);
    const res = await run(() => api.post<Result>(`/v1/admin/inventory/reconcile${eventId ? `?eventId=${eventId}` : ''}`), { onError: (e) => setError(e.message) });
    if (res) setResult(res);
  };
  return (
    <>
      <Button variant="secondary" size={size} icon={<ScanSearch className="h-4 w-4" />} onClick={start}>Run reconciliation</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Inventory reconciliation" footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        {loading && <p className="text-sm text-slate-600">Checking counters against the movement ledger, reservations and issued tickets...</p>}
        <FormError error={error} />
        {result && result.issues.length === 0 && (
          <div className="flex items-start gap-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <span><strong>All clear.</strong> {number(result.checked)} ticket categor{result.checked === 1 ? 'y' : 'ies'} checked; every counter agrees with its ledger, reservations and tickets.</span>
          </div>
        )}
        {result && result.issues.length > 0 && (
          <>
            <div className="flex items-start gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-inset ring-red-200">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" />
              <span><strong>{result.issues.length} inconsistenc{result.issues.length === 1 ? 'y' : 'ies'} found</strong> across {number(result.checked)} categories. Critical alerts have been raised. Counters are never corrected automatically.</span>
            </div>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
              {result.issues.map((i, n) => (
                <li key={n} className="px-3 py-2"><span className="font-medium text-slate-900">{i.name}</span><span className="block text-slate-600">{i.problem}</span></li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </>
  );
}
