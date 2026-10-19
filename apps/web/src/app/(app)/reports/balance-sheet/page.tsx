import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { BalanceSheetView } from './view';

export const metadata = { title: 'Balance sheet' };

export default function BalanceSheetPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <BalanceSheetView />
    </Suspense>
  );
}
