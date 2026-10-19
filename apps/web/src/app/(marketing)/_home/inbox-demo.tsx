'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowDownLeft, ArrowUpRight, Check, RotateCcw } from 'lucide-react';
import { Money, normalizeEntryLines } from '@evenbooks/domain';
import { cn } from '@/lib/utils';
import { BalanceMark, fmtUsd, useTween } from './balance-mark';
import { type DemoMonth, dayLabel } from './demo-month';

type Kind = 'income' | 'expense' | 'asset' | 'equity';
interface Option {
  account: string;
  kind: Kind;
}
interface BankLine {
  id: string;
  /** Day of the month, on the 30-day story scale. */
  day: number;
  payee: string;
  memo: string;
  amount: string;
  direction: 'in' | 'out';
  rule: string;
  options: Option[];
}

const FEED: BankLine[] = [
  {
    id: 'harbor',
    day: 2,
    payee: 'Harbor Dental',
    memo: 'ACH deposit',
    amount: '1850.00',
    direction: 'in',
    rule: 'Rule: deposits from Harbor Dental',
    options: [
      { account: 'Design income', kind: 'income' },
      { account: 'Owner contribution', kind: 'equity' },
    ],
  },
  {
    id: 'figma',
    day: 3,
    payee: 'Figma',
    memo: 'Card ending 4411',
    amount: '45.00',
    direction: 'out',
    rule: 'Rule: Figma',
    options: [
      { account: 'Software subscriptions', kind: 'expense' },
      { account: 'Office supplies', kind: 'expense' },
    ],
  },
  {
    id: 'coffee',
    day: 4,
    payee: 'Blue Bottle Coffee',
    memo: 'Card ending 4411',
    amount: '14.50',
    direction: 'out',
    rule: 'Suggested from last time',
    options: [
      { account: 'Meals with clients', kind: 'expense' },
      { account: 'Owner draw', kind: 'equity' },
    ],
  },
  {
    id: 'desk',
    day: 5,
    payee: 'Common Desk',
    memo: 'Monthly membership',
    amount: '620.00',
    direction: 'out',
    rule: 'Rule: Common Desk',
    options: [
      { account: 'Rent', kind: 'expense' },
      { account: 'Office supplies', kind: 'expense' },
    ],
  },
  {
    id: 'savings',
    day: 6,
    payee: 'Transfer to savings',
    memo: 'Online transfer',
    amount: '1000.00',
    direction: 'out',
    rule: 'Transfer between your accounts',
    options: [
      { account: 'Savings', kind: 'asset' },
      { account: 'Owner draw', kind: 'equity' },
    ],
  },
];

const OPENING_CHECKING = Money.of('3200.00', 'USD');
const FULL_SCALE = Number(Money.sum(FEED.map((l) => Money.of(l.amount, 'USD')), 'USD').toString());
const FIRST_ENTRY = 143;
/** How long the debit leg stands alone before the credit leg lands. Matches the CSS delay on the credit line. */
const LEG_GAP_MS = 520;

interface Posted {
  line: BankLine;
  option: Option;
  entryNo: number;
  debit: string;
  credit: string;
}

export function InboxDemo({ month }: { month: DemoMonth }) {
  const [choice, setChoice] = React.useState<Record<string, number>>({});
  const [posted, setPosted] = React.useState<Posted[]>([]);
  /** The entry whose credit leg has not landed yet. */
  const [pending, setPending] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const approve = (line: BankLine) => {
    const option = line.options[choice[line.id] ?? 0]!;
    const amount = Money.of(line.amount, 'USD');
    const debitAccount = line.direction === 'in' ? 'Checking' : option.account;
    const creditAccount = line.direction === 'in' ? option.account : 'Checking';
    // The product's own validator: the entry is refused unless it balances.
    normalizeEntryLines(
      [
        { accountId: debitAccount, debit: amount },
        { accountId: creditAccount, credit: amount },
      ],
      'USD',
    );
    if (timer.current) clearTimeout(timer.current);
    setPosted((p) => [{ line, option, entryNo: FIRST_ENTRY + p.length, debit: debitAccount, credit: creditAccount }, ...p]);
    setPending(line.id);
    timer.current = setTimeout(() => setPending(null), LEG_GAP_MS);
  };

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setPosted([]);
    setPending(null);
    setChoice({});
  };

  const totals = React.useMemo(() => {
    let debits = Money.zero('USD');
    let credits = Money.zero('USD');
    let checking = OPENING_CHECKING;
    let income = Money.zero('USD');
    let expenses = Money.zero('USD');
    for (const p of posted) {
      const amount = Money.of(p.line.amount, 'USD');
      debits = debits.add(amount);
      if (p.line.id !== pending) credits = credits.add(amount);
      checking = p.line.direction === 'in' ? checking.add(amount) : checking.subtract(amount);
      if (p.option.kind === 'income') income = income.add(amount);
      if (p.option.kind === 'expense') expenses = expenses.add(amount);
    }
    const n = (m: Money) => Number(m.toString());
    return { debits: n(debits), credits: n(credits), checking: n(checking), income: n(income), expenses: n(expenses), net: n(income.subtract(expenses)) };
  }, [posted, pending]);

  const postedById = new Map(posted.map((p) => [p.line.id, p]));
  const done = posted.length === FEED.length && pending === null;
  const balanced = pending === null;
  const markLabel = balanced
    ? `Balanced: debits ${fmtUsd(totals.debits)} equal credits ${fmtUsd(totals.credits)}`
    : `Posting: debits ${fmtUsd(totals.debits)}, credits ${fmtUsd(totals.credits)}`;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_30px_80px_-40px_rgb(0_0_0/0.35)]">
      {/* Window bar: company, progress, the mark in miniature for phones. */}
      <div className="flex items-center gap-3 border-b border-stone-200 bg-stone-50 px-4 py-2.5">
        <BalanceMark debits={totals.debits} credits={totals.credits} max={FULL_SCALE} label={markLabel} ringClass="ring-stone-50" className="w-9 shrink-0 lg:hidden" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-stone-800">Juniper Studio · Review inbox</p>
          <p className="text-xs text-stone-500" aria-live="polite">
            {done ? 'All caught up. Every entry balanced.' : `${FEED.length - posted.length} of ${FEED.length} transactions to review`}
          </p>
        </div>
        {posted.length > 0 && (
          <button type="button" onClick={reset} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-stone-600 hover:bg-stone-200/60">
            <RotateCcw className="size-3.5" aria-hidden />
            Start over
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-[1.15fr_1fr]">
        {/* The inbox. */}
        <ul className="divide-y divide-stone-100 lg:border-r lg:border-stone-200" aria-label="Bank transactions">
          {FEED.map((line) => {
            const p = postedById.get(line.id);
            const idx = choice[line.id] ?? 0;
            const Icon = line.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={line.id} className={cn('flex flex-col gap-2.5 px-4 py-3.5 transition-colors sm:flex-row sm:items-center', p && 'bg-brand-50/60')}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    aria-hidden
                    className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-md', line.direction === 'in' ? 'bg-brand-100 text-brand-700' : 'bg-stone-100 text-stone-600')}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate text-sm font-medium text-stone-900">{line.payee}</p>
                      <p className={cn('tabular shrink-0 text-sm font-medium', line.direction === 'in' ? 'text-brand-700' : 'text-stone-800')}>
                        {line.direction === 'in' ? '+' : '−'}
                        {fmtUsd(Number(line.amount))}
                      </p>
                    </div>
                    <p className="truncate text-xs text-stone-500">
                      {dayLabel(month, line.day)} · {line.memo}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:w-[15.5rem] sm:shrink-0">
                  {p ? (
                    <p className="ve-pop flex h-9 flex-1 items-center gap-1.5 text-sm text-brand-700">
                      <Check className="size-4" aria-hidden />
                      <span className="truncate">
                        #{p.entryNo} · {p.option.account}
                      </span>
                    </p>
                  ) : (
                    <>
                      <label className="sr-only" htmlFor={`cat-${line.id}`}>
                        Category for {line.payee}
                      </label>
                      <select
                        id={`cat-${line.id}`}
                        value={idx}
                        onChange={(e) => setChoice((c) => ({ ...c, [line.id]: Number(e.target.value) }))}
                        title={line.rule}
                        className="h-9 min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-800"
                      >
                        {line.options.map((o, i) => (
                          <option key={o.account} value={i}>
                            {o.account}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => approve(line)}
                        className="ve-approve h-9 shrink-0 rounded-md bg-brand-600 px-3 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
                      >
                        Approve
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {/* The balance and the journal it guards. */}
        <div className="flex min-w-0 flex-col border-t border-stone-200 lg:border-t-0">
          <div className="hidden px-6 pt-6 lg:block">
            <BalanceMark debits={totals.debits} credits={totals.credits} max={FULL_SCALE} label={markLabel} className="mx-auto w-full max-w-[15rem]" />
          </div>
          <dl className="grid grid-cols-2 gap-px border-b border-stone-200 bg-stone-200 lg:mt-5 lg:border-t">
            <Figure label="Debits" value={totals.debits} tone={balanced ? 'text-stone-900' : 'text-amber-700'} />
            <Figure label="Credits" value={totals.credits} tone={balanced ? 'text-stone-900' : 'text-amber-700'} />
          </dl>
          <div className="min-h-[9.5rem] flex-1 px-4 py-3 lg:px-5">
            <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Journal</p>
            {posted.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-stone-500">
                Approve a transaction and it becomes a journal entry. The debit and credit have to match, or it won’t post.
              </p>
            ) : (
              <ol className="mt-2 space-y-2">
                {posted.slice(0, 2).map((p) => (
                  <li key={p.line.id} className="ve-entry rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs">
                    <p className="flex justify-between gap-2 text-stone-500">
                      <span className="truncate">
                        #{p.entryNo} · {dayLabel(month, p.line.day)} · {p.line.payee}
                      </span>
                      <span className="shrink-0 text-brand-700">{p.line.id === pending ? 'posting' : 'posted'}</span>
                    </p>
                    <p className="ve-leg mt-1 flex justify-between gap-2 text-stone-800">
                      <span className="truncate">Dr {p.debit}</span>
                      <span className="tabular">{fmtUsd(Number(p.line.amount))}</span>
                    </p>
                    <p className="ve-leg ve-leg-late flex justify-between gap-2 pl-4 text-stone-800">
                      <span className="truncate">Cr {p.credit}</span>
                      <span className="tabular">{fmtUsd(Number(p.line.amount))}</span>
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      {/* The reports move with every approval. */}
      <dl className="grid grid-cols-2 gap-px border-t border-stone-200 bg-stone-200 sm:grid-cols-4">
        <Figure label="Checking" value={totals.checking} />
        <Figure label={`Income, ${month.short}`} value={totals.income} />
        <Figure label={`Expenses, ${month.short}`} value={totals.expenses} />
        <Figure label="Net profit" value={totals.net} tone={totals.net < 0 ? 'text-red-700' : 'text-stone-900'} />
      </dl>

      {done && (
        <div className="ve-pop flex flex-col gap-3 border-t border-brand-200 bg-brand-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-brand-900">
            That was bookkeeping. Five entries, {fmtUsd(totals.debits)} in debits and the same in credits.
          </p>
          <Link href="/sign-up" className="text-sm font-medium text-brand-800 underline underline-offset-4 hover:text-brand-900">
            Now do it with your real bank
          </Link>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, tone = 'text-stone-900' }: { label: string; value: number; tone?: string }) {
  const shown = useTween(value);
  return (
    <div className="bg-white px-4 py-2.5">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className={cn('tabular text-base font-semibold transition-colors', tone)}>{fmtUsd(shown)}</dd>
    </div>
  );
}
