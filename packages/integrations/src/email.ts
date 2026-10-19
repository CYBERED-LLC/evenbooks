/**
 * Email sending abstraction. `LogEmailSender` is the local/test transport and
 * records every message in memory; `SesEmailSender` uses SESv2. Neither claims
 * exactly-once delivery: callers persist state before and after `send` and treat
 * ambiguous outcomes as an explicit review state.
 */
import { SesTenantManager } from './email-tenants';

export interface EmailAttachment {
  fileName: string;
  contentType: string;
  content: Uint8Array;
  inline?: boolean;
  contentId?: string;
}

export interface OutgoingEmail {
  /** Trusted company ID loaded from the message row by the worker. */
  companyId: string;
  to: string;
  from: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
  /** Propagated to SES as message tags for event correlation. */
  tags?: Record<string, string>;
  configurationSet?: string | null;
}

export type SendOutcome = { ok: true; providerMessageId: string } | { ok: false; transient: boolean; error: string };

export interface EmailSender {
  readonly driver: 'log' | 'ses';
  send(msg: OutgoingEmail): Promise<SendOutcome>;
}

export class LogEmailSender implements EmailSender {
  readonly driver = 'log' as const;
  readonly sent: (OutgoingEmail & { providerMessageId: string; at: string })[] = [];
  /** Test hook: make the next send fail (transient or permanent) or return ambiguous. */
  failNext: null | { transient: boolean; error: string } = null;
  constructor(private readonly log: (msg: string, meta?: Record<string, unknown>) => void = () => {}) {}

  async send(msg: OutgoingEmail): Promise<SendOutcome> {
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return { ok: false, transient: f.transient, error: f.error };
    }
    const providerMessageId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.sent.push({ ...msg, providerMessageId, at: new Date().toISOString() });
    this.log('email (log driver, not delivered)', { to: msg.to, subject: msg.subject, attachments: msg.attachments?.map((a) => a.fileName) ?? [], providerMessageId });
    return { ok: true, providerMessageId };
  }
}

export interface SesConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  snsTopicArn?: string;
}

const TRANSIENT_SES_ERRORS = new Set(['TooManyRequestsException', 'LimitExceededException', 'ThrottlingException', 'ConflictException', 'ServiceUnavailable', 'InternalFailure', 'TimeoutError', 'NetworkingError']);

export class SesEmailSender implements EmailSender {
  readonly driver = 'ses' as const;
  private clientPromise: Promise<import('@aws-sdk/client-sesv2').SESv2Client> | null = null;
  private tenants: SesTenantManager | null = null;
  constructor(private readonly cfg: SesConfig, private readonly providedClient?: import('@aws-sdk/client-sesv2').SESv2Client) {}

  private client() {
    if (this.providedClient) return Promise.resolve(this.providedClient);
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-sesv2').then(
        ({ SESv2Client }) =>
          new SESv2Client({
            region: this.cfg.region,
            requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
            credentials: this.cfg.accessKeyId && this.cfg.secretAccessKey ? { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey } : undefined,
          }),
      );
    }
    return this.clientPromise;
  }

  async send(msg: OutgoingEmail): Promise<SendOutcome> {
    const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    try {
      const client = await this.client();
      this.tenants ??= new SesTenantManager(client, this.cfg.snsTopicArn);
      const route = await this.tenants.prepare(msg.companyId, msg.from, msg.configurationSet);
      const res = await client.send(
        new SendEmailCommand({
          TenantName: route.tenantName,
          FromEmailAddress: msg.from,
          ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
          Destination: { ToAddresses: [msg.to] },
          ConfigurationSetName: route.configurationSet,
          EmailTags: msg.tags ? Object.entries(msg.tags).map(([Name, Value]) => ({ Name, Value: Value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) })) : undefined,
          Content: {
            Simple: {
              Subject: { Data: msg.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: msg.text, Charset: 'UTF-8' }, Html: { Data: msg.html, Charset: 'UTF-8' } },
              Attachments: msg.attachments?.map((a) => ({
                FileName: a.fileName,
                ContentType: a.contentType,
                RawContent: a.content,
                ContentDisposition: a.inline ? 'INLINE' as const : 'ATTACHMENT' as const,
                ContentId: a.contentId,
                ContentTransferEncoding: 'BASE64' as const,
              })),
            },
          },
        }),
      );
      if (!res.MessageId) return { ok: false, transient: false, error: 'SES accepted the request without a MessageId' };
      return { ok: true, providerMessageId: res.MessageId };
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'SendingPausedException') {
        return { ok: false, transient: false, error: 'Email sending for this company is paused by SES. Please contact support.' };
      }
      const transient = TRANSIENT_SES_ERRORS.has(e.name ?? '') || (e.$metadata?.httpStatusCode ?? 0) >= 500;
      return { ok: false, transient, error: `${e.name ?? 'Error'}: ${e.message ?? 'unknown'}` };
    }
  }
}

export function createEmailSenderFromEnv(env: NodeJS.ProcessEnv = process.env, log?: (msg: string, meta?: Record<string, unknown>) => void): EmailSender {
  if ((env.EMAIL_DRIVER ?? 'log') === 'ses') {
    if (!env.SES_FROM_ADDRESS) throw new Error('SES_FROM_ADDRESS is required when EMAIL_DRIVER=ses');
    return new SesEmailSender({ region: env.SES_REGION ?? 'us-east-1', accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, snsTopicArn: env.SES_SNS_TOPIC_ARN });
  }
  return new LogEmailSender(log);
}

export interface EmailConfig {
  from: string;
  replyTo: string | null;
  configurationSet: string | null;
}

export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  return {
    from: env.SES_FROM_ADDRESS || 'Evenbooks <no-reply@localhost>',
    replyTo: env.SES_REPLY_TO || null,
    configurationSet: env.SES_CONFIGURATION_SET || null,
  };
}
