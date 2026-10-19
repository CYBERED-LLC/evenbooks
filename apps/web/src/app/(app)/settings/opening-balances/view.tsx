'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ClipboardPaste, FilePlus2, Search } from 'lucide-react';
import type { AccountDto, JournalEntryDto, OpeningBalancesInput } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { DateInput } from '@/components/ui/date-input';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Term } from '@/components/ui/term';
import { useToast } from '@/components/ui/toast';
import { useAccounts } from '@/lib/queries/accounts';
import { useSaveCompanyFields } from '@/lib/queries/company';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { api, idempotencyKey } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useCompany, useToday } from '@/components/company-context';
import { capitalize, formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { isValidDecimal, negateDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { cn } from '@/lib/utils';
import { addDays, asOfPresets, fiscalYearStart } from '../../reports/report-controls';
import { parsePastedBalances } from './paste';

/** Balance-sheet roles that are driven by documents, not typed in here. */
const DOCUMENT_ROLES = new Set<NonNullable<AccountDto['role']>>(['accounts_receivable', 'customer_deposits', 'sales_tax_payable']);
const BALANCE_SHEET_TYPES = new Set<AccountDto['type']>(['asset', 'liability', 'equity']);
const TYPE_ORDER = ['asset', 'liability', 'equity'] as const;
type SheetType = (typeof TYPE_ORDER)[number];
const TYPE_TITLE: Record<SheetType, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity' };

const isDocumentDriven = (a: AccountDto) => a.role !== null && DOCUMENT_ROLES.has(a.role);
const entered = (v: string | undefined) => {
  const raw = (v ?? '').trim();
  return raw && isValidDecimal(raw) && !isZeroDecimal(raw) ? raw : null;
};
/** Contra accounts (written down over time) only make sense in the full table. */
const isContra = (a: AccountDto) => /depreciation|amortization|allowance/i.test(a.name);

type ViewMode = 'guided' | 'advanced';

interface PasteResult {
  filled: number;
  unmatched: string[];
  documentDriven: string[];
  skipped: number;
}

function usePostOpeningBalances() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpeningBalancesInput) => api<JournalEntryDto>('/api/journal/opening-balances', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (entry) => {
      qc.setQueryData(qk.journal.detail(company.id, entry.id), entry);
      // Balances change and `company.hasPostedEntries` flips; the session/company key is not per-company.
      return Promise.all([...postingAffectedKeys(company.id).map((key) => qc.invalidateQueries({ queryKey: key })), qc.invalidateQueries({ queryKey: qk.session() })]);
    },
  });
}

/**
 * Starting balances. The default view asks plain questions (what the statement said for each
 * bank and card, loans, equipment); the full debit/credit table stays under "Advanced". Both
 * edit the same amounts, and the difference goes to the owner's starting equity.
 * `?accountId=` focuses that account's field (linked from adding a bank account).
 */
export function OpeningBalancesView() {
  const { company, isAdmin } = useCompany();
  const router = useRouter();
  const sp = useSearchParams();
  const focusId = sp.get('accountId');
  const accounts = useAccounts({ withBalances: true });
  const post = usePostOpeningBalances();
  const saveCompany = useSaveCompanyFields();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const keyRef = React.useRef(idempotencyKey());
  const today = useToday();

  // The date used last time (the day before the books start); otherwise the end of last tax year.
  const lastTaxYearEnd = addDays(fiscalYearStart(today, company.fiscalYearStartMonth), -1);
  const defaultDate = company.booksStartDate ? addDays(company.booksStartDate, -1) : lastTaxYearEnd;
  const datePresets = React.useMemo(
    () => [
      { label: company.fiscalYearStartMonth === 1 ? 'December 31 of last year' : 'End of last tax year', value: lastTaxYearEnd },
      ...(defaultDate !== lastTaxYearEnd ? [{ label: 'The date you used before', value: defaultDate }] : []),
      ...asOfPresets().slice(1),
    ],
    [defaultDate, lastTaxYearEnd, company.fiscalYearStartMonth],
  );
  const [date, setDate] = React.useState(defaultDate);
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [posted, setPosted] = React.useState<JournalEntryDto | null>(null);
  const [pasteResult, setPasteResult] = React.useState<PasteResult | null>(null);
  const [mode, setModeState] = React.useState<ViewMode>(sp.get('view') === 'advanced' ? 'advanced' : 'guided');
  const setMode = (m: ViewMode) => {
    setModeState(m);
    const q = new URLSearchParams(sp.toString());
    if (m === 'advanced') q.set('view', 'advanced');
    else q.delete('view');
    router.replace(`/settings/opening-balances${q.size ? `?${q}` : ''}`, { scroll: false });
  };

  const dirty = Object.values(amounts).some((v) => v.trim() !== '');
  const guard = useUnsavedChanges(dirty);

  const rows = React.useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => BALANCE_SHEET_TYPES.has(a.type) && a.isActive)
        .filter((a) => a.role !== 'opening_balance_equity')
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts.data],
  );
  const plugAccount = accounts.data?.find((a) => a.role === 'opening_balance_equity');

  // The questions: money accounts, then loans and things the business owns.
  const guided = React.useMemo(
    () => ({
      money: rows.filter((a) => a.role === 'bank' || a.role === 'credit_card'),
      loans: rows.filter((a) => a.type === 'liability' && !a.role),
      owned: rows.filter((a) => a.type === 'asset' && !a.role && !isContra(a)),
    }),
    [rows],
  );
  const guidedIds = React.useMemo(() => new Set([...guided.money, ...guided.loans, ...guided.owned].map((a) => a.id)), [guided]);

  // An account linked by id that the questions don't ask about opens the full table.
  const focusHandled = React.useRef(false);
  React.useEffect(() => {
    if (!focusId || !accounts.data || focusHandled.current) return;
    focusHandled.current = true;
    if (!guidedIds.has(focusId) && rows.some((a) => a.id === focusId)) setModeState('advanced');
  }, [focusId, accounts.data, guidedIds, rows]);

  // Natural-direction balances → debit/credit legs (display only; the server posts the entry).
  const totals = React.useMemo(() => {
    const debits: string[] = [];
    const credits: string[] = [];
    const byType: Record<SheetType, string[]> = { asset: [], liability: [], equity: [] };
    for (const a of rows) {
      const raw = entered(amounts[a.id]);
      if (!raw) continue;
      byType[a.type as SheetType].push(raw);
      const signedDebit = a.type === 'asset' ? raw : negateDecimal(raw);
      if (signedDebit.startsWith('-')) credits.push(signedDebit.slice(1));
      else debits.push(signedDebit);
    }
    const debit = sumDecimals(debits);
    const credit = sumDecimals(credits);
    const plug = subtractDecimals(debit, credit); // positive → Opening Balance Equity is credited
    const subtotal = Object.fromEntries(TYPE_ORDER.map((t) => [t, sumDecimals(byType[t])])) as Record<SheetType, string>;
    return { debit, credit, plug, subtotal, count: debits.length + credits.length };
  }, [rows, amounts]);

  const invalid = rows.filter((a) => (amounts[a.id] ?? '').trim() !== '' && !isValidDecimal(amounts[a.id]!));
  const canSubmit = isAdmin && totals.count > 0 && invalid.length === 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && !post.isPending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (
      company.hasPostedEntries &&
      !(await confirm({
        title: 'Add starting balances to books that already have activity?',
        description: 'These amounts are added to what is already in your books; they do not replace it. Check the balance sheet first if you are not sure.',
        confirmLabel: 'Save anyway',
        cancelLabel: 'Go back',
        tone: 'danger',
      }))
    )
      return;
    const lines = rows.map((a) => ({ accountId: a.id, balance: entered(amounts[a.id]) ?? '' })).filter((l) => l.balance);
    post.mutate(
      { date, lines, idempotencyKey: keyRef.current },
      {
        onSuccess: (entry) => {
          guard.markSaved();
          setPosted(entry);
          setAmounts({});
          setPasteResult(null);
          keyRef.current = idempotencyKey();
          toast.success('Starting balances saved');
          // The day after is when the books start; adding a bank account later uses it.
          const booksStartDate = addDays(entry.date, 1);
          if (booksStartDate !== company.booksStartDate) saveCompany.mutate({ booksStartDate }, { onError: (err) => onError(err, 'Could not save your starting date') });
        },
        onError: (err) => onError(err, 'Could not save starting balances'),
      },
    );
  };

  const setAmount = (id: string, v: string) => setAmounts((m) => ({ ...m, [id]: v }));
  const formProps = { rows, amounts, setAmount, date, setDate, datePresets, totals, invalid, canSubmit, posting: post.isPending, plugAccount, focusId, onClear: () => setAmounts({}), dirty };

  return (
    <>
      <PageHeader
        title="Starting balances"
        description="What your bank accounts, cards and loans held just before you started recording in Evenbooks, so your balances match your statements from day one."
        actions={
          <LinkButton href="/settings" variant="secondary">
            All settings
          </LinkButton>
        }
      />

      {!isAdmin && (
        <div role="alert" className="mb-4 rounded-md border border-stone-300 bg-stone-50 px-4 py-3 text-sm text-stone-700">
          Only admins can save starting balances. You can look, but not change them.
        </div>
      )}

      {company.hasPostedEntries && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="ob-warning">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Your books already have activity.</p>
            <p>
              Starting balances are normally entered once, before anything else. Saving again adds to the balances already there instead of replacing them; check the{' '}
              <Link href="/reports/balance-sheet" className="underline">
                balance sheet
              </Link>{' '}
              first.
            </p>
          </div>
        </div>
      )}

      {posted && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-testid="ob-posted">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            Starting balances saved for {formatDate(posted.date)}.{' '}
            <Link href={`/journal/${posted.id}`} className="font-medium underline">
              See the entry{posted.entryNumber ? ` #${posted.entryNumber}` : ''}
            </Link>
          </p>
        </div>
      )}

      {pasteResult && (
        <div
          role="status"
          className={cn(
            'mb-4 flex items-start justify-between gap-3 rounded-md border px-4 py-3 text-sm',
            pasteResult.unmatched.length || pasteResult.documentDriven.length ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-emerald-300 bg-emerald-50 text-emerald-900',
          )}
          data-testid="ob-paste-result"
        >
          <div className="space-y-1">
            <p className="font-medium">
              Filled {pasteResult.filled} {pasteResult.filled === 1 ? 'account' : 'accounts'} from the pasted rows. Review them before saving.
            </p>
            {pasteResult.unmatched.length > 0 && (
              <p data-testid="ob-paste-unmatched">
                No account with {pasteResult.unmatched.length === 1 ? 'code' : 'codes'} {pasteResult.unmatched.join(', ')}.
              </p>
            )}
            {pasteResult.documentDriven.length > 0 && <p>Not filled (enter these as invoices or payments): {pasteResult.documentDriven.join(', ')}.</p>}
            {pasteResult.skipped > 0 && (
              <p className="text-xs opacity-80">
                {pasteResult.skipped} {pasteResult.skipped === 1 ? 'line had' : 'lines had'} no amount and {pasteResult.skipped === 1 ? 'was' : 'were'} skipped.
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPasteResult(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div role="tablist" aria-label="How to enter starting balances" className="mb-4 inline-flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
        {(
          [
            ['guided', 'Step by step'],
            ['advanced', 'Advanced: all accounts'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn('min-h-9 rounded px-3 font-medium', mode === m ? 'bg-brand-600 text-white' : 'text-stone-700 hover:bg-stone-100')}
          >
            {label}
          </button>
        ))}
      </div>

      {accounts.isPending && <Spinner />}
      {accounts.isError && <ErrorNotice error={accounts.error} onRetry={() => accounts.refetch()} />}
      {accounts.data &&
        (mode === 'guided' ? (
          <GuidedBalances {...formProps} money={guided.money} loans={guided.loans} owned={guided.owned} onSubmit={(e) => void submit(e)} />
        ) : (
          <AdvancedBalances {...formProps} onSubmit={(e) => void submit(e)} onPasted={setPasteResult} setAmounts={setAmounts} />
        ))}
    </>
  );
}

interface FormProps {
  rows: AccountDto[];
  amounts: Record<string, string>;
  setAmount(id: string, v: string): void;
  date: string;
  setDate(v: string): void;
  datePresets: { label: string; value: string }[];
  totals: { debit: string; credit: string; plug: string; subtotal: Record<SheetType, string>; count: number };
  invalid: AccountDto[];
  canSubmit: boolean;
  posting: boolean;
  plugAccount: AccountDto | undefined;
  focusId: string | null;
  onClear(): void;
  dirty: boolean;
  onSubmit(e: React.FormEvent): void;
}

/** Scroll to, focus and briefly highlight the field for `?accountId=`. */
function useFocusAccount(focusId: string | null, present: boolean) {
  const [highlight, setHighlight] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!focusId || !present) return;
    const el = document.querySelector<HTMLInputElement>(`[data-account-input="${focusId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    setHighlight(focusId);
    const t = window.setTimeout(() => setHighlight(null), 4000);
    return () => window.clearTimeout(t);
  }, [focusId, present]);
  return highlight;
}

function GuidedBalances({
  money,
  loans,
  owned,
  amounts,
  setAmount,
  date,
  setDate,
  datePresets,
  totals,
  invalid,
  canSubmit,
  posting,
  focusId,
  onSubmit,
}: FormProps & { money: AccountDto[]; loans: AccountDto[]; owned: AccountDto[] }) {
  const { company, isAdmin } = useCompany();
  const cur = company.baseCurrency;
  const all = [...money, ...loans, ...owned];
  const highlight = useFocusAccount(focusId, all.some((a) => a.id === focusId));
  const dateLabel = /^\d{4}-\d{2}-\d{2}$/.test(date) ? formatDate(date) : 'that date';
  // Positive: what the business has exceeds what it owes.
  const equity = totals.plug;

  const amountRow = (a: AccountDto, label: string, hint?: string) => {
    const value = amounts[a.id] ?? '';
    const bad = value.trim() !== '' && !isValidDecimal(value);
    const id = `ob-guided-${a.id}`;
    return (
      <div key={a.id} className={cn('grid items-center gap-2 rounded-md px-2 py-2 sm:grid-cols-[1fr_12rem]', highlight === a.id && 'bg-brand-50 ring-2 ring-brand-400')} data-testid="ob-guided-row">
        <label htmlFor={id} className="min-w-0">
          <span className="font-medium text-stone-900">{a.name}</span>
          <span className="block text-xs text-stone-500">
            {label}
            {hint ? ` ${hint}` : ''}
            {!isZeroDecimal(a.balance ?? '0') && ` Already in Evenbooks: ${formatMoney(a.balance, cur)}.`}
          </span>
        </label>
        <MoneyInput
          id={id}
          data-account-input={a.id}
          allowNegative
          aria-label={`${a.name}: ${label.charAt(0).toLowerCase()}${label.slice(1).replace(/\.$/, '')}`}
          aria-invalid={bad || undefined}
          placeholder="0.00"
          value={value}
          disabled={!isAdmin || posting}
          onChange={(v) => setAmount(a.id, v)}
        />
      </div>
    );
  };

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-4" aria-busy={posting || undefined}>
      <Card>
        <CardHeader title="1. Starting date" />
        <CardBody>
          <Field
            label="What date are these balances from?"
            htmlFor="ob-date"
            hint="Usually December 31 of last year. Use the balances on your statements for that date; you record everything after it in Evenbooks."
            required
          >
            <DateInput id="ob-date" value={date} onChange={setDate} presets={datePresets} disabled={!isAdmin} className="max-w-56" />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="2. Bank accounts and credit cards" description="Use the balance printed on each statement, not today’s balance." />
        <CardBody className="space-y-1">
          {money.length === 0 ? (
            <EmptyState compact title="No bank accounts or cards yet." description="Add them on the Bank accounts page first." />
          ) : (
            money.map((a) => (a.role === 'credit_card' ? amountRow(a, `Amount owed on ${dateLabel}.`) : amountRow(a, `Balance on your statement for ${dateLabel}.`)))
          )}
          <p className="pt-1 text-xs text-stone-500">
            Missing an account?{' '}
            <Link href="/banking" className="text-brand-700 hover:underline">
              Add it on Bank accounts
            </Link>
            , then come back.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="3. Did customers owe you money on that date?" />
        <CardBody className="space-y-3 text-sm text-stone-700">
          <p>
            Add each invoice that was still unpaid, dated on or before {dateLabel}, and save it without emailing it. It shows up as an unpaid invoice, and when the customer pays you record the payment as usual.
          </p>
          <LinkButton variant="secondary" href="/invoices/new">
            <FilePlus2 className="size-4" aria-hidden /> Add an unpaid invoice
          </LinkButton>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="4. Any loans?" description="Optional. What the business still owed on each loan." />
        <CardBody className="space-y-1">
          {loans.length === 0 ? (
            <p className="text-sm text-stone-500">No loan accounts. Skip this if the business had no loans.</p>
          ) : (
            loans.map((a) => amountRow(a, `Still owed on ${dateLabel}.`))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="5. Equipment or vehicles the business owns?" description="Optional. What you paid for things the business still owns, such as a computer or a van." />
        <CardBody className="space-y-1">
          {owned.length === 0 ? <p className="text-sm text-stone-500">No equipment accounts. Skip this if the business owns none.</p> : owned.map((a) => amountRow(a, `Value on ${dateLabel}.`))}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-stone-700">
              <Term id="equity">Owner&rsquo;s starting equity</Term> (balancing amount)
            </span>
            <span className="tabular font-semibold" data-testid="ob-guided-equity">
              {formatMoney(equity, cur)}
            </span>
          </div>
          <p className="text-xs text-stone-500">
            What the business has minus what it owes. Evenbooks works it out and records it for you.
          </p>
          {invalid.length > 0 && (
            <p role="alert" className="text-xs text-red-600">
              {invalid.length} {invalid.length === 1 ? 'amount is' : 'amounts are'} not valid numbers.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={posting} disabled={!canSubmit}>
              Save starting balances
            </Button>
            <p className="text-xs text-stone-500">{totals.count === 0 ? 'Enter at least one balance to save.' : `Saved for ${dateLabel}.`}</p>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}

/** Every balance-sheet account in one table, with debit/credit totals and paste from a spreadsheet. */
function AdvancedBalances({
  rows,
  amounts,
  setAmount,
  setAmounts,
  date,
  setDate,
  datePresets,
  totals,
  invalid,
  canSubmit,
  posting,
  plugAccount,
  focusId,
  onClear,
  dirty,
  onSubmit,
  onPasted,
}: FormProps & { onPasted(r: PasteResult): void; setAmounts: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  const { company, isAdmin } = useCompany();
  const cur = company.baseCurrency;
  const [search, setSearch] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState<'' | SheetType>('');
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const highlight = useFocusAccount(focusId, rows.some((a) => a.id === focusId));

  const needle = search.trim().toLowerCase();
  const shown = rows.filter((a) => (!typeFilter || a.type === typeFilter) && (!needle || a.code.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle)));
  const hiddenWithAmounts = rows.filter((a) => entered(amounts[a.id]) && !shown.includes(a)).length;
  const filtering = !!needle || !!typeFilter;
  const balanced = totals.count > 0 && isZeroDecimal(totals.plug);

  const applyPaste = (text: string) => {
    const { rows: pasted, skipped } = parsePastedBalances(text);
    const byCode = new Map(rows.map((a) => [a.code.toLowerCase(), a]));
    const next: Record<string, string> = {};
    const unmatched: string[] = [];
    const documentDriven: string[] = [];
    for (const p of pasted) {
      const a = byCode.get(p.code.toLowerCase());
      if (!a) unmatched.push(p.code);
      else if (isDocumentDriven(a)) documentDriven.push(a.code);
      else next[a.id] = p.amount;
    }
    setAmounts((m) => ({ ...m, ...next }));
    // Show every filled row.
    setSearch('');
    setTypeFilter('');
    onPasted({ filled: Object.keys(next).length, unmatched: [...new Set(unmatched)], documentDriven: [...new Set(documentDriven)], skipped });
    setPasteOpen(false);
  };

  return (
    <>
      <form onSubmit={onSubmit} className="grid items-start gap-4 lg:grid-cols-3" aria-busy={posting || undefined}>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Balance-sheet accounts"
            description="Positive numbers in each account's natural direction: assets as debits, liabilities and equity as credits."
            actions={
              <Button type="button" variant="secondary" size="sm" onClick={() => setPasteOpen(true)} disabled={!isAdmin || posting || rows.length === 0}>
                <ClipboardPaste className="size-4" aria-hidden /> Paste from spreadsheet
              </Button>
            }
          />
          <CardBody className="flex flex-wrap items-start gap-3 border-b border-stone-200">
            <Field label="As of date" htmlFor="ob-date" hint="Usually December 31 of last year. Everything after it is recorded in Evenbooks." required>
              <DateInput id="ob-date" value={date} onChange={setDate} presets={datePresets} disabled={!isAdmin} className="max-w-56" />
            </Field>
            <Field label="Search accounts" htmlFor="ob-search" className="min-w-48">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
                <Input id="ob-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" className="pl-8" />
              </div>
            </Field>
            <Field label="Type" htmlFor="ob-type">
              <Select id="ob-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as '' | SheetType)}>
                <option value="">All types</option>
                {TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_TITLE[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </CardBody>
          {rows.length === 0 ? (
            <CardBody>
              <EmptyState title="No balance-sheet accounts" description="Add asset, liability or equity accounts in the chart of accounts first." />
            </CardBody>
          ) : shown.length === 0 ? (
            <CardBody>
              <EmptyState title="No accounts match" description="Try another search or type." />
            </CardBody>
          ) : (
            <Table aria-label="Opening balances" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-24">Code</TH>
                  <TH>Account</TH>
                  <TH className="hidden md:table-cell">Type</TH>
                  <TH numeric className="hidden lg:table-cell">
                    Current balance
                  </TH>
                  <TH numeric className="w-44">
                    Opening balance
                  </TH>
                </TR>
              </THead>
              <TBody>
                {TYPE_ORDER.map((t) => {
                  const group = shown.filter((a) => a.type === t);
                  if (group.length === 0) return null;
                  return (
                    <React.Fragment key={t}>
                      <TR className="bg-stone-50 hover:bg-stone-50">
                        <TD colSpan={5} className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                          {TYPE_TITLE[t]}
                        </TD>
                      </TR>
                      {group.map((a) => {
                        const value = amounts[a.id] ?? '';
                        const bad = value.trim() !== '' && !isValidDecimal(value);
                        return (
                          <TR key={a.id} data-testid="ob-row" className={cn(entered(value) && 'bg-brand-50/30', highlight === a.id && 'bg-brand-50 outline outline-2 outline-brand-400')}>
                            <TD className="font-mono text-xs text-stone-500">{a.code}</TD>
                            <TD>
                              {a.name}
                              <p className="text-xs text-stone-500 md:hidden">{capitalize(a.type)}</p>
                            </TD>
                            <TD className="hidden text-stone-600 md:table-cell">{capitalize(a.type)}</TD>
                            <TD numeric className="hidden text-stone-500 lg:table-cell">
                              {formatMoney(a.balance ?? '0', cur)}
                            </TD>
                            <TD numeric>
                              {isDocumentDriven(a) ? (
                                <span className="text-xs text-stone-500">Enter as documents</span>
                              ) : (
                                <MoneyInput
                                  data-account-input={a.id}
                                  allowNegative
                                  aria-label={`Opening balance for ${a.code} ${a.name}`}
                                  aria-invalid={bad || undefined}
                                  placeholder="0.00"
                                  value={value}
                                  disabled={!isAdmin || posting}
                                  onChange={(v) => setAmount(a.id, v)}
                                />
                              )}
                            </TD>
                          </TR>
                        );
                      })}
                      <TR className="font-semibold hover:bg-transparent">
                        <TD colSpan={2} className="text-stone-700">
                          Total {TYPE_TITLE[t].toLowerCase()} entered
                        </TD>
                        <TD className="hidden md:table-cell" />
                        <TD className="hidden lg:table-cell" />
                        <TD numeric data-testid={`ob-subtotal-${t}`}>
                          {formatMoney(totals.subtotal[t], cur)}
                        </TD>
                      </TR>
                    </React.Fragment>
                  );
                })}
              </TBody>
            </Table>
          )}
          {filtering && hiddenWithAmounts > 0 && (
            <CardBody className="border-t border-stone-200 text-xs text-stone-500">
              {hiddenWithAmounts} entered {hiddenWithAmounts === 1 ? 'amount is' : 'amounts are'} hidden by the filter but still included in the totals.
            </CardBody>
          )}
        </Card>

        <div className="space-y-4 lg:sticky lg:top-4">
          <Card>
            <CardHeader title="Entry preview" />
            <CardBody className="space-y-2 text-sm">
              <Row label="Total debits" value={formatMoney(totals.debit, cur)} testId="ob-total-debit" />
              <Row label="Total credits" value={formatMoney(totals.credit, cur)} testId="ob-total-credit" />
              <div className="border-t border-stone-200 pt-2">
                <Row
                  label={
                    <span>
                      Owner&rsquo;s starting equity{' '}
                      <Badge tone={isZeroDecimal(totals.plug) ? 'neutral' : totals.plug.startsWith('-') ? 'amber' : 'blue'}>{isZeroDecimal(totals.plug) ? 'none' : totals.plug.startsWith('-') ? 'debit' : 'credit'}</Badge>
                    </span>
                  }
                  value={formatMoney(totals.plug.startsWith('-') ? totals.plug.slice(1) : totals.plug, cur)}
                  testId="ob-plug"
                  strong
                />
                {balanced ? (
                  <p className="mt-1 text-xs text-emerald-700" data-testid="ob-balanced">
                    <span className="font-semibold">Balanced ✓</span> Debits equal credits, so nothing goes to starting equity.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-stone-500">
                    {plugAccount ? `Recorded in ${plugAccount.code} ${plugAccount.name}` : 'Recorded in the Opening Balance Equity account'} so the entry balances.
                  </p>
                )}
              </div>
              {invalid.length > 0 && (
                <p role="alert" className="text-xs text-red-600">
                  {invalid.length} {invalid.length === 1 ? 'amount is' : 'amounts are'} not valid numbers.
                </p>
              )}
            </CardBody>
            <CardBody className="border-t border-stone-200">
              <Button type="submit" className="w-full" loading={posting} disabled={!canSubmit}>
                Save starting balances
              </Button>
              <p className="mt-2 text-xs text-stone-500">
                {totals.count === 0 ? 'Enter at least one balance to save.' : `${totals.count} ${totals.count === 1 ? 'account' : 'accounts'} saved as one journal entry dated ${formatDate(date)}.`}
              </p>
              {dirty && (
                <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" onClick={onClear} disabled={posting}>
                  Clear all amounts
                </Button>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardBody className="text-sm text-stone-600">
              Money customers owe you, customer deposits and sales tax to pay aren&rsquo;t entered here: add the unpaid invoices and payments themselves so they can be paid and matched later.
            </CardBody>
          </Card>
        </div>
      </form>

      <PasteDialog open={pasteOpen} onClose={() => setPasteOpen(false)} onApply={applyPaste} />
    </>
  );
}

function PasteDialog({ open, onClose, onApply }: { open: boolean; onClose: () => void; onApply: (text: string) => void }) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const close = () => {
    setText('');
    setError(null);
    onClose();
  };
  const submit = () => {
    if (parsePastedBalances(text).rows.length === 0) {
      setError('No rows with an account code and an amount were found.');
      return;
    }
    setText('');
    setError(null);
    onApply(text);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Paste from spreadsheet"
      description="Copy two or more columns from a spreadsheet or CSV: the account code first and the balance last. Header rows are skipped."
      size="lg"
      dirty={text.trim() !== ''}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit">Fill balances</Button>
        </>
      }
    >
      <Field label="Rows" htmlFor="ob-paste-text" hint="Tab- or comma-separated, one account per line, e.g. 1000⇥Checking⇥12,500.00" error={error ?? undefined}>
        <Textarea
          id="ob-paste-text"
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Enter adds lines here; Ctrl/Cmd+Enter applies.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className="font-mono text-xs"
          placeholder={'1000\tChecking\t12500.00\n2100\tCredit card\t830.25'}
          spellCheck={false}
        />
      </Field>
    </Dialog>
  );
}

function Row({ label, value, testId, strong }: { label: React.ReactNode; value: string; testId: string; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3', strong && 'font-semibold')}>
      <span className="text-stone-700">{label}</span>
      <span className="tabular" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
