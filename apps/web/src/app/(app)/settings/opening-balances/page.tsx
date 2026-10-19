import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { OpeningBalancesView } from './view';

export const metadata = { title: 'Opening balances' };

export default function OpeningBalancesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <OpeningBalancesView />
    </Suspense>
  );
}
