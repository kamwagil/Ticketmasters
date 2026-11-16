'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, Checkbox, Field, FormError, Input, Modal, SelectInput, Skeleton, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { number } from '@/lib/format';
import { useAction, useQuery } from '@/lib/hooks';
import { BrandField, CHANNEL_LABEL, CHANNELS, useBrandChoice } from './shared';

/** Create or edit a campaign. A campaign is sent as one brand, to that brand's own segments only. */
export function CampaignForm({ campaign, onClose, onDone }: { campaign?: any; onClose: () => void; onDone: (saved: any) => void }) {
  const toast = useToast();
  const choice = useBrandChoice(campaign?.brandId ?? '');
  const brandId: string = campaign?.brandId ?? choice.brandId;
  const [name, setName] = useState<string>(campaign?.name ?? '');
  const [channel, setChannel] = useState<string>(campaign?.channel ?? 'EMAIL');
  const [subject, setSubject] = useState<string>(campaign?.subject ?? '');
  const [bodyHtml, setBodyHtml] = useState<string>(campaign?.bodyHtml ?? '');
  const [segmentIds, setSegmentIds] = useState<string[]>(campaign?.segments?.map((s: any) => s.id) ?? campaign?.segmentIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const { run, loading } = useAction();
  const segments = useQuery<any[]>(brandId ? '/v1/admin/segments' : null, { brandId }, { scoped: false });
  const email = channel === 'EMAIL';

  const save = async () => {
    setError(null);
    const common = { name: name.trim(), bodyHtml, segmentIds, ...(email ? { subject: subject.trim() } : {}) };
    const res = await run(
      () => (campaign ? api.patch(`/v1/admin/marketing/campaigns/${campaign.id}`, common) : api.post('/v1/admin/marketing/campaigns', { brandId, channel, ...common })),
      { onError: (e) => setError(e.message) },
    );
    if (res) {
      toast.success(campaign ? 'Campaign saved' : 'Draft campaign created');
      onDone(res);
      onClose();
    }
  };
  const valid = brandId && name.trim().length >= 2 && bodyHtml.trim() && segmentIds.length > 0 && (!email || subject.trim());

  return (
    <Modal
      open onClose={onClose} size="lg" title={campaign ? 'Edit campaign' : 'New campaign'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={!valid} onClick={save}>{campaign ? 'Save changes' : 'Save as draft'}</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <BrandField value={brandId} onChange={(v) => { choice.setBrandId(v); setSegmentIds([]); }} locked={!!campaign || choice.locked} label="Sending brand" hint="The campaign is sent with this brand's name, sender address and unsubscribe link." />
        <Field label="Channel">
          <SelectInput value={channel} disabled={!!campaign} onChange={(e) => setChannel(e.target.value)} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
        </Field>
      </div>
      <Field label="Campaign name" hint="Internal. Customers do not see it."><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {email && <Field label="Email subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>}
      <Field
        label={email ? 'Email content (HTML)' : 'Message'}
        hint={email
          ? <>Use <code>{'{{name}}'}</code> for the customer&apos;s first name. Links are tracked, and the brand&apos;s header, footer and unsubscribe link are added automatically.</>
          : <>Use <code>{'{{name}}'}</code> for the customer&apos;s first name. Formatting is removed for {CHANNEL_LABEL[channel]} messages.</>}
      >
        <Textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} className="min-h-[11rem] font-mono text-[13px]" placeholder={email ? '<h2>Hi {{name}},</h2>\n<p>Tickets for our next show are on sale now.</p>' : 'Hi {{name}}, tickets for our next show are on sale now.'} />
      </Field>
      <div>
        <div className="mb-1 text-sm font-medium text-slate-700">Audience</div>
        <p className="mb-2 text-xs text-slate-500">
          Only this brand&apos;s segments can be used: an audience never crosses brands. Customers in several segments receive one message, and only those with current consent to this brand on this channel are sent anything.
        </p>
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          {!brandId && <p className="text-sm text-slate-500">Choose the sending brand to see its segments.</p>}
          {segments.loading && <Skeleton className="h-5 w-48" />}
          {segments.data?.map((s) => (
            <Checkbox
              key={s.id} checked={segmentIds.includes(s.id)} onChange={(v) => setSegmentIds((x) => (v ? [...x, s.id] : x.filter((i) => i !== s.id)))}
              label={s.name} hint={s.lastCount === null ? 'Not evaluated yet' : `${number(s.lastCount)} customers at last evaluation`}
            />
          ))}
          {brandId && segments.data && !segments.data.length && (
            <p className="text-sm text-slate-500">This brand has no segments yet. Create one in <Link href="/crm" className="text-accent-700 hover:underline">CRM → Segments</Link>.</p>
          )}
        </div>
      </div>
      <FormError error={error ?? segments.error?.message} />
    </Modal>
  );
}
