export type ServiceErrorCode =
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'version_conflict'
  | 'forbidden'
  | 'period_locked'
  | 'unbalanced'
  | 'immutable'
  | 'over_allocation'
  | 'duplicate'
  | 'invalid_state'
  | 'external_error'
  | 'rate_limited'
  | 'internal';

const STATUS: Record<ServiceErrorCode, number> = {
  not_found: 404,
  validation: 400,
  conflict: 409,
  version_conflict: 409,
  forbidden: 403,
  period_locked: 409,
  unbalanced: 400,
  immutable: 409,
  over_allocation: 400,
  duplicate: 409,
  invalid_state: 409,
  external_error: 502,
  rate_limited: 429,
  internal: 500,
};

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }

  get status(): number {
    return STATUS[this.code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function notFound(what: string): ServiceError {
  return new ServiceError('not_found', `${what} not found`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-03-31` as `Mar 31, 2026`, for messages people read. Anything else passes through. */
export function plainDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** `120.5` in USD as `$120.50`, for messages people read. */
export function plainMoney(amount: { toString(): string } | string, currency = 'USD'): string {
  const n = Number(amount.toString());
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** A dated change that falls in a closed period, with where to reopen it. */
export function periodLocked(date: string, details?: Record<string, unknown>): ServiceError {
  return new ServiceError('period_locked', `${plainDate(date)} is in a locked period. Reopen it in Settings → Accounting periods, or use a later date.`, { date, ...details });
}

/** Plain wording for unique-constraint failures, by constraint name. */
function duplicateMessage(constraint: string | undefined): string {
  switch (constraint) {
    case 'accounts_company_id_code_key':
      return 'Another account already uses that code. Pick a different number.';
    case 'accounts_single_role_uq':
      return 'Only one account can have that role.';
    case 'invoices_number_uq':
      return 'That invoice number is already used. Pick a different number.';
    case 'credit_notes_number_uq':
      return 'That credit note number is already used. Pick a different number.';
    case 'import_batches_file_uq':
    case 'ledger_imports_file_uq':
      return 'This file was already imported.';
    case 'bank_accounts_company_id_ledger_account_id_key':
      return 'That account is already linked to another bank account.';
  }
  if (constraint?.endsWith('_company_id_name_key')) return 'That name is already used. Choose a different name.';
  return 'That already exists. Use a different name or number.';
}

export function versionConflict(what: string): ServiceError {
  return new ServiceError('version_conflict', `${what} was modified by someone else; reload and try again`);
}

/**
 * Translate PostgreSQL constraint/trigger failures into service errors so the
 * API can present them consistently. Database enforcement is the last line of
 * defense; services validate first, but a race can still surface here.
 */
export function unwrapDbError(err: unknown): { code?: string; message?: string; constraint?: string; detail?: string } | null {
  let cur = err as { code?: string; message?: string; constraint?: string; detail?: string; cause?: unknown } | undefined;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code)) return cur;
    cur = cur.cause as typeof cur;
  }
  return null;
}

export function translateDbError(err: unknown): ServiceError | null {
  const e = unwrapDbError(err);
  if (!e) return null;
  const msg = e.message ?? 'database error';
  switch (e.code) {
    case '23505':
      return new ServiceError('duplicate', duplicateMessage(e.constraint), {
        constraint: e.constraint,
        detail: e.detail,
      });
    case '23503':
      return new ServiceError('validation', 'Something this refers to no longer exists. Reload the page and try again.', {
        constraint: e.constraint,
      });
    case '23514': {
      const locked = /period containing (\d{4}-\d{2}-\d{2}) is closed/i.exec(msg);
      if (locked) return periodLocked(locked[1]!);
      if (/not balanced/i.test(msg)) return new ServiceError('unbalanced', 'The amounts don’t balance: money in and money out must add up to the same total.', { raw: msg });
      if (/currency precision/i.test(msg)) return new ServiceError('validation', 'Amounts can have at most two decimal places (cents).', { raw: msg });
      return new ServiceError('validation', 'That change isn’t allowed by your books’ rules. Nothing was saved.', { raw: msg, constraint: e.constraint });
    }
    case '23000':
      if (/immutable|append-only|cannot be deleted/i.test(msg)) return new ServiceError('immutable', 'Saved records can’t be changed directly. Void or reverse it instead.', { raw: msg });
      return new ServiceError('conflict', 'That change conflicts with something already saved. Reload the page and try again.', { raw: msg });
    case '23P01':
      return new ServiceError('conflict', 'That period overlaps one that already exists.');
    case '42501':
      return new ServiceError('forbidden', 'You don’t have permission to do that.');
    default:
      return null;
  }
}

export async function withDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    const translated = translateDbError(err);
    if (translated) throw translated;
    throw err;
  }
}
