/**
 * Default rule pattern for a bank description: the text before the first
 * store number, date, card digits or reference code, so the rule also matches
 * the next visit ("BLUE COFFEE #0412" → "BLUE COFFEE",
 * "AMAZON MKTP US*2K4LL1 SEATTLE" → "AMAZON MKTP US"). The result is a slice
 * of the original text, so a "contains" rule always matches the description
 * it came from.
 */
export function cleanRulePattern(description: string): string {
  const text = description.trim();
  const tokenRe = /\S+/g;
  let cut = text.length;
  for (let m = tokenRe.exec(text); m; m = tokenRe.exec(text)) {
    const token = m[0];
    // "US*2K4LL1": keep the part before a starred reference code
    const star = token.search(/\*(?=[A-Za-z0-9]*\d)/);
    if (star >= 0) {
      const at = m.index + star;
      if (text.slice(0, at).trim().length >= 3) {
        cut = at;
        break;
      }
      continue;
    }
    if (isNoiseToken(token) && text.slice(0, m.index).trim().length >= 3) {
      cut = m.index;
      break;
    }
  }
  const out = text.slice(0, cut).replace(/[\s#*\-–,.:/]+$/, '');
  return out.length >= 3 ? out : text;
}

function isNoiseToken(token: string): boolean {
  if (/^#/.test(token)) return true; // "#0412", "#12"
  const core = token.replace(/^[(\[]+|[)\],.:;]+$/g, '');
  if (/^x{2,}\d+$/i.test(core)) return true; // "XXXX1234"
  if (/^\d{1,4}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(core)) return true; // "04/12", "2026-04-12"
  const digits = (core.match(/\d/g) ?? []).length;
  return digits >= 3 && digits / core.length >= 0.5; // "0412", "12345678", "P0412"
}

/** Case-insensitive "contains" check used for the preview count. */
export function descriptionMatches(description: string, pattern: string, matchType: 'contains' | 'starts_with' | 'equals'): boolean {
  const d = description.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (matchType === 'starts_with') return d.startsWith(p);
  if (matchType === 'equals') return d === p;
  return d.includes(p);
}
