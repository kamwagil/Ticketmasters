'use client';

import { Lock, Plus, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CheckList, Notice } from '@/components/platform/bits';
import {
  Badge, Button, Card, Checkbox, Column, ConfirmButton, DataTable, DateTime, ErrorState, Field, FormError, Input, Modal, PageHeader, Pagination, SearchInput, Skeleton,
  StatusBadge, Tabs, Textarea, Toolbar, useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { useAction, useDebounced, usePaged, useQuery } from '@/lib/hooks';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  eventScoped: boolean;
  userCount: number;
  permissions: string[];
}

function StaffForm({ member, roles, onClose, onDone }: { member?: any; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { brands, user } = useAuth();
  const { run, loading } = useAction();
  const [error, setError] = useState<string | null>(null);
  const [fullName, setFullName] = useState(member?.fullName ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>(member?.roles.map((r: any) => r.role.id) ?? []);
  const [brandIds, setBrandIds] = useState<string[]>(member?.brandAssignments.map((b: any) => b.brand.id) ?? []);
  const [eventIds, setEventIds] = useState<string[]>(member?.eventAssignments.map((e: any) => e.event.id) ?? []);
  const [allBrands, setAllBrands] = useState<boolean>(member?.allBrands ?? false);
  const eventScoped = roles.some((r) => roleIds.includes(r.id) && r.eventScoped);
  const events = useQuery<{ items: any[] }>(eventScoped ? '/v1/admin/events' : null, { pageSize: 100 }, { scoped: false });
  // Events the user is already assigned to stay selectable even if they fall outside the first page.
  const eventOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of member?.eventAssignments ?? []) map.set(e.event.id, e.event.name);
    for (const e of events.data?.items ?? []) map.set(e.id, e.name);
    return [...map].map(([value, label]) => ({ value, label }));
  }, [events.data, member]);

  const submit = async () => {
    setError(null);
    if (password && password.length < 12) return setError('The password must be at least 12 characters.');
    if (!roleIds.length) return setError('Choose at least one role.');
    if (!allBrands && !brandIds.length) return setError('Assign at least one brand, or grant access to all brands.');
    const body: Record<string, unknown> = { fullName: fullName.trim(), roleIds, brandIds: allBrands ? [] : brandIds, eventIds: eventScoped ? eventIds : [], ...(user.allBrands ? { allBrands } : {}) };
    if (password) body.password = password;
    if (!member) body.email = email.trim();
    const res = await run(() => (member ? api.patch(`/v1/admin/staff/${member.id}`, body) : api.post('/v1/admin/staff', body)), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success(member ? 'Staff member updated' : 'Staff member created');
      onDone();
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={member ? `Edit ${member.fullName}` : 'New staff member'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={loading} disabled={fullName.trim().length < 2 || (!member && (!email.includes('@') || password.length < 12))} onClick={submit}>{member ? 'Save changes' : 'Create account'}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name"><Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus /></Field>
        <Field label="Work email" hint={member ? 'The sign-in email cannot be changed.' : undefined}><Input type="email" value={email} disabled={!!member} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
      </div>
      <Field label={member ? 'Set a new password (optional)' : 'Initial password'} hint={member ? 'At least 12 characters. Setting it signs the person out everywhere.' : 'At least 12 characters. Share it securely and ask them to change it and turn on two-step sign-in.'}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Roles" hint="You can only grant roles whose permissions you hold yourself.">
        <CheckList value={roleIds} onChange={setRoleIds} options={roles.map((r) => ({ value: r.id, label: r.name, hint: r.description ?? undefined }))} />
      </Field>
      {user.allBrands && <Checkbox checked={allBrands} onChange={setAllBrands} label="Access to all brands" hint="Platform-wide staff see every storefront, including brands added later." />}
      {!allBrands && (
        <Field label="Brands" hint="This person only ever sees data belonging to these brands.">
          <CheckList value={brandIds} onChange={setBrandIds} options={brands.map((b) => ({ value: b.id, label: b.name }))} />
        </Field>
      )}
      {eventScoped && (
        <Field label="Assigned events" hint="Event-scoped roles (event managers, ticket scanners) only work on the events selected here.">
          <CheckList value={eventIds} onChange={setEventIds} options={eventOptions} empty={events.loading ? 'Loading events' : 'No events available'} />
        </Field>
      )}
      <FormError error={error} />
    </Modal>
  );
}

function StaffTab({ roles }: { roles: Role[] }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const list = usePaged<any>('/v1/admin/staff', { q: useDebounced(q) });
  const manage = can('staff.manage');
  const { run } = useAction();
  const setStatus = async (m: any, status: 'ACTIVE' | 'SUSPENDED') => {
    const res = await run(() => api.patch(`/v1/admin/staff/${m.id}`, { status }), { onError: (e) => toast.error(e.message) });
    if (res) {
      toast.success(status === 'ACTIVE' ? `${m.fullName} reactivated` : `${m.fullName} suspended and signed out`);
      list.reload();
    }
  };

  const columns: Column<any>[] = [
    { key: 'name', header: 'Staff member', render: (m) => <div className="max-w-[16rem]"><div className="truncate font-medium text-slate-900">{m.fullName}{m.id === user.id && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}</div><div className="truncate text-xs text-slate-500">{m.email}</div></div> },
    { key: 'roles', header: 'Roles', render: (m) => <div className="flex max-w-[16rem] flex-wrap gap-1">{m.roles.map((r: any) => <Badge key={r.role.id} tone="indigo">{r.role.name}</Badge>)}</div> },
    { key: 'brands', header: 'Brands', render: (m) => (m.allBrands ? <Badge tone="purple">All brands</Badge> : <span className="block max-w-[14rem] truncate text-sm" title={m.brandAssignments.map((b: any) => b.brand.name).join(', ')}>{m.brandAssignments.map((b: any) => b.brand.name).join(', ') || '-'}</span>) },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
    { key: 'mfa', header: 'Two-step sign-in', render: (m) => <Badge tone={m.mfaEnabled ? 'green' : 'amber'}>{m.mfaEnabled ? 'On' : 'Off'}</Badge> },
    { key: 'lastLoginAt', header: 'Last sign-in', render: (m) => <DateTime value={m.lastLoginAt} mode="relative" /> },
    {
      key: 'actions', header: '', align: 'right',
      render: (m) => manage && (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>Edit</Button>
          {m.id !== user.id && (m.status === 'SUSPENDED'
            ? <Button size="sm" variant="ghost" onClick={() => setStatus(m, 'ACTIVE')}>Reactivate</Button>
            : <ConfirmButton size="sm" variant="ghost" label="Suspend" title={`Suspend ${m.fullName}?`} confirmLabel="Suspend" body="They are signed out immediately and cannot sign in until reactivated." onConfirm={() => setStatus(m, 'SUSPENDED')} />)}
          {m.id !== user.id && (
            <ConfirmButton
              size="sm" variant="danger" label="" icon={<Trash2 className="h-3.5 w-3.5" />} title={`Delete ${m.fullName}?`} confirmLabel="Delete account"
              body="The account is removed and all sessions end. Their past actions stay in the audit log."
              onConfirm={() => api.delete(`/v1/admin/staff/${m.id}`).then(() => { toast.success('Staff member deleted'); list.reload(); })}
            />
          )}
        </div>
      ),
    },
  ];
  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Name or email" />
        {manage && <div className="ml-auto"><Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>New staff member</Button></div>}
      </Toolbar>
      <DataTable columns={columns} rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} empty={{ title: 'No staff found' }} />
      <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} />
      {editing && <StaffForm member={editing === 'new' ? undefined : editing} roles={roles} onClose={() => setEditing(null)} onDone={list.reload} />}
    </Card>
  );
}

function NewRole({ onClose, onDone }: { onClose: () => void; onDone: (r: any) => void }) {
  const toast = useToast();
  const { run, loading } = useAction();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [eventScoped, setEventScoped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const derived = key || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const submit = async () => {
    setError(null);
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(derived)) return setError('The key must start with a letter and use 3 to 41 lowercase letters, digits or underscores.');
    const res = await run(() => api.post('/v1/admin/roles', { key: derived, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), eventScoped, permissions: [] }), { onError: (e) => setError(e.message) });
    if (res) {
      toast.success('Role created. Now choose its permissions.');
      onDone(res);
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="New role" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={name.trim().length < 2} onClick={submit}>Create role</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Regional Finance Lead" /></Field>
      <Field label="Key" hint="Permanent identifier."><Input value={derived} onChange={(e) => setKey(e.target.value)} className="font-mono" /></Field>
      <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Checkbox checked={eventScoped} onChange={setEventScoped} label="Event-scoped" hint="Holders only see events explicitly assigned to them." />
      <FormError error={error} />
    </Modal>
  );
}

function RolesTab({ roles, reload }: { roles: Role[]; reload: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const perms = useQuery<{ key: string; group: string; description: string }[]>('/v1/admin/permissions', undefined, { scoped: false });
  const manage = can('roles.manage');
  const [selected, setSelected] = useState<string>(roles[0]?.id ?? '');
  const [draft, setDraft] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const { run, loading } = useAction();
  const role = roles.find((r) => r.id === selected) ?? roles[0];
  useEffect(() => setDraft(role?.permissions ?? []), [role?.id, role?.permissions.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; description: string }[]>();
    for (const p of perms.data ?? []) map.set(p.group, [...(map.get(p.group) ?? []), p]);
    return [...map.entries()];
  }, [perms.data]);
  if (!role) return <Card><p className="text-sm text-slate-500">No roles defined.</p></Card>;
  const locked = role.key === 'super_admin' || !manage;
  const dirty = [...draft].sort().join(',') !== [...role.permissions].sort().join(',');
  const save = async () => {
    const res = await run(() => api.patch(`/v1/admin/roles/${role.id}`, { permissions: draft }), { onError: (e) => toast.error(e.message) });
    if (res) {
      toast.success(`Permissions updated for ${role.name}. They apply from each holder's next request.`);
      reload();
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
      <Card padded={false} title="Roles" actions={manage && <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>New</Button>}>
        <ul className="divide-y divide-slate-100">
          {roles.map((r) => (
            <li key={r.id}>
              <button onClick={() => setSelected(r.id)} className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50 ${r.id === role.id ? 'bg-accent-50' : ''}`}>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium text-slate-900">{r.name}{r.key === 'super_admin' && <Lock className="h-3 w-3 text-slate-400" />}</span>
                  <span className="text-xs text-slate-500">{r.userCount} staff · {r.permissions.length} permissions{r.eventScoped ? ' · event-scoped' : ''}</span>
                </span>
                {!r.isSystem && <Badge tone="blue">Custom</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title={role.name}
        description={role.description ?? undefined}
        actions={
          manage && (
            <>
              {!role.isSystem && (
                <ConfirmButton
                  size="sm" variant="danger" label="Delete role" title={`Delete the role "${role.name}"?`} confirmLabel="Delete role" body="A role can only be deleted once no staff member holds it."
                  onConfirm={() => api.delete(`/v1/admin/roles/${role.id}`).then(() => { toast.success('Role deleted'); setSelected(''); reload(); })}
                />
              )}
              {!locked && <Button size="sm" loading={loading} disabled={!dirty} onClick={save}>Save permissions</Button>}
            </>
          )
        }
      >
        {role.key === 'super_admin' && <div className="mb-4"><Notice>The Super Administrator role is locked: it always holds every permission.</Notice></div>}
        {perms.error ? <ErrorState error={perms.error} onRetry={perms.reload} /> : !perms.data ? <Skeleton className="h-64" /> : (
          <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
            {groups.map(([group, items]) => (
              <fieldset key={group}>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{humanize(group)}</legend>
                <div className="space-y-2">
                  {items.map((p) => (
                    <Checkbox key={p.key} disabled={locked} checked={draft.includes(p.key)} onChange={(v) => setDraft((d) => (v ? [...d, p.key] : d.filter((x) => x !== p.key)))} label={p.description} hint={p.key} />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}
      </Card>
      {creating && <NewRole onClose={() => setCreating(false)} onDone={(r) => { reload(); setSelected(r.id); }} />}
    </div>
  );
}

export default function StaffPage() {
  const router = useRouter();
  const params = useSearchParams();
  const roles = useQuery<Role[]>('/v1/admin/roles', undefined, { scoped: false });
  const active = params.get('tab') === 'roles' ? 'roles' : 'staff';
  return (
    <>
      <PageHeader title="Staff & Permissions" description="Who can sign in to this portal, which brands and events they work on, and what each role is allowed to do. Every change is recorded in the audit log." />
      <Tabs tabs={[{ id: 'staff', label: 'Staff' }, { id: 'roles', label: 'Roles', count: roles.data?.length }]} active={active} onChange={(id) => router.replace(`/staff?tab=${id}`)} />
      {roles.error ? <ErrorState error={roles.error} onRetry={roles.reload} /> : !roles.data ? <Skeleton className="h-64" /> : active === 'staff' ? <StaffTab roles={roles.data} /> : <RolesTab roles={roles.data} reload={roles.reload} />}
    </>
  );
}
