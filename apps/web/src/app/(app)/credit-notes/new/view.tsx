'use client';
import { ErrorNotice, Spinner } from '@/components/ui/card';
import { useInvoice } from '@/lib/queries/invoices';
import { CreditNoteForm } from '../credit-note-form';

/** Waits for the source invoice (when given) so the form can start prefilled instead of syncing state later. */
export function NewCreditNoteView({ invoiceId, contactId }: { invoiceId?: string; contactId?: string }) {
  const invoice = useInvoice(invoiceId ?? '', !!invoiceId);
  if (invoiceId) {
    if (invoice.isPending) return <Spinner />;
    if (invoice.isError) return <ErrorNotice error={invoice.error} onRetry={() => invoice.refetch()} />;
    return <CreditNoteForm fromInvoice={invoice.data} />;
  }
  return <CreditNoteForm contactId={contactId} />;
}
