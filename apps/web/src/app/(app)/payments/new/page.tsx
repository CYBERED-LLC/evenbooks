import { Suspense } from 'react';
import { Spinner } from '@/components/ui/card';
import { PaymentForm } from './payment-form';

export const metadata = { title: 'Record payment' };

export default function NewPaymentPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PaymentForm />
    </Suspense>
  );
}
