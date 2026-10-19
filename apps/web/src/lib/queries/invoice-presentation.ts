'use client';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoicePresentationDto, UpdateInvoicePresentationInput, SenderIdentityDto } from '@evenbooks/contracts';
import { useCompany } from '@/components/company-context';
import { api } from '@/lib/api-client';
export interface InvoiceEmailPreview {
  from: string;
  replyTo: string | null;
  subject: string;
  message: string;
  text: string;
  html: string;
  templateVersion: number;
}
export function useInvoicePresentation() {
  const { company } = useCompany();
  return useQuery({
    queryKey: ['invoice-presentation', company.id],
    queryFn: ({ signal }) => api<InvoicePresentationDto>('/api/company/invoice-presentation', { companyId: company.id, signal }),
  });
}
export function useSaveInvoicePresentation() {
  const { company } = useCompany();
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (body: UpdateInvoicePresentationInput) =>
      api<InvoicePresentationDto>('/api/company/invoice-presentation', { companyId: company.id, method: 'PATCH', body }),
    onSuccess: (data) => {
      qc.setQueryData(['invoice-presentation', company.id], data);
      router.refresh();
    },
  });
}
export function useInvoiceEmailPreview(
  input: {
    invoiceId?: string;
    subject?: string;
    message?: string | null;
    presentation?: Omit<InvoicePresentationDto, 'version'>;
    usePlatformSender?: boolean;
  },
  enabled = true,
) {
  const { company } = useCompany();
  return useQuery({
    queryKey: ['invoice-email-preview', company.id, input],
    queryFn: ({ signal }) =>
      api<InvoiceEmailPreview>('/api/company/invoice-presentation/preview', { companyId: company.id, method: 'POST', body: input, signal }),
    enabled,
    retry: false,
    staleTime: 0,
  });
}
export function useCompanyEmailSenders(enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: ['company-email-senders', company.id],
    queryFn: ({ signal }) => api<SenderIdentityDto[]>('/api/company/email-senders', { companyId: company.id, signal }),
    enabled,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'pending') ? 30_000 : false),
  });
}
