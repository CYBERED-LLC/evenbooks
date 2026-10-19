'use client';
import * as React from 'react';
import { Check, ChevronsUpDown, Loader2, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { inputBase } from './input';
import { FloatingPanel } from './floating';

export interface ComboboxOption {
  value: string;
  /** Main text; also what the input shows once the option is selected. */
  label: string;
  /** Short secondary text on the right (price, account type). */
  hint?: string;
  /** Small text under the label. */
  description?: string;
  /** Options sharing a group render under one heading, in the order groups first appear. */
  group?: string;
  /** Extra text the search matches on but does not show. */
  keywords?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  id?: string;
  value: string | null | undefined;
  onChange(value: string | null, option: ComboboxOption | null): void;
  options: ComboboxOption[];
  /** Text for the current value when it is not among `options` (server search, archived records). */
  selectedLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** Show a clear button and let an emptied input clear the value. */
  clearable?: boolean;
  loading?: boolean;
  /** Server-side search. When set, `options` are shown as given (no client filtering). */
  onQueryChange?(query: string): void;
  /** Rank an option for a query: lower is better, null hides it. */
  rank?(option: ComboboxOption, query: string): number | null;
  emptyText?: string;
  /** Adds a "create" row at the bottom; receives what was typed. */
  onCreate?(query: string): void;
  createLabel?(query: string): string;
  /** Most options rendered at once; the rest need a narrower search. */
  maxResults?: number;
  className?: string;
  inputClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  autoFocus?: boolean;
  /** Initial focus target inside a Dialog (see Dialog). */
  'data-autofocus'?: boolean;
  onBlur?(): void;
}

const WORD_SPLIT = /[\s\-–—/().,&:#]+/;

/** Default ranking: label prefix, then word prefix, then substring, then all words present. */
export function defaultRank(option: ComboboxOption, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = option.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  const hay = `${label} ${(option.keywords ?? '').toLowerCase()} ${(option.description ?? '').toLowerCase()}`;
  if (hay.split(WORD_SPLIT).some((w) => w.startsWith(q))) return 1;
  if (hay.includes(q)) return 2;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every((t) => hay.includes(t))) return 3;
  return null;
}

type Row = { kind: 'option'; option: ComboboxOption } | { kind: 'create' };

/**
 * Type-to-search replacement for long `<select>`s. Keyboard: type to filter,
 * ↑/↓ to move, Enter or Tab to pick, Esc to back out. The list renders in the
 * top layer (see FloatingPanel) so it works inside dialogs.
 */
export const Combobox = React.forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(props, forwardedRef) {
  const {
    id: idProp,
    value,
    onChange,
    options,
    selectedLabel,
    placeholder,
    disabled,
    required,
    invalid,
    clearable,
    loading,
    onQueryChange,
    rank = defaultRank,
    emptyText = 'No matches',
    onCreate,
    createLabel = (q) => (q ? `Create “${q}”` : 'Create new…'),
    maxResults = 100,
    className,
    inputClassName,
    autoFocus,
    onBlur,
  } = props;
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  const listId = `${id}-listbox`;
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [active, setActive] = React.useState(0);

  const setInputRef = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const selected = value ? options.find((o) => o.value === value) : undefined;
  const displayLabel = selected?.label ?? (value ? (selectedLabel ?? '') : '');

  const { rows, truncated } = React.useMemo(() => {
    const q = editing ? query : '';
    let list: ComboboxOption[];
    if (onQueryChange || !q.trim()) list = options;
    else {
      const ranked: { o: ComboboxOption; r: number; i: number }[] = [];
      options.forEach((o, i) => {
        const r = rank(o, q);
        if (r !== null) ranked.push({ o, r, i });
      });
      // keep group order as given; rank within each group
      const groupOrder = new Map<string, number>();
      options.forEach((o) => {
        const g = o.group ?? '';
        if (!groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
      });
      ranked.sort((a, b) => groupOrder.get(a.o.group ?? '')! - groupOrder.get(b.o.group ?? '')! || a.r - b.r || a.i - b.i);
      list = ranked.map((x) => x.o);
    }
    const out: Row[] = list.slice(0, maxResults).map((option) => ({ kind: 'option', option }));
    if (onCreate) out.push({ kind: 'create' });
    return { rows: out, truncated: list.length > maxResults };
  }, [options, query, editing, onQueryChange, rank, maxResults, onCreate]);

  const firstEnabled = React.useCallback((from: number, dir: 1 | -1) => {
    for (let i = from; i >= 0 && i < rows.length; i += dir) {
      const r = rows[i]!;
      if (r.kind === 'create' || !r.option.disabled) return i;
    }
    return -1;
  }, [rows]);

  // Keep the highlighted row valid and scrolled into view.
  React.useEffect(() => {
    if (!open) return;
    if (active >= rows.length) setActive(Math.max(0, firstEnabled(0, 1)));
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active, rows.length, firstEnabled]);

  const openList = (fromTyping: boolean) => {
    if (disabled) return;
    setOpen(true);
    if (!fromTyping) {
      const idx = rows.findIndex((r) => r.kind === 'option' && r.option.value === value);
      setActive(idx >= 0 ? idx : Math.max(0, firstEnabled(0, 1)));
    }
  };

  const close = () => {
    setOpen(false);
    setEditing(false);
    setQuery('');
    if (onQueryChange) onQueryChange('');
  };

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'create') {
      const q = editing ? query.trim() : '';
      close();
      onCreate?.(q);
      return;
    }
    if (row.option.disabled) return;
    onChange(row.option.value, row.option);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        if (!open) return openList(false);
        const next = firstEnabled(active + 1, 1);
        if (next >= 0) setActive(next);
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) return openList(false);
        const prev = firstEnabled(active - 1, -1);
        if (prev >= 0) setActive(prev);
        return;
      }
      case 'Enter': {
        if (!open || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        choose(rows[active]);
        return;
      }
      case 'Tab': {
        // Typing a code and tabbing away picks the top match; a plain tab through changes nothing.
        if (open && editing && query.trim()) {
          const row = rows[active];
          if (row?.kind === 'option') choose(row);
          else close();
        } else if (open) close();
        return;
      }
      case 'Escape': {
        if (!open && !editing) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);
    setEditing(true);
    setOpen(true);
    onQueryChange?.(q);
    setActive(0);
  };

  // With client filtering, point at the first enabled result whenever the result set changes.
  React.useEffect(() => {
    if (editing) setActive(Math.max(0, firstEnabled(0, 1)));
  }, [editing, query, firstEnabled]);

  const handleBlur = () => {
    if (editing && !query.trim() && clearable && value) onChange(null, null);
    close();
    onBlur?.();
  };

  const activeRow = open ? rows[active] : undefined;
  const activeId = activeRow ? `${listId}-${active}` : undefined;

  let lastGroup: string | undefined;
  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <input
        ref={setInputRef}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-busy={loading || undefined}
        autoFocus={autoFocus}
        data-autofocus={props['data-autofocus'] || undefined}
        disabled={disabled}
        placeholder={loading && !displayLabel ? 'Loading…' : placeholder}
        value={editing ? query : displayLabel}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.select()}
        onClick={() => (open ? undefined : openList(false))}
        onBlur={handleBlur}
        className={cn(inputBase, 'h-9 w-full truncate', clearable && value ? 'pr-14' : 'pr-8', inputClassName)}
      />
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-2 text-stone-400">
        {loading && open && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {clearable && value && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear"
            className="pointer-events-auto rounded p-0.5 hover:bg-stone-100 hover:text-stone-600"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(null, null);
              close();
            }}
          >
            <X className="size-3.5" />
          </button>
        )}
        <ChevronsUpDown className="size-4" aria-hidden />
      </div>
      {open && (
        <FloatingPanel
          ref={listRef}
          anchorRef={wrapRef}
          matchWidth
          id={listId}
          role="listbox"
          // A distinct name: reusing the field's label would make label lookups ambiguous while open.
          aria-label="Suggestions"
          onMouseDown={(e) => e.preventDefault()}
        >
          {rows.filter((r) => r.kind === 'option').length === 0 && (
            <p className="px-2 py-1.5 text-stone-500">{loading ? 'Searching…' : emptyText}</p>
          )}
          {rows.map((row, i) => {
            if (row.kind === 'create') {
              return (
                <div
                  key="__create"
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={false}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(row)}
                  className={cn(
                    'mt-1 flex cursor-pointer items-center gap-2 rounded border-t border-stone-100 px-2 py-1.5 font-medium text-brand-700',
                    i === active && 'bg-brand-50',
                  )}
                >
                  <Plus className="size-4" aria-hidden />
                  {createLabel(editing ? query.trim() : '')}
                </div>
              );
            }
            const o = row.option;
            const header = o.group !== lastGroup && o.group ? o.group : null;
            lastGroup = o.group;
            const isSelected = o.value === value;
            return (
              <React.Fragment key={o.value}>
                {header && (
                  <div role="presentation" className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500 first:pt-1">
                    {header}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={o.disabled || undefined}
                  onMouseMove={() => !o.disabled && setActive(i)}
                  onClick={() => choose(row)}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded px-2 py-1.5',
                    i === active && 'bg-stone-100',
                    o.disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <Check className={cn('mt-0.5 size-4 shrink-0 text-brand-600', !isSelected && 'invisible')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.description && <span className="block truncate text-xs text-stone-500">{o.description}</span>}
                  </span>
                  {o.hint && <span className="tabular shrink-0 text-xs text-stone-500">{o.hint}</span>}
                </div>
              </React.Fragment>
            );
          })}
          {truncated && <p className="px-2 py-1.5 text-xs text-stone-500">Showing the first {maxResults}. Keep typing to narrow the list.</p>}
        </FloatingPanel>
      )}
    </div>
  );
});
