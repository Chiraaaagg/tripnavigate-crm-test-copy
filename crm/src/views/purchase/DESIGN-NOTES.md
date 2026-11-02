# Purchase build: design notes (Track C, 2 Nov 2026)

Visual and interaction reference: the approved HTML prototype `full-crm-preview.html` (1 Nov 2026), source `build/src/40-purchase.js`, `39-purchase-breakups.js`, `70-money.js`, `80-manager.js`. The prototype was built from the live CSS, so every screen here is composed from the existing CRM kit (`src/components/ui/*`) and the department task frame (`src/views/department/task-frame.tsx`). No prototype HTML, sample data, role switcher, "Download preview", JSON tools, sender address or dev text was copied. Business rules come from the frozen Purchase build contract, not from the prototype.

## Component sources and adaptations

| Screen part | Built from | Adaptation |
|---|---|---|
| Queue (Not taken · Mine · All) | live `Table stackOnMobile`, `QueueShowTabs`, `ServiceTypePill`, `TaskStatusBadge` | Type pill sits above the service name (7 columns, owner review 1 Nov) so Status keeps a minimum width; a second badge shows the Accounts go-ahead state (icon + words). |
| Task header | live `PageHeader`, `TaskNextLine`, `InternalTaskLine`, `TaskTabsNav` | Go-ahead badge in the status row; "Next:" text computed from the workspace (booking request, go-ahead, confirmation). |
| "What Sales booked for this hotel" | live `Card`, `Table`, `Notice` | Replaces Stay / Travellers and budget / Notes from Sales / Hand-offs. Room breakup comes from the Book now cost estimate (`service_item_cost_estimates` via `PurchaseTaskView.estimate`), cost side only. Special request = warning notice with icon and the words "Special request". |
| Rate negotiation | live `Card`, `StatusBadge`, form fields | Summary line (budget, lowest rate, final rate, under/over budget badge with icon and word) + one compact bordered tile per rate (one column on phones). The final tile carries the one primary action. |
| Supplier e-mail drawer | live `Drawer` (Radix Dialog: focus trap, Escape, focus return) + `Field`/`Input`/`Textarea` | To / Cc / Subject / Message; Copy draft, Open in e-mail app (mailto), Mark as sent; "Send" only when the server switch is on. |
| Supplier payments card + drawer | live `Card`, `Drawer`, `Notice`, `SummaryList` | Live route notice (Accounts / branch Manager) from B's `previewRoute`; customer-money-short notice with a funding checkbox and reason; no amounts of customer money ever. |
| Unavailable actions | existing `aria-disabled` pattern (`book-review.tsx`) | Button stays focusable, `aria-disabled="true"`, `aria-describedby` points to one short reason shown under it. |

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Synthetic, generic queries only; no customer, supplier or money data.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `rate tiles` | Gradient Tiers, Banner Tiers Pricing Table, Receipt Tiers, Tiles, Pricing Component | No | Marketing pricing tables (plans, toggles, gradients). A rate tile here is a small bordered panel with supplier, amount, budget badge and one action; built from the live card/badge tokens to stay calm and dense. |
| 2 | `approval list` | Progress List, Tool Approval, Approval Card, Approval Pad, AI Approval | Idea only (Progress List) | Approval cards are AI human-in-the-loop widgets with new visual language. The idea of one row per item with a clear state and one decision fits; rows reuse the live table/list and status badge. |
| 3 | `email compose drawer` | Drawer Inner Content, Family Sign In Drawer, Bottom Drawers, Drawer (ddoemonn), Drawer (shadcn) | No | The CRM already has an accessible Radix side drawer (`ui/drawer.tsx`); the results add drag-to-dismiss or newsletter forms only. |

The Accounts pages (Hotel go-ahead, Supplier payments, Supplier invoices, Company funding) and the Manager's Approvals page made no further 21st.dev calls; they reuse the results above and the live list, table, notice and drawer components.

## Checks (2 Nov 2026, local mock preview only)

- 48 preview states (`pb-*`, `pm-*`, plus the changed `procurement-*`, `supplier-detail`, `b4-purchase-task-work`) at 1280 px and 375 px: axe (WCAG 2.2 AA tags) clean, no sideways scroll, one h1, no console errors.
- Browser: booking request drawer opened by click, "Mark as sent" returned the synthetic success; e-mail draft has the Deal ID subject and no selling price.
- Not checked: real data, 200% zoom by hand, screen reader by hand.
