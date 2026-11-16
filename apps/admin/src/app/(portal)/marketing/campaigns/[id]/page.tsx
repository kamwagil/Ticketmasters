'use client';

import { CalendarClock, Pencil, Send } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CampaignForm } from '@/components/crm/campaign-form';
import { CHANNEL_LABEL, fromLocalInput } from '@/components/crm/shared';
import {
  Badge, BrandChip, Button, Card, ConfirmButton, CurrencyList, DateTime, ErrorState, Field, FormError, Input, KeyValue, Modal, PageHeader, Skeleton, StatCard, StatusBadge, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize, number, percent } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';

const SKIP_LABEL: Record<string, string> = { NO_CONSENT: 'No marketing consent for this brand and channel', NO_ADDRESS: 'No address for this channel', OTHER: 'Other' };

function PromptDialog({ title, label, type, hint, confirm, onClose, onSubmit }: { title: string; label: string; type: string; hint: string; confirm: string; onClose: () => void; onSubmit: (v: string) => Promise<unknown> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const go = async () => {
    setError(null);
    const res = await run(() => onSubmit(value).then(() => true), { onError: (e) => setError(e.message) });
    if (res) onClose();
  };
  return (
    <Modal open onClose={onClose} size="sm" title={title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!value} onClick={go}>{confirm}</Button></>}>
      <Field label={label} hint={hint}><Input type={type} value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></Field>
      <FormError error={error} />
    </Modal>
  );
}

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const { can, brands } = useAuth();
  const toast = useToast();
  const { data: c, loading, error, reload } = useQuery<any>(`/v1/admin/marketing/campaigns/${id}`, undefined, { scoped: false, refreshMs: 15_000 });
  const [dialog, setDialog] = useState<null | 'edit' | 'test' | 'schedule'>(null);

  if (error && !c) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !c) return <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-24 w-full" /><Skeleton className="h-80 w-full" /></div>;
  if (!c) return null;

  const s = c.stats ?? {};
  const editable = ['DRAFT', 'SCHEDULED'].includes(c.status);
  const manage = can('marketing.manage');
  const email = c.channel === 'EMAIL';
  const estimate = (c.segments ?? []).reduce((n: number, x: any) => n + (x.lastCount ?? 0), 0);
  const unevaluated = (c.segments ?? []).some((x: any) => x.lastCount === null);
  const brand = brands.find((b) => b.id === c.brandId);

  return (
    <>
      <PageHeader
        back="/marketing"
        title={<span className="flex flex-wrap items-center gap-3">{c.name}<StatusBadge status={c.status} /></span>}
        description={<span className="flex flex-wrap items-center gap-x-2 gap-y-1">{CHANNEL_LABEL[c.channel]} campaign sent as <BrandChip brand={brand} />{c.status === 'SCHEDULED' && c.scheduledAt && <>· scheduled for <DateTime value={c.scheduledAt} /></>}{c.sentAt && <>· sent <DateTime value={c.sentAt} /></>}</span>}
        actions={
          manage && (
            <>
              <Button variant="secondary" icon={<Send className="h-4 w-4" />} onClick={() => setDialog('test')}>Send test</Button>
              {editable && (
                <>
                  <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setDialog('edit')}>Edit</Button>
                  <Button variant="secondary" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setDialog('schedule')}>Schedule</Button>
                  <ConfirmButton
                    label="Cancel campaign" variant="ghost" title="Cancel this campaign?" confirmLabel="Cancel campaign" body="It will not be sent. You can create a new campaign later."
                    onConfirm={() => api.post(`/v1/admin/marketing/campaigns/${id}/cancel`).then(() => { toast.success('Campaign cancelled'); reload(); })}
                  />
                  <ConfirmButton
                    label="Send now" variant="primary" icon={<Send className="h-4 w-4" />} title="Send this campaign now?" confirmLabel="Send campaign"
                    body={
                      <div className="space-y-2">
                        <p>
                          Audience: <strong>{unevaluated ? 'not yet evaluated' : `up to ${number(estimate)} customers`}</strong> across {c.segments.length} segment{c.segments.length === 1 ? '' : 's'}
                          {!unevaluated && c.segments.length > 1 && ' (customers in several segments are counted once when sending)'}.
                        </p>
                        <p>Only customers who currently consent to <strong>{brand?.name ?? 'this brand'}</strong> marketing by {CHANNEL_LABEL[c.channel]} will receive it. Everyone else is skipped and reported. Sending cannot be undone.</p>
                      </div>
                    }
                    onConfirm={() => api.post(`/v1/admin/marketing/campaigns/${id}/send-now`).then(() => { toast.success('Campaign is being sent'); reload(); })}
                  />
                </>
              )}
            </>
          )
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Audience" value={number(s.audience ?? 0)} hint={`${number(s.skipped ?? 0)} skipped`} />
        <StatCard label="Sent" value={number(s.sent ?? 0)} hint={`${number(s.failed ?? 0)} failed · ${number(s.pending ?? 0)} pending`} tone={s.failed ? 'warn' : 'default'} />
        <StatCard label="Opens" value={email ? number(s.opens ?? 0) : '-'} hint={email ? `${percent(s.openRate ?? 0)} of sent` : 'Email only'} />
        <StatCard label="Clicks" value={email ? number(s.clicks ?? 0) : '-'} hint={email ? `${percent(s.clickRate ?? 0)} of sent · ${number(s.totalClicks ?? 0)} total` : 'Email only'} />
        <StatCard label="Unsubscribes" value={number(s.unsubscribes ?? 0)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Content" description={email ? 'Shown without the brand header and footer, which are added when sending' : undefined} padded={false}>
            {email && <div className="border-b border-slate-100 px-5 py-3 text-sm"><span className="text-slate-500">Subject: </span><span className="font-medium text-slate-900">{c.subject || '-'}</span></div>}
            {email ? (
              // sandbox="" gives the campaign HTML a unique origin with scripts, forms and navigation disabled.
              <iframe title="Campaign content preview" sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><body style="margin:0;padding:20px;font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">${c.bodyHtml}</body>`} className="h-[30rem] w-full rounded-b-xl bg-white" />
            ) : (
              <pre className="whitespace-pre-wrap px-5 py-4 font-sans text-sm text-slate-800">{c.bodyHtml}</pre>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Audience">
            <ul className="space-y-2 text-sm">
              {(c.segments ?? []).map((x: any) => (
                <li key={x.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-800">{x.name}</span>
                  <span className="shrink-0 text-slate-500">{x.lastCount === null ? 'not evaluated' : number(x.lastCount)}</span>
                </li>
              ))}
              {!c.segments?.length && <li className="text-slate-500">No segments attached.</li>}
            </ul>
            <p className="mt-3 text-xs text-slate-500">All segments belong to {brand?.name ?? 'the sending brand'}. Audiences cannot include another brand&apos;s customers.</p>
          </Card>

          <Card title="Delivery breakdown">
            <dl className="space-y-2 text-sm">
              {[['Sent', s.sent], ['Awaiting delivery', s.pending], ['Failed', s.failed], ['Skipped', s.skipped]].map(([l, v]) => (
                <div key={l as string} className="flex items-center justify-between"><dt className="text-slate-600">{l}</dt><dd className="font-medium tabular-nums text-slate-900">{number((v as number) ?? 0)}</dd></div>
              ))}
            </dl>
            {Object.keys(s.skippedByReason ?? {}).length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Why recipients were skipped</div>
                <ul className="space-y-1.5 text-sm">
                  {Object.entries(s.skippedByReason as Record<string, number>).map(([reason, n]) => (
                    <li key={reason} className="flex items-start justify-between gap-3"><span className="text-slate-600">{SKIP_LABEL[reason] ?? humanize(reason)}</span><Badge tone={reason === 'NO_CONSENT' ? 'amber' : 'gray'}>{number(n)}</Badge></li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="Conversions" description="Paid orders attributed to this campaign">
            <KeyValue
              columns={1}
              items={[
                { label: 'Orders', value: `${number(s.conversions ?? 0)} (${percent(s.conversionRate ?? 0)} of sent)` },
                { label: 'Attributed revenue', value: <CurrencyList items={(s.revenueByCurrency ?? []).map((r: any) => ({ currency: r.currency, amountMinor: r.revenueMinor }))} emptyLabel="None yet" className="font-semibold" /> },
              ]}
            />
          </Card>
        </div>
      </div>

      {dialog === 'edit' && <CampaignForm campaign={c} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'test' && (
        <PromptDialog
          title="Send a test" label={email ? 'Email address' : 'Phone number'} type={email ? 'email' : 'tel'} confirm="Send test" onClose={() => setDialog(null)}
          hint="One copy marked [TEST] is sent. It is not counted in the campaign results."
          onSubmit={(to) => api.post(`/v1/admin/marketing/campaigns/${id}/test`, { to: to.trim() }).then(() => toast.success(`Test queued to ${to.trim()}`))}
        />
      )}
      {dialog === 'schedule' && (
        <PromptDialog
          title="Schedule campaign" label="Send at" type="datetime-local" confirm="Schedule" onClose={() => setDialog(null)}
          hint="Your local time. Consent is checked again at the moment of sending."
          onSubmit={(v) => api.post(`/v1/admin/marketing/campaigns/${id}/schedule`, { scheduledAt: fromLocalInput(v) }).then(() => { toast.success('Campaign scheduled'); reload(); })}
        />
      )}
    </>
  );
}
