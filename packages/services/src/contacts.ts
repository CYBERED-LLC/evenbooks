import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import type { BulkContactsInput, BulkContactsResultDto, ContactDto, ContactSort, CreateContactInput, ListContactsQuery, Page, UpdateContactInput } from '@evenbooks/contracts';
import { ServiceError, notFound, translateDbError, versionConflict } from './errors';
import { keyset, type SortColumns } from './keyset';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';

type ContactRow = typeof schema.contacts.$inferSelect;

export function toContactDto(c: ContactRow): ContactDto {
  return {
    id: c.id,
    name: c.name,
    isCustomer: c.isCustomer,
    isVendor: c.isVendor,
    email: c.email,
    phone: c.phone,
    billingAddress: c.billingAddress,
    notes: c.notes,
    isArchived: c.isArchived,
    version: c.version,
    createdAt: c.createdAt,
  };
}

const CONTACT_SORT_COLUMNS: SortColumns<ContactRow, ContactSort> = {
  name: { expr: sql`lower(${schema.contacts.name})`, cast: 'text', value: (r) => r.name.toLowerCase() },
  // The column mapper surfaces timestamps as ISO strings with millisecond precision; order by the
  // same truncated value or a cursor would not equal its own row.
  createdAt: { expr: sql`date_trunc('milliseconds', ${schema.contacts.createdAt})`, cast: 'timestamptz', value: (r) => r.createdAt },
};

export async function listContacts(s: ServiceContext, q: ListContactsQuery): Promise<Page<ContactDto>> {
  const conds = [eq(schema.contacts.companyId, s.ctx.companyId)];
  if (!q.includeArchived) conds.push(eq(schema.contacts.isArchived, false));
  if (q.kind === 'customer') conds.push(eq(schema.contacts.isCustomer, true));
  if (q.kind === 'vendor') conds.push(eq(schema.contacts.isVendor, true));
  if (q.q) conds.push(or(ilike(schema.contacts.name, `%${q.q}%`), ilike(schema.contacts.email, `%${q.q}%`))!);
  const sort = q.sort ?? 'name';
  const ks = keyset({
    columns: CONTACT_SORT_COLUMNS,
    sort,
    dir: q.dir ?? (sort === 'name' ? 'asc' : 'desc'),
    idColumn: schema.contacts.id,
    idOf: (r) => r.id,
    cursor: q.cursor,
  });
  const [{ total }] = (await s.tx.select({ total: sql<number>`count(*)::int` }).from(schema.contacts).where(and(...conds))) as [{ total: number }];
  const rows = await s.tx
    .select()
    .from(schema.contacts)
    .where(and(...conds, ks.after))
    .orderBy(...ks.orderBy)
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit).map(toContactDto), nextCursor: ks.next(rows, q.limit), total };
}

export async function getContact(s: ServiceContext, id: string): Promise<ContactRow> {
  const [row] = await s.tx
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.companyId, s.ctx.companyId), eq(schema.contacts.id, id)))
    .limit(1);
  if (!row) throw notFound('Contact');
  return row;
}

export async function createContact(s: ServiceContext, input: CreateContactInput): Promise<ContactDto> {
  const [row] = await s.tx
    .insert(schema.contacts)
    .values({
      companyId: s.ctx.companyId,
      name: input.name.trim(),
      isCustomer: input.isCustomer,
      isVendor: input.isVendor,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      billingAddress: input.billingAddress ?? {},
      notes: input.notes ?? null,
    })
    .returning();
  await recordAudit(s, { action: 'contact.created', entityType: 'contact', entityId: row!.id, details: { name: row!.name } });
  return toContactDto(row!);
}

export async function updateContact(s: ServiceContext, id: string, input: UpdateContactInput): Promise<ContactDto> {
  await getContact(s, id);
  const { version, ...rest } = input;
  const [row] = await s.tx
    .update(schema.contacts)
    .set({ ...rest, name: rest.name?.trim(), email: rest.email === undefined ? undefined : rest.email?.trim() || null })
    .where(and(eq(schema.contacts.companyId, s.ctx.companyId), eq(schema.contacts.id, id), eq(schema.contacts.version, version)))
    .returning();
  if (!row) throw versionConflict('Contact');
  await recordAudit(s, { action: rest.isArchived ? 'contact.archived' : 'contact.updated', entityType: 'contact', entityId: id, details: { fields: Object.keys(rest) } });
  return toContactDto(row);
}

/**
 * Archive or restore many contacts. Each contact runs in its own savepoint, so
 * a stale version fails only that row; the result reports every row with its
 * new version (what "Undo" sends back as `unarchive`).
 */
export async function bulkUpdateContacts(s: ServiceContext, input: BulkContactsInput): Promise<BulkContactsResultDto> {
  const isArchived = input.action === 'archive';
  const seen = new Set<string>();
  const results: BulkContactsResultDto['results'] = [];
  for (const item of input.items) {
    if (seen.has(item.id)) {
      results.push({ id: item.id, ok: false, error: { code: 'duplicate', message: 'Listed more than once in this request' } });
      continue;
    }
    seen.add(item.id);
    try {
      const contact = await s.tx.transaction((tx) => updateContact({ ...s, tx }, item.id, { version: item.version, isArchived }));
      results.push({ id: item.id, ok: true, contact });
    } catch (err) {
      if (err instanceof ServiceError) results.push({ id: item.id, ok: false, error: { code: err.code, message: err.message } });
      else {
        const t = translateDbError(err);
        if (!t) throw err;
        results.push({ id: item.id, ok: false, error: { code: t.code, message: t.message } });
      }
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
