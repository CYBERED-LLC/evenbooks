'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AccountDto, AccountType, LedgerCsvMapping, LedgerImportAccountDto, LedgerImportDto } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { ImportCashEditor } from '@/components/import-cash-editor';
import { Plus } from 'lucide-react';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { BackLink } from '@/components/ui/list';
import { AccountPicker, suggestAccountCode } from '@/components/account-picker';
import { Checkbox, Field, Input, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAccounts, useCreateAccount } from '@/lib/queries/accounts';
import { useCommitLedgerImport, useCreateLedgerImport, useDiscardLedgerImport, useLedgerImport, useLedgerImportChanges, useUpdateLedgerImport } from '@/lib/queries/ledger-imports';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { capitalize, formatDate, formatMoney } from '@/lib/format';
import { compareDecimals, sumDecimals } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { WaveExportSteps } from '../wave-steps';

/** Roles that only documents may post to (mirrors PROTECTED_CONTROL_ROLES). */
const CONTROL_ROLES = new Set<NonNullable<AccountDto['role']>>(['accounts_receivable', 'customer_deposits', 'sales_tax_payable']);
const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

function isMappingValid(m: LedgerCsvMapping): boolean {
  return Boolean(m.date && m.account && (m.amounts.amount || m.amounts.debit || m.amounts.credit));
}

function emptyMapping(headers: string[]): LedgerCsvMapping {
  return { date: headers[0] ?? '', account: headers[1] ?? '', description: null, memo: null, reference: null, group: null, grouping: 'sequence', amounts: { amount: null }, dateOrder: 'MDY' };
}

export function LedgerImportView() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get('id');
  const imp = useLedgerImport(id);
  const setId = (next: string | null) => router.replace(next ? `/settings/import/ledger?id=${next}` : '/settings/import/ledger');

  return (
    <>
      <BackLink listPath="/settings/import" label="Import data" />
      <PageHeader
        title="Import accounting history"
        description="Bring your past transactions over from Wave or another app. Nothing is saved until you choose Import."
      />
      {!id && <ChooseFile onCreated={(d) => setId(d.id)} />}
      {id && imp.isPending && <Spinner label="Reading the file…" />}
      {id && imp.isError && <ErrorNotice error={imp.error} onRetry={() => imp.refetch()} />}
      {imp.data && imp.data.status === 'previewed' && <Wizard key={imp.data.id} imp={imp.data} onReset={() => setId(null)} />}
      {imp.data && imp.data.status !== 'previewed' && <Finished imp={imp.data} onReset={() => setId(null)} />}
    </>
  );
}

function ChooseFile({ onCreated }: { onCreated: (d: LedgerImportDto) => void }) {
  const create = useCreateLedgerImport();
  const onError = useMutationErrorHandler();
  const [readError, setReadError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const onFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setReadError(null);
    let content: string;
    try {
      content = await file.text();
    } catch {
      setReadError('Could not read the file.');
      return;
    }
    if (!content.trim()) {
      setReadError('The file is empty.');
      return;
    }
    create.mutate({ fileName: file.name, content }, { onSuccess: onCreated, onError: (e) => onError(e, 'Could not read the export') });
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader title="Step 1 · Choose the export" description="A CSV file with one row per line of each transaction. The first row names the columns." />
      <CardBody className="space-y-3">
        <Field label="Ledger CSV file" htmlFor="ledger-file" required>
          <Input id="ledger-file" ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files)} disabled={create.isPending} className="h-auto py-1.5" />
        </Field>
        {create.isPending && <Spinner label="Reading and grouping transactions…" />}
        {readError && (
          <p role="alert" className="text-sm text-red-700">
            {readError}
          </p>
        )}
        <div>
          <h2 className="text-sm font-medium text-stone-800">From Wave</h2>
          <WaveExportSteps className="mt-1" />
        </div>
        <p className="text-sm text-stone-600">Other apps usually call it a general ledger, journal or transaction list export.</p>
        <p className="text-sm text-stone-600">Your customer list and unpaid invoices don&rsquo;t come over yet. Add unpaid invoices afterwards.</p>
      </CardBody>
    </Card>
  );
}

function Wizard({ imp, onReset }: { imp: LedgerImportDto; onReset: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const commit = useCommitLedgerImport();
  const discard = useDiscardLedgerImport();
  const changes = useLedgerImportChanges(imp.id, { onError: (e) => onError(e, 'Could not save your changes') });
  const idemRef = React.useRef(idempotencyKey());
  const headers = imp.headers ?? [];
  const [mapping, setMapping] = React.useState<LedgerCsvMapping>(imp.mapping ?? emptyMapping(headers));
  const [amountMode, setAmountMode] = React.useState<'single' | 'split'>(imp.mapping && !imp.mapping.amounts.amount ? 'split' : imp.mapping ? 'single' : 'split');
  // A recognized Wave file has its columns set already; the mapping stays one click away.
  const [showColumns, setShowColumns] = React.useState(!(imp.recognizedFormat && imp.mapping));

  const applyMapping = (next: LedgerCsvMapping) => {
    setMapping(next);
    if (!isMappingValid(next)) return;
    changes.saveMapping(next);
  };

  const accounts = imp.accounts ?? [];
  const effective = (a: LedgerImportAccountDto) => (changes.pending.has(a.source) ? (changes.pending.get(a.source) ?? null) : a.accountId);
  const unresolved = accounts.filter((a) => !effective(a) || (!changes.pending.has(a.source) && a.problem));
  const busy = changes.saving;
  const canImport = Boolean(imp.mapping) && !imp.alreadyCommitted && imp.readyCount > 0 && unresolved.length === 0 && !busy && !(imp.entries ?? []).some(e => e.cashReviewRequired && e.cashComponents === null);

  const col = (label: string, id: string, value: string | null | undefined, onChange: (v: string | null) => void, opts: { required?: boolean; none?: string } = {}) => (
    <Field label={label} htmlFor={id} required={opts.required}>
      <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{opts.required ? 'Select…' : (opts.none ?? 'None')}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <div className="space-y-4" aria-busy={busy}>
      <Card>
        <CardHeader
          title="Step 2 · Confirm the columns"
          description={
            <>
              {imp.fileName} · {imp.rowCount} rows · {imp.entryCount} transactions
              {imp.windowStart && imp.windowEnd && (
                <>
                  {' '}
                  · {formatDate(imp.windowStart)} – {formatDate(imp.windowEnd)}
                </>
              )}
            </>
          }
          actions={changes.mappingPending ? <Spinner label="Updating preview…" /> : undefined}
        />
        {!showColumns ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid="columns-recognized">
            <p className="text-sm text-stone-700">
              We recognized a Wave export{imp.recognizedFormat === 'wave_ledger' ? ' (Account Transactions report)' : ''}; columns are set.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setShowColumns(true)}>
              Change columns
            </Button>
          </div>
        ) : (
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {col('Date column', 'map-date', mapping.date, (v) => applyMapping({ ...mapping, date: v ?? '' }), { required: true })}
            {col('Account column', 'map-account', mapping.account, (v) => applyMapping({ ...mapping, account: v ?? '' }), { required: true })}
            {col('Transaction number column', 'map-group', mapping.group, (v) => applyMapping({ ...mapping, group: v }), { none: 'None: tell transactions apart another way' })}
            {!mapping.group && (
              <Field
                label="Which rows belong together"
                htmlFor="map-grouping"
                required
                hint="Reports listed account by account (like Wave’s General Ledger) need the same date and description. Exports that list each transaction’s lines one after another can go by order."
              >
                <Select
                  id="map-grouping"
                  value={mapping.grouping ?? 'sequence'}
                  onChange={(e) => applyMapping({ ...mapping, grouping: e.target.value as LedgerCsvMapping['grouping'] })}
                >
                  <option value="date-description">Rows with the same date and description</option>
                  <option value="sequence">Rows next to each other, until they add up</option>
                </Select>
              </Field>
            )}
            {col('Description column', 'map-desc', mapping.description, (v) => applyMapping({ ...mapping, description: v }))}
            {col('Line note column', 'map-memo', mapping.memo, (v) => applyMapping({ ...mapping, memo: v }))}
            {col('Reference number column', 'map-ref', mapping.reference, (v) => applyMapping({ ...mapping, reference: v }))}
            <Field label="Date order" htmlFor="map-order" required>
              <Select id="map-order" value={mapping.dateOrder} onChange={(e) => applyMapping({ ...mapping, dateOrder: e.target.value as LedgerCsvMapping['dateOrder'] })}>
                <option value="MDY">Month / day / year</option>
                <option value="DMY">Day / month / year</option>
                <option value="YMD">Year / month / day</option>
              </Select>
            </Field>
            <Field label="Amount format" htmlFor="map-mode" required>
              <Select
                id="map-mode"
                value={amountMode}
                onChange={(e) => {
                  const mode = e.target.value as 'single' | 'split';
                  setAmountMode(mode);
                  // Switching formats clears the other side; the preview updates once a column is chosen.
                  setMapping({ ...mapping, amounts: mode === 'single' ? { amount: null, invert: false } : { debit: null, credit: null } });
                }}
              >
                <option value="split">Two columns: Debit and Credit</option>
                <option value="single">One column, with minus signs</option>
              </Select>
            </Field>
            {amountMode === 'single' ? (
              <>
                {col('Amount column', 'map-amount', mapping.amounts.amount, (v) => applyMapping({ ...mapping, amounts: { amount: v, invert: mapping.amounts.invert } }), { required: true })}
                <div className="flex items-end pb-2">
                  <Checkbox
                    label="Flip plus and minus (if every transaction comes out backwards)"
                    checked={Boolean(mapping.amounts.invert)}
                    onChange={(e) => applyMapping({ ...mapping, amounts: { ...mapping.amounts, invert: e.target.checked } })}
                  />
                </div>
              </>
            ) : (
              <>
                {col('Debit column', 'map-debit', mapping.amounts.debit, (v) => applyMapping({ ...mapping, amounts: { debit: v, credit: mapping.amounts.credit ?? null } }))}
                {col('Credit column', 'map-credit', mapping.amounts.credit, (v) => applyMapping({ ...mapping, amounts: { debit: mapping.amounts.debit ?? null, credit: v } }))}
              </>
            )}
          </div>
          {!isMappingValid(mapping) && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              Choose the date, account and amount (or debit and credit) columns to see the transactions.
            </p>
          )}
        </CardBody>
        )}
      </Card>

      {imp.mapping && <AccountMapping accounts={accounts} pending={changes.pending} saving={busy} onMap={changes.mapAccounts} />}

      {imp.mapping && <Preview imp={imp} />}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm text-stone-600" aria-live="polite">
            {busy ? (
              <span data-testid="save-state">Saving…</span>
            ) : imp.alreadyCommitted ? (
              <span className="text-amber-800">This exact file has already been imported.</span>
            ) : unresolved.length > 0 ? (
              <span className="text-amber-800">
                Match {unresolved.length} more {unresolved.length === 1 ? 'account' : 'accounts'} to continue.
              </span>
            ) : imp.errorCount > 0 ? (
              <span>
                {imp.errorCount} {imp.errorCount === 1 ? 'transaction has' : 'transactions have'} problems and will be skipped; fix the export and import it again to bring them in.
              </span>
            ) : (
              <span>Everything is ready.</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onReset} disabled={commit.isPending}>
              Choose a different file
            </Button>
            <Button
              variant="secondary"
              loading={discard.isPending}
              disabled={commit.isPending}
              onClick={() =>
                discard.mutate(imp.id, {
                  onSuccess: () => {
                    toast.success('Import discarded');
                    onReset();
                  },
                  onError: (e) => onError(e, 'Could not discard import'),
                })
              }
            >
              Discard
            </Button>
            <Button
              loading={commit.isPending}
              disabled={!canImport}
              onClick={() =>
                commit.mutate(
                  { id: imp.id, idempotencyKey: idemRef.current },
                  {
                    onSuccess: (d) => {
                      toast.success(`Imported ${d.importedCount} ${d.importedCount === 1 ? 'transaction' : 'transactions'}`);
                      router.replace(`/settings/import/ledger?id=${d.id}`);
                    },
                    onError: (e) => onError(e, 'Import failed'),
                  },
                )
              }
            >
              Import {imp.readyCount} {imp.readyCount === 1 ? 'transaction' : 'transactions'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** A code written into the source name, e.g. "5110 Supplies", "5110 - Office supplies" or "Supplies (5110)". */
function codeInName(source: string): string | null {
  const m = source.match(/^\s*(\d{3,})(?=[\s\-–—:.·])/) ?? source.match(/\((\d{3,})\)\s*$/) ?? source.match(/^\s*(\d{3,})\s*$/);
  return m ? m[1]! : null;
}

/** Suggested code for a new account (stays inside the type's code block). */
const suggestCode = (pool: AccountDto[], type: AccountType): string => suggestAccountCode(pool, type);

const isControl = (a: AccountDto) => Boolean(a.role && CONTROL_ROLES.has(a.role));

/** The account name to create for a file account (receivables get a suffix; see the note on the card). */
function newAccountName(source: string): string {
  return (/receivable/i.test(source) ? `${source} (previous system)` : source).slice(0, 120);
}

function AccountMapping({
  accounts,
  pending,
  saving,
  onMap,
}: {
  accounts: LedgerImportAccountDto[];
  pending: ReadonlyMap<string, string | null>;
  saving: boolean;
  onMap: (changes: Record<string, string | null>) => void;
}) {
  const { company } = useCompany();
  const uid = React.useId();
  const chart = useAccounts();
  const everyAccount = useAccounts({ includeArchived: true });
  const createAccount = useCreateAccount();
  const onError = useMutationErrorHandler();
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState<LedgerImportAccountDto | null>(null);
  const [bulk, setBulk] = React.useState<{ done: number; total: number } | null>(null);
  const [show, setShow] = React.useState<'all' | 'unmatched'>('all');

  const effective = (a: LedgerImportAccountDto) => (pending.has(a.source) ? (pending.get(a.source) ?? null) : a.accountId);
  const isUnresolved = (a: LedgerImportAccountDto) => !effective(a) || (!pending.has(a.source) && Boolean(a.problem));
  const unresolvedRows = accounts.filter(isUnresolved);
  const active = (chart.data ?? []).filter((a) => a.isActive && !isControl(a));

  const codeMatches = unresolvedRows.flatMap((a) => {
    const code = codeInName(a.source);
    const hit = code ? active.find((o) => o.code === code) : undefined;
    return hit ? [[a.source, hit.id] as const] : [];
  });

  const matchByCode = () => {
    onMap(Object.fromEntries(codeMatches));
    toast.success(`Matched ${codeMatches.length} ${codeMatches.length === 1 ? 'account' : 'accounts'} by code`);
  };

  const createAllUnmatched = async () => {
    const targets = unresolvedRows;
    const names = targets.map((t) => newAccountName(t.source));
    const ok = await confirm({
      title: `Create ${targets.length} new ${targets.length === 1 ? 'account' : 'accounts'}?`,
      description: `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}. Types and codes are guessed from each name; you can change them later in the chart of accounts.`,
      confirmLabel: 'Create accounts',
    });
    if (!ok) return;
    const pool: AccountDto[] = [...(everyAccount.data ?? chart.data ?? [])];
    const made: Record<string, string> = {};
    setBulk({ done: 0, total: targets.length });
    try {
      for (const t of targets) {
        const g = guessAccount(t);
        const created = await createAccount.mutateAsync({ code: suggestCode(pool, g.type), name: newAccountName(t.source), type: g.type, role: (g.role || null) as never });
        pool.push(created);
        made[t.source] = created.id;
        setBulk({ done: Object.keys(made).length, total: targets.length });
      }
      toast.success(`Created ${targets.length} ${targets.length === 1 ? 'account' : 'accounts'}`);
    } catch (e) {
      onError(e, 'Could not create every account');
    } finally {
      if (Object.keys(made).length) onMap(made);
      setBulk(null);
    }
  };

  const rows = show === 'unmatched' && unresolvedRows.length > 0 ? unresolvedRows : accounts;

  return (
    <Card>
      <CardHeader
        title="Step 3 · Match accounts"
        description={
          unresolvedRows.length > 0
            ? `${accounts.length} accounts in the file; ${unresolvedRows.length} still need an Evenbooks account. Same-named accounts are matched for you.`
            : `All ${accounts.length} accounts in the file are matched.`
        }
        actions={
          unresolvedRows.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {codeMatches.length > 0 && (
                <Button variant="secondary" size="sm" onClick={matchByCode} disabled={Boolean(bulk)}>
                  Match {codeMatches.length} by code
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => void createAllUnmatched()} loading={Boolean(bulk)} disabled={chart.isPending}>
                {bulk ? `Creating ${bulk.done + 1} of ${bulk.total}…` : `Create all unmatched (${unresolvedRows.length})`}
              </Button>
            </div>
          ) : undefined
        }
      />
      {chart.isError && <ErrorNotice error={chart.error} onRetry={() => chart.refetch()} />}
      {accounts.length > 0 && (
        <CardBody className="border-b border-stone-200 py-3 text-xs text-stone-600">
          <p>
            Evenbooks keeps its own accounts for what customers owe you, customer deposits and sales tax, filled in only by invoices and payments made here, so
            the accounts in your file can&apos;t go there. Give your old app&apos;s Accounts Receivable its own account with <span className="font-medium">New</span>.
            You can rename either account later.
          </p>
        </CardBody>
      )}
      {accounts.length > 0 && unresolvedRows.length > 0 && unresolvedRows.length < accounts.length && (
        <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-2 text-sm">
          <label htmlFor={`${uid}-show`} className="text-stone-600">
            Show
          </label>
          <Select id={`${uid}-show`} value={show} onChange={(e) => setShow(e.target.value as 'all' | 'unmatched')} className="h-8 w-auto">
            <option value="all">All accounts ({accounts.length})</option>
            <option value="unmatched">Still to match ({unresolvedRows.length})</option>
          </Select>
        </div>
      )}
      {accounts.length === 0 ? (
        <CardBody>
          <EmptyState title="No accounts found" description="Check the account and amount columns." />
        </CardBody>
      ) : (
        <Table aria-label="Account matching">
          <THead>
            <TR>
              <TH>Account in the file</TH>
              <TH numeric className="hidden md:table-cell">
                Debits
              </TH>
              <TH numeric className="hidden md:table-cell">
                Credits
              </TH>
              <TH className="w-[24rem]">Evenbooks account</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((a) => {
              const pickerId = `${uid}-acct-${accounts.indexOf(a)}`;
              const value = effective(a);
              const unresolved = isUnresolved(a);
              const guess = guessAccount(a);
              return (
                <TR key={a.source} className={unresolved ? 'bg-amber-50/50' : undefined} data-testid="ledger-account-row">
                  <TD>
                    <label htmlFor={pickerId} className="font-medium text-stone-900">
                      {a.source}
                    </label>
                    <p className="text-xs text-stone-500">
                      {a.lineCount} {a.lineCount === 1 ? 'line' : 'lines'}
                    </p>
                  </TD>
                  <TD numeric className="hidden md:table-cell">
                    {formatMoney(a.debitTotal, company.baseCurrency)}
                  </TD>
                  <TD numeric className="hidden md:table-cell">
                    {formatMoney(a.creditTotal, company.baseCurrency)}
                  </TD>
                  <TD>
                    <div className="flex items-start gap-2">
                      <AccountPicker
                        id={pickerId}
                        className="min-w-0 flex-1"
                        value={value}
                        onChange={(id) => onMap({ [a.source]: id })}
                        allow={(o) => !isControl(o)}
                        prefer={(o) => o.type === guess.type}
                        preferLabel={`Likely (${capitalize(guess.type)})`}
                        createType={false}
                        placeholder="Choose an account…"
                        invalid={unresolved}
                        clearable
                        disabled={Boolean(bulk)}
                      />
                      <Button variant="ghost" size="sm" onClick={() => setCreating(a)} aria-label={`Create a new account for ${a.source}`} title="Create a new account" disabled={Boolean(bulk)}>
                        <Plus className="size-4" aria-hidden />
                        New
                      </Button>
                    </div>
                    {a.problem && !pending.has(a.source) && (
                      <p role="alert" className="mt-1 text-xs text-red-700">
                        {a.problem}
                      </p>
                    )}
                    {!value && !a.problem && /receivable/i.test(a.source) && (
                      <p className="mt-1 text-xs text-stone-500">Create a separate receivable account for this; the built-in one holds only Evenbooks invoices.</p>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {saving && <span className="sr-only">Saving account choices…</span>}
      <CreateAccountDialog
        source={creating}
        onClose={() => setCreating(null)}
        onCreated={(acct) => {
          if (creating) onMap({ [creating.source]: acct.id });
          setCreating(null);
        }}
      />
    </Card>
  );
}

/** Best guess of an account's type and role from its name and which side it mostly sits on. */
function guessAccount(a: LedgerImportAccountDto): { type: AccountType; role: string } {
  const n = a.source.toLowerCase();
  const debitHeavy = compareDecimals(a.debitTotal, a.creditTotal) >= 0;
  if (/credit card|visa|mastercard|amex|american express/.test(n)) return { type: 'liability', role: 'credit_card' };
  if (/checking|savings|bank|cash on hand|petty cash|paypal|stripe/.test(n)) return { type: 'asset', role: 'bank' };
  if (/draw|distribution/.test(n)) return { type: 'equity', role: 'owner_draws' };
  if (/equity|capital|contribution|retained|owner/.test(n)) return { type: 'equity', role: '' };
  if (/payable|loan|liabilit|accrued|deferred|unearned|tax collected|gst|hst|vat/.test(n)) return { type: 'liability', role: '' };
  if (/receivable|prepaid|inventory|equipment|furniture|vehicle|deposit|asset/.test(n)) return { type: 'asset', role: '' };
  if (/income|revenue|sales|fees earned|interest earned/.test(n)) return { type: 'income', role: '' };
  if (/expense|cost|fee|suppl|rent|utilit|insurance|travel|meal|advertis|software|subscription|payroll|wage|salar|repair|depreciation|office|phone|internet|postage|dues/.test(n)) {
    return { type: 'expense', role: '' };
  }
  return { type: debitHeavy ? 'expense' : 'income', role: '' };
}

function CreateAccountDialog({ source, onClose, onCreated }: { source: LedgerImportAccountDto | null; onClose: () => void; onCreated: (a: AccountDto) => void }) {
  const create = useCreateAccount();
  const onError = useMutationErrorHandler();
  const toast = useToast();
  const uid = React.useId();
  const chart = useAccounts({ includeArchived: true });
  const [form, setForm] = React.useState({ code: '', name: '', type: 'expense' as AccountType, role: '' });
  const [codeTouched, setCodeTouched] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    if (source) {
      const g = guessAccount(source);
      setForm({ code: '', name: newAccountName(source.source), type: g.type, role: g.role });
      setCodeTouched(false);
      setSubmitted(false);
    }
  }, [source]);

  // Suggest the next free code for the chosen type until the user types one.
  const all = chart.data;
  React.useEffect(() => {
    if (!source || codeTouched || !all) return;
    setForm((f) => ({ ...f, code: suggestCode(all, f.type) }));
  }, [source, codeTouched, all, form.type]);

  const codeError = !form.code.trim() ? 'Enter a code' : (all ?? []).some((a) => a.code === form.code.trim()) ? 'Another account already uses this code' : null;
  const nameError = !form.name.trim() ? 'Enter a name' : null;

  const roleOptions =
    form.type === 'asset'
      ? [{ v: 'bank', l: 'Bank account' }]
      : form.type === 'liability'
        ? [{ v: 'credit_card', l: 'Credit card' }]
        : form.type === 'equity'
          ? [
              { v: 'owner_equity', l: 'Owner equity' },
              { v: 'owner_draws', l: 'Owner draws' },
            ]
          : [];

  const submit = () => {
    setSubmitted(true);
    if (codeError || nameError) return;
    create.mutate(
      { code: form.code.trim(), name: form.name.trim(), type: form.type, role: (form.role || null) as never },
      {
        onSuccess: (a) => {
          toast.success('Account created', `${a.code} ${a.name}`);
          onCreated(a);
        },
        onError: (e) => onError(e, 'Could not create account'),
      },
    );
  };

  return (
    <Dialog
      open={Boolean(source)}
      onClose={onClose}
      title="New account"
      description={source ? `Created in your chart of accounts and matched to "${source.source}".` : undefined}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create and match
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" htmlFor={`${uid}-code`} required error={submitted ? codeError : null} hint={codeTouched ? undefined : 'Next free code, suggested.'}>
          <Input
            id={`${uid}-code`}
            value={form.code}
            onChange={(e) => {
              setCodeTouched(true);
              setForm({ ...form, code: e.target.value });
            }}
            inputMode="numeric"
            aria-invalid={submitted && codeError ? true : undefined}
          />
        </Field>
        <Field label="Type" htmlFor={`${uid}-type`} required>
          <Select id={`${uid}-type`} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AccountType, role: '' })}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {capitalize(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" htmlFor={`${uid}-name`} required className="sm:col-span-2" error={submitted ? nameError : null}>
          <Input id={`${uid}-name`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={submitted && nameError ? true : undefined} />
        </Field>
        {roleOptions.length > 0 && (
          <Field
            label="Role"
            htmlFor={`${uid}-role`}
            className="sm:col-span-2"
            hint="Give bank and credit-card accounts their role: cash-basis reports count imported transactions that move money through them."
          >
            <Select id={`${uid}-role`} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="">None</option>
              {roleOptions.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.l}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function Preview({ imp }: { imp: LedgerImportDto }) {
  const { company } = useCompany();
  const update = useUpdateLedgerImport();
  const onError = useMutationErrorHandler();
  const toast = useToast();
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [show, setShow] = React.useState<'all' | 'problems' | 'duplicates'>('all');
  const all = imp.entries ?? [];
  const problems = all.filter((e) => e.status === 'error');
  const duplicates = all.filter((e) => e.status === 'duplicate');
  const entries = show === 'problems' && problems.length ? problems : show === 'duplicates' && duplicates.length ? duplicates : all;
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <Card>
      <CardHeader
        title="Step 4 · Review transactions"
        description={imp.entriesTruncated ? 'Showing every transaction with a problem and the first ready ones.' : undefined}
        actions={
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Import counts">
            <div>
              <dt className="sr-only">Ready</dt>
              <dd>
                <span className="font-medium text-emerald-700" data-testid="count-ready">
                  {imp.readyCount}
                </span>{' '}
                ready
              </dd>
            </div>
            <div>
              <dt className="sr-only">Already imported</dt>
              <dd>
                <span className="font-medium text-amber-700" data-testid="count-duplicate">
                  {imp.duplicateCount}
                </span>{' '}
                already imported
              </dd>
            </div>
            <div>
              <dt className="sr-only">Problems</dt>
              <dd>
                <span className="font-medium text-red-700" data-testid="count-error">
                  {imp.errorCount}
                </span>{' '}
                with problems
              </dd>
            </div>
          </dl>
        }
      />
      {(problems.length > 0 || duplicates.length > 0) && (
        <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-2 text-sm">
          <label htmlFor="ledger-preview-show" className="text-stone-600">
            Show
          </label>
          <Select id="ledger-preview-show" value={show} onChange={(e) => setShow(e.target.value as typeof show)} className="h-8 w-auto">
            <option value="all">All transactions ({all.length})</option>
            {problems.length > 0 && <option value="problems">With problems ({problems.length})</option>}
            {duplicates.length > 0 && <option value="duplicates">Already imported ({duplicates.length})</option>}
          </Select>
        </div>
      )}
      {entries.length === 0 ? (
        <CardBody>
          <EmptyState title="No transactions found" description="Check the columns in step 2." />
        </CardBody>
      ) : (
        <div className="max-h-[32rem] overflow-y-auto">
          <Table aria-label="Transactions to import">
            <THead>
              <TR>
                <TH className="w-28">Status</TH>
                <TH className="w-28">Date</TH>
                <TH>Description</TH>
                <TH numeric>Amount</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((e) => {
                const total = sumDecimals(e.lines.map((l) => l.debit));
                const expanded = open.has(e.key);
                return (
                    <TR key={e.key} className={e.status === 'error' ? 'bg-red-50/40' : e.status === 'duplicate' ? 'opacity-70' : undefined}>
                      <TD>
                        <Badge tone={e.status === 'ok' ? 'green' : e.status === 'duplicate' ? 'amber' : 'red'}>{e.status === 'ok' ? 'Ready' : e.status === 'duplicate' ? 'Already imported' : 'Problem'}</Badge>
                      </TD>
                      <TD>{e.date ? formatDate(e.date) : <span className="text-stone-400">—</span>}</TD>
                      <TD>
                        <button type="button" className="text-left hover:underline" aria-expanded={expanded} onClick={() => toggle(e.key)}>
                          {e.description || <span className="text-stone-400">(no description)</span>}
                          {e.reference && <span className="text-stone-500"> · {e.reference}</span>}
                        </button>
                        <p className="text-xs text-stone-500">
                          {e.lines.length} {e.lines.length === 1 ? 'line' : 'lines'} · rows {e.rowNos[0]}
                          {e.rowNos.length > 1 ? `–${e.rowNos[e.rowNos.length - 1]}` : ''}
                        </p>
                        {e.error && (
                          <p className="text-xs text-red-700" role="alert">
                            {e.error}
                          </p>
                        )}
                        {e.cashKey && e.status !== 'duplicate' && (e.cashReviewRequired || e.cashComponents !== null) && (
                          <ImportCashEditor key={`${e.cashKey}-${JSON.stringify(e.cashComponents)}`} initial={e.cashComponents ?? []} pending={update.isPending}
                            onSave={components => update.mutate({ id: imp.id, input: { cashOverrides: { [e.cashKey!]: components } } }, {
                              onSuccess: () => toast.success('Cash-basis review saved'), onError: err => onError(err, 'Could not save cash-basis review'),
                            })} />
                        )}
                        {expanded && (
                          <ul className="mt-2 space-y-0.5 text-xs text-stone-600">
                            {e.lines.map((l) => (
                              <li key={l.rowNo} className="flex justify-between gap-4">
                                <span>
                                  {l.account}
                                  {l.memo ? ` · ${l.memo}` : ''}
                                </span>
                                <span className="font-mono">{compareDecimals(l.debit, '0') > 0 ? `Dr ${formatMoney(l.debit, company.baseCurrency)}` : `Cr ${formatMoney(l.credit, company.baseCurrency)}`}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TD>
                      <TD numeric>{formatMoney(total, company.baseCurrency)}</TD>
                    </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function Finished({ imp, onReset }: { imp: LedgerImportDto; onReset: () => void }) {
  return (
    <Card className="max-w-2xl">
      <CardHeader title={imp.status === 'committed' ? 'History imported' : 'Import discarded'} description={imp.fileName} />
      <CardBody className="space-y-3">
        {imp.status === 'committed' ? (
          <p className="text-sm text-stone-700">
            {imp.importedCount} {imp.importedCount === 1 ? 'transaction was' : 'transactions were'} added to your books
            {imp.windowStart && imp.windowEnd ? ` (${formatDate(imp.windowStart)} – ${formatDate(imp.windowEnd)})` : ''}. {imp.duplicateCount > 0 && `${imp.duplicateCount} already imported earlier were skipped. `}
            {imp.errorCount > 0 && `${imp.errorCount} with problems were skipped. `}
            If something looks wrong, imported entries can be reversed one by one from the journal.
          </p>
        ) : (
          <p className="text-sm text-stone-700">Nothing from this file was posted.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {imp.status === 'committed' && <LinkButton href="/journal?sourceType=import">View imported entries</LinkButton>}
          <LinkButton variant="secondary" href="/reports">
            Open reports
          </LinkButton>
          <Button variant="ghost" onClick={onReset}>
            Import another file
          </Button>
        </div>
        {imp.status === 'committed' && (
          <p className="text-sm text-stone-600" data-testid="import-check">
            Last step: check that your bank balance{imp.windowEnd ? ` on ${formatDate(imp.windowEnd)}` : ''} on the{' '}
            <Link href={`/reports/balance-sheet${imp.windowEnd ? `?asOf=${imp.windowEnd}` : ''}`} className="text-brand-700 hover:underline">
              balance sheet
            </Link>
            {' '}matches the one in Wave (or your old app). If it does, everything came across.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
