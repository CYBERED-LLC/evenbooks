import type { NextRequest } from 'next/server';
import { ingestEmailEvent } from '@evenbooks/services';
import { getDb } from '@/server/db';
import { logger } from '@/server/logger';
import { verifySnsMessage } from '@/server/sns';

export const dynamic = 'force-dynamic';

/**
 * Amazon SES event ingestion via SNS HTTPS subscription. The SNS signature is
 * verified (certificate host pinned to amazonaws.com), the topic ARN must match
 * SES_SNS_TOPIC_ARN, subscription confirmations are followed automatically, and
 * every event is stored before message state changes.
 */
export async function POST(req: NextRequest) {
  const expectedTopic = process.env.SES_SNS_TOPIC_ARN?.trim();
  if (!expectedTopic) return new Response('SES event topic is not configured', { status: 503 });
  const raw = await req.text();
  let envelope: Record<string, unknown>;
  try {
    envelope = await verifySnsMessage(raw);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'rejected SNS message');
    return new Response('invalid', { status: 400 });
  }
  if (envelope.TopicArn !== expectedTopic) return new Response('wrong topic', { status: 403 });
  if (envelope.Type === 'SubscriptionConfirmation' && typeof envelope.SubscribeURL === 'string') {
    const u = new URL(envelope.SubscribeURL);
    if (u.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) {
      await fetch(u).catch(() => {});
      logger.info({ topic: envelope.TopicArn }, 'confirmed SNS subscription');
    }
    return new Response('ok');
  }
  if (envelope.Type !== 'Notification' || typeof envelope.Message !== 'string') return new Response('ignored');
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(envelope.Message) as Record<string, unknown>;
  } catch {
    return new Response('ignored');
  }
  const mail = (event.mail ?? {}) as { messageId?: string; timestamp?: string };
  const eventType = String(event.eventType ?? event.notificationType ?? '');
  if (!mail.messageId || !eventType) return new Response('ignored');
  const bounce = (event.bounce ?? null) as { bounceType?: string; bouncedRecipients?: { emailAddress: string }[] } | null;
  const complaint = (event.complaint ?? null) as { complainedRecipients?: { emailAddress: string }[] } | null;
  const recipients = bounce?.bouncedRecipients?.map((r) => r.emailAddress) ?? complaint?.complainedRecipients?.map((r) => r.emailAddress) ?? undefined;
  await ingestEmailEvent(getDb().db, {
    provider: 'ses',
    providerMessageId: mail.messageId,
    providerEventId: typeof envelope.MessageId === 'string' ? envelope.MessageId : null,
    eventType,
    occurredAt: mail.timestamp ?? null,
    payload: event,
    bounceType: bounce?.bounceType ?? null,
    recipients,
  });
  return new Response('ok');
}
