'use client';
import * as React from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import type { AccountDto, Discount, DocumentLineInput, ItemDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import type { FormError } from '@/components/ui/error-summary';
import { AccountPicker } from '@/components/account-picker';
import { ItemPicker } from '@/components/item-picker';
import { TaxRatePicker } from '@/components/tax-rate-picker';
import { fractionToPercent } from '@/lib/queries/tax-rates';
import type { PreviewInput, PreviewResult } from '@/lib/queries/invoices';
import { formatMoney, isZeroDecimal } from '@/lib/format';
import { isValidDecimal } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useDefaultIncomeAccountId } from '@/lib/queries/items';

export interface DocumentLinesValue {
  lines: DocumentLineInput[];
  documentDiscount: Discount | null;
}

export interface DocumentLinesProps {
  value: DocumentLinesValue;
  onChange(next: DocumentLinesValue): void;
  /** Server-computed totals for the current (debounced) value; null until the first response. */
  preview: PreviewResult | null;
  /** True while a newer preview is in flight; dims the totals. */
  previewPending?: boolean;
  disabled?: boolean;
  /** Prefix for field ids, so two editors on one page do not collide. Ids are index-based (`dl-0-price`). */
  idPrefix?: string;
  /** Field ids with validation errors (from `invalidFields`). */
  invalid?: Set<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAX_RATES = 5;
const MAX_LINES = 200;
const isIncome = (a: AccountDto) => a.type === 'income';

/**
 * Lines with no category get the default one. Forms compare snapshots through this so a
 * default filled in after the accounts load doesn't count as an unsaved edit.
 */
export function withDefaultIncomeAccount(value: DocumentLinesValue, defaultId: string | null): DocumentLinesValue {
  if (!defaultId || value.lines.every((l) => l.incomeAccountId)) return value;
  return { ...value, lines: value.lines.map((l) => (l.incomeAccountId ? l : { ...l, incomeAccountId: defaultId })) };
}

export type DocumentLineField = 'item' | 'description' | 'quantity' | 'price' | 'account' | 'discount' | 'taxes';

/** DOM id of one field on one line. Index-based so server and client render the same ids. */
export function documentLineFieldId(index: number, part: DocumentLineField, prefix = 'dl'): string {
  return `${prefix}-${index}-${part}`;
}

export function blankDocumentLine(): DocumentLineInput {
  return { itemId: null, description: '', quantity: '1', unitPrice: '', discount: null, incomeAccountId: '', taxRateIds: [] };
}

function discountComplete(d: Discount | null | undefined): boolean {
  return !d || (isValidDecimal(d.value) && !d.value.trim().startsWith('-'));
}

/** A line the server can price: enough filled in to send to the preview endpoint. */
export function isPreviewableLine(l: DocumentLineInput): boolean {
  return (
    l.description.trim().length > 0 &&
    UUID_RE.test(l.incomeAccountId) &&
    isValidDecimal(l.unitPrice) &&
    isValidDecimal(l.quantity) &&
    !l.quantity.trim().startsWith('-') &&
    discountComplete(l.discount)
  );
}

export function normalizeDiscount(d: Discount | null | undefined): Discount | null {
  if (!d) return null;
  const value = d.value.trim();
  return value ? { type: d.type, value } : null;
}

export function normalizeLine(l: DocumentLineInput): DocumentLineInput {
  return {
    itemId: l.itemId ?? null,
    description: l.description.trim(),
    quantity: l.quantity.trim() || '1',
    unitPrice: l.unitPrice.trim(),
    discount: normalizeDiscount(l.discount),
    incomeAccountId: l.incomeAccountId,
    taxRateIds: l.taxRateIds,
  };
}

/** Preview input made only of lines the server can price; null when nothing is priceable yet. */
export function toPreviewInput(value: DocumentLinesValue): PreviewInput | null {
  const lines = value.lines.filter(isPreviewableLine).map(normalizeLine);
  if (lines.length === 0) return null;
  const dd = value.documentDiscount && discountComplete(value.documentDiscount) ? normalizeDiscount(value.documentDiscount) : null;
  return { lines, documentDiscount: dd };
}

/** Problems with the lines, each pointing at the field at fault, for the invoice, credit note and schedule forms. */
export function validateDocumentLines(value: DocumentLinesValue, idPrefix = 'dl'): FormError[] {
  const errs: FormError[] = [];
  const id = (i: number, part: DocumentLineField) => documentLineFieldId(i, part, idPrefix);
  if (value.lines.length === 0) errs.push({ message: 'At least one line is required.' });
  value.lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.description.trim()) errs.push({ message: `Line ${n}: description is required.`, fieldId: id(i, 'description') });
    const q = l.quantity.trim();
    if (!isValidDecimal(q) || q.startsWith('-')) errs.push({ message: `Line ${n}: quantity must be a non-negative number.`, fieldId: id(i, 'quantity') });
    if (!isValidDecimal(l.unitPrice.trim())) errs.push({ message: `Line ${n}: enter a unit price such as 250.00.`, fieldId: id(i, 'price') });
    if (!UUID_RE.test(l.incomeAccountId)) errs.push({ message: `Line ${n}: choose a category for this sale.`, fieldId: id(i, 'account') });
    if (l.discount && !discountComplete(l.discount)) errs.push({ message: `Line ${n}: discount value must be a non-negative number.`, fieldId: id(i, 'discount') });
  });
  if (value.documentDiscount && !discountComplete(value.documentDiscount)) errs.push({ message: 'Document discount value must be a non-negative number.', fieldId: `${idPrefix}-doc-discount` });
  return errs;
}

type DiscountKind = 'none' | 'percent' | 'fixed';

function DiscountEditor({
  discount,
  onChange,
  labelPrefix,
  disabled,
  valueId,
  invalid,
}: {
  discount: Discount | null | undefined;
  onChange(d: Discount | null): void;
  labelPrefix: string;
  disabled?: boolean;
  valueId?: string;
  invalid?: boolean;
}) {
  const kind: DiscountKind = discount?.type ?? 'none';
  return (
    <div className="flex gap-2">
      <Select
        aria-label={`${labelPrefix} discount type`}
        value={kind}
        disabled={disabled}
        className="min-w-0 flex-1"
        onChange={(e) => {
          const k = e.target.value as DiscountKind;
          onChange(k === 'none' ? null : { type: k, value: discount?.value ?? '' });
        }}
      >
        <option value="none">No discount</option>
        <option value="percent">Percent</option>
        <option value="fixed">Fixed</option>
      </Select>
      <MoneyInput
        id={valueId}
        aria-label={`${labelPrefix} discount value`}
        aria-invalid={invalid || undefined}
        placeholder={kind === 'percent' ? '%' : 'Amount'}
        className="w-24"
        minFraction={kind === 'percent' ? 0 : 2}
        value={discount?.value ?? ''}
        disabled={disabled || kind === 'none'}
        onChange={(v) => discount && onChange({ type: discount.type, value: v })}
      />
    </div>
  );
}

/**
 * Line editor shared by invoices, credit notes and recurring templates. Money
 * math never happens here: per-line nets and the totals panel come from the
 * server preview the parent form fetches for the current value.
 */
export function DocumentLines({ value, onChange, preview, previewPending, disabled, idPrefix = 'dl', invalid }: DocumentLinesProps) {
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const fid = (i: number, part: DocumentLineField) => documentLineFieldId(i, part, idPrefix);
  const bad = (i: number, part: DocumentLineField) => invalid?.has(fid(i, part)) || undefined;
  const defaultIncome = useDefaultIncomeAccountId();

  // Lines without a category (new lines, or a cleared picker) start in the company's main
  // income category, so a first invoice isn't blocked on an accounting choice.
  React.useEffect(() => {
    if (disabled) return;
    const next = withDefaultIncomeAccount(value, defaultIncome);
    if (next !== value) onChange(next);
  }, [defaultIncome, value, disabled, onChange]);

  const focusLater = (id: string) =>
    requestAnimationFrame(() => {
      document.getElementById(id)?.focus();
    });

  const setLines = (lines: DocumentLineInput[]) => onChange({ ...value, lines });
  const setLine = (i: number, patch: Partial<DocumentLineInput>) => setLines(value.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines(value.lines.filter((_, idx) => idx !== i));

  /** New lines start with the previous line's income account and tax rates: most documents use one of each. */
  const addLine = () => {
    if (value.lines.length >= MAX_LINES) return;
    const prev = value.lines[value.lines.length - 1];
    const line = { ...blankDocumentLine(), incomeAccountId: prev?.incomeAccountId || defaultIncome || '', taxRateIds: [...(prev?.taxRateIds ?? [])] };
    setLines([...value.lines, line]);
    focusLater(fid(value.lines.length, 'item'));
  };

  const duplicateLine = (i: number) => {
    if (value.lines.length >= MAX_LINES) return;
    const src = value.lines[i]!;
    const copy: DocumentLineInput = { ...src, discount: src.discount ? { ...src.discount } : null, taxRateIds: [...src.taxRateIds] };
    setLines([...value.lines.slice(0, i + 1), copy, ...value.lines.slice(i + 1)]);
    focusLater(fid(i + 1, 'description'));
  };

  const moveLine = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.lines.length) return;
    const next = [...value.lines];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setLines(next);
    // Keep focus on the same button of the moved line so repeated presses keep moving it.
    const label = dir < 0 ? `Move line ${j + 1} up` : `Move line ${j + 1} down`;
    requestAnimationFrame(() => {
      const btn = document.querySelector<HTMLButtonElement>(`[data-line-actions="${idPrefix}"] button[aria-label="${label}"]`);
      (btn && !btn.disabled ? btn : document.getElementById(fid(j, 'description')))?.focus();
    });
  };

  const pickItem = (i: number, item: ItemDto | null) => {
    if (!item) {
      setLine(i, { itemId: null });
      return;
    }
    setLine(i, {
      itemId: item.id,
      description: item.description ? `${item.name} — ${item.description}` : item.name,
      unitPrice: item.unitPrice,
      incomeAccountId: item.incomeAccountId || defaultIncome || '',
      taxRateIds: item.defaultTaxRateIds.slice(0, MAX_TAX_RATES),
    });
  };

  // The preview only contains priceable lines, in order. Map them back onto editor rows,
  // but only when the counts agree (a stale preview would otherwise land on the wrong row).
  const previewable = value.lines.map(isPreviewableLine);
  const previewMatches = !!preview && preview.lines.length === previewable.filter(Boolean).length;
  let cursor = 0;
  const previewFor = value.lines.map((_, i) => (previewable[i] ? (previewMatches ? preview!.lines[cursor++] ?? null : (cursor++, null)) : null));
  const last = value.lines.length - 1;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 hidden grid-cols-12 gap-2 px-3 text-xs font-semibold uppercase tracking-wide text-stone-500 md:grid">
          <div className="col-span-3">Item</div>
          <div className="col-span-5">Description</div>
          <div className="col-span-2 text-right">Qty</div>
          <div className="col-span-2 text-right">Unit price</div>
        </div>
        <ul className="space-y-2" aria-label="Document lines">
          {value.lines.map((l, i) => {
            const n = i + 1;
            const p = previewFor[i];
            return (
              <li key={i} className="rounded-md border border-stone-200 bg-stone-50/40 p-3">
                <div className="grid grid-cols-12 items-center gap-2">
                  <div className="col-span-12 md:col-span-3">
                    <ItemPicker
                      id={fid(i, 'item')}
                      aria-label={`Line ${n} item`}
                      value={l.itemId ?? null}
                      disabled={disabled}
                      onChange={(_, item) => pickItem(i, item)}
                    />
                  </div>
                  <div className="col-span-12 md:col-span-5">
                    <Input
                      id={fid(i, 'description')}
                      aria-label={`Line ${n} description`}
                      aria-invalid={bad(i, 'description')}
                      placeholder="Description"
                      value={l.description}
                      disabled={disabled}
                      maxLength={1000}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    <MoneyInput
                      id={fid(i, 'quantity')}
                      aria-label={`Line ${n} quantity`}
                      aria-invalid={bad(i, 'quantity')}
                      placeholder="Qty"
                      minFraction={0}
                      value={l.quantity}
                      disabled={disabled}
                      onChange={(v) => setLine(i, { quantity: v })}
                    />
                  </div>
                  <div className="col-span-8 md:col-span-2">
                    <MoneyInput
                      id={fid(i, 'price')}
                      aria-label={`Line ${n} unit price`}
                      aria-invalid={bad(i, 'price')}
                      placeholder="Unit price"
                      allowNegative
                      value={l.unitPrice}
                      disabled={disabled}
                      onChange={(v) => setLine(i, { unitPrice: v })}
                      onKeyDown={(e) => {
                        // Enter in the last line's price starts the next line (Cmd/Ctrl+Enter still saves).
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && i === last && !disabled) {
                          e.preventDefault();
                          addLine();
                        }
                      }}
                    />
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-12 items-center gap-2">
                  <div className="col-span-12 flex items-center gap-2 md:col-span-4">
                    <span className="shrink-0 text-xs font-medium text-stone-500" aria-hidden>
                      Category
                    </span>
                    <div className="min-w-0 flex-1">
                      <AccountPicker
                        id={fid(i, 'account')}
                        aria-label={`Line ${n} category`}
                        value={l.incomeAccountId || null}
                        allow={isIncome}
                        createType="income"
                        recentKey="document-line-income-account"
                        placeholder="Category…"
                        invalid={bad(i, 'account')}
                        disabled={disabled}
                        onChange={(id) => setLine(i, { incomeAccountId: id ?? '' })}
                      />
                    </div>
                  </div>
                  <div className="col-span-12 md:col-span-3">
                    <DiscountEditor
                      discount={l.discount}
                      labelPrefix={`Line ${n}`}
                      valueId={fid(i, 'discount')}
                      invalid={bad(i, 'discount')}
                      disabled={disabled}
                      onChange={(d) => setLine(i, { discount: d })}
                    />
                  </div>
                  <div className="col-span-6 min-w-0 md:col-span-2">
                    <TaxRatePicker
                      aria-label={`Line ${n} tax rates`}
                      className="w-full"
                      value={l.taxRateIds}
                      max={MAX_TAX_RATES}
                      disabled={disabled}
                      onChange={(ids) => setLine(i, { taxRateIds: ids })}
                    />
                  </div>
                  <div className="col-span-6 flex items-center justify-end gap-1 md:col-span-3">
                    <span className="tabular mr-auto whitespace-nowrap text-sm text-stone-700 md:mr-1" data-testid={`line-${n}-net`}>
                      {p ? (
                        <>
                          <span className="font-medium">{formatMoney(p.net, cur)}</span>
                          {!isZeroDecimal(p.taxTotal) && <span className="text-xs text-stone-500"> + {formatMoney(p.taxTotal, cur)} tax</span>}
                        </>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-0.5 border-t border-stone-100 pt-1.5" data-line-actions={idPrefix}>
                  <Button variant="ghost" size="sm" className="px-2" aria-label={`Duplicate line ${n}`} title="Duplicate line" disabled={disabled || value.lines.length >= MAX_LINES} onClick={() => duplicateLine(i)}>
                    <Copy className="size-4" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="sm" className="px-2" aria-label={`Move line ${n} up`} title="Move up" disabled={disabled || i === 0} onClick={() => moveLine(i, -1)}>
                    <ArrowUp className="size-4" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="sm" className="px-2" aria-label={`Move line ${n} down`} title="Move down" disabled={disabled || i === last} onClick={() => moveLine(i, 1)}>
                    <ArrowDown className="size-4" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="sm" className="px-2" aria-label={`Remove line ${n}`} title="Remove line" disabled={disabled || value.lines.length <= 1} onClick={() => removeLine(i)}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={addLine} disabled={disabled || value.lines.length >= MAX_LINES}>
            <Plus className="size-4" /> Add line
          </Button>
          <span className="text-xs text-stone-500">Enter in the last unit price adds a line.</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-stone-200 pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <p className="mb-1 text-sm font-medium text-stone-700">Document discount</p>
          <DiscountEditor
            discount={value.documentDiscount}
            labelPrefix="Document"
            valueId={`${idPrefix}-doc-discount`}
            invalid={invalid?.has(`${idPrefix}-doc-discount`)}
            disabled={disabled}
            onChange={(d) => onChange({ ...value, documentDiscount: d })}
          />
          <p className="mt-1 text-xs text-stone-500">Applied after line discounts and shared across lines before tax.</p>
        </div>
        <dl className={`tabular w-full space-y-1 text-sm sm:max-w-xs ${previewPending ? 'opacity-60 transition-opacity' : ''}`} aria-live="polite" aria-busy={previewPending || undefined}>
          <div className="flex justify-between">
            <dt className="text-stone-500">Subtotal</dt>
            <dd data-testid="doc-subtotal">{preview ? formatMoney(preview.subtotal, cur) : '—'}</dd>
          </div>
          {preview && !isZeroDecimal(preview.discountTotal) && (
            <div className="flex justify-between">
              <dt className="text-stone-500">Discounts</dt>
              <dd data-testid="doc-discount">−{formatMoney(preview.discountTotal, cur)}</dd>
            </div>
          )}
          {preview?.taxSummary.map((t) => (
            <div key={t.taxRateId} className="flex justify-between">
              <dt className="text-stone-500">
                {t.name} ({fractionToPercent(t.rate)})
              </dt>
              <dd>{formatMoney(t.amount, cur)}</dd>
            </div>
          ))}
          {preview && preview.taxSummary.length === 0 && (
            <div className="flex justify-between">
              <dt className="text-stone-500">Tax</dt>
              <dd>{formatMoney(preview.taxTotal, cur)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-stone-200 pt-1 text-base font-semibold text-stone-900">
            <dt>Total</dt>
            <dd data-testid="doc-total">{preview ? formatMoney(preview.total, cur) : '—'}</dd>
          </div>
          <span className="sr-only" data-testid="doc-tax-total">
            {preview ? formatMoney(preview.taxTotal, cur) : ''}
          </span>
        </dl>
      </div>
    </div>
  );
}
