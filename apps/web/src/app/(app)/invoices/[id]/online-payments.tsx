'use client';
import * as React from 'react';
import Link from 'next/link';
import type { InvoiceDto, ProcessorChargeDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, Spinner } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useCompany } from '@/components/company-context';
import { useProcessorCharges, useProcessorConnection, useRefundProcessorCharge } from '@/lib/queries/processor';
import { useUpdateInvoice } from '@/lib/queries/invoices';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { capitalize, formatDateTime, formatMoney } from '@/lib/format';
import { isValidDecimal } from '@/lib/decimal';
import { ChargeStatusBadge } from '../../settings/payments/view';

/**
 * Online payments card on the invoice page: what customers paid through Stripe,
 * refunds through the processor, and the per-invoice Pay-button switch.
 */
export function OnlinePaymentsCard({ invoice }: { invoice: InvoiceDto }) {
  const { company, isAdmin } = useCompany();
  const cur = company.baseCurrency;
  const conn = useProcessorConnection();
  const charges = useProcessorCharges({ invoiceId: invoice.id, limit: 50 }, Boolean(conn.data));
  const update = useUpdateInvoice(invoice.id);
  const refund = useRefundProcessorCharge();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const [refunding, setRefunding] = React.useState<ProcessorChargeDto | null>(null);
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');
  const idem = React.useRef(idempotencyKey());

  if (conn.isPending || conn.data === null || conn.isError) return null; // no processor connected: nothing to show
  const list = charges.data ?? [];
  const canToggle = invoice.status === 'issued' || invoice.status === 'draft';
  const amountValid = isValidDecimal(amount) && Number(amount) > 0 && refunding !== null && Number(amount) <= Number(refunding.refundableAmount);

  const openRefund = (ch: ProcessorChargeDto) => {
    setRefunding(ch);
    setAmount(ch.refundableAmount);
    setReason('');
    idem.current = idempotencyKey();
  };

  return (
    <>
      <Card data-testid="online-payments-card">
        <CardHeader
          title="Online payments"
          description={invoice.onlinePaymentsDisabled ? 'The Pay button is hidden on this invoice.' : 'Customers can pay this invoice from its public link.'}
          actions={
            canToggle ? (
              <Button
                variant="secondary"
                size="sm"
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    { version: invoice.version, onlinePaymentsDisabled: !invoice.onlinePaymentsDisabled },
                    { onSuccess: () => toast.success(invoice.onlinePaymentsDisabled ? 'Pay button enabled' : 'Pay button hidden'), onError: (e) => onError(e, 'Could not update the invoice') },
                  )
                }
              >
                {invoice.onlinePaymentsDisabled ? 'Show Pay button' : 'Hide Pay button'}
              </Button>
            ) : undefined
          }
        />
        {charges.isPending && <Spinner />}
        {charges.data && list.length === 0 && (
          <CardBody>
            <p className="text-sm text-stone-500">No online payment attempts yet.</p>
          </CardBody>
        )}
        {list.length > 0 && (
          <Table aria-label="Online payments">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Method</TH>
                <TH numeric>Amount</TH>
                <TH numeric className="hidden sm:table-cell">
                  Fees
                </TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {list.map((ch) => (
                <TR key={ch.id} data-testid="online-payment-row" data-status={ch.status}>
                  <TD>{formatDateTime(ch.succeededAt ?? ch.createdAt)}</TD>
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
                    {ch.failureMessage && <p className="text-xs text-red-700">{ch.failureMessage}</p>}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      {ch.paymentId && (
                        <Link href={`/payments/${ch.paymentId}`} className="text-xs text-brand-700 hover:underline">
                          Payment
                        </Link>
                      )}
                      {isAdmin && ch.status === 'succeeded' && Number(ch.refundableAmount) > 0 && (
                        <Button variant="ghost" size="sm" onClick={() => openRefund(ch)}>
                          Refund…
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog
        open={refunding !== null}
        onClose={() => setRefunding(null)}
        title="Refund online payment"
        description={refunding ? `Up to ${formatMoney(refunding.refundableAmount, cur)} can be returned to the customer through Stripe. Stripe keeps its processing fee; the Evenbooks platform fee is returned proportionally.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRefunding(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={refund.isPending}
              disabled={!amountValid || !reason.trim()}
              onClick={() =>
                refunding &&
                refund.mutate(
                  { id: refunding.id, input: { version: refunding.version, amount, reason: reason.trim(), idempotencyKey: idem.current } },
                  {
                    onSuccess: () => {
                      setRefunding(null);
                      toast.success('Refund sent through Stripe and recorded');
                    },
                    onError: (e) => onError(e, 'Refund failed'),
                  },
                )
              }
            >
              Refund
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Amount" htmlFor="refund-amount" required error={amount && !amountValid ? 'Enter an amount within the refundable balance' : null}>
            <Input id="refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Reason" htmlFor="refund-reason" required>
            <Textarea id="refund-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="text-xs text-stone-500">The refunded portion reopens on the invoice; the rest of the payment stays applied.</p>
        </div>
      </Dialog>
    </>
  );
}
