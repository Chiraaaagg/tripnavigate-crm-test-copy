# Accounts phase 2: customer documents design notes (Track E, 11 Nov 2026)

Business rules come from the frozen Accounts phase 2 contract (sections 6, 9, 11; owner answers Q1–Q4; addenda L3, B1). Every screen is composed from the CRM kit (`src/components/ui/*`), the Phase 1 desk kit (`views/accounts-desk/desk-kit.tsx`) and the new Accounts phase 2 kit (`views/accounts-desk/acc2-kit.tsx`: `CommandButton`, `DialogAction`, `ReasonField`, `BlockedButton`). No new dependency.

## Screens and where they live

| Screen (contract 11) | Files | Preview states |
|---|---|---|
| 1. Deal page › Customer documents card | `deal-card.tsx`, `labels.ts`, `types.ts` | `acc2-docs-deal-*` |
| 2. Accounts › Customer documents (`/app/accounts/documents`) | `list.tsx`, `filter.ts` | `acc2-docs-list-*` |
| 14. Print page for the PDF maker (`/print/customer-document/[jobId]`) | `app/print/customer-document/[jobId]/page.tsx` (B's template and loader only) | — (needs a signed token; no gallery state) |
| Staff print view while the PDF maker is off (`/app/deals/[id]/documents/[documentId]`) | `print-view.tsx`, `print-button.tsx` | `acc2-docs-print*` |

## Interaction decisions

- The card is a Server Component. Draft previews are track B's `CustomerDocumentTemplate` rendered on the server from the frozen `cdoc-1` content (R-B2) and passed in, so no zod reaches the browser (CSP blocks eval). Buttons and dialogs are client islands.
- One primary per draft: "Release as 10101-INV-2". The expected number is worked out from the Deal's numbered documents and prefix (Bitrix Deal ID, else CRM reference); the dialog says the database gives the final number and the success line states it. Release binds `expectedRowVersion` and `expectedContentSha256` of the preview shown.
- Release is `aria-disabled` with one reason when the switch is off, the draft is stale ("Refresh the draft first"), billing is not verified, or the preview did not load. Nothing is hidden.
- Status never by colour alone: B's `documentStatusLines` words ("Draft — number on release", "Replaced by …", "Cancelled — reason", "Booking changed since release", "Payment reversed") on badges with icons.
- PDF: "Download PDF" (ready), "PDF not made yet" + "Print view" (maker off), "PDF being made", "PDF failed" + "Make the PDF again" (Accounts) + "Print view". No document title says "not a tax invoice" (owner Q1).
- Reasons (discard, cancel, replace) 10–500 characters; a refusal keeps the dialog open with every typed value, marks the field it names and focuses it (desk kit).
- The list is a plain GET form plus quick-view chip links, so every filter lives in the address; keyset "Next page" / "Back to the newest". Managers see "View only" and no draft views.
- 1280 and 375 px: the table stacks into labelled cards under 640 px; the preview scrolls inside its own labelled, focusable region; no page-level sideways scroll (checked at 375 and 640 = 200% zoom).

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Short synthetic queries only; no customer, money or document data was sent.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `invoice preview` | Content 11 Billing Overview, Receipt Pricing, Checkout Summary, Invoice History Table, Invoice Form with Line Item Dialog | Idea only (Invoice History Table; Checkout Summary) | Issued documents as rows with number, status words and one download per row; "not made yet" shown honestly instead of a fake file (Checkout Summary's "calculated at next step" idea). The printed layout itself is track B's template. |
| 2 | `document list` | File List Item, The Item one, Key Value List, List, Tree View | Idea only (File List Item) | One row per document with its actions beside it; no overflow menu (each row has at most three actions, shown as buttons so keyboard users see them). |

## Not done here

- No gallery state for the print page (it needs the worker's signed token by design).
- `pdf.fileId` is not shown (downloads go by document id through B's route).

## Accounts phase 3 — automatic bills (track U, 13 November 2026)

Screens: Deal page Customer documents card additions ("Made by the CRM", "Held — reasons" with repair links, "Released by the CRM", ready-draft lines for release on/off), Accounts › Bills to check (`?preset=toCheck`, `?toCheck=1` accepted; "Automatic drafts" filter `auto=held|ready`), Settings › Accounts additions (`views/accounts-desk/acc3-settings.tsx`), daily check additions (`views/accounts-desk/acc3-daily-check.tsx`). Preview states `acc3-bills-*` (27).

21st.dev calls (component search, synthetic queries only):

| Query | What came back | Adopted? |
|---|---|---|
| `status badge` | Tremor-style status badge, dot badges, styled badges with pulse | Pattern only: kept the existing `StatusBadge` (icon + words). "Held — check to fix" / "Checks passed" use it beside the draft status, so status is never colour alone. No pulse (reduced motion, calm look). |
| `warning list` | shadcn warning alert, "Note" callout, light danger banner | Adopted the shape: one warning callout titled "Held — the CRM did not release this draft" with a bullet per reason and an inline repair link. Built on the existing `Notice`. |
| `settings switch` | Base UI / WAI-ARIA switches, instant-toggle switch | Not adopted as a control: these settings need a reason and are audited, so an instant toggle would mislead. Used labelled On/Off radio pairs plus a reason and one "Save …" button per section; "Now:" badges in words. |
| `stat tiles` | Dot-matrix tiles, KPI tile with sparkline | Not adopted (animated, decorative). New daily-check tiles copy the existing Phase 1 `CheckItem` tiles exactly; the queue-age tile adds a "(late …)" word note instead of colour. |

Checked in the preview (dev server 3295): all 27 `acc3-bills-*` states return 200; 12 checked at 375 px and 2 at 1280 px with no sideways scroll; refusal states focus and mark the named field (`limitRupees`, `companyName`); keyboard focus ring visible; no console errors. `acc2-docs-deal-accounts` and `acc2-docs-list` render without any phase 3 text (Phase 2 unchanged when the new keys are absent).

Words: hold reasons and "by the CRM, rule: …" lines come from track B's frozen `HOLD_REASON_TEXT` / `AUTO_RULE_TEXT` (modules/customer-documents/contracts.ts). Repair links only where Accounts can act: billing not verified → billing details, newer version waiting → Accounts review.
