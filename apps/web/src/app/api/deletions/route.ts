import { DeleteRecordInput } from '@evenbooks/contracts';
import { deleteRecord } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

/** Permanent delete of a posted record (admin; the company setting is enforced by the service and the database). */
export const POST = route({ body: DeleteRecordInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => deleteRecord(s, body)));
