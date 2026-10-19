import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { DEFAULT_INVOICE_BRANDING, DEFAULT_INVOICE_EMAIL } from '@evenbooks/domain';
import { FixtureEmailIdentityManager, LocalStorage, LogEmailSender, renderInvoicePdf } from '@evenbooks/integrations';
import { createWorld, type TestWorld } from './helpers';
import {
  createContact,
  createDraftInvoice,
  issueInvoice,
  getInvoicePresentation,
  updateInvoicePresentation,
  queueInvoiceEmail,
  sendQueuedEmail,
  updateCompany,
  setupCompanyEmailSender,
  cancelCompanyEmailSender,
  refreshCompanyEmailSender,
  selectCompanyEmailSender,
  listCompanyEmailSenders,
  getPublicInvoice,
  getPublicLink,
  generateInvoicePdf,
  queueTestInvoiceEmail,
  sampleInvoicePdf,
} from '../src';

let w: TestWorld, directory: string, storage: LocalStorage;
const config = { from: 'Evenbooks <billing@evenbooks.org>', replyTo: null, configurationSet: null };
const options = { config, baseUrl: 'https://evenbooks.test' };
const presentation = () => ({ branding: { ...DEFAULT_INVOICE_BRANDING }, email: { ...DEFAULT_INVOICE_EMAIL } });
async function issued() {
  const accounts = await w.accountsByCode(w.ctxA);
  const contact = await w.run(w.ctxA, (s) =>
    createContact(s, { name: 'Customer <script>', email: 'customer@example.test', isCustomer: true, isVendor: false }),
  );
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, {
      contactId: contact.id,
      issueDate: '2026-09-01',
      lines: [{ description: 'Consulting', quantity: '1', unitPrice: '100', incomeAccountId: accounts.get('4100')!, taxRateIds: [] }],
    }),
  );
  return w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
}
beforeAll(async () => {
  w = await createWorld();
  directory = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-branding-'));
  storage = new LocalStorage(directory);
});
afterAll(async () => {
  await w?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('invoice presentation and queued content', () => {
  it('versions settings, protects concurrent edits, and isolates companies', async () => {
    const initial = await w.run(w.ctxA, getInvoicePresentation);
    expect(initial.version).toBe(0);
    const next = await w.run(w.ctxA, (s) =>
      updateInvoicePresentation(s, {
        ...presentation(),
        version: 0,
        branding: {
          ...DEFAULT_INVOICE_BRANDING,
          layout: 'modern',
          accentColor: '#276749',
          defaultNotes: 'Thanks for your business',
          defaultFooter: 'Payment terms',
        },
      }),
    );
    expect(next.version).toBe(1);
    await expect(w.run(w.ctxA, (s) => updateInvoicePresentation(s, { ...presentation(), version: 0 }))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect((await w.run(w.ctxB, getInvoicePresentation)).version).toBe(0);
    await expect(
      w.run(w.ctxA, (s) =>
        updateInvoicePresentation(s, { ...presentation(), version: 1, email: { ...DEFAULT_INVOICE_EMAIL, subject: '{{unsupported}}' } }),
      ),
    ).rejects.toThrow();
    await expect(
      w.run(w.ctxA, (s) =>
        updateInvoicePresentation(s, {
          ...presentation(),
          version: 1,
          branding: { ...DEFAULT_INVOICE_BRANDING, logo: 'data:image/png;base64,YWJj' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });
  it('snapshots issuer, notes and branding at issue, with explicit PDF design changes', async () => {
    const invoice = await issued();
    expect(invoice.memo).toBe('Thanks for your business');
    expect(invoice.footer).toBe('Payment terms');
    await w.run(w.ctxA, (s) => updateCompany(s, { version: s.company.version, name: 'Renamed company' }));
    const current = await w.run(w.ctxA, getInvoicePresentation);
    await w.run(w.ctxA, (s) =>
      updateInvoicePresentation(s, {
        ...presentation(),
        version: current.version,
        branding: { ...DEFAULT_INVOICE_BRANDING, accentColor: '#ff0000', showQuantity: false, showUnitPrice: false, showLineTax: false },
      }),
    );
    const token = (await w.run(w.ctxA, (s) => getPublicLink(s, invoice.id, options.baseUrl))).url!.split('/').pop()!;
    let publicInvoice = (await getPublicInvoice(w.tdb.app.db, token))!.dto;
    expect(publicInvoice.company.name).toBe('Alpha LLC');
    expect(publicInvoice.branding?.accentColor).toBe('#276749');
    expect(publicInvoice.branding?.showQuantity).toBe(true);
    const first = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, invoice.id, 'original'));
    const second = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, invoice.id, 'design_updated', { applyCurrentDesign: true }));
    expect(second.version).toBe(first.version + 1);
    publicInvoice = (await getPublicInvoice(w.tdb.app.db, token))!.dto;
    expect(publicInvoice.company.name).toBe('Alpha LLC');
    expect(publicInvoice.branding?.accentColor).toBe('#ff0000');
    expect(publicInvoice.branding).toMatchObject({ showQuantity: false, showUnitPrice: false, showLineTax: false });
  });
  it('guards historical issuer details and append-only template versions at the database boundary', async () => {
    const invoice = await issued();
    const [row] = await w.run(w.ctxA, (s) => s.tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id)));
    await expect(
      w.run(w.ctxA, (s) =>
        s.tx
          .update(schema.invoices)
          .set({ designSnapshot: { ...row!.designSnapshot!, issuer: { ...row!.designSnapshot!.issuer, name: 'Forged issuer' } } })
          .where(eq(schema.invoices.id, invoice.id)),
      ),
    ).rejects.toThrow();
    await expect(
      w.run(w.ctxA, (s) =>
        s.tx.delete(schema.invoicePresentationVersions).where(eq(schema.invoicePresentationVersions.companyId, w.companyA)),
      ),
    ).rejects.toThrow();
  });
  it('keeps the existing company footer setting in sync without returning a stale version', async () => {
    await w.run(w.ctxA, (s) => updateCompany(s, { version: s.company.version, invoiceFooter: 'Updated footer' }));
    const settings = await w.run(w.ctxA, getInvoicePresentation);
    expect(settings.branding.defaultFooter).toBe('Updated footer');
    const updated = await w.run(w.ctxA, (s) => updateCompany(s, { version: s.company.version, invoiceFooter: 'Another footer' }));
    expect((await w.run(w.ctxA, async (s) => s.company)).version).toBe(updated.version);
    const current = await w.run(w.ctxA, getInvoicePresentation);
    await w.run(w.ctxA, (s) =>
      updateInvoicePresentation(s, { ...current, branding: { ...current.branding, defaultFooter: 'Template footer' } }),
    );
    expect((await w.run(w.ctxA, async (s) => s.company)).invoiceFooter).toBe('Template footer');
  });
  it('pins subject, body, sender and attachment across template edits and retries', async () => {
    const invoice = await issued();
    const first = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, invoice.id, 'first'));
    const queued = await w.run(w.ctxA, (s) =>
      queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test', message: 'First message', subject: 'Custom subject' }, options),
    );
    await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, invoice.id, 'second'));
    const current = await w.run(w.ctxA, getInvoicePresentation);
    await w.run(w.ctxA, (s) =>
      updateInvoicePresentation(s, {
        ...presentation(),
        version: current.version,
        email: { ...DEFAULT_INVOICE_EMAIL, message: 'Changed message', subject: 'Changed subject', replyTo: 'new@example.test' },
      }),
    );
    const sender = new LogEmailSender();
    const deps = { db: w.tdb.app.db, storage, sender, ...options };
    sender.failNext = { transient: true, error: 'Temporary outage' };
    await expect(sendQueuedEmail(deps, queued.id, null)).rejects.toMatchObject({ code: 'external_error' });
    expect(await sendQueuedEmail(deps, queued.id, 'Another message')).toEqual({ status: 'sent' });
    expect(sender.sent[0]?.subject).toBe('Custom subject');
    expect(sender.sent[0]?.text).toContain('First message');
    expect(sender.sent[0]?.text).not.toContain('Changed message');
    expect(sender.sent[0]?.from).toBe(config.from);
    expect(sender.sent[0]?.companyId).toBe(w.companyA);
    expect(sender.sent[0]?.replyTo).not.toBe('new@example.test');
    const [row] = await w.run(w.ctxA, (s) => s.tx.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, queued.id)));
    expect(row!.pdfAttachmentId).toBe(first.attachmentId);
    expect(row!.contentSnapshot?.html).not.toContain('<script>');
    await sendQueuedEmail(deps, queued.id, null);
    expect(sender.sent).toHaveLength(1);
  });
  it('keeps a newer public PDF current when an older queued email generates its snapshot', async () => {
    const invoice = await issued();
    const queued = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test' }, options));
    const newer = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, invoice.id, 'design_updated', { applyCurrentDesign: true }));
    const sender = new LogEmailSender();
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options }, queued.id, null);
    const [current] = await w.run(w.ctxA, (s) => s.tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id)));
    const [message] = await w.run(w.ctxA, (s) => s.tx.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, queued.id)));
    expect(current!.currentPdfAttachmentId).toBe(newer.attachmentId);
    expect(message!.pdfAttachmentId).not.toBe(newer.attachmentId);
    expect(sender.sent).toHaveLength(1);
  });
  it('preserves a legacy queued subject and renders old jobs through the platform sender', async () => {
    const invoice = await issued();
    const queued = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoice.id, { to: 'legacy@example.test' }, options));
    await w.run(w.ctxA, (s) =>
      s.tx
        .update(schema.emailMessages)
        .set({ contentSnapshot: null, subject: 'Legacy subject' })
        .where(eq(schema.emailMessages.id, queued.id)),
    );
    const sender = new LogEmailSender();
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options }, queued.id, 'Legacy message');
    expect(sender.sent[0]?.subject).toBe('Legacy subject');
    expect(sender.sent[0]?.text).toContain('Legacy message');
    expect(sender.sent[0]?.companyId).toBe(w.companyA);
    expect(sender.sent[0]?.from).toBe(config.from);
  });
  it('does not send without the saved PDF and leaves a storage failure retryable', async () => {
    const invoice = await issued();
    const version = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, invoice.id, 'original'));
    const queued = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test' }, options));
    const [attachment] = await w.run(w.ctxA, (s) =>
      s.tx.select().from(schema.attachments).where(eq(schema.attachments.id, version.attachmentId)),
    );
    const object = await storage.getObject(attachment!.objectKey);
    await storage.deleteObject(attachment!.objectKey);
    const sender = new LogEmailSender();
    const deps = { db: w.tdb.app.db, storage, sender, ...options };
    await expect(sendQueuedEmail(deps, queued.id, null)).rejects.toMatchObject({ code: 'external_error' });
    expect(sender.sent).toHaveLength(0);
    const [message] = await w.run(w.ctxA, (s) => s.tx.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, queued.id)));
    expect(message!.status).toBe('queued');
    await storage.putObject(attachment!.objectKey, object!.body, 'application/pdf');
    await sendQueuedEmail(deps, queued.id, null);
    expect(sender.sent).toHaveLength(1);
  });
});
describe('verified company senders', () => {
  it('cancels only its own pending setup and requires a fresh proof when restarted', async () => {
    const manager = new FixtureEmailIdentityManager();
    const input = { domain: 'cancel.example.test', fromEmail: 'billing@cancel.example.test', fromName: 'Company' };
    const sender = await w.run(w.ctxA, (s) => setupCompanyEmailSender(s, input, manager));
    await expect(w.run(w.ctxB, (s) => cancelCompanyEmailSender(s, sender.id))).rejects.toMatchObject({ code: 'not_found' });
    await w.run(w.ctxA, (s) => cancelCompanyEmailSender(s, sender.id));
    expect((await w.run(w.ctxA, listCompanyEmailSenders)).some((row) => row.id === sender.id)).toBe(false);
    await w.run(w.ctxA, (s) => cancelCompanyEmailSender(s, sender.id));
    const check = vi.spyOn(manager, 'check');
    expect((await w.run(w.ctxA, (s) => refreshCompanyEmailSender(s, sender.id, manager))).status).toBe('disabled');
    expect(check).not.toHaveBeenCalled();
    await expect(w.run(w.ctxA, (s) => selectCompanyEmailSender(s, sender.id))).rejects.toMatchObject({ code: 'invalid_state' });
    const restarted = await w.run(w.ctxA, (s) => setupCompanyEmailSender(s, input, manager));
    expect(restarted).toMatchObject({ id: sender.id, active: false, status: 'pending', checkedAt: null });
    expect(restarted.records[0]!.value).not.toBe(sender.records[0]!.value);
    manager.verifiedDomains.add(input.domain);
    manager.proofs.set(sender.records[0]!.name, sender.records[0]!.value);
    expect((await w.run(w.ctxA, (s) => refreshCompanyEmailSender(s, sender.id, manager))).status).toBe('pending');
    manager.proofs.set(restarted.records[0]!.name, restarted.records[0]!.value);
    expect((await w.run(w.ctxA, (s) => refreshCompanyEmailSender(s, sender.id, manager))).status).toBe('verified');
  });
  it('requires company-specific proof even when SES already trusts a shared domain', async () => {
    const manager = new FixtureEmailIdentityManager();
    manager.verifiedDomains.add('company.test');
    const data = { domain: 'company.test', fromEmail: 'billing@company.test', fromName: 'Company' };
    const a = await w.run(w.ctxA, (s) => setupCompanyEmailSender(s, data, manager));
    const b = await w.run(w.ctxB, (s) => setupCompanyEmailSender(s, data, manager));
    expect(a.records[0]!.value).not.toBe(b.records[0]!.value);
    manager.proofs.set(a.records[0]!.name, a.records[0]!.value);
    expect((await w.run(w.ctxA, (s) => refreshCompanyEmailSender(s, a.id, manager))).status).toBe('verified');
    expect((await w.run(w.ctxB, (s) => refreshCompanyEmailSender(s, b.id, manager))).status).toBe('pending');
    await expect(w.run(w.ctxB, (s) => selectCompanyEmailSender(s, a.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.run(w.ctxB, (s) => selectCompanyEmailSender(s, b.id))).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await w.run(w.ctxB, listCompanyEmailSenders)).map((x) => x.id)).toEqual([b.id]);
    await w.run(w.ctxA, (s) => selectCompanyEmailSender(s, a.id));
    const invoice = await issued();
    const queued = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test' }, options));
    expect(queued.fromEmail).toContain('billing@company.test');
    const sender = new LogEmailSender();
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options, identities: manager }, queued.id, null);
    expect(sender.sent[0]?.from).toContain('billing@company.test');
    expect(sender.sent[0]?.companyId).toBe(w.companyA);
    const pending = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test' }, options));
    manager.proofs.clear();
    expect(await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options, identities: manager }, pending.id, null)).toEqual({
      status: 'failed',
    });
    expect(sender.sent).toHaveLength(1);
    await expect(w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test' }, options))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    const fallback = await w.run(w.ctxA, (s) =>
      queueInvoiceEmail(s, invoice.id, { to: 'customer@example.test', usePlatformSender: true }, options),
    );
    expect(fallback.fromEmail).toBe(config.from);
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options, identities: manager }, fallback.id, null);
    expect(sender.sent[1]?.companyId).toBe(w.companyA);
    await w.run(w.ctxA, (s) => selectCompanyEmailSender(s, null));
  });
  it('rejects consumer domains and produces durable test emails with PDF attachments', async () => {
    await expect(
      w.run(w.ctxA, (s) =>
        setupCompanyEmailSender(
          s,
          { domain: 'gmail.com', fromEmail: 'company@gmail.com', fromName: 'Company' },
          new FixtureEmailIdentityManager(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    const test = await w.run(w.ctxA, (s) =>
      queueTestInvoiceEmail(s, { to: 'test@example.test', idempotencyKey: 'test-template', presentation: presentation() }),
    );
    const replay = await w.run(w.ctxA, (s) =>
      queueTestInvoiceEmail(s, { to: 'test@example.test', idempotencyKey: 'test-template', presentation: presentation() }),
    );
    expect(replay.id).toBe(test.id);
    const sender = new LogEmailSender();
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options }, test.id, null);
    expect(sender.sent[0]?.attachments?.[0]?.fileName).toBe('sample-invoice.pdf');
    expect(sender.sent[0]?.companyId).toBe(w.companyA);
    const outbox = await w.run(w.ctxA, (s) =>
      s.tx
        .select()
        .from(schema.outboxEvents)
        .where(and(eq(schema.outboxEvents.companyId, w.companyA), eq(schema.outboxEvents.dedupeKey, `email.send:${test.id}`))),
    );
    expect(outbox).toHaveLength(1);
  });
  it('records tenant pauses as permanent failures and never retries through the platform sender', async () => {
    const queued = await w.run(w.ctxB, (s) =>
      queueTestInvoiceEmail(s, { to: 'tenant-paused@example.test', idempotencyKey: 'tenant-paused', presentation: presentation() }),
    );
    const sender = new LogEmailSender();
    const send = vi.spyOn(sender, 'send');
    sender.failNext = { transient: false, error: 'Email sending for this company is paused by SES. Please contact support.' };
    const deps = { db: w.tdb.app.db, storage, sender, ...options };
    expect(await sendQueuedEmail(deps, queued.id, null)).toEqual({ status: 'failed' });
    expect(send.mock.calls[0]?.[0].companyId).toBe(w.companyB);
    expect(await sendQueuedEmail(deps, queued.id, null)).toEqual({ status: 'failed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sender.sent).toHaveLength(0);
    const [row] = await w.run(w.ctxB, (s) => s.tx.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, queued.id)));
    expect(row).toMatchObject({ status: 'failed', lastError: expect.stringContaining('paused by SES') });
    expect(row?.failedAt).not.toBeNull();
  });
  it('validates raster logos and embeds them inline in durable emails', async () => {
    const input = {
      ...presentation(),
      branding: {
        ...DEFAULT_INVOICE_BRANDING,
        logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQT/ekKWIYtWDUglELRi0YtWDUglELRi0YtWDUglELhooFAHWiXC65AlfZAAAAAElFTkSuQmCC',
      },
    };
    const current = await w.run(w.ctxA, getInvoicePresentation);
    await w.run(w.ctxA, (s) => updateInvoicePresentation(s, { ...input, version: current.version }));
    const queued = await w.run(w.ctxA, (s) =>
      queueTestInvoiceEmail(s, { to: 'logo@example.test', idempotencyKey: 'logo-test', presentation: input }),
    );
    const sender = new LogEmailSender();
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, ...options }, queued.id, null);
    expect(sender.sent[0]?.html).toContain('cid:company-logo');
    expect(sender.sent[0]?.attachments?.[1]).toMatchObject({ contentType: 'image/png', inline: true, contentId: 'company-logo' });
    expect(sender.sent[0]?.attachments?.[0]?.content.byteLength).toBeGreaterThan(1000);
  });
  it('renders long invoices in both paper sizes with notes and a footer', async () => {
    for (const paperSize of ['LETTER', 'A4'] as const) {
      const data = sampleInvoicePdf(
        { name: 'Company', email: null, phone: null, address: {} },
        { ...DEFAULT_INVOICE_BRANDING, paperSize, layout: 'modern', paymentInstructions: 'Bank transfer details' },
      );
      data.lines = Array.from({ length: 120 }, (_, i) => ({
        ...data.lines[0]!,
        description: `Line ${i + 1} ` + 'Detailed service description '.repeat(8),
      }));
      data.memo = 'Long note paragraph.\n'.repeat(60);
      data.footer = 'Thank you';
      const pdf = await renderInvoicePdf(data);
      expect(pdf.toString('ascii', 0, 8)).toBe('%PDF-1.3');
      expect(pdf.length).toBeGreaterThan(10000);
    }
  });
});
