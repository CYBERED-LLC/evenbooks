'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const inputBase =
  'rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-stone-100 disabled:text-stone-500 aria-[invalid=true]:border-red-500';

/**
 * Full width unless the caller sets a width: without class merging, `w-full` and
 * a passed `w-24` would both apply and CSS order, not intent, would pick one.
 */
export function fieldWidth(className?: string): string {
  return className && /(^|\s)w-\S+/.test(className) ? '' : 'w-full';
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(inputBase, fieldWidth(className), 'h-9', className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(inputBase, fieldWidth(className), 'min-h-20', className)} {...props} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(inputBase, fieldWidth(className), 'h-9 pr-8', className)} {...props}>
      {children}
    </select>
  );
});

export function Label({ className, children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('block text-sm font-medium text-stone-700', className)} {...props}>
      {children}
    </label>
  );
}

export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  const hintId = htmlFor && hint && !error ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor && error ? `${htmlFor}-error` : undefined;
  const describedBy = errorId ?? hintId;
  // Point the control at its hint or error so screen readers read it with the field.
  const control =
    describedBy && React.isValidElement<{ 'aria-describedby'?: string }>(children) && !children.props['aria-describedby']
      ? React.cloneElement(children, { 'aria-describedby': describedBy })
      : children;
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="text-red-600" aria-hidden>
            {' '}
            *
          </span>
        )}
      </Label>
      {control}
      {hint && !error && (
        <p id={hintId} className="text-xs text-stone-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Checkbox({ className, label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-sm text-stone-800', className)}>
      <input type="checkbox" className="size-4 rounded border-stone-300 text-brand-600 focus:ring-brand-500" {...props} />
      {label}
    </label>
  );
}
