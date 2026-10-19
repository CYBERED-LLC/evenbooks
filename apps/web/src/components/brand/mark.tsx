import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The Evenbooks mark: an equals sign. Two identical bars, because the books
 * balance and the terms are even. Fill and corner radius follow the theme.
 */
export function BrandMark({ className, size = 32, title = 'Evenbooks' }: { className?: string; size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={title}
      className={cn('shrink-0 text-brand-600', className)}
    >
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <rect x="8" y="11" width="16" height="3.5" rx="1.75" fill="var(--color-white, #fff)" />
      <rect x="8" y="17.5" width="16" height="3.5" rx="1.75" fill="var(--color-white, #fff)" />
    </svg>
  );
}

/** Mark plus the lowercase wordmark. `size` scales both. */
export function Wordmark({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const dims = { sm: { mark: 22, text: 'text-base' }, md: { mark: 28, text: 'text-lg' }, lg: { mark: 40, text: 'text-2xl' }, xl: { mark: 56, text: 'text-4xl' } }[size];
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={dims.mark} />
      <span className={cn('font-display font-semibold tracking-tight text-stone-900', dims.text)}>evenbooks</span>
    </span>
  );
}
