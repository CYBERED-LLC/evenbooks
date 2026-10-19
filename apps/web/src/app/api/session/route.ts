import { route } from '@/server/api';
import { env } from '@/server/env';
import { serverFeatures } from '@/server/processor';
import type { SessionDto } from '@evenbooks/contracts';

export const GET = route({}, async ({ principal }): Promise<SessionDto> => ({
  userId: principal.session.userId,
  company: principal.company,
  role: principal.role,
  authMode: env().authMode,
  memberLimit: principal.memberLimit,
  features: serverFeatures(),
}));
