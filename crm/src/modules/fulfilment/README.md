# fulfilment module

Phase 3: an accepted hotel booking version on a deal becomes one internal
Purchase hotel task. Contract: `docs/implementation/history/phase-3/contract.md`
(§7–§8 for this code). Follow the rules in [../README.md](../README.md).

| File | Role |
|---|---|
| `contracts.ts` | Frozen types and wording (lead-owned; import, never redefine) |
| `commands.ts` | Typed RPC wrappers for agent B's commands and read functions; zod-validated (fail closed); `BookingCommandError` maps SQLSTATE + exact token to `BookingErrorCode` |
| `evidence.ts` | Server-side file checks: size, declared type, magic bytes, name sanitizing, sha256 (`node:crypto`) |
| `forms.ts` | Form field names (`FIELD`) and pure parsing; rupees ↔ paise with BigInt only. Client-safe |
| `dto.ts` | DTO shaping. Selling total only when `canReadDealCommercial`; Purchase DTOs are explicit whitelists with no commercial/evidence field. Client-safe |
| `server/actions.ts` | Server actions (`'use server'`) |
| `server/queries.ts` | Page loaders (`server-only`) |
| `server/evidence-download.ts` | Handler for `GET /app/bookings/evidence/[id]` |
| `server/intake.ts` | B1 loaders: intake screen, Deal services, Deals list summaries, workflow switches (`server-only`) |
| `server/intake-actions.ts` | B1 intake server actions (`'use server'`) |
| `server/flight.ts`, `server/flight-actions.ts` | B1 Flight queue loaders and claim action |
| `server/counts.ts` | B1 `loadMyWorkCounts` (null on any failure) |
| `server/workflow-actions.ts` | B1 `setWorkflowSettingAction` (Super Admin switches) |
| `server/workflow-settings.ts` | Re-exports `loadWorkflowSettings` under the path named in the freeze note |

`index.ts` is client-safe (contracts, `formatEvidenceSize`, `nightsBetween`,
`BOOKING_FORM_FIELDS`, `paiseToRupeesInput`, `rupeesToPaise`). Import server
code by path.

## API for agent C

### Loaders (`@/modules/fulfilment/server/queries`)

Call with the `StaffContext` from `requireStaff()`.

| Function | Returns | Notes |
|---|---|---|
| `loadBookingForDeal(staff, dealId)` | `BookingPanelView \| null` | `null` = deal not visible, malformed id, or viewer holds Purchase in the entity. `sellingTotalPaise` key is **absent** unless the viewer may read commercial values |
| `loadPurchaseQueue(staff)` | `PurchaseQueueView` | `{ tasks: [] }` when nothing is visible |
| `loadPurchaseTask(staff, taskId)` | `PurchaseTaskView \| null` | `null` = not found or not visible (indistinguishable) |
| `loadBookingHealth(staff)` | `BookingHealthView \| null` | `null` = viewer is not an integration admin |

All of them **throw** on failures the database did not explain (show the
error state, never an empty one).

Panel semantics: `state` is `none` (no version), `draft_needs_repair`,
`draft_ready` or `confirmed`. `canEdit` is false once confirmed. `canConfirm` =
the viewer may confirm **and** the draft is ready. `confirmBlockedReason` is
set only when `canEdit && !canConfirm`: `ERROR_TEXT.not_authorized` when the
viewer may not confirm, the gate's `ISSUE_TEXT` (`environment_unset` /
`booking_disabled`) when the gate blocks, otherwise `null` (use `issues`).
`openBlockedReason` is set (to `ERROR_TEXT.deal_not_active`) only for
`state === 'none'` when the viewer could start a booking but the Deal is lost
or rejected in Bitrix (Stage 7, migration 20261115000100: the stage list is the
`authz.lost_deal_stages` table); the panel then shows the reason instead of the
start control, and `openBookingDraftAction` would answer `deal_not_active`.
Rollout: deploy this app before (or with) migration 20261115000100. An older
app maps the 55000 `deal_not_active` refusal to a generic failure; this app
treats a missing `dealNotActive` key as false, so it is safe on the older
database.
`contentHash` is the value to post back unchanged when confirming. Evidence
rows with status `removed` are not listed. `confirmed` is set only for
`state === 'confirmed'` (the shaper refuses a confirmed version without its
task).

### Actions (`@/modules/fulfilment/server/actions`)

Signature for all: `(previous: BookingActionResult<T> | null, formData: FormData) => Promise<BookingActionResult<T>>`
(fits `useActionState(action, null)`). Use the `FIELD` constants from
`@/modules/fulfilment/forms` for input names. Actor, entity, branch and
ownership are never read from the form.

| Action | FormData fields (exact names) | `data` on success |
|---|---|---|
| `openBookingDraftAction` | `dealId` | `OpenDraftResult` (`created` false = existing draft returned) |
| `saveBookingDraftAction` | `dealId`, `versionId`, `rowVersion` (the panel's `rowVersion`), `hotelName`, `city`, `checkIn`, `checkOut` (`YYYY-MM-DD`), `rooms`, `roomType`, `mealPlan`, `adults`, `children`, `inclusions`, `specialRequests`, `purchaseBudgetRupees`, `sellingTotalRupees` | `SaveDraftResult` (new `rowVersion`, `contentHash`) |
| `uploadBookingEvidenceAction` | `dealId`, `versionId`, `kind` (`EvidenceKind`), `file` (one `File`) | `{ evidenceId }` |
| `removeBookingEvidenceAction` | `dealId`, `evidenceId` | `{ evidenceId }` |
| `confirmBookingAction` | `dealId`, `versionId`, `contentHash` (panel's `contentHash`, unchanged) | `ConfirmBookingResult` (`outcome: 'created' \| 'existing'`) |
| `claimPurchaseTaskAction` | `taskId` | `ClaimTaskResult` (`alreadyYours` true on a repeat) |

Field rules (`saveBookingDraftAction`):
- Empty text/number/date fields are saved as "not filled in" (`null`); the
  readiness list says what is still missing.
- Amounts are rupees with up to 2 decimals; commas, spaces and a leading `₹`
  are accepted (`1,23,456.50`). Prefill with `paiseToRupeesInput(paise)`.
- `sellingTotalRupees`: render it only when the panel has the
  `sellingTotalPaise` key (commercial viewers). When present, the action sends
  `p_selling_total_provided = true` and an empty value removes the selling
  total. When absent, it sends `false` and the stored amount is left
  untouched (contract §12 A4 M3).
- Any invalid field returns `{ ok: false, code: 'invalid_input' }` before the
  database is called. The result does not name the field. Validate in the
  browser with `BOOKING_FACT_LIMITS` to highlight it.

Failure results are `{ ok: false, code, message }` with `message =
ERROR_TEXT[code]`. `confirmBookingAction` adds `issues` (the readiness list)
for `not_ready`. Upload outcomes: `evidence_rejected` (bad type, magic bytes,
empty, over `EVIDENCE_MAX_BYTES` (4 MiB), or more than 10 files) and `upload_failed` (storage failed, or the database found no matching object (A4 H2);
the row is marked failed). If the final step's outcome is unknown, the upload
returns `{ ok: false, code: 'upload_failed', message: UNKNOWN_OUTCOME_TEXT }`
and the stored object is kept (A4 M1). Show `message`, not a text derived from
`code`. A first-time confirmation succeeds with `CONFIRM_SUCCESS_TEXT`.
Unexpected failures (unknown database state, malformed response, network)
**throw** an error whose message is `UNKNOWN_OUTCOME_TEXT`, because the
command may have committed. In production Next.js hides thrown messages, so
the route error boundary should show `UNKNOWN_OUTCOME_TEXT` itself. They are
never guessed into a refusal.
Session problems redirect via `requireStaff()`, or return `code: 'session'`
when the token expires mid-request.

Evidence uploads are capped at 4 MiB (`EVIDENCE_MAX_BYTES`, the hosted
function body cap). `next.config.ts` (lead-owned) sets
`serverActions.bodySizeLimit` and `proxyClientMaxBodySize` to `'5mb'` to leave
room for the multipart overhead.

### Evidence download

Link to `/app/bookings/evidence/<evidenceId>` (plain `<a href download>`, no
prefetch). It returns a 302 to a signed Storage URL that is valid for 60 s and
carries the stored file name, and a 404 for any refusal (Purchase, not stored,
unknown). Never render the file inline.

## B1: service items, intake, Flight queue, counts (10 October 2026)

Contract: `docs/implementation/frontend-first-plan-2026-10-10/b1-contract-service-items-intake-tasks-2026-10-10.md`;
shapes: `b1-freeze-note.md` (same folder). Every B1 read and command runs under
the staff member's own session; the database authorizes, validates the facts
again and audits. While `service_items_enabled` is off, every existing command
behaves exactly as before.

### Loaders

| Function (path) | Returns | Notes |
|---|---|---|
| `loadIntake(staff, dealId)` (`server/intake`) | `IntakeView \| null` | Composes `booking_panel`, `deal_services`, `intake_checklist` and the switches. `null` = not visible, malformed id, or no booking read (Purchase, Flight). The route redirects to the Deal page while `serviceItemsEnabled` is false. `stage.label` is null (the view labels raw stage ids); `isTriggerStage` = the checklist has no `stage_not_confirmed` item. `prefillSource` is `'crm'` until the Bitrix field mapping is approved (B1-O2) |
| `loadDealServices(staff, dealId)` (`server/intake`) | `DealServicesView \| null` | `null` also on a database that has no B1 functions yet (PostgREST `PGRST202`), so the Deal page works before the migration. `progress`, item `title` and `nextStep` are computed here (`computeProgress`, `itemTitle`, `nextStepFor` in `dto.ts`) from the items the database returned |
| `loadDealServiceSummaries(staff, dealIds)` (`server/intake`) | `Map<dealId, DealServiceSummaryView>` | Chunks of 50. Empty map on refusal or an older database (show the notice row); throws on an unexplained failure |
| `loadWorkflowSettings(staff)` (`server/intake` or `server/workflow-settings`) | `WorkflowSettingsView` | Both switches off on refusal or an older database; throws otherwise |
| `loadWorkflowSwitchStates(staff)` (`server/intake` or `server/workflow-settings`) | `WorkflowSettingsView` | Workflow switches page only: no fallback to off. Throws on any failure (the page says the state could not be read); a switch the database did not return stays `undefined` and shows as Unknown, never Off |
| `loadMyWorkCounts(staff)` (`server/counts`) | `MyWorkCounts \| null` | `null` on any failure: show "counts unavailable", never zeros |
| `loadFlightQueue(staff)`, `loadFlightTask(staff, taskId)` (`server/flight`) | `FlightQueueView`, `FlightTaskView \| null` | Mirror the Purchase loaders. Flight DTOs carry no selling price, proof files or other departments' budgets |

### Actions

Signature for all: `(previous: BookingActionResult<T> | null, formData: FormData)`.
Field names are the `FIELD` constants (`BOOKING_FORM_FIELDS`).

| Action (path) | FormData fields | `data` on success |
|---|---|---|
| `addServiceItemAction` (`server/intake-actions`) | `dealId`, `versionId`, `rowVersion`, `serviceType`, `requestId` (a fresh UUID per form render; the database replays an exact retry), `purchaseBudgetRupees`, the facts fields of the type (below) | `ServiceItemAddResult` |
| `saveServiceItemAction` | same plus `itemId` | `ServiceItemSaveResult` |
| `removeServiceItemAction` | `dealId`, `versionId`, `rowVersion`, `itemId` | `ServiceItemRemoveResult` |
| `saveTravellersAction` | `dealId`, `rowVersion` (the draft **package** version's), `travellerName[]`, `travellerType[]` (parallel; blank rows skipped; `seq` = 1..n) | `TravellersSaveResult` |
| `confirmIntakeAction` | `dealId`, `versionId`, `contentHash` | `ConfirmBookingResult` (`taskIds` = one per service) |
| `claimFlightTaskAction` (`server/flight-actions`) | `taskId` | `ClaimTaskResult` |
| `setWorkflowSettingAction` (`server/workflow-actions`) | `settingKey`, `settingValue` (`on`/`off`), `reason` (10–500 characters) | `WorkflowSettingResult` |

Facts fields per service type: hotel = the draft fields (`hotelName`, `city`,
`checkIn`, `checkOut`, `rooms`, `adults`, `roomType`, `mealPlan`, `children`,
`inclusions`, `specialRequests`); transfer = `route`, `date`, `vehicleType`,
`passengers`, `pickupTime`, `notes`; activity = `name`, `city`, `date`,
`participants`, `time`, `notes`; flight = `segmentFrom[]`, `segmentTo[]`,
`segmentDate[]` (parallel arrays; blank rows skipped), `passengers`,
`preferredTime`, `cabin`, `notes`. Required fields of an item must be filled
(an item is saved whole); an empty budget is saved as 0 and the checklist warns.

The parsers (`parseServiceItemForm`, `parseTravellersForm`,
`parseWorkflowSettingForm`, client-safe) answer `{ ok: false, fields }` with
the inputs to highlight (`segmentDate[1]`, `travellerName[0]` for rows).
`validateServiceFacts(type, facts)` is the client-side mirror of the database
validator. The action results themselves carry only `invalid_input` (the
frozen `BookingActionResult` has no field list); run the parser in the browser
to highlight fields and keep what was typed.

`confirmIntakeAction` answers `not_ready` with the readiness `issues`;
`created` uses `INTAKE_CONFIRM_SUCCESS_TEXT` with the task count, `existing`
uses `INTAKE_CONFIRM_EXISTING_TEXT`. Refusal codes added in B1:
`service_on_hold`, `too_many_items`, `item_locked`,
`traveller_identity_locked`, `service_items_disabled` (wording in
`ERROR_TEXT`). Unexplained failures throw `UNKNOWN_OUTCOME_TEXT` as before.

Purchase DTOs (`toPurchaseTaskSummary/View`) now carry `serviceType`,
`itemTitle` and typed `facts`; hotel fields are null / 0 for other service
types. On a database before B1 the hotel facts are built from the hotel
columns (deploy the app first, then the migration). A unit test walks the
Purchase and Flight DTO keys to prove no selling, margin or evidence field
can appear.

## Open questions (for the lead)

1. `BookingActionResult` has no code for an unknown outcome and no per-field
   errors. The upload's unknown outcome uses `code: 'upload_failed'` with
   `UNKNOWN_OUTCOME_TEXT`. Other unexpected failures throw. `invalid_input`
   carries no field list. An `unknown_outcome` code would remove the
   ambiguity.

## B1.1 (Book now, revision, Visa & Passport desk, department work forms)

Frozen contracts: the "B1.1" section of `contracts.ts` (freeze note `docs/implementation/frontend-first-plan-2026-10-10/b1.1/b1.1-freeze-note.md`). Built and unit-tested on `claude/b11-ts`; not merged, not released, not used with real data.

- Wrappers and zod mirrors: `b11-commands.ts` (untyped RPC surface until the lead regenerates `database.types.ts`).
- DTOs: `b11-dto.ts` (`toBookNowView`, desk and work-form DTOs with no commercial keys). Parsers: `b11-forms.ts` (frozen FIELD names).
- Loaders: `server/book-now.ts` `loadBookNow` (`BookNowView | null | 'not_installed'`), `server/visa.ts` `loadVisaQueue` / `loadVisaTask`, `server/department.ts` `loadDepartmentWorkForm`; `loadWorkflowSettings`, `loadDealServices`, `loadMyWorkCounts` carry the additive keys.
- Actions: `server/book-now-actions.ts` (`startBookNowAction`, `saveBookCustomerAction`, `saveBookTripAction`, `saveTravellerIdentityAction`, `saveParticipationAction`, `saveBookPriceAction`, `saveBookPaymentAction`, `submitBookingAction`, `openRevisionAction`, `classifyRevisionAction`, `discardRevisionAction`), `server/visa-actions.ts`, `server/department-actions.ts`; download handler body `server/department-evidence.ts`. Claims and expense review actions live in `finance/server/claim-actions.ts` and `finance/server/expense-actions.ts`.
- A database without B1.1 answers "function missing" (PGRST202 / 42883): loaders treat it as not installed.
- Versions (Echo review R4): claim and task commands resolve the current version server-side (`authz.task_current_version` / the Deal's working or accepted version); the browser never chooses it. A `versionId` returned to the browser may therefore be a superseded base after a revision: reload before acting on it, and never treat it as "the current version".
- Task DTOs carry no version number (the earlier `currentVersionNo` key was dropped: no database read sends it); `changedFields` lists non-commercial field names only.

## B1.2 (quotation conversion and booking money)

- `booking_commercials_save` and `booking_instalments_save` are the normal writers of a booking draft's selling total and payment plan. The one other writer is quotation conversion (`quotation_convert_to_booking`, migration 20261120000200, calling `authz.quotation_money_to_booking` from 20261120000300): inside the same transaction it writes `booking_version_commercials.selling_total_paise` (list price and discount stay empty), `booking_version_instalments` and the converted items' `purchase_budget_paise` directly, audited once as `quotation.converted`. Keep its rules in step with those two commands (amount limits, at most 12 instalments, label 1–60 characters, dates 2000–2100); a change to either command's validation must be mirrored in the quotation plan checks of 20261120000300.
