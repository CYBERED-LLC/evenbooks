'use client';
import * as React from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { FloatingPanel } from '@/components/ui/floating';
import { fractionToPercent, useTaxRates } from '@/lib/queries/tax-rates';
import { cn } from '@/lib/utils';
import { TaxRateDialog } from '@/app/(app)/settings/tax-rates/view';

export interface TaxRatePickerProps {
  value: string[];
  onChange(ids: string[]): void;
  max?: number;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}

/**
 * Compact multi-select for sales tax rates: a button summarizing the chosen
 * rates that opens a checklist, with inline "New tax rate".
 */
export function TaxRatePicker({ value, onChange, max = 5, disabled, className, ...aria }: TaxRatePickerProps) {
  const rates = useTaxRates();
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();
  const all = rates.data ?? [];
  const byId = new Map(all.map((r) => [r.id, r]));
  const active = all.filter((r) => r.isActive || value.includes(r.id));
  const chosen = value.map((id) => byId.get(id));
  const summary =
    value.length === 0 ? 'No tax' : chosen.map((r) => (r ? `${r.name} ${fractionToPercent(r.rate)}` : '(inactive rate)')).join(', ');

  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((x) => x !== id));

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${aria['aria-label']}: ${summary}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={cn(
          'inline-flex h-9 max-w-full items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 text-xs text-stone-700 shadow-sm hover:bg-stone-50 disabled:bg-stone-100 disabled:text-stone-500',
          className,
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0 text-stone-400" aria-hidden />
      </button>
      {open && (
        <FloatingPanel
          id={panelId}
          anchorRef={btnRef}
          onDismiss={() => setOpen(false)}
          role="group"
          aria-label="Choose tax rates"
          className="min-w-56"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              btnRef.current?.focus();
            }
          }}
        >
          {rates.isPending && <p className="px-2 py-1.5 text-stone-500">Loading tax rates…</p>}
          {!rates.isPending && active.length === 0 && <p className="px-2 py-1.5 text-stone-500">No tax rates yet.</p>}
          {active.map((r) => {
            const checked = value.includes(r.id);
            return (
              <label key={r.id} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-stone-100', !checked && value.length >= max && 'cursor-not-allowed opacity-50')}>
                <input
                  type="checkbox"
                  className="size-4 rounded border-stone-300 text-brand-600 focus:ring-brand-500"
                  checked={checked}
                  disabled={!checked && value.length >= max}
                  onChange={(e) => toggle(r.id, e.target.checked)}
                />
                <span className="flex-1">{r.name}</span>{' '}
                <span className="tabular text-xs text-stone-500">{fractionToPercent(r.rate)}</span>
              </label>
            );
          })}
          {value
            .filter((id) => !byId.has(id))
            .map((id) => (
              <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-stone-100">
                <input type="checkbox" className="size-4" checked onChange={() => toggle(id, false)} />
                <span className="flex-1 text-stone-500">(inactive rate)</span>
              </label>
            ))}
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-2 rounded border-t border-stone-100 px-2 py-1.5 text-left font-medium text-brand-700 hover:bg-brand-50"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> New tax rate…
          </button>
        </FloatingPanel>
      )}
      <TaxRateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(r) => {
          if (!value.includes(r.id) && value.length < max) onChange([...value, r.id]);
        }}
      />
    </>
  );
}
