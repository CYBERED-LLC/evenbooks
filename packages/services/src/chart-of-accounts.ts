import type { AccountRole, AccountType } from '@evenbooks/domain';

export interface DefaultAccount {
  code: string;
  name: string;
  type: AccountType;
  role?: AccountRole;
  system?: boolean;
  description?: string;
  /** Default Schedule C line for expense/income categories (2025 layout). */
  scheduleC?: string;
}

/**
 * Default chart for a US service business. System accounts carry roles the
 * application depends on and cannot be archived; their code, name and
 * description can still be changed. Everything else is editable.
 *
 * Every account has a one-line description in plain words, shown on the chart
 * of accounts and in account pickers. Migration 0021 copied them onto existing
 * companies' untouched defaults, so keep the two in step when one changes.
 *
 * The receivable control account is named for what it holds: only invoices
 * issued in Evenbooks post there (through invoices, payments and credit notes),
 * so the balance sheet line always equals the open invoices in the aging
 * report. Receivables collected outside Evenbooks belong in their own account.
 */
export const DEFAULT_CHART: DefaultAccount[] = [
  // Assets
  { code: '1000', name: 'Checking Account', type: 'asset', role: 'bank',
    description: 'Your main business bank account.' },
  { code: '1050', name: 'Undeposited Funds', type: 'asset', role: 'undeposited_funds', system: true,
    description: 'Checks and cash received but not yet deposited.' },
  { code: '1100', name: 'Accounts Receivable (Evenbooks invoices)', type: 'asset', role: 'accounts_receivable', system: true,
    description: "Invoices issued in Evenbooks that customers haven't paid yet. Changes only through invoices, payments and credit notes." },
  { code: '1500', name: 'Equipment', type: 'asset',
    description: 'Computers, tools, vehicles and other things the business owns and uses for years.' },
  { code: '1600', name: 'Accumulated Depreciation', type: 'asset',
    description: "How much of your equipment's cost has been written off as depreciation so far. Shown as a negative amount." },
  // Liabilities
  { code: '2000', name: 'Credit Card', type: 'liability', role: 'credit_card',
    description: 'What you owe on the business credit card.' },
  { code: '2100', name: 'Sales Tax Payable', type: 'liability', role: 'sales_tax_payable', system: true,
    description: 'Sales tax you collected on invoices and still need to pay to the state. Changes only through invoices and credit notes.' },
  { code: '2200', name: 'Customer Deposits and Credits', type: 'liability', role: 'customer_deposits', system: true,
    description: 'Money customers paid you ahead of time, and credits you owe them. Changes only through payments and credit notes.' },
  { code: '2500', name: 'Loans Payable', type: 'liability',
    description: 'What the business still owes on loans.' },
  // Equity
  { code: '3000', name: "Owner's Equity", type: 'equity', role: 'owner_equity',
    description: 'Money you put into the business from your own pocket.' },
  { code: '3100', name: "Owner's Draws", type: 'equity', role: 'owner_draws',
    description: 'Money you took out of the business for yourself.' },
  { code: '3200', name: 'Retained Earnings', type: 'equity', role: 'retained_earnings', system: true,
    description: 'Profit from earlier years that stayed in the business.' },
  { code: '3900', name: 'Opening Balance Equity', type: 'equity', role: 'opening_balance_equity', system: true,
    description: 'Balancing amount from your starting balances.' },
  // Income
  { code: '4000', name: 'Sales', type: 'income', scheduleC: '1',
    description: 'Money from selling products.' },
  { code: '4100', name: 'Service Revenue', type: 'income', scheduleC: '1',
    description: 'Money from the services you provide.' },
  { code: '4800', name: 'Sales Discounts', type: 'income', role: 'sales_discounts', system: true, scheduleC: '2',
    description: 'Discounts and write-offs that lower what customers pay you.' },
  { code: '4900', name: 'Other Income', type: 'income', scheduleC: '6',
    description: "Income that isn't from your main business, such as interest." },
  { code: '4950', name: 'Advance Customer Payments', type: 'income', role: 'advance_payments', system: true, scheduleC: '1',
    description: 'Customer payments not yet applied to an invoice. Used on cash-basis reports only.' },
  { code: '4990', name: 'Uncategorized Income', type: 'income', role: 'uncategorized_income', system: true, scheduleC: '6',
    description: "Money in that hasn't been sorted into a category yet." },
  // Expenses
  { code: '5000', name: 'Advertising', type: 'expense', scheduleC: '8',
    description: 'Ads, marketing and promotion.' },
  { code: '5010', name: 'Car and Truck Expenses', type: 'expense', scheduleC: '9',
    description: 'Fuel, parking, tolls and other costs of driving for the business.' },
  { code: '5020', name: 'Commissions and Fees', type: 'expense', scheduleC: '10',
    description: 'Commissions and fees paid to others, such as marketplace fees.' },
  { code: '5030', name: 'Contract Labor', type: 'expense', scheduleC: '11',
    description: "Payments to freelancers and contractors who aren't employees." },
  { code: '5040', name: 'Depreciation', type: 'expense', scheduleC: '13',
    description: 'The yearly write-off of equipment you own.' },
  { code: '5050', name: 'Insurance', type: 'expense', scheduleC: '15',
    description: 'Business insurance, other than health insurance.' },
  { code: '5060', name: 'Interest Expense', type: 'expense', scheduleC: '16b',
    description: 'Interest on business loans and credit cards.' },
  { code: '5070', name: 'Legal and Professional Services', type: 'expense', scheduleC: '17',
    description: 'Accountants, lawyers and other professional help.' },
  { code: '5080', name: 'Office Expense', type: 'expense', scheduleC: '18',
    description: 'Postage, printing and small office costs.' },
  { code: '5090', name: 'Rent or Lease', type: 'expense', scheduleC: '20b',
    description: 'Rent for your office, shop or equipment.' },
  { code: '5100', name: 'Repairs and Maintenance', type: 'expense', scheduleC: '21',
    description: 'Fixing and maintaining equipment or your workplace.' },
  { code: '5110', name: 'Supplies', type: 'expense', scheduleC: '22',
    description: 'Materials and supplies you use up in the business.' },
  { code: '5120', name: 'Taxes and Licenses', type: 'expense', scheduleC: '23',
    description: 'Business licenses, permits and business taxes (not income tax).' },
  { code: '5130', name: 'Travel', type: 'expense', scheduleC: '24a',
    description: 'Airfare, hotels and other costs of business trips.' },
  { code: '5140', name: 'Meals', type: 'expense', scheduleC: '24b',
    description: 'Business meals. Usually only half is deductible.' },
  { code: '5150', name: 'Utilities', type: 'expense', scheduleC: '25',
    description: 'Phone, internet, electricity and water for the business.' },
  { code: '5160', name: 'Software and Subscriptions', type: 'expense', scheduleC: '18',
    description: 'Software and online services you pay for.' },
  { code: '5170', name: 'Bank Fees', type: 'expense', role: 'bank_fees', system: true, scheduleC: '10',
    description: 'Fees your bank or payment processor charges.' },
  { code: '5180', name: 'Bad Debt', type: 'expense', role: 'bad_debt', system: true, scheduleC: '27b',
    description: 'Invoices you have given up on collecting.' },
  { code: '5900', name: 'Other Expenses', type: 'expense', scheduleC: '27b',
    description: "Business costs that don't fit another category." },
  { code: '5980', name: 'Rounding Differences', type: 'expense', role: 'rounding', system: true, scheduleC: '27b',
    description: 'Cent differences from rounding.' },
  { code: '5990', name: 'Uncategorized Expense', type: 'expense', role: 'uncategorized_expense', system: true, scheduleC: '27b',
    description: "Money out that hasn't been sorted into a category yet." },
];
