'use client';
import * as React from 'react';
import type { ContactDto } from '@evenbooks/contracts';
import { Field } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useContact, useContacts } from '@/lib/queries/contacts';
import { useDebounced } from '@/lib/use-debounced';
import { ContactDialog } from '@/app/(app)/contacts/contact-dialog';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ContactPickerProps {
  value: string | null;
  onChange(id: string | null, contact: ContactDto | null): void;
  kind?: 'customer' | 'vendor';
  label?: string;
  required?: boolean;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  error?: string | null;
  hint?: React.ReactNode;
  /** Render just the input (with `aria-label`), for filter bars and table cells. */
  bare?: boolean;
  'aria-label'?: string;
  placeholder?: string;
  clearable?: boolean;
  /** Offer "+ New contact" (default true). */
  allowCreate?: boolean;
  includeArchived?: boolean;
  className?: string;
  autoFocus?: boolean;
  'data-autofocus'?: boolean;
}

/**
 * Searchable customer/vendor picker. Searches the server as you type, so it
 * works for any number of contacts, and can create a contact inline from what
 * was typed. The new contact is selected as soon as the server returns it.
 */
export function ContactPicker({
  value,
  onChange,
  kind,
  label,
  required,
  id: idProp,
  disabled,
  invalid,
  error,
  hint,
  bare,
  placeholder,
  clearable,
  allowCreate = true,
  includeArchived,
  className,
  autoFocus,
  ...aria
}: ContactPickerProps) {
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  const [query, setQuery] = React.useState('');
  const q = useDebounced(query.trim(), 200);
  const list = useContacts({ kind, q: q || undefined, limit: 50, includeArchived });
  const [creating, setCreating] = React.useState<{ name: string } | null>(null);
  // The selected contact may not be on the current page of results; fetch it for its name.
  const inList = !!value && (list.data?.items ?? []).some((c) => c.id === value);
  const selected = useContact(value && !inList ? value : '');
  const [created, setCreated] = React.useState<ContactDto | null>(null);

  const fieldLabel = label ?? (kind === 'customer' ? 'Customer' : kind === 'vendor' ? 'Vendor' : 'Contact');

  const options = React.useMemo<ComboboxOption[]>(() => {
    const items = list.data?.items ?? [];
    const withCreated = created && !items.some((c) => c.id === created.id) && (!q || created.name.toLowerCase().includes(q.toLowerCase())) ? [created, ...items] : items;
    return withCreated.map((c) => ({
      value: c.id,
      label: c.name,
      description: c.email ?? undefined,
      hint: c.isArchived ? 'Archived' : !kind && c.isCustomer && c.isVendor ? 'Customer · Vendor' : !kind ? (c.isVendor ? 'Vendor' : 'Customer') : undefined,
    }));
  }, [list.data, created, q, kind]);

  const selectedName = value ? (created?.id === value ? created.name : selected.data?.id === value ? selected.data.name : undefined) : undefined;

  const input = (
    <Combobox
      id={id}
      className={bare ? className : undefined}
      value={value}
      options={options}
      selectedLabel={selectedName ?? (value ? 'Loading…' : undefined)}
      onQueryChange={setQuery}
      onChange={(v) => onChange(v, v ? ((list.data?.items ?? []).find((c) => c.id === v) ?? (created?.id === v ? created : null)) : null)}
      loading={list.isFetching}
      placeholder={placeholder ?? `Search ${fieldLabel.toLowerCase()}s…`}
      disabled={disabled}
      required={required}
      invalid={invalid || !!error}
      clearable={clearable}
      autoFocus={autoFocus}
      emptyText={q ? `No ${fieldLabel.toLowerCase()} matches “${q}”` : `No ${fieldLabel.toLowerCase()}s yet`}
      onCreate={allowCreate ? (text) => setCreating({ name: text }) : undefined}
      createLabel={(text) => (text ? `New contact “${text}”` : 'New contact…')}
      aria-label={aria['aria-label'] ?? (bare ? fieldLabel : undefined)}
      data-autofocus={aria['data-autofocus']}
    />
  );

  return (
    <>
      {bare ? (
        input
      ) : (
        <Field label={fieldLabel} htmlFor={id} required={required} error={error} hint={hint} className={className}>
          {input}
        </Field>
      )}
      {allowCreate && (
        <ContactDialog
          open={!!creating}
          onClose={() => setCreating(null)}
          defaultKind={kind}
          defaultName={creating?.name}
          defaultEmail={creating && EMAIL.test(creating.name) ? creating.name : undefined}
          onSaved={(c) => {
            setCreated(c);
            onChange(c.id, c);
          }}
        />
      )}
    </>
  );
}
