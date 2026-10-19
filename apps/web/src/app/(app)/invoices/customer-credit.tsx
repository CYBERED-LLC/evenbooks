'use client';
import Link from 'next/link';
import type { CustomerBalanceDto } from '@evenbooks/contracts';
import { Term } from '@/components/ui/term';
import { useCustomerBalance } from '@/lib/queries/invoices';
import { compareDecimals, sumDecimals } from '@/lib/decimal';
import { formatMoney } from '@/lib/format';

/** Credit a customer can still use: unapplied payments (not refundable deposits) and open credit notes. */
export function customerCredit(b: CustomerBalanceDto | undefined) {
  const payments = (b?.unappliedPayments ?? []).filter((p) => !p.isRefundableDeposit && compareDecimals(p.unappliedAmount, '0') > 0);
  const creditNotes = (b?.openCreditNotes ?? []).filter((c) => compareDecimals(c.balance, '0') > 0);
  const total = sumDecimals([...payments.map((p) => p.unappliedAmount), ...creditNotes.map((c) => c.balance)]);
  return { payments, creditNotes, total, any: payments.length + creditNotes.length > 0 };
}

function fromWhere(payments: number, creditNotes: number): string {
  if (payments && creditNotes) return 'from earlier payments and credit notes';
  if (payments) return payments === 1 ? 'from an earlier payment' : 'from earlier payments';
  return creditNotes === 1 ? 'from a credit note' : 'from credit notes';
}

const MAX_LINKS = 3;

/**
 * "Acme has $200 credit from an earlier payment." On a draft it says the credit can be used
 * once the invoice is issued; on an issued invoice (`invoiceId`) each source links to its
 * Apply dialog with this invoice filled in.
 */
export function CustomerCreditNotice({ contactId, customerName, currency, invoiceId }: { contactId: string | null; customerName: string | null | undefined; currency: string; invoiceId?: string }) {
  const balance = useCustomerBalance(contactId);
  const credit = customerCredit(balance.data);
  if (!contactId || !credit.any) return null;
  const who = customerName || 'This customer';
  const sources = [
    ...credit.payments.map((p) => ({ key: `p-${p.id}`, href: `/payments/${p.id}`, label: `${formatMoney(p.unappliedAmount, currency)} payment` })),
    ...credit.creditNotes.map((c) => ({ key: `c-${c.id}`, href: `/credit-notes/${c.id}`, label: `${formatMoney(c.balance, currency)} credit note ${c.number}` })),
  ];
  return (
    <div role="status" data-testid="customer-credit" className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
      <p>
        {who} has <span className="font-semibold">{formatMoney(credit.total, currency)}</span> <Term id="unapplied">credit</Term> {fromWhere(credit.payments.length, credit.creditNotes.length)}.{' '}
        {invoiceId ? 'Use it on this invoice:' : 'Once this invoice is issued, you can use it from the invoice page.'}
      </p>
      {invoiceId && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {sources.slice(0, MAX_LINKS).map((s) => (
            <li key={s.key}>
              <Link href={`${s.href}?apply=${invoiceId}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
                Apply the {s.label}
              </Link>
            </li>
          ))}
          {sources.length > MAX_LINKS && (
            <li>
              <Link href={`/contacts/${contactId}`} className="text-brand-700 underline-offset-2 hover:underline">
                See all {sources.length}
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
