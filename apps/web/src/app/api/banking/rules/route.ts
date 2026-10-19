import { CreateRuleInput } from '@evenbooks/contracts';
import { createRule, listRules } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => listRules(s)));
export const POST = route({ body: CreateRuleInput }, async ({ principal, body }) => inCompany(principal, (s) => createRule(s, body)));
