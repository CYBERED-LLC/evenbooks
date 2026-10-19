import { CreateScheduleInput } from '@evenbooks/contracts';
import { createSchedule, listSchedules } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => listSchedules(s)));
export const POST = route({ body: CreateScheduleInput }, async ({ principal, body }) => inCompany(principal, (s) => createSchedule(s, body)));
