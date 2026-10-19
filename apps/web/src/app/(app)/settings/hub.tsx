'use client';
import Link from 'next/link';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { visibleSettingsGroups } from '@/components/nav-config';
import { useCompany } from '@/components/company-context';

export function SettingsHub() {
  const { isAdmin } = useCompany();
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-8">
        {visibleSettingsGroups(isAdmin).map((g) => (
          <section key={g.label} aria-labelledby={`settings-${g.label}`}>
            <h2 id={`settings-${g.label}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
              {g.label}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((s) => (
                <Link key={s.href} href={s.href} className="block rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <Card className="h-full hover:border-brand-300">
                    <CardBody>
                      <h3 className="font-semibold text-stone-900">{s.label}</h3>
                      <p className="mt-1 text-sm text-stone-600">{s.description}</p>
                    </CardBody>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
