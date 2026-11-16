'use client';

import { Check, Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { Badge, BrandChip, Button, Card, Field, FormError, Input, KeyValue, Modal, PageHeader, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { useAction } from '@/lib/hooks';

function Copyable({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2">
      <code className={`min-w-0 flex-1 select-all break-all text-xs text-slate-800 ${mono ? 'font-mono' : ''}`}>{value}</code>
      <button
        type="button" aria-label="Copy"
        onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => undefined)}
        className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
      >
        {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function PasswordCard() {
  const toast = useToast();
  const { run, loading } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('Choose a password different from the current one.');
    const ok = await run(() => api.post('/v1/admin/auth/password', { currentPassword: current, newPassword: next }), { onError: (er) => setError(er.message) });
    if (ok) {
      toast.success('Password changed. Your other sessions have been signed out.');
      setCurrent('');
      setNext('');
      setConfirm('');
    }
  };
  return (
    <Card title="Password" description="At least 12 characters. Changing it signs out every other session.">
      <form onSubmit={submit} className="max-w-md space-y-4">
        <Field label="Current password"><Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password"><Input type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Confirm new password"><Input type="password" autoComplete="new-password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <FormError error={error} />
        <Button type="submit" loading={loading}>Change password</Button>
      </form>
    </Card>
  );
}

function TwoStepCard() {
  const { user, reloadUser } = useAuth();
  const toast = useToast();
  const { run, loading } = useAction();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');

  const start = async () => {
    setError(null);
    const res = await run(() => api.post('/v1/admin/auth/mfa/setup'), { onError: (e) => toast.error(e.message) });
    if (res) setSetup(res);
  };
  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const ok = await run(() => api.post('/v1/admin/auth/mfa/enable', { code }), { onError: (er) => setError(er.message) });
    if (ok) {
      toast.success('Two-step verification is on. Your other sessions have been signed out.');
      setSetup(null);
      setCode('');
      await reloadUser();
    }
  };
  const disable = async () => {
    setError(null);
    const ok = await run(() => api.post('/v1/admin/auth/mfa/disable', { password, code }), { onError: (er) => setError(er.message) });
    if (ok) {
      toast.success('Two-step verification turned off');
      setDisabling(false);
      setPassword('');
      setCode('');
      await reloadUser();
    }
  };
  const codeInput = (
    <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-40 text-center text-lg tracking-[0.35em]" />
  );

  return (
    <Card
      title="Two-step verification"
      description="A 6-digit code from an authenticator app is required at sign-in, in addition to your password."
      actions={user.mfaEnabled ? <Badge tone="green">On</Badge> : <Badge tone="amber">Off</Badge>}
    >
      {user.mfaEnabled ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3 text-sm text-slate-600">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <span>Your account is protected with an authenticator app. Keep it on: administrator accounts can move money and see customer data.</span>
          </div>
          <Button variant="secondary" icon={<ShieldOff className="h-4 w-4" />} onClick={() => { setDisabling(true); setError(null); setCode(''); }}>Turn off</Button>
        </div>
      ) : !setup ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-xl text-sm text-slate-600">Recommended for every staff account. You will need an authenticator app such as Google Authenticator, Microsoft Authenticator, Authy or 1Password.</p>
          <Button loading={loading} icon={<ShieldCheck className="h-4 w-4" />} onClick={start}>Set up two-step verification</Button>
        </div>
      ) : (
        <form onSubmit={enable} className="max-w-xl space-y-5">
          <ol className="space-y-5 text-sm text-slate-700">
            <li>
              <p className="font-medium text-slate-900">1. Add this account to your authenticator app</p>
              <p className="mt-1 text-slate-600">Choose &quot;Enter a setup key&quot; in the app, use your email as the account name, select time-based, and enter this key:</p>
              <div className="mt-2"><Copyable value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} /></div>
              <details className="mt-2 text-xs text-slate-500">
                <summary className="cursor-pointer font-medium text-slate-600">Use a setup link instead</summary>
                <p className="mt-2">Password managers and some authenticator apps accept this link directly. Treat it like a password.</p>
                <div className="mt-2"><Copyable value={setup.otpauthUri} /></div>
              </details>
            </li>
            <li>
              <p className="font-medium text-slate-900">2. Enter the 6-digit code the app shows</p>
              <div className="mt-2">{codeInput}</div>
            </li>
          </ol>
          <FormError error={error} />
          <div className="flex gap-2">
            <Button type="submit" loading={loading} disabled={code.length !== 6}>Turn on</Button>
            <Button variant="secondary" onClick={() => { setSetup(null); setCode(''); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}

      <Modal
        open={disabling} onClose={() => setDisabling(false)} title="Turn off two-step verification?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDisabling(false)}>Keep it on</Button><Button variant="danger" loading={loading} disabled={!password || code.length !== 6} onClick={disable}>Turn off</Button></>}
      >
        <p className="text-sm text-slate-600">Your account will be protected by your password alone. Confirm with your password and a current code.</p>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Authentication code">{codeInput}</Field>
        <FormError error={error} />
      </Modal>
    </Card>
  );
}

export default function AccountPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="Account & security" description="Your staff profile, password and sign-in protection." />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <TwoStepCard />
          <PasswordCard />
        </div>
        <Card title="Profile">
          <KeyValue
            columns={1}
            items={[
              { label: 'Name', value: user.fullName },
              { label: 'Email', value: user.email },
              { label: 'Roles', value: <div className="flex flex-wrap gap-1.5">{user.roles.map((r) => <Badge key={r} tone="indigo">{humanize(r)}</Badge>)}</div> },
              {
                label: 'Brand access',
                value: user.allBrands ? 'All brands (platform-wide)' : <div className="flex flex-col gap-1">{user.brands.map((b) => <BrandChip key={b.id} brand={b} />)}</div>,
              },
              ...(user.eventScoped ? [{ label: 'Event access', value: 'Only events assigned to you' }] : []),
              { label: 'Permissions', value: `${user.permissions.length} granted` },
            ]}
          />
          <p className="mt-4 text-xs text-slate-500">Your name, roles and brand access are managed by an administrator in Staff &amp; Permissions.</p>
        </Card>
      </div>
    </>
  );
}
