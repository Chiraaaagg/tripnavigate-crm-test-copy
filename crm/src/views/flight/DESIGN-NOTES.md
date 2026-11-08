# Flight build: design notes (Track C, 4 Nov 2026)

Visual and interaction reference: the team HTML prototype `full-crm-preview.html` (branch `flight-module-updates` 76f66d2; `build/src/50-flight-visa.js`, `50-flight.css`), opened locally as the Flight role (`#/app/flight/s-412-f?tab=work`) and the Sales Deal page. The prototype was built from the live CSS, so every screen here is composed from the existing CRM kit (`src/components/ui/*`), the department task frame (`src/views/department/task-frame.tsx`) and the Purchase build's form kit (`src/views/accounts/supplier-forms.tsx`: `guard`, `useRequestId`, `Submit`, `UnavailableAction`, `HandForm`). No prototype HTML, sample records, role switcher, JSON import or export, in-memory state or development text was copied. Business rules come from the frozen Flight build contract (sections 7 to 11), not from the prototype.

## Component sources and adaptations

| Screen part | Built from | Adaptation |
|---|---|---|
| Queue (one row per Deal) | live `Table stackOnMobile`, `QueueShowTabs`, `QueueEmpty`, `StatusBadge` | Seven columns as FV:1031. Two or more flights: a native `<details>` "Show N flights" listing route · date · "x of y tickets" (keyboard and screen reader work without script). Secondary chips are text + icon, never colour only. Manager: no tabs, All only. |
| Workspace header | live `PageHeader`, `TaskBackLink`, `TaskNextLine`, `InternalTaskLine`, `TaskTabsNav` | One primary action by state: Take these flights / Review booking change / Confirm tickets / Finish this flight (on the Work tab the primary is the Confirm tickets button itself). Manager's "Move to another colleague" is a secondary drawer. |
| Progress bar | new `FlightProgress` (bits.tsx) | An ordered list; each step says "Step n of m: name, done / current step / not started" for screen readers; vertical list under 640 px; the Approvals step appears only when a change or fare approval exists. |
| Itinerary grid ("Main itinerary") | plain table with explicit roles (as `ui/table.tsx`) | Header names wrap; under 768 px every row becomes a labelled two-column card, so nothing scrolls sideways at 375 px (fixes FV:1503). Edit rows (Alternate, Fill missing details, Add sector) live in this component's own state and render only for the Flight assignee (fixes the cross-role draft leak FV:1275). Traveller checkboxes on Alternate and Add sector, locked travellers disabled with the reason (fixes FV:2252, FV:2362). Focus goes to the first field and back to the opening button. |
| Sector fields | live `Input`, `Select` | Date accepts "2 Dec 26", "2/12/26", "2026-12-02" and shows the parsed date; time boxes take 8 characters ("07:05 pm", fixes maxlength 7) with a `datalist` every 5 minutes; arrival date defaults to the same or next day. |
| Passenger itinerary ("Add new table") | live `Dialog` | Choose one eligible traveller, edit their flights, Send / Save and apply, Discard; the draft stays while the page is open, also when the dialog closes. |
| Booking changed | live `Card`, `Notice` | Unchanged / changed / removed / added legs, traveller changes, other fields, impact list, "Apply the new booking". Everything else on that flight says "Review the booking change first". |
| Confirm tickets popup | live `Dialog` (Radix: focus trap, Escape, focus return) | Width `min(76rem, 100vw − 2rem)`; each passenger line is a wrapping card (no sideways scroll at 375 px, fixes FV:2048). CRS type select of five; CRS PNR hidden for Airline direct; "+" copies a line with the next ticket number. Fare per type: Basic, K, YQ, YR, Other (+ Markup, Discount on flight-only Deals). Live budget line from the server preview; above budget "Ask the Manager to approve". Error summary "Nothing was confirmed" with a link per field. The whole draft lives outside the dialog, so it survives closing, refusals and a Manager round trip. |
| Confirmed tickets | live `Card` | Grouped by Airline PNR with CRS type / CRS PNR; flights date-sorted, airline code once ("AI 470"); full ticket range text; "Correct ticket" dialog with reason; corrections listed; "No longer active" group. No fares. |
| Cost and payment | live `Card`, `Drawer`, `Notice`, `UnavailableAction` | Budget vs supplier cost; per batch the fare breakup (only keys the server sent) and a payment badge; "Record direct payment" drawer (proof picker + upload) and "Raise payment request" drawer with the server's route text. |
| Finish this flight | live `StatList`, `ProgressChecklist`, `Dialog` | Server checklist (contract 7 tokens, "why" text in words), e-ticket upload (multiple files), "Mark flight done" stays focusable with `aria-disabled` and one reason until the list is clear; dialog lists flights, PNRs, ticket count; no "costs are locked" claim (fixes FV:2480). |
| Deal page flight card + approval card | live `Card`, `Notice` | Per pending change: previous → proposed flights, travellers, remark, Approve / Reject (reason 10–500). Current flights with approved changes, unnamed travellers notice, e-ticket links, "Meets flight" for transfers. No fares. |
| Supplier invoices (Work and Files) | Purchase "Upload invoice or credit note" drawer pattern, live `Drawer`, `StatusBadge`, `Notice` | Invoice only (credit notes stay Purchase); file stored first, then the details; "Invoice missing" notice; also after "done". |
| Flight suppliers and bank details | Purchase supplier register layout (row per supplier, side drawers) | Add supplier, Edit/Archive (says it becomes unverified again), Add bank details (never shown back; "Bank details approved" / "No approved bank details"). |
| Manager · Flight fares above budget | live `Card`, `EmptyState` | One row per request with Approve these fares / Return (reason). |

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Synthetic, generic queries only; no customer, supplier or money data.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `progress steps` | Steps (anubra266), Task Steps, Multi-Step Progress (sean0205, already the source of `ui/progress-checklist`), Onboarding Steps with Progress, Progress List | Idea only (Steps) | A horizontal numbered track with done / current / not started fits the prototype's progress bar; built as a plain ordered list with the CRM tokens and words for each state instead of adding the component. |
| 2 | `flight itinerary` | Flight Ticket, Flight Search, FlightMultiRoute, Flight Card, Trip Details Card | No | Consumer booking cards with animation and prices; the Flight team needs a dense editable grid. Kept the prototype's table. |
| 3 | `diff list` | Key Value List, Package Dependency List, Interactive List, List 2, Disc Reveal List | Idea only (Package Dependency List) | Grouped rows with a state word per row fits "Booking changed" (Unchanged / Changed / Removed / Added); built as plain lists inside a Card. |
| 4 | `expandable row` | Expanding Sub-Rows Table, Data Grid Table, Expandable Gallery, HeroUI Table, Table (originui) | Idea only (Expanding Sub-Rows Table) | The queue's "Show N flights" uses the idea with a native `<details>` in the existing table (no TanStack, no new dependency). |

## Checks (4 Nov 2026, local mock preview only)

- Preview states `flight-*` (list on /preview, group "Flight build"). The older names (B1 `flight-task-*`, Batch 4 `b4-flight-*`, B1.1 `b11-flight-task-*`) now render the new screens.
- Every `flight-*` state at 1280 px and 375 px: axe (WCAG 2.2 AA tags) clean, one h1, no sideways scroll, no console errors.
- Opened by click (1280, 375 and 640 px for 200% zoom, reduced motion): Confirm tickets popup, Alternate and Add sector edit rows, passenger itinerary dialog, Correct ticket, both payment drawers, Mark flight done, Manager's move drawer, queue disclosure: axe clean, no sideways scroll, focus on the first field.
- Keyboard: Alternate opened with Enter, saved, focus back on its button; Escape closes the popup and focus returns to "Confirm tickets"; a refused confirm keeps every typed value ("Nothing was confirmed" summary).
- Not checked: real data, a screen reader by hand.
