'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { formatDecimalInput, parseDecimalInput } from '@/lib/decimal';
import { Input } from './input';

export interface MoneyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** Canonical decimal string ("1200.50"), or '' for empty. */
  value: string;
  /**
   * Receives the canonical decimal for anything that parses ("$1,200.5" → "1200.5"),
   * or the raw text when it doesn't, so validation can still report it.
   */
  onChange(value: string): void;
  allowNegative?: boolean;
  /** Decimals shown after leaving the field (never drops typed precision). */
  minFraction?: number;
}

/**
 * Amount field that accepts what people actually type: currency symbols,
 * thousands separators, ".5", "(45)" for negatives. It shows the amount
 * with separators after you leave it and flags text that is not a number.
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, allowNegative = false, minFraction = 2, className, onBlur, onFocus, ...props },
  ref,
) {
  const [text, setText] = React.useState(() => (value ? formatDecimalInput(value, minFraction) : ''));
  const [focused, setFocused] = React.useState(false);

  // Follow outside changes (an item filling the price, a form reset) unless they came from our own typing.
  React.useEffect(() => {
    if (focused) return;
    const parsed = parseDecimalInput(text, { allowNegative });
    if (parsed !== value) setText(value && parseDecimalInput(value) !== null ? formatDecimalInput(value, minFraction) : value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const parsed = parseDecimalInput(text, { allowNegative });
  const invalid = parsed === null;

  return (
    <Input
      {...props}
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={cn('tabular text-right', className)}
      aria-invalid={invalid || props['aria-invalid'] ? true : undefined}
      title={invalid ? (allowNegative ? 'Enter an amount like 1,200.50' : 'Enter a positive amount like 1,200.50') : props.title}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const p = parseDecimalInput(t, { allowNegative });
        onChange(p === null ? t : p);
      }}
      onBlur={(e) => {
        setFocused(false);
        const p = parseDecimalInput(text, { allowNegative });
        if (p) setText(formatDecimalInput(p, minFraction));
        onBlur?.(e);
      }}
    />
  );
});
