import { Money, MoneyError } from '../money/money';

export interface EntryLineInput {
  accountId: string;
  /** Exactly one of debit/credit must be positive; the other must be absent or zero. */
  debit?: Money;
  credit?: Money;
  memo?: string | null;
  /** Optional dimension used by reporting drill-down. */
  contactId?: string | null;
}

export interface NormalizedLine {
  accountId: string;
  debit: Money;
  credit: Money;
  memo: string | null;
  contactId: string | null;
}

export class UnbalancedEntryError extends MoneyError {
  constructor(
    public readonly debits: string,
    public readonly credits: string,
  ) {
    super(`Entry is not balanced: debits ${debits} != credits ${credits}`);
    this.name = 'UnbalancedEntryError';
  }
}

export class InvalidEntryError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntryError';
  }
}

/**
 * Normalize and validate journal lines: >= 2 nonzero lines, one side each,
 * single currency, debits == credits. Returns lines ready for posting.
 */
export function normalizeEntryLines(lines: readonly EntryLineInput[], currency: string): NormalizedLine[] {
  if (lines.length < 2) throw new InvalidEntryError('An entry needs at least two lines');
  const zero = Money.zero(currency);
  const out: NormalizedLine[] = lines.map((l, i) => {
    const debit = l.debit ?? zero;
    const credit = l.credit ?? zero;
    if (debit.currency !== currency || credit.currency !== currency) {
      throw new InvalidEntryError(`Line ${i + 1}: currency must be ${currency}`);
    }
    if (debit.isNegative() || credit.isNegative()) {
      throw new InvalidEntryError(`Line ${i + 1}: negative amounts are not allowed; swap the side instead`);
    }
    if (debit.isZero() === credit.isZero()) {
      throw new InvalidEntryError(`Line ${i + 1}: exactly one of debit or credit must be nonzero`);
    }
    return { accountId: l.accountId, debit, credit, memo: l.memo ?? null, contactId: l.contactId ?? null };
  });
  const totalDebit = Money.sum(out.map((l) => l.debit), currency);
  const totalCredit = Money.sum(out.map((l) => l.credit), currency);
  if (!totalDebit.equals(totalCredit)) {
    throw new UnbalancedEntryError(totalDebit.toString(), totalCredit.toString());
  }
  return out;
}

/** Build the reversing lines for an entry (swap debit and credit). */
export function reverseLines(lines: readonly NormalizedLine[]): NormalizedLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

/** Signed balance impact of a line for a given account type's natural side. */
export function signedAmount(line: { debit: Money; credit: Money }, debitNormal: boolean): Money {
  return debitNormal ? line.debit.subtract(line.credit) : line.credit.subtract(line.debit);
}
