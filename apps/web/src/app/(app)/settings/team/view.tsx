'use client';
import * as React from 'react';
import Link from 'next/link';
import { Card, CardBody, CardHeader, PageHeader, Spinner } from '@/components/ui/card';
import { useCompany } from '@/components/company-context';

/**
 * Who can work in these books. People are Clerk organization members, so with Clerk sign-in
 * this shows Clerk's own members and invitations screen (it says "company", see
 * lib/clerk-appearance.ts); Clerk enforces the plan's member limit when someone is invited.
 */
export function TeamSettingsView() {
  const { authMode, isAdmin, memberLimit, company, userName, role } = useCompany();
  const free = company.plan === 'free' || memberLimit <= 1;
  return (
    <>
      <PageHeader title="Team" description="Invite people to these books and see who has access. Admins can change settings and invite people; members keep the books." />
      <Card className="mb-6" data-testid="team-limit">
        <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-stone-700">
            {memberLimit === 1 ? 'Your plan is for 1 person.' : `Your plan allows up to ${memberLimit} people.`}
            {free && ' The paid plan lets you invite up to 20 people, such as a bookkeeper or your accountant.'}
          </p>
          {free && isAdmin && (
            <Link href="/settings/billing" className="font-medium text-brand-700 hover:underline">
              See plans
            </Link>
          )}
        </CardBody>
      </Card>
      {authMode === 'clerk' ? (
        <ClerkMembers />
      ) : (
        <Card>
          <CardHeader title="People" />
          <CardBody className="space-y-2 text-sm text-stone-700">
            <p>
              {userName ?? 'You'} · {role === 'admin' ? 'Admin' : 'Member'}
            </p>
            <p className="text-stone-500">Team management is available when signed in with Clerk. Development sign-in uses fixed test people instead.</p>
          </CardBody>
        </Card>
      )}
    </>
  );
}

function ClerkMembers() {
  const [Comp, setComp] = React.useState<React.ComponentType<Record<string, unknown>> | null>(null);
  React.useEffect(() => {
    void import('@clerk/nextjs').then((m) => setComp(() => m.OrganizationProfile as unknown as React.ComponentType<Record<string, unknown>>));
  }, []);
  if (!Comp) return <Spinner label="Loading your team" />;
  return <Comp routing="hash" appearance={{ elements: { rootBox: 'w-full', cardBox: 'w-full max-w-none shadow-none border border-stone-200' } }} />;
}
