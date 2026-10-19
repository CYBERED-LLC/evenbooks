import { CreateManualBankTransactionInput, ListInboxQuery } from '@evenbooks/contracts';
import { createManualBankTransaction, listInbox } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListInboxQuery }, async ({ principal, query }) => inCompany(principal, (s) => listInbox(s, query)));
export const POST = route({ body: CreateManualBankTransactionInput }, async ({ principal, body }) => inCompany(principal, (s) => createManualBankTransaction(s, body)));
