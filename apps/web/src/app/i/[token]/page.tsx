import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PublicInvoiceDto } from '@evenbooks/contracts';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { PayButton } from './pay-button';

export const metadata: Metadata = { title: 'Invoice', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** "0.0825" -> "8.25%" without float math (string digit shift). */
function percent(fraction: string): string {
  if (!/^\d+(\.\d+)?$/.test(fraction)) return fraction;
  const [intPart = '0', fracPart = ''] = fraction.split('.');
  const digits = fracPart.padEnd(2, '0');
  const int = (intPart + digits.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const rest = digits.slice(2).replace(/0+$/, '');
  return `${int}${rest ? '.' + rest : ''}%`;
}

function AddressLines({ a }: { a: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string } | undefined }) {
  if (!a) return null;
  const cityLine = `${[a.city, a.region].filter(Boolean).join(', ')}${a.postalCode ? ` ${a.postalCode}` : ''}`.trim();
  return (
    <>
      {a.line1 && <p>{a.line1}</p>}
      {a.line2 && <p>{a.line2}</p>}
      {cityLine && <p>{cityLine}</p>}
      {a.country && <p>{a.country}</p>}
    </>
  );
}

/**
 * Customer-facing invoice reached by a revocable token. No session, no app
 * shell. The API already limits the payload to customer-safe fields.
 */
export default async function PublicInvoicePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const { token } = await params;
  const { checkout } = await searchParams;
  const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/public/invoices/${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error('This invoice could not be loaded right now.');
  const inv = (await res.json()) as PublicInvoiceDto;
  const cur = inv.currency;
  const paid = inv.status === 'paid';
  const voided = inv.status === 'void';

  return (
    <main className="min-h-full bg-stone-100 px-4 py-8 text-stone-900 print:bg-white print:p-0">
      <article style={{ borderTop: `5px solid ${inv.branding?.accentColor ?? '#1d4ed8'}` }} className="mx-auto max-w-3xl rounded-lg border border-stone-200 bg-white p-6 shadow-sm sm:p-10 print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="text-sm text-stone-700">
            <>{inv.branding?.logo && <img src={inv.branding.logo} alt={inv.company.name} className="mb-3 max-h-16 max-w-36 object-contain" />}<p style={{ color: inv.branding?.layout === 'modern' ? inv.branding.accentColor : undefined }} className="text-lg font-semibold text-stone-900">{inv.company.name}</p></>
            <AddressLines a={inv.company.address} />
            {inv.company.email && <p className="mt-1">{inv.company.email}</p>}
            {inv.company.phone && <p>{inv.company.phone}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-2xl font-semibold tracking-tight">Invoice</h1>
            <p className="font-mono text-sm text-stone-600" data-testid="public-invoice-number">
              {inv.number}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-stone-500">Issued</dt>
              <dd>{formatDate(inv.issueDate)}</dd>
              <dt className="text-stone-500">Due</dt>
              <dd className={inv.isOverdue ? 'font-medium text-red-700' : undefined}>{formatDate(inv.dueDate)}</dd>
            </dl>
          </div>
        </header>

        {voided && (
          <div role="status" className="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            This invoice has been voided and is no longer payable.
          </div>
        )}
        {paid && (
          <div role="status" className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Paid in full. Thank you.
          </div>
        )}
        {inv.isOverdue && !paid && !voided && (
          <div role="status" className="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            This invoice is overdue. Payment was due {formatDate(inv.dueDate)}.
          </div>
        )}
        {checkout === 'success' && !paid && !voided && (
          <div role="status" className="mt-6 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" data-testid="checkout-return">
            Thank you. Your payment is being confirmed; this page updates as soon as the payment provider reports it.
          </div>
        )}
        {checkout === 'cancel' && !paid && !voided && (
          <div role="status" className="mt-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
            The payment was cancelled. You can try again below.
          </div>
        )}

        <section className="mt-8 text-sm text-stone-700">
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Bill to</p>
          <p className="mt-1 font-medium text-stone-900">{inv.customer.name}</p>
          <AddressLines a={inv.customer.address} />
          {inv.customer.email && <p className="mt-1">{inv.customer.email}</p>}
        </section>

        <table className="mt-8 w-full border-collapse text-sm">
          <thead className="border-b border-stone-300 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
            <tr>
              <th scope="col" className="py-2 pr-3">
                Description
              </th>
              {inv.branding?.showQuantity !== false && <th scope="col" className="py-2 px-3 text-right">
                Qty
              </th>}
              {inv.branding?.showUnitPrice !== false && <th scope="col" className="py-2 px-3 text-right">
                Unit price
              </th>}
              {inv.branding?.showLineTax !== false && <th scope="col" className="py-2 px-3 text-right">Tax</th>}
              <th scope="col" className="py-2 pl-3 text-right">
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td className="py-2 pr-3 align-top">
                  {l.description}
                  {!isZeroDecimal(l.lineDiscount) && <p className="text-xs text-stone-500">Discount −{formatMoney(l.lineDiscount, cur)}</p>}
                </td>
                {inv.branding?.showQuantity !== false && <td className="tabular py-2 px-3 text-right align-top">{l.quantity}</td>}
                {inv.branding?.showUnitPrice !== false && <td className="tabular py-2 px-3 text-right align-top">{formatMoney(l.unitPrice, cur)}</td>}
                {inv.branding?.showLineTax !== false && <td className="tabular py-2 px-3 text-right align-top">{formatMoney(l.taxTotal, cur)}</td>}
                <td className="tabular py-2 pl-3 text-right align-top">{formatMoney(l.net, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 flex flex-col-reverse gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm text-sm text-stone-700">
            {inv.branding?.paymentInstructions && <p className="mb-3 whitespace-pre-wrap">{inv.branding.paymentInstructions}</p>}
            {inv.memo && <p className="whitespace-pre-wrap">{inv.memo}</p>}
            {inv.onlinePayment && !paid && !voided && <PayButton token={token} currency={cur} options={inv.onlinePayment} accentColor={inv.branding?.accentColor} />}
            {inv.paymentUrl && !paid && !voided && (
              <a
                style={{ backgroundColor: inv.branding?.accentColor }}
                href={inv.paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex h-11 items-center justify-center rounded-md bg-brand-600 px-5 text-base font-medium text-white shadow-sm hover:bg-brand-700 print:hidden"
              >
                Pay now
              </a>
            )}
          </div>
          <dl className="tabular w-full space-y-1 text-sm sm:max-w-xs">
            <div className="flex justify-between">
              <dt className="text-stone-500">Subtotal</dt>
              <dd>{formatMoney(inv.subtotal, cur)}</dd>
            </div>
            {!isZeroDecimal(inv.discountTotal) && (
              <div className="flex justify-between">
                <dt className="text-stone-500">Discounts</dt>
                <dd>−{formatMoney(inv.discountTotal, cur)}</dd>
              </div>
            )}
            {inv.taxSummary.map((t, i) => (
              <div key={i} className="flex justify-between">
                <dt className="text-stone-500">
                  {t.name} ({percent(t.rate)})
                </dt>
                <dd>{formatMoney(t.amount, cur)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-stone-300 pt-1 font-semibold">
              <dt>Total</dt>
              <dd data-testid="public-invoice-total">{formatMoney(inv.total, cur)}</dd>
            </div>
            {!voided && (
              <>
                {!isZeroDecimal(inv.amountSettled) && (
                  <div className="flex justify-between">
                    <dt className="text-stone-500">Paid</dt>
                    <dd>−{formatMoney(inv.amountSettled, cur)}</dd>
                  </div>
                )}
                <div className="flex justify-between text-base font-semibold">
                  <dt>Balance due</dt>
                  <dd data-testid="public-invoice-balance">{formatMoney(inv.balanceDue, cur)}</dd>
                </div>
              </>
            )}
          </dl>
        </div>

        <footer className="mt-10 border-t border-stone-200 pt-4 text-xs text-stone-500">
          {inv.footer && <p className="whitespace-pre-wrap text-sm text-stone-700">{inv.footer}</p>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p>
              {inv.number} · {inv.company.name}
            </p>
            {inv.pdfAvailable && (
              <a style={{ color: inv.branding?.accentColor }} href={`/api/public/invoices/${encodeURIComponent(token)}/pdf`} className="font-medium text-brand-700 underline print:hidden">
                Download PDF
              </a>
            )}
          </div>
        </footer>
      </article>
    </main>
  );
}
