/** Tax years offered by Schedule C and the mappings page: 2024 (first supported) through next year. */
export function taxYears(now = new Date()): number[] {
  const last = now.getFullYear() + 1;
  const years: number[] = [];
  for (let y = 2024; y <= last; y++) years.push(y);
  return years;
}
