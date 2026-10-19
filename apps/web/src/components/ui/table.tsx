'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const StickyContext = React.createContext(false);

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** Keep the header row in view while the page scrolls (long reports and lists). */
  stickyHeader?: boolean;
}

export function Table({ className, children, stickyHeader, ...props }: TableProps) {
  return (
    <StickyContext.Provider value={!!stickyHeader}>
      {/* A horizontal scroller would also become the sticky header's scroll container, so wide screens drop it.
          `relative` keeps absolutely positioned children (sr-only labels) inside the scroller instead of widening the page. */}
      <div className={cn('relative w-full overflow-x-auto', stickyHeader && 'lg:overflow-x-visible')}>
        <table className={cn('w-full border-collapse text-sm', className)} {...props}>
          {children}
        </table>
      </div>
    </StickyContext.Provider>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  const sticky = React.useContext(StickyContext);
  return (
    <thead className={cn('bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500', sticky && 'lg:sticky lg:top-0 lg:z-10 lg:shadow-[0_1px_0_var(--color-stone-200)]')}>
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-stone-100">{children}</tbody>;
}

export interface TRProps extends React.HTMLAttributes<HTMLTableRowElement> {
  ref?: React.Ref<HTMLTableRowElement>;
  /** Clicking anywhere on the row (outside links and controls) opens this URL; Cmd/Ctrl-click opens a new tab. */
  href?: string;
}

const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="combobox"], [role="button"], [data-row-click="ignore"]';

export function TR({ className, children, href, onClick, ref, ...props }: TRProps) {
  const router = useRouter();
  const handleClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    onClick?.(e);
    if (!href || e.defaultPrevented || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return; // selecting text, not navigating
    if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  };
  return (
    <tr ref={ref} className={cn('hover:bg-stone-50', href && 'cursor-pointer', className)} onClick={handleClick} {...props}>
      {children}
    </tr>
  );
}

export function TH({ className, children, numeric, ...props }: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th scope="col" className={cn('px-3 py-2 font-semibold', numeric && 'text-right', className)} {...props}>
      {children}
    </th>
  );
}

/** A text color in `className` (e.g. red for negatives) replaces the default; both are single utilities, so CSS order alone would let the default win. */
const TEXT_COLOR = /(^|\s)text-(stone|brand|red|emerald|amber|sky|white)-?\d*(\s|$)/;

export function TD({ className, children, numeric, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td className={cn('px-3 py-2 align-top', !TEXT_COLOR.test(className ?? '') && 'text-stone-800', numeric && 'tabular text-right', className)} {...props}>
      {children}
    </td>
  );
}

export interface SortableTHProps extends Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'onClick'> {
  numeric?: boolean;
  sortKey: string;
  /** Active sort key and direction (the list's defaults when the URL has none). */
  sort: string;
  dir: 'asc' | 'desc';
  /** Direction used when this column is first clicked (dates and amounts: newest/largest first). */
  defaultDir?: 'asc' | 'desc';
  /** Receives the direction to apply: the opposite of the current one on the active column, else `defaultDir`. */
  onSort(key: string, dir: 'asc' | 'desc'): void;
}

/** Column header that sorts the list; announces the current order to screen readers. */
export function SortableTH({ className, children, numeric, sortKey, sort, dir, defaultDir = 'desc', onSort, ...props }: SortableTHProps) {
  const active = sort === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn('px-3 py-2 font-semibold', numeric && 'text-right', className)} {...props}>
      <button
        type="button"
        onClick={() => onSort(sortKey, active ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir)}
        className={cn('group inline-flex items-center gap-1 uppercase tracking-wide hover:text-stone-800', numeric && 'flex-row-reverse', active && 'text-stone-800')}
      >
        {children}
        <Icon className={cn('size-3.5 shrink-0', !active && 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60')} aria-hidden />
      </button>
    </th>
  );
}
