import 'server-only';
import { createSimpleFinClientFromEnv, type SimpleFinClient } from '@evenbooks/integrations';

declare global {
  var __evenbooksSimpleFin: SimpleFinClient | undefined;
}

/** One client per process so the fixture driver keeps its claimed-token state in dev. */
export function getSimpleFin(): SimpleFinClient {
  if (!globalThis.__evenbooksSimpleFin) globalThis.__evenbooksSimpleFin = createSimpleFinClientFromEnv();
  return globalThis.__evenbooksSimpleFin;
}
