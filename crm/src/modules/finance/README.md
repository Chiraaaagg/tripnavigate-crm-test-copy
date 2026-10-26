# finance module (Phase 5A: Accounts review and customer receipts)

Contract: `docs/implementation/history/contracts/phase-5a-contract.md` (frozen). Migration:
`supabase/migrations/20261101000100_accounts_receipts.sql`, repaired forward by
`20261103000100_cash_overview_repairs.sql` (Phase 5B Milestone A sections 2-3:
reconciliation obligations that never expire with explicit states, bounded
unresolved lists with full totals, and a paged Accounts queue). This is an internal
operational record of money the company says it received. It is not an
official ledger, a tax receipt voucher or a tax invoice. Invoices, tax,
refunds, supplier payments and bank feeds are not part of this module yet.

## Files

| File | Purpose |
|---|---|
| `contracts.ts` | Lead-owned shared types, error tokens and staff wording. Do not edit here. |
| `dto.ts` | zod mirrors of every read shape; responses are validated before a page sees them. |
| `commands.ts` | Typed RPC wrappers. Errors map by exact token + SQLSTATE (`FINANCE_ERROR_STATES`); anything else is `code: null` (fail closed). `cash_cap_exceeded` carries `capKind` (`payer_day` or `trip`) from the SQL DETAIL. |
| `forms.ts` | Pure FormData parsing (`FINANCE_FIELD` names = `FIN_FIELD` in `src/views/finance-forms.tsx`), exact rupees-to-paise BigInt conversion, IST dates, field errors mirroring the SQL. |
| `server/queries.ts` | Reads under the staff session client: `loadAccountsQueue` (one page of 50 by deal reference; optional `after` cursor from the previous page's `nextAfter`, a malformed cursor loads the first page; returns `{ items, hasMore, nextAfter, totalCount }`), `lookupAccountsDeal`, `loadAccountsDealDetail`, `loadCashOverview`, `loadFinancePolicy`, `financeEnabledEntityIds`. Refusals throw `FinanceReadError` whose `.code` is the token; lookup/detail return `null` for not found or not visible. |
| `server/actions.ts` | `'use server'` actions `(prevState, FormData) -> { status, message?, fieldErrors?, code? }`. Each reads the hidden `requestId`. |
| `server/evidence.ts` | Server-side upload (`storeFinanceEvidence`: the server checks the file and computes its sha256) and the download route helper (`financeEvidenceDownloadResponse`, used by `/app/accounts/files/[id]`). |
| `server/slip-id.ts` | `depositSlipRequestId`: the deposit slip's request id, derived (UUID v5) from the deposit form's request id so a retry replays both. |

## Rules

- Every read and command is a SECURITY DEFINER RPC; finance tables have no
  Data API privileges. The privileged client is used only for Storage, after
  the database authorized the actor and generated the object path.
- Amounts are whole paise as digit strings; never JS numbers or floats.
- A definitive refusal writes nothing, so the page may issue a new `requestId`
  after a known result. An unknown outcome preserves the existing ID and inputs
  until reconciliation; it must not be retried with a fresh ID. The same `requestId` with the same payload replays the stored
  result (`outcome: 'existing'`).
- Cash reconciliation forms accept valid non-future dates. The locked database
  command decides whether an old obligation or stale-only replacement is eligible;
  no unconditional 90-day form cutoff applies.
- Deposit slips are uploaded with the deposit (`recordDepositAction`); the
  slip is begun against the branch and linked when the deposit is recorded.
  A refused deposit removes its unused slip. A rejected deposit releases its
  slip: it may be removed and the same file uploaded for a new deposit.
- Cheque clearance and bounce proof must be uploaded after the cheque was
  presented (verified) or re-presented.
- Payment modes are switched in `finance_live_settings` only after CA
  confirmation (contract section 14), by owner SQL or by a Super Admin through
  `public.admin_set_finance_live_modes` (reason required). Every change writes a
  `settings.finance_live_changed` audit row (migration 20261114000100).
  Engineering never enables them.
- A Super Admin who also holds Accounts in the company is refused by
  `admin_set_finance_live_modes` (the same separation as
  `finance_policy_update`). This rule applies to the finance switches only;
  the booking and supplier-confirmation switches need Super Admin alone.

Follow the rules in [../README.md](../README.md).

## Current repair checkpoint

The seed and old-date parser repairs, recovery backend, deposit checker slip link and recovery controls are in draft PR 15 (Claude continuation, 8 October 2026). Stage 2 company destinations has a frozen contract but no implementation. Follow `docs/implementation/current/codex-stage-0-1-release-evidence-2026-10-08.md` and the authoritative implementation index; source and test existence do not establish live activation.
