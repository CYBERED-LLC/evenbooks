import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { ScheduleCView } from './view';

export const metadata = { title: 'Schedule C summary' };

export default function ScheduleCPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ScheduleCView />
    </Suspense>
  );
}
