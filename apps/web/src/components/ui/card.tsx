import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    // min-w-0: as a grid or flex item a card would otherwise grow to its widest
    // content (a table, a long name) and push the page sideways on phones.
    <div className={cn('min-w-0 rounded-lg border border-stone-200 bg-white shadow-sm', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-4 py-3">
      <div>
        <h2 className="font-display text-base font-semibold text-stone-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-stone-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-4 py-3', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-stone-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple';
const tones: Record<BadgeTone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-sky-100 text-sky-800',
  purple: 'bg-violet-100 text-violet-800',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium', tones[tone], className)}>{children}</span>;
}

/** `compact` is for an empty section inside a card: one quiet line instead of a dashed box. */
export function EmptyState({ title, description, action, compact }: { title: string; description?: string; action?: React.ReactNode; compact?: boolean }) {
  if (compact)
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500">
        <p>
          <span className="font-medium text-stone-700">{title}</span>
          {description && <span> · {description}</span>}
        </p>
        {action}
      </div>
    );
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 px-6 py-12 text-center">
      <p className="text-sm font-medium text-stone-800">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-stone-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-6 text-sm text-stone-500">
      <span className="size-4 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-medium underline">
          Retry
        </button>
      )}
    </div>
  );
}
