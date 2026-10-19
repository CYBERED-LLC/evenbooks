'use client';
import * as React from 'react';
import type { PeriodDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { addDays } from '@/components/ui/date-input';
import { useClosePeriod, usePeriods, useReclosePeriod, useReopenPeriod } from '@/lib/queries/periods';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { formatDate, formatDateTime } from '@/lib/format';
import { useCompany } from '@/components/company-context';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Last day of the month before (year, month0); month0 may be out of range. */
const lastDayBefore = (year: number, month0: number) => iso(new Date(year, month0, 0));
const firstDayOf = (year: number, month0: number) => iso(new Date(year, month0, 1));

/**
 * Range presets relative to today and the fiscal year start month (1–12).
 * Quarters follow the fiscal year, so a July year has quarters ending Sep, Dec, Mar and Jun.
 */
export function periodPresets(today: Date, fiscalStartMonth: number) {
  const fs0 = fiscalStartMonth - 1;
  const y = today.getFullYear();
  const m0 = today.getMonth();
  // Start of the fiscal year containing today.
  const fyStartYear = m0 >= fs0 ? y : y - 1;
  const lastFy = { start: firstDayOf(fyStartYear - 1, fs0), end: lastDayBefore(fyStartYear, fs0) };
  // Months elapsed in the current fiscal year, rounded down to whole quarters.
  const monthsIn = (m0 - fs0 + 12) % 12;
  const quarterStartMonth0 = fs0 + Math.floor(monthsIn / 3) * 3; // may exceed 11
  const lastQuarterEnd = lastDayBefore(fyStartYear, quarterStartMonth0);
  const lastMonthEnd = lastDayBefore(y, m0);
  const fyStartFor = (end: string) => {
    const [ey, em] = end.split('-').map(Number) as [number, number];
    const sy = em - 1 >= fs0 ? ey : ey - 1;
    return firstDayOf(sy, fs0);
  };
  return { lastMonthEnd, lastQuarterEnd, lastFy, fyStartFor };
}

export function PeriodsView() {
  const { isAdmin, company, userId } = useCompany();
  const who = (id: string | null) => (id === userId ? 'you' : 'a teammate');
  const q = usePeriods();
  const close = useClosePeriod();
  const reopen = useReopenPeriod();
  const reclose = useReclosePeriod();
  const toast = useToast();
  const confirm = useConfirm();
  const onError = useMutationErrorHandler();
  const presets = React.useMemo(() => periodPresets(new Date(), company.fiscalYearStartMonth), [company.fiscalYearStartMonth]);
  const [form, setForm] = React.useState({ startDate: presets.lastFy.start, endDate: presets.lastFy.end, reason: '' });
  const [touched, setTouched] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reopening, setReopening] = React.useState<PeriodDto | null>(null);
  const [reason, setReason] = React.useState('');
  const [recloseId, setRecloseId] = React.useState<string | null>(null);

  // Books are usually closed in sequence: start the day after the latest closed period.
  const lastClosedEnd = (q.data ?? [])
    .filter((p) => p.status === 'closed')
    .map((p) => p.endDate)
    .sort()
    .at(-1);
  const suggestedStart = lastClosedEnd ? addDays(lastClosedEnd, 1) : undefined;
  const startFor = React.useCallback((end: string) => (suggestedStart && suggestedStart <= end ? suggestedStart : presets.fyStartFor(end)), [suggestedStart, presets]);

  React.useEffect(() => {
    if (touched || !q.data) return;
    const end = presets.lastFy.end;
    setForm((f) => ({ ...f, startDate: startFor(end), endDate: end }));
  }, [q.data, touched, presets, startFor]);

  const applyPreset = (end: string, start?: string) => {
    setTouched(true);
    setError(null);
    setForm((f) => ({ ...f, startDate: start ?? startFor(end), endDate: end }));
  };

  const submit = async () => {
    if (!form.startDate || !form.endDate) return setError('Enter both a start and an end date.');
    if (form.endDate < form.startDate) return setError('The end date must be on or after the start date.');
    setError(null);
    const ok = await confirm({
      title: 'Lock this period?',
      description: (
        <>
          Nothing dated <strong>{formatDate(form.startDate)}</strong> through <strong>{formatDate(form.endDate)}</strong> can be recorded, changed or voided until an admin reopens the period.
        </>
      ),
      confirmLabel: 'Lock period',
    });
    if (!ok) return;
    close.mutate(
      { startDate: form.startDate, endDate: form.endDate, reason: form.reason || undefined },
      {
        onSuccess: () => {
          toast.success('Period locked', `${formatDate(form.startDate)} – ${formatDate(form.endDate)}`);
          setTouched(false);
          setForm((f) => ({ ...f, reason: '' }));
        },
        onError: (err) => onError(err, 'Could not lock period'),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Accounting periods"
        description="Lock a month or year once you’ve filed or your accountant has signed off, so nothing dated inside it changes by accident. You can reopen it later with a reason."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Periods" />
          {q.isPending && <Spinner />}
          {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
          {q.data && q.data.length === 0 && (
            <CardBody>
              <EmptyState title="No locked periods yet" description="Lock a period once your taxes for it are filed or your accountant has finished with it." />
            </CardBody>
          )}
          {q.data && q.data.length > 0 && (
            <Table aria-label="Accounting periods">
              <THead>
                <TR>
                  <TH>From</TH>
                  <TH>To</TH>
                  <TH>Status</TH>
                  <TH className="hidden md:table-cell">Last change</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {q.data.map((p) => (
                  <TR key={p.id}>
                    <TD>{formatDate(p.startDate)}</TD>
                    <TD>{formatDate(p.endDate)}</TD>
                    <TD>
                      <Badge tone={p.status === 'closed' ? 'neutral' : 'amber'}>{p.status === 'closed' ? 'Locked' : 'Open'}</Badge>
                    </TD>
                    <TD className="hidden text-stone-500 md:table-cell">
                      {p.status === 'closed' ? `Locked ${formatDateTime(p.closedAt)} by ${who(p.closedBy)}` : `Reopened ${formatDateTime(p.reopenedAt)} by ${who(p.reopenedBy)}`}
                      {p.reason && <span className="block text-xs">“{p.reason}”</span>}
                    </TD>
                    <TD>
                      {isAdmin && p.status === 'closed' && (
                        <Button variant="secondary" size="sm" onClick={() => setReopening(p)}>
                          Reopen…
                        </Button>
                      )}
                      {isAdmin && p.status === 'open' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={reclose.isPending && recloseId === p.id}
                          disabled={reclose.isPending && recloseId !== p.id}
                          onClick={() => {
                            setRecloseId(p.id);
                            reclose.mutate(
                              { id: p.id, version: p.version },
                              {
                                onSuccess: () => toast.success('Period locked', `${formatDate(p.startDate)} – ${formatDate(p.endDate)}`),
                                onError: (e) => onError(e, 'Could not lock period'),
                                onSettled: () => setRecloseId(null),
                              },
                            );
                          }}
                        >
                          Lock again
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        {isAdmin && (
          <Card>
            <CardHeader title="Lock a period" description={suggestedStart ? `The last locked period ended ${formatDate(lastClosedEnd)}.` : undefined} />
            <CardBody>
              <form
                noValidate
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div role="group" aria-label="Quick ranges" className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(presets.lastMonthEnd)}>
                    Through last month
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(presets.lastQuarterEnd)}>
                    Through last quarter
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(presets.lastFy.end, presets.lastFy.start)}>
                    Last fiscal year
                  </Button>
                </div>
                <Field label="Start date" htmlFor="ps" required hint={suggestedStart ? `Suggested: ${formatDate(suggestedStart)}, the day after the last locked period.` : undefined}>
                  <Input
                    id="ps"
                    type="date"
                    value={form.startDate}
                    onChange={(e) => {
                      setTouched(true);
                      setForm({ ...form, startDate: e.target.value });
                    }}
                  />
                </Field>
                <Field label="End date" htmlFor="pe" required error={error}>
                  <Input
                    id="pe"
                    type="date"
                    value={form.endDate}
                    min={form.startDate || undefined}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => {
                      setTouched(true);
                      setError(null);
                      setForm({ ...form, endDate: e.target.value });
                    }}
                  />
                </Field>
                <Field label="Reason" htmlFor="pr">
                  <Textarea id="pr" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                </Field>
                <Button type="submit" loading={close.isPending} className="w-full">
                  Lock period
                </Button>
              </form>
            </CardBody>
          </Card>
        )}
      </div>
      <Dialog
        open={Boolean(reopening)}
        onClose={() => setReopening(null)}
        title="Reopen period"
        description={
          reopening
            ? `Anything dated ${formatDate(reopening.startDate)} through ${formatDate(reopening.endDate)} can be recorded and changed again. The reason is kept in History.`
            : undefined
        }
        dirty={!!reason.trim() && !reopen.isPending}
        onSubmit={() => {
          if (!reopening || !reason.trim()) return;
          reopen.mutate(
            { id: reopening.id, input: { version: reopening.version, reason: reason.trim() } },
            {
              onSuccess: () => {
                toast.success('Period reopened');
                setReopening(null);
                setReason('');
              },
              onError: (e) => onError(e, 'Could not reopen period'),
            },
          );
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReopening(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!reason.trim()} loading={reopen.isPending}>
              Reopen
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reopen-reason" required>
          <Textarea id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
