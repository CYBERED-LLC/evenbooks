'use client';
import * as React from 'react';
import { Field, Select } from '@/components/ui/input';
import { subtractDecimals } from '@/lib/decimal';
import type { ReportLine } from '@/lib/queries/reports';
import { DATE_RE, addDays, iso, lastDay } from './report-controls';

/**
 * Period comparison, computed client-side: the report is fetched a second time
 * for the comparison range and the two are merged by account.
 */
export type CompareMode = 'none' | 'prev' | 'yoy';

export function compareParam(sp: URLSearchParams): CompareMode {
  const v = sp.get('compare');
  return v === 'prev' || v === 'yoy' ? v : 'none';
}

function parts(d: string): [number, number, number] {
  return [Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))];
}
function isMonthStart(d: string): boolean {
  return d.endsWith('-01');
}
function isMonthEnd(d: string): boolean {
  const [y, m, day] = parts(d);
  return day === lastDay(y, m);
}
/** Same day `months` months away; month ends stay month ends and the day is clamped (Mar 31 → Feb 28). */
export function shiftMonths(d: string, months: number): string {
  const [y, m, day] = parts(d);
  const target = m + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  const last = lastDay(ty, tm);
  return iso(ty, tm, isMonthEnd(d) ? last : Math.min(day, last));
}

/** Range to compare `from`–`to` against, or null for no comparison. */
export function comparisonRange(from: string, to: string, mode: CompareMode): { from: string; to: string } | null {
  if (mode === 'none' || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return null;
  if (mode === 'yoy') return { from: shiftMonths(from, -12), to: shiftMonths(to, -12) };
  if (isMonthStart(from) && isMonthEnd(to)) {
    // Whole months: the same number of months immediately before (Q2 → Q1, a year → the year before).
    const [fy, fm] = parts(from);
    const [ty, tm] = parts(to);
    const months = ty * 12 + tm - (fy * 12 + fm) + 1;
    return { from: shiftMonths(from, -months), to: addDays(from, -1) };
  }
  // Any other range: the same number of days immediately before.
  const days = Math.round((Date.UTC(...parts(to)) - Date.UTC(...parts(from))) / 86_400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/** As-of date to compare a balance sheet against, or null for no comparison. */
export function comparisonAsOf(asOf: string, mode: CompareMode): string | null {
  if (mode === 'none' || !DATE_RE.test(asOf)) return null;
  if (mode === 'yoy') return shiftMonths(asOf, -12);
  // End of the month before (a month-end date compares with the previous month end).
  const [y, m] = parts(asOf);
  return iso(y, m - 1, lastDay(y, m - 1));
}

export interface MergedLine {
  accountId: string;
  code: string;
  name: string;
  /** Null when the account has no line in the current period. */
  amount: string | null;
  /** Null when the account has no line in the comparison period (or there is no comparison). */
  prior: string | null;
}

/** Current lines plus accounts that only appear in the comparison period, ordered by code. */
export function mergeLines<T extends ReportLine>(current: T[], prior: ReportLine[] | undefined): (MergedLine & { line: T | null })[] {
  const priorById = new Map((prior ?? []).map((l) => [l.accountId, l]));
  const out: (MergedLine & { line: T | null })[] = current.map((l) => ({
    accountId: l.accountId,
    code: l.code,
    name: l.name,
    amount: l.amount,
    prior: priorById.get(l.accountId)?.amount ?? null,
    line: l,
  }));
  if (!prior) return out;
  const seen = new Set(current.map((l) => l.accountId));
  const extra = prior.filter((l) => !seen.has(l.accountId));
  if (extra.length === 0) return out;
  for (const l of extra) out.push({ accountId: l.accountId, code: l.code, name: l.name, amount: null, prior: l.amount, line: null });
  return out.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}

function cents(v: string): bigint {
  // subtractDecimals normalizes to two decimals ("-12.30"), so dropping the point gives exact cents.
  return BigInt(subtractDecimals(v || '0', '0').replace('.', ''));
}

/** Current minus prior as a decimal string. */
export function change(current: string | null, prior: string | null): string {
  return subtractDecimals(current ?? '0', prior ?? '0');
}

/** Percent change against the prior amount's magnitude ("+12.5%"), or null when the prior is zero. */
export function percentChange(current: string | null, prior: string | null): string | null {
  const p = cents(prior ?? '0');
  if (p === 0n) return null;
  const diff = cents(current ?? '0') - p;
  const abs = p < 0n ? -p : p;
  // Tenths of a percent, rounded half away from zero.
  const scaled = diff * 1000n;
  const neg = scaled < 0n;
  const mag = neg ? -scaled : scaled;
  const tenths = (mag + abs / 2n) / abs;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  const sign = tenths === 0n ? '' : neg ? '−' : '+';
  return `${sign}${whole.toLocaleString('en-US')}.${frac}%`;
}

export function compareLabel(mode: CompareMode, kind: 'range' | 'asOf'): string {
  if (mode === 'prev') return kind === 'range' ? 'Previous period' : 'Previous month end';
  if (mode === 'yoy') return kind === 'range' ? 'Same period last year' : 'Same date last year';
  return 'No comparison';
}

export function CompareSelect({ value, onChange, kind = 'range' }: { value: CompareMode; onChange: (m: CompareMode) => void; kind?: 'range' | 'asOf' }) {
  return (
    <Field label="Compare to" htmlFor="compare">
      <Select id="compare" value={value} onChange={(e) => onChange(e.target.value as CompareMode)}>
        {(['none', 'prev', 'yoy'] as const).map((m) => (
          <option key={m} value={m}>
            {compareLabel(m, kind)}
          </option>
        ))}
      </Select>
    </Field>
  );
}
