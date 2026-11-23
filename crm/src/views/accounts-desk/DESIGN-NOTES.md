# Accounts phase: design notes (Track D, 10 Nov 2026)

Business rules come from the frozen Accounts phase contract (sections 4, 7–9, 11; lead decisions of 10 Nov 2026). Every screen is composed from the existing CRM kit (`src/components/ui/*`: Table with stacked phone rows and a labelled scroll region, StatusBadge with icon and words, Notice, EmptyState, ErrorSummary, Radix Dialog / DropdownMenu / Popover, PageHeader, Card) and the patterns of the Purchase, Flight and Visa builds (request id per form renewed only after success, refusals keep typed values, one primary action per screen). No new dependency.

## Screens and where they live

| Screen | Files | Preview states |
|---|---|---|
| Accounts › Documents and money (11.1) | `records.tsx`, `records-table.tsx`, `record-cells.tsx`, `row-actions.tsx`, `address.ts` | `acc-records*` |
| Accounts › Dues (11.2) | `dues.tsx` | `acc-dues*` |
| Accounts › Tally (11.3) | `tally.tsx`, `tally-export-form.tsx` | `acc-tally*` |
| Deal page "Customer dues" card (11.4) | `deal-money.tsx`, `deal-money-forms.tsx` | `acc-deal-dues*` |
| Notification bell and sound (11.5) | `../notices/bell.tsx`, `provider.tsx`, `sound.ts` | `acc-bell*` |
| Phase 0 (11.6) | `booking-form/ready-list.tsx`, `passengers-card.tsx`, `booking-form-screen.tsx`, `b11/id-proof-slot.tsx`, `b11/id-proofs-list.tsx`, `finance-views.tsx`, `flight/money.tsx`, `flight/cancel-request.tsx` | `bookform-flight-only--*`, `acc-id-proofs-flight-only`, `finance-deal-return-blocked-committed--*`, `flight-ws-cancel-*` |
| Purchase "Booking changed" banner (11.7) | `../purchase/booking-change-banner.tsx` | `acc-purchase-changed*` |
| Home row, nav, settings (11.8) | `home-view.tsx`, `StaffShell.tsx`, `NavLinks.tsx`, `shell-permissions.ts`, `settings.tsx` | `acc-home-purchase`, `acc-settings` |

## Interaction decisions (accessibility, not policy)

- Search and filters are plain GET forms and chip links, so the address keeps every filter, the back button works and nothing needs script. Active filters show as removable chips plus "Clear all". The filter panel is a `<details>` that opens by itself when a filter is set.
- "Show more" appends the next keyset page in place (focus moves to the first new row); without script a `<noscript>` link opens the same list after the cursor. Totals are read only on "Show totals".
- The workspace table has 8 columns (type folded into the record cell as an eyebrow); from 640 px it keeps a minimum width and scrolls inside its own labelled, focusable region; under 640 px each row is a labelled card. The page never scrolls sideways (checked at 375 px).
- Row actions: one menu button per row named after the record ("Actions for Supplier payment SP-…"); each item opens one dialog with one primary button. A refusal keeps the dialog open with an ErrorSummary that takes focus and every typed value.
- Bell: one notices connection per tab (provider), two buttons (sidebar on desktop, top bar on phones; only one is displayed). The button's accessible name carries the counts ("Notices: 6 unread, 2 urgent"); the visible urgent count says "urgent" in words. The panel is a Radix Popover (role dialog, Escape, focus return). Urgent notices have the word "Urgent", a border and "Done"; normal ones group per Deal in a `<details>` line. New notices are announced in a polite live region, urgent ones assertively, at most one every 10 seconds.
- Sound: off by default; "Sound on / Sound off (mute)" is a pressed toggle; "Test sound" unlocks audio; after a reload the bell says "Click anywhere to turn sound back on" until the first click. Tones are Web Audio (three-note square for urgent, one soft sine for new tasks).
- Purchase banner sits above the task header on every tab; "OK, seen" is a secondary button so the page keeps one primary action.
- Flight "Cancel request" shows whenever the money read says `canCancel` (also for a requester who no longer holds the task); the confirm dialog's buttons are "Keep the request" and "Cancel the request".
- Reduced motion: every animation uses the kit's `motion-reduce:` variants; the retry spinner uses `motion-safe:`.

## 21st.dev calls

Tool: `search`, type `component`. Short synthetic queries only; no customer, money or document data was sent.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `notification inbox` | Notification Panel (uvain), NotificationInbox Popover (ruixen.ui), Illos Notifications Popover, Team Invitation, Avatar Notifications | Idea only (Notification Panel; Inbox Popover) | "Seen vs dealt with" maps to urgent read vs Done; header "Mark all read" and footer history link. Built on Radix Popover and the CRM kit; no illustration, avatar or blinking dot (status never by colour or motion alone). |
| 2 | `table filters` | Table (originui), ReUI Filters, Flexi Filter Table (ruixen.ui), Advanced Data Table Filter Builder, Role Filter Chips | Idea only (Flexi Filter Table, ReUI Filters) | A plain filter panel of selects and dates plus removable chips; no AND/OR builder (the read takes a fixed allowlist) and no client-side table library. |
| 3 | `payment schedule` | Receipt Pricing, Appointment Booking Split, Dialog, Pricing Table, Invoice History Table | Idea only (Invoice History Table) | Instalments as rows with status badges; no download buttons (the CRM issues no invoice). |
| 4 | `export form` | Data Export Checkbox Group, Share Menu with Export Submenu, signature pad export, Excel Viewer, Import Patchbay | Idea only (Data Export Checkbox Group) | Record types as a ticked checkbox group; one format only (CSV evidence pack), so no format menu. |
| 5 | `alert banner` | Alert (serafimcloud), Alert Banner (lavikatiyar), Alert (appica-dev), Alert Light Danger, System Message | Idea only (Alert Banner) | The "Booking changed" banner: icon, title, list, one action; not dismissible (it leaves only with "OK, seen"). |
| 6 | `installments table` | Invoice History Table (2), Invoice Line Items Table, Invoice Table | Idea only (Invoice Line Items Table) | Amount / covered / open columns with right-aligned figures; no totals footer (the summary above carries the totals). |
| 7 | `settings switch` | Switch (serafimcloud), Switch (redrob-labs), Switch (cnippet), Switch With Description | No | A switch that changes at once does not fit: every change here needs a reason and is audited, so it is a button "Switch on / Switch off" with a reason field and the current value in words. |
| 8 | `diff list` | Key Value List (corr), Package Dependency List, Interactive List, List 2 | Idea only (Key Value List) | The banner lists "label: before → after" lines in a plain list. |

## Preview states

Group "Accounts phase (10 Nov 2026)" and "Accounts phase 0" on `/preview`. Synthetic props only.

## Not done here (reported to the lead)

See the Track D report: wiring of the Accounts desk pages to track B's reads and actions, Settings tab entry, and gaps in the frozen reads (eligible tasks for "Link to another task", the existing bill's id on a duplicate refusal, a settings read for the Tally switch and exception owner).
