import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: [path.resolve(here, '../../../.env'), path.resolve(here, '../.env')], quiet: true });

export interface WorkerEnv {
  databaseUrl: string;
  concurrency: number;
  publicBaseUrl: string;
  isProduction: boolean;
}

export function workerEnv(): WorkerEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return {
    databaseUrl,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    isProduction: (process.env.APP_ENV ?? process.env.NODE_ENV) === 'production',
  };
}
