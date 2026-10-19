'use client';
import * as React from 'react';
import Link from 'next/link';
import { CircleHelp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { glossary, type GlossaryId } from '@/lib/glossary';
import { FloatingPanel } from './floating';

function Explanation({ id, panelId, anchorRef, onClose }: { id: GlossaryId; panelId: string; anchorRef: React.RefObject<HTMLElement | null>; onClose(): void }) {
  const entry = glossary[id];
  return (
    <FloatingPanel
      id={panelId}
      anchorRef={anchorRef}
      role="dialog"
      aria-label={entry.label}
      onDismiss={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          anchorRef.current?.focus();
        }
      }}
      className="max-w-xs p-3 font-normal normal-case tracking-normal"
    >
      <p className="text-sm text-stone-800">{entry.plain}</p>
      {'accountantTerm' in entry && entry.accountantTerm && <p className="mt-1.5 text-xs text-stone-500">Accountants call this {entry.accountantTerm}.</p>}
      {'learnMore' in entry && entry.learnMore && (
        <Link href={entry.learnMore.href} className="mt-2 inline-block text-xs font-medium text-brand-700 underline-offset-2 hover:underline" onClick={onClose}>
          {entry.learnMore.label}
        </Link>
      )}
    </FloatingPanel>
  );
}

function useExplanation() {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();
  return { open, setOpen, ref, panelId };
}

/**
 * A word with a plain explanation one tap away: dotted underline, opens a small popover on
 * click, tap or Enter (works on phones, unlike `title=`). Children default to the glossary
 * label. Use it the first time a screen shows an accounting idea, not on every mention.
 *
 *   <Term id="receivable" />            → "Customers owe you" with the explanation
 *   <Term id="reconcile">Reconcile</Term>
 */
export function Term({ id, children, className }: { id: GlossaryId; children?: React.ReactNode; className?: string }) {
  const x = useExplanation();
  return (
    <>
      <button
        ref={x.ref}
        type="button"
        aria-expanded={x.open}
        aria-controls={x.open ? x.panelId : undefined}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          x.setOpen((o) => !o);
        }}
        className={cn('cursor-help rounded-sm text-left underline decoration-stone-400 decoration-dotted underline-offset-[3px] hover:decoration-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600', className)}
      >
        {children ?? glossary[id].label}
      </button>
      {x.open && <Explanation id={id} panelId={x.panelId} anchorRef={x.ref} onClose={() => x.setOpen(false)} />}
    </>
  );
}

/** A small "?" button beside a label or heading that opens the same explanation as `Term`. */
export function HelpTip({ id, className, label }: { id: GlossaryId; className?: string; /** Accessible name; defaults to "What is <label>?" */ label?: string }) {
  const x = useExplanation();
  return (
    <>
      <button
        ref={x.ref}
        type="button"
        aria-expanded={x.open}
        aria-controls={x.open ? x.panelId : undefined}
        aria-haspopup="dialog"
        aria-label={label ?? `What is “${glossary[id].label}”?`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          x.setOpen((o) => !o);
        }}
        className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-2 focus-visible:outline-brand-600', className)}
      >
        <CircleHelp className="size-4" aria-hidden />
      </button>
      {x.open && <Explanation id={id} panelId={x.panelId} anchorRef={x.ref} onClose={() => x.setOpen(false)} />}
    </>
  );
}
