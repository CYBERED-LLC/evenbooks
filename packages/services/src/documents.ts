import { and, eq, inArray } from 'drizzle-orm';
import { schema, type CustomerSnapshot, type LineTaxJson, type TaxSummaryJson } from '@evenbooks/db';
import { Money, calculateInvoice, parsePrecise, type InvoiceCalc } from '@evenbooks/domain';
import type { DocumentLineDto, DocumentLineInput, AllocationDto } from '@evenbooks/contracts';
import { ServiceError } from './errors';
import type { ServiceContext } from './context';
import { getContact } from './contacts';

/**
 * Shared helpers for invoices and credit notes: line validation, arithmetic via
 * the domain calculator, tax snapshots, and DTO mapping.
 */

export interface ComputedDocument {
  calc: InvoiceCalc;
  lines: {
    input: DocumentLineInput;
    taxes: LineTaxJson[];
    gross: Money;
    lineDiscount: Money;
    documentDiscountShare: Money;
    net: Money;
    taxTotal: Money;
    total: Money;
  }[];
  taxSummary: TaxSummaryJson[];
}

export async function computeDocument(
  s: ServiceContext,
  lines: readonly DocumentLineInput[],
  documentDiscount: { type: 'percent' | 'fixed'; value: string } | null | undefined,
): Promise<ComputedDocument> {
  const cur = s.company.baseCurrency;
  const accountIds = [...new Set(lines.map((l) => l.incomeAccountId))];
  const accounts = await s.tx
    .select({ id: schema.accounts.id, type: schema.accounts.type, isActive: schema.accounts.isActive, name: schema.accounts.name })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), inArray(schema.accounts.id, accountIds)));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of accountIds) {
    const a = byId.get(id);
    if (!a) throw new ServiceError('validation', 'Unknown income account');
    if (a.type !== 'income') throw new ServiceError('validation', `${a.name} is not an income account`);
    if (!a.isActive) throw new ServiceError('validation', `${a.name} is archived`);
  }
  const rateIds = [...new Set(lines.flatMap((l) => l.taxRateIds))];
  const rates = rateIds.length
    ? await s.tx
        .select()
        .from(schema.taxRates)
        .where(and(eq(schema.taxRates.companyId, s.ctx.companyId), inArray(schema.taxRates.id, rateIds)))
    : [];
  if (rates.length !== rateIds.length) throw new ServiceError('validation', 'Unknown tax rate');
  for (const l of lines) {
    parsePrecise(l.quantity);
    parsePrecise(l.unitPrice);
  }
  const calc = calculateInvoice({
    currency: cur,
    lines: lines.map((l, i) => ({ key: String(i), quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount ?? null, taxRateIds: l.taxRateIds })),
    documentDiscount: documentDiscount ?? null,
    taxRates: rates.map((r) => ({ id: r.id, name: r.name, rate: r.rate })),
  });
  const rateById = new Map(rates.map((r) => [r.id, r]));
  return {
    calc,
    lines: calc.lines.map((cl, i) => ({
      input: lines[i]!,
      taxes: cl.taxes.map((t) => ({ taxRateId: t.taxRateId, name: rateById.get(t.taxRateId)!.name, rate: rateById.get(t.taxRateId)!.rate, amount: t.amount.toString() })),
      gross: cl.gross,
      lineDiscount: cl.lineDiscount,
      documentDiscountShare: cl.documentDiscountShare,
      net: cl.net,
      taxTotal: cl.taxTotal,
      total: cl.total,
    })),
    taxSummary: calc.taxes.map((t) => ({
      taxRateId: t.taxRateId,
      name: t.name,
      rate: t.rate,
      taxable: t.taxable.toString(),
      amount: t.amount.toString(),
      liabilityAccountId: rateById.get(t.taxRateId)!.liabilityAccountId,
    })),
  };
}

export function lineRows(s: ServiceContext, computed: ComputedDocument) {
  return computed.lines.map((l, i) => ({
    companyId: s.ctx.companyId,
    lineNo: i + 1,
    itemId: l.input.itemId ?? null,
    description: l.input.description,
    quantity: parsePrecise(l.input.quantity).toString(),
    unitPrice: parsePrecise(l.input.unitPrice).toString(),
    discount: l.input.discount ?? null,
    incomeAccountId: l.input.incomeAccountId,
    taxRateIds: l.input.taxRateIds,
    taxes: l.taxes,
    gross: l.gross.toString(),
    lineDiscount: l.lineDiscount.toString(),
    documentDiscountShare: l.documentDiscountShare.toString(),
    net: l.net.toString(),
    taxTotal: l.taxTotal.toString(),
    total: l.total.toString(),
  }));
}

export function totalsRow(computed: ComputedDocument) {
  const c = computed.calc;
  return {
    subtotal: c.subtotal.toString(),
    discountTotal: c.discountTotal.toString(),
    netTotal: c.netTotal.toString(),
    taxTotal: c.taxTotal.toString(),
    total: c.total.toString(),
    taxSummary: computed.taxSummary,
  };
}

export async function snapshotCustomer(s: ServiceContext, contactId: string): Promise<CustomerSnapshot> {
  const c = await getContact(s, contactId);
  if (!c.isCustomer) throw new ServiceError('validation', `${c.name} is not a customer`);
  if (c.isArchived) throw new ServiceError('validation', `${c.name} is archived`);
  return { name: c.name, email: c.email, phone: c.phone, address: c.billingAddress };
}

type LineRow = typeof schema.invoiceLines.$inferSelect | typeof schema.creditNoteLines.$inferSelect;

export function toLineDto(l: LineRow, cur: string, accountName?: string): DocumentLineDto {
  return {
    id: l.id,
    lineNo: l.lineNo,
    itemId: l.itemId,
    description: l.description,
    quantity: parsePrecise(l.quantity).toString(),
    unitPrice: parsePrecise(l.unitPrice).toString(),
    discount: l.discount ?? null,
    incomeAccountId: l.incomeAccountId,
    incomeAccountName: accountName,
    taxRateIds: l.taxRateIds,
    taxes: l.taxes,
    gross: Money.round(l.gross, cur).toString(),
    lineDiscount: Money.round(l.lineDiscount, cur).toString(),
    documentDiscountShare: Money.round(l.documentDiscountShare, cur).toString(),
    net: Money.round(l.net, cur).toString(),
    taxTotal: Money.round(l.taxTotal, cur).toString(),
    total: Money.round(l.total, cur).toString(),
  };
}

export function toAllocationDto(a: typeof schema.paymentAllocations.$inferSelect, cur: string, extra: { invoiceNumber?: string | null; sourceLabel?: string } = {}): AllocationDto {
  return {
    id: a.id,
    sourceType: a.sourceType,
    paymentId: a.paymentId,
    creditNoteId: a.creditNoteId,
    invoiceId: a.invoiceId,
    invoiceNumber: extra.invoiceNumber ?? undefined,
    amount: Money.round(a.amount, cur).toString(),
    date: a.date,
    status: a.status,
    journalEntryId: a.journalEntryId,
    reversalJournalEntryId: a.reversalJournalEntryId,
    sourceLabel: extra.sourceLabel,
  };
}

export async function accountNames(s: ServiceContext, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await s.tx.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(inArray(schema.accounts.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Stateless calculation for form previews (no persistence). */
export async function previewDocument(
  s: ServiceContext,
  input: { lines: DocumentLineInput[]; documentDiscount?: { type: 'percent' | 'fixed'; value: string } | null },
): Promise<{ lines: Omit<DocumentLineDto, 'id' | 'lineNo' | 'itemId' | 'incomeAccountName'>[]; subtotal: string; discountTotal: string; netTotal: string; taxTotal: string; total: string; taxSummary: TaxSummaryJson[] }> {
  const computed = await computeDocument(s, input.lines, input.documentDiscount ?? null);
  return {
    lines: computed.lines.map((l) => ({
      description: l.input.description,
      quantity: l.input.quantity,
      unitPrice: l.input.unitPrice,
      discount: l.input.discount ?? null,
      incomeAccountId: l.input.incomeAccountId,
      taxRateIds: l.input.taxRateIds,
      taxes: l.taxes,
      gross: l.gross.toString(),
      lineDiscount: l.lineDiscount.toString(),
      documentDiscountShare: l.documentDiscountShare.toString(),
      net: l.net.toString(),
      taxTotal: l.taxTotal.toString(),
      total: l.total.toString(),
    })),
    ...totalsRow(computed),
  };
}
