import { CsvMapping } from '@evenbooks/contracts';
import { remapBatch } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getStorage } from '@/server/storage';

export const POST = route({ body: CsvMapping, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => remapBatch(s, getStorage(), params.id!, body)));
