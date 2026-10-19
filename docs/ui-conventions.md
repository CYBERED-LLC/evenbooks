# Web UI conventions (apps/web)

Read this before adding pages. Follow the existing examples exactly:
`src/app/(app)/accounts/view.tsx` (list + dialogs + optimistic edit), `src/app/(app)/journal/journal-form.tsx` (multi-line form), `src/app/(app)/journal/view.tsx` (URL-driven filters, pagination, prefetch on hover), `src/app/(app)/settings/periods/view.tsx`.

## Structure
- Route folder under `src/app/(app)/<area>/`. `page.tsx` is a server component that only renders a client `view.tsx` (or prefetches with `HydrationBoundary` like `dashboard/page.tsx`). Dynamic segments receive `params` as a Promise: `const { id } = await params`.
- Data hooks live in `src/lib/queries/<domain>.ts` (`'use client'`), built with `queryOptions` + `useQuery`/`useMutation`, using `api()` from `src/lib/api-client.ts` and keys from `src/lib/query-keys.ts` (`qk.*`). Always pass `companyId` from `useCompany()`; the key must start with `qk.company(companyId)`. Do not edit `query-keys.ts`; if a key is missing, compose it locally as `[...qk.company(companyId), '<domain>', ...]`.
- API base path is `/api/...`; the client sends the `x-company-id` header automatically. Every route returns JSON matching the zod DTOs in `packages/contracts/src/*.ts` (read them for exact field names). Lists return `{ items, nextCursor }`.
- Money values are decimal strings. Display with `formatMoney(value, company.baseCurrency)` from `src/lib/format.ts`; never do arithmetic with `Number` for anything shown as a total — use helpers in `src/lib/decimal.ts` (`sumDecimals`, `subtractDecimals`, `multiplyDecimals`) for form-side totals.
- Dates are `YYYY-MM-DD` strings; display with `formatDate`.

## Mutations
- After a mutation that posts to the ledger, invalidate `postingAffectedKeys(companyId)` (accounts, journal, reports, audit) plus the domain's own keys.
- Financial commands (post, void, categorize, match, commit import, complete reconciliation) send `idempotencyKey: idempotencyKey()` generated once per form instance (`useRef`), and the submit button shows `loading` while pending; never allow double submit.
- Errors: `const onError = useMutationErrorHandler()` then `onError(err, 'Could not …')`. Success: `useToast().success('…')`.
- Optimistic updates only for reversible metadata (names, archive flags); never for financial state.
- Use `version` from the DTO for edits (optimistic concurrency); on `version_conflict` the toast tells the user to reload.

## Components
- `Button`, `LinkButton` (`src/components/ui/button.tsx`); `Input`, `Textarea`, `Select`, `Field`, `Label`, `Checkbox` (`ui/input.tsx`); `Card`, `CardHeader`, `CardBody`, `PageHeader`, `Badge`, `EmptyState`, `Spinner`, `ErrorNotice` (`ui/card.tsx`); `Table`, `THead`, `TBody`, `TR`, `TH`, `TD` (`ui/table.tsx`, `numeric` prop right-aligns); `Dialog` (`ui/dialog.tsx`, native `<dialog>`); `useToast`.
- Tailwind 4 utility classes. Colors only through the themed scales: `stone-*` neutrals, `brand-*` accent, `white` surfaces and the semantic `emerald`/`amber`/`red`/`sky` tones; radii only `rounded-md`/`rounded-lg`; headings `font-display`. Never hard-code hex values: every brand theme in `globals.css` re-points these variables (see `docs/brand-bible.md`). Keep layouts responsive (stack on small screens, hide secondary columns with `hidden md:table-cell`, 40 px touch targets).
- Accessibility: every input has a label (`Field` + `htmlFor` or `aria-label`), dialogs have titles, loading states use `Spinner`/`aria-busy`, errors use `role="alert"`.
- Icons from `lucide-react`.

## Usability building blocks (required)
These replace hand-rolled controls. Reference implementation: `src/app/(app)/journal/journal-form.tsx`.
- **Never use a raw `<Select>` for accounts, contacts or items.** Use `AccountPicker` (`src/components/account-picker.tsx`: `allow` = hard filter, `prefer` = listed first, `recentKey` = remembered picks, `createType` for the "New account" row), `ContactPicker` (`src/components/contact-picker.tsx`, server search, `bare` + `aria-label` for filter bars, `clearable`), `ItemPicker` and `TaxRatePicker`. Any other long list uses `Combobox` (`src/components/ui/combobox.tsx`). Short fixed enums (status, method, kind) stay `Select`.
- **Amounts** use `MoneyInput` (`ui/money-input.tsx`): it accepts `$1,200.50`, emits canonical decimals, and flags invalid text. **Dates** use `DateInput` (`ui/date-input.tsx`) with `commonDatePresets()` or `termsPresets(issueDate)` for due dates.
- **Forms**: `useUnsavedChanges(dirty)` (`src/lib/use-unsaved-changes.ts`): Cancel calls `guard.leave(() => router.back())`, call `guard.markSaved()` before navigating after a save. `useSubmitShortcut(fn)` (`src/lib/use-hotkeys.ts`) on the form wrapper gives Cmd/Ctrl+Enter; show the hint with `useModKeyLabel()`. Validation returns `FormError[]` (`ui/error-summary.tsx`) with `fieldId`s; call `focusFirstError(errs)`, pass `invalid`/`aria-invalid` from `invalidFields(errs)`, render `<ErrorSummary>`. Offer "Save and new" where people enter batches (keep the date and account, reset the idempotency key).
- **Dialogs**: pass `onSubmit` to `Dialog` and make the primary button `type="submit"` (Enter submits); do not nest a `<form>` inside. Pass `dirty` for forms with typed input. Mark the first field `data-autofocus` (React's `autoFocus` loses to `showModal`). Destructive actions confirm with `useConfirm()` (`ui/dialog.tsx`), never `window.confirm`.
- **Record page headers**: at most one primary button (the next step for the record's status) and two frequent secondary actions; everything else goes in `ActionMenu` (`ui/action-menu.tsx`, the "More actions" ⋯ button, last in the row). Groups: share/export, create-from (Duplicate, credit note…), then a final destructive group (Void…, Reverse…, Delete…) with `tone: 'danger'`. Never put a solid red `danger` button in a header. Disabled items stay listed with `description` saying why (no separate "X is disabled because…" note). Permanent delete comes from `useDeleteRecordAction(type, id, { redirectTo })`: put `item` in the menu and render `dialog`. Settings shown in a details card (payment URL, public link) are edited from an inline link there, not from the header. Reversible actions (archive) are not `danger`. In e2e use `menuItem(page, 'Void…')` from `e2e/helpers.ts`.
- **Phones** (below `sm`, 640px): a header holds the primary action, at most one or two frequent ones, and ⋯ on one row. Actions people rarely take on a phone (export, download, print, import) move into the menu: give the button `className={phoneHidden}` and add a `phoneOnly: true` copy to the page's `ActionMenu` (both from `ui/action-menu.tsx`). `ExportCsvButton` and `ReportActions` already do this. Grid and flex children that hold cards or tables need `min-w-0` (`Card` has it) or the page scrolls sideways; `e2e/phone-layout.spec.ts` checks that.
- **List rows** carry navigation and the one forward action (Review, Accept), never Undo, Void or Delete. Those live on the record's page or dialog, one deliberate step away (e.g. the bank inbox opens a reviewed line in `TransactionDialog`, and Delete for a line in For review sits in the Review dialog's footer). A delete confirmation opened from a dialog is rendered beside that dialog (`useDeleteRecordAction`), never inside it, because `Dialog` wraps its body in a form.
- **Status words**: badges say what the status means to the reader, in sentence case: never render a raw enum like `issued`. Invoices use `InvoiceStatusBadge` and credit notes `CreditNoteStatusBadge` (`components/status-badges.tsx`, labels from `lib/status.ts`: Unpaid / Partially paid / Overdue / Paid). Other enums go through `capitalize()`. Say a condition like "overdue" once in the header (badge plus the balance line), not again in a banner and red text elsewhere.
- **Empty sections**: inside a card use `<EmptyState compact …>` (one quiet line); the dashed `EmptyState` box is for an empty page or list. Prefer hiding a card that has nothing to show yet (e.g. invoice allocations) or folding it into the record's activity timeline.
- **Toasts** accept an action: `toast.success('Categorized', undefined, { action: { label: 'Undo', onClick } })`.
- **Lists**: `useListParams()` (`src/lib/use-list-params.ts`) for URL filters, the search box (`search`/`setSearch`), and paging (`next`/`prev`/`pageIndex`); render `<FilterChips>` and `<Pager>` (`ui/list.tsx`). Rows take `href` on `TR` so the whole row opens the record. Detail pages start with `<BackLink listPath="/invoices" label="Invoices" />` so filters survive. Long tables pass `stickyHeader` to `Table`.
- **Sorting and totals**: services page with `keyset()` (`packages/services/src/keyset.ts`): declare `SortColumns` (wrap nullable columns in `coalesce`), take `sort`/`dir` from the query (contracts: `...sortParams(KEYS).shape`), return `{ items, nextCursor: ks.next(rows, limit), total }` with `total` from a `count(*)` over the same filters. In the view, pass `list.sort`/`list.dir` into the query, render sortable columns with `SortableTH` (`ui/table.tsx`) and give `Pager` the `total`. Reference: journal list (`services/src/ledger.ts` `listEntries`, `app/(app)/journal/view.tsx`).
- **Shortcuts**: `useHotkeys({ n: …, '/': …, 'g i': … })` for page-level keys; plain keys are ignored while typing or when a dialog is open.
- **Hydration**: never put module-level counters or `Date.now()` into DOM attributes (ids); use indexes or `React.useId()`.

## Testing
- Dev server runs at `http://localhost:3000` with `AUTH_MODE=dev`. Sign in with `POST /api/dev-auth` (see `e2e/helpers.ts`: `devLogin`, `gotoReady`, `apiGet`, `apiPost`). Add a Playwright spec under `apps/web/e2e/<area>.spec.ts` and run `pnpm exec playwright test e2e/<area>.spec.ts` from `apps/web`. Use unique names per run (`unique('...')`) so specs are re-runnable. Use `getByLabel(/^Name/)` style regexes when a label has a required asterisk.
- Pick from comboboxes with `pickOption(page.getByLabel('Line 1 account'), '5140', '5140 Meals')` from `e2e/helpers.ts` (not `selectOption`). `MoneyInput` reformats on blur (`250` shows as `250.00`).
- Typecheck with `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/web` before finishing.

## Plain words (owners who don't know accounting)
Our users run small businesses; most have never kept books. Every everyday screen speaks business, not ledger. Accountant tools (journal entries, chart of accounts, trial balance, general ledger, history) keep their real names but live under **Advanced** in the sidebar.
- **Say what happens, not how the books work.** "Saving records this in your books right away", not "Posting creates the journal entry". Page descriptions say what the page is for and what to do next. Never mention posted entries, the ledger, control accounts, subledgers, debits/credits, roles or recognition on owner-facing screens.
- **Explain once with `<Term>`** (`components/ui/term.tsx`, entries in `lib/glossary.ts`): `<Term id="receivable" />` renders "Customers owe you" with a tap-to-open explanation that also names the accounting term. `<HelpTip id="…" />` is the "?" button for beside a label or heading. Use it the first time a screen shows the idea; never rely on `title=` (phones never see it). Add a glossary entry rather than writing a one-off tooltip.
- **Vocabulary** (sidebar and screens must agree):

  | Say | Not |
  |---|---|
  | Expenses / Record expense (route `/purchases`) | Purchases, New receipt |
  | Payments received | Payments |
  | Bank transactions (route `/banking/inbox`) / Bank accounts (`/banking`) | Transactions / Banking |
  | Customers & vendors | Contacts |
  | Category (income and expense accounts in everyday flows) | Account, ledger account |
  | Customers owe you | Accounts receivable, A/R |
  | Profit | Net income (fine on accountant reports) |
  | Paid toward / Credit to use | Allocations / Unapplied |
  | Starting balances | Opening balances |
  | Locked period | Closed period |
  | Receipt = the uploaded file only | Customer receipt, receipt for a purchase record |
  | Note | Memo (on new copy; existing field names may stay) |
  | All activity (report) | Transactions report |
  | Saved, Recorded | Posted |

- **Status badges** only for states the reader acts on (Void, Overdue, Draft). Don't badge every row "Posted". Never show a raw enum (`ok`, `committed`, `closed`, `succeeded`): map it to words.
- **Errors** come from the server as plain sentences (`packages/services/src/errors.ts`: `periodLocked()`, `plainDate()`, `plainMoney()`, constraint names mapped in `duplicateMessage`). Write new `ServiceError` messages the same way: what's wrong, then what to do ("Mar 31, 2026 is in a locked period. Reopen it in Settings → Accounting periods, or use a later date."). Format dates and money, never print ids, enums or raw decimals. `onError(err, 'Could not void invoice')` shows your text as the title and the server's sentence beneath it.
- **Today** is `todayIso(company.timeZone)` (or `useToday()` from `components/company-context.tsx`), never the UTC date.
- **Company setup answers** live on `CompanyDto`: `businessType`, `taxBasis` (`'cash' | 'accrual' | null`), `booksStartDate`, `setupDismissedAt`. Reports open on `company.taxBasis ?? <the report's old default>`. Schedule C applies to `sole_proprietor`, `single_member_llc` and unanswered (`null`) companies.
