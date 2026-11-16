'use client';

import {
  BarChart3, Bell, Boxes, Building2, CalendarDays, ChevronDown, CreditCard, FileClock, Handshake, Headphones, LayoutDashboard, LogOut, Megaphone, Menu,
  Plug, QrCode, Receipt, RotateCcw, Search, Settings, ShieldCheck, Store, Ticket, UserCircle, Users, UsersRound, Wallet, X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { relative } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { Badge, cn } from './ui';

/** Primary navigation. `permission` hides sections the user cannot use; the API enforces access regardless. */
export const NAV: { href: string; label: string; icon: typeof Store; permission: string }[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, permission: 'reports.read' },
  { href: '/brands', label: 'Brands', icon: Store, permission: 'brands.read' },
  { href: '/events', label: 'Events', icon: CalendarDays, permission: 'events.read' },
  { href: '/inventory', label: 'Inventory', icon: Boxes, permission: 'inventory.read' },
  { href: '/orders', label: 'Orders', icon: Receipt, permission: 'orders.read' },
  { href: '/payments', label: 'Payments', icon: CreditCard, permission: 'payments.read' },
  { href: '/tickets', label: 'Tickets', icon: Ticket, permission: 'tickets.read' },
  { href: '/customers', label: 'Customers', icon: Users, permission: 'customers.read' },
  { href: '/crm', label: 'CRM', icon: UsersRound, permission: 'crm.segments' },
  { href: '/marketing', label: 'Marketing', icon: Megaphone, permission: 'marketing.read' },
  { href: '/organizers', label: 'Sellers & Promoters', icon: Handshake, permission: 'organizers.read' },
  { href: '/settlements', label: 'Settlements', icon: Wallet, permission: 'settlements.read' },
  { href: '/refunds', label: 'Refunds', icon: RotateCcw, permission: 'refunds.read' },
  { href: '/support', label: 'Customer Support', icon: Headphones, permission: 'support.read' },
  { href: '/reports', label: 'Reports & Analytics', icon: BarChart3, permission: 'reports.read' },
  { href: '/staff', label: 'Staff & Permissions', icon: ShieldCheck, permission: 'staff.read' },
  { href: '/integrations', label: 'Integrations', icon: Plug, permission: 'integrations.read' },
  { href: '/audit', label: 'Audit Logs', icon: FileClock, permission: 'audit.read' },
  { href: '/settings', label: 'Settings', icon: Settings, permission: 'brands.read' },
];

const isActive = (pathname: string, href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

function useClickOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return ref;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can } = useAuth();
  return (
    <div className="flex h-full flex-col bg-ink-900 text-slate-300">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-600 text-white"><Ticket className="h-4 w-4" /></span>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">Central Ticketing</div>
          <div className="text-[11px] text-slate-400">Management platform</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4" aria-label="Primary">
        {NAV.filter((n) => can(n.permission)).map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                active ? 'bg-ink-700 text-white' : 'text-slate-300 hover:bg-ink-800 hover:text-white',
              )}
            >
              <n.icon className={cn('h-4 w-4 shrink-0', active ? 'text-accent-500' : 'text-slate-500 group-hover:text-slate-300')} />
              {n.label}
            </Link>
          );
        })}
      </nav>
      {can('tickets.scan') && (
        <div className="border-t border-ink-700 p-3">
          <Link href="/scan" className="flex items-center gap-3 rounded-lg bg-ink-800 px-3 py-2.5 text-[13px] font-medium text-white hover:bg-ink-700">
            <QrCode className="h-4 w-4 text-accent-500" /> Open ticket scanner
          </Link>
        </div>
      )}
    </div>
  );
}

/** Global brand selector. Choosing a brand filters every list, dashboard and report to that storefront. */
function BrandSelector() {
  const { brands, brandId, brand, setBrandId, user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const single = !user.allBrands && brands.length === 1;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => !single && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn('flex h-9 max-w-[15rem] items-center gap-2 rounded-lg bg-white px-3 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300', !single && 'hover:bg-slate-50')}
      >
        {brand ? <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: brand.primaryColor }} /> : <Building2 className="h-4 w-4 shrink-0 text-slate-400" />}
        <span className="truncate">{brand?.name ?? 'All brands'}</span>
        {!single && <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 z-40 mt-1.5 w-64 animate-fade-in rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop">
          {(user.allBrands || brands.length > 1) && (
            <button role="option" aria-selected={!brandId} onClick={() => { setBrandId(null); setOpen(false); }} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-50', !brandId && 'bg-accent-50 text-accent-700')}>
              <Building2 className="h-4 w-4 text-slate-400" />
              <span className="flex-1 font-medium">All brands</span>
              <span className="text-xs text-slate-400">{brands.length}</span>
            </button>
          )}
          {brands.map((b) => (
            <button key={b.id} role="option" aria-selected={brandId === b.id} onClick={() => { setBrandId(b.id); setOpen(false); }} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-50', brandId === b.id && 'bg-accent-50 text-accent-700')}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: b.primaryColor }} />
              <span className="flex-1 truncate font-medium">{b.name}</span>
              {b.status !== 'ACTIVE' && <Badge tone="red">{b.status === 'SUSPENDED' ? 'Suspended' : 'Inactive'}</Badge>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Jump straight to an order, customer or ticket by reference, email or phone. */
function GlobalSearch() {
  const router = useRouter();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    const upper = term.toUpperCase();
    const target = upper.startsWith('TKT-') && can('tickets.read') ? '/tickets' : upper.startsWith('RFD-') && can('refunds.read') ? '/refunds' : upper.startsWith('PAY-') && can('payments.read') ? '/payments'
      : upper.startsWith('SUP-') && can('support.read') ? '/support' : !upper.startsWith('ORD-') && term.includes('@') && can('customers.read') && !can('orders.read') ? '/customers' : '/orders';
    router.push(`${target}?q=${encodeURIComponent(term)}`);
    setQ('');
  };
  return (
    <form onSubmit={go} className="relative hidden w-full max-w-sm md:block" role="search">
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search order, ticket, email or phone"
        aria-label="Search"
        className="h-9 w-full rounded-lg border-0 bg-slate-100 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-accent-500"
      />
    </form>
  );
}

function Notifications() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const allowed = can('system.health');
  const alerts = useQuery<{ items: { id: string; type: string; severity: string; message: string; createdAt: string }[]; total: number }>(
    allowed ? '/v1/admin/alerts' : null, { open: true, pageSize: 8 }, { refreshMs: 60_000 },
  );
  const refunds = useQuery<{ total: number }>(can('refunds.read') ? '/v1/admin/refunds' : null, { status: 'REQUESTED', pageSize: 1 }, { refreshMs: 60_000 });
  const count = (alerts.data?.total ?? 0) + (refunds.data?.total ?? 0);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-label={`Notifications${count ? ` (${count})` : ''}`} className="relative grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800">
        <Bell className="h-[18px] w-[18px]" />
        {count > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1.5 w-[22rem] max-w-[calc(100vw-2rem)] animate-fade-in rounded-xl border border-slate-200 bg-white shadow-pop">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">Needs attention</div>
          <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {!!refunds.data?.total && (
              <Link href="/refunds?status=REQUESTED" onClick={() => setOpen(false)} className="block px-4 py-3 hover:bg-slate-50">
                <div className="text-sm font-medium text-slate-900">{refunds.data.total} refund request{refunds.data.total === 1 ? '' : 's'} awaiting approval</div>
                <div className="mt-0.5 text-xs text-slate-500">Review in Refunds</div>
              </Link>
            )}
            {alerts.data?.items.map((a) => (
              <Link key={a.id} href="/settings?tab=health" onClick={() => setOpen(false)} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex items-center gap-2">
                  <Badge tone={a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARNING' ? 'amber' : 'blue'}>{a.severity.toLowerCase()}</Badge>
                  <span className="text-xs text-slate-400">{relative(a.createdAt)}</span>
                </div>
                <div className="mt-1 text-sm text-slate-700">{a.message}</div>
              </Link>
            ))}
            {count === 0 && <div className="px-4 py-8 text-center text-sm text-slate-500">Nothing needs your attention.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const initials = user.fullName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-ink-800 text-[11px] font-semibold text-white">{initials}</span>
        <span className="hidden text-left leading-tight lg:block">
          <span className="block max-w-[10rem] truncate text-sm font-medium text-slate-800">{user.fullName}</span>
          <span className="block text-[11px] capitalize text-slate-500">{user.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}</span>
        </span>
        <ChevronDown className="hidden h-4 w-4 text-slate-400 lg:block" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1.5 w-60 animate-fade-in rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop">
          <div className="px-2.5 py-2">
            <div className="truncate text-sm font-medium text-slate-900">{user.fullName}</div>
            <div className="truncate text-xs text-slate-500">{user.email}</div>
            {!user.mfaEnabled && <div className="mt-1.5"><Badge tone="amber">Two-step sign-in is off</Badge></div>}
          </div>
          <div className="my-1 h-px bg-slate-100" />
          <Link role="menuitem" href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50">
            <UserCircle className="h-4 w-4 text-slate-400" /> Account & security
          </Link>
          <button role="menuitem" onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
            <LogOut className="h-4 w-4 text-slate-400" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [mobileNav, setMobileNav] = useState(false);
  const pathname = usePathname();
  useEffect(() => setMobileNav(false), [pathname]);
  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 lg:block">
        <Sidebar />
      </aside>
      {mobileNav && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/60" onClick={() => setMobileNav(false)} />
          <div className="absolute inset-y-0 left-0 w-64 animate-fade-in">
            <Sidebar onNavigate={() => setMobileNav(false)} />
            <button onClick={() => setMobileNav(false)} aria-label="Close menu" className="absolute right-[-2.75rem] top-3 grid h-9 w-9 place-items-center rounded-lg bg-ink-900 text-white"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setMobileNav(true)} aria-label="Open menu" className="grid h-9 w-9 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"><Menu className="h-5 w-5" /></button>
          <BrandSelector />
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <ProfileMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
