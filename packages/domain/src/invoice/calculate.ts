import { Money, D, parsePrecise, type Dec } from '../money/money';

export type Discount = { type: 'percent'; value: string } | { type: 'fixed'; value: string };

export interface TaxRateDef {
  id: string;
  name: string;
  /** Decimal fraction, e.g. "0.0825" for 8.25%. */
  rate: string;
}

export interface InvoiceLineInput {
  /** Caller-supplied stable key so results can be joined back (line id or index). */
  key: string;
  quantity: string;
  unitPrice: string;
  discount?: Discount | null;
  taxRateIds: readonly string[];
}

export interface InvoiceCalcInput {
  currency: string;
  lines: readonly InvoiceLineInput[];
  documentDiscount?: Discount | null;
  taxRates: readonly TaxRateDef[];
}

export interface LineTax {
  taxRateId: string;
  amount: Money;
}

export interface InvoiceLineCalc {
  key: string;
  /** quantity × unit price, rounded to currency. */
  gross: Money;
  lineDiscount: Money;
  /** Gross minus line discount. */
  afterLineDiscount: Money;
  documentDiscountShare: Money;
  /** Taxable base and the revenue recognized for the line. */
  net: Money;
  taxes: LineTax[];
  taxTotal: Money;
  /** net + taxes */
  total: Money;
}

export interface TaxSummary {
  taxRateId: string;
  name: string;
  rate: string;
  taxable: Money;
  amount: Money;
}

export interface InvoiceCalc {
  currency: string;
  lines: InvoiceLineCalc[];
  subtotal: Money;
  lineDiscountTotal: Money;
  documentDiscountTotal: Money;
  discountTotal: Money;
  netTotal: Money;
  taxes: TaxSummary[];
  taxTotal: Money;
  total: Money;
}

export class InvoiceCalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceCalcError';
  }
}

function pct(value: string): Dec {
  const p = new D(value);
  if (p.isNegative() || p.gt(100)) throw new InvoiceCalcError(`Percent discount out of range: ${value}`);
  return p.div(100);
}

function applyDiscount(base: Money, discount: Discount | null | undefined, currency: string): Money {
  if (!discount) return Money.zero(currency);
  if (discount.type === 'percent') return base.multiply(pct(discount.value));
  const fixed = Money.round(discount.value, currency);
  if (fixed.isNegative()) throw new InvoiceCalcError('Fixed discount cannot be negative');
  return fixed.min(base);
}

/**
 * Invoice arithmetic policy (see docs/financial-policy.md):
 *  1. line gross  = round(quantity × unit price)
 *  2. line discount (percent of gross, or fixed capped at gross)
 *  3. document discount (percent of Σ after-line-discount, or fixed capped) is
 *     allocated across lines proportionally by largest remainder
 *  4. line net (taxable base) = after-line-discount − document discount share
 *  5. tax per line per rate = round(net × rate); summarized by rate
 *  6. total = Σ net + Σ tax
 * Discounts are applied before tax. Rounding happens per line.
 */
export function calculateInvoice(input: InvoiceCalcInput): InvoiceCalc {
  const { currency } = input;
  const rateById = new Map(input.taxRates.map((t) => [t.id, t]));
  const zero = Money.zero(currency);

  const stage1 = input.lines.map((line) => {
    const qty = parsePrecise(line.quantity);
    const price = parsePrecise(line.unitPrice);
    if (qty.isNegative()) throw new InvoiceCalcError(`Line ${line.key}: quantity cannot be negative`);
    const gross = Money.round(qty.times(price), currency);
    const lineDiscount = applyDiscount(gross, line.discount, currency);
    const afterLineDiscount = gross.subtract(lineDiscount);
    for (const id of line.taxRateIds) {
      if (!rateById.has(id)) throw new InvoiceCalcError(`Line ${line.key}: unknown tax rate ${id}`);
    }
    return { line, gross, lineDiscount, afterLineDiscount };
  });

  const afterLineTotal = Money.sum(
    stage1.map((s) => s.afterLineDiscount),
    currency,
  );
  const documentDiscountTotal = applyDiscount(afterLineTotal, input.documentDiscount, currency);
  const shares = documentDiscountTotal.isZero()
    ? stage1.map(() => zero)
    : documentDiscountTotal.allocate(stage1.map((s) => s.afterLineDiscount.decimal.abs()));

  const taxAgg = new Map<string, { taxable: Money; amount: Money }>();
  const lines: InvoiceLineCalc[] = stage1.map((s, i) => {
    const share = shares[i]!;
    const net = s.afterLineDiscount.subtract(share);
    const taxes: LineTax[] = [...new Set(s.line.taxRateIds)].map((taxRateId) => {
      const rate = rateById.get(taxRateId)!;
      const amount = net.multiply(rate.rate);
      const agg = taxAgg.get(taxRateId) ?? { taxable: zero, amount: zero };
      taxAgg.set(taxRateId, { taxable: agg.taxable.add(net), amount: agg.amount.add(amount) });
      return { taxRateId, amount };
    });
    const taxTotal = Money.sum(
      taxes.map((t) => t.amount),
      currency,
    );
    return {
      key: s.line.key,
      gross: s.gross,
      lineDiscount: s.lineDiscount,
      afterLineDiscount: s.afterLineDiscount,
      documentDiscountShare: share,
      net,
      taxes,
      taxTotal,
      total: net.add(taxTotal),
    };
  });

  const subtotal = Money.sum(
    lines.map((l) => l.gross),
    currency,
  );
  const lineDiscountTotal = Money.sum(
    lines.map((l) => l.lineDiscount),
    currency,
  );
  const netTotal = Money.sum(
    lines.map((l) => l.net),
    currency,
  );
  const taxes: TaxSummary[] = input.taxRates
    .filter((t) => taxAgg.has(t.id))
    .map((t) => ({ taxRateId: t.id, name: t.name, rate: t.rate, ...taxAgg.get(t.id)! }));
  const taxTotal = Money.sum(
    taxes.map((t) => t.amount),
    currency,
  );
  return {
    currency,
    lines,
    subtotal,
    lineDiscountTotal,
    documentDiscountTotal,
    discountTotal: lineDiscountTotal.add(documentDiscountTotal),
    netTotal,
    taxes,
    taxTotal,
    total: netTotal.add(taxTotal),
  };
}
