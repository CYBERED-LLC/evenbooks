import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { TrialBalanceView } from './view';

export const metadata = { title: 'Trial balance' };

export default function TrialBalancePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TrialBalanceView />
    </Suspense>
  );
}
