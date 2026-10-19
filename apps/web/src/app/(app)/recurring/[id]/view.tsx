'use client';
import * as React from 'react';
import Link from 'next/link';
import { Pause, Pencil, Play, PlayCircle, XCircle } from 'lucide-react';
import { ActionMenu } from '@/components/ui/action-menu';
import type { ScheduleDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { BackLink } from '@/components/ui/list';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { useToast } from '@/components/ui/toast';
import { useCancelSchedule, usePauseSchedule, useResumeSchedule, useRunSchedule, useSchedule, useUpdateSchedule } from '@/lib/queries/recurring';
import { useContact } from '@/lib/queries/contacts';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { capitalize, formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { FREQUENCY_LABEL, ScheduleStatusBadge, templateSubtotal } from '../view';
import { ReadOnlyLines, TemplateEditor, templateFromDto, templateToInput, validateTemplate, type TemplateState } from '../schedule-form';

const INVOICE_TONE: Record<string, 'neutral' | 'green' | 'amber' | 'red' | 'blue'> = { draft: 'neutral', issued: 'blue', paid: 'green', void: 'red' };
/** Occurrences carry only the stored status, so "issued" isn't split into unpaid or partly paid here. */
const INVOICE_LABEL: Record<string, string> = { draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void' };

export function ScheduleDetailView({ id }: { id: string }) {
  const { company } = useCompany();
  const q = useSchedule(id);
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const pause = usePauseSchedule(id);
  const run = useRunSchedule(id);
  const [dialog, setDialog] = React.useState<'template' | 'resume' | 'cancel' | 'settings' | null>(null);
  const cur = company.baseCurrency;

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const editable = s.status !== 'cancelled';
  const total = s.templateTotal ? { amount: s.templateTotal, approximate: false } : templateSubtotal(s.template);
  const occurrences = s.occurrences ?? [];

  return (
    <>
      <BackLink listPath="/recurring" label="Recurring invoices" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name} <ScheduleStatusBadge status={s.status} />
          </span>
        }
        description={
          <>
            {FREQUENCY_LABEL[s.frequency]} invoices for{' '}
            <Link href={`/contacts/${s.contactId}`} className="text-brand-700 hover:underline">
              {s.contactName ?? 'customer'}
            </Link>
            {s.createdFromInvoiceId && (
              <>
                {' '}
                · repeats{' '}
                <Link href={`/invoices/${s.createdFromInvoiceId}`} className="text-brand-700 hover:underline">
                  the source invoice
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {s.status === 'active' && (
              <Button
                variant="secondary"
                loading={pause.isPending}
                onClick={() => pause.mutate({ version: s.version }, { onSuccess: () => toast.success('Schedule paused'), onError: (e) => onError(e, 'Could not pause schedule') })}
              >
                <Pause className="size-4" /> Pause
              </Button>
            )}
            {s.status === 'paused' && (
              <Button variant="secondary" onClick={() => setDialog('resume')}>
                <Play className="size-4" /> Resume…
              </Button>
            )}
            {(s.status === 'active' || s.status === 'paused') && (
              <Button
                variant="secondary"
                loading={run.isPending}
                onClick={() =>
                  run.mutate(undefined, {
                    onSuccess: (r) => {
                      if (r.issued.length === 0) toast.info('Nothing due', r.skippedExisting ? `${r.skippedExisting} ${r.skippedExisting === 1 ? 'invoice was' : 'invoices were'} already created.` : 'The next invoice date is still ahead.');
                      else toast.success(`Issued ${r.issued.length} invoice${r.issued.length === 1 ? '' : 's'}`, r.skippedExisting ? `${r.skippedExisting} already existed and were skipped.` : undefined);
                    },
                    onError: (e) => onError(e, 'Could not issue invoices'),
                  })
                }
              >
                <PlayCircle className="size-4" /> Issue due now
              </Button>
            )}
            <ActionMenu
              groups={[
                [editable && { label: 'Edit settings…', icon: Pencil, description: 'Name, end date, days to pay, email', onSelect: () => setDialog('settings') }],
                [editable && { label: 'Cancel schedule…', icon: XCircle, tone: 'danger', description: 'Stop issuing invoices; this cannot be resumed', onSelect: () => setDialog('cancel') }],
              ]}
            />
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Summary" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <dt className="text-stone-500">Next invoice</dt>
              <dd data-testid="next-occurrence">
                {s.nextOccurrenceDate ? formatDate(s.nextOccurrenceDate) : '—'}
                {s.nextRunAt && <p className="text-xs text-stone-500">Created {formatDateTime(s.nextRunAt)}</p>}
                {s.status === 'paused' && s.nextOccurrenceDate && <p className="text-xs text-amber-700">Paused: nothing is created until you resume</p>}
              </dd>
              <dt className="text-stone-500">Last created</dt>
              <dd>{s.lastIssuedAt ? formatDateTime(s.lastIssuedAt) : 'Never'}</dd>
              <dt className="text-stone-500">First invoice date</dt>
              <dd>{formatDate(s.anchorDate)}</dd>
              <dt className="text-stone-500">End date</dt>
              <dd>{s.endDate ? formatDate(s.endDate) : 'None'}</dd>
              <dt className="text-stone-500">Days to pay</dt>
              <dd>{s.termsDays === 0 ? 'Due on receipt' : `${s.termsDays} ${s.termsDays === 1 ? 'day' : 'days'}`}</dd>
              <dt className="text-stone-500">Email</dt>
              <dd>{s.sendEmail ? `Each invoice is emailed to ${s.emailTo ?? 'the customer'}` : 'Not emailed; send each one yourself'}</dd>
              <dt className="text-stone-500">Created</dt>
              <dd>{formatDateTime(s.createdAt)}</dd>
              {s.pausedAt && (
                <>
                  <dt className="text-stone-500">Paused since</dt>
                  <dd>{formatDateTime(s.pausedAt)}</dd>
                </>
              )}
            </dl>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="What each invoice contains"
            description="Changes apply to invoices created from now on."
            actions={
              editable ? (
                <Button variant="secondary" size="sm" onClick={() => setDialog('template')}>
                  Edit lines…
                </Button>
              ) : undefined
            }
          />
          <ReadOnlyLines lines={s.template.lines} ariaLabel="Template lines" />
          <CardBody className="space-y-2 border-t border-stone-200 text-sm">
            <div className="flex justify-between">
              <span className="text-stone-500">{total.approximate ? 'Subtotal before tax and discounts' : 'Invoice total'}</span>
              <span className="tabular font-semibold" data-testid="template-total">
                {formatMoney(total.amount, cur)}
              </span>
            </div>
            {s.template.documentDiscount && (
              <p className="text-stone-600">
                Document discount: {s.template.documentDiscount.type === 'percent' ? `${s.template.documentDiscount.value}%` : formatMoney(s.template.documentDiscount.value, cur)}
              </p>
            )}
            {s.template.memo && <p className="text-stone-600">Memo: {s.template.memo}</p>}
            {s.template.footer && <p className="text-stone-600">Footer: {s.template.footer}</p>}
            {s.template.paymentUrl && (
              <p className="break-all text-stone-600">
                Reusable payment URL: <span className="font-mono text-xs">{s.template.paymentUrl}</span>
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Invoices created" description={`${occurrences.length} invoice${occurrences.length === 1 ? '' : 's'} created by this schedule so far.`} />
        {occurrences.length === 0 ? (
          <CardBody>
            <EmptyState compact title="No invoices created yet" description={s.nextOccurrenceDate ? `The first one is created on ${formatDate(s.nextOccurrenceDate)}.` : undefined} />
          </CardBody>
        ) : (
          <Table aria-label="Invoices created">
            <THead>
              <TR>
                <TH className="w-16">#</TH>
                <TH>Date</TH>
                <TH>Invoice</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {occurrences.map((o) => (
                <TR key={o.index}>
                  <TD className="font-mono text-xs">{o.index + 1}</TD>
                  <TD>{formatDate(o.date)}</TD>
                  <TD>
                    {o.invoiceId ? (
                      <Link href={`/invoices/${o.invoiceId}`} className="font-medium text-brand-700 hover:underline">
                        {o.invoiceNumber ?? 'Invoice'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>{o.invoiceStatus ? <Badge tone={INVOICE_TONE[o.invoiceStatus] ?? 'neutral'}>{INVOICE_LABEL[o.invoiceStatus] ?? capitalize(o.invoiceStatus)}</Badge> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <EditTemplateDialog schedule={s} open={dialog === 'template'} onClose={() => setDialog(null)} />
      <ResumeDialog schedule={s} open={dialog === 'resume'} onClose={() => setDialog(null)} />
      <CancelDialog schedule={s} open={dialog === 'cancel'} onClose={() => setDialog(null)} />
      <EditSettingsDialog schedule={s} open={dialog === 'settings'} onClose={() => setDialog(null)} />
    </>
  );
}

function EditTemplateDialog({ schedule, open, onClose }: { schedule: ScheduleDto; open: boolean; onClose: () => void }) {
  const update = useUpdateSchedule(schedule.id);
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [template, setTemplate] = React.useState<TemplateState>(() => templateFromDto(schedule.template));
  const [errors, setErrors] = React.useState<FormError[]>([]);
  React.useEffect(() => {
    if (open) {
      setTemplate(templateFromDto(schedule.template));
      setErrors([]);
    }
  }, [open, schedule.template]);
  const dirty = open && JSON.stringify(template) !== JSON.stringify(templateFromDto(schedule.template));
  const shownErrors = errors.length ? errors.filter((e) => validateTemplate(template, 'edit-tpl').some((x) => x.fieldId === e.fieldId && x.message === e.message)) : errors;

  const save = () => {
    if (update.isPending) return;
    const errs = validateTemplate(template, 'edit-tpl');
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    update.mutate(
      { version: schedule.version, template: templateToInput(template) },
      {
        onSuccess: () => {
          toast.success('Lines updated', 'Invoices created from now on use the new lines.');
          onClose();
        },
        onError: (e) => onError(e, 'Could not update the lines'),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Edit lines"
      description="Changes apply to invoices created from now on. Invoices already created don't change."
      onSubmit={save}
      dirty={dirty}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={update.isPending}>
            Save lines
          </Button>
        </>
      }
    >
      {open && (
        <div className="space-y-4">
          <TemplateEditor value={template} onChange={setTemplate} disabled={update.isPending} idPrefix="edit-tpl" invalid={invalidFields(shownErrors)} />
          <ErrorSummary errors={shownErrors} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Resuming a paused schedule is a financial command: catch-up issues every
 * missed invoice at once. The dialog shows exactly what would be issued and
 * sends one idempotency key per opening so a retry cannot double-issue.
 */
function ResumeDialog({ schedule, open, onClose }: { schedule: ScheduleDto; open: boolean; onClose: () => void }) {
  const resume = useResumeSchedule(schedule.id);
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const idemRef = React.useRef(idempotencyKey());
  React.useEffect(() => {
    if (open) idemRef.current = idempotencyKey();
  }, [open]);
  const missed = schedule.catchUp ?? [];
  const n = missed.length;

  const go = (mode: 'catch_up' | 'skip') =>
    resume.mutate(
      { version: schedule.version, mode, idempotencyKey: idemRef.current },
      {
        onSuccess: (s) => {
          toast.success(
            mode === 'catch_up' && n > 0 ? `Resumed and issued ${n} invoice${n === 1 ? '' : 's'}` : 'Schedule resumed',
            s.nextOccurrenceDate ? `Next invoice ${formatDate(s.nextOccurrenceDate)}` : 'No more invoices to create; the schedule is complete.',
          );
          onClose();
        },
        onError: (e) => onError(e, 'Could not resume schedule'),
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Resume schedule"
      description={n === 0 ? 'No invoice dates were missed while it was paused.' : `${n} invoice date${n === 1 ? ' was' : 's were'} missed while it was paused. Choose what to do with ${n === 1 ? 'it' : 'them'}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={resume.isPending}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => go('skip')} loading={resume.isPending && resume.variables?.mode === 'skip'} disabled={resume.isPending}>
            {n === 0 ? 'Resume from the next date' : 'Skip them and continue from the next date'}
          </Button>
          <Button onClick={() => go('catch_up')} loading={resume.isPending && resume.variables?.mode === 'catch_up'} disabled={resume.isPending || n === 0}>
            Issue these {n} missed invoice{n === 1 ? '' : 's'} now
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-stone-600">
          Missed dates <span data-testid="catch-up-count">({n})</span>
        </p>
        {n === 0 ? (
          <p className="text-stone-500">Every invoice up to today has already been created.</p>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-md border border-stone-200" aria-label="Missed dates">
            {missed.map((o) => (
              <li key={o.index} className="flex justify-between px-3 py-1.5">
                <span>Invoice {o.index + 1}</span>
                <span className="tabular">{formatDate(o.date)}</span>
              </li>
            ))}
          </ul>
        )}
        {schedule.nextOccurrenceDate && n === 0 && <p className="text-stone-600">The next invoice is created on {formatDate(schedule.nextOccurrenceDate)}.</p>}
        {n > 0 && <p className="text-xs text-stone-500">Skipped dates can&rsquo;t be billed by the schedule later; you can still create those invoices by hand.</p>}
      </div>
    </Dialog>
  );
}

function CancelDialog({ schedule, open, onClose }: { schedule: ScheduleDto; open: boolean; onClose: () => void }) {
  const cancel = useCancelSchedule(schedule.id);
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [reason, setReason] = React.useState('');
  React.useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const submit = () => {
    if (!reason.trim() || cancel.isPending) return;
    cancel.mutate(
      { version: schedule.version, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Schedule cancelled');
          onClose();
        },
        onError: (e) => onError(e, 'Could not cancel schedule'),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Cancel schedule"
      description="No more invoices will be created. Invoices already created don't change. Cancelling can't be undone; the reason is kept in the schedule's history."
      onSubmit={submit}
      dirty={!!reason.trim()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={cancel.isPending}>
            Keep schedule
          </Button>
          <Button type="submit" variant="danger" disabled={!reason.trim()} loading={cancel.isPending}>
            Cancel schedule
          </Button>
        </>
      }
    >
      <Field label="Reason" htmlFor="cancel-reason" required>
        <Textarea id="cancel-reason" data-autofocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function EditSettingsDialog({ schedule, open, onClose }: { schedule: ScheduleDto; open: boolean; onClose: () => void }) {
  const update = useUpdateSchedule(schedule.id);
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [form, setForm] = React.useState({ name: '', endDate: '', termsDays: '', sendEmail: false, emailTo: '' });
  const customer = useContact(schedule.contactId);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setForm({ name: schedule.name, endDate: schedule.endDate ?? '', termsDays: String(schedule.termsDays), sendEmail: schedule.sendEmail, emailTo: schedule.emailTo ?? '' });
      setError(null);
    }
  }, [open, schedule]);

  const initialForm = { name: schedule.name, endDate: schedule.endDate ?? '', termsDays: String(schedule.termsDays), sendEmail: schedule.sendEmail, emailTo: schedule.emailTo ?? '' };
  const dirty = open && JSON.stringify(form) !== JSON.stringify(initialForm);

  const save = () => {
    if (update.isPending) return;
    const n = Number(form.termsDays);
    if (!form.name.trim()) return setError('Name is required.');
    if (!/^\d+$/.test(form.termsDays.trim()) || n < 0 || n > 365) return setError('Days to pay must be a whole number from 0 to 365.');
    if (form.endDate && form.endDate < schedule.anchorDate) return setError('End date cannot be before the first invoice date.');
    if (form.sendEmail && !form.emailTo.trim()) return setError('Enter the email address to send each invoice to, or turn emailing off.');
    if (form.sendEmail && !/^\S+@\S+\.\S+$/.test(form.emailTo.trim())) return setError('Enter a valid email address.');
    setError(null);
    update.mutate(
      {
        version: schedule.version,
        name: form.name.trim(),
        endDate: form.endDate || null,
        termsDays: n,
        sendEmail: form.sendEmail,
        emailTo: form.emailTo.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success('Schedule updated');
          onClose();
        },
        onError: (e) => onError(e, 'Could not update schedule'),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit settings"
      description={`How often and the first invoice date can't change (${FREQUENCY_LABEL[schedule.frequency].toLowerCase()} from ${formatDate(schedule.anchorDate)}). To change them, cancel this schedule and start a new one.`}
      onSubmit={save}
      dirty={dirty}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="es-name" required className="sm:col-span-2">
          <Input id="es-name" data-autofocus value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="End date" htmlFor="es-end" hint="Leave blank to keep going until you cancel.">
          <Input id="es-end" type="date" value={form.endDate} min={schedule.anchorDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        </Field>
        <Field label="Days to pay" htmlFor="es-terms" required>
          <Input id="es-terms" inputMode="numeric" value={form.termsDays} onChange={(e) => setForm({ ...form, termsDays: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox
            label="Email each invoice to the customer"
            checked={form.sendEmail}
            onChange={(e) => setForm({ ...form, sendEmail: e.target.checked, emailTo: e.target.checked && !form.emailTo.trim() ? (customer.data?.email ?? '') : form.emailTo })}
          />
        </div>
        {form.sendEmail && (
          <Field label="Email address" htmlFor="es-email" required hint={form.emailTo.trim() ? undefined : `${customer.data?.name ?? 'This customer'} has no email on file. Enter one, or turn emailing off.`} className="sm:col-span-2">
            <Input id="es-email" type="email" value={form.emailTo} onChange={(e) => setForm({ ...form, emailTo: e.target.value })} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
