import { z } from 'zod';
import { CreateRefundInput } from '@evenbooks/contracts';
import { createRefund, listRefunds } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Query = z.object({ paymentId: z.uuid().optional(), creditNoteId: z.uuid().optional(), contactId: z.uuid().optional() });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => listRefunds(s, query)));
export const POST = route({ body: CreateRefundInput }, async ({ principal, body }) => inCompany(principal, (s) => createRefund(s, body)));
