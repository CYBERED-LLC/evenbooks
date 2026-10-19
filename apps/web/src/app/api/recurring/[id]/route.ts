import { UpdateScheduleInput } from '@evenbooks/contracts';
import { getSchedule, updateSchedule } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getSchedule(s, params.id!)));
export const PATCH = route({ body: UpdateScheduleInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => updateSchedule(s, params.id!, body)));
