import { Money, MoneyError } from '../money/money';

/**
 * A recognition component of a document (invoice or credit note): a slice of
 * the document total that maps to one account when settled. Income lines and
 * tax amounts are separate components so cash-basis reports can recognize
 * revenue and tax proportionally to what was actually collected.
 */
export interface RecognitionComponent {
  key: string;
  kind: 'income' | 'tax' | 'other';
  accountId: string;
  amount: Money;
  lineId?: string | null;
  taxRateId?: string | null;
}

export interface ComponentAllocation {
  key: string;
  amount: Money;
}

export class OverAllocationError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = 'OverAllocationError';
  }
}

/**
 * Deterministically allocate an applied amount across components.
 *
 * To guarantee that allocations across several partial settlements add up to
 * exactly the component totals, we allocate the *cumulative* settled amount
 * and return the difference from the previous cumulative allocation.
 *
 * Example: $1,000 income + $100 tax; $550 applied → $500 income, $50 tax.
 */
export function allocateSettlement(
  components: readonly RecognitionComponent[],
  cumulativeBefore: Money,
  applied: Money,
): ComponentAllocation[] {
  if (components.length === 0) {
    if (!applied.isZero()) throw new OverAllocationError('Cannot allocate to a document without components');
    return [];
  }
  const currency = components[0]!.amount.currency;
  const total = Money.sum(
    components.map((c) => c.amount),
    currency,
  );
  if (components.some((c) => c.amount.isNegative())) {
    throw new MoneyError('Recognition components must be non-negative');
  }
  const after = cumulativeBefore.add(applied);
  if (after.isNegative()) throw new OverAllocationError('Cumulative settlement cannot be negative');
  if (after.gt(total)) {
    throw new OverAllocationError(
      `Settlement ${after.toString()} exceeds document total ${total.toString()}`,
    );
  }
  const weights = components.map((c) => c.amount.decimal);
  const before = cumulativeBefore.allocate(weights);
  const target = after.allocate(weights);
  return components.map((c, i) => ({ key: c.key, amount: target[i]!.subtract(before[i]!) }));
}

/**
 * Allocate a single payment amount across several open documents in order
 * (oldest first by caller ordering), never exceeding each document's open
 * balance. Returns per-document applied amounts and any unapplied remainder.
 */
export function allocatePaymentAcrossDocuments(
  amount: Money,
  documents: readonly { id: string; open: Money }[],
): { applied: { id: string; amount: Money }[]; unapplied: Money } {
  if (amount.isNegative()) throw new MoneyError('Payment amount cannot be negative');
  let remaining = amount;
  const applied: { id: string; amount: Money }[] = [];
  for (const doc of documents) {
    if (remaining.isZero()) break;
    if (doc.open.isNegative()) throw new MoneyError(`Document ${doc.id} has a negative open balance`);
    const take = remaining.min(doc.open);
    if (take.isPositive()) {
      applied.push({ id: doc.id, amount: take });
      remaining = remaining.subtract(take);
    }
  }
  return { applied, unapplied: remaining };
}
