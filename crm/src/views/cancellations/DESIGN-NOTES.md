# Trip-cancellation panels: design notes (Track E, Accounts phase 2, 11 Nov 2026)

Business rules come from the frozen Accounts phase 2 contract (7.1, 7.4 C9–C11, 9, 10, 11 items 6–8; LD12–LD14; Addendum L3 form fields). Every screen is composed from the existing CRM kit (`src/components/ui/*`: Card, StatusBadge with icon and words, Notice, Table with stacked phone rows, ChoiceGroup/Radio, Field, MoneyInput, Textarea) and the Accounts desk dialog (`views/accounts-desk/desk-kit.tsx`: one form per dialog, one primary button, refusal keeps the dialog open with every typed value, the named field marked and focused, request id renewed only after success). No new dependency.

## Screens and where they live

| Screen | Files | Preview states |
|---|---|---|
| Flight task › Trip cancelled (11.6) | `views/flight/trip-cancelled.tsx`, `views/cancellations/flight-model.ts`; badge in `views/flight/money.tsx`; placed first on the Work tab (`views/flight/work-tab.tsx`) | `acc2-cancel-flight-*` |
| Visa task › Trip cancelled (11.7) | `views/visa/trip-cancelled.tsx`; placed above the step bar (`views/visa/work-tab.tsx`) | `acc2-cancel-visa-*` |
| Manager cancellation review (11.8) | `views/purchase/manager-approvals.tsx` (Flight charges table, charges kept, Visa-only line) | `acc2-cancel-manager-*` |

View-side shapes: `views/cancellations/types.ts` mirrors the additive keys of Track C's reads (`flight_money` batch `cancellation` / `ticketsCancelled`, `visa_workspace` `cancellation`, per application `cancellationChoice` / `canChooseCancellation`, per fee `refundExpectedPaise`, `manager_cancellation_list` `flightCharges` / `chargesKeptPaise`). All optional, so the existing screens and states are unchanged until the database sends them.

## Interaction decisions

- Flight: one section per ticket batch with its supplier cost, "Airline keeps", "Refund expected", "Refund reported" (the airline's word, not money) and "Refund received (verified)" (Accounts' verified receipts; received sum only, contract 10). Status in words: "Charges not entered yet", "Charges entered · revision n", "Tickets cancelled" (approved; the tickets themselves stay as issued, so the label also shows on the batch in Cost and payment). The batch button opens one dialog ("Enter airline charges" / "Change airline charges"); after approval it becomes "Update refund reported" and the approved amounts are shown as text and sent unchanged as hidden values (LD13). Someone else's batch: the button stays visible, `aria-disabled`, with "Only the Flight person on these tickets enters the airline charges."
- Visa: while the cancellation is open only a warning banner (LD12: the block starts at approval). After approval a card with the frozen refusal words ("The trip is cancelled. New fees, applications and payments are stopped."), the submitted applications with "Decide" (radio "Withdraw the application" / "Let it finish" + reason 10–300) or their choice in words, and the fees the company paid with "Set / Change refund expected" (no entry = not refundable). The Manager and colleagues read the same card without buttons.
- Manager: the cancellation item keeps its approve/return form; it adds "Charges kept (suppliers and airlines)" and a table "Airline charges per ticket batch" (stacked rows on phones). A case with nothing to charge says "You can approve the cancellation directly" (LD14).
- No customer money, selling price or customer refund appears on any of these screens (Flight and Visa fences, contract 10).

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Short synthetic queries only; no customer, supplier or money data was sent.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `cancellation banner` | Banner (diceui), Project Banner (shugar), Announcement Banner (cnippet-dev), Banner (serafimcloud), Promo Banner (shadcndesign) | Idea only (Project Banner) | A non-dismissible banner for a temporary state that needs resolution fits "Trip cancellation in progress"; built with the kit Notice (icon + title + words), not dismissible, no countdown. |
| 2 | `charges table` | Records Table (theshanelevine), Invoice Table (felipemenezes098), Table (originui), Payments Table (bundui), Table (cnippet-dev) | Idea only (Invoice Table) | Right-aligned amounts per row with a caption-like heading; the kit Table already stacks rows on phones. No footer total (the item shows "Charges kept" above), no sorting or row selection. |
| 3 | `radio choice` | Radio (klyv-ui), Radio Group (originui, shadcn), Radio (preetsuthar17), Reshaped Radio | Idea only (Radio Group with descriptions) | Two native radios with one-line descriptions inside a fieldset with a legend (kit ChoiceGroup); no animated or card radios. |
