'use client';
import * as React from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate, todayIso } from '@/lib/format';
import { FloatingPanel } from './floating';
import { Input } from './input';
import { useToday } from '@/components/company-context';

export interface DatePreset {
  label: string;
  value: string;
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD plus `days` (calendar arithmetic, no time zone drift). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d! + days);
  return iso(dt);
}

export function endOfPreviousMonth(from = new Date()): string {
  return iso(new Date(from.getFullYear(), from.getMonth(), 0));
}

/** Today, yesterday and the end of last month: the dates most entries use. */
export function commonDatePresets(today = todayIso()): DatePreset[] {
  return [
    { label: 'Today', value: today },
    { label: 'Yesterday', value: addDays(today, -1) },
    { label: 'End of last month', value: endOfPreviousMonth(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1)) },
  ];
}

/** Net 15/30/60 from a start date, for due dates. */
export function termsPresets(from: string, terms: number[] = [15, 30, 60]): DatePreset[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return [];
  return [{ label: 'On receipt', value: from }, ...terms.map((n) => ({ label: `Net ${n}`, value: addDays(from, n) }))];
}

export interface DateInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange(value: string): void;
  /** Quick picks in a menu beside the field; defaults to today / yesterday / end of last month. Pass [] for none. */
  presets?: DatePreset[];
}

/** Native date field with a menu of quick picks. */
export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { value, onChange, presets, className, disabled, ...props },
  ref,
) {
  const today = useToday();
  const list = presets ?? commonDatePresets(today);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  return (
    <div ref={wrapRef} className={cn('relative flex', className)}>
      <Input ref={ref} type="date" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn('min-w-0 w-full', list.length && 'rounded-r-none')} {...props} />
      {list.length > 0 && (
        <button
          ref={btnRef}
          type="button"
          disabled={disabled}
          aria-label="Quick picks"
          title="Quick picks: today, yesterday…"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-ml-px inline-flex h-9 items-center rounded-r-md border border-stone-300 bg-white px-2 text-stone-500 shadow-sm hover:bg-stone-50 disabled:bg-stone-100"
        >
          <CalendarDays className="size-4" aria-hidden />
        </button>
      )}
      {open && (
        <FloatingPanel
          anchorRef={wrapRef}
          align="end"
          role="menu"
          onDismiss={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              btnRef.current?.focus();
            }
          }}
          className="min-w-52"
        >
          {list.map((p, i) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              autoFocus={i === 0}
              onClick={() => {
                onChange(p.value);
                setOpen(false);
              }}
              className={cn('flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none', p.value === value && 'font-medium text-brand-700')}
            >
              <span>{p.label}</span>
              <span className="tabular text-xs text-stone-500">{formatDate(p.value)}</span>
            </button>
          ))}
        </FloatingPanel>
      )}
    </div>
  );
});
