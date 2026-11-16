'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, hasToken, refresh, setSignedOutHandler } from './api';

export interface BrandOption {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  primaryColor: string;
  logoUrl: string | null;
  defaultCurrency: string;
}
export interface Me {
  id: string;
  email: string;
  fullName: string;
  allBrands: boolean;
  roles: string[];
  permissions: string[];
  eventScoped: boolean;
  mfaEnabled: boolean;
  brands: BrandOption[];
}

interface AuthState {
  user: Me;
  brands: BrandOption[];
  /** Selected brand in the global selector. null = "All brands" (everything the user may see). */
  brandId: string | null;
  brand: BrandOption | null;
  setBrandId: (id: string | null) => void;
  can: (...permissions: string[]) => boolean;
  logout: () => Promise<void>;
  reloadUser: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const BRAND_KEY = 'ctp.brand';

/**
 * Loads the signed-in user and guards the portal. Permissions here only decide what the
 * interface shows; every request is authorised again by the API.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<Me | null>(null);
  const [brandId, setBrand] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const toLogin = useCallback(() => {
    setUser(null);
    const next = pathname && pathname !== '/login' ? `?next=${encodeURIComponent(pathname)}` : '';
    router.replace(`/login${next}`);
  }, [router, pathname]);

  const load = useCallback(async () => {
    if (!hasToken() && !(await refresh())) return toLogin();
    try {
      const me = await api.get<Me>('/v1/admin/auth/me');
      setUser(me);
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(BRAND_KEY);
      } catch {
        /* storage unavailable */
      }
      // A user tied to exactly one brand always works in that brand.
      if (!me.allBrands && me.brands.length === 1) setBrand(me.brands[0].id);
      else setBrand(saved && me.brands.some((b) => b.id === saved) ? saved : null);
    } catch {
      toLogin();
    } finally {
      setReady(true);
    }
  }, [toLogin]);

  useEffect(() => {
    setSignedOutHandler(toLogin);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthState | null>(() => {
    if (!user) return null;
    const perms = new Set(user.permissions);
    return {
      user,
      brands: user.brands,
      brandId,
      brand: user.brands.find((b) => b.id === brandId) ?? null,
      setBrandId: (id) => {
        setBrand(id);
        try {
          if (id) localStorage.setItem(BRAND_KEY, id);
          else localStorage.removeItem(BRAND_KEY);
        } catch {
          /* storage unavailable */
        }
      },
      can: (...p) => p.every((x) => perms.has(x)),
      logout: async () => {
        await api.logout();
        setUser(null);
        router.replace('/login');
      },
      reloadUser: load,
    };
  }, [user, brandId, router, load]);

  if (!ready || !value) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-accent-600" />
          Loading your workspace
        </div>
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside the portal layout');
  return v;
}

/** Renders children only when the user holds every listed permission. */
export function Can({ permission, children, fallback = null }: { permission: string | string[]; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useAuth();
  return <>{can(...(Array.isArray(permission) ? permission : [permission])) ? children : fallback}</>;
}
