import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from '@evenbooks/integrations';
import { commitBatch, createAccount, createBankAccount, previewCsv, remapBatch } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

/** A bank export whose headers the detector can't read on its own. */
const MARCH = `Posting Day,Merchant Info,Out,In,Note\n2026-03-02,COFFEE,4.50,,\n2026-03-03,CLIENT,,900.00,inv 7\n`;
const APRIL = `Posting Day,Merchant Info,Out,In,Note\n2026-04-02,COFFEE,5.00,,\n2026-04-04,RENT,1200.00,,april\n`;

describe('CSV import reuses the last committed mapping', () => {
  let w: TestWorld;
  let storage: LocalStorage;
  let tmpDir: string;
  let bankId: string;
  let otherBankId: string;

  beforeAll(async () => {
    w = await createWorld();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-map-reuse-'));
    storage = new LocalStorage(tmpDir);
    const ledger = await w.run(w.ctxA, (s) => createAccount(s, { code: '1091', name: 'Mapping Reuse Checking', type: 'asset', role: 'bank' }));
    const ledger2 = await w.run(w.ctxA, (s) => createAccount(s, { code: '1092', name: 'Mapping Reuse Savings', type: 'asset', role: 'bank' }));
    bankId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Reuse Checking', kind: 'bank', ledgerAccountId: ledger.id }))).id;
    otherBankId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Reuse Savings', kind: 'bank', ledgerAccountId: ledger2.id }))).id;
  });
  afterAll(async () => {
    await w.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses the mapping of the last committed import for the same account when its columns are present', async () => {
    const first = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: bankId, fileName: 'march.csv', content: MARCH }));
    expect(first.mapping).toBeNull();
    const mapping = {
      date: 'Posting Day',
      description: 'Merchant Info',
      memo: 'Note',
      reference: null,
      amounts: { amount: null, debit: 'Out', credit: 'In' },
      dateOrder: 'YMD' as const,
    };
    const remapped = await w.run(w.ctxA, (s) => remapBatch(s, storage, first.id, mapping));
    expect(remapped.errorCount).toBe(0);
    await w.run(w.ctxA, (s) => commitBatch(s, remapped.id));

    const april = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: bankId, fileName: 'april.csv', content: APRIL }));
    expect(april.mapping).toEqual(mapping);
    expect(april.errorCount).toBe(0);
    expect(april.rows!.map((r) => r.amount)).toEqual(['-5', '-1200']);

    // Another account doesn't inherit it.
    const other = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: otherBankId, fileName: 'april.csv', content: APRIL }));
    expect(other.mapping).toBeNull();
  });

  it('falls back to header detection when the saved columns are missing', async () => {
    const changed = `Date,Description,Amount\n04/10/2026,COFFEE,-4.00\n`;
    const p = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: bankId, fileName: 'new-format.csv', content: changed }));
    expect(p.mapping?.date).toBe('Date');
    expect(p.mapping?.amounts.amount).toBe('Amount');
    expect(p.errorCount).toBe(0);
  });
});
