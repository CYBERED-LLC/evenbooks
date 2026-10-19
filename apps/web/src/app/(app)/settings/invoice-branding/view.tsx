'use client';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InvoicePresentationInput, type InvoicePresentationDto, type SenderIdentityDto } from '@evenbooks/contracts';
import { EMAIL_PLACEHOLDERS } from '@evenbooks/domain';
import { useCompany } from '@/components/company-context';
import { Badge, Card, CardBody, CardHeader, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, idempotencyKey } from '@/lib/api-client';
import {
  useInvoicePresentation,
  useSaveInvoicePresentation,
  useInvoiceEmailPreview,
  useCompanyEmailSenders,
} from '@/lib/queries/invoice-presentation';
import { useDebounced } from '@/lib/use-debounced';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';

export function InvoiceBrandingView() {
  const q = useInvoicePresentation();
  return (
    <>
      <PageHeader title="Invoice branding" description="Customize your invoices, email templates and company sender." />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      ) : q.data ? (
        <BrandingForm key={`${q.data.version}`} initial={q.data} />
      ) : null}
    </>
  );
}
function PdfFrame({ blob }: { blob: Blob }) {
  const [url, setUrl] = React.useState('');
  React.useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url ? <iframe title="Invoice PDF preview" src={url} className="h-[650px] w-full rounded border border-stone-200" /> : null;
}
function BrandingForm({ initial }: { initial: InvoicePresentationDto }) {
  const { company, isAdmin } = useCompany();
  const toast = useToast();
  const [form, setForm] = React.useState(initial);
  const [testTo, setTestTo] = React.useState(company.email ?? '');
  const [logoError, setLogoError] = React.useState<string | null>(null);
  const [previewTab, setPreviewTab] = React.useState<'email' | 'invoice'>('email');
  const save = useSaveInvoicePresentation();
  const dirty = JSON.stringify(initial) !== JSON.stringify(form);
  const unsaved = useUnsavedChanges(dirty);
  const validation = InvoicePresentationInput.safeParse(form);
  const valid = validation.success;
  const delayed = useDebounced(form, 450);
  const preview = useInvoiceEmailPreview({ presentation: delayed }, valid && previewTab === 'email');
  const pdf = useQuery({
    queryKey: ['sample-invoice-pdf', company.id, delayed],
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/company/invoice-presentation/sample-pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-id': company.id },
        body: JSON.stringify(delayed),
        signal,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message ?? 'Could not generate preview');
      }
      return res.blob();
    },
    enabled: valid && previewTab === 'invoice',
    retry: false,
  });
  const test = useMutation({
    mutationFn: () =>
      api('/api/company/invoice-presentation/test-email', {
        companyId: company.id,
        method: 'POST',
        body: { ...form, to: testTo, idempotencyKey: idempotencyKey() },
      }),
    onSuccess: () => toast.success('Test email queued with a sample PDF'),
    onError: (e) => toast.error(e.message),
  });
  const branding = (key: keyof InvoicePresentationDto['branding'], value: string | boolean | null) =>
    setForm((f) => ({ ...f, branding: { ...f.branding, [key]: value } }));
  const email = (key: keyof InvoicePresentationDto['email'], value: string | null) =>
    setForm((f) => ({ ...f, email: { ...f.email, [key]: value } }));
  const upload = async (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 256_000) {
      setLogoError('Choose a PNG or JPEG under 250 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => branding('logo', String(reader.result));
    reader.onerror = () => setLogoError('Could not read this image.');
    reader.readAsDataURL(file);
  };
  const download = async () => {
    try {
      const res = await fetch('/api/company/invoice-presentation/sample-pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-id': company.id },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message ?? 'Could not generate PDF');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sample-invoice.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <div className="space-y-6">
      {!isAdmin && <p className="text-sm text-stone-600">Company administrators can change these settings.</p>}
      <div className="grid items-start gap-6 2xl:grid-cols-2">
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && isAdmin)
              save.mutate(form, {
                onSuccess: () => {
                  unsaved.markSaved();
                  toast.success('Invoice settings saved');
                },
              });
          }}
        >
          <fieldset disabled={!isAdmin || save.isPending} className="space-y-6">
            <Card>
              <CardHeader title="Invoice design" description="Defaults apply to new invoices. Issued invoices keep their saved design." />
              <CardBody>
                <div className="space-y-4">
                  <Field
                    label="Logo"
                    htmlFor="invoice-logo"
                    error={logoError ?? undefined}
                    hint="PNG or JPEG, up to 250 KB and 4,000 pixels per side."
                  >
                    <Input id="invoice-logo" type="file" accept="image/png,image/jpeg" onChange={(e) => void upload(e.target.files?.[0])} />
                  </Field>
                  {form.branding.logo && (
                    <div className="flex items-center gap-3">
                      <img src={form.branding.logo} alt="Company logo" className="max-h-16 max-w-36 object-contain" />
                      <Button type="button" variant="secondary" size="sm" onClick={() => branding('logo', null)}>
                        Remove logo
                      </Button>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Layout" htmlFor="invoice-layout">
                      <Select id="invoice-layout" value={form.branding.layout} onChange={(e) => branding('layout', e.target.value)}>
                        <option value="classic">Classic</option>
                        <option value="modern">Modern</option>
                      </Select>
                    </Field>
                    <Field label="Paper size" htmlFor="paper-size">
                      <Select id="paper-size" value={form.branding.paperSize} onChange={(e) => branding('paperSize', e.target.value)}>
                        <option value="LETTER">Letter</option>
                        <option value="A4">A4</option>
                      </Select>
                    </Field>
                  </div>
                  <Field label="Accent color" htmlFor="accent-color">
                    <Input
                      id="accent-color"
                      type="color"
                      value={form.branding.accentColor}
                      onChange={(e) => branding('accentColor', e.target.value)}
                    />
                  </Field>
                  <fieldset className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">Invoice row columns</legend>
                    <div className="flex flex-col items-start gap-2">
                      <Checkbox label="Show quantity" checked={form.branding.showQuantity} onChange={(e) => branding('showQuantity', e.target.checked)} />
                      <Checkbox label="Show unit price" checked={form.branding.showUnitPrice} onChange={(e) => branding('showUnitPrice', e.target.checked)} />
                      <Checkbox label="Show tax on each row" checked={form.branding.showLineTax} onChange={(e) => branding('showLineTax', e.target.checked)} />
                    </div>
                    <p className="text-xs text-stone-600">Description and amount always appear. Invoice totals and the tax summary stay visible.</p>
                  </fieldset>
                  <Field label="Default notes" htmlFor="default-notes">
                    <Textarea
                      id="default-notes"
                      maxLength={2000}
                      value={form.branding.defaultNotes ?? ''}
                      onChange={(e) => branding('defaultNotes', e.target.value || null)}
                    />
                  </Field>
                  <Field label="Default footer" htmlFor="default-footer">
                    <Textarea
                      id="default-footer"
                      maxLength={2000}
                      value={form.branding.defaultFooter ?? ''}
                      onChange={(e) => branding('defaultFooter', e.target.value || null)}
                    />
                  </Field>
                  <Field label="Payment instructions" htmlFor="payment-instructions" hint="Shown on invoices and their emails.">
                    <Textarea
                      id="payment-instructions"
                      maxLength={2000}
                      value={form.branding.paymentInstructions ?? ''}
                      onChange={(e) => branding('paymentInstructions', e.target.value || null)}
                    />
                  </Field>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Email template" description="Used for manual, bulk and recurring invoice emails." />
              <CardBody>
                <div className="space-y-4">
                  <Field label="Subject" htmlFor="email-subject" required>
                    <Input
                      id="email-subject"
                      value={form.email.subject}
                      maxLength={250}
                      onChange={(e) => email('subject', e.target.value)}
                    />
                  </Field>
                  <Field label="Message" htmlFor="email-message" hint="Plain text with paragraphs and supported placeholders.">
                    <Textarea
                      id="email-message"
                      rows={5}
                      value={form.email.message}
                      maxLength={5000}
                      onChange={(e) => email('message', e.target.value)}
                    />
                  </Field>
                  <Field label="Signature" htmlFor="email-signature">
                    <Textarea
                      id="email-signature"
                      value={form.email.signature}
                      maxLength={2000}
                      onChange={(e) => email('signature', e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Reply-to address"
                    htmlFor="email-reply-to"
                    hint={`Defaults to ${company.email ?? 'the platform reply-to address'}.`}
                  >
                    <Input
                      id="email-reply-to"
                      type="email"
                      value={form.email.replyTo ?? ''}
                      onChange={(e) => email('replyTo', e.target.value || null)}
                    />
                  </Field>
                  <details className="text-sm text-stone-600">
                    <summary className="cursor-pointer font-medium">Available placeholders</summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {EMAIL_PLACEHOLDERS.map((p) => (
                        <code key={p} className="rounded bg-stone-100 px-2 py-1">{`{{${p}}}`}</code>
                      ))}
                    </div>
                  </details>
                </div>
              </CardBody>
            </Card>
            {!valid && (
              <div role="alert" className="text-sm text-red-700">
                {validation.error.issues.map((issue) => (
                  <p key={issue.path.join('.')}>
                    {issue.path.join('.')}: {issue.message}
                  </p>
                ))}
              </div>
            )}
            {save.isError && <ErrorNotice error={save.error} />}
            <Button type="submit" loading={save.isPending} disabled={!dirty || !valid}>
              Save invoice settings
            </Button>
          </fieldset>
        </form>
        <div className="space-y-6 2xl:sticky 2xl:top-6">
          <Card>
            <CardHeader
              title="Preview"
              actions={
                <div className="flex gap-2">
                  <Button size="sm" variant={previewTab === 'email' ? 'primary' : 'secondary'} onClick={() => setPreviewTab('email')}>
                    Email
                  </Button>
                  <Button size="sm" variant={previewTab === 'invoice' ? 'primary' : 'secondary'} onClick={() => setPreviewTab('invoice')}>
                    Invoice
                  </Button>
                </div>
              }
            />
            <CardBody>
              {previewTab === 'email' ? (
                <>
                  {preview.isPending ? (
                    <Spinner label="Preparing preview" />
                  ) : preview.isError ? (
                    <ErrorNotice error={preview.error} onRetry={() => preview.refetch()} />
                  ) : preview.data ? (
                    <>
                      <dl className="mb-4 space-y-1 break-words text-sm">
                        <div>
                          <dt className="inline text-stone-500">From: </dt>
                          <dd className="inline">{preview.data.from}</dd>
                        </div>
                        <div>
                          <dt className="inline text-stone-500">Reply-to: </dt>
                          <dd className="inline">{preview.data.replyTo ?? 'None'}</dd>
                        </div>
                        <div>
                          <dt className="inline text-stone-500">Subject: </dt>
                          <dd className="inline">{preview.data.subject}</dd>
                        </div>
                      </dl>
                      <iframe
                        title="Invoice email preview"
                        sandbox=""
                        srcDoc={preview.data.html}
                        className="h-[580px] w-full rounded border border-stone-200"
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {pdf.isPending ? (
                    <Spinner label="Preparing PDF" />
                  ) : pdf.isError ? (
                    <ErrorNotice error={pdf.error} />
                  ) : pdf.data ? (
                    <PdfFrame blob={pdf.data} />
                  ) : null}
                </>
              )}
              <Button className="mt-4" variant="secondary" disabled={!valid} onClick={() => void download()}>
                Download sample PDF
              </Button>
            </CardBody>
          </Card>
          {isAdmin && (
            <Card>
              <CardHeader title="Send a test" description="Uses your current edits and sender, with a sample invoice attached." />
              <CardBody>
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (valid) test.mutate();
                  }}
                >
                  <Field label="Test recipient" htmlFor="test-recipient">
                    <Input id="test-recipient" type="email" required value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                  </Field>
                  <Button type="submit" variant="secondary" loading={test.isPending} disabled={!valid}>
                    Send test email
                  </Button>
                  {test.isError && <ErrorNotice error={test.error} />}
                </form>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      {isAdmin && <SenderSettings />}
    </div>
  );
}
function DnsRecordCopy({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="max-w-full cursor-pointer rounded border border-stone-200 bg-stone-100 px-2 py-1 text-left text-xs text-stone-800 transition-colors hover:bg-stone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 focus-visible:ring-offset-2"
      aria-label={`Copy ${label}`}
      title="Click to copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success('Copied to clipboard');
        } catch {
          toast.error('Could not copy', 'Please select and copy the text manually.');
        }
      }}
    >
      <code className="break-all whitespace-pre-wrap">{value}</code>
    </button>
  );
}

function SenderSettings() {
  const { company } = useCompany();
  const q = useCompanyEmailSenders();
  const qc = useQueryClient();
  const toast = useToast();
  const [domain, setDomain] = React.useState('');
  const [fromEmail, setFromEmail] = React.useState(company.email ?? '');
  const [fromName, setFromName] = React.useState(company.name);
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api<SenderIdentityDto | SenderIdentityDto[]>(`/api/company/email-senders${path}`, { companyId: company.id, method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['company-email-senders', company.id] });
      void qc.invalidateQueries({ queryKey: ['invoice-email-preview', company.id] });
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: ['company-email-senders', company.id] });
      toast.error(e.message);
    },
  });
  return (
    <Card>
      <CardHeader
        title="Company sender"
        description="Send invoices from your own domain after verifying it. Your existing mailbox keeps receiving replies."
      />
      <CardBody>
        <div className="space-y-5">
          {q.isPending ? (
            <Spinner />
          ) : q.isError ? (
            <ErrorNotice error={q.error} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">
                  {q.data?.some((r) => r.active)
                    ? 'Your selected company sender is used for new emails.'
                    : 'Emails currently use the Evenbooks sender.'}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={action.isPending || !q.data?.some((r) => r.active)}
                  onClick={() => action.mutate({ path: '/select', body: { id: null } })}
                >
                  Use Evenbooks sender
                </Button>
              </div>
              {q.data?.map((row) => (
                <section key={row.id} className="space-y-3 rounded-lg border border-stone-200 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="break-all font-medium">
                      {row.fromName} &lt;{row.fromEmail}&gt;
                    </p>
                    <Badge tone={row.status === 'verified' ? 'green' : row.status === 'failed' ? 'red' : 'amber'}>{row.status}</Badge>
                    {row.active && <Badge>Selected</Badge>}
                  </div>
                  {row.lastError && <p className="text-sm text-stone-600">{row.lastError}</p>}
                  <p className="text-sm text-stone-600">Add these records at your DNS provider. Keep your existing mailbox records.</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          <th className="p-2">Type</th>
                          <th className="p-2">Name</th>
                          <th className="p-2">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.records.map((record) => (
                          <tr key={record.name} className="border-t border-stone-100">
                            <td className="p-2">{record.type}</td>
                            <td className="p-2">
                              <DnsRecordCopy value={record.name} label={`${record.purpose} name`} />
                            </td>
                            <td className="p-2">
                              <DnsRecordCopy value={record.value} label={`${record.purpose} value`} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={action.isPending}
                      onClick={() => action.mutate({ path: `/${row.id}/verify` })}
                    >
                      Check verification
                    </Button>
                    <Button
                      size="sm"
                      disabled={row.status !== 'verified' || row.active || action.isPending}
                      onClick={() => action.mutate({ path: '/select', body: { id: row.id } })}
                    >
                      Use this sender
                    </Button>
                    {row.status !== 'verified' && <Button
                      size="sm"
                      variant="secondary"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ path: `/${row.id}/cancel` }, { onSuccess: () => toast.success('Domain verification cancelled') })}
                    >Cancel verification</Button>}
                  </div>
                  {row.checkedAt && <p className="text-xs text-stone-500">Last checked {new Date(row.checkedAt).toLocaleString()}</p>}
                </section>
              ))}
            </>
          )}
          <form
            className="space-y-4 border-t border-stone-200 pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              action.mutate({ path: '', body: { domain, fromEmail, fromName } });
            }}
          >
            <p className="font-medium">Add or update a company sender</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Company domain" htmlFor="sender-domain">
                <Input id="sender-domain" required placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
              </Field>
              <Field label="From address" htmlFor="sender-address">
                <Input
                  id="sender-address"
                  required
                  type="email"
                  placeholder="billing@example.com"
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                />
              </Field>
              <Field label="Sender name" htmlFor="sender-name">
                <Input id="sender-name" required maxLength={100} value={fromName} onChange={(e) => setFromName(e.target.value)} />
              </Field>
            </div>
            <p className="text-sm text-stone-600">
              Use a domain you control, including one hosted by Google Workspace or Microsoft 365. Personal @gmail.com and @outlook.com
              addresses need a mailbox connection.
            </p>
            <Button type="submit" variant="secondary" loading={action.isPending}>
              Set up sender
            </Button>
          </form>
          {action.isError && <ErrorNotice error={action.error} />}
        </div>
      </CardBody>
    </Card>
  );
}
