import { describe, expect, it } from 'vitest';
import { creditNoteStatus, daysBetween, invoiceStatus } from './status';

describe('invoiceStatus', () => {
  const issued = { status: 'issued' as const, isOverdue: false, amountSettled: '0.00' };
  it('splits issued into unpaid, partially paid and overdue', () => {
    expect(invoiceStatus(issued).label).toBe('Unpaid');
    expect(invoiceStatus({ ...issued, amountSettled: '10.00' }).label).toBe('Partially paid');
    expect(invoiceStatus({ ...issued, amountSettled: '10.00', isOverdue: true })).toEqual({ label: 'Overdue', tone: 'red' });
  });
  it('labels the other statuses in sentence case', () => {
    expect(invoiceStatus({ ...issued, status: 'draft' }).label).toBe('Draft');
    expect(invoiceStatus({ ...issued, status: 'paid', amountSettled: '5.00' }).label).toBe('Paid');
    expect(invoiceStatus({ ...issued, status: 'void' }).label).toBe('Void');
  });
});

describe('creditNoteStatus', () => {
  it('describes how much credit is left', () => {
    expect(creditNoteStatus({ status: 'issued', amountUsed: '0' }).label).toBe('Available');
    expect(creditNoteStatus({ status: 'issued', amountUsed: '3.00' }).label).toBe('Partly used');
    expect(creditNoteStatus({ status: 'paid', amountUsed: '3.00' }).label).toBe('Fully used');
  });
});

describe('daysBetween', () => {
  it('counts calendar days across month ends', () => {
    expect(daysBetween('2026-09-30', '2026-10-12')).toBe(12);
    expect(daysBetween('2026-10-12', '2026-10-12')).toBe(0);
    expect(daysBetween('2026-10-12', '2026-10-10')).toBe(-2);
  });
});
