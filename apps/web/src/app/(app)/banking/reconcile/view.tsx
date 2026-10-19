'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { BankAccountDto, ReconciliationDto } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { addDays, DateInput, endOfPreviousMonth } from '@/components/ui/date-input';
import { Field, Select, Textarea } from '@/components/ui/input';
import { FilterChips } from '@/components/ui/list';
import { MoneyInput } from '@/components/ui/money-input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useBankAccounts, useReconciliations, useStartReconciliation } from '@/lib/queries/reconciliation';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { isValidDecimal } from '@/lib/decimal';
import { useListParams } from '@/lib/use-list-params';
import { formatDate, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { Term } from '@/components/ui/term';
import { negateDecimal } from '@/lib/decimal';

const STATUS_LABEL: Record<ReconciliationDto['status'], string> = { in_progress: 'In progress', completed: 'Completed', flagged: 'Needs another look' };

export function ReconciliationStatusBadge({ status }: { status: ReconciliationDto['status'] }) {
  const tone = status === 'completed' ? 'green' : status === 'flagged' ? 'red' : 'amber';
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

export function ReconcileListView() {
  const { company } = useCompany();
  const list = useListParams();
  const bankAccountId = list.get('bankAccountId');
  const accounts = useBankAccounts();
  const q = useReconciliations(bankAccountId);

  const selectedAccount = (accounts.data ?? []).find((a) => a.id === bankAccountId) ?? null;

  return (
    <>
      <PageHeader
        title="Bank reconciliation"
        description={
          <>
            <Term id="reconcile">Check that Evenbooks agrees with your bank statement</Term>, so you know nothing is missing or counted twice. Tick each transaction that is on the statement until the totals match.
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Statements"
            description={selectedAccount ? selectedAccount.name : 'Every account'}
            actions={
              <Select aria-label="Filter by bank account" value={bankAccountId ?? ''} onChange={(e) => list.set('bankAccountId', e.target.value || null)} className="w-56">
                <option value="">All bank accounts</option>
                {(accounts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            }
          />
          <div className="px-4 pt-3 empty:hidden">
            <FilterChips
              filters={bankAccountId ? [{ key: 'bankAccountId', label: `Account: ${selectedAccount?.name ?? '…'}` }] : []}
              onRemove={(k) => list.set(k, null)}
              onClear={() => list.clear(['bankAccountId'])}
            />
          </div>
          {q.isPending && <Spinner />}
          {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
          {q.data && q.data.length === 0 && (
            <CardBody>
              <EmptyState title="No reconciliations yet" description="Start one with the opening and closing balances printed on your statement." />
            </CardBody>
          )}
          {q.data && q.data.length > 0 && (
            <Table aria-label="Reconciliations">
              <THead>
                <TR>
                  {!bankAccountId && <TH className="hidden md:table-cell">Account</TH>}
                  <TH>Statement period</TH>
                  <TH numeric>Closing balance</TH>
                  <TH>Status</TH>
                  <TH className="w-20">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {q.data.map((r) => (
                  <TR key={r.id} href={`/banking/reconcile/${r.id}`}>
                    {!bankAccountId && <TD className="hidden md:table-cell">{r.bankAccountName}</TD>}
                    <TD>
                      <span className="font-medium">
                        {formatDate(r.statementStartDate)} – {formatDate(r.statementEndDate)}
                      </span>
                      {!bankAccountId && <p className="text-xs text-stone-500 md:hidden">{r.bankAccountName}</p>}
                    </TD>
                    <TD numeric>{formatMoney(r.statementClosingBalance, company.baseCurrency)}</TD>
                    <TD>
                      <ReconciliationStatusBadge status={r.status} />
                      {r.status === 'flagged' && r.flaggedReason && <p className="mt-1 text-xs text-red-700">{r.flaggedReason}</p>}
                    </TD>
                    <TD>
                      <LinkButton href={`/banking/reconcile/${r.id}`} variant="secondary" size="sm">
                        Open
                      </LinkButton>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        <StartReconciliationCard accounts={accounts.data ?? []} accountsLoaded={accounts.isSuccess} filterAccountId={bankAccountId ?? null} />
      </div>
    </>
  );
}

/** Last day of the month containing `date` (YYYY-MM-DD). */
function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

/**
 * The next statement period: the day after the last completed statement through
 * the end of that month, else last calendar month.
 */
function nextPeriod(lastCompleted: ReconciliationDto | null): { startDate: string; endDate: string } {
  if (lastCompleted) {
    const start = addDays(lastCompleted.statementEndDate, 1);
    return { startDate: start, endDate: endOfMonth(start) };
  }
  const end = endOfPreviousMonth();
  return { startDate: `${end.slice(0, 7)}-01`, endDate: end };
}

function StartReconciliationCard({ accounts, accountsLoaded, filterAccountId }: { accounts: BankAccountDto[]; accountsLoaded: boolean; filterAccountId: string | null }) {
  const [accountId, setAccountId] = React.useState<string>(filterAccountId ?? '');

  // Follow the list filter; with a single bank account there is nothing to choose.
  React.useEffect(() => {
    if (filterAccountId) setAccountId(filterAccountId);
  }, [filterAccountId]);
  React.useEffect(() => {
    if (!accountId && accounts.length === 1) setAccountId(accounts[0]!.id);
  }, [accountId, accounts]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const sessions = useReconciliations(account?.id);
  const forAccount = account ? (sessions.data ?? []).filter((s) => s.bankAccountId === account.id) : [];
  const inProgress = forAccount.find((s) => s.status === 'in_progress') ?? null;
  // The list is ordered by statement end descending, so the first completed one is the latest.
  const lastCompleted = forAccount.find((s) => s.status === 'completed') ?? null;

  return (
    <Card>
      <CardHeader title="Start reconciliation" description="Enter the balances printed on the bank statement." />
      <CardBody className="space-y-4">
        {accountsLoaded && accounts.length === 0 && <p className="text-sm text-stone-500">Add a bank account under Bank accounts first.</p>}
        {accounts.length > 0 && (
          <Field label="Bank account" htmlFor="rs-account" required>
            <Select id="rs-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose a bank account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {account && sessions.isPending && <Spinner />}
        {account && sessions.isError && <ErrorNotice error={sessions.error} onRetry={() => sessions.refetch()} />}
        {account && inProgress && (
          <div className="space-y-3 text-sm text-stone-700">
            <p>
              A reconciliation for the statement ending {formatDate(inProgress.statementEndDate)} is already in progress. Finish or delete it before starting another.
            </p>
            <LinkButton href={`/banking/reconcile/${inProgress.id}`} className="w-full">
              Continue reconciliation
            </LinkButton>
          </div>
        )}
        {account && sessions.isSuccess && !inProgress && <StartForm key={`${account.id}:${lastCompleted?.id ?? ''}`} account={account} lastCompleted={lastCompleted} />}
      </CardBody>
    </Card>
  );
}

/** Keyed by account and its last completed statement, so the prefills are computed once per account. */
function StartForm({ account, lastCompleted }: { account: BankAccountDto; lastCompleted: ReconciliationDto | null }) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const start = useStartReconciliation();
  const prefillOpening = lastCompleted?.statementClosingBalance ?? null;
  // Statement balances here count what is owed on a card as positive; card providers report it as negative.
  const prefillClosing = account.lastBalance ? (account.kind === 'credit_card' ? negateDecimal(account.lastBalance) : account.lastBalance) : null;
  const isCard = account.kind === 'credit_card';
  const [form, setForm] = React.useState(() => ({ ...nextPeriod(lastCompleted), opening: prefillOpening ?? '', closing: prefillClosing ?? '', notes: '' }));
  const [touched, setTouched] = React.useState(false);

  const openingError = touched && !isValidDecimal(form.opening) ? 'Enter the opening balance' : null;
  const closingError = touched && !isValidDecimal(form.closing) ? 'Enter the closing balance' : null;
  const canSubmit = isValidDecimal(form.opening) && isValidDecimal(form.closing) && form.startDate <= form.endDate;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    start.mutate(
      {
        bankAccountId: account.id,
        statementStartDate: form.startDate,
        statementEndDate: form.endDate,
        statementOpeningBalance: form.opening.trim(),
        statementClosingBalance: form.closing.trim(),
        notes: form.notes.trim() || null,
      },
      {
        onSuccess: (detail) => {
          toast.success('Reconciliation started');
          router.push(`/banking/reconcile/${detail.id}`);
        },
        onError: (err) => onError(err, 'Could not start reconciliation'),
      },
    );
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate aria-label="Start reconciliation">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Statement start" htmlFor="rs-start" required>
          <DateInput id="rs-start" value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v })} presets={[]} />
        </Field>
        <Field label="Statement end" htmlFor="rs-end" required error={form.startDate > form.endDate ? 'End must be on or after start' : null}>
          <DateInput id="rs-end" value={form.endDate} onChange={(v) => setForm({ ...form, endDate: v })} />
        </Field>
      </div>
      <Field
        label="Opening balance"
        htmlFor="rs-open"
        required
        error={openingError}
        hint={
          prefillOpening !== null && lastCompleted
            ? `From the last completed statement (ended ${formatDate(lastCompleted.statementEndDate)}).`
            : isCard
              ? 'The previous balance on the statement: what you owed at the start.'
              : undefined
        }
      >
        <MoneyInput id="rs-open" allowNegative placeholder="0.00" value={form.opening} onChange={(v) => setForm({ ...form, opening: v })} aria-invalid={openingError ? true : undefined} />
      </Field>
      <Field
        label="Closing balance"
        htmlFor="rs-close"
        required
        error={closingError}
        hint={
          prefillClosing !== null && account.lastBalanceAt
            ? `Prefilled with the ${isCard ? 'amount owed' : "bank's balance"} on ${formatDate(account.lastBalanceAt.slice(0, 10))}; use the statement's figure if it differs.`
            : isCard
              ? 'The new balance on the statement: what you owed at the end.'
              : 'As printed on the statement.'
        }
      >
        <MoneyInput id="rs-close" allowNegative placeholder="0.00" value={form.closing} onChange={(v) => setForm({ ...form, closing: v })} aria-invalid={closingError ? true : undefined} />
      </Field>
      <Field label="Notes" htmlFor="rs-notes">
        <Textarea id="rs-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
      <Button type="submit" loading={start.isPending} disabled={touched && !canSubmit} className="w-full">
        Start reconciliation
      </Button>
    </form>
  );
}
