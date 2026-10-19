import { describe, expect, it } from 'vitest';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { EmailIdentityPermissionError, SesEmailIdentityManager } from '../src/email-identities';

describe('SES company identities', () => {
  it.each(['create', 'check'] as const)('reports missing permissions during %s without exposing AWS details', async (operation) => {
    const denied = Object.assign(new Error('User arn:aws:iam::123456789012:user/private-user cannot access a private identity'), { name: 'AccessDeniedException' });
    const client = { send: async () => { throw denied; } } as unknown as SESv2Client;
    const error = await new SesEmailIdentityManager(client)[operation]('example.com').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EmailIdentityPermissionError);
    expect(error).toMatchObject({ cause: denied });
    expect((error as Error).message).toContain('missing email provider permissions');
    expect((error as Error).message).not.toContain('private-user');
  });
  it('requires verified sending and successful, enabled DKIM', async () => {
    const client = {
      send: async () => ({ VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS', SigningEnabled: false, Tokens: ['dkim-token'] } }),
    } as unknown as SESv2Client;
    const manager = new SesEmailIdentityManager(client);
    expect(await manager.check('example.com')).toMatchObject({ verified: false, dkimTokens: ['dkim-token'] });
    client.send = (async () => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true, Tokens: ['dkim-token'] },
    })) as typeof client.send;
    expect(await manager.check('example.com')).toMatchObject({ verified: true, error: null });
  });
  it('reuses an existing SES identity without treating it as company ownership', async () => {
    let calls = 0;
    const client = {
      send: async (command: { input: { EmailIdentity: string } }) => {
        expect(command.input.EmailIdentity).toBe('example.com');
        if (calls++ === 0) throw Object.assign(new Error('Exists'), { name: 'AlreadyExistsException' });
        return { VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true } };
      },
    } as unknown as SESv2Client;
    expect((await new SesEmailIdentityManager(client).create('example.com')).verified).toBe(true);
    expect(calls).toBe(2);
  });
  it('reports deleted identities as unverified but propagates provider outages', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('Deleted'), { name: 'NotFoundException' });
      },
    } as unknown as SESv2Client;
    const manager = new SesEmailIdentityManager(client);
    expect(await manager.check('example.com')).toMatchObject({ verified: false, error: 'The sending domain no longer exists in SES' });
    client.send = (async () => {
      throw new Error('Provider unavailable');
    }) as typeof client.send;
    await expect(manager.check('example.com')).rejects.toThrow('Provider unavailable');
  });
});
