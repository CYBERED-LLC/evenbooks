/**
 * Keyword guesses from an account's name to a Schedule C line. Only a starting
 * point: suggestions are applied as unsaved edits for the user to review.
 * Rules are checked in order, most specific first.
 */
const EXPENSE_RULES: [RegExp, string][] = [
  [/\b(advertis|marketing|promotion|ads?\b)/, '8'],
  [/\b(equipment|machinery|vehicle)\b.*\b(rent|rental|lease)|\b(rent|rental|lease)\b.*\b(equipment|machinery|vehicle)/, '20a'],
  [/\b(car|truck|vehicle|auto|mileage|fuel|gas(oline)?|parking|tolls?)\b/, '9'],
  [/\b(commission|merchant|processing|payment processor|stripe|paypal|square|bank (fee|charge)s?|fees)\b/, '10'],
  [/\b(contract (labor|work)|contractor|subcontract|freelanc)/, '11'],
  [/\bdepletion\b/, '12'],
  [/\b(depreciation|amortization|section 179)\b/, '13'],
  [/\b(employee benefit|health (plan|insurance)|benefits)\b/, '14'],
  [/\binsurance\b/, '15'],
  [/\bmortgage\b/, '16a'],
  [/\binterest\b/, '16b'],
  [/\b(legal|attorney|lawyer|accounting|bookkeeping|professional|cpa|tax prep)/, '17'],
  [/\b(office|postage|shipping|software|subscriptions?|saas|printing|stationery)\b/, '18'],
  [/\b(pension|retirement|401\(?k\)?|profit.sharing)\b/, '19'],
  [/\b(rent|rental|lease)\b/, '20b'],
  [/\b(repairs?|maintenance)\b/, '21'],
  [/\bsuppl(y|ies)\b/, '22'],
  [/\b(taxes|tax|licen[cs]es?|permits?)\b/, '23'],
  [/\b(travel|airfare|flights?|hotels?|lodging)\b/, '24a'],
  [/\b(meals?|dining|restaurants?|food)\b/, '24b'],
  [/\b(utilit|electric|internet|phones?|telephone|mobile|cell|water|gas and electric)/, '25'],
  [/\b(wages?|salar|payroll)/, '26'],
];

const INCOME_RULES: [RegExp, string][] = [
  [/\b(returns?|refunds?|allowances?|discounts?)\b/, '2'],
  [/\b(interest|other income|miscellaneous|misc)\b/, '6'],
  [/\b(sales|revenue|services?|consulting|fees|income|receipts)\b/, '1'],
];

export function suggestLine(name: string, type: string): string | null {
  const n = name.toLowerCase();
  const rules = type === 'income' ? INCOME_RULES : type === 'expense' ? EXPENSE_RULES : [];
  for (const [re, code] of rules) if (re.test(n)) return code;
  return null;
}
