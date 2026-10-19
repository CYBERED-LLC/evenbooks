'use client';
import * as React from 'react';
import type { ImportCashComponentInput } from '@evenbooks/contracts';
import { AccountPicker } from './account-picker';
import { Button } from './ui/button';
import { Checkbox, Input } from './ui/input';

/** Empty means the transaction has no cash-basis income or expense (for example a loan). */
export function ImportCashEditor({ initial, pending, onSave }: {
  initial: ImportCashComponentInput[];
  pending: boolean;
  onSave(components: ImportCashComponentInput[]): void;
}) {
  const [lines, setLines] = React.useState(initial);
  const id = React.useId();
  const [noCash, setNoCash] = React.useState(false);
  return <div className="space-y-2 rounded border border-stone-200 p-3 text-sm">
    <p>Enter income collected and expenses paid on this date, including any fees. Do not include collected sales tax as income. Use positive amounts for income or expenses and negative amounts for refunds. Remove all lines for a transfer, loan, or other transaction with no income or expense.</p>
    {lines.map((line, i) => <div key={i} className="flex flex-wrap items-center gap-2">
      <AccountPicker id={`${id}-account-${i}`} aria-label={`Cash-basis account ${i + 1}`} value={line.accountId}
        allow={a => a.type === 'income' || a.type === 'expense'} createType={false} disabled={pending}
        onChange={accountId => setLines(prev => prev.map((c, n) => n === i ? { ...c, accountId: accountId ?? '' } : c))} />
      <Input aria-label={`Cash-basis amount ${i + 1}`} value={line.amount} inputMode="decimal" disabled={pending}
        onChange={e => setLines(prev => prev.map((c, n) => n === i ? { ...c, amount: e.target.value } : c))} className="w-32" />
      <Button variant="ghost" disabled={pending} onClick={() => setLines(prev => prev.filter((_, n) => n !== i))}>Remove</Button>
    </div>)}
    {lines.length === 0 && <Checkbox label="This transaction has no cash-basis income or expense" checked={noCash} disabled={pending} onChange={event => setNoCash(event.target.checked)} />}
    <div className="flex gap-2">
      <Button variant="secondary" disabled={pending} onClick={() => setLines(prev => [...prev, { accountId: '', amount: '' }])}>Add cash-basis line</Button>
      <Button loading={pending} disabled={(lines.length === 0 && !noCash) || lines.some(c => !c.accountId || !c.amount.trim())} onClick={() => onSave(lines)}>Save cash-basis review</Button>
    </div>
  </div>;
}
