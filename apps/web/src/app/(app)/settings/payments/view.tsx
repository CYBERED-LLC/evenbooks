'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { ProcessorChargeDto, ProcessorConnectionDto, ProcessorPayoutDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useCompany } from '@/components/company-context';
import { useBankAccounts } from '@/lib/queries/banking';
import {
  useConnectProcessor,
  useDisconnectProcessor,
  useLinkProcessor,
  useProcessorCharges,
  useProcessorConnection,
  useProcessorPayouts,
  useRefreshProcessorConnection,
  useUpdateProcessorConnection,
} from '@/lib/queries/processor';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { capitalize, formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { compareDecimals, isValidDecimal } from '@/lib/decimal';
import { AccountPicker } from '@/components/account-picker';

const STATUS_TONE: Record<ProcessorConnectionDto['status'], 'green' | 'amber' | 'neutral' | 'red'> = { active: 'green', pending: 'amber', restricted: 'red', disconnected: 'neutral' };
const CHARGE_TONE: Record<ProcessorChargeDto['status'], 'green' | 'amber' | 'neutral' | 'red' | 'blue'> = { succeeded: 'green', processing: 'blue', pending: 'neutral', failed: 'red', canceled: 'neutral' };

const CHARGE_LABEL: Record<ProcessorChargeDto['status'], string> = { succeeded: 'Succeeded', processing: 'Processing', pending: 'Pending', failed: 'Failed', canceled: 'Canceled' };
const PAYOUT_LABEL: Record<ProcessorPayoutDto['status'], string> = { paid: 'Paid', in_transit: 'On the way', pending: 'Pending', failed: 'Failed', canceled: 'Canceled' };

export function ChargeStatusBadge({ status }: { status: ProcessorChargeDto['status'] }) {
  return <Badge tone={CHARGE_TONE[status]}>{CHARGE_LABEL[status] ?? capitalize(status)}</Badge>;
}

export function PaymentsSettingsView() {
  const { company, isAdmin, features } = useCompany();
  const q = useProcessorConnection();
  const params = useSearchParams();
  const onboarding = params.get('onboarding');
  const link = params.get('link');
  const linkMessage = params.get('message');
  const connect = useConnectProcessor();
  const linkExisting = useLinkProcessor();
  const refresh = useRefreshProcessorConnection();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const router = useRouter();
  const pathname = usePathname();
  const refreshedOnReturn = React.useRef(false);
  const [linkError, setLinkError] = React.useState<string | null>(null);
  const reportedLink = React.useRef(false);

  // Coming back from Stripe's sign-in (OAuth callback): report once, then drop the query.
  React.useEffect(() => {
    if (!link || reportedLink.current) return;
    reportedLink.current = true;
    if (link === 'done') toast.success('Your Stripe account is connected');
    else if (link === 'denied') setLinkError('Stripe access was not granted, so nothing was connected.');
    else setLinkError(linkMessage ?? 'Could not connect the Stripe account');
    router.replace(pathname);
  }, [link, linkMessage, toast, router, pathname]);

  // Coming back from hosted onboarding: pull the account flags once.
  React.useEffect(() => {
    if (onboarding === 'return' && q.data && !refreshedOnReturn.current) {
      refreshedOnReturn.current = true;
      refresh.mutate(undefined, {
        onSuccess: (c) => toast.success(c.chargesEnabled ? 'Stripe is connected' : 'Stripe onboarding is not finished yet'),
        onError: (e) => onError(e, 'Could not refresh the Stripe connection'),
      });
    }
  }, [onboarding, q.data, refresh, toast, onError]);

  const startLink = () =>
    linkExisting.mutate(undefined, {
      onSuccess: (res) => {
        window.location.assign(res.url);
      },
      onError: (e) => onError(e, 'Could not start connecting Stripe'),
    });

  const startOnboarding = () =>
    connect.mutate(undefined, {
      onSuccess: (res) => {
        window.location.assign(res.onboardingUrl);
      },
      onError: (e) => onError(e, 'Could not start Stripe onboarding'),
    });

  return (
    <>
      <PageHeader
        title="Online payments"
        description="Let customers pay invoices by card or bank transfer through Stripe. Payments, fees and payouts are recorded in the books automatically."
        actions={
          q.data && isAdmin ? (
            <Button variant="secondary" onClick={() => refresh.mutate(undefined, { onSuccess: () => toast.success('Connection refreshed'), onError: (e) => onError(e, 'Could not refresh') })} loading={refresh.isPending}>
              <RefreshCw className="size-4" /> Refresh status
            </Button>
          ) : undefined
        }
      />
      {linkError && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>{linkError}</span>
          <button type="button" className="font-medium underline" onClick={() => setLinkError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.isSuccess && q.data === null && !features.onlinePayments && (
        <Card>
          <CardBody>
            <EmptyState title="Online payments are not enabled yet" description="This server does not offer card or bank-debit payments at the moment. Invoices can still carry an external payment link, and everything else works as usual." />
          </CardBody>
        </Card>
      )}
      {q.isSuccess && q.data === null && features.onlinePayments && (
        <Card>
          <CardBody>
            <EmptyState
              title="Stripe is not connected"
              description={
                isAdmin
                  ? `Connect a Stripe account to add a Pay button to your invoices. Stripe handles cards and bank transfers (ACH); Evenbooks records every payment, fee and payout for you. ${feeSentence(company.plan)}`
                  : 'An administrator can connect Stripe from this page.'
              }
              action={
                isAdmin ? (
                  features.stripeAccountLinking ? (
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button onClick={startLink} loading={linkExisting.isPending} disabled={connect.isPending}>
                          I already have a Stripe account
                        </Button>
                        <Button variant="secondary" onClick={startOnboarding} loading={connect.isPending} disabled={linkExisting.isPending}>
                          Create a new Stripe account
                        </Button>
                      </div>
                      <p className="max-w-md text-xs text-stone-500">Signing in to an existing account keeps its history, payouts and bank details. A new account is set up in a few minutes on Stripe.</p>
                    </div>
                  ) : (
                    <Button onClick={startOnboarding} loading={connect.isPending}>
                      Connect Stripe
                    </Button>
                  )
                ) : undefined
              }
            />
          </CardBody>
        </Card>
      )}
      {q.data && (
        <ConnectionPanel
          connection={q.data}
          isAdmin={isAdmin}
          onContinueOnboarding={startOnboarding}
          continuing={connect.isPending}
          onLinkExisting={features.stripeAccountLinking ? startLink : null}
          linking={linkExisting.isPending}
        />
      )}
    </>
  );
}

function feeSentence(plan: 'free' | 'paid'): string {
  return plan === 'paid' ? 'On your plan you pay only Stripe’s own fees; Evenbooks adds nothing.' : 'On the free plan you pay one all-in rate per payment, Stripe’s fee included; upgrade to pay only Stripe’s fees.';
}

function ConnectionPanel({
  connection: c,
  isAdmin,
  onContinueOnboarding,
  continuing,
  onLinkExisting,
  linking,
}: {
  connection: ProcessorConnectionDto;
  isAdmin: boolean;
  onContinueOnboarding: () => void;
  continuing: boolean;
  /** Offered while an account Evenbooks created is still unfinished; null when linking is off. */
  onLinkExisting: (() => void) | null;
  linking: boolean;
}) {
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const bankAccounts = useBankAccounts();
  const update = useUpdateProcessorConnection();
  const disconnect = useDisconnectProcessor();
  const charges = useProcessorCharges({ limit: 25 });
  const payouts = useProcessorPayouts();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  // The linked-balance notice is advice, not state: dismissing it is remembered per browser.
  const noticeKey = `eb-linked-balance-dismissed:${c.id}`;
  const [balanceNoticeDismissed, setBalanceNoticeDismissed] = React.useState(true);
  React.useEffect(() => setBalanceNoticeDismissed(window.localStorage.getItem(noticeKey) === '1'), [noticeKey]);
  const dismissBalanceNotice = () => {
    window.localStorage.setItem(noticeKey, '1');
    setBalanceNoticeDismissed(true);
  };
  const [form, setForm] = React.useState({
    payoutBankAccountId: c.payoutBankAccountId ?? '',
    allowCard: c.allowCard,
    allowAch: c.allowAch,
    allowPartial: c.allowPartial,
    minimumPayment: c.minimumPayment,
    autoPostPayouts: c.autoPostPayouts,
  });
  React.useEffect(() => {
    setForm({ payoutBankAccountId: c.payoutBankAccountId ?? '', allowCard: c.allowCard, allowAch: c.allowAch, allowPartial: c.allowPartial, minimumPayment: c.minimumPayment, autoPostPayouts: c.autoPostPayouts });
  }, [c]);
  const minValid = isValidDecimal(form.minimumPayment) && compareDecimals(form.minimumPayment, '0') >= 0;
  const methodsValid = form.allowCard || form.allowAch;
  const banks = (bankAccounts.data ?? []).filter((b) => b.kind === 'bank' && b.isActive);
  const bankLedgerIds = new Set(banks.map((b) => b.ledgerAccountId));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!minValid || !methodsValid) return;
    update.mutate(
      {
        version: c.version,
        payoutBankAccountId: form.payoutBankAccountId || null,
        allowCard: form.allowCard,
        allowAch: form.allowAch,
        allowPartial: form.allowPartial,
        minimumPayment: form.minimumPayment,
        autoPostPayouts: form.autoPostPayouts,
      },
      { onSuccess: () => toast.success('Payment settings saved'), onError: (err) => onError(err, 'Could not save payment settings') },
    );
  };

  return (
    <div className="space-y-4">
      <Card data-testid="processor-connection" data-status={c.status}>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              Stripe account <Badge tone={STATUS_TONE[c.status]}>{capitalize(c.status)}</Badge>
            </span>
          }
          description={c.displayName ? `${c.displayName} · ${c.providerAccountId}` : c.providerAccountId}
          actions={
            <a href={c.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
              Stripe dashboard <ExternalLink className="size-3.5" aria-hidden />
            </a>
          }
        />
        <CardBody>
          {c.status === 'pending' && (
            <div role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Stripe onboarding is not finished. Customers cannot pay online until Stripe enables charges.
              {isAdmin && (
                <Button className="ml-3" size="sm" onClick={onContinueOnboarding} loading={continuing}>
                  Continue onboarding
                </Button>
              )}
              {isAdmin && onLinkExisting && c.origin === 'created' && (
                <Button className="ml-2" size="sm" variant="secondary" onClick={onLinkExisting} loading={linking}>
                  Use my existing Stripe account instead
                </Button>
              )}
            </div>
          )}
          {c.linkedBalance && Number(c.linkedBalance) !== 0 && !balanceNoticeDismissed && (
            <div role="status" data-testid="linked-balance-notice" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <button type="button" className="float-right ml-3 font-medium underline" onClick={dismissBalanceNotice}>
                Dismiss
              </button>
              When you connected it{c.linkedAt ? ` on ${formatDate(c.linkedAt.slice(0, 10))}` : ''}, this Stripe account already held {formatMoney(c.linkedBalance, cur)} that Evenbooks has not recorded. Stripe pays that money out with your next payouts, which will take the {c.clearingAccountName} account below zero. Record it with a journal entry that debits {c.clearingAccountName} and credits the account where your previous books held it (for example the Stripe or undeposited funds account you imported).
            </div>
          )}
          {c.status === 'restricted' && (
            <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              Stripe has restricted this account{c.lastError ? ` (${c.lastError})` : ''}. Resolve the requirements in the Stripe dashboard.
              {isAdmin && (
                <Button className="ml-3" size="sm" variant="secondary" onClick={onContinueOnboarding} loading={continuing}>
                  Open requirements
                </Button>
              )}
            </div>
          )}
          <dl className="grid grid-cols-2 gap-y-2 text-sm sm:grid-cols-4">
            <dt className="text-stone-500">Charges</dt>
            <dd>{c.chargesEnabled ? 'Enabled' : 'Not yet'}</dd>
            <dt className="text-stone-500">Payouts</dt>
            <dd>{c.payoutsEnabled ? 'Enabled' : 'Not yet'}</dd>
            <dt className="text-stone-500">Stripe balance (in your records)</dt>
            <dd className="tabular" data-testid="clearing-balance">
              {formatMoney(c.clearingBalance, cur)}
            </dd>
            <dt className="text-stone-500">Last event</dt>
            <dd>{c.lastEventAt ? formatDateTime(c.lastEventAt) : '—'}</dd>
            <dt className="text-stone-500">Clearing account</dt>
            <dd>{c.clearingAccountName}</dd>
            <dt className="text-stone-500">Fee account</dt>
            <dd>{c.feeAccountName}</dd>
            <dt className="text-stone-500">Processing cost</dt>
            <dd data-testid="platform-fee">
              {c.platformFee.plan === 'paid'
                ? 'Stripe’s standard rates only; Evenbooks adds nothing (paid plan)'
                : `${c.platformFee.cardTotalPercent}% on cards, ${c.platformFee.achTotalPercent}% on bank transfers, all in (free plan)`}
            </dd>
            <dt className="text-stone-500">How the fee is split</dt>
            <dd>{c.platformFee.plan === 'paid' ? 'Stripe’s fee only' : 'Stripe takes its standard fee; Evenbooks takes the remainder of the all-in rate'}</dd>
          </dl>
          <p className="mt-3 text-xs text-stone-500">
            Each online payment is recorded as a payment from your customer, with Stripe’s fee recorded as an expense. When Stripe sends the money to your bank, that deposit is recorded too, and it matches the line in Bank transactions.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Payment options" description="What customers can do on the public invoice page." />
        <CardBody>
          <form className="space-y-4" onSubmit={save} aria-label="Payment options">
            <div className="grid gap-4 sm:grid-cols-2">
              <Checkbox label="Accept cards" checked={form.allowCard} onChange={(e) => setForm({ ...form, allowCard: e.target.checked })} disabled={!isAdmin} />
              <Checkbox label="Accept bank transfers (ACH)" checked={form.allowAch} onChange={(e) => setForm({ ...form, allowAch: e.target.checked })} disabled={!isAdmin} />
              <Checkbox label="Allow partial payments" checked={form.allowPartial} onChange={(e) => setForm({ ...form, allowPartial: e.target.checked })} disabled={!isAdmin} />
              <Checkbox label="Record Stripe deposits to your bank automatically" checked={form.autoPostPayouts} onChange={(e) => setForm({ ...form, autoPostPayouts: e.target.checked })} disabled={!isAdmin} />
              <Field label="Minimum payment" htmlFor="min-payment" hint="Smallest partial payment a customer may make." error={minValid ? null : 'Enter a non-negative amount'}>
                <Input id="min-payment" inputMode="decimal" value={form.minimumPayment} onChange={(e) => setForm({ ...form, minimumPayment: e.target.value })} disabled={!isAdmin} />
              </Field>
              <Field label="Payout bank account" htmlFor="payout-bank" hint="The bank account Stripe sends your money to. Needed to record deposits automatically.">
                {/* Stripe pays into a bank account; the picker searches their ledger accounts and maps back. */}
                <AccountPicker
                  id="payout-bank"
                  value={banks.find((b) => b.id === form.payoutBankAccountId)?.ledgerAccountId ?? null}
                  onChange={(ledgerId) => setForm({ ...form, payoutBankAccountId: banks.find((b) => b.ledgerAccountId === ledgerId)?.id ?? '' })}
                  allow={(a) => bankLedgerIds.has(a.id)}
                  createType={false}
                  clearable
                  placeholder="Not set — search bank accounts…"
                  disabled={!isAdmin}
                />
              </Field>
            </div>
            {!methodsValid && (
              <p role="alert" className="text-sm text-red-700">
                Enable at least one payment method.
              </p>
            )}
            {isAdmin && (
              <div className="flex flex-wrap justify-between gap-2">
                <Button type="submit" loading={update.isPending} disabled={!minValid || !methodsValid}>
                  Save options
                </Button>
                <Button type="button" variant="danger" onClick={() => setConfirmDisconnect(true)}>
                  Disconnect…
                </Button>
              </div>
            )}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent online payments" description="Newest first. Each completed payment links to the payment in your records." />
        {charges.isPending && <Spinner />}
        {charges.data && charges.data.length === 0 && (
          <CardBody>
            <p className="text-sm text-stone-500">No online payments yet.</p>
          </CardBody>
        )}
        {charges.data && charges.data.length > 0 && (
          <Table aria-label="Online payments">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Invoice</TH>
                <TH className="hidden md:table-cell">Payer</TH>
                <TH>Method</TH>
                <TH numeric>Amount</TH>
                <TH numeric className="hidden sm:table-cell">
                  Fees
                </TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Links</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {charges.data.map((ch) => (
                <TR key={ch.id}>
                  <TD>{formatDateTime(ch.succeededAt ?? ch.createdAt)}</TD>
                  <TD>
                    {ch.invoiceId ? (
                      <Link href={`/invoices/${ch.invoiceId}`} className="text-brand-700 hover:underline">
                        {ch.invoiceNumber ?? 'Invoice'}
                      </Link>
                    ) : (
                      <span className="text-stone-500">{ch.origin === 'external' ? 'Outside Evenbooks' : '—'}</span>
                    )}
                  </TD>
                  <TD className="hidden md:table-cell">{ch.contactName ?? ch.payerEmail ?? '—'}</TD>
                  <TD>{ch.method === 'ach' ? 'ACH' : capitalize(ch.method)}</TD>
                  <TD numeric>{formatMoney(ch.amount, cur)}</TD>
                  <TD numeric className="hidden sm:table-cell">
                    {ch.status === 'succeeded' ? formatMoney(String(Number(ch.processorFee) + Number(ch.platformFee)), cur) : '—'}
                  </TD>
                  <TD>
                    <ChargeStatusBadge status={ch.status} />
                    {Number(ch.amountRefunded) > 0 && (
                      <Badge tone="neutral" className="ml-1">
                        refunded {formatMoney(ch.amountRefunded, cur)}
                      </Badge>
                    )}
                    {Number(ch.amountDisputed) > 0 && (
                      <Badge tone="red" className="ml-1">
                        disputed
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    {ch.paymentId && (
                      <Link href={`/payments/${ch.paymentId}`} className="text-xs text-brand-700 hover:underline">
                        Payment
                      </Link>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Payouts" description="Money Stripe sent to your bank. Each recorded deposit matches its line in Bank transactions." />
        {payouts.isPending && <Spinner />}
        {payouts.data && payouts.data.length === 0 && (
          <CardBody>
            <p className="text-sm text-stone-500">No payouts yet.</p>
          </CardBody>
        )}
        {payouts.data && payouts.data.length > 0 && (
          <Table aria-label="Payouts">
            <THead>
              <TR>
                <TH>Arrival</TH>
                <TH>Stripe id</TH>
                <TH numeric>Amount</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Bank account</TH>
                <TH>
                  <span className="sr-only">Links</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {payouts.data.map((p) => (
                <TR key={p.id}>
                  <TD>{formatDate(p.arrivalDate)}</TD>
                  <TD className="font-mono text-xs">{p.providerPayoutId}</TD>
                  <TD numeric>{formatMoney(p.amount, cur)}</TD>
                  <TD>
                    <Badge tone={p.status === 'paid' ? 'green' : p.status === 'failed' || p.status === 'canceled' ? 'red' : 'amber'}>{PAYOUT_LABEL[p.status] ?? capitalize(p.status)}</Badge>
                    {p.status === 'paid' && !p.journalEntryId && <p className="mt-0.5 text-xs text-stone-500">Not recorded yet. Set the payout bank account above to record deposits.</p>}
                  </TD>
                  <TD className="hidden md:table-cell">{p.bankAccountName ?? '—'}</TD>
                  <TD className="text-right">
                    {p.journalEntryId && (
                      <Link href={`/journal/${p.journalEntryId}`} className="text-xs text-brand-700 hover:underline">
                        Entry
                      </Link>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title="Disconnect Stripe?"
        description="The Pay button disappears from your invoices. Your Stripe account is unaffected, and any payouts or refunds Stripe still reports are recorded so the books stay complete."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(
                  { version: c.version },
                  {
                    onSuccess: () => {
                      setConfirmDisconnect(false);
                      toast.success('Stripe disconnected');
                    },
                    onError: (err) => onError(err, 'Could not disconnect'),
                  },
                )
              }
            >
              Disconnect
            </Button>
          </>
        }
      >
        <p className="text-sm text-stone-700">You can connect again at any time; the same clearing and fee accounts are reused.</p>
      </Dialog>
    </div>
  );
}
