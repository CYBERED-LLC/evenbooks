import { CreateLedgerImportInput } from '@evenbooks/contracts';
import { createLedgerImport, listLedgerImports } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { getStorage } from '@/server/storage';

export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => listLedgerImports(s)));
export const POST = route({ body: CreateLedgerImportInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => createLedgerImport(s, getStorage(), body)));
