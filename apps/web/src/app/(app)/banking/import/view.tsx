'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CsvMapping, ImportBatchDto } from '@evenbooks/contracts';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select } from '@/components/ui/input';
import { BackLink } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useBankAccounts, useCommitBatch, useDiscardBatch, useImportBatch, useImportBatches, usePreviewCsv, useRemapBatch } from '@/lib/queries/banking';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { capitalize, formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { cn } from '@/lib/utils';

const NONE = '';

const ROW_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  ok: { label: 'Ready', tone: 'green' },
  duplicate: { label: 'Already imported', tone: 'amber' },
  error: { label: 'Problem', tone: 'red' },
};
const BATCH_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'neutral' }> = {
  committed: { label: 'Imported', tone: 'green' },
  previewed: { label: 'Not imported yet', tone: 'amber' },
  failed: { label: 'Failed', tone: 'red' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

function isMappingValid(m: CsvMapping): boolean {
  return Boolean(m.date && m.description && (m.amounts.amount || m.amounts.debit || m.amounts.credit));
}

export function CsvImportView() {
  const { company } = useCompany();
  const router = useRouter();
  const sp = useSearchParams();
  const bankAccountId = sp.get('bankAccountId') ?? '';
  const batchParam = sp.get('batch');
  const bankAccounts = useBankAccounts();
  const bankAccount = bankAccounts.data?.find((b) => b.id === bankAccountId);

  const setBankAccount = (id: string) => {
    const next = new URLSearchParams(sp.toString());
    if (id) next.set('bankAccountId', id);
    else next.delete('bankAccountId');
    next.delete('batch');
    router.replace(`/banking/import?${next.toString()}`);
  };

  return (
    <>
      <BackLink listPath="/banking" label="Bank accounts" />
      <PageHeader title="Import bank CSV" description="Upload a CSV file downloaded from your bank, check how its columns are read, then import. Lines you already imported are skipped." />
      <Card className="mb-4">
        <CardBody>
          <Field label="Bank account" htmlFor="import-bank" required className="max-w-md">
            <Select id="import-bank" value={bankAccountId} onChange={(e) => setBankAccount(e.target.value)} disabled={bankAccounts.isPending}>
              <option value="">Select bank account…</option>
              {(bankAccounts.data ?? [])
                .filter((b) => b.isActive)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
          {bankAccounts.isError && <ErrorNotice error={bankAccounts.error} onRetry={() => bankAccounts.refetch()} />}
        </CardBody>
      </Card>
      {bankAccountId && bankAccount && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <ImportWizard key={bankAccountId} bankAccountId={bankAccountId} batchParam={batchParam} currency={company.baseCurrency} cardAccount={bankAccount.kind === 'credit_card'} />
          </div>
          <RecentImports bankAccountId={bankAccountId} openBatchId={batchParam} />
        </div>
      )}
      {bankAccountId && bankAccounts.data && !bankAccount && <EmptyState title="Bank account not found" description="Pick a bank account above to continue." />}
    </>
  );
}

type SampleRows = { raw: Record<string, string> }[] | undefined;

/**
 * Parse the first `limit` data rows of a CSV in the browser. The server only
 * returns rows once a usable mapping exists, but the mapping hints need sample
 * values before that.
 */
function peekCsv(content: string, limit = 8): { raw: Record<string, string> }[] {
  const text = content.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length && records.length <= limit; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((f) => f.trim())) records.push(row);
  }
  const [head, ...data] = records;
  if (!head) return [];
  const headers = head.map((h) => h.trim());
  return data.slice(0, limit).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))).map((raw) => ({ raw }));
}

/** The first few distinct, non-empty values of a column, for the mapping hints. */
function sampleValues(rows: SampleRows, column: string | null | undefined, n = 3): string[] {
  if (!rows || !column) return [];
  const out: string[] = [];
  for (const r of rows) {
    const v = (r.raw[column] ?? '').trim();
    if (!v || out.includes(v)) continue;
    out.push(v.length > 28 ? `${v.slice(0, 27)}…` : v);
    if (out.length >= n) break;
  }
  return out;
}

function sameMapping(a: CsvMapping | null | undefined, b: CsvMapping | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (m: CsvMapping) =>
    [m.date, m.description, m.memo ?? '', m.reference ?? '', m.amounts.amount ?? '', m.amounts.debit ?? '', m.amounts.credit ?? '', m.amounts.invert ? '1' : '', m.dateOrder].join('\u0000');
  return norm(a) === norm(b);
}

/** A column choice with the first values of that column shown beneath it (and beside each option). */
function ColumnSelect({
  id,
  label,
  value,
  onChange,
  headers,
  rows,
  required,
  hint,
  noneLabel,
}: {
  id: string;
  label: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  headers: string[];
  rows: SampleRows;
  required?: boolean;
  hint?: string;
  noneLabel: string;
}) {
  const samples = sampleValues(rows, value);
  const hintId = `${id}-samples`;
  return (
    <Field label={label} htmlFor={id} required={required} hint={hint}>
      <Select id={id} value={value ?? NONE} onChange={(e) => onChange(e.target.value || null)} aria-describedby={samples.length ? hintId : undefined}>
        <option value="">{noneLabel}</option>
        {headers.map((h) => {
          const first = sampleValues(rows, h, 1)[0];
          return (
            <option key={h} value={h}>
              {first ? `${h} (e.g. ${first})` : h}
            </option>
          );
        })}
      </Select>
      {samples.length > 0 && (
        <p id={hintId} className="truncate text-xs text-stone-500" data-testid={`${id}-samples`} title={samples.join(' · ')}>
          <span className="sr-only">Sample values: </span>
          {samples.join(' · ')}
        </p>
      )}
    </Field>
  );
}

function ImportWizard({ bankAccountId, batchParam, currency, cardAccount }: { bankAccountId: string; batchParam: string | null; currency: string; cardAccount: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const preview = usePreviewCsv();
  const remap = useRemapBatch();
  const commit = useCommitBatch();
  const discard = useDiscardBatch();
  const recent = useImportBatches(bankAccountId);
  const resume = useImportBatch(batchParam);
  const [batch, setBatch] = React.useState<ImportBatchDto | null>(null);
  const [mapping, setMapping] = React.useState<CsvMapping | null>(null);
  const [amountMode, setAmountMode] = React.useState<'single' | 'split'>('single');
  const [readError, setReadError] = React.useState<string | null>(null);
  const [reused, setReused] = React.useState(false);
  const [show, setShow] = React.useState<'all' | 'problems'>('all');
  const [dragging, setDragging] = React.useState(false);
  const [peeked, setPeeked] = React.useState<{ raw: Record<string, string> }[]>([]);
  const idemRef = React.useRef(idempotencyKey());
  const fileRef = React.useRef<HTMLInputElement>(null);

  /** Keep `?batch=` pointing at the open preview so a reload (or the Continue link) picks it up again. */
  const syncUrl = React.useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(sp.toString());
      if (id) next.set('batch', id);
      else next.delete('batch');
      if (next.toString() !== sp.toString()) router.replace(`/banking/import?${next.toString()}`, { scroll: false });
    },
    [router, sp],
  );

  const adopt = React.useCallback(
    (b: ImportBatchDto) => {
      setBatch(b);
      const m = b.mapping ?? emptyMapping(b.headers ?? []);
      setMapping(m);
      setAmountMode(m.amounts.amount ? 'single' : m.amounts.debit || m.amounts.credit ? 'split' : 'single');
      syncUrl(b.id);
    },
    [syncUrl],
  );

  // Resume a previewed batch named in the URL (the "Continue" link in Recent imports).
  const resumed = resume.data;
  React.useEffect(() => {
    if (resumed && resumed.status === 'previewed' && resumed.bankAccountId === bankAccountId && resumed.id !== batch?.id) {
      adopt(resumed);
      setReused(false);
      setShow('all');
      idemRef.current = idempotencyKey();
    }
    // Only react to a newly loaded batch, not to our own state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumed]);

  const lastCommittedMapping = (recent.data ?? []).find((b) => b.status === 'committed' && b.source === 'csv' && b.mapping)?.mapping ?? null;

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    if (!/\.(csv|txt)$/i.test(file.name) && file.type && !/csv|text\/plain|excel/i.test(file.type)) {
      setReadError(`${file.name} doesn't look like a CSV file.`);
      return;
    }
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
    setPeeked(peekCsv(content));
    preview.mutate(
      { bankAccountId, fileName: file.name, content },
      {
        onSuccess: (b) => {
          adopt(b);
          setReused(sameMapping(b.mapping, lastCommittedMapping));
          setShow('all');
        },
        onError: (e) => onError(e, 'Could not preview CSV'),
      },
    );
    if (fileRef.current) fileRef.current.value = '';
  };

  // Each remap replaces the batch, so remaps must run one after another against
  // the newest batch; changes made meanwhile are coalesced into the next one.
  const remapQueue = React.useRef<CsvMapping | null>(null);
  const remapping = React.useRef(false);
  const runRemap = async (batchId: string, first: CsvMapping) => {
    remapping.current = true;
    let id = batchId;
    let next: CsvMapping | null = first;
    let latest: ImportBatchDto | null = null;
    try {
      while (next) {
        remapQueue.current = null;
        latest = await remap.mutateAsync({ id, mapping: next });
        id = latest.id;
        next = remapQueue.current;
        if (next) {
          setBatch(latest);
          syncUrl(latest.id);
        }
      }
      if (latest) adopt(latest);
    } catch (e) {
      remapQueue.current = null;
      if (latest) setBatch(latest);
      onError(e, 'Could not apply mapping');
    } finally {
      remapping.current = false;
    }
  };

  const applyMapping = (next: CsvMapping) => {
    setMapping(next);
    setReused(false);
    if (!batch || !isMappingValid(next)) return;
    if (remapping.current) remapQueue.current = next;
    else void runRemap(batch.id, next);
  };

  const reset = () => {
    setBatch(null);
    setPeeked([]);
    setMapping(null);
    setReadError(null);
    setReused(false);
    setShow('all');
    idemRef.current = idempotencyKey();
    syncUrl(null);
  };

  const headers = batch?.headers ?? [];
  // Server rows carry the raw values once a mapping parses; before that use the browser's peek.
  const sampleRows: SampleRows = batch?.rows && batch.rows.length > 0 ? batch.rows : peeked;
  const busy = preview.isPending || remap.isPending;

  if (!batch || !mapping) {
    const stale = batchParam && resume.data && resume.data.status !== 'previewed';
    return (
      <Card>
        <CardHeader title="Step 1 · Choose a CSV file" description="Most bank exports work as-is. The first row must contain column headers." />
        <CardBody className="space-y-3">
          {batchParam && resume.isPending && <Spinner label="Loading the saved preview…" />}
          {stale && (
            <p role="status" className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
              That file was {resume.data!.status === 'committed' ? 'already imported' : 'set aside'}. Choose the file again to start over.
            </p>
          )}
          {batchParam && resume.isError && <ErrorNotice error={resume.error} onRetry={() => resume.refetch()} />}
          <div
            data-testid="csv-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (!dragging) setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!preview.isPending) void readFile(e.dataTransfer.files[0]);
            }}
            className={cn(
              'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
              dragging ? 'border-brand-500 bg-brand-50' : 'border-stone-300 bg-stone-50',
            )}
          >
            <Upload className="size-6 text-stone-400" aria-hidden />
            <p className="text-sm text-stone-700">
              <span className="font-medium">Drop a CSV file here</span>, or choose one:
            </p>
            <Field label="CSV file" htmlFor="csv-file" required className="w-full max-w-sm text-left">
              <Input
                id="csv-file"
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void readFile(e.target.files?.[0])}
                disabled={preview.isPending}
                className="h-auto bg-white py-1.5"
              />
            </Field>
          </div>
          {preview.isPending && <Spinner label="Parsing and previewing…" />}
          {readError && (
            <p role="alert" className="text-sm text-red-700">
              {readError}
            </p>
          )}
        </CardBody>
      </Card>
    );
  }

  const willImport = batch.rows ? batch.rows.filter((r) => r.status === 'ok').length : Math.max(0, batch.rowCount - batch.duplicateCount - batch.errorCount);
  const canImport = !batch.alreadyCommitted && willImport > 0 && !busy && isMappingValid(mapping);
  const problems = (batch.rows ?? []).filter((r) => r.status !== 'ok');
  const shownRows = show === 'problems' && problems.length > 0 ? problems : (batch.rows ?? []);

  return (
    <div className="space-y-4" aria-busy={busy}>
      <Card>
        <CardHeader
          title="Step 2 · Confirm column mapping"
          description={
            <>
              {batch.fileName} · {batch.rowCount} rows
              {batch.windowStart && batch.windowEnd && (
                <>
                  {' '}
                  · {formatDate(batch.windowStart)} – {formatDate(batch.windowEnd)}
                </>
              )}
            </>
          }
          actions={remap.isPending ? <Spinner label="Re-parsing…" /> : undefined}
        />
        <CardBody>
          {reused && (
            <p className="mb-3 text-sm text-stone-600" data-testid="mapping-reused">
              Using the column mapping from your last import into this account.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <ColumnSelect id="map-date" label="Date column" required noneLabel="Select…" headers={headers} rows={sampleRows} value={mapping.date} onChange={(v) => applyMapping({ ...mapping, date: v ?? '' })} />
            <ColumnSelect
              id="map-desc"
              label="Description column"
              required
              noneLabel="Select…"
              headers={headers}
              rows={sampleRows}
              value={mapping.description}
              onChange={(v) => applyMapping({ ...mapping, description: v ?? '' })}
            />
            <Field label="Date order" htmlFor="map-order" required>
              <Select id="map-order" value={mapping.dateOrder} onChange={(e) => applyMapping({ ...mapping, dateOrder: e.target.value as CsvMapping['dateOrder'] })}>
                <option value="MDY">Month / day / year</option>
                <option value="DMY">Day / month / year</option>
                <option value="YMD">Year / month / day</option>
              </Select>
            </Field>
            <ColumnSelect id="map-memo" label="Memo column" noneLabel="None" headers={headers} rows={sampleRows} value={mapping.memo} onChange={(v) => applyMapping({ ...mapping, memo: v })} />
            <ColumnSelect id="map-ref" label="Reference column" noneLabel="None" headers={headers} rows={sampleRows} value={mapping.reference} onChange={(v) => applyMapping({ ...mapping, reference: v })} />
            <Field label="Amount format" htmlFor="map-mode" required>
              <Select
                id="map-mode"
                value={amountMode}
                onChange={(e) => {
                  const mode = e.target.value as 'single' | 'split';
                  setAmountMode(mode);
                  // Switching formats clears the other side; remap fires once a column is chosen.
                  setMapping({ ...mapping, amounts: mode === 'single' ? { amount: null, invert: mapping.amounts.invert } : { debit: null, credit: null } });
                }}
              >
                <option value="single">One amount column (money out is negative)</option>
                <option value="split">Separate money-out and money-in columns</option>
              </Select>
            </Field>
            {amountMode === 'single' ? (
              <>
                <ColumnSelect
                  id="map-amount"
                  label="Amount column"
                  required
                  noneLabel="Select…"
                  headers={headers}
                  rows={sampleRows}
                  value={mapping.amounts.amount}
                  onChange={(v) => applyMapping({ ...mapping, amounts: { amount: v, invert: mapping.amounts.invert } })}
                />
                <div className="flex flex-col justify-end gap-1 pb-1">
                  <Checkbox
                    label="Invert sign (positive numbers are money out)"
                    checked={Boolean(mapping.amounts.invert)}
                    onChange={(e) => applyMapping({ ...mapping, amounts: { ...mapping.amounts, invert: e.target.checked } })}
                  />
                  {cardAccount && (
                    <p className="text-xs text-stone-500" data-testid="invert-card-hint">
                      For a card statement, charges should come out as money out. Tick this if they show in green below.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <ColumnSelect
                  id="map-debit"
                  label="Money out column"
                  hint="Payments and charges"
                  noneLabel="None"
                  headers={headers}
                  rows={sampleRows}
                  value={mapping.amounts.debit}
                  onChange={(v) => applyMapping({ ...mapping, amounts: { debit: v, credit: mapping.amounts.credit ?? null } })}
                />
                <ColumnSelect
                  id="map-credit"
                  label="Money in column"
                  hint="Deposits and refunds"
                  noneLabel="None"
                  headers={headers}
                  rows={sampleRows}
                  value={mapping.amounts.credit}
                  onChange={(v) => applyMapping({ ...mapping, amounts: { debit: mapping.amounts.debit ?? null, credit: v } })}
                />
              </>
            )}
          </div>
          {!isMappingValid(mapping) && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              Choose a date column, a description column, and an amount column (or money-out and money-in columns) to preview the lines.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Preview"
          actions={
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Import counts">
              <div>
                <dt className="sr-only">Rows</dt>
                <dd>
                  <span className="font-medium">{batch.rowCount}</span> rows
                </dd>
              </div>
              <div>
                <dt className="sr-only">Will import</dt>
                <dd>
                  <span className="font-medium text-emerald-700" data-testid="count-import">
                    {willImport}
                  </span>{' '}
                  will import
                </dd>
              </div>
              <div>
                <dt className="sr-only">Already imported</dt>
                <dd>
                  <span className="font-medium text-amber-700" data-testid="count-duplicate">
                    {batch.duplicateCount}
                  </span>{' '}
                  already imported
                </dd>
              </div>
              <div>
                <dt className="sr-only">Problems</dt>
                <dd>
                  <span className="font-medium text-red-700" data-testid="count-error">
                    {batch.errorCount}
                  </span>{' '}
                  {batch.errorCount === 1 ? 'problem' : 'problems'}
                </dd>
              </div>
            </dl>
          }
        />
        {batch.alreadyCommitted && (
          <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            This file has already been imported into this bank account. Importing it again is disabled.
          </div>
        )}
        {(!batch.rows || batch.rows.length === 0) && (
          <CardBody>
            <EmptyState title="No rows parsed" description="Check the column mapping above." />
          </CardBody>
        )}
        {batch.rows && batch.rows.length > 0 && problems.length > 0 && (
          <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-2 text-sm">
            <label htmlFor="preview-show" className="text-stone-600">
              Show
            </label>
            <Select id="preview-show" value={show} onChange={(e) => setShow(e.target.value as 'all' | 'problems')} className="h-8 w-auto">
              <option value="all">All rows ({batch.rows.length})</option>
              <option value="problems">Problems and already imported ({problems.length})</option>
            </Select>
          </div>
        )}
        {batch.rows && batch.rows.length > 0 && (
          <div className="max-h-[28rem] overflow-y-auto">
            <Table aria-label="Preview rows">
              <THead>
                <TR>
                  <TH className="w-12">#</TH>
                  <TH className="w-36">Status</TH>
                  <TH className="w-28">Date</TH>
                  <TH>Description</TH>
                  <TH numeric>Amount</TH>
                </TR>
              </THead>
              <TBody>
                {shownRows.map((r) => (
                  <TR key={r.rowNo} className={r.status === 'error' ? 'bg-red-50/40' : r.status === 'duplicate' ? 'opacity-70' : undefined}>
                    <TD className="font-mono text-xs text-stone-500">{r.rowNo}</TD>
                    <TD>
                      <Badge tone={ROW_STATUS[r.status]?.tone ?? 'red'}>{ROW_STATUS[r.status]?.label ?? capitalize(r.status)}</Badge>
                    </TD>
                    <TD>{r.date ? formatDate(r.date) : <span className="text-stone-400">—</span>}</TD>
                    <TD>
                      {/* Error rows have no normalized values; show what the file says instead. */}
                      <span>{r.description ?? (r.raw[mapping.description] || <span className="text-stone-400">—</span>)}</span>
                      {r.memo && <p className="text-xs text-stone-500">{r.memo}</p>}
                      {r.error && (
                        <p className="text-xs text-red-700" role="alert">
                          {r.error}
                        </p>
                      )}
                    </TD>
                    <TD numeric className={r.amount && r.amount.startsWith('-') ? 'text-stone-800' : 'text-emerald-700'}>
                      {r.amount ? formatMoney(r.amount, currency) : ''}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 px-4 py-3">
          <Button variant="ghost" onClick={reset} disabled={busy || commit.isPending}>
            Choose a different file
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              loading={discard.isPending}
              disabled={commit.isPending}
              onClick={() =>
                discard.mutate(batch.id, {
                  onSuccess: () => {
                    toast.success('Import discarded');
                    reset();
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
                  { id: batch.id, idempotencyKey: idemRef.current },
                  {
                    onSuccess: (b) => {
                      toast.success(`Imported ${b.importedCount} transactions`);
                      router.push(`/banking/inbox?bankAccountId=${bankAccountId}`);
                    },
                    onError: (e) => onError(e, 'Import failed'),
                  },
                )
              }
            >
              Import {willImport} {willImport === 1 ? 'transaction' : 'transactions'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function emptyMapping(headers: string[]): CsvMapping {
  return { date: headers[0] ?? '', description: headers[1] ?? '', memo: null, reference: null, amounts: { amount: null }, dateOrder: 'MDY' };
}

function RecentImports({ bankAccountId, openBatchId }: { bankAccountId: string; openBatchId: string | null }) {
  const q = useImportBatches(bankAccountId);
  // Remapping discards the superseded preview, so discarded batches are noise here.
  const batches = (q.data ?? []).filter((b) => b.status !== 'discarded');
  return (
    <Card>
      <CardHeader title="Recent imports" />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && batches.length === 0 && (
        <CardBody>
          <EmptyState title="Nothing imported yet" />
        </CardBody>
      )}
      {batches.length > 0 && (
        <ul className="divide-y divide-stone-100 text-sm" aria-label="Recent imports">
          {batches.slice(0, 10).map((b) => (
            <li key={b.id} className="px-4 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{b.fileName ?? capitalize(b.source)}</span>
                <Badge tone={BATCH_STATUS[b.status]?.tone ?? 'neutral'}>{BATCH_STATUS[b.status]?.label ?? capitalize(b.status)}</Badge>
              </div>
              <p className="text-xs text-stone-500">
                {b.status === 'previewed'
                  ? `${formatDateTime(b.createdAt)} · ${b.rowCount} lines · ${b.duplicateCount} already imported · ${b.errorCount} with problems`
                  : `${formatDateTime(b.committedAt ?? b.createdAt)} · ${b.importedCount} imported · ${b.duplicateCount} already imported · ${b.errorCount} with problems`}
              </p>
              {b.status === 'committed' && (
                <Link href={`/banking/inbox?bankAccountId=${bankAccountId}`} className="text-xs text-brand-700 hover:underline">
                  Review transactions
                </Link>
              )}
              {b.status === 'previewed' &&
                (b.id === openBatchId ? (
                  <span className="text-xs text-stone-500">Open now</span>
                ) : (
                  <Link
                    href={`/banking/import?bankAccountId=${bankAccountId}&batch=${b.id}`}
                    replace
                    scroll={false}
                    className="text-xs text-brand-700 hover:underline"
                    aria-label={`Continue importing ${b.fileName ?? 'this file'}`}
                  >
                    Continue
                  </Link>
                ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
