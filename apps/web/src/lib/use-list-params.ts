'use client';
import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDebounced } from '@/lib/use-debounced';

const PAGE_KEYS = ['cursor', 'prev'];

/**
 * URL-backed list state for index pages: filters, a debounced search box that
 * stays in sync with the URL, and cursor paging with a Previous button (earlier
 * cursors ride along as repeated `prev` params). Changing a filter resets paging.
 * It also remembers the list URL so detail pages can link back to it (see `useListHref`).
 */
export function useListParams(opts: { searchKey?: string; debounceMs?: number } = {}) {
  const { searchKey = 'q', debounceMs = 300 } = opts;
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const spString = sp.toString();

  // router.replace lands asynchronously; a second change made before it lands must build on
  // the first (sort, then a date filter) instead of on the stale URL, or it would undo it.
  const pending = React.useRef<string | null>(null);
  React.useEffect(() => {
    pending.current = null;
  }, [spString]);
  const current = React.useCallback(() => new URLSearchParams(pending.current ?? spString), [spString]);

  const replace = React.useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      pending.current = qs;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const get = React.useCallback((key: string) => sp.get(key) ?? undefined, [sp]);

  const setMany = React.useCallback(
    (values: Record<string, string | null | undefined>, resetPaging = true) => {
      const next = current();
      for (const [k, v] of Object.entries(values)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (resetPaging) PAGE_KEYS.forEach((k) => next.delete(k));
      replace(next);
    },
    [current, replace],
  );

  const set = React.useCallback((key: string, value: string | null | undefined) => setMany({ [key]: value }), [setMany]);

  // Search box: local while typing, pushed to the URL after a pause, and re-read
  // whenever the URL changes underneath it (nav links, "Clear filters", back button).
  const urlSearch = sp.get(searchKey) ?? '';
  const [search, setSearchState] = React.useState(urlSearch);
  const typing = React.useRef(false);
  const debounced = useDebounced(search, debounceMs);
  React.useEffect(() => {
    if (!typing.current) setSearchState(urlSearch);
  }, [urlSearch]);
  React.useEffect(() => {
    if (!typing.current) return;
    typing.current = false;
    if (debounced.trim() !== urlSearch) set(searchKey, debounced.trim() || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const setSearch = React.useCallback((v: string) => {
    typing.current = true;
    setSearchState(v);
  }, []);

  // Sorting: `sort` + `dir` in the URL (SortableTH works out the next direction).
  const sort = sp.get('sort') ?? undefined;
  const dir = (sp.get('dir') === 'asc' ? 'asc' : sp.get('dir') === 'desc' ? 'desc' : undefined) as 'asc' | 'desc' | undefined;
  const setSort = React.useCallback((key: string, nextDir: 'asc' | 'desc') => setMany({ sort: key, dir: nextDir }), [setMany]);

  const cursor = sp.get('cursor') ?? undefined;
  const prevStack = sp.getAll('prev');
  const pageIndex = cursor ? prevStack.length + 1 : 0;

  const next = React.useCallback(
    (nextCursor: string) => {
      const n = current();
      const at = n.get('cursor');
      if (at) n.append('prev', at);
      n.set('cursor', nextCursor);
      replace(n);
    },
    [current, replace],
  );

  const prev = React.useCallback(() => {
    const n = current();
    const stack = n.getAll('prev');
    n.delete('prev');
    const back = stack.pop();
    stack.forEach((c) => n.append('prev', c));
    if (back) n.set('cursor', back);
    else n.delete('cursor');
    replace(n);
  }, [current, replace]);

  const clear = React.useCallback(
    (keys: string[]) => {
      const n = current();
      keys.forEach((k) => n.delete(k));
      PAGE_KEYS.forEach((k) => n.delete(k));
      if (keys.includes(searchKey)) {
        typing.current = false;
        setSearchState('');
      }
      replace(n);
    },
    [current, replace, searchKey],
  );

  // Remember where this list was (filters, page) for "Back to …" links on detail pages.
  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(`eb.list.${pathname}`, spString ? `${pathname}?${spString}` : pathname);
    } catch {
      // storage unavailable (private mode); back links fall back to the bare list
    }
  }, [pathname, spString]);

  return { get, set, setMany, search, setSearch, sort, dir, setSort, cursor, pageIndex, hasPrev: pageIndex > 0, next, prev, clear, params: sp };
}

/** The list page URL as the user last left it (filters and page), or the bare path. */
export function useListHref(listPath: string): string {
  const [href, setHref] = React.useState(listPath);
  React.useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(`eb.list.${listPath}`);
      if (saved) setHref(saved);
    } catch {
      // ignore
    }
  }, [listPath]);
  return href;
}
