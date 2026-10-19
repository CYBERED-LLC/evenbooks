'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronRight, Keyboard, Menu, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCompany } from '@/components/company-context';
import { CompanySwitcher } from '@/components/company-switcher';
import { LazyClerk, PortalContainerContext } from '@/components/clerk-portal';
import { Wordmark } from '@/components/brand/mark';
import { AppearanceToggle } from '@/components/appearance-toggle';
import { CommandPalette } from '@/components/command-palette';
import { ShortcutsDialog } from '@/components/shortcuts-dialog';
import { NAV_GROUPS, NAV_ITEMS, isNavActive } from '@/components/nav-config';
import { useHotkeys, useModKeyLabel } from '@/lib/use-hotkeys';
import { useBankAccounts } from '@/lib/queries/banking';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { company, userName, role, authMode } = useCompany();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  // The Advanced group (journal, chart of accounts, history) starts folded; remember the choice.
  const [advancedOpen, setAdvancedOpenState] = React.useState(false);
  React.useEffect(() => {
    setAdvancedOpenState(window.localStorage.getItem('eb-nav-advanced') === 'open');
  }, []);
  const setAdvancedOpen = (open: boolean) => {
    setAdvancedOpenState(open);
    window.localStorage.setItem('eb-nav-advanced', open ? 'open' : 'closed');
  };
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const mod = useModKeyLabel();

  React.useEffect(() => setDrawerOpen(false), [pathname]);

  const bank = useBankAccounts();
  const unreviewed = (bank.data ?? []).reduce((n, b) => n + (b.isActive ? (b.unreviewedCount ?? 0) : 0), 0);

  const hotkeys = React.useMemo(() => {
    const map: Record<string, () => void> = {
      'mod+k': () => {
        setDrawerOpen(false);
        setPaletteOpen((o) => !o);
      },
      '?': () => setHelpOpen(true),
    };
    for (const item of NAV_ITEMS) if (item.shortcut) map[item.shortcut] = () => router.push(item.href);
    return map;
  }, [router]);
  useHotkeys(hotkeys);

  const openPalette = () => {
    setDrawerOpen(false);
    setPaletteOpen(true);
  };

  const searchButton = (
    <button
      type="button"
      onClick={openPalette}
      aria-label={`Search and jump (${mod}+K)`}
      aria-keyshortcuts="Control+K Meta+K"
      className="flex h-10 w-full items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-500 hover:border-stone-400 hover:text-stone-700 lg:h-9"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded border border-stone-200 bg-stone-50 px-1.5 font-sans text-xs text-stone-500">{mod === '⌘' ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );

  const sidebar = (
    <nav aria-label="Primary" className="flex h-full flex-col">
      <div className="px-4 py-4">
        <Link href="/dashboard" className="inline-flex rounded-md focus-visible:outline-2" aria-label="Evenbooks home">
          <Wordmark />
        </Link>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <CompanySwitcher />
        {searchButton}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {NAV_GROUPS.map((group, gi) => {
          const containsActive = group.items.some((item) => isNavActive(item.href, pathname));
          const expanded = !group.collapsible || containsActive || advancedOpen;
          const listId = `nav-group-${gi}`;
          return (
            <div key={group.label ?? gi} className={cn(gi > 0 && 'mt-3')}>
              {group.label && group.collapsible ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  disabled={containsActive}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  className="flex min-h-10 w-full items-center gap-1 rounded-md px-3 pb-1 text-xs font-medium uppercase tracking-wide text-stone-500 hover:text-stone-800 disabled:cursor-default disabled:hover:text-stone-500 lg:min-h-0"
                >
                  <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} aria-hidden />
                  {group.label}
                </button>
              ) : (
                group.label && (
                  <p aria-hidden className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-stone-500">
                    {group.label}
                  </p>
                )
              )}
              {expanded && (
              <ul id={listId} className="space-y-0.5" aria-label={group.label ?? undefined}>
                {group.items.map((item) => {
                  const active = isNavActive(item.href, pathname);
                  const badge = item.href === '/banking/inbox' && unreviewed > 0 ? unreviewed : null;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-10 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium lg:min-h-0',
                          active ? 'bg-brand-50 text-brand-800' : 'text-stone-700 hover:bg-stone-100',
                        )}
                      >
                        <item.icon className="size-4 shrink-0" aria-hidden />
                        <span className="flex-1">{item.label}</span>
                        {badge !== null && (
                          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold tabular text-brand-800" data-testid="unreviewed-badge">
                            {badge > 999 ? '999+' : badge}
                            <span className="sr-only"> to review</span>
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-stone-200 px-4 pt-3">
        <AppearanceToggle className="w-full justify-between" />
      </div>
      <div className="flex items-center gap-3 px-4 py-3 text-xs text-stone-500">
        {authMode === 'clerk' && <ClerkUserButton />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-stone-700">{userName ?? 'Signed in'}</p>
          <p className="truncate">
            {company.name} · {role === 'admin' ? 'Admin' : 'Member'}
          </p>
        </div>
        <button type="button" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" className="rounded-md p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-700">
          <Keyboard className="size-4" aria-hidden />
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-stone-200 bg-white lg:block print:hidden">{sidebar}</aside>
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        {sidebar}
      </MobileDrawer>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-stone-200 bg-white px-2 lg:hidden print:hidden">
          <button type="button" className="inline-flex size-10 items-center justify-center rounded-md hover:bg-stone-100" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <Menu className="size-5" />
          </button>
          <Wordmark size="sm" />
          <span className="ml-auto min-w-0 truncate text-sm font-medium text-stone-600">{company.name}</span>
          <button
            type="button"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100"
            aria-label={`Search and jump (${mod}+K)`}
            onClick={openPalette}
          >
            <Search className="size-5" aria-hidden />
          </button>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 print:max-w-none print:p-0">
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

/**
 * Off-canvas navigation on a native modal <dialog>: Escape closes it, focus stays
 * inside while open and returns to the menu button afterwards. The sidebar is only
 * mounted while open so its controls are never duplicated in the page. Clerk menus
 * opened from it portal into the dialog, since anything under body sits behind it.
 */
function MobileDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const getContainer = React.useCallback(() => ref.current, []);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Menu"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 h-dvh max-h-none w-[min(18rem,85vw)] max-w-none overflow-visible border-0 bg-white p-0 shadow-xl backdrop:bg-stone-900/40 lg:hidden"
    >
      {open && (
        <div className="relative h-full">
          <button type="button" className="absolute right-2 top-3 inline-flex size-10 items-center justify-center rounded-md hover:bg-stone-100" aria-label="Close menu" onClick={onClose}>
            <X className="size-5" />
          </button>
          <PortalContainerContext.Provider value={getContainer}>{children}</PortalContainerContext.Provider>
        </div>
      )}
    </dialog>
  );
}

/** Clerk account menu (profile, sign out); the dev switcher has no equivalent. */
function ClerkUserButton() {
  return <LazyClerk name="UserButton" fallback={<div className="size-7 rounded-full bg-stone-100" aria-hidden />} afterSignOutUrl="/" />;
}
