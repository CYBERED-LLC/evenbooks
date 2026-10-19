import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { parsePrecise } from '@evenbooks/domain';
import type { CreateItemInput, ItemDto, UpdateItemInput } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { getAccount } from './accounts';

type ItemRow = typeof schema.items.$inferSelect;

export function toItemDto(i: ItemRow): ItemDto {
  return {
    id: i.id,
    name: i.name,
    description: i.description,
    kind: i.kind,
    unitPrice: parsePrecise(i.unitPrice).toString(),
    incomeAccountId: i.incomeAccountId,
    defaultTaxRateIds: i.defaultTaxRateIds,
    isActive: i.isActive,
    version: i.version,
  };
}

async function validateItem(s: ServiceContext, input: { incomeAccountId?: string; defaultTaxRateIds?: string[] }) {
  if (input.incomeAccountId) {
    const a = await getAccount(s, input.incomeAccountId);
    if (a.type !== 'income') throw new ServiceError('validation', 'Choose an income category for this item.');
  }
  if (input.defaultTaxRateIds?.length) {
    const rates = await s.tx
      .select({ id: schema.taxRates.id })
      .from(schema.taxRates)
      .where(and(eq(schema.taxRates.companyId, s.ctx.companyId), inArray(schema.taxRates.id, input.defaultTaxRateIds)));
    if (rates.length !== new Set(input.defaultTaxRateIds).size) throw new ServiceError('validation', 'Unknown tax rate');
  }
}

export async function listItems(s: ServiceContext, opts: { includeInactive?: boolean } = {}): Promise<ItemDto[]> {
  const conds = [eq(schema.items.companyId, s.ctx.companyId)];
  if (!opts.includeInactive) conds.push(eq(schema.items.isActive, true));
  const rows = await s.tx
    .select()
    .from(schema.items)
    .where(and(...conds))
    .orderBy(asc(schema.items.name));
  return rows.map(toItemDto);
}

export async function getItem(s: ServiceContext, id: string): Promise<ItemRow> {
  const [row] = await s.tx
    .select()
    .from(schema.items)
    .where(and(eq(schema.items.companyId, s.ctx.companyId), eq(schema.items.id, id)))
    .limit(1);
  if (!row) throw notFound('Item');
  return row;
}

export async function createItem(s: ServiceContext, input: CreateItemInput): Promise<ItemDto> {
  await validateItem(s, input);
  const [row] = await s.tx
    .insert(schema.items)
    .values({
      companyId: s.ctx.companyId,
      name: input.name.trim(),
      description: input.description ?? null,
      kind: input.kind,
      unitPrice: parsePrecise(input.unitPrice).toString(),
      incomeAccountId: input.incomeAccountId,
      defaultTaxRateIds: input.defaultTaxRateIds,
    })
    .returning();
  await recordAudit(s, { action: 'item.created', entityType: 'item', entityId: row!.id, details: { name: row!.name } });
  return toItemDto(row!);
}

export async function updateItem(s: ServiceContext, id: string, input: UpdateItemInput): Promise<ItemDto> {
  await getItem(s, id);
  await validateItem(s, input);
  const { version, ...rest } = input;
  const [row] = await s.tx
    .update(schema.items)
    .set({ ...rest, name: rest.name?.trim(), unitPrice: rest.unitPrice ? parsePrecise(rest.unitPrice).toString() : undefined })
    .where(and(eq(schema.items.companyId, s.ctx.companyId), eq(schema.items.id, id), eq(schema.items.version, version)))
    .returning();
  if (!row) throw versionConflict('Item');
  await recordAudit(s, { action: 'item.updated', entityType: 'item', entityId: id, details: { fields: Object.keys(rest) } });
  return toItemDto(row);
}
