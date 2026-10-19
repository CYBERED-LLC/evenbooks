import { refreshProcessorConnection } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { processorDeps } from '@/server/processor';

/** Pull the connected account's capability flags from the provider. */
export const POST = route({ role: 'admin' }, async ({ principal }) => inCompany(principal, (s) => refreshProcessorConnection(s, processorDeps())));
