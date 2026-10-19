# Invoice branding and company email

Administrators configure **Settings → Invoice branding**. Members can view the design and preview it; only administrators can edit templates, set up senders or queue test emails.

## Templates and designs

Each save creates a new `invoice_presentation_versions` record. The settings include a PNG/JPEG logo (250 KB maximum), accent color, classic/modern layout, Letter/A4 size, default notes/footer, payment instructions, and an email subject/message/signature/reply-to.

Quantity, unit price and line tax can each be shown or hidden on invoice rows. The settings apply to PDF previews, attachments and the public invoice page. Description, amount, totals and the tax summary remain visible. Existing saved designs default to showing all three columns; issued invoices retain their saved choices until **Apply current design** is used.

Supported email placeholders: `{{customer_name}}`, `{{company_name}}`, `{{invoice_number}}`, `{{issue_date}}`, `{{due_date}}`, `{{total}}`, `{{balance_due}}`, `{{invoice_url}}`. Templates accept plain text with paragraphs. Values are escaped in HTML, and the renderer produces both HTML and plain text. Financial calculations remain unchanged.

New invoice forms start with the saved notes/footer. Issuing captures company details and branding in `invoices.design_snapshot`. The public invoice uses the same branding and issuer. Existing invoices are backfilled once during migration; original issuer details cannot be recovered if they were changed before this feature.

**Apply current design** explicitly creates a new PDF version for an issued invoice while retaining its issuer and accounting data. Earlier attachments remain intact. Regenerating a PDF normally uses the invoice's saved design.

All manual, bulk and recurring emails use the current email template. The send dialog supports subject/message overrides and an explicit platform-sender override. An email stores its resolved From, Reply-To, subject, text/HTML, logo, template version and PDF attachment. If its PDF has not been generated, it stores the data required to generate that attachment. Retries reuse this content. Public links still show current payment status and can be revoked.

Test emails use sample invoice data and run through the same durable queue, quota and suppression checks. In log-driver mode they are logged, not delivered.

## Company senders

Companies can send through SES using an address on a domain they control, including custom domains hosted by Google Workspace/Microsoft 365. Personal `@gmail.com`/`@outlook.com` addresses need a future mailbox authorization integration.

The administrator supplies the domain, From address and display name. The UI provides:

- A unique company authorization TXT record (`_evenbooks-<company-id>.<domain>`).
- SES Easy DKIM CNAME records.

Verification requires both the company's TXT proof and successful, enabled SES DKIM with sending verification. A domain already verified for a different company does not establish ownership for the new company. Domain records are scoped to the SES region configured by `SES_REGION`.

The company sender must be explicitly selected after verification. Verification runs again before each company-sender delivery and every six hours during worker maintenance (including cron/once mode). Verification loss fails delivery visibly; users can repair the domain or explicitly resend with the Evenbooks sender. Queued content is never silently switched to another From address. Disabling the selection affects newly queued emails; already queued emails retain their chosen sender.

**Cancel verification** removes a pending or failed setup from the company's list and stops further checks. It leaves the shared SES identity and DNS records intact. The same domain can be set up again with a new company authorization TXT value. Already queued emails retain their chosen sender; a cancelled identity cannot send them.

Replies use the template's Reply-To, then the company contact email, then `SES_REPLY_TO`. Sender setup does not change mailbox MX records. DKIM supplies domain alignment for DMARC; existing DMARC policies should be preserved. Custom MAIL FROM/SPF alignment is optional and can be configured separately in SES if needed.

## Deployment

Apply migrations `0015_invoice_presentation.sql` and `0016_invoice_design_history.sql` before deploying web and worker. Existing queued messages without snapshots are rendered and persisted once by the new worker using their legacy job message. New messages contain snapshots; deploy the new worker before enabling the new web flow to avoid older workers ignoring those snapshots.

Use `EMAIL_DRIVER=ses`, `SES_REGION`, `SES_FROM_ADDRESS`, optional `SES_REPLY_TO`/`SES_CONFIGURATION_SET`, and the existing AWS credentials/default credential chain. Web needs `ses:CreateEmailIdentity` and `ses:GetEmailIdentity`; worker needs `ses:GetEmailIdentity` plus its existing `ses:SendEmail` permission for authorized customer-domain identities. A sending IAM policy restricted to evenbooks.org must be extended. SES production access is required for sending to unverified recipients.

For dynamic customer domains, see [`ops/email/company-sender-policy.json`](../ops/email/company-sender-policy.json) and its [application instructions](../ops/email/README.md). The proposed production policy allows all SES identities in the configured account/region, retains the static outbound IP restrictions, and removes the Evenbooks-only From-address condition. Company-specific DNS proof and successful SES verification remain enforced by the application.

Every SES email uses a company tenant named `evenbooks-company-<company UUID>`, derived from the persisted email row. The adapter provisions the tenant and assigns AWS's Strict reputation policy before its first send. All domains belonging to a company share that tenant, including the Evenbooks sender and test emails; changing a sender cannot bypass a pause. Paused tenants fail delivery permanently and are never automatically reinstated. Existing company quotas and local suppression checks remain in place.

Tenants require a configuration set. The adapter uses the existing `SES_CONFIGURATION_SET` if supplied; otherwise it provisions `evenbooks-company-emails` and, when `SES_SNS_TOPIC_ARN` is configured, a destination for the existing delivery/bounce/complaint webhook. Apply the complete IAM policy and deploy the updated worker and web app; tenant enforcement is required from the start. Follow the [setup instructions](../ops/email/README.md#setup-and-deployment). No additional database migration is required for tenant routing.

With `EMAIL_DRIVER=log`, sender setup uses a local fixture and remains pending. It never claims a real domain is verified. Automated tests explicitly supply a fixture manager with DNS proofs and provider status.

Live delivery authentication and Gmail/Outlook rendering must be checked against a real test domain after adding DNS records and enabling the SES permissions. Local tests do not contact customer domains or send real email.

## API

- `GET/PATCH /api/company/invoice-presentation`: defaults/current version; save with the expected version.
- `POST /api/company/invoice-presentation/preview`: sample or invoice email preview, optionally with unsaved settings/overrides.
- `POST /api/company/invoice-presentation/sample-pdf`: binary PDF preview/download.
- `POST /api/company/invoice-presentation/test-email`: durable test email with sample attachment.
- `GET/POST /api/company/email-senders`: list or set up a sender.
- `POST /api/company/email-senders/:id/verify`: refresh provider/DNS verification.
- `POST /api/company/email-senders/:id/cancel`: cancel pending/failed verification for this company.
- `POST /api/company/email-senders/select`: select a verified identity; `id: null` selects the platform sender.
- `POST /api/invoices/:id/send`: adds optional subject and `usePlatformSender` overrides.
- `POST /api/invoices/:id/pdf`: adds `applyCurrentDesign` to create a new PDF with current branding.
