import { Resolver } from 'node:dns/promises';

export class EmailIdentityPermissionError extends Error {
  constructor(cause: unknown) {
    super('Company sender verification is unavailable because the server is missing email provider permissions. Please contact support.', { cause });
    this.name = 'EmailIdentityPermissionError';
  }
}

function rethrowIdentityError(err: unknown): never {
  if (['AccessDeniedException', 'AccessDenied'].includes((err as { name?: string } | null)?.name ?? '')) {
    throw new EmailIdentityPermissionError(err);
  }
  throw err;
}

export interface EmailIdentityStatus {
  verified: boolean;
  dkimTokens: string[];
  error: string | null;
}
export interface EmailIdentityManager {
  readonly driver: 'log' | 'ses';
  create(domain: string): Promise<EmailIdentityStatus>;
  check(domain: string): Promise<EmailIdentityStatus>;
  provesOwnership(name: string, token: string): Promise<boolean>;
}
export class SesEmailIdentityManager implements EmailIdentityManager {
  readonly driver = 'ses' as const;
  private readonly resolver = new Resolver({ timeout: 3000, tries: 2 });
  private readonly client: import('@aws-sdk/client-sesv2').SESv2Client;
  constructor(client: import('@aws-sdk/client-sesv2').SESv2Client) {
    this.client = client;
  }
  async create(domain: string) {
    const { CreateEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
    try {
      await this.client.send(new CreateEmailIdentityCommand({ EmailIdentity: domain, DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' } }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'AlreadyExistsException') rethrowIdentityError(err);
    }
    return this.check(domain);
  }
  async check(domain: string): Promise<EmailIdentityStatus> {
    const { GetEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
    try {
      const result = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      const verified = !!result.VerifiedForSendingStatus && result.DkimAttributes?.Status === 'SUCCESS' && result.DkimAttributes?.SigningEnabled === true;
      return {
        verified,
        dkimTokens: result.DkimAttributes?.Tokens ?? [],
        error: verified ? null : 'Waiting for domain verification and DKIM authentication',
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFoundException')
        return { verified: false, dkimTokens: [], error: 'The sending domain no longer exists in SES' };
      rethrowIdentityError(err);
    }
  }
  async provesOwnership(name: string, token: string) {
    try {
      const records = await this.resolver.resolveTxt(name);
      return records.some((record) => record.join('') === token);
    } catch (err) {
      if (['ENOTFOUND', 'ENODATA'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
      throw err;
    }
  }
}
/** Local adapter never marks a domain verified without an explicit test fixture. */
export class FixtureEmailIdentityManager implements EmailIdentityManager {
  readonly driver = 'log' as const;
  verifiedDomains = new Set<string>();
  proofs = new Map<string, string>();
  async create(domain: string) {
    return this.check(domain);
  }
  async check(domain: string) {
    return {
      verified: this.verifiedDomains.has(domain),
      dkimTokens: [0, 1, 2].map((i) => `fixture${i}${domain.replace(/\./g, '')}`),
      error: 'Local email driver: verification is simulated only in tests',
    };
  }
  async provesOwnership(name: string, token: string) {
    return this.proofs.get(name) === token;
  }
}
export async function createEmailIdentityManagerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<EmailIdentityManager> {
  if ((env.EMAIL_DRIVER ?? 'log') !== 'ses') return new FixtureEmailIdentityManager();
  const { SESv2Client } = await import('@aws-sdk/client-sesv2');
  return new SesEmailIdentityManager(
    new SESv2Client({
      region: env.SES_REGION ?? 'us-east-1',
      requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } : undefined,
    }),
  );
}
