import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { InboxView } from './view';

export const metadata = { title: 'Bank transactions' };

export default function BankingInboxPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <InboxView />
    </Suspense>
  );
}
