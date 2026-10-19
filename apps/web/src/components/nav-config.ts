import {
  BarChart3,
  BookOpen,
  Building2,
  ClipboardList,
  FileMinus,
  FileText,
  Inbox,
  Landmark,
  LayoutDashboard,
  Receipt,
  Repeat,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

/** Sidebar, command palette, settings nav and shortcut help all read from here. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra words the command palette matches on. */
  keywords?: string;
  /** Two-key shortcut ("g i"). */
  shortcut?: string;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
  /** Tucked away behind a toggle unless the current page is inside it (accountant tools). */
  collapsible?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview to do setup get started', shortcut: 'g d' }] },
  {
    label: 'Sales',
    items: [
      { href: '/invoices', label: 'Invoices', icon: FileText, keywords: 'receivable sales billing customers', shortcut: 'g i' },
      { href: '/payments', label: 'Payments received', icon: Landmark, keywords: 'payments received money customer deposit check zelle' },
      { href: '/credit-notes', label: 'Credit notes', icon: FileMinus, keywords: 'refund credit memo discount' },
      { href: '/recurring', label: 'Recurring invoices', icon: Repeat, keywords: 'schedule subscription repeat retainer' },
    ],
  },
  { label: 'Spending', items: [{ href: '/purchases', label: 'Expenses', icon: Receipt, keywords: 'purchases receipts vendors spending costs', shortcut: 'g p' }] },
  {
    label: 'Banking',
    items: [
      { href: '/banking/inbox', label: 'Bank transactions', icon: Inbox, keywords: 'transactions bank inbox review categorize', shortcut: 'g t' },
      { href: '/banking', label: 'Bank accounts', icon: Building2, keywords: 'banking cards reconcile import statements connect' },
    ],
  },
  { label: 'Reports', items: [{ href: '/reports', label: 'Reports', icon: BarChart3, keywords: 'profit loss taxes statements', shortcut: 'g r' }] },
  {
    label: 'Company',
    items: [
      { href: '/contacts', label: 'Customers & vendors', icon: Users, keywords: 'contacts customers vendors clients suppliers', shortcut: 'g c' },
      { href: '/settings', label: 'Settings', icon: Settings, keywords: 'preferences configuration' },
    ],
  },
  {
    label: 'Advanced',
    collapsible: true,
    items: [
      { href: '/journal', label: 'Journal entries', icon: ClipboardList, keywords: 'journal entries ledger adjustment' },
      { href: '/accounts', label: 'Chart of accounts', icon: BookOpen, keywords: 'accounts categories coa' },
      { href: '/audit', label: 'History', icon: ShieldCheck, keywords: 'audit trail log changes' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Whether a sidebar link is the current section. "/banking" owns its subpages
 * (reconcile, import) but not "/banking/inbox", which is the Transactions link.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + '/')) return false;
  // A more specific sidebar link (Transactions under Banking) wins.
  return !NAV_ITEMS.some((i) => i.href !== href && i.href.startsWith(href + '/') && (pathname === i.href || pathname.startsWith(i.href + '/')));
}

export interface SimplePage {
  href: string;
  label: string;
  description?: string;
  keywords?: string;
  /** Only admins see it (system status, team). */
  adminOnly?: boolean;
}

export const REPORT_PAGES: SimplePage[] = [
  { href: '/reports/profit-and-loss', label: 'Profit & Loss', keywords: 'income statement p&l pnl' },
  { href: '/reports/balance-sheet', label: 'Balance sheet', keywords: 'assets liabilities equity' },
  { href: '/reports/trial-balance', label: 'Trial balance', keywords: 'debits credits' },
  { href: '/reports/general-ledger', label: 'General ledger', keywords: 'gl postings account activity history' },
  { href: '/reports/category', label: 'Category report', keywords: 'spending categories' },
  { href: '/reports/schedule-c', label: 'Schedule C summary', keywords: 'tax irs 1040' },
  { href: '/reports/outstanding-invoices', label: 'Outstanding invoices', keywords: 'aging receivables overdue ar' },
  { href: '/reports/transactions', label: 'All activity', keywords: 'transactions report posted lines' },
];

export interface SettingsGroup {
  label: string;
  items: SimplePage[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: 'Company',
    items: [
      { href: '/settings/company', label: 'Company', description: 'Name, address, time zone, tax setup and invoice numbering.', keywords: 'profile address invoice numbering footer business type tax basis' },
      { href: '/settings/team', label: 'Team', description: 'Invite people to these books and see who has access.', keywords: 'members invite users people accountant' },
      { href: '/settings/billing', label: 'Plan and billing', description: 'Your Evenbooks plan: team size and fees on online payments. Upgrade, downgrade or cancel.', keywords: 'subscription upgrade plan' },
    ],
  },
  {
    label: 'Books',
    items: [
      { href: '/settings/import', label: 'Import data', description: 'Bring your history over from Wave or another app, or upload bank statements.', keywords: 'wave csv migrate history' },
      { href: '/settings/opening-balances', label: 'Starting balances', description: 'What was in your bank and on your cards just before you started using Evenbooks.', keywords: 'opening balances start' },
      { href: '/settings/periods', label: 'Accounting periods', description: 'Lock past months or years after you file taxes, so nothing changes by accident.', keywords: 'close lock year end' },
      { href: '/settings/mappings', label: 'Schedule C mappings', description: 'Choose which tax-form line each category goes on.', keywords: 'tax lines' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { href: '/settings/invoice-branding', label: 'Invoice branding', description: 'Invoice designs, email templates and the address your invoices come from.', keywords: 'logo pdf template email sender domain' },
      { href: '/settings/items', label: 'Products and services', description: 'Things you sell, with a price, so invoices fill themselves in.', keywords: 'items catalog' },
      { href: '/settings/tax-rates', label: 'Sales tax rates', description: 'Sales tax you charge on invoices, and who you pay it to.', keywords: 'vat gst' },
      { href: '/settings/payments', label: 'Online payments', description: 'Let customers pay invoices by card or bank transfer through Stripe. Fees and deposits are recorded for you.', keywords: 'stripe card ach' },
    ],
  },
  {
    label: 'Banking',
    items: [{ href: '/settings/rules', label: 'Categorization rules', description: 'Suggest a category for bank transactions that match a pattern.', keywords: 'auto categorize' }],
  },
  {
    label: 'System',
    items: [{ href: '/settings/jobs', label: 'Sync and email status', description: 'Bank syncs, emails and other background work, with anything that failed.', keywords: 'background jobs worker queue outbox', adminOnly: true }],
  },
];

/** Settings groups this person can see (system pages are for admins). */
export function visibleSettingsGroups(isAdmin: boolean): SettingsGroup[] {
  return SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => isAdmin || !i.adminOnly) })).filter((g) => g.items.length);
}

export const SETTINGS_PAGES: SimplePage[] = SETTINGS_GROUPS.flatMap((g) => g.items);

export const ACTIONS: SimplePage[] = [
  { href: '/invoices/new', label: 'New invoice', keywords: 'create bill customer' },
  { href: '/purchases/new', label: 'Record expense', keywords: 'create purchase receipt expense spending' },
  { href: '/payments/new', label: 'Record payment received', keywords: 'receive money customer paid check zelle' },
  { href: '/banking', label: 'Connect a bank account', keywords: 'link bank simplefin feed import statement' },
  { href: '/settings/import', label: 'Import from Wave or another app', keywords: 'wave migrate history csv' },
  { href: '/settings/team', label: 'Invite someone', keywords: 'team member accountant bookkeeper' },
  { href: '/contacts?new=1', label: 'New customer or vendor', keywords: 'create contact customer vendor client' },
  { href: '/journal/new', label: 'New journal entry (advanced)', keywords: 'create adjustment manual' },
];

export interface ShortcutHelp {
  keys: string[];
  label: string;
}

export interface ShortcutSection {
  title: string;
  items: ShortcutHelp[];
}

/** Shown by "?". Keep in step with the bindings in app-shell and the list and inbox pages. */
export function shortcutSections(mod: string): ShortcutSection[] {
  return [
    {
      title: 'Anywhere',
      items: [
        { keys: [mod, 'K'], label: 'Search and jump' },
        { keys: ['?'], label: 'Show keyboard shortcuts' },
        ...NAV_ITEMS.filter((i) => i.shortcut).map((i) => ({ keys: i.shortcut!.toUpperCase().split(' '), label: `Go to ${i.label}` })),
      ],
    },
    {
      title: 'Lists',
      items: [
        { keys: ['N'], label: 'New (invoice, contact, purchase…)' },
        { keys: ['/'], label: 'Focus the search box' },
      ],
    },
    {
      title: 'Forms and dialogs',
      items: [
        { keys: [mod, 'Enter'], label: 'Save or submit' },
        { keys: ['Esc'], label: 'Close the dialog or menu' },
      ],
    },
    {
      title: 'Bank transactions',
      items: [
        { keys: ['J'], label: 'Next transaction' },
        { keys: ['K'], label: 'Previous transaction' },
        { keys: ['Enter'], label: 'Accept the suggestion' },
        { keys: ['R'], label: 'Review the selected transaction' },
        { keys: ['E'], label: 'Exclude' },
        { keys: ['X'], label: 'Select for bulk actions' },
      ],
    },
  ];
}
