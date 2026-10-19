import type { PgBoss } from 'pg-boss';

/**
 * Queue catalogue. Every job payload carries `companyId` and a dedupe key; jobs
 * are idempotent because the services they call are (unique indexes, outbox
 * dedupe keys, state machines).
 */
export const QUEUES = {
  invoiceIssued: 'invoice.issued',
  emailSend: 'email.send',
  recurringTick: 'recurring.tick',
  recurringIssue: 'recurring.issue',
  bankSyncTick: 'bank.sync.tick',
  bankSync: 'bank.sync',
  maintenance: 'maintenance',
  outboxDispatch: 'outbox.dispatch',
} as const;

export const DEAD_LETTER = 'dead-letter';

export interface InvoiceIssuedJob {
  companyId: string;
  invoiceId: string;
  actorId?: string;
}
export interface EmailSendJob {
  companyId: string;
  emailMessageId: string;
  invoiceId: string | null;
  message: string | null;
}
export interface RecurringIssueJob {
  companyId: string;
  scheduleId: string;
}
export interface BankSyncJob {
  companyId: string;
  connectionId: string;
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(DEAD_LETTER, { retentionSeconds: 30 * 86_400, deleteAfterSeconds: 60 * 86_400 });
  const base = { deadLetter: DEAD_LETTER, retentionSeconds: 14 * 86_400, deleteAfterSeconds: 30 * 86_400 };
  await boss.createQueue(QUEUES.invoiceIssued, { ...base, retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 });
  await boss.createQueue(QUEUES.emailSend, { ...base, retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 300 });
  await boss.createQueue(QUEUES.recurringTick, { ...base, retryLimit: 1, expireInSeconds: 300, policy: 'singleton' });
  await boss.createQueue(QUEUES.recurringIssue, { ...base, retryLimit: 3, retryDelay: 120, retryBackoff: true, expireInSeconds: 600, policy: 'singleton' });
  await boss.createQueue(QUEUES.bankSyncTick, { ...base, retryLimit: 1, expireInSeconds: 300, policy: 'singleton' });
  await boss.createQueue(QUEUES.bankSync, { ...base, retryLimit: 2, retryDelay: 300, retryBackoff: true, expireInSeconds: 600, policy: 'singleton' });
  await boss.createQueue(QUEUES.maintenance, { ...base, retryLimit: 1, expireInSeconds: 900, policy: 'singleton' });
  await boss.createQueue(QUEUES.outboxDispatch, { ...base, retryLimit: 1, expireInSeconds: 120, policy: 'singleton' });
}
