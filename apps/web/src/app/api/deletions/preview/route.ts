import { DeletionTarget } from '@evenbooks/contracts';
import { previewDeletion } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: DeletionTarget, role: 'admin' }, async ({ principal, query }) => inCompany(principal, (s) => previewDeletion(s, query)));
