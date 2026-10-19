import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from '@evenbooks/integrations';
import { createPurchase, listAttachmentsFor, uploadAttachment } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

// "Attach receipt" on a saved expense uploads straight onto the record.
let w: TestWorld;
let acct: Map<string, string>;
let storage: LocalStorage;
let tmpDir: string;

const pdf = () => new TextEncoder().encode('%PDF-1.4 test');

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-storage-'));
  storage = new LocalStorage(tmpDir);
});
afterAll(async () => {
  await w.destroy();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('uploading onto a saved record', () => {
  it('links the file to an existing purchase at once', async () => {
    const p = await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-03-08', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5110')!, description: 'Ink', amount: '40' }], attachmentIds: [] }),
    );
    const att = await w.run(w.ctxA, (s) => uploadAttachment(s, storage, { kind: 'receipt', fileName: 'ink.pdf', contentType: 'application/pdf', body: pdf(), entityType: 'purchase', entityId: p.id }));
    expect(att).toMatchObject({ entityType: 'purchase', entityId: p.id, status: 'uploaded' });
    const list = await w.run(w.ctxA, (s) => listAttachmentsFor(s, 'purchase', p.id));
    expect(list.map((a) => a.fileName)).toEqual(['ink.pdf']);
  });

  it("refuses another company's record, unknown record types and half-given links", async () => {
    const p = await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-03-09', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5110')!, description: 'Paper', amount: '9' }], attachmentIds: [] }),
    );
    const upload = (entityType: string | null, entityId: string | null) => (s: Parameters<typeof uploadAttachment>[0]) =>
      uploadAttachment(s, storage, { kind: 'receipt', fileName: 'r.pdf', contentType: 'application/pdf', body: pdf(), entityType, entityId });
    await expect(w.run(w.ctxB, upload('purchase', p.id))).rejects.toMatchObject({ code: 'not_found', message: 'Expense not found' });
    await expect(w.run(w.ctxA, upload('company', p.id))).rejects.toMatchObject({ code: 'validation' });
    await expect(w.run(w.ctxA, upload('purchase', null))).rejects.toMatchObject({ code: 'validation' });
  });
});
