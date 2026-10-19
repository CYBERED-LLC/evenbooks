'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorNotice, Spinner } from '@/components/ui/card';
import { useCompany } from '@/components/company-context';
import { purchaseDetailOptions } from '@/lib/queries/purchases';
import { PurchaseForm } from '../purchase-form';

/** New purchase, optionally started from an existing one (`?copyFrom=<id>`, the Duplicate action). */
export function NewPurchaseView({ copyFrom }: { copyFrom?: string }) {
  const { company } = useCompany();
  const source = useQuery({ ...purchaseDetailOptions(company.id, copyFrom ?? ''), enabled: !!copyFrom });
  if (!copyFrom) return <PurchaseForm />;
  if (source.isPending) return <Spinner />;
  if (source.isError) return <ErrorNotice error={source.error} onRetry={() => source.refetch()} />;
  return <PurchaseForm key={source.data.id} copyOf={source.data} />;
}
