import { z } from 'zod';
import { Discount, DocumentLineInput } from '@evenbooks/contracts';
import { previewDocument } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Body = z.object({ lines: z.array(DocumentLineInput).min(1).max(200), documentDiscount: Discount.nullable().optional() });
export const POST = route({ body: Body }, async ({ principal, body }) => inCompany(principal, (s) => previewDocument(s, body)));
