import { describe, expect, it } from 'vitest';
import { DEFAULT_INVOICE_BRANDING } from '@evenbooks/domain';
import { InvoiceBrandingInput } from '../src/invoice-presentation';

describe('invoice row column settings', () => {
  it('accepts older clients and defaults their omitted columns to visible', () => {
    const { showQuantity: _quantity, showUnitPrice: _price, showLineTax: _tax, ...legacy } = DEFAULT_INVOICE_BRANDING;
    expect(InvoiceBrandingInput.parse(legacy)).toMatchObject({ showQuantity: true, showUnitPrice: true, showLineTax: true });
  });
  it('retains explicit hidden columns', () => {
    const branding = { ...DEFAULT_INVOICE_BRANDING, showQuantity: false, showUnitPrice: false, showLineTax: false };
    expect(InvoiceBrandingInput.parse(branding)).toEqual(branding);
  });
});
