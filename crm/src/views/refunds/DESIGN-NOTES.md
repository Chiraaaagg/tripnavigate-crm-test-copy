# Accounts phase 2: refunds design notes (Track E, 11 Nov 2026)

Business rules come from the frozen Accounts phase 2 contract (sections 7, 9, 10, 11; owner answers Q5–Q8, Q6 one-person payout; LD5, LD8, LD11, LD31, LD32; Addendum L1 one-step supplier refunds; Addendum L3 form shape). Composed from the CRM kit, the Phase 1 desk kit and `views/accounts-desk/acc2-kit.tsx`. No new dependency.

## Screens and where they live

| Screen (contract 11) | Files | Preview states |
|---|---|---|
| 3. Deal page › Refunds card | `deal-card.tsx`, `request-block.tsx`, `fields.tsx`, `supplier-refunds.tsx`, `labels.ts` | `acc2-refund-deal-*` |
| 4. Approvals › Refunds to approve (`/app/approvals`) | `desk.tsx` (`ApprovalsRefundsSection`), slot in `../purchase/manager-approvals.tsx` | `acc2-refund-approvals-*` |
| 5. Accounts › Refunds (`/app/accounts/refunds`) | `desk.tsx` (`AccountsRefundsPage`) | `acc2-refund-desk-*` |

## Interaction decisions

- One refund request block is shared by all three screens: status words, the figures, the payee ("the person who paid" or "someone else" with the reason the Manager sees), the reason and a short history list (asked, approved/returned, paid, withdrawn, credit note). Buttons follow the read's `can` flags only.
- The request form is one dialog: kind (cancellation only once the cancellation is approved, otherwise disabled with that reason), outcome, customer charge, amount with the live maximum ("At most ₹… (verified money held minus the customer charge)") from track C's pure limits mirror; the database decides. Charge-only hides the amount (sent as 0).
- Approve binds the exact amounts: the button and dialog say "Approve ₹55,000 refund (charge ₹20,000)" and send hidden `expectedAmountPaise` / `expectedChargePaise`; a change meanwhile returns "Someone changed this meanwhile" and nothing is approved.
- Payout: "Pay out and verify RF-…" with mode, paid on (min = approval date, max = today), reference (optional only for cash), proof file in the same form (track C uploads it, discards it if the command refuses). The dialog says the person records and verifies in one step and cannot pay out a refund they asked for or approved.
- Supplier refunds: expected and received side by side, "Record refund received" (one step, Addendum L1), "Cancel" with a reason; the over-expected reason field appears only when the typed amount is above what is still expected. "Supplier refunds never change what the customer owes."
- Queues (Approvals, Accounts › Refunds) load each request's Deal read (R-C1) so the decision binds what is shown; if that read fails the row says so and links to the Deal page.
- Purchase, Flight and Visa never get the card (the read returns null and the route renders nothing); a failed read shows an error card only to people who may read customer money.

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Short synthetic queries only.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `refund request` | Time Off Request Calendar, Support Request Fieldset, Appointment Booking Split, Access Request Inbox, Collaborative Requests Dropdown | Idea only (Access Request Inbox; Support Request Fieldset) | A queue of requests, each with what was asked and approve/return beside it; grouped fieldset with a legend per choice. No avatars or bulk approve (each approval binds exact amounts). |
| 2 | `approval timeline` | Onboarding Timeline, Milestone Timeline, Delivery progress, Process Timeline, Timeline | Idea only (Milestone Timeline) | A short vertical list of dated steps with who did them; plain text with a left rule, no icons-only states. |
| 3 | `file upload` | File Upload (x3), upload, File Upload | No | A drop zone adds script and hides the native control's keyboard and screen-reader behaviour; the native file input with a label and hint is kept, as in the Phase 1 supplier payment form. |
