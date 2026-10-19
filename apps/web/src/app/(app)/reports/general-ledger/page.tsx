import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { GeneralLedgerView } from './view';

export const metadata = { title: 'General ledger' };

export default function GeneralLedgerPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <GeneralLedgerView />
    </Suspense>
  );
}
