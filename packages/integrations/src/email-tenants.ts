import type { SESv2Client, Tenant } from '@aws-sdk/client-sesv2';

export const COMPANY_EMAIL_CONFIGURATION_SET = 'evenbooks-company-emails';

/** Derived only from the persisted company ID, never from request/queue routing input. */
export function companyEmailTenantName(companyId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new Error('A valid company ID is required for tenant email sending');
  }
  return `evenbooks-company-${companyId.toLowerCase()}`;
}

function errorName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

/** Bounded, shared provisioning promises. Failed operations remain retryable. */
function provisionOnce<T>(cache: Map<string, Promise<T>>, key: string, provision: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  const pending = provision().catch((err: unknown) => {
    if (cache.get(key) === pending) cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

export class SesTenantManager {
  private readonly tenants = new Map<string, Promise<Tenant>>();
  private readonly configurationSets = new Map<string, Promise<void>>();
  private readonly routes = new Map<string, Promise<{ tenantName: string; configurationSet: string }>>();

  constructor(private readonly client: SESv2Client, private readonly snsTopicArn?: string) {}

  async prepare(companyId: string, from: string, configuredSet?: string | null) {
    const tenantName = companyEmailTenantName(companyId);
    const address = (from.match(/<([^<>]+)>\s*$/)?.[1] ?? from).trim().toLowerCase();
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw new Error('Invalid email sender address');
    const configurationSet = configuredSet || COMPANY_EMAIL_CONFIGURATION_SET;
    return provisionOnce(this.routes, JSON.stringify([tenantName, address, configurationSet]), async () => {
      const sdk = await import('@aws-sdk/client-sesv2');
      const tenant = await this.ensureTenant(tenantName);
      // Derive region/account from SES rather than a separate, potentially stale setting.
      const arnPrefix = tenant.TenantArn!.split(':').slice(0, 5).join(':');
      const identity = await this.verifiedIdentity(address);
      if (!configuredSet) await this.ensureConfigurationSet(configurationSet);
      for (const resource of [`identity/${identity}`, `configuration-set/${configurationSet}`]) {
        try {
          await this.client.send(new sdk.CreateTenantResourceAssociationCommand({
            TenantName: tenantName,
            ResourceArn: `${arnPrefix}:${resource}`,
          }));
        } catch (err) {
          if (errorName(err) !== 'AlreadyExistsException') throw err;
        }
      }
      return { tenantName, configurationSet };
    });
  }

  private ensureTenant(tenantName: string) {
    return provisionOnce(this.tenants, tenantName, async () => {
      const sdk = await import('@aws-sdk/client-sesv2');
      let tenant: Tenant | undefined;
      // A missing tenant has no ARN: SES authorizes GetTenant against "*" in
      // that case. Create first so IAM can stay scoped to company tenant ARNs.
      try {
        tenant = await this.client.send(new sdk.CreateTenantCommand({ TenantName: tenantName }));
      } catch (err) {
        if (errorName(err) !== 'AlreadyExistsException') throw err;
        tenant = (await this.client.send(new sdk.GetTenantCommand({ TenantName: tenantName }))).Tenant;
      }
      if (!tenant?.TenantArn || !['ENABLED', 'REINSTATED'].includes(tenant.SendingStatus ?? '')) {
        throw Object.assign(new Error('Email sending for this company is paused or unavailable in SES. Please contact support.'), { name: 'TenantSendingPaused' });
      }
      const region = tenant.TenantArn.split(':')[3];
      const partition = tenant.TenantArn.split(':')[1];
      await this.client.send(new sdk.UpdateReputationEntityPolicyCommand({
        ReputationEntityType: 'RESOURCE',
        ReputationEntityReference: tenant.TenantArn,
        ReputationEntityPolicy: `arn:${partition}:ses:${region}:aws:reputation-policy/strict`,
      }));
      // Never call UpdateReputationEntityCustomerManagedStatus: retries must not unpause tenants.
      return tenant;
    });
  }

  private async verifiedIdentity(address: string): Promise<string> {
    const { GetEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
    const domain = address.split('@')[1]!;
    // Existing platform senders may have an individually verified address instead of a domain.
    for (const identity of [domain, address]) {
      try {
        const result = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
        if (result.VerifiedForSendingStatus) return identity;
      } catch (err) {
        if (errorName(err) !== 'NotFoundException') throw err;
      }
    }
    throw new Error('The sender identity is not verified in SES');
  }

  private ensureConfigurationSet(name: string) {
    return provisionOnce(this.configurationSets, name, async () => {
      const sdk = await import('@aws-sdk/client-sesv2');
      try {
        await this.client.send(new sdk.CreateConfigurationSetCommand({ ConfigurationSetName: name }));
      } catch (err) {
        if (errorName(err) !== 'AlreadyExistsException') throw err;
      }
      if (this.snsTopicArn) {
        try {
          await this.client.send(new sdk.CreateConfigurationSetEventDestinationCommand({
            ConfigurationSetName: name,
            EventDestinationName: 'evenbooks-invoice-events',
            EventDestination: {
              Enabled: true,
              MatchingEventTypes: ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'DELIVERY_DELAY'],
              SnsDestination: { TopicArn: this.snsTopicArn },
            },
          }));
        } catch (err) {
          if (errorName(err) !== 'AlreadyExistsException') throw err;
        }
      }
    });
  }
}
