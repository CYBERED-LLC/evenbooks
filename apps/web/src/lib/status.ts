import type { CreditNoteDto, InvoiceDto } from '@evenbooks/contracts';
import { isZeroDecimal, todayIso } from './format';

export interface StatusLabel {
  label: string;
  tone: 'neutral' | 'green' | 'amber' | 'red' | 'blue';
}

/**
 * What an invoice's status means to the reader. The stored status only says
 * "issued"; people need to know whether it is unpaid, partly paid or late.
 */
export function invoiceStatus(inv: Pick<InvoiceDto, 'status' | 'isOverdue' | 'amountSettled'>): StatusLabel {
  switch (inv.status) {
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'paid':
      return { label: 'Paid', tone: 'green' };
    case 'void':
      return { label: 'Void', tone: 'neutral' };
    case 'issued':
      if (inv.isOverdue) return { label: 'Overdue', tone: 'red' };
      return isZeroDecimal(inv.amountSettled) ? { label: 'Unpaid', tone: 'blue' } : { label: 'Partially paid', tone: 'amber' };
  }
}

/** Credit notes: "issued" means credit is still available; "paid" means it has all been used. */
export function creditNoteStatus(cn: Pick<CreditNoteDto, 'status' | 'amountUsed'>): StatusLabel {
  switch (cn.status) {
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'paid':
      return { label: 'Fully used', tone: 'green' };
    case 'void':
      return { label: 'Void', tone: 'neutral' };
    case 'issued':
      return isZeroDecimal(cn.amountUsed) ? { label: 'Available', tone: 'blue' } : { label: 'Partly used', tone: 'amber' };
  }
}

/** Whole days from `from` to `to` (plain YYYY-MM-DD dates). */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Today in the browser's time zone, as YYYY-MM-DD. */
export function localTodayIso(): string {
  return todayIso();
}
