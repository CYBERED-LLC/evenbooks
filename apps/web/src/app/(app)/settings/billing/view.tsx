'use client';
import * as React from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, CardHeader, PageHeader, Spinner } from '@/components/ui/card';
import { useCompany } from '@/components/company-context';
import { PLANS } from '@/lib/marketing-content';

/**
 * The company's plan. Subscriptions live in Clerk Billing (organization plans); the app reads
 * the plan on each signed-in request (`has({ plan })`), so a change shows here on the next load.
 */
export function BillingSettingsView() {
  const { company, authMode, isAdmin, memberLimit } = useCompany();
  const current = PLANS.find((p) => p.id === company.plan) ?? PLANS.find((p) => p.id === 'free')!;
  return (
    <>
      <PageHeader title="Plan and billing" description="One paid plan at one price. Change or cancel it whenever you like." />
      <Card className="mb-6">
        <CardHeader title={<span className="inline-flex items-center gap-2">Current plan <Badge tone={company.plan === 'paid' ? 'green' : 'neutral'}>{current.name}</Badge></span>} />
        <CardBody>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-stone-600">People</dt>
              <dd className="font-medium text-stone-900">{memberLimit === 1 ? '1 person' : memberLimit ? `Up to ${memberLimit} people` : current.members}</dd>
              <dd>
                <Link href="/settings/team" className="text-brand-700 hover:underline">
                  Invite someone
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-stone-600">Fee on card payments</dt>
              <dd className="font-medium text-stone-900">{current.cardFee}</dd>
            </div>
            <div>
              <dt className="text-stone-600">Fee on bank transfers</dt>
              <dd className="font-medium text-stone-900">{current.achFee}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      {authMode !== 'clerk' ? (
        <p className="text-sm text-stone-600">Changing plans needs Clerk sign-in, which development sign-in doesn&rsquo;t use.</p>
      ) : isAdmin ? (
        <ClerkPricingTable />
      ) : (
        <p className="text-sm text-stone-600">Only admins can change the plan. Ask an admin of this company.</p>
      )}
    </>
  );
}

function ClerkPricingTable() {
  const [Comp, setComp] = React.useState<React.ComponentType<Record<string, unknown>> | null>(null);
  React.useEffect(() => {
    void import('@clerk/nextjs').then((m) => setComp(() => m.PricingTable as unknown as React.ComponentType<Record<string, unknown>>));
  }, []);
  if (!Comp) return <Spinner label="Loading plans" />;
  return <Comp for="organization" newSubscriptionRedirectUrl="/settings/billing" />;
}
