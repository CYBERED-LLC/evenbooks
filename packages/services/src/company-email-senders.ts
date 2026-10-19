import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { schema, withSystem, type Db } from '@evenbooks/db';
import { SenderSetupInput, type SenderIdentityDto } from '@evenbooks/contracts';
import type { EmailIdentityManager, EmailConfig } from '@evenbooks/integrations';
import type { ServiceContext } from './context';
import { runJobInCompany } from './context';
import { ServiceError, notFound } from './errors';
import { recordAudit } from './audit';

type SenderRow = typeof schema.companyEmailSenders.$inferSelect;
export function senderProofName(row: Pick<SenderRow, 'companyId' | 'domain'>) {
  return `_evenbooks-${row.companyId}.${row.domain}`;
}
export function toSenderDto(row: SenderRow): SenderIdentityDto {
  return {
    id: row.id,
    domain: row.domain,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    status: row.status,
    active: row.active,
    checkedAt: row.checkedAt,
    lastError: row.lastError,
    records: [
      { name: senderProofName(row), type: 'TXT', value: row.proofToken, purpose: 'Authorize this company' },
      ...row.dkimTokens.map((token) => ({
        name: `${token}._domainkey.${row.domain}`,
        type: 'CNAME' as const,
        value: `${token}.dkim.amazonses.com`,
        purpose: 'Authenticate invoice emails',
      })),
    ],
  };
}
export async function listCompanyEmailSenders(s: ServiceContext) {
  const rows = await s.tx.select().from(schema.companyEmailSenders).where(and(
    eq(schema.companyEmailSenders.companyId, s.ctx.companyId),
    ne(schema.companyEmailSenders.status, 'disabled'),
  ));
  return rows.map(toSenderDto);
}
export async function setupCompanyEmailSender(s: ServiceContext, input: unknown, manager: EmailIdentityManager) {
  const data = SenderSetupInput.parse(input);
  if (
    ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com'].includes(
      data.domain,
    )
  )
    throw new ServiceError('validation', 'Use a domain your company controls. Personal mailbox providers require a separate mailbox connection.');
  const status = await manager.create(data.domain);
  await s.tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, s.ctx.companyId)).for('update');
  const [existing] = await s.tx
    .select()
    .from(schema.companyEmailSenders)
    .where(and(eq(schema.companyEmailSenders.companyId, s.ctx.companyId), eq(schema.companyEmailSenders.domain, data.domain)));
  const values = {
    ...data,
    companyId: s.ctx.companyId,
    proofToken: existing && existing.status !== 'disabled' ? existing.proofToken : `evenbooks-verification=${randomBytes(24).toString('hex')}`,
    dkimTokens: status.dkimTokens,
    status: 'pending' as const,
    active: existing?.status !== 'disabled' && existing?.active === true,
    checkedAt: null,
    lastError: manager.driver === 'log' ? 'Local email driver: emails are logged; domain verification requires SES.' : null,
  };
  const [row] = existing
    ? await s.tx.update(schema.companyEmailSenders).set(values).where(eq(schema.companyEmailSenders.id, existing.id)).returning()
    : await s.tx.insert(schema.companyEmailSenders).values(values).returning();
  await recordAudit(s, {
    action: 'email.sender_configured',
    entityType: 'company',
    entityId: s.ctx.companyId,
    details: { domain: data.domain, fromEmail: data.fromEmail },
  });
  return toSenderDto(row!);
}
/** Cancel only this company's setup. SES identities can be shared by other companies. */
export async function cancelCompanyEmailSender(s: ServiceContext, id: string) {
  await s.tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, s.ctx.companyId)).for('update');
  const [row] = await s.tx.select().from(schema.companyEmailSenders)
    .where(and(eq(schema.companyEmailSenders.companyId, s.ctx.companyId), eq(schema.companyEmailSenders.id, id))).for('update');
  if (!row) throw notFound('Sender identity');
  if (row.status === 'disabled') return listCompanyEmailSenders(s);
  if (row.status === 'verified') throw new ServiceError('invalid_state', 'This domain is already verified. Select the Evenbooks sender to stop using it.');
  await s.tx.update(schema.companyEmailSenders)
    .set({ status: 'disabled', active: false, lastError: null, checkedAt: null })
    .where(eq(schema.companyEmailSenders.id, id));
  await recordAudit(s, {
    action: 'email.sender_verification_cancelled',
    entityType: 'company',
    entityId: s.ctx.companyId,
    details: { senderIdentityId: id, domain: row.domain },
  });
  return listCompanyEmailSenders(s);
}
export async function refreshCompanyEmailSender(s: ServiceContext, id: string, manager: EmailIdentityManager) {
  const [row] = await s.tx
    .select()
    .from(schema.companyEmailSenders)
    .where(and(eq(schema.companyEmailSenders.companyId, s.ctx.companyId), eq(schema.companyEmailSenders.id, id)))
    .for('update');
  if (!row) throw notFound('Sender identity');
  if (row.status === 'disabled') return toSenderDto(row);
  const provider = await manager.check(row.domain);
  const owned = await manager.provesOwnership(senderProofName(row), row.proofToken);
  const verified = provider.verified && owned;
  // Verification loss leaves the active selection intact so delivery fails visibly.
  const status = verified
    ? ('verified' as const)
    : row.status === 'verified'
      ? ('failed' as const)
      : ('pending' as const);
  const lastError = verified ? null : !owned ? 'Waiting for the company authorization TXT record' : provider.error;
  const [updated] = await s.tx
    .update(schema.companyEmailSenders)
    .set({ status, dkimTokens: provider.dkimTokens, lastError, checkedAt: new Date().toISOString() })
    .where(eq(schema.companyEmailSenders.id, id))
    .returning();
  if (row.status !== status)
    await recordAudit(s, {
      action: 'email.sender_status_changed',
      entityType: 'company',
      entityId: s.ctx.companyId,
      details: { senderIdentityId: id, status },
    });
  return toSenderDto(updated!);
}
export async function selectCompanyEmailSender(s: ServiceContext, id: string | null) {
  await s.tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, s.ctx.companyId)).for('update');
  if (id) {
    const [row] = await s.tx
      .select()
      .from(schema.companyEmailSenders)
      .where(and(eq(schema.companyEmailSenders.companyId, s.ctx.companyId), eq(schema.companyEmailSenders.id, id)));
    if (!row) throw notFound('Sender identity');
    if (row.status !== 'verified') throw new ServiceError('invalid_state', 'Verify the domain before using this sender');
  }
  await s.tx.update(schema.companyEmailSenders).set({ active: false }).where(eq(schema.companyEmailSenders.companyId, s.ctx.companyId));
  if (id) await s.tx.update(schema.companyEmailSenders).set({ active: true }).where(eq(schema.companyEmailSenders.id, id));
  await recordAudit(s, {
    action: 'email.sender_selected',
    entityType: 'company',
    entityId: s.ctx.companyId,
    details: { senderIdentityId: id },
  });
  return listCompanyEmailSenders(s);
}
export async function resolveCompanyEmailSender(s: ServiceContext, config: EmailConfig, usePlatform = false) {
  const [row] = usePlatform
    ? []
    : await s.tx
        .select()
        .from(schema.companyEmailSenders)
        .where(and(eq(schema.companyEmailSenders.companyId, s.ctx.companyId), eq(schema.companyEmailSenders.active, true)));
  if (row && row.status !== 'verified')
    throw new ServiceError('invalid_state', 'The company sender needs verification. Repair it in Invoice branding or explicitly use the Evenbooks sender.');
  return { from: row ? `${JSON.stringify(row.fromName)} <${row.fromEmail}>` : config.from, senderIdentityId: row?.id ?? null };
}
export async function refreshActiveEmailSenders(db: Db, manager: EmailIdentityManager) {
  const rows = await withSystem(db, (tx) =>
    tx
      .select({ id: schema.companyEmailSenders.id, companyId: schema.companyEmailSenders.companyId })
      .from(schema.companyEmailSenders)
      .where(and(eq(schema.companyEmailSenders.active, true), sql`checked_at is null or checked_at < now() - interval '6 hours'`)),
  );
  let checked = 0;
  for (const row of rows) {
    // One unavailable DNS/provider check must not prevent the remaining maintenance tasks.
    try {
      await runJobInCompany(db, { companyId: row.companyId, actorId: 'sender-verification', actorType: 'system' }, (s) =>
        refreshCompanyEmailSender(s, row.id, manager),
      );
      checked++;
    } catch {
      /* retry on the next maintenance pass */
    }
  }
  return checked;
}
