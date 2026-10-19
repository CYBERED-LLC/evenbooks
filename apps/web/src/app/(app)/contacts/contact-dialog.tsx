'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { ContactDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useCreateContact, useUpdateContact } from '@/lib/queries/contacts';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';

interface FormState {
  name: string;
  isCustomer: boolean;
  isVendor: boolean;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  notes: string;
}

function fromContact(c: ContactDto | null | undefined, defaultKind?: 'customer' | 'vendor', defaultName?: string, defaultEmail?: string): FormState {
  return {
    name: c?.name ?? defaultName ?? '',
    isCustomer: c ? c.isCustomer : defaultKind !== 'vendor',
    isVendor: c ? c.isVendor : defaultKind === 'vendor',
    email: c?.email ?? defaultEmail ?? '',
    phone: c?.phone ?? '',
    line1: c?.billingAddress.line1 ?? '',
    line2: c?.billingAddress.line2 ?? '',
    city: c?.billingAddress.city ?? '',
    region: c?.billingAddress.region ?? '',
    postalCode: c?.billingAddress.postalCode ?? '',
    notes: c?.notes ?? '',
  };
}

function toAddress(f: FormState) {
  const entries = Object.entries({ line1: f.line1, line2: f.line2, city: f.city, region: f.region, postalCode: f.postalCode })
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v.length > 0);
  return Object.fromEntries(entries) as { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string };
}

export interface ContactDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this contact; otherwise it creates one. */
  contact?: ContactDto | null;
  /** Pre-tick the matching kind on create (used by the contact picker). */
  defaultKind?: 'customer' | 'vendor';
  /** Pre-fill the name on create (what was typed into the picker). */
  defaultName?: string;
  /** Pre-fill the email on create (when what was typed looks like one). */
  defaultEmail?: string;
  onSaved?: (contact: ContactDto) => void;
}

/** Create/edit form for a contact. Shared by the contacts pages and the inline picker. */
export function ContactDialog({ open, onClose, contact, defaultKind, defaultName, defaultEmail, onSaved }: ContactDialogProps) {
  const create = useCreateContact();
  const update = useUpdateContact();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const id = React.useId();
  const [form, setForm] = React.useState<FormState>(() => fromContact(contact, defaultKind, defaultName, defaultEmail));
  const [initial, setInitial] = React.useState(form);
  const router = useRouter();
  const [errors, setErrors] = React.useState<{ name?: string; kind?: string; email?: string }>({});
  const editing = Boolean(contact);
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (open) {
      const f = fromContact(contact, defaultKind, defaultName, defaultEmail);
      setForm(f);
      setInitial(f);
      setErrors({});
    }
  }, [open, contact, defaultKind, defaultName, defaultEmail]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
    if (k === 'name') setErrors((er) => ({ ...er, name: undefined }));
    if (k === 'isCustomer' || k === 'isVendor') setErrors((er) => ({ ...er, kind: undefined }));
    if (k === 'email') setErrors((er) => ({ ...er, email: undefined }));
  };

  const submit = () => {
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = 'Name is required';
    if (!form.isCustomer && !form.isVendor) next.kind = 'Pick customer, vendor, or both';
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = 'Enter a full email address, like name@example.com';
    setErrors(next);
    if (Object.keys(next).length > 0) {
      const first = next.name ? 'name' : next.email ? 'email' : null;
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    const fields = {
      name: form.name.trim(),
      isCustomer: form.isCustomer,
      isVendor: form.isVendor,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      billingAddress: toAddress(form),
      notes: form.notes.trim() || null,
    };
    if (contact) {
      update.mutate(
        { id: contact.id, input: { version: contact.version, ...fields } },
        {
          onSuccess: (saved) => {
            toast.success('Contact updated');
            onSaved?.(saved);
            onClose();
          },
          onError: (e) => onError(e, 'Could not update contact'),
        },
      );
    } else {
      create.mutate(fields, {
        onSuccess: (saved) => {
          // Pickers take the new contact straight into their form; elsewhere offer to open it.
          toast.success('Contact created', undefined, onSaved ? undefined : { action: { label: 'Open', onClick: () => router.push(`/contacts/${saved.id}`) } });
          onSaved?.(saved);
          onClose();
        },
        onError: (e) => onError(e, 'Could not create contact'),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${contact!.name}` : 'New contact'}
      size="lg"
      onSubmit={submit}
      dirty={dirty && !pending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${id}-name`} required error={errors.name} className="sm:col-span-2">
          <Input id={`${id}-name`} value={form.name} onChange={set('name')} aria-invalid={errors.name ? true : undefined} data-autofocus />
        </Field>
        <Field label="Kind" required error={errors.kind} className="sm:col-span-2">
          <div className="flex flex-wrap gap-4">
            <Checkbox label="Customer" checked={form.isCustomer} onChange={set('isCustomer')} />
            <Checkbox label="Vendor" checked={form.isVendor} onChange={set('isVendor')} />
          </div>
        </Field>
        <Field label="Email" htmlFor={`${id}-email`} error={errors.email}>
          <Input id={`${id}-email`} type="email" value={form.email} onChange={set('email')} aria-invalid={errors.email ? true : undefined} />
        </Field>
        <Field label="Phone" htmlFor={`${id}-phone`}>
          <Input id={`${id}-phone`} type="tel" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="Address line 1" htmlFor={`${id}-line1`} className="sm:col-span-2">
          <Input id={`${id}-line1`} value={form.line1} onChange={set('line1')} />
        </Field>
        <Field label="Address line 2" htmlFor={`${id}-line2`} className="sm:col-span-2">
          <Input id={`${id}-line2`} value={form.line2} onChange={set('line2')} />
        </Field>
        <Field label="City" htmlFor={`${id}-city`}>
          <Input id={`${id}-city`} value={form.city} onChange={set('city')} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="State / region" htmlFor={`${id}-region`}>
            <Input id={`${id}-region`} value={form.region} onChange={set('region')} />
          </Field>
          <Field label="Postal code" htmlFor={`${id}-postal`}>
            <Input id={`${id}-postal`} value={form.postalCode} onChange={set('postalCode')} />
          </Field>
        </div>
        <Field label="Notes" htmlFor={`${id}-notes`} className="sm:col-span-2">
          <Textarea id={`${id}-notes`} value={form.notes} onChange={set('notes')} />
        </Field>
      </div>
    </Dialog>
  );
}
