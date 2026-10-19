/**
 * Every fact the public pages may state, in one place. If it is not here, do
 * not claim it on a marketing page. Keep it in the brand voice
 * (docs/brand-bible.md §1): plain, exact, no superlatives.
 */

export const TAGLINES = {
  mission: 'Honest books at a fair price, for as long as you run your business.',
  short: 'Books that balance. Prices that don’t move.',
  even: 'Even books. Even terms.',
  work: 'Bookkeeping that shows its work.',
} as const;

export const AUDIENCE = 'Sole proprietors and small companies in the United States that want real books without an accounting department.';

export interface Feature {
  id: string;
  title: string;
  summary: string;
  detail: string;
}

export const FEATURES: Feature[] = [
  {
    id: 'ledger',
    title: 'Real double-entry books',
    summary: 'Every transaction posts as a balanced journal entry. Nothing is quietly edited. Mistakes are fixed with a reversal you can see.',
    detail: 'A chart of accounts you control, period locks, opening balances, an audit trail of who changed what, and reports that reconcile to the ledger because they are computed from it.',
  },
  {
    id: 'invoicing',
    title: 'Invoices that get paid',
    summary: 'Issue invoices and credit notes, send them by email with a PDF, and let customers pay online by card or bank transfer.',
    detail: 'Recurring invoices on a schedule, partial payments, refunds, sales tax lines, and a public invoice page that always shows the live balance.',
  },
  {
    id: 'payments',
    title: 'Online payments, booked for you',
    summary: 'Connect your own Stripe account. Each payment, fee, refund and payout lands in the right account automatically.',
    detail: 'A “Stripe balance” clearing account that returns to zero after each payout, fees split into Stripe’s and ours, and payouts matched against your bank feed.',
  },
  {
    id: 'banking',
    title: 'Bank feeds and a review inbox',
    summary: 'Pull transactions through SimpleFIN Bridge or import a CSV. Rules suggest categories; you approve each entry.',
    detail: 'Matching to invoices, payments and payouts; duplicate detection; reconciliation sessions against your statement; nothing posts without a person saying so.',
  },
  {
    id: 'reports',
    title: 'Reports you can hand to an accountant',
    summary: 'Profit and loss on accrual and cash basis, balance sheet, trial balance, general ledger, outstanding invoices and a Schedule C summary.',
    detail: 'Every report downloads as CSV. Cash-basis figures come from a recognition layer, not from guessing at bank transactions.',
  },
  {
    id: 'team',
    title: 'Yours to keep',
    summary: 'Export any report, invite your bookkeeper, or run the whole thing yourself from the source code.',
    detail: 'Two roles (admin and member), attachments on documents, and a company you can leave with your data intact.',
  },
];

export const HOW_IT_WORKS = [
  { step: 1, title: 'Connect a bank or import a statement', text: 'Transactions arrive in an inbox. Rules propose a category; nothing posts until you approve it.' },
  { step: 2, title: 'Invoice and get paid', text: 'Send an invoice with a pay link. Card and bank transfer payments post themselves, fees and all.' },
  { step: 3, title: 'Reconcile and report', text: 'Tick off your statement, lock the period, and hand your accountant reports that actually balance.' },
] as const;

export interface Plan {
  id: 'free' | 'paid';
  name: string;
  price: string;
  cadence: string;
  altPrice?: string;
  members: string;
  cardFee: string;
  achFee: string;
  bullets: string[];
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    cadence: 'a month',
    members: '1 person per company',
    cardFee: '5% all-in on card payments',
    achFee: '1% all-in on bank transfers',
    bullets: ['Every bookkeeping feature, no limits on invoices, transactions or bank accounts', 'Online payments through your own Stripe account', 'Stripe’s fee is included in the rate, not added on top', 'Community support'],
  },
  {
    id: 'paid',
    name: 'Paid',
    price: '$15',
    cadence: 'per company, per month',
    altPrice: 'or $150 a year',
    members: 'Up to 20 people per company',
    cardFee: 'Stripe’s fee only (2.9% + 30¢)',
    achFee: 'Stripe’s fee only (0.8%, capped at $5)',
    bullets: ['Everything in Free', 'Evenbooks takes nothing on payments', 'Invite up to 20 people at no extra cost', 'Email support'],
  },
];

export const FEE_FACTS = {
  freeCardPercent: '5%',
  freeAchPercent: '1%',
  stripeCard: '2.9% + 30¢',
  stripeAch: '0.8%, capped at $5',
  paidMonthly: '$15',
  paidYearly: '$150',
  simplefinNote: 'Bank feeds use SimpleFIN Bridge, an independent service you subscribe to directly for about $1.50 a month. Evenbooks earns nothing from it.',
} as const;

export const COMMITMENTS = [
  { title: 'The price is on the page', text: 'One paid plan at one price. The fee math is public, and it’s the same code that charges you. No higher tier is holding back the reports you need.' },
  { title: 'Your books are yours', text: 'Every report exports as CSV. Leave whenever you want and take everything with you.' },
  { title: 'The source is open to read and run', text: 'Anyone can read the code. You can run it on your own server for your own company, free, for as long as you like.' },
  { title: 'If we ever close, the code opens', text: 'It’s written into the license. If we ever shut down the hosted service, the code is released under Apache 2.0. Your books never depend on us staying around.' },
] as const;

export const FAQ = [
  { q: 'Is this really double-entry bookkeeping?', a: 'Yes. Every invoice, payment, purchase and bank transaction becomes a balanced journal entry you can inspect. Posted entries are immutable; corrections are reversals. The trial balance is zero by construction.' },
  { q: 'Who is it for?', a: AUDIENCE + ' It is single-currency (USD) and the online payments run on Stripe’s US platform.' },
  { q: 'What does “all-in” mean on the free plan?', a: 'You pay one rate on an online payment, 5% on cards or 1% on bank transfers, and Stripe’s own fee is inside it. Evenbooks keeps the difference. On very small charges Stripe’s fixed fee can exceed the rate, and then we keep nothing.' },
  { q: 'Why is the paid plan so cheap?', a: 'Because bookkeeping software should not cost more than the coffee it tracks. $15 a month covers our costs for a company with a team; payments on the paid plan cost you only what Stripe charges.' },
  { q: 'Can I move from Wave, QuickBooks or a spreadsheet?', a: 'Import bank statements as CSV, enter opening balances as of a date, and continue from there. There is no one-click migration of historical invoices yet.' },
  { q: 'Can I self-host?', a: 'Yes. The code is source-available under the Elastic License 2.0: run it for your own company for free, forever. You may not resell hosted access to it. Community support only.' },
  { q: 'Who is behind it?', a: 'Evenbooks is built and run by a small, independent team in the United States. There are no investors and no plans to sell your data or your attention.' },
] as const;

export const SOURCE = {
  licence: 'Elastic License 2.0',
  licenceSummary: 'You can read, modify, and run the software for your own company or clients you serve directly. You cannot offer it to others as a hosted or managed service.',
  repoUrl: null as string | null, // set when the repository is published
} as const;
