import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { MappingsView } from './view';

export const metadata = { title: 'Schedule C mappings' };

export default function MappingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <MappingsView />
    </Suspense>
  );
}
