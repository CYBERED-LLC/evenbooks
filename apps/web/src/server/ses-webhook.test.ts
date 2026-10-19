import { afterEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
vi.mock('@evenbooks/services', () => ({ ingestEmailEvent: vi.fn() }));
vi.mock('./db', () => ({ getDb: () => ({ db: {} }) }));
vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('./sns', () => ({ verifySnsMessage: vi.fn() }));
import { POST } from '../app/api/webhooks/ses/route';
import { verifySnsMessage } from './sns';
import { ingestEmailEvent } from '@evenbooks/services';
const topic = 'arn:aws:sns:us-east-1:123456789012:evenbooks-email-events';
const request = () => new Request('https://evenbooks.test/api/webhooks/ses', { method: 'POST', body: '{}' }) as NextRequest;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
it('fails closed when the configured topic is missing', async () => {
  vi.stubEnv('SES_SNS_TOPIC_ARN', '');
  expect((await POST(request())).status).toBe(503);
  expect(verifySnsMessage).not.toHaveBeenCalled();
  expect(ingestEmailEvent).not.toHaveBeenCalled();
});
it.each(['SubscriptionConfirmation', 'Notification'])('rejects another signed topic for %s before any side effect', async Type => {
  vi.stubEnv('SES_SNS_TOPIC_ARN', topic);
  vi.mocked(verifySnsMessage).mockResolvedValue({ Type, TopicArn: topic + '-other', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Token=test', Message: '{}' });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await POST(request())).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled(); expect(ingestEmailEvent).not.toHaveBeenCalled();
});
it('confirms only the allowed SNS topic', async () => {
  vi.stubEnv('SES_SNS_TOPIC_ARN', topic);
  const url = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=test';
  vi.mocked(verifySnsMessage).mockResolvedValue({ Type: 'SubscriptionConfirmation', TopicArn: topic, SubscribeURL: url });
  const fetch = vi.fn().mockResolvedValue(new Response('ok')); vi.stubGlobal('fetch', fetch);
  expect((await POST(request())).status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(new URL(url));
});
it('ingests an event from the allowed topic', async () => {
  vi.stubEnv('SES_SNS_TOPIC_ARN', topic);
  vi.mocked(verifySnsMessage).mockResolvedValue({ Type: 'Notification', TopicArn: topic, MessageId: 'event-1', Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-1' } }) });
  expect((await POST(request())).status).toBe(200);
  expect(ingestEmailEvent).toHaveBeenCalledWith({}, expect.objectContaining({ providerMessageId: 'ses-1', eventType: 'Delivery' }));
});
it('rejects an invalid SNS signature', async () => {
  vi.stubEnv('SES_SNS_TOPIC_ARN', topic);
  vi.mocked(verifySnsMessage).mockRejectedValue(new Error('bad signature'));
  expect((await POST(request())).status).toBe(400);
  expect(ingestEmailEvent).not.toHaveBeenCalled();
});
