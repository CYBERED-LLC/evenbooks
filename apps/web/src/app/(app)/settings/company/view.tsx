'use client';
import * as React from 'react';
import type { BusinessType, CompanyDto, TaxBasis, UpdateCompanyInput } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { ErrorSummary, focusFirstError, type FormError } from '@/components/ui/error-summary';
import { useToast } from '@/components/ui/toast';
import { useCompany } from '@/components/company-context';
import { useSaveCompanyFields, useUpdateCompany } from '@/lib/queries/company';
import { HelpTip, Term } from '@/components/ui/term';
import { usePeriods } from '@/lib/queries/periods';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { ApiClientError, api } from '@/lib/api-client';
import { useRouter } from 'next/navigation';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';
import { US_STATES } from './us-states';
import { BUSINESS_TYPES, RadioGroup, TAX_BASIS_CHOICES, TimeZonePicker, useTimeZones } from './setup-options';

type Form = ReturnType<typeof fromCompany>;
type FieldKey = keyof Form;

function fromCompany(company: CompanyDto) {
  return {
    name: company.name,
    legalName: company.legalName ?? '',
    email: company.email ?? '',
    phone: company.phone ?? '',
    line1: company.address.line1 ?? '',
    line2: company.address.line2 ?? '',
    city: company.address.city ?? '',
    region: company.address.region ?? '',
    postalCode: company.address.postalCode ?? '',
    timeZone: company.timeZone,
    fiscalYearStartMonth: String(company.fiscalYearStartMonth),
    invoicePrefix: company.invoicePrefix,
    nextInvoiceNumber: String(company.nextInvoiceNumber),
    creditNotePrefix: company.creditNotePrefix,
    defaultTermsDays: String(company.defaultTermsDays),
    invoiceFooter: company.invoiceFooter ?? '',
    transactionDeletion: company.transactionDeletionEnabled ? 'on' : 'off',
    businessType: (company.businessType ?? '') as BusinessType | '',
    taxBasis: (company.taxBasis ?? '') as TaxBasis | '',
  };
}

/** DOM ids, so errors can point at (and focus) their field. */
const FIELD_ID: Record<FieldKey, string> = {
  name: 'name',
  legalName: 'legal',
  email: 'email',
  phone: 'phone',
  line1: 'l1',
  line2: 'l2',
  city: 'city',
  region: 'region',
  postalCode: 'zip',
  timeZone: 'tz',
  fiscalYearStartMonth: 'fy',
  invoicePrefix: 'ipfx',
  nextInvoiceNumber: 'inum',
  creditNotePrefix: 'cpfx',
  defaultTermsDays: 'terms',
  invoiceFooter: 'footer',
  transactionDeletion: 'allow-delete',
  businessType: 'business-type',
  taxBasis: 'tax-basis',
};

const FIELD_LABEL: Record<FieldKey, string> = {
  name: 'company name',
  legalName: 'legal name',
  email: 'email',
  phone: 'phone',
  line1: 'address',
  line2: 'address',
  city: 'city',
  region: 'state',
  postalCode: 'ZIP',
  timeZone: 'time zone',
  fiscalYearStartMonth: 'tax year start',
  invoicePrefix: 'invoice prefix',
  nextInvoiceNumber: 'next invoice number',
  creditNotePrefix: 'credit note prefix',
  defaultTermsDays: 'payment terms',
  invoiceFooter: 'invoice footer',
  transactionDeletion: 'deleting transactions',
  businessType: 'kind of business',
  taxBasis: 'tax reporting',
};
const ADDRESS_KEYS: FieldKey[] = ['line1', 'line2', 'city', 'region', 'postalCode'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const changedKeys = (form: Form, base: Form) => (Object.keys(form) as FieldKey[]).filter((k) => form[k] !== base[k]);

/** The update payload for the changed fields; the address travels as a whole. */
function toInput(form: Form, changed: FieldKey[]): Omit<UpdateCompanyInput, 'version'> {
  const has = (k: FieldKey) => changed.includes(k);
  return {
    ...(has('name') && { name: form.name.trim() }),
    ...(has('legalName') && { legalName: form.legalName.trim() || null }),
    ...(has('email') && { email: form.email.trim() || null }),
    ...(has('phone') && { phone: form.phone.trim() || null }),
    ...(ADDRESS_KEYS.some(has) && {
      address: { line1: form.line1, line2: form.line2, city: form.city, region: form.region, postalCode: form.postalCode.trim(), country: 'US' },
    }),
    ...(has('timeZone') && { timeZone: form.timeZone.trim() }),
    ...(has('fiscalYearStartMonth') && { fiscalYearStartMonth: Number(form.fiscalYearStartMonth) }),
    ...(has('invoicePrefix') && { invoicePrefix: form.invoicePrefix }),
    ...(has('nextInvoiceNumber') && { nextInvoiceNumber: Number(form.nextInvoiceNumber) }),
    ...(has('creditNotePrefix') && { creditNotePrefix: form.creditNotePrefix }),
    ...(has('defaultTermsDays') && { defaultTermsDays: Number(form.defaultTermsDays) }),
    ...(has('invoiceFooter') && { invoiceFooter: form.invoiceFooter || null }),
    ...(has('transactionDeletion') && { transactionDeletionEnabled: form.transactionDeletion === 'on' }),
    ...(has('businessType') && { businessType: form.businessType || null }),
    ...(has('taxBasis') && { taxBasis: form.taxBasis || null }),
  };
}

const sameForm = (a: Form, b: Form) => (Object.keys(a) as FieldKey[]).every((k) => a[k] === b[k]);

function validate(form: Form, base: Form, company: CompanyDto, timeZones: Set<string>): Partial<Record<FieldKey, string>> {
  const e: Partial<Record<FieldKey, string>> = {};
  if (!form.name.trim()) e.name = 'Enter the company name.';
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = 'Enter a full email address, like billing@example.com.';
  if (form.postalCode.trim() && !/^\d{5}(-\d{4})?$/.test(form.postalCode.trim())) e.postalCode = 'Use a 5-digit ZIP, or ZIP+4 like 62704-1234.';
  if (!form.timeZone.trim()) e.timeZone = 'Choose a time zone.';
  else if (timeZones.size > 0 && !timeZones.has(form.timeZone.trim())) e.timeZone = 'Pick a time zone from the list, like America/Chicago.';
  const terms = form.defaultTermsDays.trim();
  if (!/^\d+$/.test(terms) || Number(terms) > 365) e.defaultTermsDays = 'Enter a whole number of days from 0 to 365.';
  if (form.invoicePrefix.length > 12) e.invoicePrefix = 'Keep the prefix to 12 characters or fewer.';
  if (form.creditNotePrefix.length > 12) e.creditNotePrefix = 'Keep the prefix to 12 characters or fewer.';
  const next = form.nextInvoiceNumber.trim();
  if (!/^\d+$/.test(next) || Number(next) < 1) e.nextInvoiceNumber = 'Enter a whole number.';
  // Unchanged is always fine, even if issued invoices have since moved the number on.
  else if (next !== base.nextInvoiceNumber && Number(next) < company.nextInvoiceNumber)
    e.nextInvoiceNumber = `It can only go up: numbers below ${company.nextInvoiceNumber} may already be on issued invoices.`;
  if (form.invoiceFooter.length > 2000) e.invoiceFooter = 'Keep the footer to 2,000 characters or fewer.';
  return e;
}

/** Point server validation messages at the field they are about. */
function serverFieldError(err: unknown): Partial<Record<FieldKey, string>> | null {
  if (!(err instanceof ApiClientError)) return null;
  const m = err.message.toLowerCase();
  if (err.code === 'invalid_state' && m.includes('fiscal year')) return { fiscalYearStartMonth: err.message };
  if (err.status !== 400) return null;
  if (m.includes('invoice number')) return { nextInvoiceNumber: err.message };
  if (m.includes('time zone')) return { timeZone: err.message };
  if (m.includes('email')) return { email: err.message };
  return null;
}

export function CompanySettingsView() {
  const { company, isAdmin } = useCompany();
  const router = useRouter();
  const update = useUpdateCompany();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const mod = useModKeyLabel();
  const [baseline, setBaseline] = React.useState(() => fromCompany(company));
  const [form, setForm] = React.useState(baseline);
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({});
  const dirty = !sameForm(form, baseline);

  // Fresh server data (after a save, or a change elsewhere) replaces the form unless there are unsaved edits.
  const serverForm = React.useMemo(() => fromCompany(company), [company]);
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  React.useEffect(() => {
    setBaseline(serverForm);
    if (!dirtyRef.current) setForm(serverForm);
  }, [serverForm]);

  const guard = useUnsavedChanges(isAdmin && dirty);

  const { list: timeZones, known: zoneSet } = useTimeZones(company.timeZone);

  const set = (k: FieldKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    if (errors[k]) setErrors((errs) => ({ ...errs, [k]: undefined }));
  };
  const err = (k: FieldKey) => errors[k] ?? null;
  const invalid = (k: FieldKey) => (errors[k] ? true : undefined);

  const showErrors = (next: Partial<Record<FieldKey, string>>) => {
    setErrors(next);
    focusFirstError(toFormErrors(next));
  };

  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    if (!isAdmin || saving) return;
    const next = validate(form, baseline, company, zoneSet);
    if (Object.keys(next).length) return showErrors(next);
    setErrors({});
    const changed = changedKeys(form, baseline);
    if (changed.length === 0) return;
    // Only changed fields are sent, so numbering moved on by newly issued invoices is left alone.
    const input = toInput(form, changed);
    setSaving(true);
    try {
      let saved: CompanyDto;
      try {
        saved = await update.mutateAsync({ version: company.version, ...input });
      } catch (e) {
        if (!(e instanceof ApiClientError && e.code === 'version_conflict')) throw e;
        // Something else saved the company (often just an invoice taking the next number).
        // Retry on the fresh version unless the same fields were changed there.
        const fresh = await api<CompanyDto>('/api/company', { companyId: company.id });
        const freshForm = fromCompany(fresh);
        const clash = changed.filter((k) => freshForm[k] !== baseline[k]);
        if (clash.length) {
          setBaseline(freshForm);
          router.refresh();
          toast.error('Someone else changed these settings', `Check the ${[...new Set(clash.map((k) => FIELD_LABEL[k]))].join(', ')} and save again.`);
          return;
        }
        const recheck = validate(form, baseline, fresh, zoneSet);
        if (Object.keys(recheck).length) return showErrors(recheck);
        saved = await update.mutateAsync({ version: fresh.version, ...input });
      }
      guard.markSaved();
      const fresh = fromCompany(saved);
      setBaseline(fresh);
      setForm(fresh);
      toast.success('Settings saved');
    } catch (e) {
      const fieldErr = serverFieldError(e);
      if (fieldErr) showErrors(fieldErr);
      else onError(e, 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };
  const submitKeys = useSubmitShortcut(() => void save(), isAdmin);

  // The service refuses a new fiscal year start while any period is closed; say so up front.
  const periods = usePeriods();
  const closedPeriods = periods.data?.filter((p) => p.status === 'closed').length ?? 0;
  const fiscalLocked = closedPeriods > 0;
  const fiscalChanged = form.fiscalYearStartMonth !== baseline.fiscalYearStartMonth;

  const regionKnown = !form.region || US_STATES.some((s) => s.code === form.region);
  const summary = toFormErrors(errors);

  return (
    <>
      <PageHeader title="Company" description={isAdmin ? 'Your business details, how you report taxes, and how invoices are numbered.' : 'Only admins can change these settings.'} />
      <form
        noValidate
        className="space-y-4"
        onKeyDown={submitKeys.onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!isAdmin} className="space-y-4">
          <Card>
            <CardHeader title="Identity" description="Shown on invoices, credit notes and customer emails." />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Company name" htmlFor="name" required error={err('name')}>
                <Input id="name" value={form.name} onChange={set('name')} aria-invalid={invalid('name')} autoComplete="organization" />
              </Field>
              <Field label="Legal name" htmlFor="legal" hint="If different from the name customers know.">
                <Input id="legal" value={form.legalName} onChange={set('legalName')} />
              </Field>
              <Field label="Email" htmlFor="email" error={err('email')}>
                <Input id="email" type="email" value={form.email} onChange={set('email')} aria-invalid={invalid('email')} autoComplete="email" />
              </Field>
              <Field label="Phone" htmlFor="phone">
                <Input id="phone" type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" />
              </Field>
              <Field label="Address line 1" htmlFor="l1" className="sm:col-span-2">
                <Input id="l1" value={form.line1} onChange={set('line1')} autoComplete="address-line1" />
              </Field>
              <Field label="Address line 2" htmlFor="l2" className="sm:col-span-2">
                <Input id="l2" value={form.line2} onChange={set('line2')} autoComplete="address-line2" />
              </Field>
              <Field label="City" htmlFor="city">
                <Input id="city" value={form.city} onChange={set('city')} autoComplete="address-level2" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="State" htmlFor="region">
                  <Select id="region" value={form.region} onChange={set('region')} autoComplete="address-level1">
                    <option value="">Choose…</option>
                    {!regionKnown && <option value={form.region}>{form.region}</option>}
                    {US_STATES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="ZIP" htmlFor="zip" error={err('postalCode')}>
                  <Input id="zip" inputMode="numeric" value={form.postalCode} onChange={set('postalCode')} aria-invalid={invalid('postalCode')} autoComplete="postal-code" />
                </Field>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Business and taxes" description="Reports open the way you report taxes, and dates follow your time zone." />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <RadioGroup
                id="business-type"
                name="business-type"
                legend="What kind of business is this?"
                value={form.businessType}
                onChange={(v) => setForm((f) => ({ ...f, businessType: v }))}
                options={BUSINESS_TYPES}
                className="sm:col-span-2"
                columns={2}
              />
              <RadioGroup
                id="tax-basis"
                name="tax-basis"
                legend="How do you report income for taxes?"
                legendExtra={<HelpTip id="cash-basis" label="What does cash basis mean?" />}
                value={form.taxBasis}
                onChange={(v) => setForm((f) => ({ ...f, taxBasis: v }))}
                options={TAX_BASIS_CHOICES.filter((c): c is (typeof c & { value: TaxBasis }) => c.value !== 'unsure')}
                className="sm:col-span-2"
                columns={2}
              />
              <Field label="Time zone" htmlFor="tz" hint="Sets what “today” means for new records and when recurring invoices go out." error={err('timeZone')}>
                <TimeZonePicker id="tz" value={form.timeZone} onChange={(tz) => {
                    setForm((f) => ({ ...f, timeZone: tz }));
                    if (errors.timeZone) setErrors((errs) => ({ ...errs, timeZone: undefined }));
                  }} zones={timeZones} invalid={invalid('timeZone')} />
              </Field>
              <Field
                label={
                  <>
                    <Term id="fiscal-year">Tax year</Term> starts in
                  </>
                }
                htmlFor="fy"
                hint={
                  fiscalLocked
                    ? `Locked while ${closedPeriods} accounting period${closedPeriods === 1 ? ' is' : 's are'} locked. Reopen them in Accounting periods to change it.`
                    : 'The month your tax year starts. For most sole proprietors and single-member LLCs, this is January. It can’t change once a period is locked.'
                }
                error={err('fiscalYearStartMonth')}
              >
                <Select id="fy" value={form.fiscalYearStartMonth} onChange={set('fiscalYearStartMonth')} disabled={fiscalLocked} aria-invalid={invalid('fiscalYearStartMonth')}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={String(i + 1)}>
                      {m}
                    </option>
                  ))}
                </Select>
                {fiscalChanged && company.hasPostedEntries && (
                  <p className="mt-1 text-sm text-amber-800" role="status" data-testid="fiscal-year-warning">
                    Your books already have activity. After saving, &ldquo;This tax year&rdquo; and &ldquo;Last tax year&rdquo; in reports, and this year&rsquo;s profit on the balance sheet, cover different dates. Nothing you recorded changes.
                  </p>
                )}
              </Field>
              <p className="text-xs text-stone-500 sm:col-span-2">Amounts are in US dollars.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Invoices" description="How new invoices are numbered and when they are due." />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Default payment terms (days)" htmlFor="terms" hint="Days a customer has to pay. 0 means due on receipt." error={err('defaultTermsDays')}>
                <Input id="terms" type="number" inputMode="numeric" min={0} max={365} value={form.defaultTermsDays} onChange={set('defaultTermsDays')} aria-invalid={invalid('defaultTermsDays')} />
              </Field>
              <Field label="Invoice prefix" htmlFor="ipfx" error={err('invoicePrefix')}>
                <Input id="ipfx" value={form.invoicePrefix} onChange={set('invoicePrefix')} aria-invalid={invalid('invoicePrefix')} />
              </Field>
              <Field
                label="Next invoice number"
                htmlFor="inum"
                hint={`Can only go up (currently ${company.nextInvoiceNumber}), so no two invoices share a number. Next invoice: ${form.invoicePrefix}${form.nextInvoiceNumber || company.nextInvoiceNumber}.`}
                error={err('nextInvoiceNumber')}
              >
                <Input
                  id="inum"
                  type="number"
                  inputMode="numeric"
                  min={company.nextInvoiceNumber}
                  step={1}
                  value={form.nextInvoiceNumber}
                  onChange={set('nextInvoiceNumber')}
                  aria-invalid={invalid('nextInvoiceNumber')}
                />
              </Field>
              <Field label="Credit note prefix" htmlFor="cpfx" error={err('creditNotePrefix')}>
                <Input id="cpfx" value={form.creditNotePrefix} onChange={set('creditNotePrefix')} aria-invalid={invalid('creditNotePrefix')} />
              </Field>
              <Field label="Invoice footer" htmlFor="footer" className="sm:col-span-2" hint="Payment instructions or a thank-you note printed at the bottom of every invoice." error={err('invoiceFooter')}>
                <Textarea id="footer" value={form.invoiceFooter} onChange={set('invoiceFooter')} aria-invalid={invalid('invoiceFooter')} />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Deleting transactions"
              description="Voiding cancels a record but keeps it in your history, marked Void. Deleting removes it as if it never existed."
            />
            <CardBody className="space-y-2">
              <Checkbox
                id="allow-delete"
                label="Allow administrators to delete transactions permanently"
                checked={form.transactionDeletion === 'on'}
                onChange={(e) => {
                  const value = e.target.checked ? 'on' : 'off';
                  setForm((f) => ({ ...f, transactionDeletion: value }));
                }}
              />
              <p className="text-xs text-stone-500">
                Applies to invoices, credit notes, payments, refunds, expenses, journal entries and bank transactions. Records in locked periods and payments collected online can&rsquo;t be deleted, and every delete is kept in History. Turn this off to allow only voids.
              </p>
            </CardBody>
          </Card>
          {isAdmin && (
            <div className="sticky bottom-0 z-10 -mx-1 rounded-lg border border-stone-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/80 print:hidden">
              {summary.length > 0 && (
                <div className="mb-3">
                  <ErrorSummary errors={summary} />
                </div>
              )}
              <div className="flex flex-wrap items-center justify-end gap-3">
                <p className="mr-auto text-sm text-stone-600" role="status">
                  {dirty ? <span className="font-medium text-amber-800">You have unsaved changes</span> : 'All changes saved'}
                </p>
                {dirty && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setForm(baseline);
                      setErrors({});
                    }}
                  >
                    Discard changes
                  </Button>
                )}
                <Button type="submit" loading={saving} disabled={!dirty && !saving} title={`Save settings (${mod}+Enter)`}>
                  Save settings
                </Button>
              </div>
            </div>
          )}
        </fieldset>
      </form>
      {isAdmin && <SetupChecklistSetting />}
    </>
  );
}

/** Brings back (or hides) the dashboard's "Set up your books" list. Saves right away. */
function SetupChecklistSetting() {
  const { company } = useCompany();
  const save = useSaveCompanyFields();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const hidden = Boolean(company.setupDismissedAt);
  return (
    <Card className="mt-4" data-testid="setup-checklist-setting">
      <CardHeader title="Setup checklist" description="The “Set up your books” list on the dashboard. It goes away by itself once every step is done." />
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-600">{hidden ? 'Hidden from the dashboard.' : 'Shown on the dashboard until setup is done.'}</p>
        <Button
          variant="secondary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { setupDismissed: !hidden },
              {
                onSuccess: () => toast.success(hidden ? 'The setup checklist is back on the dashboard' : 'Setup checklist hidden'),
                onError: (e) => onError(e, 'Could not change the setup checklist'),
              },
            )
          }
        >
          {hidden ? 'Show the setup checklist' : 'Hide the setup checklist'}
        </Button>
      </CardBody>
    </Card>
  );
}

const FIELD_ORDER = Object.keys(FIELD_ID) as FieldKey[];
function toFormErrors(errors: Partial<Record<FieldKey, string>>): FormError[] {
  return FIELD_ORDER.filter((k) => errors[k]).map((k) => ({ message: errors[k]!, fieldId: FIELD_ID[k] }));
}
