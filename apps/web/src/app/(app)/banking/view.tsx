'use client';
import { AlertTriangle, Archive, ArchiveRestore, CheckCircle2, Pencil, Upload } from 'lucide-react';
import * as React from 'react';
import Link from 'next/link';
import type { BankAccountDto } from '@evenbooks/contracts';
import { AccountPicker } from '@/components/account-picker';
import { Button, LinkButton } from '@/components/ui/button';
import { ActionMenu } from '@/components/ui/action-menu';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { addDays, DateInput } from '@/components/ui/date-input';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Term } from '@/components/ui/term';
import { useToast } from '@/components/ui/toast';
import { useAccounts } from '@/lib/queries/accounts';
import { useBankAccounts, useCreateBankAccount, usePostStartingBalance, useUpdateBankAccount } from '@/lib/queries/banking';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useCompany, useToday } from '@/components/company-context';
import { BankConnections, suggestLedgerCode } from '@/components/bank-connections';
import { compareDecimals, isValidDecimal, negateDecimal, subtractDecimals } from '@/lib/decimal';
import { cn } from '@/lib/utils';

type Kind = 'bank' | 'credit_card';
const kindLabel: Record<Kind, string> = { bank: 'Bank', credit_card: 'Credit card' };

/** The bank's latest balance in Evenbooks' terms. Card providers report the amount owed as a negative balance; Evenbooks counts it as positive. */
function bankSide(b: BankAccountDto): string | null {
  if (!b.lastBalance) return null;
  return b.kind === 'credit_card' ? negateDecimal(b.lastBalance) : b.lastBalance;
}

/** Evenbooks minus bank balance, or null when they agree or the bank balance is unknown. */
function balanceGap(b: BankAccountDto): string | null {
  const bank = bankSide(b);
  if (!bank || b.ledgerBalance === undefined) return null;
  const gap = subtractDecimals(b.ledgerBalance, bank);
  return compareDecimals(gap, '0') === 0 ? null : gap;
}

/** A balance as the owner reads it: money in the account, or what is owed on a card (positive = owed). */
function balanceText(kind: Kind, value: string, currency: string): string {
  if (kind === 'bank') return formatMoney(value, currency);
  return compareDecimals(value, '0') < 0 ? `Overpaid ${formatMoney(negateDecimal(value), currency)}` : `Owed ${formatMoney(value, currency)}`;
}

export function BankingOverviewView() {
  const { company, isAdmin } = useCompany();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const update = useUpdateBankAccount();
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const q = useBankAccounts({ includeInactive });
  const [adding, setAdding] = React.useState(false);
  const [renaming, setRenaming] = React.useState<BankAccountDto | null>(null);
  const cur = company.baseCurrency;

  const setActive = async (b: BankAccountDto, isActive: boolean) => {
    if (
      !isActive &&
      !(await confirm({
        title: `Deactivate ${b.name}?`,
        description: 'It is hidden from pickers, imports and reconciliation. Its transactions and history are kept, and you can reactivate it any time from “Show inactive”.',
        confirmLabel: 'Deactivate',
        tone: 'danger',
      }))
    )
      return;
    update.mutate(
      { id: b.id, input: { version: b.version, isActive } },
      {
        onSuccess: () => toast.success(isActive ? 'Bank account reactivated' : 'Bank account deactivated', b.name),
        onError: (e) => onError(e, 'Could not update bank account'),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Bank accounts"
        description="The bank accounts and cards your business uses. Bring in their transactions, then check them against each statement."
        actions={
          <>
            <Checkbox label="Show inactive" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            {isAdmin && <Button onClick={() => setAdding(true)}>Add bank account</Button>}
          </>
        }
      />
      {/* Stacked rather than side by side: the accounts table needs the full width for its actions. */}
      <div className="space-y-4">
        <Card>
          <CardHeader title="Accounts" />
          {q.isPending && <Spinner />}
          {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
          {q.data && q.data.length === 0 && (
            <CardBody>
              <EmptyState
                title="No bank accounts yet"
                description="Add your bank account or card to bring in its transactions."
                action={isAdmin ? <Button onClick={() => setAdding(true)}>Add bank account</Button> : undefined}
              />
            </CardBody>
          )}
          {q.data && q.data.length > 0 && (
            <Table aria-label="Bank accounts">
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH numeric className="hidden sm:table-cell">
                    Balance in Evenbooks
                  </TH>
                  <TH numeric className="hidden lg:table-cell">
                    Balance at bank
                  </TH>
                  <TH className="hidden md:table-cell">To review</TH>
                  <TH className="hidden sm:table-cell">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {q.data.map((b) => {
                  const bank = bankSide(b);
                  const importHref = `/banking/import?bankAccountId=${b.id}`;
                  const reconcile = (
                    <LinkButton variant="secondary" size="sm" href={`/banking/reconcile?bankAccountId=${b.id}`}>
                      Reconcile
                    </LinkButton>
                  );
                  const menu = (
                    <ActionMenu
                      size="sm"
                      aria-label={`More actions for ${b.name}`}
                      groups={[
                        [{ label: 'Import CSV', icon: Upload, href: importHref, phoneOnly: true }],
                        [isAdmin && { label: 'Rename…', icon: Pencil, onSelect: () => setRenaming(b) }],
                        [
                          isAdmin &&
                            (b.isActive
                              ? { label: 'Deactivate…', icon: Archive, description: 'Hide it; its history is kept', onSelect: () => void setActive(b, false) }
                              : { label: 'Reactivate', icon: ArchiveRestore, onSelect: () => void setActive(b, true) }),
                        ],
                      ]}
                    />
                  );
                  return (
                    <TR key={b.id} className={!b.isActive ? 'opacity-60' : undefined}>
                      <TD>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{b.name}</span>
                          <Badge tone={b.kind === 'bank' ? 'blue' : 'purple'}>{kindLabel[b.kind]}</Badge>
                          {!b.isActive && <Badge tone="neutral">Inactive</Badge>}
                        </div>
                        {b.unreviewedCount ? (
                          <Link href={`/banking/inbox?bankAccountId=${b.id}`} className="text-xs text-brand-700 hover:underline md:hidden">
                            {b.unreviewedCount} to review
                          </Link>
                        ) : null}
                        {/* Phones get one column: balances, the gap and the actions stack under the name. */}
                        <div className="mt-1 space-y-1.5 sm:hidden">
                          <p className="tabular-nums">
                            {balanceText(b.kind, b.ledgerBalance ?? '0', cur)}
                            {bank && <span className="text-xs text-stone-500"> · At bank: {balanceText(b.kind, bank, cur)}</span>}
                          </p>
                          <BalanceGap account={b} currency={cur} align="start" />
                          <div className="flex items-center gap-1.5">
                            {reconcile}
                            {menu}
                          </div>
                        </div>
                      </TD>
                      <TD numeric className="hidden sm:table-cell">
                        <span data-testid="balance-evenbooks">{balanceText(b.kind, b.ledgerBalance ?? '0', cur)}</span>
                        {bank && <p className="text-xs font-normal text-stone-500 lg:hidden">At bank: {balanceText(b.kind, bank, cur)}</p>}
                        <BalanceGap account={b} currency={cur} />
                      </TD>
                      <TD numeric className="hidden lg:table-cell">
                        {bank ? (
                          <>
                            <span data-testid="balance-bank">{balanceText(b.kind, bank, cur)}</span>
                            <p className="text-xs font-normal text-stone-500">{b.lastSyncedAt ? `Synced ${formatDateTime(b.lastSyncedAt)}` : b.lastBalanceAt ? formatDateTime(b.lastBalanceAt) : ''}</p>
                          </>
                        ) : (
                          <span className="text-stone-400">Not connected</span>
                        )}
                      </TD>
                      <TD className="hidden md:table-cell">
                        {b.unreviewedCount ? (
                          <Link href={`/banking/inbox?bankAccountId=${b.id}`} className="text-brand-700 hover:underline">
                            <Badge tone="amber">{b.unreviewedCount} to review</Badge>
                          </Link>
                        ) : (
                          <Badge tone="green">All reviewed</Badge>
                        )}
                      </TD>
                      <TD className="hidden whitespace-nowrap sm:table-cell">
                        <div className="flex items-center justify-end gap-1.5">
                          <LinkButton variant="secondary" size="sm" href={importHref}>
                            Import CSV
                          </LinkButton>
                          {reconcile}
                          {menu}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
        <BankConnections />
      </div>
      <AddBankAccountDialog open={adding} onClose={() => setAdding(false)} existing={q.data ?? []} />
      <RenameBankAccountDialog account={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}

/** Shown under "Balance in Evenbooks" when it disagrees with the bank's latest balance, with the likely reason. */
function BalanceGap({ account: b, currency, align = 'end' }: { account: BankAccountDto; currency: string; align?: 'start' | 'end' }) {
  const gap = balanceGap(b);
  if (!gap) return null;
  const amount = formatMoney(gap.replace(/^-/, ''), currency);
  const higher = compareDecimals(gap, '0') > 0;
  const what = b.kind === 'credit_card' ? `Evenbooks shows ${amount} ${higher ? 'more' : 'less'} owed than the bank.` : `Evenbooks shows ${amount} ${higher ? 'more' : 'less'} than the bank.`;
  const why = b.unreviewedCount
    ? `${b.unreviewedCount} transaction${b.unreviewedCount === 1 ? ' is' : 's are'} still to review, which usually explains it.`
    : 'Look for a missing or doubled transaction, then reconcile.';
  return (
    <p
      className={cn('mt-1 flex items-start gap-1 whitespace-normal text-left text-xs font-normal text-amber-800', align === 'end' ? 'ml-auto max-w-72 justify-end' : 'max-w-sm')}
      data-testid={align === 'end' ? 'balance-gap' : undefined}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {what} {why}
      </span>
    </p>
  );
}

interface Added {
  account: BankAccountDto;
  /** The starting balance that was recorded, if any. */
  balance: { amount: string; date: string } | null;
}

/**
 * Add a bank account or card: a name, a type and the statement balance it starts from. The account
 * in the chart of accounts is created with the next free code; choosing it lives under Advanced.
 */
function AddBankAccountDialog({ open, onClose, existing }: { open: boolean; onClose: () => void; existing: BankAccountDto[] }) {
  const { company } = useCompany();
  const today = useToday();
  const create = useCreateBankAccount();
  const postBalance = usePostStartingBalance();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const accounts = useAccounts({ includeArchived: true });
  // Statement balance for the day before the books start, else the day they pick.
  const defaultDate = company.booksStartDate ? addDays(company.booksStartDate, -1) : today;
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Kind>('bank');
  const [balance, setBalance] = React.useState('');
  const [balanceDate, setBalanceDate] = React.useState(defaultDate);
  const [advanced, setAdvanced] = React.useState(false);
  const [mode, setMode] = React.useState<'existing' | 'new'>('new');
  const [ledgerAccountId, setLedgerAccountId] = React.useState<string | null>(null);
  const [newCode, setNewCode] = React.useState('');
  const [codeTouched, setCodeTouched] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [added, setAdded] = React.useState<Added | null>(null);
  const idem = React.useRef(idempotencyKey());

  React.useEffect(() => {
    if (open) {
      setName('');
      setKind('bank');
      setBalance('');
      setBalanceDate(defaultDate);
      setAdvanced(false);
      setMode('new');
      setLedgerAccountId(null);
      setNewCode('');
      setCodeTouched(false);
      setNewName('');
      setNameTouched(false);
      setSubmitted(false);
      setAdded(null);
      idem.current = idempotencyKey();
    }
    // Reset once per opening; the default date only matters then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Suggest the next free code for the kind until the user types their own.
  const all = accounts.data;
  React.useEffect(() => {
    if (open && all && !codeTouched) setNewCode(suggestLedgerCode(all, kind, []));
  }, [open, all, kind, codeTouched]);

  const linked = new Set(existing.map((b) => b.ledgerAccountId));
  const role = kind === 'bank' ? 'bank' : 'credit_card';
  const hasCandidates = (all ?? []).some((a) => a.isActive && a.role === role && !linked.has(a.id));
  const ledgerName = nameTouched ? newName : name;
  const codeTaken = (all ?? []).some((a) => a.code === newCode.trim());
  // An existing account already carries its balance; only a new one needs a starting point.
  const asksBalance = mode === 'new';
  const balanceEntered = asksBalance && balance.trim() !== '';
  const isCard = kind === 'credit_card';
  const datedLabel = `${isCard ? 'Amount owed' : 'Balance'} on ${/^\d{4}-\d{2}-\d{2}$/.test(balanceDate) ? formatDate(balanceDate) : '…'}`;

  const errors = {
    name: !name.trim() ? 'Enter a name' : null,
    balance: balanceEntered && !isValidDecimal(balance) ? 'Enter an amount, or leave it blank' : null,
    date: balanceEntered && !/^\d{4}-\d{2}-\d{2}$/.test(balanceDate) ? 'Choose the statement date' : null,
    ledger: mode === 'existing' && !ledgerAccountId ? 'Choose an account' : null,
    code: mode === 'new' ? (!newCode.trim() ? 'Enter a code' : codeTaken ? 'Another account already uses this code' : null) : null,
    lname: mode === 'new' && !ledgerName.trim() ? 'Enter a name' : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const pending = create.isPending || postBalance.isPending;

  const submit = () => {
    setSubmitted(true);
    if (!valid) {
      // Problems in the Advanced section stay hidden unless it opens.
      if (errors.ledger || errors.code || errors.lname || (errors.date && company.booksStartDate)) setAdvanced(true);
      return;
    }
    if (pending) return;
    create.mutate(
      {
        name: name.trim(),
        kind,
        ...(mode === 'existing' && ledgerAccountId ? { ledgerAccountId } : { newLedgerAccount: { code: newCode.trim(), name: ledgerName.trim() } }),
      },
      {
        onSuccess: (account) => {
          toast.success(isCard ? 'Card added' : 'Bank account added', account.name);
          if (!balanceEntered || compareDecimals(balance, '0') === 0) return setAdded({ account, balance: null });
          const amount = balance.trim();
          postBalance.mutate(
            { accountId: account.ledgerAccountId, balance: amount, date: balanceDate, idempotencyKey: idem.current },
            {
              onSuccess: () => setAdded({ account, balance: { amount, date: balanceDate } }),
              onError: (e) => {
                onError(e, 'Could not record the starting balance');
                setAdded({ account, balance: null });
              },
            },
          );
        },
        onError: (e) => onError(e, isCard ? 'Could not add card' : 'Could not add bank account'),
      },
    );
  };

  if (added) {
    const a = added.account;
    const card = a.kind === 'credit_card';
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={`${a.name} is added`}
        onSubmit={onClose}
        footer={
          <>
            <LinkButton variant="secondary" href={`/banking/import?bankAccountId=${a.id}`}>
              Import CSV
            </LinkButton>
            <Button type="submit">Done</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-stone-700" data-testid="bank-account-added">
          {added.balance ? (
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
              <span>
                Starting balance recorded: {balanceText(a.kind, added.balance.amount, company.baseCurrency)} on {formatDate(added.balance.date)}.
              </span>
            </p>
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <p>
                Enter what your statement said {card ? 'you owed' : 'was in the account'} when your books start, so Evenbooks matches your bank.
              </p>
              <Link href={`/settings/opening-balances?accountId=${a.ledgerAccountId}`} className="mt-1 inline-block font-medium text-brand-700 hover:underline">
                Enter its starting balance
              </Link>
            </div>
          )}
          <p>Next, bring in its transactions: import a CSV file downloaded from your bank, or connect your bank for an automatic feed below.</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add bank account"
      description="A business bank account or credit card. You can bring in its transactions next."
      onSubmit={submit}
      dirty={!!name.trim() && !pending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Add account
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="ba-name" required hint="How it shows in Evenbooks, e.g. “Chase checking”." error={submitted ? errors.name : null}>
          <Input id="ba-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-invalid={submitted && errors.name ? true : undefined} />
        </Field>
        <Field label="Type" htmlFor="ba-kind" required>
          <Select
            id="ba-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setLedgerAccountId(null);
            }}
          >
            <option value="bank">Bank account</option>
            <option value="credit_card">Credit card</option>
          </Select>
        </Field>
        {asksBalance && (
          <Field
            label={datedLabel}
            htmlFor="ba-balance"
            className={company.booksStartDate ? 'sm:col-span-2' : undefined}
            hint={
              isCard
                ? 'From your card statement. Leave blank to add it later.'
                : `From your bank statement${company.booksStartDate ? ', the day before your books start' : ''}. Leave blank to add it later.`
            }
            error={submitted ? errors.balance : null}
          >
            <MoneyInput id="ba-balance" allowNegative placeholder="0.00" value={balance} onChange={setBalance} className={company.booksStartDate ? 'sm:max-w-56' : undefined} aria-invalid={submitted && errors.balance ? true : undefined} />
          </Field>
        )}
        {asksBalance && !company.booksStartDate && (
          <Field label="Statement date" htmlFor="ba-date" error={submitted ? errors.date : null}>
            <DateInput id="ba-date" value={balanceDate} onChange={setBalanceDate} />
          </Field>
        )}
      </div>
      <details className="mt-4 rounded-md border border-stone-200" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-stone-700">Advanced</summary>
        <div className="grid gap-4 border-t border-stone-200 p-3 sm:grid-cols-2">
          <p className="text-xs text-stone-500 sm:col-span-2">Each bank account or card also appears in your chart of accounts. Evenbooks picks the next free code for you.</p>
          <Field label="In the chart of accounts" htmlFor="ba-mode" className="sm:col-span-2">
            <Select id="ba-mode" value={mode} onChange={(e) => setMode(e.target.value as 'existing' | 'new')}>
              <option value="new">Add it to the chart of accounts</option>
              <option value="existing">Use an account already in the chart</option>
            </Select>
          </Field>
          {mode === 'existing' && (
            <Field
              label="Existing account"
              htmlFor="ba-ledger"
              required
              className="sm:col-span-2"
              error={submitted ? errors.ledger : null}
              hint={hasCandidates ? `${isCard ? 'Credit card' : 'Bank'} accounts not linked yet. Its balance comes along.` : `There are no unlinked ${isCard ? 'credit card' : 'bank'} accounts in the chart.`}
            >
              <AccountPicker
                id="ba-ledger"
                value={ledgerAccountId}
                onChange={(v) => setLedgerAccountId(v)}
                allow={(a) => a.role === role && !linked.has(a.id)}
                createType={false}
                invalid={submitted && !!errors.ledger}
              />
            </Field>
          )}
          {mode === 'new' && (
            <>
              <Field label="Account code" htmlFor="ba-code" required hint={codeTouched ? undefined : 'Next free code, suggested.'} error={submitted || codeTaken ? errors.code : null}>
                <Input
                  id="ba-code"
                  value={newCode}
                  onChange={(e) => {
                    setNewCode(e.target.value);
                    setCodeTouched(true);
                  }}
                  maxLength={20}
                  aria-invalid={errors.code && (submitted || codeTaken) ? true : undefined}
                />
              </Field>
              <Field label="Account name in the chart" htmlFor="ba-lname" required hint={nameTouched ? undefined : 'Follows the name above until you change it.'} error={submitted ? errors.lname : null}>
                <Input
                  id="ba-lname"
                  value={ledgerName}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    setNameTouched(true);
                  }}
                  maxLength={120}
                />
              </Field>
              {company.booksStartDate && (
                <Field label="Statement date" htmlFor="ba-date" hint="The day your starting balance is from." error={submitted ? errors.date : null}>
                  <DateInput id="ba-date" value={balanceDate} onChange={setBalanceDate} />
                </Field>
              )}
            </>
          )}
        </div>
      </details>
      {asksBalance && (
        <p className="mt-3 text-xs text-stone-500">
          The balance becomes its <Term id="starting-balances">starting balance</Term>, so Evenbooks agrees with your bank from the first day.
        </p>
      )}
    </Dialog>
  );
}

function RenameBankAccountDialog({ account, onClose }: { account: BankAccountDto | null; onClose: () => void }) {
  const update = useUpdateBankAccount();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [name, setName] = React.useState('');
  React.useEffect(() => {
    if (account) setName(account.name);
  }, [account]);
  const save = () => {
    if (!account || !name.trim() || update.isPending) return;
    update.mutate(
      { id: account.id, input: { version: account.version, name: name.trim() } },
      {
        onSuccess: () => {
          toast.success('Bank account renamed');
          onClose();
        },
        onError: (e) => onError(e, 'Could not update bank account'),
      },
    );
  };
  return (
    <Dialog
      open={Boolean(account)}
      onClose={onClose}
      title={account ? `Rename ${account.name}` : 'Rename bank account'}
      onSubmit={save}
      dirty={!!account && name.trim() !== account.name && !update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={update.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="rn-name" required>
        <Input id="rn-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
    </Dialog>
  );
}
