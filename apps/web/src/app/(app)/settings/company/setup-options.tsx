'use client';
import * as React from 'react';
import type { BusinessType, TaxBasis } from '@evenbooks/contracts';
import { cn } from '@/lib/utils';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';

/**
 * The setup answers (business type, tax basis, time zone), shared by the
 * dashboard's welcome questions and Settings → Company so both ask the same way.
 */
export const BUSINESS_TYPES: { value: BusinessType; label: string }[] = [
  { value: 'sole_proprietor', label: 'Sole proprietor' },
  { value: 'single_member_llc', label: 'Single-member LLC' },
  { value: 'partnership', label: 'Partnership or multi-member LLC' },
  { value: 's_corp', label: 'S corporation' },
  { value: 'c_corp', label: 'C corporation' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
];

/** "Not sure" saves as cash, the usual choice for small businesses. */
export type TaxBasisChoice = TaxBasis | 'unsure';
export const TAX_BASIS_CHOICES: { value: TaxBasisChoice; label: string; hint: string }[] = [
  { value: 'cash', label: 'Cash', hint: 'Recommended for most sole proprietors and freelancers: income counts when you’re paid.' },
  { value: 'accrual', label: 'Accrual', hint: 'Income counts when you invoice.' },
  { value: 'unsure', label: 'Not sure — use cash', hint: 'Most small businesses report this way. Your accountant can tell you for sure.' },
];

export const taxBasisFromChoice = (c: TaxBasisChoice | ''): TaxBasis | null => (c === '' ? null : c === 'unsure' ? 'cash' : c);

export const businessTypeLabel = (t: BusinessType | null) => BUSINESS_TYPES.find((b) => b.value === t)?.label ?? null;

/** The browser's time zone, or null when the browser doesn't say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Every IANA zone the browser knows (a short fallback list on old browsers). */
export function useTimeZones(saved: string): { list: string[]; known: Set<string> } {
  const list = React.useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];
    }
  }, []);
  // Intl may omit aliases such as UTC; the saved zone is always acceptable.
  const known = React.useMemo(() => new Set([...list, 'UTC', saved]), [list, saved]);
  return { list, known };
}

/** Shown first, so most US owners find theirs without typing. */
const COMMON_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];

function zoneName(tz: string, style: 'longGeneric' | 'shortOffset'): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** "Chicago — Central Time", with the zone id underneath and the current UTC offset on the right. */
function zoneOption(tz: string, group: string): ComboboxOption {
  const place = tz === 'UTC' ? 'UTC' : tz.split('/').slice(1).reverse().join(', ').replaceAll('_', ' ') || tz;
  const generic = tz === 'UTC' ? 'Coordinated Universal Time' : zoneName(tz, 'longGeneric');
  return {
    value: tz,
    label: generic && !generic.startsWith('GMT') ? `${place} — ${generic}` : place,
    description: tz,
    hint: zoneName(tz, 'shortOffset').replace('GMT', 'UTC').replace('-', '−') || undefined,
    keywords: `${tz.replaceAll('_', ' ')} ${generic}`,
    group,
  };
}

/** Type-to-search time zone dropdown, the same control as the app's other long lists. */
export function TimeZonePicker({ id, value, onChange, zones, invalid }: { id?: string; value: string; onChange(tz: string): void; zones: string[]; invalid?: boolean }) {
  const options = React.useMemo(() => {
    const all = new Set([...zones, ...(value ? [value] : [])]);
    const common = COMMON_ZONES.filter((z) => all.has(z));
    const rest = [...all].filter((z) => !COMMON_ZONES.includes(z)).sort();
    return [...common.map((z) => zoneOption(z, 'United States')), ...rest.map((z) => zoneOption(z, 'All time zones'))];
  }, [zones, value]);
  return <Combobox id={id} value={value || null} onChange={(v) => v && onChange(v)} options={options} invalid={invalid} placeholder="Search for a city, like Chicago" maxResults={600} />;
}

/** A labelled group of radio buttons, one option per row, each with an optional hint. */
export function RadioGroup<T extends string>({
  name,
  legend,
  legendExtra,
  value,
  onChange,
  options,
  disabled,
  className,
  columns,
  id,
}: {
  name: string;
  legend: React.ReactNode;
  /** Shown after the legend, e.g. a HelpTip. */
  legendExtra?: React.ReactNode;
  value: NoInfer<T> | '';
  onChange(v: NoInfer<T>): void;
  options: { value: T; label: string; hint?: string }[];
  disabled?: boolean;
  className?: string;
  /** Lay options out in two columns from `sm` up. */
  columns?: 2;
  id?: string;
}) {
  return (
    <fieldset className={cn('min-w-0', className)} disabled={disabled} id={id}>
      <legend className="flex items-center gap-1 text-sm font-medium text-stone-800">
        {legend}
        {legendExtra}
      </legend>
      <div className={cn('mt-1.5 grid gap-1.5', columns === 2 && 'sm:grid-cols-2')}>
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex min-h-10 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
              value === o.value ? 'border-brand-400 bg-brand-50/50' : 'border-stone-200 hover:border-stone-300',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-0.5 size-4 shrink-0 border-stone-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="min-w-0">
              <span className="font-medium text-stone-900">{o.label}</span>
              {o.hint && <span className="block text-xs text-stone-600">{o.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
