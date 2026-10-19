'use client';
import * as React from 'react';
import type { AccountDto, BankTransactionDto, BankTxnStatus } from '@evenbooks/contracts';
import { cn } from '@/lib/utils';

export const isMoneyIn = (amount: string) => !amount.startsWith('-') && !/^0+(\.0+)?$/.test(amount);
export const absDecimal = (amount: string) => (amount.startsWith('-') ? amount.slice(1) : amount);

/** Accounts most lines land in: income for money in, expenses (or a non-bank asset such as equipment) for money out. */
export const preferFor = (moneyIn: boolean) =>
  moneyIn ? (a: AccountDto) => a.type === 'income' : (a: AccountDto) => a.type === 'expense' || (a.type === 'asset' && a.role !== 'bank');

/** A strong candidate exists (a record of this amount, or an unpaid invoice for it): open the Match tab first. */
export const hasStrongMatch = (t: BankTransactionDto) => !!t.matchHint && ((t.matchHint.count > 0 && t.matchHint.topScore >= 90) || t.matchHint.invoices > 0);

/**
 * Probably recorded already (or paying an invoice): Accept must not add it again,
 * so the row offers Match and bulk accept skips it.
 */
export const needsMatch = (t: BankTransactionDto) => t.status === 'unreviewed' && !!t.matchHint && (t.matchHint.count > 0 || t.matchHint.invoices > 0);

/** What each review outcome means, for badges and the reviewed-line dialog. */
export const STATUS_LABEL: Record<BankTxnStatus, string> = {
  unreviewed: 'For review',
  categorized: 'Categorized',
  matched: 'Matched',
  transfer: 'Transfer',
  excluded: 'Excluded',
};

/** Only for lines that aren't real; personal spending is recorded as an owner draw instead. */
export const EXCLUDE_REASONS = ['Duplicate', 'Bank reversal'];

/** One-click reasons that fill the reason field. */
export function ReasonChips({ value, onPick }: { value: string; onPick(reason: string): void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Common reasons">
      {EXCLUDE_REASONS.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => onPick(r)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            value === r ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/**
 * Undo lives on the always-mounted list view: the review dialog and its forms
 * unmount on success, which would drop a mutation callback started from a toast.
 */
export interface InboxActions {
  undoOne(t: BankTransactionDto): void;
  undoMany(txns: BankTransactionDto[]): void;
}
export const InboxActionsContext = React.createContext<InboxActions>({ undoOne: () => undefined, undoMany: () => undefined });
export const useInboxActions = () => React.useContext(InboxActionsContext);
