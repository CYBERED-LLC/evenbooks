'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { visibleSettingsGroups } from '@/components/nav-config';
import { useCompany } from '@/components/company-context';

/**
 * Every settings page gets a grouped side nav (a scrolling strip on small screens)
 * with the current page marked. The settings index is the overview, so it has none.
 */
export function SettingsFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAdmin } = useCompany();
  if (pathname === '/settings') return <>{children}</>;
  return (
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="Settings" className="mb-6 print:hidden lg:mb-0">
        <Link href="/settings" className="mb-3 inline-flex min-h-10 items-center gap-1 text-sm text-stone-500 hover:text-stone-800 lg:min-h-0">
          <ArrowLeft className="size-4" aria-hidden /> All settings
        </Link>
        <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-1 lg:sticky lg:top-6 lg:mx-0 lg:block lg:space-y-4 lg:overflow-visible lg:px-0">
          {visibleSettingsGroups(isAdmin).map((g) => (
            <div key={g.label} className="shrink-0">
              <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-stone-500" aria-hidden>
                {g.label}
              </p>
              <ul aria-label={g.label} className="flex gap-1 lg:block lg:space-y-0.5">
                {g.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(item.href + '/');
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-10 items-center whitespace-nowrap rounded-md px-2 py-1.5 text-sm lg:min-h-0',
                          active ? 'bg-brand-50 font-medium text-brand-800' : 'text-stone-700 hover:bg-stone-100',
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
