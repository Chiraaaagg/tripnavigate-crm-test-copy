# Write-off screens — design notes (Accounts phase 3, track U, 13 Nov 2026)

Contract 6.6, 13, 14 and 15 screen 6. Synthetic content only in every 21st.dev query.

## 21st.dev calls

| Query | What came back | Adopted? | Why |
|---|---|---|---|
| `approval queue` | Access Request Inbox (grouped queue, approve supersedes others), Message Queue, Pending, Approval Card | Partly | Took the "one card per request with the reason and the decision buttons" layout for the Approvals › Write-offs tab. Did not take grouping or the AI-style approval card: one write-off per Deal, decisions go through the existing dialog kit. |
| `summary stats` | Public Stats, Stats, Stats Section (three-column metric block), Stats 2 | Partly | Three metric tiles (Deals, waived, kept) on the monthly totals page, built with the existing `StatCard` (no count-up motion, calm). |
| `message log` (lead's call, shared) | Log Viewer, Audit Log, Message Thread | No | Write-off history is a status badge plus one sentence; a log viewer is too heavy. |

## Adaptations

- Small balances list reuses the Customer documents list pattern: quick views as links (address keeps them), stacked table under 640 px, keyset "Next page".
- Every action is one dialog from `views/accounts-desk/acc2-kit.tsx` (one primary button, refusal keeps typed text, focus returns to the opener). The amount is never typed: a write-off is the whole balance, sent as a hidden paise value; approval binds `expectedAmountPaise`.
- Status = icon + words (`Waiting for Manager approval`, `Written off`, `Returned by the Manager`, `Withdrawn`, `Undone`, `Needs review`), never colour alone.
- A blocked "Propose write-off" stays visible, `aria-disabled`, with the first block reason under it; further reasons listed in the row.
- Dues line component `DuesWriteOffLine` renders the contract sentence "Written off ₹X by <Manager> on <date> — reason" for Accounts, Manager and Sales.

## Checked

1280 px and 375 px (no page-level sideways scroll), keyboard open/close of the propose dialog with focus return, refusal focus, approve success path, no console errors from these pages.
