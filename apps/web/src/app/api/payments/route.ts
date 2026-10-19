import { CreatePaymentInput, ListPaymentsQuery } from '@evenbooks/contracts';
import { createPayment, listPayments } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListPaymentsQuery }, async ({ principal, query }) => inCompany(principal, (s) => listPayments(s, query)));
export const POST = route({ body: CreatePaymentInput }, async ({ principal, body }) => inCompany(principal, (s) => createPayment(s, body)));
