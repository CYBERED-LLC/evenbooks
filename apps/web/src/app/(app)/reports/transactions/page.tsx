import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { TransactionsReportView } from './view';

export const metadata = { title: 'All activity' };

export default function TransactionsReportPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TransactionsReportView />
    </Suspense>
  );
}
