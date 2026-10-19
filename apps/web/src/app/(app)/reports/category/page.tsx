import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { CategoryReportView } from './view';

export const metadata = { title: 'Category report' };

export default function CategoryReportPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CategoryReportView />
    </Suspense>
  );
}
