import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { OutstandingInvoicesView } from './view';

export const metadata = { title: 'Outstanding invoices' };

export default function OutstandingInvoicesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <OutstandingInvoicesView />
    </Suspense>
  );
}
