'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The mark as an instrument. The top bar is the debits, the bottom bar the
 * credits, both drawn against the same track. While they differ the bars turn
 * amber and a stroke crosses them, so the equals sign reads as "not equal".
 */
export function BalanceMark({
  debits,
  credits,
  max,
  label,
  ringClass = 'ring-white',
  className,
}: {
  debits: number;
  credits: number;
  /** The value a full-width bar represents. */
  max: number;
  label: string;
  /** Ring colour matching the surface behind the mark, so the stroke cuts the bars cleanly. */
  ringClass?: string;
  className?: string;
}) {
  const balanced = Math.abs(debits - credits) < 0.005;
  const pct = (v: number) => (max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0);
  const fill = balanced ? 'bg-brand-600' : 'bg-amber-600';
  return (
    <div role="img" aria-label={label} className={cn('relative aspect-[2/1]', className)}>
      <span aria-hidden className="absolute inset-x-0 top-[18%] h-[22%] rounded-full bg-stone-200/80" />
      <span aria-hidden className="absolute inset-x-0 bottom-[18%] h-[22%] rounded-full bg-stone-200/80" />
      <span aria-hidden className={cn('ve-bar absolute left-0 top-[18%] h-[22%] rounded-full', fill)} style={{ width: `${pct(debits)}%` }} />
      <span aria-hidden className={cn('ve-bar absolute left-0 bottom-[18%] h-[22%] rounded-full', fill)} style={{ width: `${pct(credits)}%` }} />
      <span
        aria-hidden
        className={cn(
          've-slash absolute top-[-8%] left-1/2 h-[116%] w-[8%] -translate-x-1/2 rotate-[30deg] rounded-full bg-amber-600 ring-[0.35rem]',
          ringClass,
          balanced ? 'scale-y-0 opacity-0' : 'scale-y-100 opacity-100',
        )}
      />
    </div>
  );
}

/** Tween a number toward `target` for count-up figures. Jumps straight there when motion is reduced. */
export function useTween(target: number, ms = 520): number {
  const [value, setValue] = React.useState(target);
  const from = React.useRef(target);
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = origin + (target - origin) * eased;
      from.current = v;
      setValue(t === 1 ? target : v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** Display only: callers compute with Money and convert at the edge. */
export function fmtUsd(n: number): string {
  return usd.format(Math.abs(n) < 0.005 ? 0 : n);
}
