'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import type { BusinessType, CompanyDto, InboxPageDto, InvoiceDto, Page } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/input';
import { HelpTip } from '@/components/ui/term';
import { useToast } from '@/components/ui/toast';
import { useCompany } from '@/components/company-context';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useBankAccounts } from '@/lib/queries/banking';
import { journalListOptions } from '@/lib/queries/journal';
import { useLedgerImports } from '@/lib/queries/ledger-imports';
import { processorConnectionOptions } from '@/lib/queries/processor';
import { useSaveCompanyFields } from '@/lib/queries/company';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { cn } from '@/lib/utils';
import {
  BUSINESS_TYPES,
  RadioGroup,
  TAX_BASIS_CHOICES,
  browserTimeZone,
  businessTypeLabel,
  taxBasisFromChoice,
  useTimeZones,
  TimeZonePicker,
  type TaxBasisChoice,
} from '../settings/company/setup-options';
import { setupProgress, setupSteps, showSetupChecklist, type SetupStep } from './setup-steps';

/** Gathers what the checklist needs, as cheaply as possible (one small query per step). */
function useSetupStepList(enabled: boolean): SetupStep[] | null {
  const { company, features } = useCompany();
  const c = company.id;
  const bank = useBankAccounts();
  const accounts = bank.data ?? [];
  const connected = accounts.some((b) => b.connectionId);
  const anyTransactions = useQuery({
    queryKey: [...qk.banking.all(c), 'setup', 'any-transactions'],
    queryFn: async ({ signal }) => {
      const page = await api<InboxPageDto>('/api/banking/transactions', { companyId: c, signal, query: { limit: 1 } });
      return page.items.length > 0 || Object.values(page.counts).some((n) => n > 0);
    },
    enabled: enabled && accounts.length > 0 && !connected,
    staleTime: 30_000,
  });
  const opening = useQuery({ ...journalListOptions(c, { sourceType: 'opening_balance', limit: 1 }), enabled });
  const imports = useLedgerImports();
  const issued = useQuery({
    queryKey: [...qk.invoices.all(c), 'setup', 'any-issued'],
    queryFn: async ({ signal }) => {
      for (const status of ['issued', 'paid'] as const) {
        const page = await api<Page<InvoiceDto>>('/api/invoices', { companyId: c, signal, query: { status, limit: 1 } });
        if (page.items.length > 0) return true;
      }
      return false;
    },
    enabled,
    staleTime: 30_000,
  });
  const processor = useQuery({ ...processorConnectionOptions(c), enabled: enabled && features.onlinePayments });

  const bankDone = connected || anyTransactions.data === true;
  const pending =
    bank.isPending ||
    (accounts.length > 0 && !connected && anyTransactions.isPending) ||
    opening.isPending ||
    imports.isPending ||
    issued.isPending ||
    (features.onlinePayments && processor.isPending);
  if (!enabled || pending) return null;
  return setupSteps({
    aboutDone: Boolean(company.businessType && company.taxBasis),
    detailsDone: Boolean(company.email && company.address.line1),
    bankDone,
    balancesDone: (opening.data?.items.length ?? 0) > 0 || (imports.data ?? []).some((i) => i.status === 'committed'),
    invoiceDone: issued.data === true,
    paymentsDone: features.onlinePayments ? Boolean(processor.data?.chargesEnabled) : null,
  });
}

/** True while the checklist is on screen, so the dashboard can drop the empty To do card. */
export function useSetupChecklistVisible(): { visible: boolean; steps: SetupStep[] | null } {
  const { company, isAdmin } = useCompany();
  const enabled = isAdmin && !company.setupDismissedAt;
  const steps = useSetupStepList(enabled);
  return { visible: showSetupChecklist({ dismissedAt: company.setupDismissedAt, isAdmin, steps }), steps };
}

/** "Set up your books": the first things a new company does, each ticking itself off. */
export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const { company } = useCompany();
  const save = useSaveCompanyFields();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const progress = setupProgress(steps);
  const firstOpen = steps.find((s) => !s.done)?.id;

  const hide = () =>
    save.mutate(
      { setupDismissed: true },
      {
        onSuccess: () => toast.success('Setup list hidden', 'Bring it back from Settings → Company.'),
        onError: (e) => onError(e, 'Could not hide the setup list'),
      },
    );

  return (
    <Card className="mb-6" data-testid="setup-checklist">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-4 py-3">
        <div>
          <h2 className="font-display text-base font-semibold text-stone-900">Set up your books</h2>
          <p className="mt-0.5 text-sm text-stone-500" data-testid="setup-progress">
            {progress.done} of {progress.total} done
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={hide} loading={save.isPending}>
          Hide this list
        </Button>
      </div>
      <div className="h-1 bg-stone-100" aria-hidden>
        <div className="h-1 bg-brand-500 transition-[width]" style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }} />
      </div>
      <ol className="divide-y divide-stone-100" aria-label="Setup steps">
        {steps.map((s) =>
          s.id === 'about' && !s.done ? (
            <li key={s.id} data-step={s.id} data-done="false">
              <div className="flex items-start gap-3 px-4 pt-3">
                <StepIcon done={false} current />
                <div className="min-w-0">
                  <p className="font-medium text-stone-900">{s.title}</p>
                  <p className="text-sm text-stone-600">{s.detail}</p>
                </div>
              </div>
              <WelcomeQuestions company={company} />
            </li>
          ) : (
            <li key={s.id} data-step={s.id} data-done={s.done ? 'true' : 'false'}>
              <Link href={s.href} className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm hover:bg-stone-50">
                <StepIcon done={s.done} current={s.id === firstOpen} />
                <span className="min-w-0 flex-1">
                  <span className={cn('font-medium', s.done ? 'text-stone-500 line-through decoration-stone-300' : 'text-stone-900')}>{s.title}</span>
                  <span className="block text-stone-500">{s.id === 'about' && s.done ? aboutSummary(company) : s.detail}</span>
                </span>
                <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
                <ChevronRight className="size-4 shrink-0 text-stone-400" aria-hidden />
              </Link>
            </li>
          ),
        )}
      </ol>
    </Card>
  );
}

function aboutSummary(company: CompanyDto): string {
  const basis = company.taxBasis === 'accrual' ? 'Accrual' : 'Cash';
  return [businessTypeLabel(company.businessType), `${basis} basis`, company.timeZone].filter(Boolean).join(' · ');
}

function StepIcon({ done, current }: { done: boolean; current: boolean }) {
  return done ? (
    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
  ) : (
    <Circle className={cn('mt-0.5 size-5 shrink-0', current ? 'text-brand-500' : 'text-stone-300')} aria-hidden />
  );
}

/**
 * The three welcome questions, answered inline (never a blocking dialog). Saving them ticks off
 * the first step; they can be changed later in Settings → Company.
 */
function WelcomeQuestions({ company }: { company: CompanyDto }) {
  const save = useSaveCompanyFields();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const zones = useTimeZones(company.timeZone);
  const uid = React.useId();
  const [timeZone, setTimeZone] = React.useState(company.timeZone);
  // Prefill the browser's zone after mount (the server can't know it).
  React.useEffect(() => {
    const tz = browserTimeZone();
    if (tz) setTimeZone(tz);
  }, []);
  const [businessType, setBusinessType] = React.useState<BusinessType | ''>(company.businessType ?? '');
  const [basis, setBasis] = React.useState<TaxBasisChoice | ''>(company.taxBasis ?? '');
  const [submitted, setSubmitted] = React.useState(false);

  const tzError = !timeZone.trim() ? 'Choose a time zone.' : !zones.known.has(timeZone.trim()) ? 'Pick a time zone from the list, like America/Chicago.' : null;
  const typeError = businessType ? null : 'Choose the kind of business.';
  const basisError = basis ? null : 'Choose how you report income.';
  const errors = [tzError, typeError, basisError].filter(Boolean);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (errors.length) return;
    save.mutate(
      { timeZone: timeZone.trim(), businessType: businessType || null, taxBasis: taxBasisFromChoice(basis) },
      { onSuccess: () => toast.success('Saved', 'Reports now open the way you report taxes.'), onError: (err) => onError(err, 'Could not save your answers') },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4 px-4 pb-4 pt-3 sm:pl-12" aria-label="Tell us about your business" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Time zone" htmlFor={`${uid}-tz`} hint="Sets what “today” means for new records and recurring invoices." error={submitted ? tzError : null}>
          <TimeZonePicker id={`${uid}-tz`} value={timeZone} onChange={setTimeZone} zones={zones.list} invalid={submitted && !!tzError} />
        </Field>
      </div>
      <RadioGroup
        name={`${uid}-type`}
        legend="What kind of business is this?"
        value={businessType}
        onChange={setBusinessType}
        options={BUSINESS_TYPES}
        columns={2}
      />
      {submitted && typeError && (
        <p role="alert" className="-mt-2 text-sm text-red-700">
          {typeError}
        </p>
      )}
      <RadioGroup
        name={`${uid}-basis`}
        legend="How do you report income for taxes?"
        legendExtra={<HelpTip id="cash-basis" label="What does cash basis mean?" />}
        value={basis}
        onChange={setBasis}
        options={TAX_BASIS_CHOICES}
      />
      {submitted && basisError && (
        <p role="alert" className="-mt-2 text-sm text-red-700">
          {basisError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
        <p className="text-xs text-stone-500">You can change these later in Settings → Company.</p>
      </div>
    </form>
  );
}
