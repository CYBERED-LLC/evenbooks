import { describe, expect, it } from 'vitest';
import { calculateInvoice, Money } from '../src/index';

const tax = [{ id: 'tx', name: 'State', rate: '0.10' }];

describe('calculateInvoice', () => {
  it('computes gross, tax and total for a simple line', () => {
    const c = calculateInvoice({
      currency: 'USD',
      taxRates: tax,
      lines: [{ key: '1', quantity: '10', unitPrice: '100', taxRateIds: ['tx'] }],
    });
    expect(c.subtotal.toString()).toBe('1000.00');
    expect(c.taxTotal.toString()).toBe('100.00');
    expect(c.total.toString()).toBe('1100.00');
    expect(c.taxes[0]!.taxable.toString()).toBe('1000.00');
  });

  it('rounds each line then sums; keeps 6-decimal quantities', () => {
    const c = calculateInvoice({
      currency: 'USD',
      taxRates: [{ id: 'tx', name: 'T', rate: '0.0825' }],
      lines: [
        { key: '1', quantity: '1.5', unitPrice: '19.99', taxRateIds: ['tx'] }, // 29.985 -> 29.99
        { key: '2', quantity: '3', unitPrice: '0.333333', taxRateIds: ['tx'] }, // 0.999999 -> 1.00
      ],
    });
    expect(c.lines[0]!.gross.toString()).toBe('29.99');
    expect(c.lines[1]!.gross.toString()).toBe('1.00');
    // 29.99*0.0825 = 2.474175 -> 2.47 ; 1.00*0.0825 = 0.0825 -> 0.08
    expect(c.lines[0]!.taxTotal.toString()).toBe('2.47');
    expect(c.lines[1]!.taxTotal.toString()).toBe('0.08');
    expect(c.taxTotal.toString()).toBe('2.55');
    expect(c.total.toString()).toBe('33.54');
  });

  it('applies percent and fixed line discounts before tax', () => {
    const c = calculateInvoice({
      currency: 'USD',
      taxRates: tax,
      lines: [
        { key: 'a', quantity: '1', unitPrice: '200', discount: { type: 'percent', value: '25' }, taxRateIds: ['tx'] },
        { key: 'b', quantity: '1', unitPrice: '50', discount: { type: 'fixed', value: '80' }, taxRateIds: [] },
      ],
    });
    expect(c.lines[0]!.lineDiscount.toString()).toBe('50.00');
    expect(c.lines[0]!.net.toString()).toBe('150.00');
    expect(c.lines[0]!.taxTotal.toString()).toBe('15.00');
    expect(c.lines[1]!.lineDiscount.toString()).toBe('50.00'); // capped at gross
    expect(c.lines[1]!.net.toString()).toBe('0.00');
    expect(c.total.toString()).toBe('165.00');
  });

  it('allocates a document discount across lines with exact sum', () => {
    const c = calculateInvoice({
      currency: 'USD',
      taxRates: tax,
      documentDiscount: { type: 'fixed', value: '10' },
      lines: [
        { key: 'a', quantity: '1', unitPrice: '33.33', taxRateIds: ['tx'] },
        { key: 'b', quantity: '1', unitPrice: '33.33', taxRateIds: ['tx'] },
        { key: 'c', quantity: '1', unitPrice: '33.34', taxRateIds: [] },
      ],
    });
    const shares = c.lines.map((l) => l.documentDiscountShare);
    expect(Money.sum(shares).toString()).toBe('10.00');
    expect(c.documentDiscountTotal.toString()).toBe('10.00');
    expect(c.netTotal.toString()).toBe('90.00');
    expect(c.discountTotal.toString()).toBe('10.00');
    // taxable = line a + b nets
    const taxable = c.lines[0]!.net.add(c.lines[1]!.net);
    expect(c.taxes[0]!.taxable.equals(taxable)).toBe(true);
  });

  it('percent document discount', () => {
    const c = calculateInvoice({
      currency: 'USD',
      taxRates: [],
      documentDiscount: { type: 'percent', value: '10' },
      lines: [
        { key: 'a', quantity: '2', unitPrice: '25', taxRateIds: [] },
        { key: 'b', quantity: '1', unitPrice: '50', taxRateIds: [] },
      ],
    });
    expect(c.documentDiscountTotal.toString()).toBe('10.00');
    expect(c.total.toString()).toBe('90.00');
  });

  it('rejects unknown tax rates and out-of-range percents', () => {
    expect(() =>
      calculateInvoice({ currency: 'USD', taxRates: [], lines: [{ key: '1', quantity: '1', unitPrice: '1', taxRateIds: ['nope'] }] }),
    ).toThrow(/unknown tax rate/);
    expect(() =>
      calculateInvoice({
        currency: 'USD',
        taxRates: [],
        lines: [{ key: '1', quantity: '1', unitPrice: '1', discount: { type: 'percent', value: '101' }, taxRateIds: [] }],
      }),
    ).toThrow(/out of range/);
  });

  it('dedupes repeated tax rate ids on a line', () => {
    const c = calculateInvoice({
      currency: 'USD',
      taxRates: tax,
      lines: [{ key: '1', quantity: '1', unitPrice: '100', taxRateIds: ['tx', 'tx'] }],
    });
    expect(c.taxTotal.toString()).toBe('10.00');
  });
});
