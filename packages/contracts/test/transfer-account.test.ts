import { describe, expect, it } from 'vitest';
import { isTransferAccount } from '../src/banking';
import type { AccountDto } from '../src/ledger';

type TransferAccount = Pick<AccountDto, 'type' | 'role'>;

describe('transfer accounts', () => {
  it.each<TransferAccount>([
    { type: 'asset', role: null }, // Custom Wave clearing account
    { type: 'asset', role: 'bank' },
    { type: 'asset', role: 'undeposited_funds' },
    { type: 'asset', role: 'processor_clearing' },
    { type: 'liability', role: null },
    { type: 'liability', role: 'credit_card' },
    { type: 'equity', role: 'owner_equity' },
    { type: 'equity', role: 'owner_draws' },
  ])('offers $type / $role', (account) => {
    expect(isTransferAccount(account)).toBe(true);
  });

  it.each<TransferAccount>([
    { type: 'asset', role: 'accounts_receivable' },
    { type: 'liability', role: 'customer_deposits' },
    { type: 'liability', role: 'sales_tax_payable' },
    { type: 'income', role: null },
    { type: 'expense', role: null },
    { type: 'expense', role: 'processor_fees' },
    { type: 'equity', role: 'retained_earnings' },
    { type: 'equity', role: 'opening_balance_equity' },
  ])('excludes $type / $role', (account) => {
    expect(isTransferAccount(account)).toBe(false);
  });
});
