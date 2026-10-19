import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { schema, withSystem, type Db, type RecurringTemplate } from '@evenbooks/db';
import { Money, dueOccurrences, nextOccurrenceAfter, occurrenceDate, todayInTimeZone, zonedInstant, type ScheduleRule } from '@evenbooks/domain';
import type { CreateScheduleInput, ResumeScheduleInput, ScheduleDto, UpdateScheduleInput, RecurringTemplateInput } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict, unwrapDbError } from './errors';
import { runJobInCompany, type ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { computeDocument } from './documents';
import { createDraftInvoice, issueInvoice, loadInvoice } from './invoices';
import { getContact } from './contacts';
import { queueInvoiceEmail } from './invoice-email';

type ScheduleRow = typeof schema.recurringSchedules.$inferSelect;

/** Issuance runs at 06:00 company-local time on the occurrence date. */
const RUN_HOUR = 6;

function ruleOf(s: ScheduleRow): ScheduleRule {
  return { frequency: s.frequency, anchorDate: s.anchorDate, endDate: s.endDate };
}

function computeNext(s: ScheduleRow, timeZone: string): { nextOccurrenceDate: string | null; nextRunAt: string | null } {
  const next = nextOccurrenceAfter(ruleOf(s), s.lastIssuedIndex);
  if (!next) return { nextOccurrenceDate: null, nextRunAt: null };
  return { nextOccurrenceDate: next.date, nextRunAt: zonedInstant(next.date, timeZone, RUN_HOUR).toISOString() };
}

async function toDtos(s: ServiceContext, rows: ScheduleRow[], full: boolean): Promise<ScheduleDto[]> {
  if (rows.length === 0) return [];
  const contacts = await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, [...new Set(rows.map((r) => r.contactId))]));
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const out: ScheduleDto[] = [];
  for (const r of rows) {
    let occurrences: ScheduleDto['occurrences'];
    let catchUp: ScheduleDto['catchUp'];
    let templateTotal: string | undefined;
    if (full) {
      const invs = await s.tx
        .select({ id: schema.invoices.id, number: schema.invoices.number, status: schema.invoices.status, idx: schema.invoices.recurringOccurrenceIndex })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.recurringScheduleId, r.id)))
        .orderBy(desc(schema.invoices.recurringOccurrenceIndex));
      const rule = ruleOf(r);
      occurrences = invs.map((i) => ({ index: i.idx!, date: occurrenceDate(rule, i.idx!), invoiceId: i.id, invoiceNumber: i.number, invoiceStatus: i.status }));
      const today = todayInTimeZone(s.company.timeZone);
      catchUp = dueOccurrences(rule, r.lastIssuedIndex, today).map((o) => ({ index: o.index, date: o.date, invoiceId: null, invoiceNumber: null, invoiceStatus: null }));
      try {
        const computed = await computeDocument(s, r.template.lines, r.template.documentDiscount ?? null);
        templateTotal = computed.calc.total.toString();
      } catch {
        templateTotal = undefined;
      }
    }
    out.push({
      id: r.id,
      name: r.name,
      status: r.status,
      contactId: r.contactId,
      contactName: contactName.get(r.contactId),
      frequency: r.frequency,
      anchorDate: r.anchorDate,
      endDate: r.endDate,
      termsDays: r.termsDays,
      sendEmail: r.sendEmail,
      emailTo: r.emailTo,
      templateVersion: r.templateVersion,
      template: r.template as RecurringTemplateInput,
      templateTotal,
      lastIssuedIndex: r.lastIssuedIndex,
      lastIssuedAt: r.lastIssuedAt,
      nextOccurrenceDate: r.nextOccurrenceDate,
      nextRunAt: r.nextRunAt,
      pausedAt: r.pausedAt,
      createdFromInvoiceId: r.createdFromInvoiceId,
      occurrences,
      catchUp,
      version: r.version,
      createdAt: r.createdAt,
    });
  }
  return out;
}

async function loadSchedule(s: ServiceContext, id: string, forUpdate = false): Promise<ScheduleRow> {
  const q = s.tx
    .select()
    .from(schema.recurringSchedules)
    .where(and(eq(schema.recurringSchedules.companyId, s.ctx.companyId), eq(schema.recurringSchedules.id, id)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Recurring schedule');
  return row;
}

export async function listSchedules(s: ServiceContext): Promise<ScheduleDto[]> {
  const rows = await s.tx.select().from(schema.recurringSchedules).where(eq(schema.recurringSchedules.companyId, s.ctx.companyId)).orderBy(asc(schema.recurringSchedules.name));
  return toDtos(s, rows, false);
}

export async function getSchedule(s: ServiceContext, id: string): Promise<ScheduleDto> {
  return (await toDtos(s, [await loadSchedule(s, id)], true))[0]!;
}

/**
 * Create a schedule, optionally seeded from an issued invoice ("repeat this
 * invoice"). The invoice's contents are copied into a versioned template; the
 * invoice itself stays independent. Payment URLs are copied only on explicit
 * confirmation that the link is reusable.
 */
export async function createSchedule(s: ServiceContext, input: CreateScheduleInput): Promise<ScheduleDto> {
  let template: RecurringTemplate;
  let contactId = input.contactId;
  let fromInvoiceId: string | null = null;
  if (input.fromInvoiceId) {
    const inv = await loadInvoice(s, input.fromInvoiceId);
    if (inv.status === 'draft') throw new ServiceError('validation', 'Repeat an issued invoice, not a draft');
    const lines = await s.tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.lineNo));
    template = {
      lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount ?? null, incomeAccountId: l.incomeAccountId, taxRateIds: l.taxRateIds })),
      documentDiscount: inv.documentDiscount ?? null,
      memo: inv.memo,
      footer: inv.footer,
      paymentUrl: input.copyPaymentUrl ? inv.paymentUrl : null,
    };
    contactId = inv.contactId;
    fromInvoiceId = inv.id;
  } else {
    if (!input.template) throw new ServiceError('validation', 'Provide a template or a source invoice');
    if (!contactId) throw new ServiceError('validation', 'Choose a customer');
    template = { ...input.template, documentDiscount: input.template.documentDiscount ?? null, memo: input.template.memo ?? null, footer: input.template.footer ?? null, paymentUrl: input.template.paymentUrl ?? null };
  }
  const contact = await getContact(s, contactId!);
  if (!contact.isCustomer) throw new ServiceError('validation', 'This contact isn’t marked as a customer.');
  // Validate the template arithmetic now so failures surface at creation, not at 6am.
  await computeDocument(s, template.lines, template.documentDiscount ?? null);
  if (input.sendEmail && !(input.emailTo ?? contact.email)) throw new ServiceError('validation', `${contact.name} has no email address. Enter one to email each invoice, or turn emailing off.`);
  const draftRow: Partial<ScheduleRow> = {
    lastIssuedIndex: null,
    anchorDate: input.anchorDate,
    endDate: input.endDate ?? null,
    frequency: input.frequency,
  };
  const next = computeNext(draftRow as ScheduleRow, s.company.timeZone);
  const [row] = await s.tx
    .insert(schema.recurringSchedules)
    .values({
      companyId: s.ctx.companyId,
      contactId: contactId!,
      name: input.name.trim(),
      frequency: input.frequency,
      anchorDate: input.anchorDate,
      endDate: input.endDate ?? null,
      termsDays: input.termsDays ?? s.company.defaultTermsDays,
      sendEmail: input.sendEmail,
      emailTo: input.emailTo ?? contact.email ?? null,
      templateVersion: 1,
      template,
      createdFromInvoiceId: fromInvoiceId,
      createdBy: s.ctx.actorId,
      ...next,
    })
    .returning();
  await s.tx.insert(schema.recurringTemplateVersions).values({ companyId: s.ctx.companyId, scheduleId: row!.id, version: 1, template, createdBy: s.ctx.actorId });
  await recordAudit(s, { action: 'recurring.created', entityType: 'recurring_schedule', entityId: row!.id, details: { name: row!.name, frequency: row!.frequency, anchorDate: row!.anchorDate, fromInvoiceId } });
  return getSchedule(s, row!.id);
}

export async function updateSchedule(s: ServiceContext, id: string, input: UpdateScheduleInput): Promise<ScheduleDto> {
  const cur = await loadSchedule(s, id, true);
  if (cur.version !== input.version) throw versionConflict('Recurring schedule');
  if (cur.status === 'cancelled') throw new ServiceError('invalid_state', 'Cancelled schedules cannot be edited');
  const patch: Partial<ScheduleRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.endDate !== undefined) patch.endDate = input.endDate;
  if (input.termsDays !== undefined) patch.termsDays = input.termsDays;
  if (input.sendEmail !== undefined) patch.sendEmail = input.sendEmail;
  if (input.emailTo !== undefined) patch.emailTo = input.emailTo;
  // Emailing needs an address: fall back to the customer's, as creating a schedule does.
  if ((patch.sendEmail ?? cur.sendEmail) && !(patch.emailTo !== undefined ? patch.emailTo : cur.emailTo)) {
    const contact = await getContact(s, cur.contactId);
    if (!contact.email) throw new ServiceError('validation', `${contact.name} has no email address. Enter one to email each invoice, or turn emailing off.`);
    patch.emailTo = contact.email;
  }
  if (input.template) {
    const template: RecurringTemplate = { ...input.template, documentDiscount: input.template.documentDiscount ?? null, memo: input.template.memo ?? null, footer: input.template.footer ?? null, paymentUrl: input.template.paymentUrl ?? null };
    await computeDocument(s, template.lines, template.documentDiscount ?? null);
    patch.template = template;
    patch.templateVersion = cur.templateVersion + 1;
    await s.tx.insert(schema.recurringTemplateVersions).values({ companyId: s.ctx.companyId, scheduleId: id, version: cur.templateVersion + 1, template, createdBy: s.ctx.actorId });
  }
  const merged = { ...cur, ...patch } as ScheduleRow;
  const next = merged.status === 'active' ? computeNext(merged, s.company.timeZone) : {};
  const [row] = await s.tx
    .update(schema.recurringSchedules)
    .set({ ...patch, ...next, status: merged.status === 'active' && !nextOccurrenceAfter(ruleOf(merged), merged.lastIssuedIndex) ? 'completed' : merged.status })
    .where(and(eq(schema.recurringSchedules.id, id), eq(schema.recurringSchedules.version, input.version)))
    .returning();
  if (!row) throw versionConflict('Recurring schedule');
  await recordAudit(s, { action: 'recurring.updated', entityType: 'recurring_schedule', entityId: id, details: { fields: Object.keys(patch), templateVersion: row.templateVersion } });
  return getSchedule(s, id);
}

export async function pauseSchedule(s: ServiceContext, id: string, version: number): Promise<ScheduleDto> {
  const cur = await loadSchedule(s, id, true);
  if (cur.version !== version) throw versionConflict('Recurring schedule');
  if (cur.status !== 'active') throw new ServiceError('invalid_state', `This schedule is ${cur.status}.`);
  await s.tx.update(schema.recurringSchedules).set({ status: 'paused', pausedAt: new Date().toISOString(), nextRunAt: null }).where(eq(schema.recurringSchedules.id, id));
  await recordAudit(s, { action: 'recurring.paused', entityType: 'recurring_schedule', entityId: id });
  return getSchedule(s, id);
}

/**
 * Resume. The caller has seen the catch-up preview (`catchUp` on the DTO) and
 * chooses to issue every missed occurrence or to skip them. Skipping advances
 * `last_issued_index` past the missed occurrences so they can never be issued.
 */
export async function resumeSchedule(s: ServiceContext, id: string, input: ResumeScheduleInput): Promise<ScheduleDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const cur = await loadSchedule(s, id, true);
    if (cur.version !== input.version) throw versionConflict('Recurring schedule');
    if (cur.status !== 'paused') throw new ServiceError('invalid_state', `This schedule is ${cur.status}.`);
    const today = todayInTimeZone(s.company.timeZone);
    let lastIssuedIndex = cur.lastIssuedIndex;
    if (input.mode === 'skip') {
      const missed = dueOccurrences(ruleOf(cur), cur.lastIssuedIndex, today);
      if (missed.length) lastIssuedIndex = missed[missed.length - 1]!.index;
    }
    const merged = { ...cur, lastIssuedIndex } as ScheduleRow;
    const next = computeNext(merged, s.company.timeZone);
    await s.tx
      .update(schema.recurringSchedules)
      .set({ status: next.nextOccurrenceDate ? 'active' : 'completed', pausedAt: null, lastIssuedIndex, resumeFromIndex: input.mode === 'skip' ? lastIssuedIndex : null, ...next })
      .where(eq(schema.recurringSchedules.id, id));
    await recordAudit(s, { action: 'recurring.resumed', entityType: 'recurring_schedule', entityId: id, details: { mode: input.mode, skippedThrough: input.mode === 'skip' ? lastIssuedIndex : null } });
    if (input.mode === 'catch_up') {
      // Issue the backlog now (in this transaction) so the user sees the result immediately.
      await issueDueOccurrencesInternal(s, id, today);
    }
    return getSchedule(s, id);
  });
}

export async function cancelSchedule(s: ServiceContext, id: string, version: number, reason: string): Promise<ScheduleDto> {
  const cur = await loadSchedule(s, id, true);
  if (cur.version !== version) throw versionConflict('Recurring schedule');
  if (cur.status === 'cancelled') throw new ServiceError('invalid_state', 'Already cancelled');
  await s.tx.update(schema.recurringSchedules).set({ status: 'cancelled', nextRunAt: null, nextOccurrenceDate: null }).where(eq(schema.recurringSchedules.id, id));
  await recordAudit(s, { action: 'recurring.cancelled', entityType: 'recurring_schedule', entityId: id, reason });
  return getSchedule(s, id);
}

/**
 * Issue every due occurrence for one schedule. Each occurrence is created and
 * issued in a savepoint; the unique index on (company, schedule, occurrence)
 * makes concurrent runs and retries safe — a loser sees 23505, re-reads the
 * winner's invoice, and moves on. PDF/email are separate durable steps
 * triggered by the outbox event, so their failure never issues another invoice.
 */
async function issueDueOccurrencesInternal(s: ServiceContext, scheduleId: string, today: string): Promise<{ issued: string[]; skippedExisting: number }> {
  const sched = await loadSchedule(s, scheduleId, true);
  if (sched.status !== 'active' && sched.status !== 'paused') return { issued: [], skippedExisting: 0 };
  const due = dueOccurrences(ruleOf(sched), sched.lastIssuedIndex, today, 120);
  const issued: string[] = [];
  let skippedExisting = 0;
  let lastIndex = sched.lastIssuedIndex;
  for (const occ of due) {
    const existing = await s.tx
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.recurringScheduleId, scheduleId), eq(schema.invoices.recurringOccurrenceIndex, occ.index)));
    if (existing.length) {
      skippedExisting++;
      lastIndex = occ.index;
      continue;
    }
    try {
      await s.tx.transaction(async () => {
        const draft = await createDraftInvoice(s, {
          contactId: sched.contactId,
          issueDate: occ.date,
          termsDays: sched.termsDays,
          lines: sched.template.lines,
          documentDiscount: sched.template.documentDiscount ?? null,
          memo: sched.template.memo ?? null,
          footer: sched.template.footer ?? null,
          paymentUrl: sched.template.paymentUrl ?? null,
        });
        // Tag the draft with the occurrence before issuing (the unique index guards duplicates).
        await s.tx
          .update(schema.invoices)
          .set({ recurringScheduleId: scheduleId, recurringOccurrenceIndex: occ.index, templateVersion: sched.templateVersion })
          .where(eq(schema.invoices.id, draft.id));
        const issuedInv = await issueInvoice(s, draft.id, { version: draft.version + 1 });
        if (sched.sendEmail && sched.emailTo) {
          await queueInvoiceEmail(s, issuedInv.id, { to: sched.emailTo, auto: true, idempotencyKey: `recurring:${scheduleId}:${occ.index}` });
        }
        issued.push(issuedInv.id);
      });
      lastIndex = occ.index;
    } catch (err) {
      const e = unwrapDbError(err);
      if (e?.code === '23505' && /invoices_recurring_uq/.test(e.constraint ?? e.message ?? '')) {
        skippedExisting++;
        lastIndex = occ.index;
        continue;
      }
      throw err;
    }
  }
  if (lastIndex !== sched.lastIssuedIndex || due.length === 0) {
    const merged = { ...sched, lastIssuedIndex: lastIndex } as ScheduleRow;
    const next = computeNext(merged, s.company.timeZone);
    await s.tx
      .update(schema.recurringSchedules)
      .set({
        lastIssuedIndex: lastIndex,
        lastIssuedAt: issued.length ? new Date().toISOString() : sched.lastIssuedAt,
        ...next,
        status: sched.status === 'active' && !next.nextOccurrenceDate ? 'completed' : sched.status,
      })
      .where(eq(schema.recurringSchedules.id, scheduleId));
  }
  if (issued.length) {
    await recordAudit(s, { action: 'recurring.issued', entityType: 'recurring_schedule', entityId: scheduleId, details: { count: issued.length, invoiceIds: issued } });
  }
  return { issued, skippedExisting };
}

/** Worker entry point for one schedule (runs in job + company context). */
export async function runScheduleIssuance(db: Db, companyId: string, scheduleId: string, jobId?: string, now = new Date()) {
  return runJobInCompany(db, { companyId, actorId: 'recurring-scheduler', actorType: 'job', jobId }, async (s) => {
    const today = todayInTimeZone(s.company.timeZone, now);
    return issueDueOccurrencesInternal(s, scheduleId, today);
  });
}

/** Schedules whose next run is due (system context; cross-company). */
export async function dueSchedules(db: Db, now = new Date()): Promise<{ id: string; companyId: string }[]> {
  return withSystem(db, async (tx) =>
    tx
      .select({ id: schema.recurringSchedules.id, companyId: schema.recurringSchedules.companyId })
      .from(schema.recurringSchedules)
      .where(and(eq(schema.recurringSchedules.status, 'active'), lte(schema.recurringSchedules.nextRunAt, now.toISOString())))
      .orderBy(asc(schema.recurringSchedules.nextRunAt))
      .limit(500),
  );
}

export { sql, Money };
