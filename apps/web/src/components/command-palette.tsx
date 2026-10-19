'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueries } from '@tanstack/react-query';
import { ArrowRight, BarChart3, ClipboardList, FileText, Plus, Search, Settings, Users } from 'lucide-react';
import type { ContactDto, InvoiceDto, JournalEntryDto, Page } from '@evenbooks/contracts';
import { Dialog } from '@/components/ui/dialog';
import { useCompany } from '@/components/company-context';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate, formatMoney } from '@/lib/format';
import { invoiceStatus } from '@/lib/status';
import { cn } from '@/lib/utils';
import { ACTIONS, NAV_ITEMS, REPORT_PAGES, SETTINGS_PAGES, type SimplePage } from '@/components/nav-config';

interface PaletteOption {
  key: string;
  href: string;
  label: string;
  meta?: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface PaletteGroup {
  label: string;
  options: PaletteOption[];
  loading?: boolean;
}

/** Every word of the query appears in the label or keywords; label prefix matches rank first. */
function matchPages(pages: SimplePage[], q: string): SimplePage[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pages;
  const hits = pages.filter((p) => {
    const hay = `${p.label} ${p.keywords ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const ql = q.toLowerCase();
  return hits.sort((a, b) => Number(!a.label.toLowerCase().startsWith(ql)) - Number(!b.label.toLowerCase().startsWith(ql)));
}

const SEARCH_LIMIT = 5;

/**
 * Cmd/Ctrl+K: jump to any page, start a common action, or find an invoice,
 * contact or journal entry by typing. Arrow keys move, Enter opens, Esc closes.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Search and jump" size="lg">
      <PaletteBody onClose={onClose} />
    </Dialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { company, isAdmin } = useCompany();
  const [q, setQ] = React.useState('');
  const [active, setActive] = React.useState(0);
  const term = useDebounced(q.trim(), 200);
  const searching = term.length >= 2;
  const baseId = React.useId();
  const listId = `${baseId}-list`;

  const [invoices, contacts, journal] = useQueries({
    queries: [
      {
        queryKey: [...qk.company(company.id), 'palette', 'invoices', term],
        queryFn: ({ signal }: { signal: AbortSignal }) => api<Page<InvoiceDto>>('/api/invoices', { companyId: company.id, signal, query: { q: term, limit: SEARCH_LIMIT } }),
        enabled: searching,
        staleTime: 15_000,
      },
      {
        queryKey: [...qk.company(company.id), 'palette', 'contacts', term],
        queryFn: ({ signal }: { signal: AbortSignal }) => api<Page<ContactDto>>('/api/contacts', { companyId: company.id, signal, query: { q: term, limit: SEARCH_LIMIT } }),
        enabled: searching,
        staleTime: 15_000,
      },
      {
        queryKey: [...qk.company(company.id), 'palette', 'journal', term],
        queryFn: ({ signal }: { signal: AbortSignal }) => api<Page<JournalEntryDto>>('/api/journal', { companyId: company.id, signal, query: { q: term, limit: SEARCH_LIMIT } }),
        enabled: searching,
        staleTime: 15_000,
      },
    ],
  });

  const groups = React.useMemo<PaletteGroup[]>(() => {
    const qq = q.trim();
    const out: PaletteGroup[] = [];
    const actions = matchPages(ACTIONS, qq);
    if (actions.length) out.push({ label: 'Actions', options: actions.map((a) => ({ key: `a:${a.href}`, href: a.href, label: a.label, icon: Plus })) });
    const pages = matchPages(
      NAV_ITEMS.map((n) => ({ href: n.href, label: n.label, keywords: n.keywords })),
      qq,
    );
    const iconFor = new Map(NAV_ITEMS.map((n) => [n.href, n.icon] as const));
    if (pages.length) out.push({ label: 'Pages', options: pages.map((p) => ({ key: `p:${p.href}`, href: p.href, label: p.label, icon: iconFor.get(p.href) ?? ArrowRight })) });
    if (qq) {
      const reports = matchPages(REPORT_PAGES, qq);
      if (reports.length) out.push({ label: 'Reports', options: reports.map((p) => ({ key: `r:${p.href}`, href: p.href, label: p.label, icon: BarChart3 })) });
      const settings = matchPages(SETTINGS_PAGES.filter((p) => isAdmin || !p.adminOnly), qq);
      if (settings.length) out.push({ label: 'Settings', options: settings.map((p) => ({ key: `s:${p.href}`, href: p.href, label: p.label, meta: 'Settings', icon: Settings })) });
    }
    if (searching) {
      out.push({
        label: 'Customers & vendors',
        loading: contacts.isFetching && !contacts.data,
        options: (contacts.data?.items ?? []).map((c) => ({
          key: `c:${c.id}`,
          href: `/contacts/${c.id}`,
          label: c.name,
          meta: [c.isCustomer && 'Customer', c.isVendor && 'Vendor', c.isArchived && 'Archived'].filter(Boolean).join(' · '),
          icon: Users,
        })),
      });
      out.push({
        label: 'Invoices',
        loading: invoices.isFetching && !invoices.data,
        options: (invoices.data?.items ?? []).map((i) => ({
          key: `i:${i.id}`,
          href: `/invoices/${i.id}`,
          label: `${i.number ?? 'Draft invoice'}${i.contactName ? ` · ${i.contactName}` : ''}`,
          meta: `${formatMoney(i.total)} · ${invoiceStatus(i).label}`,
          icon: FileText,
        })),
      });
      out.push({
        label: 'Journal entries',
        loading: journal.isFetching && !journal.data,
        options: (journal.data?.items ?? []).map((j) => ({
          key: `j:${j.id}`,
          href: `/journal/${j.id}`,
          label: `${j.entryNumber ? `#${j.entryNumber}` : 'Draft'} · ${j.memo || 'No memo'}`,
          meta: formatDate(j.date),
          icon: ClipboardList,
        })),
      });
    }
    return out.filter((g) => g.options.length || g.loading);
  }, [q, isAdmin, searching, contacts.data, contacts.isFetching, invoices.data, invoices.isFetching, journal.data, journal.isFetching]);

  const flat = React.useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  React.useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const go = (o: PaletteOption | undefined) => {
    if (!o) return;
    onClose();
    router.push(o.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length) setActive((current + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setActive((current - 1 + flat.length) % flat.length);
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      setActive(Math.max(flat.length - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[current]);
    }
  };

  const anyLoading = groups.some((g) => g.loading) || (q.trim().length >= 2 && q.trim() !== term);
  let index = -1;

  return (
    <div className="-mx-5 -my-4">
      <div className="flex items-center gap-2 border-b border-stone-200 px-4">
        <Search className="size-4 shrink-0 text-stone-400" aria-hidden />
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat.length ? optionId(current) : undefined}
          aria-label="Search pages, actions and records"
          placeholder="Type a page, an action, a contact, an invoice number…"
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-stone-900 placeholder:text-stone-400 focus:outline-none"
        />
        {anyLoading && (
          <span role="status" className="size-4 shrink-0 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600">
            <span className="sr-only">Searching</span>
          </span>
        )}
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="max-h-[55vh] overflow-y-auto p-2">
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className="mb-1">
            <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-stone-500" aria-hidden>
              {g.label}
            </p>
            {g.loading && !g.options.length && <p className="px-2 py-1.5 text-sm text-stone-500">Searching…</p>}
            {g.options.map((o) => {
              index += 1;
              const i = index;
              const Icon = o.icon;
              return (
                <div
                  key={o.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => i !== current && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(o)}
                  className={cn('flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm', i === current ? 'bg-brand-50 text-brand-900' : 'text-stone-800')}
                >
                  <Icon className="size-4 shrink-0 text-stone-500" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.meta && <span className="shrink-0 text-xs text-stone-500">{o.meta}</span>}
                </div>
              );
            })}
          </div>
        ))}
        {!groups.length && !anyLoading && <p className="px-2 py-6 text-center text-sm text-stone-500">Nothing matches “{q.trim()}”.</p>}
      </div>
      <p className="border-t border-stone-200 px-4 py-2 text-xs text-stone-500">
        <kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> to move · <kbd className="font-sans">Enter</kbd> to open · <kbd className="font-sans">Esc</kbd> to close
      </p>
    </div>
  );
}
