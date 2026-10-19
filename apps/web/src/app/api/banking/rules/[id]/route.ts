import { UpdateRuleInput } from '@evenbooks/contracts';
import { deleteRule, updateRule } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const PATCH = route({ body: UpdateRuleInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => updateRule(s, params.id!, body)));
export const DELETE = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => deleteRule(s, params.id!));
  return new Response(null, { status: 204 });
});
