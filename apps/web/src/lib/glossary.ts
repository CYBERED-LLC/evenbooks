/**
 * Plain-language definitions for the accounting ideas the app can't avoid. Shown by `<Term>`
 * (components/ui/term.tsx). Each entry says what the thing means for the business owner first;
 * `accountantTerm` is the word their accountant or tax software uses, so both make sense.
 * Keep entries to two short sentences; link out (`learnMore`) only to pages in the app.
 */
export interface GlossaryEntry {
  /** What the app calls it in everyday screens. */
  label: string;
  /** One or two short sentences, written for someone who has never kept books. */
  plain: string;
  /** The accounting name, when it differs from `label`. */
  accountantTerm?: string;
  learnMore?: { label: string; href: string };
}

export const glossary = {
  receivable: {
    label: 'Customers owe you',
    plain: 'Money customers owe you for invoices you have sent and they have not paid yet.',
    accountantTerm: 'accounts receivable (A/R)',
    learnMore: { label: 'See who owes you', href: '/reports/outstanding-invoices' },
  },
  profit: {
    label: 'Profit',
    plain: 'What you earned minus what you spent. It is not the same as cash in the bank: loan payments, money you take out for yourself and equipment move cash without changing profit.',
    accountantTerm: 'net income',
  },
  'cash-basis': {
    label: 'When money moved',
    plain: 'Counts income when a customer pays you and expenses when you pay. Most sole proprietors and freelancers report taxes this way.',
    accountantTerm: 'cash basis',
  },
  'accrual-basis': {
    label: 'When invoiced or billed',
    plain: 'Counts income when you send the invoice and expenses when you are billed, even if no money has moved yet.',
    accountantTerm: 'accrual basis',
  },
  reconcile: {
    label: 'Check against your statement',
    plain: 'Compare Evenbooks with your bank or card statement, line by line, so you know nothing is missing or counted twice. Do it once a month when the statement arrives.',
    accountantTerm: 'reconciliation',
  },
  categorize: {
    label: 'Categorize',
    plain: 'Say what a bank transaction was for, such as Office supplies or Sales, so it lands in the right place in your reports and taxes.',
  },
  category: {
    label: 'Category',
    plain: 'A bucket your money is sorted into, such as Rent, Meals or Sales. Your bank and card accounts are on the same list.',
    accountantTerm: 'account (the full list is the chart of accounts)',
    learnMore: { label: 'See all categories', href: '/accounts' },
  },
  'journal-entry': {
    label: 'Journal entry',
    plain: 'A manual adjustment to your books. Most businesses rarely need one: invoices, payments, purchases and bank transactions record themselves.',
  },
  'starting-balances': {
    label: 'Starting balances',
    plain: 'What your accounts held just before you started recording in Evenbooks, such as the balance on your bank statement for December 31.',
    accountantTerm: 'opening balances',
    learnMore: { label: 'Enter starting balances', href: '/settings/opening-balances' },
  },
  'owner-draw': {
    label: 'Personal spending (owner draw)',
    plain: 'Money you take out of the business for yourself, or business money spent on something personal. It is not a business expense and does not lower your profit.',
    accountantTerm: 'owner’s draw',
  },
  'owner-contribution': {
    label: 'Money you put in',
    plain: 'Money you put into the business from your own pocket. It is not income and is not taxed as income.',
    accountantTerm: 'owner’s contribution (capital)',
  },
  transfer: {
    label: 'Transfer',
    plain: 'Money moving between two of your own accounts, such as paying the credit card from checking. It is neither income nor spending.',
  },
  match: {
    label: 'Match',
    plain: 'Link a bank transaction to something already recorded, such as a customer payment or a purchase, so it is not counted twice.',
  },
  exclude: {
    label: 'Exclude',
    plain: 'Leave a bank line out of your books. Only for lines that are not real, such as duplicates or a charge the bank reversed. Personal spending is real money leaving, so record it as personal spending instead.',
  },
  'undeposited-funds': {
    label: 'Payments to deposit',
    plain: 'A holding spot for checks and cash you have received but not taken to the bank yet. When the deposit shows up in your bank feed, match it there.',
    accountantTerm: 'undeposited funds',
  },
  'credit-note': {
    label: 'Credit note',
    plain: 'A document that lowers what a customer owes: for a refund, a discount, or a mistake on an invoice you already sent.',
    accountantTerm: 'credit memo',
  },
  issue: {
    label: 'Issue',
    plain: 'Finalizes an invoice: it gets its number, can be sent, and counts as money your customer owes you. To change it afterwards, void it or give a credit note.',
  },
  void: {
    label: 'Void',
    plain: 'Cancels a record but keeps it in your history, marked Void. Your reports and balances ignore it.',
  },
  unapplied: {
    label: 'Credit to use',
    plain: 'Money a customer paid that is not attached to an invoice yet. Apply it to an invoice, keep it for their next one, or refund it.',
    accountantTerm: 'unapplied payment',
  },
  'locked-period': {
    label: 'Locked period',
    plain: 'A month or year you have locked, usually after filing taxes, so nothing dated inside it changes by accident. You can reopen it with a reason.',
    accountantTerm: 'closed accounting period',
    learnMore: { label: 'Accounting periods', href: '/settings/periods' },
  },
  'fiscal-year': {
    label: 'Tax year',
    plain: 'The 12 months your books and taxes cover. For most sole proprietors and single-member LLCs it runs January to December.',
    accountantTerm: 'fiscal year',
  },
  'balance-sheet': {
    label: 'Balance sheet',
    plain: 'A snapshot on one date of what the business has, what it owes, and what is left over for you.',
  },
  assets: {
    label: 'What the business has',
    plain: 'Money in the bank, money customers owe you, and things the business owns, such as equipment.',
    accountantTerm: 'assets',
  },
  liabilities: {
    label: 'What the business owes',
    plain: 'Credit card balances, loans, and sales tax you collected but have not paid to the state yet.',
    accountantTerm: 'liabilities',
  },
  equity: {
    label: 'What is left for you',
    plain: 'Money you put in, minus what you took out, plus profit kept in the business.',
    accountantTerm: 'owner’s equity',
  },
  'retained-earnings': {
    label: 'Profit from earlier years',
    plain: 'Profit from past years that stayed in the business.',
    accountantTerm: 'retained earnings',
  },
  'schedule-c': {
    label: 'Schedule C',
    plain: 'The IRS form sole proprietors and single-member LLCs use to report business profit or loss with their personal tax return.',
    learnMore: { label: 'Schedule C summary', href: '/reports/schedule-c' },
  },
  'sales-tax-payable': {
    label: 'Sales tax to pay',
    plain: 'Sales tax you collected from customers that you still need to pay to the state.',
    accountantTerm: 'sales tax payable',
  },
  'trial-balance': {
    label: 'Trial balance',
    plain: 'Every account’s balance on one date, in debit and credit columns. Mostly for your accountant.',
  },
  'general-ledger': {
    label: 'General ledger',
    plain: 'Every change to one account, in date order, with a running balance. Useful to find where a number came from.',
  },
  uncategorized: {
    label: 'Uncategorized',
    plain: 'Money that has not been sorted into a category yet. It still counts in your totals, but your tax lines may be off until you categorize it.',
  },
  'report-basis': {
    label: 'Cash or accrual',
    plain: 'Cash counts income when customers pay you and expenses when you pay. Accrual counts them when you invoice or are billed, even before money moves. Most sole proprietors file taxes on cash.',
    accountantTerm: 'cash basis or accrual basis',
  },
  'match-found': {
    label: 'Match found',
    plain: 'Something with this amount is already recorded near this date, such as a customer payment, an expense or an unpaid invoice. Match the bank line to it so the money isn’t counted twice.',
  },
  'possible-transfer': {
    label: 'Possible transfer',
    plain: 'Another of your bank or card accounts has the opposite amount around the same day, so this may be money moving between your own accounts. Record it as a transfer to link both sides.',
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof glossary;
