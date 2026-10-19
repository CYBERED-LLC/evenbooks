import { ListAuditQuery } from '@evenbooks/contracts';
import { listAudit } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListAuditQuery }, async ({ principal, query }) => inCompany(principal, (s) => listAudit(s, query)));
