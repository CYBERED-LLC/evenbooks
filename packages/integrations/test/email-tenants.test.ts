import { describe, expect, it, vi } from 'vitest';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { SesEmailSender, type OutgoingEmail } from '../src/email';
import { COMPANY_EMAIL_CONFIGURATION_SET, companyEmailTenantName } from '../src/email-tenants';

const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const prefix = 'arn:aws:ses:us-east-1:123456789012';
const failure = (name: string) => Object.assign(new Error(name), { name });
const message = (companyId = companyA, from = 'Company <billing@example.com>'): OutgoingEmail => ({
  companyId, from, to: 'customer@example.test', subject: 'Invoice', text: 'Please pay', html: '<p>Please pay</p>',
});

function fakeSes() {
  const tenants = new Map<string, { TenantName: string; TenantArn: string; SendingStatus: string }>();
  const policies = new Map<string, string>();
  const associations = new Set<string>();
  const sets = new Set<string>();
  const identities = new Set(['example.com', 'other.example.com', 'evenbooks.org']);
  const destinations = new Set<string>();
  let reject: ((name: string, input: Record<string, unknown>) => Error | undefined) | undefined;
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const input = command.input;
    const err = reject?.(name, input);
    if (err) throw err;
    const tenantName = input.TenantName as string;
    switch (name) {
      case 'GetTenantCommand': {
        const tenant = tenants.get(tenantName);
        // SES cannot resolve a missing tenant's ARN and rejects this lookup
        // under the production policy rather than returning NotFound.
        if (!tenant) throw failure('AccessDeniedException');
        return { Tenant: tenant };
      }
      case 'CreateTenantCommand': {
        if (tenants.has(tenantName)) throw failure('AlreadyExistsException');
        const tenant = { TenantName: tenantName, TenantArn: `${prefix}:tenant/${tenantName}/id`, SendingStatus: 'ENABLED' };
        tenants.set(tenantName, tenant);
        return tenant;
      }
      case 'UpdateReputationEntityPolicyCommand':
        policies.set(input.ReputationEntityReference as string, input.ReputationEntityPolicy as string);
        return {};
      case 'GetEmailIdentityCommand':
        if (!identities.has(input.EmailIdentity as string)) throw failure('NotFoundException');
        return { VerifiedForSendingStatus: true };
      case 'CreateConfigurationSetCommand': {
        const set = input.ConfigurationSetName as string;
        if (sets.has(set)) throw failure('AlreadyExistsException');
        sets.add(set);
        return {};
      }
      case 'CreateConfigurationSetEventDestinationCommand': {
        const key = JSON.stringify([input.ConfigurationSetName, input.EventDestinationName]);
        if (destinations.has(key)) throw failure('AlreadyExistsException');
        destinations.add(key);
        return {};
      }
      case 'CreateTenantResourceAssociationCommand': {
        const key = JSON.stringify([tenantName, input.ResourceArn]);
        if (associations.has(key)) throw failure('AlreadyExistsException');
        associations.add(key);
        return {};
      }
      case 'SendEmailCommand': {
        const tenant = tenants.get(tenantName);
        if (!tenant || tenant.SendingStatus === 'DISABLED') throw failure('SendingPausedException');
        if (!associations.has(JSON.stringify([tenantName, `${prefix}:configuration-set/${input.ConfigurationSetName as string}`]))) throw failure('BadRequestException');
        if (policies.get(tenant.TenantArn) !== 'arn:aws:ses:us-east-1:aws:reputation-policy/strict') throw failure('BadRequestException');
        return { MessageId: 'message-id' };
      }
      default: throw new Error(`Unexpected SES operation: ${name}`);
    }
  });
  const client = { send } as unknown as SESv2Client;
  const sender = new SesEmailSender({ region: 'us-east-1', snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:invoice-events' }, client);
  return {
    client, sender, tenants, policies, associations, sets, identities, send,
    rejectWith: (fn?: typeof reject) => { reject = fn; },
    calls: (name: string) => send.mock.calls.filter(([command]) => command.constructor.name === name).map(([command]) => command.input),
  };
}

describe('company SES tenants', () => {
  it('creates a missing tenant before looking it up under ARN-scoped IAM', async () => {
    const ses = fakeSes();
    expect(await ses.sender.send(message())).toMatchObject({ ok: true });
    expect(ses.calls('GetTenantCommand')).toHaveLength(0);
    expect(await new SesEmailSender({ region: 'us-east-1' }, ses.client).send(message())).toMatchObject({ ok: true });
    expect(ses.calls('GetTenantCommand')).toHaveLength(1);
  });
  it('isolates companies sharing a domain and enables Strict reputation enforcement before sending', async () => {
    const ses = fakeSes();
    expect(await ses.sender.send(message())).toMatchObject({ ok: true });
    expect(await ses.sender.send(message(companyB))).toMatchObject({ ok: true });
    const sends = ses.calls('SendEmailCommand');
    expect(sends.map((input) => input.TenantName)).toEqual([companyEmailTenantName(companyA), companyEmailTenantName(companyB)]);
    expect(ses.tenants.size).toBe(2);
    expect(ses.policies.size).toBe(2);
    expect(sends.every((input) => input.ConfigurationSetName === COMPANY_EMAIL_CONFIGURATION_SET)).toBe(true);
    expect(ses.calls('CreateConfigurationSetCommand')).toHaveLength(1);
    expect(ses.calls('CreateConfigurationSetEventDestinationCommand')[0]?.EventDestination).toMatchObject({
      Enabled: true, MatchingEventTypes: expect.arrayContaining(['BOUNCE', 'COMPLAINT', 'DELIVERY']),
    });
    for (const id of [companyA, companyB]) {
      expect(ses.associations.has(JSON.stringify([companyEmailTenantName(id), `${prefix}:identity/example.com`]))).toBe(true);
    }
  });
  it('keeps the same tenant across custom domains and the Evenbooks fallback', async () => {
    const ses = fakeSes();
    for (const from of ['billing@example.com', 'billing@other.example.com', 'Evenbooks <billing@evenbooks.org>']) {
      expect(await ses.sender.send(message(companyA, from))).toMatchObject({ ok: true });
    }
    expect(ses.calls('SendEmailCommand').map((input) => input.TenantName)).toEqual(Array(3).fill(companyEmailTenantName(companyA)));
    expect(ses.tenants.size).toBe(1);
    expect(ses.calls('UpdateReputationEntityPolicyCommand')).toHaveLength(1);
  });
  it('deduplicates concurrent provisioning and reuses associations on a fresh worker', async () => {
    const ses = fakeSes();
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => ses.sender.send(message())));
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(ses.calls('CreateTenantCommand')).toHaveLength(1);
    expect(ses.calls('CreateTenantResourceAssociationCommand')).toHaveLength(2);
    expect(await new SesEmailSender({ region: 'us-east-1' }, ses.client).send(message())).toMatchObject({ ok: true });
    expect(ses.tenants.size).toBe(1);
  });
  it('uses a configured set without altering its destinations', async () => {
    const ses = fakeSes();
    expect(await ses.sender.send({ ...message(), configurationSet: 'existing-invoice-events' })).toMatchObject({ ok: true });
    expect(ses.calls('SendEmailCommand')[0]?.ConfigurationSetName).toBe('existing-invoice-events');
    expect(ses.calls('CreateConfigurationSetCommand')).toHaveLength(0);
    expect(ses.calls('CreateConfigurationSetEventDestinationCommand')).toHaveLength(0);
  });
  it('supports an individually verified platform address', async () => {
    const ses = fakeSes();
    ses.identities.delete('evenbooks.org');
    ses.identities.add('billing@evenbooks.org');
    expect(await ses.sender.send(message(companyA, 'Evenbooks <billing@evenbooks.org>'))).toMatchObject({ ok: true });
    expect(ses.associations.has(JSON.stringify([companyEmailTenantName(companyA), `${prefix}:identity/billing@evenbooks.org`]))).toBe(true);
  });
  it('never sends or automatically unpauses an already disabled tenant', async () => {
    const ses = fakeSes();
    const name = companyEmailTenantName(companyA);
    ses.tenants.set(name, { TenantName: name, TenantArn: `${prefix}:tenant/${name}/id`, SendingStatus: 'DISABLED' });
    expect(await ses.sender.send(message())).toMatchObject({ ok: false, transient: false, error: expect.stringContaining('paused') });
    expect(ses.calls('SendEmailCommand')).toHaveLength(0);
    expect(ses.calls('UpdateReputationEntityPolicyCommand')).toHaveLength(0);
    expect(ses.calls('UpdateReputationEntityCustomerManagedStatusCommand')).toHaveLength(0);
  });
  it('respects SES pausing after provisioning, including sends using the Evenbooks identity', async () => {
    const ses = fakeSes();
    expect(await ses.sender.send(message())).toMatchObject({ ok: true });
    ses.tenants.get(companyEmailTenantName(companyA))!.SendingStatus = 'DISABLED';
    expect(await ses.sender.send(message(companyA, 'billing@evenbooks.org'))).toMatchObject({ ok: false, transient: false });
    expect(ses.calls('SendEmailCommand').every((input) => input.TenantName === companyEmailTenantName(companyA))).toBe(true);
    expect(ses.calls('UpdateReputationEntityCustomerManagedStatusCommand')).toHaveLength(0);
  });
  it.each(['', 'another-company', '../company', undefined])('rejects invalid company routing %s before any AWS request', async (companyId) => {
    const ses = fakeSes();
    expect(await ses.sender.send({ ...message(), companyId: companyId as string })).toMatchObject({ ok: false, transient: false });
    expect(ses.send).not.toHaveBeenCalled();
  });
  it('never sends with an unverified identity', async () => {
    const ses = fakeSes();
    ses.identities.clear();
    expect(await ses.sender.send(message())).toMatchObject({ ok: false, transient: false, error: expect.stringContaining('not verified') });
    expect(ses.calls('SendEmailCommand')).toHaveLength(0);
  });
  it.each(['UpdateReputationEntityPolicyCommand', 'CreateTenantResourceAssociationCommand', 'CreateConfigurationSetEventDestinationCommand'])('fails closed when %s is denied, and recovers after permissions are restored', async (operation) => {
    const ses = fakeSes();
    ses.rejectWith((name) => name === operation ? failure('AccessDeniedException') : undefined);
    expect(await ses.sender.send(message())).toMatchObject({ ok: false, transient: false });
    expect(ses.calls('SendEmailCommand')).toHaveLength(0);
    ses.rejectWith();
    expect(await ses.sender.send(message())).toMatchObject({ ok: true });
    expect(ses.tenants.size).toBe(1);
  });
  it('retries throttled provisioning without retaining failed operations', async () => {
    const ses = fakeSes();
    ses.rejectWith((name) => name === 'CreateTenantResourceAssociationCommand' ? failure('TooManyRequestsException') : undefined);
    expect(await ses.sender.send(message())).toMatchObject({ ok: false, transient: true });
    expect(ses.calls('SendEmailCommand')).toHaveLength(0);
    ses.rejectWith();
    expect(await ses.sender.send(message())).toMatchObject({ ok: true });
  });
});
