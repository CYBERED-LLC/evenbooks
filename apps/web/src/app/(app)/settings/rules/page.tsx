import { Suspense } from 'react';
import { RulesView } from './view';

export const metadata = { title: 'Categorization rules' };

export default function RulesPage() {
  return (
    <Suspense>
      <RulesView />
    </Suspense>
  );
}
