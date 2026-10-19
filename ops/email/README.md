# Company email tenants and IAM

Every SES send uses `evenbooks-company-<company UUID>` as its tenant. The worker
takes that UUID from the persisted email message's company, never from a user
request, sender domain, template, or job routing argument. The same tenant covers
custom domains, the Evenbooks sender, test emails, manual
sends, bulk sends and recurring invoices. No database migration is needed.

On its first send, the SES adapter automatically creates/reuses the tenant, applies
the AWS **Strict** reputation policy, and associates the verified sender identity
and configuration set. Later sends use bounded provisioning caches; SES still
validates resource associations and sending status on every send. Failed
provisioning is not cached. Duplicate resources and concurrent creation are safe.
Retries never enable a paused tenant or send without a tenant. Strict applies to
all companies; change the provisioning code before using a different policy.
Provisioning creates first and reads on `AlreadyExistsException`: SES authorizes
a lookup of a nonexistent tenant against `*`, which the scoped runtime policy
intentionally does not allow.

If `SES_CONFIGURATION_SET` is set, the adapter associates that existing set and
leaves its event destinations unchanged. Otherwise it creates/reuses
`evenbooks-company-emails`. Configure `SES_SNS_TOPIC_ARN` on web and worker following [the SNS setup guide](sns-topic.md). The webhook refuses events when the ARN is unset. When it is set, the managed set gets an
SNS destination for Send, Delivery, Bounce, Complaint, Reject and DeliveryDelay,
preserving the existing webhook and company-local suppressions. The SNS topic must
allow SES to publish and subscribe the application's `/api/webhooks/ses` endpoint.
After rotating the topic, update the managed destination in SES as well. Tenant
suppression remains at the SES account default; existing app suppression records
and company sending limits are unchanged.

## Production policy

`company-sender-policy.json` is the complete runtime policy for the runtime IAM user
(`evenbooks.prod` in the hosted deployment), region `us-east-1`, as a template: fill in
`<AWS_ACCOUNT_ID>` and one `aws:SourceIp` entry per static outbound IP of the web and
worker services. The hosted deployment's filled-in copy is kept privately next to it
(`company-sender-policy.production.json`). It supports any customer domain,
allows only the SES operations used for tenant provisioning and delivery, and
limits reputation-policy assignment to AWS's Strict policy. All SES calls are
explicitly denied outside the production static outbound IPs. Tenant creation
and management are scoped to `evenbooks-company-*` tenants. The runtime user has
no permission to re-enable sending, delete tenants, or modify sending-authorization
policies. Customers receive DNS records, never AWS credentials.

The policy also explicitly denies sends without a company tenant, including
legacy sending APIs. This deny prevents the old `SendAsEvenbooks` policy from
allowing a tenantless send. SES and the application still enforce sender
verification; the application additionally requires each company's DNS ownership
proof before using its custom sender. IAM does not know the current application
company: choosing the correct tenant and resources remains the server's job.

The full policy is 1,107 characters excluding whitespace, below the 2,048-character
IAM user inline-policy limit. That limit applies to the **sum** of inline policies
on the user; remove obsolete policies or use a managed policy if needed.

AWS administration requires a separate admin profile; the runtime AWS credentials
cannot change IAM policies.

## Setup and deployment

1. Using an AWS administrator profile in the sending account, replace the
   existing sending policy with the filled-in tenant policy. Tenant enforcement is
   required from the start; this is a pre-launch deployment:

   ```sh
   aws iam put-user-policy \
     --user-name evenbooks.prod \
     --policy-name CompanySenderTenants \
     --policy-document file://ops/email/company-sender-policy.production.json
   ```

2. Deploy the updated worker, then web, explicitly targeting the intended environment:

   ```sh
   railway up -s worker -e production -d
   railway up -s web -e production -d
   ```

3. Check that the new worker is active.
   Send a sample invoice to SES's `success@simulator.amazonses.com` recipient.
   Confirm the company tenant exists, has Strict policy and identity/configuration
   set associations, and that SES received the send with that tenant. Test a custom
   domain after adding its authorization TXT and DKIM records. Sending from the
   Evenbooks identity must use the same company tenant. Test a paused **test** tenant
   and confirm the app records a permanent failure without using another sender.

4. Confirm a send with no `TenantName` is denied, while legitimate company sends
   succeed. Check callback delivery, bounce/complaint handling, worker health and
   invoice send statuses. Allow for IAM propagation between changes.

## Pauses

SES automatically pauses tenants under Strict enforcement. An operator must
investigate the finding and explicitly reinstate the tenant in SES; application
retries never do this. Customers retain their company tenant when changing domains
or choosing the Evenbooks sender. Pause a company tenant rather than disabling the
shared configuration set or platform identity.

Keep tenant resources and their reputation history; do not delete/recreate tenants
as a way to clear a pause. Tenantless sending is not supported.

Tenants reduce the impact of customer abuse, but combined sending activity can
still affect the account. Monitor reputation findings in SES/EventBridge and keep
the existing company quotas and bounce/complaint suppressions. Pricing and tenant
quotas follow AWS's current SES plans.

References:

- https://docs.aws.amazon.com/ses/latest/dg/tenants.html
- https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html
