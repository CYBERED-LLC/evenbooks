import { ResumeScheduleInput } from '@evenbooks/contracts';
import { resumeSchedule } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ResumeScheduleInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => resumeSchedule(s, params.id!, body)));
