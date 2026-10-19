import { describe, expect, it } from 'vitest';
import { cleanRulePattern, descriptionMatches } from './rule-pattern';

describe('cleanRulePattern', () => {
  it.each([
    ['BLUE COFFEE #0412', 'BLUE COFFEE'],
    ['STARBUCKS 00412 SEATTLE WA', 'STARBUCKS'],
    ['AMAZON MKTP US*2K4LL1 SEATTLE', 'AMAZON MKTP US'],
    ['SHELL OIL 57444 04/12', 'SHELL OIL'],
    ['DEBIT CARD PURCHASE XXXX1234 HOME DEPOT', 'DEBIT CARD PURCHASE'],
    ['ADOBE CREATIVE CLOUD', 'ADOBE CREATIVE CLOUD'],
    ['7-ELEVEN 12345', '7-ELEVEN'],
    ['ABC 123456', 'ABC'],
    ['#123 STORE', '#123 STORE'],
    ['  GITHUB   ', 'GITHUB'],
  ])('%s → %s', (input, expected) => {
    const out = cleanRulePattern(input);
    expect(out).toBe(expected);
    expect(descriptionMatches(input, out, 'contains')).toBe(true);
  });
});
