import { Suspense } from 'react';
import { PageHeader } from '@/components/ui/card';
import { ReportsIndex } from './reports-index';

export const metadata = { title: 'Reports' };

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="See how the business is doing and get what your accountant asks for. Each report opens on the period you last used and can be printed or downloaded."
      />
      <Suspense>
        <ReportsIndex />
      </Suspense>
    </>
  );
}
