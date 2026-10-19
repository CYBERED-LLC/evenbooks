'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, X } from 'lucide-react';
import { Button } from './button';
import { useListHref } from '@/lib/use-list-params';

export interface ActiveFilter {
  key: string;
  label: React.ReactNode;
}

/** Removable chips for the filters in effect, plus "Clear all". Renders nothing when none are set. */
export function FilterChips({ filters, onRemove, onClear }: { filters: ActiveFilter[]; onRemove(key: string): void; onClear(): void }) {
  if (filters.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" aria-label="Active filters">
      {filters.map((f) => (
        <span key={f.key} className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-white py-0.5 pl-2.5 pr-1 text-xs text-stone-700">
          {f.label}
          <button type="button" aria-label={`Remove filter: ${typeof f.label === 'string' ? f.label : f.key}`} className="rounded-full p-0.5 hover:bg-stone-100" onClick={() => onRemove(f.key)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Button variant="link" size="sm" className="text-xs" onClick={onClear}>
        Clear all
      </Button>
    </div>
  );
}

export interface PagerProps {
  /** Rows on this page. */
  count: number;
  pageIndex: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev(): void;
  onNext(): void;
  /** Plural noun: "invoices". */
  noun: string;
  /** Extra text on the left, such as a page total. */
  summary?: React.ReactNode;
  /** Rows matching the filters across all pages, when the list reports it. */
  total?: number;
}

/** List footer: "Showing 51–100 invoices" with Previous / Next. */
export function Pager({ count, pageIndex, pageSize, hasPrev, hasNext, onPrev, onNext, noun, summary, total }: PagerProps) {
  const start = pageIndex * pageSize + (count ? 1 : 0);
  const end = pageIndex * pageSize + count;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 px-3 py-2 text-sm print:hidden">
      <span className="text-stone-500">
        {hasPrev || hasNext ? `Showing ${start}–${end}${total !== undefined ? ` of ${total}` : ''} ${noun}` : `${total ?? count} ${noun}`}
        {summary && <span className="ml-2 text-stone-700">· {summary}</span>}
      </span>
      {(hasPrev || hasNext) && (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onPrev} disabled={!hasPrev}>
            Previous
          </Button>
          <Button variant="secondary" size="sm" onClick={onNext} disabled={!hasNext}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

/** "← Invoices" link back to the list as the user left it (filters and page kept). */
export function BackLink({ listPath, label }: { listPath: string; label: string }) {
  const href = useListHref(listPath);
  return (
    <Link href={href} className="mb-2 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800 print:hidden">
      <ArrowLeft className="size-4" aria-hidden /> {label}
    </Link>
  );
}
