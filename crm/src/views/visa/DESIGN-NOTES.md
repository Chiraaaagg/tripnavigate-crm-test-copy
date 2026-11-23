# Visa build: design notes (Track D, 8 Nov 2026)

Visual and interaction reference: the PR2 HTML prototype `full-crm-preview.html` at 71eda1e (visa role, `#/app/visa`), walked locally on 8 Nov 2026: the queue, a visa task Work tab with the step bar, Passengers and documents, Appointment, the Decision popups, the handover and Mark delivered cells, a returned fee with "Fix fee", the passport task, the Book now visa drawer, Sales notices and the Home rows (HTML references are cited as H:line in the code comments). Business rules come from the frozen Visa build contract (sections 2, 6–8, 11, 16), not from the prototype. Every screen is composed from the existing CRM kit (`src/components/ui/*`), the department task frame (`src/views/department/task-frame.tsx`) and the Flight build's patterns (link tabs, status badge with icon, request id per form renewed only after success). No prototype HTML, sample records, role switcher, browser storage, demo "routes" configuration, embassy status, application plans, `checklistDrawer` "Verified" column or development text was copied.

## Approved deviations from the HTML (contract 2.3, section 16) and how they show

| # | Screen effect |
|---|---|
| V1 | The task exists from booking acceptance; the queue says "from accepted bookings". |
| V2 | Passport number shown and editable for the assignee only; everyone else reads "Passport shown to the assigned executive" (no masked number). |
| V3 | No "waiting for decision" click: after Applied the Decision cell offers "Record decision" at once. |
| V4 | "Withdrawn by customer" is a decision option and a row menu item for not-applied passengers; its own popup (reason, "The customer has been told", optional handover when the passport is with us). |
| V5 | Approve and Reject require the proof file unless one is on file ("Visa document on file: …"). |
| V6 / VL2 | A company fee without a receipt is saved as a draft and listed on top of Appointment with "Send fee to Accounts". |
| V7 | "How the passport goes back" has no default ("Not decided yet" in Approve/Reject, "Choose" in Set handover where it is required). |
| V8 | E-visa passengers show "Not needed (E-visa)" for the appointment; sticker and passport need a date. |
| V9 | "Visa costs per traveller" from real cost entries, no customer price. |
| V10 | Deal page "Visa results" card only for the Sales owner (or the Manager without one), with "OK, seen". |
| V11 | Applied date and delivered date inputs have `max` = today (IST) and a local check; the database decides. |
| V12 | Passport tasks use the same Work tab and complete. |
| QB2 | The e-visa e-mail starts empty, hint "Record where you sent the e-visa. The CRM does not send it." Handover cell says "E-visa sent to …", never "e-mailed". |
| §16 | No matching by name: removed passengers stay listed as "Removed from the booking"; no relink. "Add other visa cost" (row menu) records a per-passenger "other" cost. |

## Interaction changes made for accessibility (not policy)

- The HTML opens popups from a `<select>` change (Application: Not applied → Applied; Decision: Pending → Approved/Rejected). A select that opens a dialog on change misfires with arrow keys, so the Application cell has a "Mark as applied" button and the Decision cell a "Record decision" menu button (Approved / Rejected / Withdrawn by customer). Same words, same popups.
- Step bar steps are links to `#sec-<task>-pax` / `#sec-<task>-appt` (work without script); the bar sits in a labelled, focusable region that scrolls sideways at 375 px; the fill uses width classes because the production CSP forbids inline style attributes.
- Both wide tables (Passengers and documents, Appointment) scroll inside their own labelled region at narrow widths (contract 0 / H:15052); the page itself never scrolls sideways.
- One row in edit at a time; focus moves to the first field when the pencil opens it and back to the pencil on Save or Cancel. A refusal of the row is shown in a full-width row above it, and every typed value stays.
- Popups: Radix dialog (focus trap, Escape, focus return to the opening control, including a menu button); after a confirmed success the popup closes and focus goes to the result line at the top of the Work tab (the pressed button usually disappears).
- Refusals list the fields with links (ErrorSummary, "Nothing was saved"); a chosen file stays chosen, an uploaded receipt or proof is not uploaded again on retry.

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Short synthetic queries only; no customer, passport or money data.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `editable table row` | Editable Data Table (starc007), Table Edit (ruixen.ui), Reshaped Table, Excel-Style Table, Table (micka_design) | Idea only (Table Edit) | Inline row edit with a pencil and Save/Cancel per row matches H:14656; built with the CRM Table, Input, Select and native checkboxes, no virtualised grid or new dependency. |
| 2 | `bulk select bar` | Select (originui), HeroUI Select, two Select components, Breadcrumb | No | Results were select inputs, not a selection bar; kept the HTML bulk bar (Select all · "n of m selected" · Confirm applied) on the CRM tokens. |
| 3 | `stepper` | Stepper (originui), Stepper (sean0205, source of `ui/progress-checklist`), Stepper (corr), Vertical Titled Stepper, Stepper (nyxbui) | Idea only (corr horizontal stepper) | Five numbered circles with a connecting line and a word under each step, as H:15082; plain ordered list with links, words for every state. |
| 4 | `notification card` | Information Card (KarrixLee), Notifications Carousel, Card (notification), Team Invitation Alert, Notification Stack Card | Idea only (Information Card) | The Deal page "Visa results" is a plain card with a list of results and one "OK, seen" button each; no carousel or stacking animation. |

## Preview states

Group "Visa build (8 Nov 2026)" on `/preview` (states `visa-*`); the older `b11-visa-*` and `b4-visa-*` names now render the new screens. The Book now visa drawer is opened from `/preview/visa-book-now-drawer` (services step) with "Visa".

## Checks

See the Track D report for what was checked (axe, 1280 / 375 px, keyboard, 200% zoom, reduced motion) and what was not (real data, a screen reader by hand).
