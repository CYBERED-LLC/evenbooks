import { z } from 'zod';
import { PreviewCsvInput } from '@evenbooks/contracts';
import { listBatches, previewCsv } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { getStorage } from '@/server/storage';

const Query = z.object({ bankAccountId: z.uuid().optional() });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => listBatches(s, query.bankAccountId)));
export const POST = route({ body: PreviewCsvInput }, async ({ principal, body }) => inCompany(principal, (s) => previewCsv(s, getStorage(), body)));
