'use client';
import * as React from 'react';
import type { AccountType } from '@evenbooks/contracts';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ACCOUNT_TYPES, accountLabel } from '@/components/account-picker';
import { useAccounts } from '@/lib/queries/accounts';

const TYPE_GROUP: Record<AccountType, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

/**
 * Account search for report filters. Unlike `AccountPicker` (which offers only
 * active accounts, for posting), reports must reach archived accounts too, since
 * their history is still in the ledger. Archived accounts are listed last.
 */
export function ReportAccountPicker({
  id,
  value,
  onChange,
  placeholder = 'Search accounts…',
  clearable,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (id: string | null) => void;
  placeholder?: string;
  clearable?: boolean;
  'aria-label'?: string;
}) {
  const accounts = useAccounts({ includeArchived: true });
  const options = React.useMemo<ComboboxOption[]>(() => {
    const all = accounts.data ?? [];
    const out: ComboboxOption[] = [];
    for (const t of ACCOUNT_TYPES) {
      for (const a of all) if (a.isActive && a.type === t) out.push({ value: a.id, label: accountLabel(a), group: TYPE_GROUP[t], keywords: `${t} ${a.role ?? ''}` });
    }
    for (const a of all) if (!a.isActive) out.push({ value: a.id, label: accountLabel(a), group: 'Archived', hint: TYPE_GROUP[a.type], keywords: `archived ${a.type}` });
    return out;
  }, [accounts.data]);
  const selected = value ? accounts.data?.find((a) => a.id === value) : undefined;
  return (
    <Combobox
      id={id}
      value={value || null}
      options={options}
      selectedLabel={selected ? accountLabel(selected) : value && accounts.isSuccess ? '(unknown account)' : undefined}
      onChange={(v) => onChange(v)}
      loading={accounts.isPending}
      placeholder={placeholder}
      clearable={clearable}
      emptyText="No account matches"
      aria-label={ariaLabel}
    />
  );
}
