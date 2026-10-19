'use client';
import { ErrorNotice, Spinner } from '@/components/ui/card';
import { useInvoice } from '@/lib/queries/invoices';
import { useInvoicePresentation } from '@/lib/queries/invoice-presentation';
import { InvoiceForm } from '../invoice-form';

/** New invoice, optionally started from an existing one (`?copyFrom=<id>`, the Duplicate action) or for a customer (`?contactId=`). */
export function NewInvoiceView({ copyFrom, contactId }: { copyFrom?: string; contactId?: string }) {
  const defaults = useInvoicePresentation();
  const source = useInvoice(copyFrom ?? '', !!copyFrom);
  if (!copyFrom) {
    if (defaults.isPending) return <Spinner />;
    if (defaults.isError) return <ErrorNotice error={defaults.error} onRetry={()=>defaults.refetch()} />;
    return <InvoiceForm contactId={contactId} defaults={defaults.data?.branding} />;
  }
  if (source.isPending) return <Spinner />;
  if (source.isError) return <ErrorNotice error={source.error} onRetry={() => source.refetch()} />;
  return <InvoiceForm key={source.data.id} copyOf={source.data} />;
}
