import 'server-only';
import { createStorageFromEnv, type ObjectStorage } from '@evenbooks/integrations';

declare global {
  var __evenbooksStorage: ObjectStorage | undefined;
}

export function getStorage(): ObjectStorage {
  if (!globalThis.__evenbooksStorage) globalThis.__evenbooksStorage = createStorageFromEnv();
  return globalThis.__evenbooksStorage;
}
