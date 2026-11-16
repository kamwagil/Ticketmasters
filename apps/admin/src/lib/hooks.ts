'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Params } from './api';
import { useAuth } from './auth';

export interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

/**
 * GET a resource and keep it in state.
 * @param path     API path, or null to skip the request.
 * @param params   Query parameters (empty values are dropped).
 * @param opts.scoped  Adds the globally selected brand as `brandId` (default true).
 */
export function useQuery<T = any>(path: string | null, params?: Params, opts: { scoped?: boolean; refreshMs?: number } = {}): QueryState<T> {
  const { brandId } = useAuth();
  const scoped = opts.scoped ?? true;
  const merged = useMemo(() => ({ ...(scoped && brandId ? { brandId } : {}), ...params }), [scoped, brandId, JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = path ? `${path}?${JSON.stringify(merged)}` : null;
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: ApiError | null }>({ data: undefined, loading: !!path, error: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!path) {
      setState({ data: undefined, loading: false, error: null });
      return;
    }
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get<T>(path, merged)
      .then((data) => id === latest.current && setState({ data, loading: false, error: null }))
      .catch((error) => id === latest.current && setState((s) => ({ data: s.data, loading: false, error: error as ApiError })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  useEffect(() => {
    if (!opts.refreshMs || !path) return;
    const t = setInterval(() => setTick((x) => x + 1), opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, path]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { ...state, reload };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** Paged list with server-side filtering. Changing a filter returns to page 1. */
export function usePaged<T = any>(path: string | null, filters?: Params, opts: { scoped?: boolean; pageSize?: number } = {}) {
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify(filters ?? {});
  const { brandId } = useAuth();
  useEffect(() => setPage(1), [filterKey, brandId]);
  const q = useQuery<Paged<T>>(path, { ...filters, page, pageSize: opts.pageSize ?? 25 }, { scoped: opts.scoped });
  return {
    items: q.data?.items ?? [],
    total: q.data?.total ?? 0,
    pages: q.data?.pages ?? 1,
    page,
    setPage,
    loading: q.loading,
    error: q.error,
    reload: q.reload,
    /** Filters currently applied, including brand scope: pass to ExportMenu so exports match the screen. */
    params: { ...(opts.scoped !== false && brandId ? { brandId } : {}), ...filters } as Params,
  };
}

/** Runs a write action with loading state; returns undefined (and reports via onError) when it fails. */
export function useAction() {
  const [loading, setLoading] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, handlers: { onError?: (e: ApiError) => void } = {}): Promise<T | undefined> => {
    setLoading(true);
    try {
      return await fn();
    } catch (e) {
      handlers.onError?.(e as ApiError);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);
  return { run, loading };
}

/** Debounces a fast-changing value (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
