# Financial policy

How Evenbooks records and reports money. This documents software behavior; it is not tax advice. Sources consulted: IRS Publication 538 (Accounting Periods and Methods), Publication 334 (Tax Guide for Small Business), the 2025 Schedule C instructions, Publications 502/526/527 for the "paid when charged / mailed" analogies, and the IRS 1099-K guidance. Where the IRS is silent, the choice is marked **policy**.

## 1. Money and rounding

- Amounts are exact decimals end to end: `numeric` in PostgreSQL, `decimal.js` in the application, strings in every API payload. No arithmetic on JavaScript floats.
- Monetary amounts are rounded **half away from zero** (`ROUND_HALF_UP`) to the currency's minor units (USD: 2). Quantities and unit prices keep up to 6 decimals.
- Rounding happens **per line** and totals are sums of rounded lines, so an invoice's displayed lines always add up to its total.
- Allocations (document discounts, partial settlements) use the **largest-remainder** method so parts add exactly to the whole. Ties go to the earliest line.
- MVP enforces USD only. Base currency is stored on the company and currency on every document/account; mixed currencies are rejected at posting.

## 2. Invoice arithmetic

1. Line gross = round(quantity × unit price).
2. Line discount: percent of gross, or fixed amount capped at gross.
3. Document discount: percent of Σ(after-line-discount) or fixed, allocated across lines proportionally (largest remainder).
4. Line net (taxable base) = after-line-discount − document-discount share. This is the revenue recorded for the line.
5. Tax per line per rate = round(net × rate), summarized by rate. Discounts are always applied **before** tax. No automatic rate lookup; rates are configured manually.
6. Total = Σ net + Σ tax.

Discounts reduce recorded revenue directly (net revenue); they are not posted to a contra account. The `sales_discounts` account exists for early-payment discounts or write-offs recorded explicitly.

## 3. Posting rules (accrual ledger)

| Event | Debit | Credit |
| --- | --- | --- |
| Issue invoice | Accounts receivable | Income (per line, net) and Sales tax payable (per rate) |
| Receive payment, allocated to invoices | Bank / undeposited funds | Accounts receivable |
| Receive payment, unapplied portion (advance, overpayment, deposit) | Bank | Customer deposits and credits |
| Apply unapplied funds or a credit note to an invoice | Customer deposits and credits | Accounts receivable |
| Issue credit note | Income (per line) and Sales tax payable | Customer deposits and credits |
| Refund unapplied funds or a credit note | Customer deposits and credits | Bank |
| Void invoice | reversal of the issue entry | |
| Paid purchase from bank | Expense / asset (per line) | Bank |
| Credit-card purchase | Expense / asset | Credit-card liability |
| Vendor refund | Bank / card | Expense |
| Pay credit-card balance (transfer) | Credit-card liability | Bank |
| Bank fee netted from a deposit | Bank fees (expense) | Bank (as part of the deposit split) |

Consequences:

- **Accounts receivable equals the sum of open invoice balances.** Nothing else posts there.
- **Customer deposits and credits** holds all unapplied customer funds and unapplied credit notes. Refundable security deposits are flagged and stay there on both bases until applied or forfeited.
- Voids and corrections of sales documents happen through the document (void, credit note, refund), never by editing or deleting the entry.

## 4. Cash-basis recognition

Evenbooks keeps one accrual ledger. Cash-basis reports are built from a single **cash recognition layer** (`cash_recognitions`), never by filtering bank lines or by account type.

### 4.1 What creates cash recognition

| Event | Cash-basis effect | Date |
| --- | --- | --- |
| Payment allocated to an invoice | Invoice components (income per line, tax per rate) recognized **proportionally** to the amount applied | Payment date |
| Payment received but unapplied (advance / prepayment / overpayment) | Income to *Advance Customer Payments* | Payment date |
| Refundable security deposit received | **None** (liability) until applied or forfeited | — |
| Unapplied funds later applied to an invoice | Reclassification: −Advance Customer Payments, +invoice components. Net income unchanged | Application date |
| Credit note applied to an invoice | Reclassification: −credit-note components, +invoice components. Net zero (no cash moved) | Application date |
| Refund paid out | Negative recognition of the source: −Advance Customer Payments for unapplied funds, −credit-note components for a credit note | Refund date |
| Paid purchase (bank or card) | Expense lines recognized in full | Purchase date |
| Categorized bank transaction | Its income/expense lines | Transaction date |
| Manual journal marked *include* | Its income/expense lines | Entry date |
| Imported history cash entry | Its income/expense lines, or explicit reviewed income/expense components for settlements against another balance-sheet account | Entry date |
| Imported history entry that touches none of those accounts (for example an old invoice: receivable against income) | **None** (marked *exclude*) | — |
| Manual journal marked *exclude*, opening balances, transfers, card payments, invoice issue, credit note issue | **None** | — |
| Reversal of an *include* entry | Opposite of the original | Reversal date |

The recognition rows are append-only and traceable to their source event; a rebuild job can regenerate them from the source documents and compare totals.

### 4.2 Rationale and boundaries (from IRS text)

- **Income when actually or constructively received; expenses when paid** (Pub 334, Pub 538, Schedule C instructions).
- **Credit-card purchases count when charged, not when the card bill is paid** (Rev. Rul. 78-39; Pub 502 and 526 state the same rule). Paying the card is a liability payment, not an expense.
- **Advance payments are income when received for cash-method taxpayers** (Pub 334). Only genuinely **refundable** deposits are excluded while the obligation to return them exists (Pub 527 analogy; *Indianapolis Power & Light*). Evenbooks therefore requires the user to flag a payment as a refundable deposit; otherwise unapplied funds are income.
- **Sales tax imposed on the buyer and collected by the seller is not income** (Schedule C line 23 instructions; Pub 334). Evenbooks treats configured tax rates as pass-through liabilities on both bases. Seller-imposed taxes (rare) would need a gross-up option; not in MVP.
- **Partial-payment allocation between price and tax is not prescribed by the IRS.** **Policy:** proportional allocation, applied consistently to income, tax, discounts and refunds. Example: $1,000 services + $100 tax, $550 received → $500 cash revenue and $50 tax collected.
- **Bad debts:** an unpaid invoice never entered cash income, so writing it off produces **no** cash-basis expense (Pub 334). A write-off is a credit note; on the cash basis it is invisible unless money moved.
- **Refunds** reduce income when paid (repayment rule, Pub 334); Schedule C reports them on line 2 (returns and allowances) when mapped that way.
- **Owner draws and contributions** are equity and appear on neither basis.
- **Processor fees netted from deposits:** gross receipts are the gross amount; the fee is an expense (1099-K guidance). Bank-matching splits a net deposit into payment(s) plus a fee line.
- **Prepaid expenses:** recorded when paid. Proration under the 12-month rule is a manual journal (*exclude* on cash basis, or *include* for the cash timing the user chooses).

### 4.3 Report semantics

- Cash/accrual selection applies to the P&L, income/expense category report and the Schedule C summary.
- Balance sheet, trial balance and general ledger are accrual-only and say so on screen and in exports.
- Trial balance is a snapshot as of one date: each account's net posted balance appears in the debit or credit column, including earlier years. CSV and PDF use the same snapshot; account drill-down includes its full posting history through that date.
- Reports use posted entries / recognized amounts only, explicit date boundaries (inclusive), and stable ordering in CSV exports. Uncategorized amounts are shown, never dropped.
- Schedule C mappings are per company and tax year (2025 layout: line 27a = energy-efficient buildings, 27b = other expenses). Meals map to 24b at 100% of cost; the 50% limitation is applied in the summary as a note, not by altering the books.

## 5. Periods, corrections and audit

- Closed periods block posting and reversal dates inside them. Reopening requires a reason and is audited.
- Corrections are linked reversals or replacement documents. Reversing an entry that a completed reconciliation relied on flags that reconciliation for review.
- Every posting, void, reversal, period change and settings change writes an audit event with actor, action, entity and reason. Secrets never enter the audit trail or logs.

## 6. Reviewed imported settlements

When an imported entry moves money against a receivable, payable or other noncash balance-sheet account, the owner must supply the cash-basis income/expense amounts. The importer does not infer document links or treat gross collections including sales tax as income. An empty review explicitly means no cash income/expense. Reviewed components replace the entry's default recognition, so fees must be included too. They are persisted on the imported entry and are reproduced on rebuild; linked reversals negate them at the reversal date.

Admins may correct imported cash components with a reason and version check. These audited cash-report metadata corrections do not change the posted accrual lines. All affected periods must be open. Cash reports reject older unreviewed settlements rather than silently omit their revenue. Imported sales-tax reports and migration of invoice documents remain unsupported.
