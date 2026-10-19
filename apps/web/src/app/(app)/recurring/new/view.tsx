'use client';
import { ErrorNotice, Spinner } from '@/components/ui/card';
import { useInvoice } from '@/lib/queries/invoices';
import { ScheduleForm } from '../schedule-form';

/** New schedule, optionally repeating an invoice (`?invoiceId=<id>`, the invoice page's "Make recurring"). */
export function NewScheduleView({ invoiceId }: { invoiceId?: string }) {
  const source = useInvoice(invoiceId ?? '', !!invoiceId);
  if (!invoiceId) return <ScheduleForm />;
  if (source.isPending) return <Spinner />;
  if (source.isError) return <ErrorNotice error={source.error} onRetry={() => source.refetch()} />;
  return <ScheduleForm key={source.data.id} fromInvoice={source.data} />;
}
