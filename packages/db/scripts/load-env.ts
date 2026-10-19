import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// Load the repo-root .env first, then any package-local .env (local wins).
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: [path.resolve(here, '../../../.env'), path.resolve(process.cwd(), '.env')], quiet: true });
