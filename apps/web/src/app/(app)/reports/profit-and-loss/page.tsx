import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { ProfitAndLossView } from './view';

export const metadata = { title: 'Profit & Loss' };

export default function ProfitAndLossPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ProfitAndLossView />
    </Suspense>
  );
}
