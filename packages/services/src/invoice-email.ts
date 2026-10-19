import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, withSystem, type Db } from '@evenbooks/db';
import { randomUUID } from 'node:crypto';
import { renderInvoicePdf, invoiceLogoBytes, type EmailIdentityManager } from '@evenbooks/integrations';
import { invoiceEmailContent, type EmailContentOptions } from './invoice-email-content';
import { refreshCompanyEmailSender } from './company-email-senders';
import type { EmailSender, EmailConfig, ObjectStorage } from '@evenbooks/integrations';
import type { BulkInvoiceInput, BulkInvoiceItemResult, BulkInvoiceResultDto, EmailMessageDto, SendInvoiceEmailInput } from '@evenbooks/contracts';
import { ServiceError, notFound } from './errors';
import { runJobInCompany, type ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { enqueueOutbox } from './outbox';
import { bulkIssueInvoices, bulkResultError, loadInvoice } from './invoices';
import { generateInvoicePdf } from './invoice-pdf';

type EmailRow = typeof schema.emailMessages.$inferSelect;

export function toEmailDto(m: EmailRow): EmailMessageDto {
  return {
    id: m.id,
    kind: m.kind,
    invoiceId: m.invoiceId,
    toEmail: m.toEmail,
    fromEmail: m.contentSnapshot?.from ?? null,
    replyTo: m.contentSnapshot?.replyTo ?? null,
    templateVersion: m.templateVersion,
    subject: m.subject,
    status: m.status,
    providerMessageId: m.providerMessageId,
    attempts: m.attempts,
    lastError: m.lastError,
    isResend: m.isResend,
    requestedBy: m.requestedBy,
    queuedAt: m.queuedAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    failedAt: m.failedAt,
  };
}

/**
 * Sending quota per company. Invoice email goes out from the platform's own
 * sender identity to any address the user types, so an unlimited endpoint would
 * let a fresh sign-up relay mail through it until the provider paused sending
 * for every tenant. The tiers mirror the plan: a one-member free company has no
 * business sending hundreds of invoices a day. Automatic sends (recurring
 * invoices) count toward the quota but are never blocked by it.
 */
export const EMAIL_QUOTAS: Record<'free' | 'paid', { perHour: number; perDay: number }> = {
  free: { perHour: 20, perDay: 50 },
  paid: { perHour: 200, perDay: 1000 },
};

async function assertEmailQuota(s: ServiceContext): Promise<void> {
  const quota = EMAIL_QUOTAS[s.company.plan === 'paid' ? 'paid' : 'free'];
  const [row] = await s.tx
    .select({
      hour: sql<number>`count(*) filter (where ${schema.emailMessages.createdAt} > now() - interval '1 hour')::int`,
      day: sql<number>`count(*) filter (where ${schema.emailMessages.createdAt} > now() - interval '24 hours')::int`,
    })
    .from(schema.emailMessages)
    .where(and(eq(schema.emailMessages.companyId, s.ctx.companyId), sql`${schema.emailMessages.createdAt} > now() - interval '24 hours'`));
  if ((row?.hour ?? 0) >= quota.perHour) {
    throw new ServiceError('rate_limited', `This company has queued ${quota.perHour} emails in the last hour; try again later`, {
      limit: quota.perHour,
      window: 'hour',
    });
  }
  if ((row?.day ?? 0) >= quota.perDay) {
    throw new ServiceError('rate_limited', `This company has reached its daily limit of ${quota.perDay} emails`, { limit: quota.perDay, window: 'day' });
  }
}

/**
 * Queue an invoice email. The row is created as `queued` in the same
 * transaction as an outbox event; the worker performs the actual send. Sending
 * is never done inside a request or a ledger transaction.
 */
export async function queueInvoiceEmail(
  s: ServiceContext,
  invoiceId: string,
  input: SendInvoiceEmailInput & { isResend?: boolean; auto?: boolean },
  options: EmailContentOptions = {},
): Promise<EmailMessageDto> {
  return idempotent(s, input.idempotencyKey, { invoiceId, ...input }, async () => {
    const inv = await loadInvoice(s, invoiceId);
    if (inv.status === 'draft') throw new ServiceError('invalid_state', 'Issue the invoice before sending it');
    if (inv.status === 'void') throw new ServiceError('invalid_state', 'Void invoices cannot be sent');
    if (!input.auto) await assertEmailQuota(s);
    const [suppressed] = await s.tx
      .select({ id: schema.emailSuppressions.id, reason: schema.emailSuppressions.reason })
      .from(schema.emailSuppressions)
      .where(and(eq(schema.emailSuppressions.companyId, s.ctx.companyId), sql`lower(${schema.emailSuppressions.email}) = lower(${input.to})`));
    const dedupeKey = input.idempotencyKey ? `email:${invoiceId}:${input.idempotencyKey}` : `email:${invoiceId}:${input.auto ? 'auto' : Date.now()}`;
    const content = await invoiceEmailContent(s, invoiceId, { ...options, ...input });
    const { templateVersion, pdfAttachmentId, ...contentSnapshot } = content;
    const [row] = await s.tx
      .insert(schema.emailMessages)
      .values({
        companyId: s.ctx.companyId,
        kind: 'invoice',
        invoiceId,
        toEmail: input.to,
        subject: content.subject,
        contentSnapshot,
        templateVersion,
        pdfAttachmentId,
        replyTo: content.replyTo,
        status: suppressed ? 'suppressed' : 'queued',
        lastError: suppressed ? `Address suppressed: ${suppressed.reason}` : null,
        isResend: input.isResend ?? false,
        requestedBy: s.ctx.actorId,
        dedupeKey,
      })
      .onConflictDoNothing({ target: [schema.emailMessages.companyId, schema.emailMessages.dedupeKey] })
      .returning();
    if (!row) {
      const [existing] = await s.tx
        .select()
        .from(schema.emailMessages)
        .where(and(eq(schema.emailMessages.companyId, s.ctx.companyId), eq(schema.emailMessages.dedupeKey, dedupeKey)));
      return toEmailDto(existing!);
    }
    if (!suppressed) {
      await enqueueOutbox(s, 'email.send', { emailMessageId: row.id, invoiceId, message: input.message ?? null }, `email.send:${row.id}`);
    }
    await recordAudit(s, {
      action: input.isResend ? 'invoice.email_resend_requested' : 'invoice.email_queued',
      entityType: 'invoice',
      entityId: invoiceId,
      details: { emailMessageId: row.id, to: input.to, suppressed: Boolean(suppressed) },
    });
    return toEmailDto(row);
  });
}

export async function queueTestInvoiceEmail(
  s: ServiceContext,
  input: { to: string; idempotencyKey: string; presentation: NonNullable<EmailContentOptions['presentation']> },
) {
  return idempotent(s, input.idempotencyKey, input, async () => {
    await assertEmailQuota(s);
    const [suppressed] = await s.tx
      .select()
      .from(schema.emailSuppressions)
      .where(and(eq(schema.emailSuppressions.companyId, s.ctx.companyId), sql`lower(email) = lower(${input.to})`));
    if (suppressed) throw new ServiceError('invalid_state', 'This test address is on the suppression list');
    const content = await invoiceEmailContent(s, undefined, { presentation: input.presentation });
    const { templateVersion, pdfAttachmentId, ...contentSnapshot } = content;
    const [row] = await s.tx
      .insert(schema.emailMessages)
      .values({
        companyId: s.ctx.companyId,
        kind: 'invoice_test',
        toEmail: input.to,
        subject: content.subject,
        contentSnapshot,
        templateVersion,
        pdfAttachmentId,
        replyTo: content.replyTo,
        requestedBy: s.ctx.actorId,
        dedupeKey: `test:${input.idempotencyKey}`,
      })
      .returning();
    await enqueueOutbox(s, 'email.send', { emailMessageId: row!.id, invoiceId: null, message: null }, `email.send:${row!.id}`);
    await recordAudit(s, { action: 'email.test_queued', entityType: 'company', entityId: s.ctx.companyId, details: { to: input.to, emailMessageId: row!.id } });
    return toEmailDto(row!);
  });
}

export async function listInvoiceEmails(s: ServiceContext, invoiceId: string): Promise<EmailMessageDto[]> {
  const rows = await s.tx
    .select()
    .from(schema.emailMessages)
    .where(and(eq(schema.emailMessages.companyId, s.ctx.companyId), eq(schema.emailMessages.invoiceId, invoiceId)))
    .orderBy(desc(schema.emailMessages.createdAt));
  return rows.map(toEmailDto);
}

/**
 * Email many invoices to their customers. The address is the one on the
 * invoice (the customer snapshot), falling back to the contact's current
 * email; invoices with neither are skipped and reported. Each item runs in its
 * own savepoint with its own idempotency key (the email dedupe key), so a
 * retry never queues a second copy.
 */
export async function bulkSendInvoices(
  s: ServiceContext,
  items: { id: string; idempotencyKey: string }[],
  message?: string | null,
): Promise<BulkInvoiceResultDto> {
  const seen = new Set<string>();
  const results: BulkInvoiceItemResult[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      results.push({ id: item.id, number: null, ok: false, error: { code: 'duplicate', message: 'Listed more than once in this request' } });
      continue;
    }
    seen.add(item.id);
    try {
      const out = await s.tx.transaction(async (tx) => {
        const ss = { ...s, tx };
        const inv = await loadInvoice(ss, item.id);
        if (inv.status === 'draft') throw new ServiceError('invalid_state', 'Issue the invoice before sending it');
        if (inv.status === 'void') throw new ServiceError('invalid_state', 'Void invoices cannot be sent');
        let to = inv.customerSnapshot?.email?.trim() || null;
        if (!to) {
          const [c] = await tx
            .select({ email: schema.contacts.email })
            .from(schema.contacts)
            .where(and(eq(schema.contacts.companyId, s.ctx.companyId), eq(schema.contacts.id, inv.contactId)));
          to = c?.email?.trim() || null;
        }
        if (!to) return { number: inv.number, email: null };
        // "Resend" ignores this request's own message so a retry replays the same payload.
        const dedupeKey = `email:${item.id}:${item.idempotencyKey}`;
        const [prior] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.emailMessages)
          .where(
            and(
              eq(schema.emailMessages.companyId, s.ctx.companyId),
              eq(schema.emailMessages.invoiceId, item.id),
              sql`${schema.emailMessages.dedupeKey} is distinct from ${dedupeKey}`,
            ),
          );
        const email = await queueInvoiceEmail(ss, item.id, {
          to,
          message: message ?? null,
          idempotencyKey: item.idempotencyKey,
          isResend: (prior?.n ?? 0) > 0,
        });
        return { number: inv.number, email };
      });
      if (!out.email) {
        results.push({ id: item.id, number: out.number, ok: false, skipped: true, error: { code: 'no_email', message: 'The customer has no email address' } });
      } else if (out.email.status === 'suppressed') {
        results.push({
          id: item.id,
          number: out.number,
          ok: false,
          email: out.email,
          error: { code: 'suppressed', message: out.email.lastError ?? 'The address is on the suppression list' },
        });
      } else {
        results.push({ id: item.id, number: out.number, ok: true, email: out.email });
      }
    } catch (err) {
      results.push({ id: item.id, number: null, ok: false, error: bulkResultError(err) });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  return { action: 'send', results, succeeded, failed: results.length - succeeded - skipped, skipped };
}

/** `POST /api/invoices/bulk`: issue drafts or email issued invoices, with a result per invoice. */
export async function bulkInvoiceAction(s: ServiceContext, input: BulkInvoiceInput): Promise<BulkInvoiceResultDto> {
  if (input.action === 'issue') return bulkIssueInvoices(s, input.items);
  return bulkSendInvoices(s, input.items, input.message);
}

export interface SendDeps {
  db: Db;
  storage: ObjectStorage;
  sender: EmailSender;
  config: EmailConfig;
  baseUrl: string;
  identities?: EmailIdentityManager;
}

/**
 * Worker job: perform the send for a queued message. State machine:
 *   queued → sending → sent | failed (permanent) | queued (transient, retried by the job) | uncertain
 * The message row is marked `sending` in its own committed transaction before
 * the network call so a crash mid-send leaves an `uncertain` row for review
 * rather than a silent duplicate. Never exactly-once; see docs/financial-policy.md.
 */
export async function sendQueuedEmail(
  deps: SendDeps,
  emailMessageId: string,
  customMessage: string | null,
  jobId?: string,
): Promise<{ status: EmailRow['status'] }> {
  const head = await withSystem(deps.db, async (tx) => {
    const [m] = await tx.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailMessageId));
    return m ?? null;
  });
  if (!head) throw notFound('Email message');
  if (head.status !== 'queued') return { status: head.status };
  const ctx = { companyId: head.companyId, actorId: head.requestedBy, actorType: 'job' as const, jobId };

  // Phase 1: prepare (mark sending, load everything, ensure PDF) and commit.
  const prepared = await runJobInCompany(deps.db, ctx, async (s) => {
    const [claimed] = await s.tx
      .update(schema.emailMessages)
      .set({ status: 'sending', attempts: sql`${schema.emailMessages.attempts} + 1` })
      .where(and(eq(schema.emailMessages.id, emailMessageId), eq(schema.emailMessages.status, 'queued')))
      .returning();
    if (!claimed) return null;
    const inv = claimed.invoiceId ? await loadInvoice(s, claimed.invoiceId) : null;
    const content =
      claimed.contentSnapshot ??
      (await invoiceEmailContent(s, claimed.invoiceId ?? undefined, {
        message: customMessage,
        subject: claimed.subject,
        usePlatformSender: true,
        config: deps.config,
        baseUrl: deps.baseUrl,
      }));
    if (content.senderIdentityId) {
      const identity = deps.identities
        ? await refreshCompanyEmailSender(s, content.senderIdentityId, deps.identities)
        : (
            await s.tx
              .select()
              .from(schema.companyEmailSenders)
              .where(and(eq(schema.companyEmailSenders.id, content.senderIdentityId), eq(schema.companyEmailSenders.companyId, s.ctx.companyId)))
          )[0];
      if (!identity || identity.status !== 'verified') {
        await s.tx
          .update(schema.emailMessages)
          .set({
            status: 'failed',
            lastError: 'The company sender is no longer verified. Repair it or resend explicitly using the Evenbooks sender.',
            failedAt: new Date().toISOString(),
          })
          .where(eq(schema.emailMessages.id, emailMessageId));
        await recordAudit(s, {
          action: 'invoice.email_failed',
          entityType: inv ? 'invoice' : 'company',
          entityId: inv?.id ?? s.ctx.companyId,
          details: { emailMessageId, error: 'Company sender verification lost' },
        });
        return { blocked: true as const };
      }
    }
    let attachmentId = claimed.pdfAttachmentId;
    if (!attachmentId && inv)
      attachmentId = (
        await generateInvoicePdf(s, deps.storage, inv.id, 'email_snapshot', { baseUrl: deps.baseUrl, data: content.pdfData, preserveCurrentPdf: true })
      ).attachmentId;
    if (!attachmentId && content.sample) {
      const id = randomUUID();
      const objectKey = `companies/${s.ctx.companyId}/invoice_pdf/${id}/sample.pdf`;
      const pdf = await renderInvoicePdf(content.pdfData!);
      const stored = await deps.storage.putObject(objectKey, pdf, 'application/pdf');
      await s.tx.insert(schema.attachments).values({
        id,
        companyId: s.ctx.companyId,
        kind: 'invoice_pdf',
        objectKey,
        fileName: 'sample-invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: stored.size,
        sha256: stored.sha256,
        status: 'uploaded',
        completedAt: new Date().toISOString(),
        uploadedBy: s.ctx.actorId,
      });
      attachmentId = id;
    }
    const [att] = await s.tx.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId!));
    if (!att) throw notFound('Invoice PDF');
    // Check storage before committing sending. A missing file remains retryable and never sends without a PDF.
    const pdf = await deps.storage.getObject(att.objectKey);
    if (!pdf) throw new ServiceError('external_error', 'Invoice PDF is missing from storage');
    await s.tx
      .update(schema.emailMessages)
      .set({ pdfAttachmentId: attachmentId, contentSnapshot: content, replyTo: content.replyTo })
      .where(eq(schema.emailMessages.id, emailMessageId));
    return { blocked: false as const, claimed, inv, att, pdf, content };
  });
  if (!prepared) return { status: head.status };
  if (prepared.blocked) return { status: 'failed' };

  // Phase 2: provider call after the sending state and exact content have committed.
  const { claimed, inv, att, pdf, content } = prepared;
  const attachments: NonNullable<Parameters<EmailSender['send']>[0]['attachments']> = [
    { fileName: att.fileName, contentType: 'application/pdf', content: pdf.body },
  ];
  if (content.logo) {
    const logo = invoiceLogoBytes(content.logo);
    attachments.push({
      fileName: logo.contentType === 'image/png' ? 'logo.png' : 'logo.jpg',
      contentType: logo.contentType,
      content: logo.bytes,
      inline: true,
      contentId: 'company-logo',
    });
  }
  const outcome = await deps.sender.send({
    companyId: head.companyId,
    to: claimed.toEmail,
    from: content.from,
    replyTo: content.replyTo,
    subject: content.subject,
    text: content.text,
    html: content.html,
    attachments,
    tags: { company_id: head.companyId, ...(inv && { invoice_id: inv.id }), email_message_id: emailMessageId },
    configurationSet: deps.config.configurationSet,
  });

  // Phase 3: record the outcome (committed before any retry signal is raised).
  const recorded = await runJobInCompany(deps.db, ctx, async (s) => {
    if (outcome.ok) {
      await s.tx
        .update(schema.emailMessages)
        .set({ status: 'sent', providerMessageId: outcome.providerMessageId, sentAt: new Date().toISOString(), lastError: null })
        .where(eq(schema.emailMessages.id, emailMessageId));
      if (inv) await s.tx.update(schema.invoices).set({ lastSentAt: new Date().toISOString() }).where(eq(schema.invoices.id, inv.id));
      await recordAudit(s, {
        action: 'invoice.email_sent',
        entityType: inv ? 'invoice' : 'company',
        entityId: inv?.id ?? head.companyId,
        details: { emailMessageId, to: claimed.toEmail, providerMessageId: outcome.providerMessageId },
      });
      return { status: 'sent' as const };
    }
    const status = outcome.transient && claimed.attempts < 5 ? ('queued' as const) : ('failed' as const);
    await s.tx
      .update(schema.emailMessages)
      .set({ status, lastError: outcome.error, failedAt: status === 'failed' ? new Date().toISOString() : null })
      .where(eq(schema.emailMessages.id, emailMessageId));
    await recordAudit(s, {
      action: status === 'failed' ? 'invoice.email_failed' : 'invoice.email_retry',
      entityType: inv ? 'invoice' : 'company',
      entityId: inv?.id ?? head.companyId,
      details: { emailMessageId, error: outcome.error },
    });
    return { status, error: outcome.error };
  });
  if (recorded.status === 'queued') throw new ServiceError('external_error', `Transient email failure: ${recorded.error}`);
  return { status: recorded.status };
}

/** Mark messages stuck in `sending` (crash between send and record) as uncertain for review. */
export async function markStuckSendsUncertain(db: Db, olderThanMinutes = 10): Promise<number> {
  return withSystem(db, async (tx) => {
    const stale = await tx.execute<{ id: string; company_id: string }>(sql`
      select id, company_id from email_messages
      where status = 'sending' and updated_at < now() - (${olderThanMinutes}::text || ' minutes')::interval order by company_id, id`);
    let count = 0;
    for (const row of stale.rows) {
      await tx.execute(sql`select set_config('app.company_id', ${row.company_id}, true)`);
      const changed = await tx.execute(sql`
        update email_messages set status = 'uncertain', last_error = coalesce(last_error, 'Send did not complete; delivery unknown')
        where id = ${row.id} and company_id = ${row.company_id} and status = 'sending'
          and updated_at < now() - (${olderThanMinutes}::text || ' minutes')::interval returning id`);
      count += changed.rows.length;
    }
    return count;
  });
}

/**
 * Provider event ingestion (SES via SNS). Runs in system context because the
 * event carries only the provider message id; the company comes from the
 * message row. Bounces/complaints add local suppressions.
 */
export interface ProviderEvent {
  provider: 'ses';
  providerMessageId: string;
  providerEventId: string | null;
  eventType: string;
  occurredAt: string | null;
  payload: Record<string, unknown>;
  bounceType?: string | null;
  recipients?: string[];
}

export async function ingestEmailEvent(db: Db, evt: ProviderEvent): Promise<{ matched: boolean }> {
  return withSystem(db, async (tx) => {
    const [m] = await tx
      .select()
      .from(schema.emailMessages)
      .where(and(eq(schema.emailMessages.provider, evt.provider), eq(schema.emailMessages.providerMessageId, evt.providerMessageId)));
    await tx
      .insert(schema.emailEvents)
      .values({
        companyId: m?.companyId ?? null,
        emailMessageId: m?.id ?? null,
        provider: evt.provider,
        providerMessageId: evt.providerMessageId,
        eventType: evt.eventType,
        payload: evt.payload,
        occurredAt: evt.occurredAt,
        providerEventId: evt.providerEventId,
      })
      .onConflictDoNothing();
    if (!m) return { matched: false };
    await tx.execute(sql`select set_config('app.company_id', ${m.companyId}, true)`);
    const type = evt.eventType.toLowerCase();
    if (type === 'delivery') {
      await tx
        .update(schema.emailMessages)
        .set({ status: 'delivered', deliveredAt: evt.occurredAt ?? new Date().toISOString() })
        .where(eq(schema.emailMessages.id, m.id));
    } else if (type === 'bounce') {
      const permanent = (evt.bounceType ?? '').toLowerCase() === 'permanent';
      await tx
        .update(schema.emailMessages)
        .set({ status: 'bounced', failedAt: evt.occurredAt ?? new Date().toISOString(), lastError: `Bounce (${evt.bounceType ?? 'unknown'})` })
        .where(eq(schema.emailMessages.id, m.id));
      if (permanent) {
        for (const r of evt.recipients ?? [m.toEmail]) {
          await tx
            .insert(schema.emailSuppressions)
            .values({ companyId: m.companyId, email: r, reason: 'Permanent bounce', source: 'ses' })
            .onConflictDoNothing();
        }
      }
    } else if (type === 'complaint') {
      await tx.update(schema.emailMessages).set({ status: 'complained', lastError: 'Recipient complaint' }).where(eq(schema.emailMessages.id, m.id));
      for (const r of evt.recipients ?? [m.toEmail]) {
        await tx.insert(schema.emailSuppressions).values({ companyId: m.companyId, email: r, reason: 'Complaint', source: 'ses' }).onConflictDoNothing();
      }
    } else if (type === 'reject') {
      await tx
        .update(schema.emailMessages)
        .set({ status: 'failed', failedAt: evt.occurredAt ?? new Date().toISOString(), lastError: 'Rejected by provider' })
        .where(eq(schema.emailMessages.id, m.id));
    }
    // Send / DeliveryDelay / others: recorded as events only
    return { matched: true };
  });
}

export async function listSuppressions(s: ServiceContext) {
  return s.tx
    .select()
    .from(schema.emailSuppressions)
    .where(eq(schema.emailSuppressions.companyId, s.ctx.companyId))
    .orderBy(desc(schema.emailSuppressions.createdAt));
}

export async function removeSuppression(s: ServiceContext, id: string) {
  await s.tx.delete(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.companyId, s.ctx.companyId), eq(schema.emailSuppressions.id, id)));
  await recordAudit(s, { action: 'email.suppression_removed', entityType: 'email_suppression', entityId: id });
}
