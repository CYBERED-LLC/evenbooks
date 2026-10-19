# Evenbooks brand bible

The reference for every visual and verbal decision about Evenbooks. Read it before touching the
marketing site, the app shell, emails, invoices or anything a customer sees. Change it deliberately
and record why in `docs/decisions.md`.

Status (2026-09-23): the identity is decided. **Ledger** is the light theme, **Midnight** the dark
theme; the app follows the device setting by default and each person can override it. The other
three explored directions are recorded in §3 for history only.

---

## 1. Who we are

**Name.** Evenbooks. One word, capital E, lowercase b: *Evenbooks*. Never *EvenBooks*, *Even Books*
or *EB*. The camel-case form echoes QuickBooks and FreshBooks, which we do not want to look like.
In the wordmark only, the name is set fully lowercase: **evenbooks**.

**Why "even".** Books that balance (double entry: every debit has an equal credit), and terms that
are even: one fair price, published fee math, no bait and switch. Both meanings must survive in
everything we make. If a design would suit a bank, it is too cold; if it would suit a budgeting app
with confetti, it is too soft.

**Domain.** evenbooks.org is the product and the company. The .org is a promise, not a legal
status. We are a for-profit LLC and say so; the domain says we behave like a public good:
source-available code, free self-hosting forever, free export, a sunset clause that opens the code
if the hosted service ever ends. `evenbooks.app` redirects. Never call the code "open source"; it is
**source-available** under Elastic License 2.0.

**Positioning.** *Honest books at a fair price, for as long as you run your business.* We replace Wave for
sole proprietors and very small companies, and we compete on trust, not features. The incumbents
trained people to expect upsells; our whole identity is the absence of that.

**Taglines** (pick per context, never more than one on a screen):

- Books that balance. Prices that don't move.
- Even books. Even terms.
- Bookkeeping that shows its work.
- Honest books at a fair price, for as long as you run your business. *(mission statement, long form)*

**Voice.** Plain, calm, exact. Short sentences. We name numbers precisely and never round a fee
to sound better. We say "you" and "we", never "users". We do not exclaim. We explain the
accounting when it helps (a tooltip that says what a credit note does) and stay out of the way
when it does not. Humor is dry and rare. Words we use: *books, ledger, balance, fair, plain,
open, yours*. Words we avoid: *seamless, powerful, unlock, supercharge, effortless, AI-powered,
game-changing, free forever* (say what is free instead).

Examples:

| Instead of | Write |
| --- | --- |
| Supercharge your finances with powerful automation | Your bank feed is categorized for you. You approve each entry. |
| Oops! Something went wrong 😬 | The payment could not be recorded. Nothing was posted. Try again. |
| Unlock premium features | The paid plan is $15 a month per company. Here is what changes. |

---

## 2. The mark

An **equals sign**: two identical horizontal bars on a rounded square. It reads as balance, as
double entry (two lines, one truth), and as the plain fairness in the name. Nobody else in the
category owns it.

- Component: `apps/web/src/components/brand/mark.tsx` (`BrandMark`, `Wordmark`). Favicon:
  `apps/web/src/app/icon.svg`.
- Geometry: 32-unit square, corner radius 7, bars 16 × 3.5 with 3-unit gap, centered. The two bars
  are always identical; never make one shorter, thicker or a different color.
- Color: the accent (`brand-600`) square with bars in the theme's card white. On dark or photo
  backgrounds use the same mark; on the accent color itself use an outline version (bars only, in
  card white) rather than a square on a square.
- Clear space: at least half the mark's height on every side. Minimum size 16 px on screen.
- The wordmark is the mark plus **evenbooks** in the display face, semibold, tight tracking, sitting
  on the same baseline as the bars' optical center. Use `Wordmark` rather than recreating it.
- Do not rotate, skew, add gradients, add a shadow, or place text inside the square.

---

## 3. Color system

Every color in the product is expressed through two scales plus a small semantic set, all as
CSS variables. Never hard-code a hex value in a component; use the utility classes.

| Role | Utility | Used for |
| --- | --- | --- |
| Neutral | `stone-50…950` | page background (50), hover and table heads (50/100), borders (200/300), muted text (500/600), body text (700/800/900) |
| Card | `white` | card, dialog, input and sidebar surfaces (`--color-white` is themed) |
| Accent | `brand-50…900` | primary buttons (600, hover 700), links and active nav text (700/800), active nav background (50), focus ring (500) |
| Success | `emerald` | paid, matched, posted |
| Warning | `amber` | due soon, needs review, uncertain match |
| Danger | `red` | overdue, void, errors, destructive buttons |
| Info | `sky` / `blue` | informational badges and toasts |
| Special | `violet` | rare, e.g. system-generated entries |

Rules: accent is for action and orientation, never decoration; large areas stay neutral. Money is
never colored by sign alone; negatives get a minus sign and, where it matters, a red tone as well.
Every text/background pair meets WCAG AA (4.5:1 body, 3:1 large text). Semantic colors carry
meaning, so a badge tone must match the state everywhere (a "Paid" badge is always `green`).

### Light and dark

Both themes are complete variable sets in `apps/web/src/app/globals.css`. Ledger is the base
(`:root`); Midnight applies under `[data-theme='dark']`. Swatches are page / card / ink / accent.

| Theme | Role | Palette | Type | Corners |
| --- | --- | --- | --- | --- |
| **Ledger** | Light, the default look | cream `#faf7f0` / `#fffdf8` / ink `#1c1915` / forest `#2b614a` | Fraunces display, Inter text | 6 px |
| **Midnight** | Dark | `#0e1115` / `#141920` / `#f0f3f7` / mint `#4fd1a6` | IBM Plex Sans, Plex Mono figures | 8 px |

**Mode.** The default is *System*: the app follows `prefers-color-scheme`. Anyone can pin *Light* or
*Dark* with the appearance control at the bottom of the sidebar (and in the marketing footer). The
choice is per browser, kept in the `eb-theme` cookie, and applies before first paint through a
small inline script so there is no flash. Public invoice pages follow the same rule, so a customer
in dark mode sees Midnight.

**Why these two.** Ledger is the only direction that still says "honest books" with the accent
removed, and its serif display is a signature no competitor uses. Midnight is its night-time twin:
same structure, same restraint, figures set in a monospace so a full journal stays scannable.
Three other directions were explored and set aside on 2026-09-23: *Graphite* (cool grays, cobalt,
Inter Tight), *Even* (oat, copper, Manrope) and *Meridian* (black, white, ultramarine, Space
Grotesk). They were competent but generic; none carried the name's meaning on its own.

---

## 4. Typography

- **Display** (`font-display`): page titles, card titles, the wordmark, marketing headlines.
  Semibold, tight tracking. Set by the theme.
- **Text** (`font-sans`): everything else. 14 px is the working size in the app, 16 px on
  marketing and public pages. Line height 1.5.
- **Figures**: all money and quantities use tabular numerals (`.tabular`) and are right-aligned in
  tables. Never mix proportional and tabular figures in one column. Midnight sets figures in Plex
  Mono for the terminal feel; Ledger uses Inter's tabular set.
- Hierarchy is carried by size and weight, not color. At most three sizes on a screen outside
  tables.
- Currency formatting comes from `formatMoney`; never format by hand.

---

## 5. Layout, surfaces and motion

- **Cards** are the unit of layout: `white` surface, 1 px `stone-200` border, subtle shadow, themed
  radius. Page background is `stone-50`. Avoid nested cards; use dividers inside a card.
- **Spacing** on a 4 px grid; 16 px card padding, 24 px between sections.
- **Density**: bookkeeping is a reading task. Tables stay compact (8 px vertical cell padding),
  forms breathe (space between fields, one column on mobile).
- **Shadows** are for elevation only (dialogs, menus, toasts). Cards use `shadow-sm` at most.
- **Motion** is functional and short (150 ms color transitions, drawer slide). Respect
  `prefers-reduced-motion`. Nothing bounces.
- **Empty states** say what the thing is and offer the one action that fills it.
- **Icons**: `lucide-react`, 16 px in dense UI, 20 px in headers, stroke only, never filled, never
  colored except by the semantic tone of their row.

---

## 6. Mobile

The app must be fully usable on a phone, because the people we serve run their business from one.

- Breakpoints follow Tailwind: phone (< 640), tablet (640–1023), desktop (≥ 1024). The sidebar
  becomes a drawer under 1024; the header shows the wordmark and the current company.
- Every page header wraps its actions under the title on narrow screens. Primary action first.
- Tables hide secondary columns (`hidden md:table-cell`) rather than shrinking type below 14 px,
  and scroll horizontally only as a last resort. Money and status columns are never hidden.
- Forms are single-column under 640; inputs are at least 40 px tall; dialogs become full-height
  sheets at small sizes (`max-h-[85vh]`, full width).
- Touch targets at least 40 × 40 px. No hover-only affordances: anything revealed on hover must
  also be reachable by tap or focus.
- Test at 390 × 844 (iPhone) and 768 × 1024 (iPad) before shipping a page.

---

## 7. Applying the brand outside the app

- **Marketing site**: same variables and type, larger sizes, more white space. One accent color,
  photography avoided in favor of real product screens and ledger-style tables. The homepage
  lets people use the product rather than look at it: a working review inbox where the mark
  itself is the balance (it turns into ≠ while debits and credits differ), an animated invoice →
  phone → payment → payout walkthrough, and a month you can scrub through. Figures in these demos
  come from the product's own ledger and fee code. Motion there may be richer than in the app,
  but it still stops for `prefers-reduced-motion` and never loops on its own outside view. The "how we make
  money" page shows the actual fee math (5% all-in on cards, 1% on bank transfers for the free plan;
  $15 a month per company on the paid plan; Stripe's fee only after that).
- **Invoices and PDFs** sent to a customer's customer carry *their* branding first; Evenbooks
  appears only as a small "Powered by evenbooks" line with the mark, in neutral gray.
- **Emails**: text-first, one button in the accent color, wordmark in the header, nothing else.
- **Social and repo**: the mark on the accent color as the avatar; description
  "Honest double-entry bookkeeping for small companies. Source-available."

---

## 8. Implementation notes

- The mode (`system` | `light` | `dark`) is read from the `eb-theme` cookie in
  `apps/web/src/app/layout.tsx` and rendered as `data-mode` on `<html>`, with `data-theme` holding
  the resolved theme. `THEME_BOOT_SCRIPT` (in `apps/web/src/lib/themes.ts`) resolves *system* from
  `prefers-color-scheme` before paint and follows OS changes. `/api/theme?set=dark&next=/path` sets
  the mode from a link; `AppearanceToggle` (`apps/web/src/components/appearance-toggle.tsx`) posts
  it and applies it instantly.
- Fonts load through `next/font/google` in `apps/web/src/app/fonts.ts`: Inter, Fraunces, IBM Plex
  Sans, IBM Plex Mono. Nothing else.
- `apps/web/scripts/brand-shots.mjs` screenshots the key pages in both themes at desktop and phone
  sizes against a dev-auth server; run it after visual changes.
- New components must only use `stone-*`, `brand-*`, `white` and the semantic scales, plus
  `rounded-md`/`rounded-lg` and `font-display`/`font-sans`, so that they follow the theme for free.

---

## 9. Do and don't

**Do** show the number. Lead with balances, totals and dates; they are the product.
**Do** keep one accent on screen. Two competing colors mean two competing actions.
**Do** write the fee, the price and the limit in full where the decision is made.
**Don't** use green for money that is merely positive, or red for money that is merely large.
**Don't** add illustrations, mascots or gradients. The books are the picture.
**Don't** shorten the name, camel-case it, or pair it with another product's color scheme.
**Don't** describe the code as open source. Source-available, self-host free, forever.
