import { describe, expect, it } from 'vitest';
import {
  Money,
  allocateSettlement,
  allocatePaymentAcrossDocuments,
  OverAllocationError,
  type RecognitionComponent,
} from '../src/index';

const usd = (v: string) => Money.of(v, 'USD');

const components: RecognitionComponent[] = [
  { key: 'income', kind: 'income', accountId: 'inc', amount: usd('1000') },
  { key: 'tax', kind: 'tax', accountId: 'tax', amount: usd('100') },
];

describe('allocateSettlement', () => {
  it('plan fixture: $550 on $1,000 + $100 tax recognizes $500 revenue and $50 tax', () => {
    const a = allocateSettlement(components, usd('0'), usd('550'));
    expect(a.map((x) => [x.key, x.amount.toString()])).toEqual([
      ['income', '500.00'],
      ['tax', '50.00'],
    ]);
  });

  it('cumulative partial payments sum exactly to the totals', () => {
    const payments = ['0.01', '333.33', '333.33', '433.33'].map(usd);
    let before = usd('0');
    const totals = { income: usd('0'), tax: usd('0') };
    for (const p of payments) {
      const a = allocateSettlement(components, before, p);
      expect(Money.sum(a.map((x) => x.amount)).equals(p)).toBe(true);
      for (const x of a) totals[x.key as 'income' | 'tax'] = totals[x.key as 'income' | 'tax'].add(x.amount);
      before = before.add(p);
    }
    expect(totals.income.toString()).toBe('1000.00');
    expect(totals.tax.toString()).toBe('100.00');
  });

  it('rejects over-allocation', () => {
    expect(() => allocateSettlement(components, usd('1000'), usd('100.01'))).toThrow(OverAllocationError);
  });

  it('handles negative (reversal) applications symmetrically', () => {
    const fwd = allocateSettlement(components, usd('0'), usd('550'));
    const back = allocateSettlement(components, usd('550'), usd('-550'));
    expect(back.map((x) => x.amount.toString())).toEqual(fwd.map((x) => x.amount.negate().toString()));
  });

  it('allocates a zero-total document with zero application', () => {
    expect(allocateSettlement([], usd('0'), usd('0'))).toEqual([]);
  });
});

describe('allocatePaymentAcrossDocuments', () => {
  it('applies oldest first and returns unapplied remainder', () => {
    const r = allocatePaymentAcrossDocuments(usd('250'), [
      { id: 'a', open: usd('100') },
      { id: 'b', open: usd('100') },
      { id: 'c', open: usd('0') },
    ]);
    expect(r.applied.map((x) => [x.id, x.amount.toString()])).toEqual([
      ['a', '100.00'],
      ['b', '100.00'],
    ]);
    expect(r.unapplied.toString()).toBe('50.00');
  });
});
