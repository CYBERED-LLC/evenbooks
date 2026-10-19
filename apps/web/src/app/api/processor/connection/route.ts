import { UpdateProcessorConnectionInput } from '@evenbooks/contracts';
import { getProcessorConnection, updateProcessorConnection } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { processorDeps } from '@/server/processor';

/** The company's live payment-processor connection (null when none). */
export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => getProcessorConnection(s, processorDeps())));
export const PATCH = route({ body: UpdateProcessorConnectionInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => updateProcessorConnection(s, processorDeps(), body)));
