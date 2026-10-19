'use client';
import * as React from 'react';
import { useCompany } from '@/components/company-context';

const MAX = 5;

function read(key: string): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/**
 * The last few ids picked for one purpose (for example `purchase-line-account`),
 * remembered per company in this browser. Pass no key to disable.
 */
export function useRecent(key: string | undefined) {
  const { company } = useCompany();
  const storageKey = key ? `eb.recent.${company.id}.${key}` : null;
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (storageKey) setIds(read(storageKey));
  }, [storageKey]);
  const push = React.useCallback(
    (id: string) => {
      if (!storageKey) return;
      const next = [id, ...read(storageKey).filter((x) => x !== id)].slice(0, MAX);
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      setIds(next);
    },
    [storageKey],
  );
  return { ids, push };
}

/** A single remembered value (last payment method, last "paid from" account), per company. */
export function useRememberedValue(key: string): [string | null, (v: string) => void] {
  const { company } = useCompany();
  const storageKey = `eb.last.${company.id}.${key}`;
  const [value, setValue] = React.useState<string | null>(null);
  React.useEffect(() => {
    setValue(window.localStorage.getItem(storageKey));
  }, [storageKey]);
  const remember = React.useCallback(
    (v: string) => {
      window.localStorage.setItem(storageKey, v);
      setValue(v);
    },
    [storageKey],
  );
  return [value, remember];
}
