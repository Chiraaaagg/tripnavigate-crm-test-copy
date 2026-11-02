# Application modules

TripNavigate CRM is a modular monolith (approved D04). Each folder under
`src/modules` owns one business capability. Identity, access, read-only Leads/Deals, Bitrix intake, the accepted hotel booking slice, hotel procurement and the Accounts receipt foundation are implemented in source. This does not certify release or live operation. Read `docs/implementation/README.md` from the repository root for the current repair branch, main integration differences, evidence and gates.

| Module | Current implementation | Remaining scope |
|---|---|---|
| `identity` | Staff onboarding, MFA, recovery/session controls; fixed recovery deletion plans, case-bound provider resume, audited cleanup retry and their Staff page controls | Coordinated migration/application release; invitation result handling in the combined revision |
| `access` | Memberships, roles, scoped permissions and administration | Real staff grants and access verification |
| `deals` | Bitrix header visibility under RLS | Commercial data ownership and verified conversion linkage |
| `integration` | Receiver, inbox, worker, reconciliation and manifest gates; newer automatic sync/soft removal restored on main | Teammate-owned combined source/database reconciliation and current operational evidence |
| `fulfilment` | Accepted hotel booking, evidence and one Purchase task | Amendments, cancellations, other service types, readiness and closure |
| `procurement` | Suppliers, offers, immutable costs, private evidence and supplier confirmation | Live release and wider service execution |
| `finance` | Accounts booking review/billing, customer receipts with independent verification, cash/deposit/reconciliation, cheque clearance, reversals, policy and operational journal | Company bank/UPI destinations in review (Stage 2, draft PR 16); supplier originals, Sales status projection, accounting pack, allocations/funding and settlement later |
| `documents` | General module placeholder; specific private evidence exists in booking, procurement and finance | General document lifecycle and future verification requirements |
| `reporting` | Placeholder | Permission-aware reports and exports |

## Rules for every module

1. **Folder layout.** `server/` holds code that may touch the database or
   secrets and starts with `import 'server-only'` (or `'use server'` for
   actions). Pure rules and DTO shaping live beside it and are unit-tested.
2. **Authorization first.** Every server action or route calls
   `requireStaff()` (aal2 + active staff) and then a database command or
   RLS-protected query under the user's own session. Never read the actor's
   identity, entity or branch from request input.
3. **Privileged client last.** `@/lib/supabase/admin` (secret key, bypasses
   RLS) is importable only from `src/modules/*/server/**` (ESLint enforced) and
   only after a database command authorized the actor.
4. **DTOs only.** Pages receive DTOs, never raw rows. Restricted fields
   (selling price, margin, documents) are added only when the access policy
   allows it, in addition to database filtering.
5. **Cross-module calls** go through a module's exported functions, not its
   tables. Finance owns money tables; other modules read finance projections.
6. **Writes are commands.** Multi-row business changes run in one database
   transaction (SQL function or server-side transaction) together with the
   audit event, and later with the outbox row. No sequence of independent HTTP
   calls for one business change.
