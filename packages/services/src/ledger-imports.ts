import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import type { ObjectStorage } from '@evenbooks/integrations';
import { D, Money, PROTECTED_CONTROL_ROLES, groupLedgerRows, ledgerEntryFingerprint, unfoldSectionedLedger, type LedgerCsvEntry, type LedgerCsvMapping as DomainMapping } from '@evenbooks/domain';
import type {
  CreateLedgerImportInput,
  LedgerCsvMapping,
  LedgerImportAccountDto,
  LedgerImportDto,
  LedgerImportEntryDto,
  UpdateLedgerImportInput,
} from '@evenbooks/contracts';
import { ServiceError, notFound, plainDate } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { uploadAttachment } from './attachments';
import { parseCsv } from './imports';
import { postEntry } from './ledger';
import { validateImportedCashComponents } from './import-cash';

type ImportRow = typeof schema.ledgerImports.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

/** Entries shown per preview: every problem (up to the cap) plus the first ready ones. */
const PREVIEW_PROBLEMS = 200;
const PREVIEW_READY = 200;

/** Roles whose accounts hold money; an imported entry touching one is a cash event. */
const CASH_ROLES = new Set(['bank', 'credit_card', 'undeposited_funds']);

/** Prefix for journal_entries.idempotency_key on imported entries (unique per company). */
const KEY_PREFIX = 'ledger-import:';

// Ordered candidates: the first header matching the earliest pattern wins.
const HINTS = {
  date: [/^(transaction |txn |journal |entry |posting |posted )?date$/i, /^date posted$/i],
  account: [/^account( name)?$/i, /^(gl|ledger|split) account$/i, /^account title$/i, /^(full )?account name$/i],
  group: [/^(transaction|txn|journal|entry|je) ?(id|no\.?|number|#)$/i, /^transaction$/i],
  description: [/^transaction description$/i, /^description$/i, /^(name|payee|memo\/description|narration)$/i],
  memo: [/^(transaction )?line description$/i, /^line memo$/i, /^memo$/i, /^notes?( \/ memo)?$/i],
  reference: [/^(reference|ref\.?)( ?(no\.?|number|#))?$/i, /^(num|number|check ?(no|number|#)|invoice number|bill number|doc(ument)? ?(no|number|#))$/i],
  debit: [/^debit( amount)?\b/i, /^dr$/i],
  credit: [/^credit( amount)?\b/i, /^cr$/i],
  amount: [/^amount$/i, /^(net )?amount\b/i],
} satisfies Record<string, RegExp[]>;

function findHeader(headers: string[], patterns: RegExp[], exclude: (string | null | undefined)[] = []): string | null {
  for (const re of patterns) {
    const h = headers.find((x) => re.test(x.trim()) && !exclude.includes(x));
    if (h) return h;
  }
  return null;
}

/**
 * Parse the file. Reports laid out in per-account sections (Wave's General
 * Ledger report) are flattened into one table with an added `Account` column.
 */
function readLedgerRecords(content: string): { headers: string[]; records: Record<string, string>[] } {
  const parsed = parseCsv(content);
  return unfoldSectionedLedger(parsed.headers, parsed.records) ?? parsed;
}

/**
 * Best-effort mapping from headers; debit/credit columns are preferred over a
 * signed amount. Without a transaction id column, both groupings are tried
 * and the one producing fewer problem entries wins.
 */
export function detectLedgerMapping(headers: string[], records: readonly Record<string, string>[] = []): LedgerCsvMapping | null {
  const date = findHeader(headers, HINTS.date);
  const account = findHeader(headers, HINTS.account);
  const debit = findHeader(headers, HINTS.debit);
  const credit = findHeader(headers, HINTS.credit);
  const amount = findHeader(headers, HINTS.amount);
  if (!date || !account || (!amount && !debit && !credit)) return null;
  const description = findHeader(headers, HINTS.description);
  const mapping: LedgerCsvMapping = {
    date,
    account,
    description,
    memo: findHeader(headers, HINTS.memo, [description]),
    reference: findHeader(headers, HINTS.reference),
    group: findHeader(headers, HINTS.group),
    grouping: 'sequence',
    amounts: debit || credit ? { debit, credit } : { amount, invert: false },
    dateOrder: guessDateOrder(records.map((r) => r[date] ?? '')),
  };
  if (!mapping.group && records.length) {
    const errors = (grouping: DomainMapping['grouping']) => groupLedgerRows(records, { ...mapping, grouping } as DomainMapping).filter((e) => e.error).length;
    if (errors('date-description') < errors('sequence')) mapping.grouping = 'date-description';
  }
  return mapping;
}

/**
 * Wave's two exports: Settings → Data export → "Export accounting transactions" (one row per
 * line, with a transaction id and "(Two Column Approach)" debit/credit columns), and the
 * "Account Transactions (General Ledger)" report (flattened above; "(In Business Currency)" columns).
 */
export function recognizeLedgerFormat(headers: readonly string[]): LedgerImportDto['recognizedFormat'] {
  if (headers.includes('Transaction ID') && headers.some((h) => /\((two column approach|one column)\)/i.test(h))) return 'wave_transactions';
  if (headers[0] === 'Account' && headers.some((h) => /\(in business currency\)/i.test(h))) return 'wave_ledger';
  return null;
}

/** Day-first if any slash date has a first part above 12; ISO dates parse under any order. */
function guessDateOrder(values: string[]): LedgerCsvMapping['dateOrder'] {
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(v.trim());
    if (m && Number(m[1]) > 12) return 'DMY';
  }
  return 'MDY';
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Match a source account to the chart by code, name, or "code name". */
function autoMatch(source: string, accounts: AccountRow[]): string | null {
  const n = normalizeName(source);
  const active = accounts.filter((a) => a.isActive);
  const hit =
    active.find((a) => a.code.toLowerCase() === source.trim().toLowerCase()) ??
    active.find((a) => normalizeName(a.name) === n) ??
    active.find((a) => normalizeName(`${a.code} ${a.name}`) === n);
  return hit?.id ?? null;
}

function accountProblem(a: AccountRow | undefined, s: ServiceContext): string | null {
  if (!a) return 'This account no longer exists. Pick another.';
  if (!a.isActive) return `${a.code} ${a.name} is archived. Pick another account, or unarchive it in the chart of accounts.`;
  if (a.currency !== s.company.baseCurrency) return `${a.code} ${a.name} is not in ${s.company.baseCurrency}`;
  if (a.role && PROTECTED_CONTROL_ROLES.has(a.role)) {
    return `${a.name} only holds invoices, payments and credit notes made in Evenbooks. Use a separate account for what customers owed in your old app, such as “Accounts Receivable (previous system)”.`;
  }
  return null;
}

interface Analysis {
  headers: string[];
  rowCount: number;
  entries: (LedgerCsvEntry & { status: LedgerImportEntryDto['status']; fingerprint: string | null; cashReviewRequired: boolean; cashComponents: schema.ImportCashComponent[] | null })[];
  accounts: LedgerImportAccountDto[];
  /** Effective map: saved choices, then automatic matches for accounts not yet chosen. */
  accountMap: Record<string, string | null>;
  byId: Map<string, AccountRow>;
}

/**
 * Parse the file with the import's mapping and classify every entry. Nothing
 * is persisted here; the file is the source of truth, so a changed mapping or
 * a period closed since the preview is always reflected.
 */
async function analyze(s: ServiceContext, content: string, mapping: LedgerCsvMapping | null, savedMap: Record<string, string | null>, cashOverrides: ImportRow['cashOverrides'] = {}): Promise<Analysis> {
  const { headers, records } = readLedgerRecords(content);
  const chart = await s.tx.select().from(schema.accounts).where(eq(schema.accounts.companyId, s.ctx.companyId));
  const byId = new Map(chart.map((a) => [a.id, a]));
  if (!mapping) return { headers, rowCount: records.length, entries: [], accounts: [], accountMap: savedMap, byId };

  const grouped = groupLedgerRows(records, mapping as DomainMapping);
  const cur = s.company.baseCurrency;

  // Source accounts and the effective map (saved choices, then automatic matches).
  const stats = new Map<string, { lines: number; debit: InstanceType<typeof D>; credit: InstanceType<typeof D> }>();
  for (const e of grouped) {
    for (const l of e.lines) {
      const st = stats.get(l.account) ?? { lines: 0, debit: new D(0), credit: new D(0) };
      st.lines++;
      st.debit = st.debit.plus(l.debit);
      st.credit = st.credit.plus(l.credit);
      stats.set(l.account, st);
    }
  }
  const accountMap: Record<string, string | null> = {};
  for (const name of stats.keys()) accountMap[name] = name in savedMap ? savedMap[name]! : autoMatch(name, chart);

  const periods = await s.tx
    .select({ start: schema.accountingPeriods.startDate, end: schema.accountingPeriods.endDate })
    .from(schema.accountingPeriods)
    .where(and(eq(schema.accountingPeriods.companyId, s.ctx.companyId), eq(schema.accountingPeriods.status, 'closed')));

  const seq = new Map<string, number>();
  const entries: Analysis['entries'] = grouped.map((e) => {
    let error = e.error;
    if (!error) {
      for (const l of e.lines) {
        try {
          Money.of(l.debit, cur);
          Money.of(l.credit, cur);
        } catch {
          error = `Row ${l.rowNo}: amount has more decimal places than ${cur} allows`;
          break;
        }
      }
    }
    if (!error && e.date && periods.some((p) => e.date! >= p.start && e.date! <= p.end)) {
      error = `${plainDate(e.date)} is in a locked period. Reopen it in Settings → Accounting periods, or use a later date.`;
    }
    if (error) return { ...e, error, status: 'error' as const, fingerprint: null, cashReviewRequired: false, cashComponents: null };
    const base = ledgerEntryFingerprint(e, 0);
    const k = seq.get(base) ?? 0;
    seq.set(base, k + 1);
    return { ...e, status: 'ok' as LedgerImportEntryDto['status'], fingerprint: k === 0 ? base : ledgerEntryFingerprint(e, k), cashReviewRequired: false, cashComponents: null as schema.ImportCashComponent[] | null };
  });

  const keys = entries.filter((e) => e.fingerprint).map((e) => KEY_PREFIX + e.fingerprint);
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 5000) {
    const rows = await s.tx
      .select({ key: schema.journalEntries.idempotencyKey })
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), inArray(schema.journalEntries.idempotencyKey, keys.slice(i, i + 5000))));
    for (const r of rows) existing.add(r.key!);
  }
  for (const e of entries) if (e.fingerprint && existing.has(KEY_PREFIX + e.fingerprint)) e.status = 'duplicate';

  for (const e of entries) {
    if (!e.fingerprint || e.status === 'duplicate') continue;
    const mapped = e.lines.map(l => byId.get(accountMap[l.account] ?? ''));
    if (mapped.some(a => !a || accountProblem(a, s))) continue;
    e.cashReviewRequired = mapped.some(a => a?.role && CASH_ROLES.has(a.role)) &&
      mapped.some(a => a && (a.type === 'asset' || a.type === 'liability') && (!a.role || !CASH_ROLES.has(a.role)));
    const override = cashOverrides[e.fingerprint];
    if (override !== undefined) {
      try { e.cashComponents = await validateImportedCashComponents(s, override); }
      catch (err) { e.error = (err as Error).message; e.status = 'error'; }
    } else if (e.cashReviewRequired) {
      e.error = 'Review cash-basis income and expenses for this settlement before importing';
      e.status = 'error';
    }
  }

  const accounts: LedgerImportAccountDto[] = [...stats.entries()]
    .map(([source, st]) => {
      const id = accountMap[source] ?? null;
      return {
        source,
        lineCount: st.lines,
        debitTotal: st.debit.toString(),
        creditTotal: st.credit.toString(),
        accountId: id,
        problem: id ? accountProblem(byId.get(id), s) : null,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source));
  return { headers, rowCount: records.length, entries, accounts, accountMap, byId };
}

async function readFile(s: ServiceContext, storage: ObjectStorage, row: ImportRow): Promise<string> {
  const [att] = row.fileAttachmentId ? await s.tx.select().from(schema.attachments).where(eq(schema.attachments.id, row.fileAttachmentId)) : [];
  const obj = att ? await storage.getObject(att.objectKey) : null;
  if (!obj) throw new ServiceError('internal', 'Import file is missing from storage');
  return new TextDecoder().decode(obj.body);
}

async function alreadyCommitted(s: ServiceContext, row: ImportRow): Promise<ImportRow | undefined> {
  const [prior] = await s.tx
    .select()
    .from(schema.ledgerImports)
    .where(and(eq(schema.ledgerImports.companyId, s.ctx.companyId), eq(schema.ledgerImports.fileSha256, row.fileSha256), eq(schema.ledgerImports.status, 'committed')))
    .limit(1);
  return prior && prior.id !== row.id ? prior : undefined;
}

/** Persist counts from an analysis and build the detailed DTO. */
async function saveAndDescribe(s: ServiceContext, row: ImportRow, a: Analysis): Promise<LedgerImportDto> {
  const ready = a.entries.filter((e) => e.status === 'ok');
  const dates = a.entries.filter((e) => e.date).map((e) => e.date!).sort();
  const [updated] = await s.tx
    .update(schema.ledgerImports)
    .set({
      rowCount: a.rowCount,
      entryCount: a.entries.length,
      readyCount: ready.length,
      duplicateCount: a.entries.filter((e) => e.status === 'duplicate').length,
      errorCount: a.entries.filter((e) => e.status === 'error').length,
      windowStart: dates[0] ?? null,
      windowEnd: dates[dates.length - 1] ?? null,
    })
    .where(eq(schema.ledgerImports.id, row.id))
    .returning();
  const problems = a.entries.filter((e) => e.status !== 'ok');
  const shown = [...problems.slice(0, PREVIEW_PROBLEMS), ...ready.slice(0, PREVIEW_READY)].sort((x, y) => x.rowNos[0]! - y.rowNos[0]!);
  return {
    ...toDto(updated!),
    headers: a.headers,
    recognizedFormat: recognizeLedgerFormat(a.headers),
    alreadyCommitted: Boolean(await alreadyCommitted(s, row)),
    accounts: a.accounts,
    entries: shown.map((e) => ({
      key: e.key,
      cashKey: e.fingerprint,
      cashReviewRequired: e.cashReviewRequired,
      cashComponents: e.cashComponents,
      rowNos: e.rowNos,
      date: e.date,
      description: e.description,
      reference: e.reference,
      status: e.status,
      error: e.error,
      lines: e.lines,
    })),
    entriesTruncated: shown.length < a.entries.length,
  };
}

/** Store the file, detect a mapping and return the first preview. */
export async function createLedgerImport(s: ServiceContext, storage: ObjectStorage, input: CreateLedgerImportInput): Promise<LedgerImportDto> {
  const { headers, records } = readLedgerRecords(input.content);
  const attachment = await uploadAttachment(s, storage, {
    kind: 'csv_import',
    fileName: input.fileName,
    contentType: 'text/csv',
    body: new TextEncoder().encode(input.content),
  });
  const [row] = await s.tx
    .insert(schema.ledgerImports)
    .values({
      companyId: s.ctx.companyId,
      fileAttachmentId: attachment.id,
      fileName: input.fileName,
      fileSha256: createHash('sha256').update(input.content).digest('hex'),
      mapping: detectLedgerMapping(headers, records),
      createdBy: s.ctx.actorId,
    })
    .returning();
  await s.tx.update(schema.attachments).set({ entityType: 'ledger_import', entityId: row!.id }).where(eq(schema.attachments.id, attachment.id));
  return saveAndDescribe(s, row!, await analyze(s, input.content, row!.mapping, {}));
}

export async function getLedgerImport(s: ServiceContext, storage: ObjectStorage, id: string): Promise<LedgerImportDto> {
  const row = await loadImport(s, id);
  if (row.status !== 'previewed') return toDto(row);
  return saveAndDescribe(s, row, await analyze(s, await readFile(s, storage, row), row.mapping, row.accountMap, row.cashOverrides));
}

/** Change the column mapping and/or account choices of a previewed import. */
export async function updateLedgerImport(s: ServiceContext, storage: ObjectStorage, id: string, input: UpdateLedgerImportInput): Promise<LedgerImportDto> {
  const row = await loadImport(s, id);
  if (row.status !== 'previewed') throw new ServiceError('invalid_state', `This import is ${row.status}`);
  if (input.accountMap) {
    const ids = Object.values(input.accountMap).filter((v): v is string => Boolean(v));
    if (ids.length) {
      const found = await s.tx
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.companyId, s.ctx.companyId), inArray(schema.accounts.id, [...new Set(ids)])));
      if (found.length !== new Set(ids).size) throw new ServiceError('validation', 'One of the chosen accounts no longer exists. Reload the page and pick again.');
    }
  }
  const [updated] = await s.tx
    .update(schema.ledgerImports)
    .set({ mapping: input.mapping ?? row.mapping, accountMap: { ...row.accountMap, ...(input.accountMap ?? {}) }, cashOverrides: input.mapping ? {} : { ...row.cashOverrides, ...(input.cashOverrides ?? {}) } })
    .where(eq(schema.ledgerImports.id, id))
    .returning();
  return saveAndDescribe(s, updated!, await analyze(s, await readFile(s, storage, updated!), updated!.mapping, updated!.accountMap, updated!.cashOverrides));
}

/**
 * Post every ready entry as a journal entry (source 'import'), in date order.
 * Every source account used by a ready entry must be mapped to a usable
 * account. Entries with errors and duplicates are skipped and counted.
 */
export async function commitLedgerImport(s: ServiceContext, storage: ObjectStorage, id: string, idempotencyKey?: string): Promise<LedgerImportDto> {
  return idempotent(s, idempotencyKey, { ledgerImportId: id }, async () => {
    const row = await loadImport(s, id);
    if (row.status === 'committed') return toDto(row);
    if (row.status !== 'previewed') throw new ServiceError('invalid_state', `This import is ${row.status}`);
    if (!row.mapping) throw new ServiceError('validation', 'Choose which columns hold the date, account and amount before importing.');
    const prior = await alreadyCommitted(s, row);
    if (prior) throw new ServiceError('duplicate', `This file was already imported${prior.committedAt ? ` on ${plainDate(prior.committedAt.slice(0, 10))}` : ''}.`, { priorImportId: prior.id });

    const a = await analyze(s, await readFile(s, storage, row), row.mapping, row.accountMap, row.cashOverrides);
    if (a.entries.some(e => e.cashReviewRequired && e.cashComponents === null)) throw new ServiceError('validation', 'Review cash-basis income and expenses for every settlement before importing');
    const ready = a.entries.filter((e) => e.status === 'ok');
    if (ready.length === 0) throw new ServiceError('validation', 'Nothing to import: no transaction is ready. Fix the problems shown, or choose another file.');
    const used = new Set(ready.flatMap((e) => e.lines.map((l) => l.account)));
    const blocking = a.accounts.filter((x) => used.has(x.source) && (!x.accountId || x.problem));
    if (blocking.length) {
      const names = blocking.slice(0, 5).map((x) => `"${x.source}"`).join(', ');
      throw new ServiceError('validation', `Map every account before importing (${blocking.length} left: ${names}${blocking.length > 5 ? ', …' : ''})`, {
        accounts: blocking.map((x) => x.source),
      });
    }

    const cur = s.company.baseCurrency;
    const ordered = [...ready].sort((x, y) => (x.date! < y.date! ? -1 : x.date! > y.date! ? 1 : x.rowNos[0]! - y.rowNos[0]!));
    for (const e of ordered) {
      const lines = e.lines.map((l) => {
        const accountId = a.accountMap[l.account]!;
        const debit = new D(l.debit);
        return {
          accountId,
          debit: debit.isZero() ? undefined : Money.of(l.debit, cur),
          credit: debit.isZero() ? Money.of(l.credit, cur) : undefined,
          memo: l.memo,
        };
      });
      const touchesCash = lines.some((l) => {
        const role = a.byId.get(l.accountId)?.role;
        return role ? CASH_ROLES.has(role) : false;
      });
      const memo = [e.description, e.reference ? `(${e.reference})` : ''].filter(Boolean).join(' ') || `Imported from ${row.fileName}`;
      await postEntry(s, {
        date: e.date!,
        memo: memo.slice(0, 500),
        sourceType: 'import',
        sourceId: row.id,
        cashTreatment: touchesCash ? 'include' : 'exclude',
        cashComponents: e.cashComponents,
        lines,
        idempotencyKey: KEY_PREFIX + e.fingerprint!,
      });
    }

    const dates = ordered.map((e) => e.date!);
    const [updated] = await s.tx
      .update(schema.ledgerImports)
      .set({
        status: 'committed',
        accountMap: a.accountMap,
        importedCount: ordered.length,
        readyCount: ordered.length,
        duplicateCount: a.entries.filter((e) => e.status === 'duplicate').length,
        errorCount: a.entries.filter((e) => e.status === 'error').length,
        entryCount: a.entries.length,
        windowStart: dates[0] ?? null,
        windowEnd: dates[dates.length - 1] ?? null,
        committedAt: new Date().toISOString(),
      })
      .where(eq(schema.ledgerImports.id, id))
      .returning();
    await recordAudit(s, {
      action: 'ledger_import.committed',
      entityType: 'ledger_import',
      entityId: id,
      details: { fileName: row.fileName, imported: ordered.length, duplicates: updated!.duplicateCount, errors: updated!.errorCount },
    });
    return toDto(updated!);
  });
}

export async function discardLedgerImport(s: ServiceContext, id: string): Promise<void> {
  const row = await loadImport(s, id);
  if (row.status !== 'previewed') throw new ServiceError('invalid_state', 'This file was already imported, so it can’t be discarded. Imported entries can be reversed one by one from the journal.');
  await s.tx.update(schema.ledgerImports).set({ status: 'discarded' }).where(eq(schema.ledgerImports.id, id));
}

export async function listLedgerImports(s: ServiceContext): Promise<LedgerImportDto[]> {
  const rows = await s.tx
    .select()
    .from(schema.ledgerImports)
    .where(eq(schema.ledgerImports.companyId, s.ctx.companyId))
    .orderBy(desc(schema.ledgerImports.createdAt))
    .limit(100);
  return rows.map(toDto);
}

async function loadImport(s: ServiceContext, id: string): Promise<ImportRow> {
  const [row] = await s.tx
    .select()
    .from(schema.ledgerImports)
    .where(and(eq(schema.ledgerImports.companyId, s.ctx.companyId), eq(schema.ledgerImports.id, id)))
    .limit(1).for('update');
  if (!row) throw notFound('Import');
  return row;
}

function toDto(r: ImportRow): LedgerImportDto {
  return {
    id: r.id,
    fileName: r.fileName,
    status: r.status,
    mapping: (r.mapping as LedgerCsvMapping | null) ?? null,
    rowCount: r.rowCount,
    entryCount: r.entryCount,
    readyCount: r.readyCount,
    importedCount: r.importedCount,
    duplicateCount: r.duplicateCount,
    errorCount: r.errorCount,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    createdAt: r.createdAt,
    committedAt: r.committedAt,
  };
}
