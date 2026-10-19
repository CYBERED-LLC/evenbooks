'use client';
import * as React from 'react';
import type { ItemDto } from '@evenbooks/contracts';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useItems } from '@/lib/queries/items';
import { formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { ItemDialog } from '@/app/(app)/settings/items/view';

export interface ItemPickerProps {
  id?: string;
  value: string | null | undefined;
  onChange(id: string | null, item: ItemDto | null): void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  'data-autofocus'?: boolean;
}

/** Searchable item picker showing each item's price, with inline "New item". */
export function ItemPicker({ id, value, onChange, disabled, invalid, placeholder = 'Item…', className, ...aria }: ItemPickerProps) {
  const { company } = useCompany();
  const items = useItems();
  const [creating, setCreating] = React.useState<{ name: string } | null>(null);
  const all = React.useMemo(() => items.data ?? [], [items.data]);
  const selected = value ? all.find((i) => i.id === value) : undefined;

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      all
        .filter((i) => i.isActive || i.id === value)
        .map((i) => ({
          value: i.id,
          label: i.name,
          hint: formatMoney(i.unitPrice, company.baseCurrency),
          description: i.description ?? undefined,
          keywords: i.kind,
        })),
    [all, value, company.baseCurrency],
  );

  return (
    <>
      <Combobox
        id={id}
        className={className}
        value={value}
        options={options}
        selectedLabel={selected?.name}
        onChange={(v) => onChange(v, v ? (all.find((i) => i.id === v) ?? null) : null)}
        loading={items.isPending}
        placeholder={placeholder}
        disabled={disabled}
        invalid={invalid}
        clearable
        emptyText={all.length ? 'No item matches' : 'No items yet'}
        onCreate={(q) => setCreating({ name: q })}
        createLabel={(q) => (q ? `New item “${q}”` : 'New item…')}
        {...aria}
      />
      <ItemDialog open={!!creating} onClose={() => setCreating(null)} defaultName={creating?.name} onSaved={(item) => onChange(item.id, item)} />
    </>
  );
}
