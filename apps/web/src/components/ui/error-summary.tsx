'use client';
import * as React from 'react';

export interface FormError {
  message: string;
  /** DOM id of the field at fault; the summary links to it and it is marked invalid. */
  fieldId?: string;
}

/** Move focus to the first field with an error (call right after validation fails). */
export function focusFirstError(errors: FormError[]) {
  const first = errors.find((e) => e.fieldId);
  if (!first?.fieldId) return;
  requestAnimationFrame(() => {
    const el = document.getElementById(first.fieldId!);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  });
}

/** Set of field ids with errors, for `aria-invalid` / `invalid` props. */
export function invalidFields(errors: FormError[]): Set<string> {
  return new Set(errors.map((e) => e.fieldId).filter((x): x is string => !!x));
}

/** Error list shown above a form's actions; each item jumps to its field. */
export function ErrorSummary({ errors }: { errors: FormError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="list-disc space-y-1 rounded-md border border-red-200 bg-red-50 p-3 pl-8 text-sm text-red-800">
      {errors.map((e) => (
        <li key={`${e.fieldId ?? ''}${e.message}`}>
          {e.fieldId ? (
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() => {
                const el = document.getElementById(e.fieldId!);
                el?.scrollIntoView({ block: 'center' });
                el?.focus();
              }}
            >
              {e.message}
            </button>
          ) : (
            e.message
          )}
        </li>
      ))}
    </ul>
  );
}
