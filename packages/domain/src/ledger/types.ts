export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Debit-normal account types increase with debits. */
export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense';
}

/**
 * Control-account roles the system relies on. Exactly one active account per
 * company may carry each of the `single` roles; `many` roles may be assigned to
 * several accounts (e.g. multiple bank accounts).
 */
export const ACCOUNT_ROLES = [
  'accounts_receivable',
  'customer_deposits',
  'sales_tax_payable',
  'undeposited_funds',
  'bank',
  'credit_card',
  'opening_balance_equity',
  'owner_equity',
  'owner_draws',
  'retained_earnings',
  'sales_discounts',
  'bad_debt',
  'bank_fees',
  'uncategorized_income',
  'uncategorized_expense',
  'rounding',
  'advance_payments',
  'processor_clearing',
  'processor_fees',
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const SINGLE_INSTANCE_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>([
  'accounts_receivable',
  'customer_deposits',
  'sales_tax_payable',
  'undeposited_funds',
  'opening_balance_equity',
  'retained_earnings',
  'sales_discounts',
  'bad_debt',
  'bank_fees',
  'uncategorized_income',
  'uncategorized_expense',
  'rounding',
  'advance_payments',
]);

/** Roles whose accounts are protected from arbitrary manual journal lines. */
export const PROTECTED_CONTROL_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>([
  'accounts_receivable',
  'customer_deposits',
  'sales_tax_payable',
]);

export const ROLE_ACCOUNT_TYPES: Record<AccountRole, AccountType> = {
  accounts_receivable: 'asset',
  customer_deposits: 'liability',
  sales_tax_payable: 'liability',
  undeposited_funds: 'asset',
  bank: 'asset',
  credit_card: 'liability',
  opening_balance_equity: 'equity',
  owner_equity: 'equity',
  owner_draws: 'equity',
  retained_earnings: 'equity',
  sales_discounts: 'income',
  bad_debt: 'expense',
  bank_fees: 'expense',
  uncategorized_income: 'income',
  uncategorized_expense: 'expense',
  rounding: 'expense',
  advance_payments: 'income',
  processor_clearing: 'asset',
  processor_fees: 'expense',
};
