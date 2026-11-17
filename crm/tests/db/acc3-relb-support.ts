import { expect } from 'vitest';
import { type Actor, type TestDb, resetActor } from '../helpers/db';
import {
  ACTIVITY_ITEM, HOTEL, HOTEL_ITEM, type Item, PASSPORT_ITEM, TRANSFER_ITEM, TRIP, VISA_ITEM, dayFrom, sha,
} from './acc-support';
import {
  ACC, ACC2, DEAL, MANAGER, MANAGER_J, MANAGER_J2, OWNER, PURCHASE, REASON, SUPER, TOKENS, U, U2, acc3Helpers, rid, text, today,
} from './acc3-support';

/**
 * Accounts phase 3, Track T — Release B helpers (contract sections 9-12, 13,
 * 14, 16.1 E / G / H / N). Written from the frozen contract, NOT from the
 * tracks' code: every command and read is called with the positional
 * signature the contract freezes. Builds on acc3Helpers (acc3-support.ts).
 * Every scenario runs inside ONE rolled-back owner transaction (asOwner).
 *
 * Actors (synthetic, @example.test):
 *   OWNER       Sales Delhi A      Sales owner of SYN-DEL-001 (asks for changes)
 *   MANAGER     Manager Delhi      branch Manager of the Deal (Approver)
 *   MANAGER_J2  Manager Jodhpur 2  another Manager of the entity (LD37 Approver when MANAGER asked)
 *   PURCHASE    Purchase Jodhpur   enters rate contracts; Purchase assignee of hotel tasks
 *   ACC         Accounts Jodhpur   (A)
 *   SUPER       Admin Jodhpur      Super Admin (switches)
 */

export { ACC, ACC2, DEAL, MANAGER, MANAGER_J, MANAGER_J2, OWNER, PURCHASE, REASON, SUPER, TOKENS, U, U2, rid, sha, text, today, dayFrom };
export { ACTIVITY_ITEM, HOTEL, HOTEL_ITEM, PASSPORT_ITEM, TRANSFER_ITEM, TRIP, VISA_ITEM };
export type { Item };

// ---------------------------------------------------------------------------
// Contract signatures, positional (Release B)
// ---------------------------------------------------------------------------
export const SQLB = {
  // E 9.1-9.5
  setRateContracts: 'select public.admin_set_rate_contracts_enabled($1, $2) as r',
  roomTypeSave: 'select public.hotel_room_type_save($1, $2, $3, $4, $5) as r',
  roomTypeRemove: 'select public.hotel_room_type_remove($1, $2, $3) as r',
  contractSave: 'select public.rate_contract_save($1, $2, $3::jsonb, $4) as r',
  linesSet: 'select public.rate_contract_lines_set($1, $2, $3::jsonb, $4::jsonb, $5) as r',
  contractSubmit: 'select public.rate_contract_submit($1, $2, $3) as r',
  contractDecide: 'select public.rate_contract_decide($1, $2, $3, $4, $5) as r',
  contractEnd: 'select public.rate_contract_end($1, $2, $3, $4) as r',
  price: 'select authz.rate_contract_price($1, $2, $3, $4, $5, $6::date, $7::date, $8) as r',
  contractsList: 'select public.rate_contracts_list($1::jsonb, $2, $3) as r',
  contractGet: 'select public.rate_contract_get($1) as r',
  lookup: 'select public.rate_contract_lookup($1, $2, $3, $4, $5) as r',
  expiry: 'select authz.rate_contract_expiry() as r',
  quoteAdd: 'select public.purchase_quote_add($1, $2, $3::jsonb) as r',
  hotelLink: 'select public.supplier_hotel_link($1, $2, $3) as r',
  managerApprovals: 'select public.manager_approvals() as r',
  importStage: 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7, $8) as r',
  importValidate: 'select public.import_batch_validate($1) as r',
  importApply: 'select public.import_batch_apply($1, $2, $3, $4, $5::jsonb) as r',
  importGet: 'select public.import_batch_get($1, $2, $3) as r',
  // G 10.1-10.5
  approveOverBudget: 'select public.purchase_cost_approve_over_budget($1, $2) as r',
  costApproved: 'select authz.cost_version_approved($1, $2) as r',
  procurementIssues: 'select authz.procurement_issues($1) as r',
  taskCurrentVersion: 'select authz.task_current_version($1) as r',
  goAheadValid: 'select authz.purchase_go_ahead_valid($1) as r',
  setChanges: 'select public.admin_set_booking_changes_enabled($1, $2) as r',
  crCreate: 'select public.booking_change_request_create($1, $2::jsonb, $3) as r',
  crResubmit: 'select public.booking_change_request_resubmit($1, $2, $3::jsonb, $4) as r',
  crWithdraw: 'select public.booking_change_request_withdraw($1, $2, $3, $4) as r',
  crDecide: 'select public.booking_change_request_decide($1, $2, $3, $4, $5) as r',
  crOpen: 'select public.booking_change_open_version($1, $2) as r',
  crSubmit: 'select public.booking_change_submit($1, $2, $3::uuid[], $4) as r',
  reconfirmRecord: 'select public.task_reconfirm_record($1, $2, $3::jsonb, $4) as r',
  reconfirmApprove: 'select public.task_reconfirm_approve_over_budget($1, $2, $3) as r',
  reconfirmRefuse: 'select public.task_reconfirm_refuse($1, $2, $3, $4) as r',
  changeOpen: 'select authz.deal_change_open($1) as r',
  tripCancelled: 'select authz.deal_trip_cancelled($1) as r',
  dealCommitted: 'select authz.deal_committed($1) as r',
  dealChanges: 'select public.deal_change_requests($1) as r',
  changesList: 'select public.change_requests_list($1::jsonb, $2, $3) as r',
  reconfirmGet: 'select public.task_reconfirmation_get($1) as r',
  changeHistory: 'select public.deal_change_history($1) as r',
  // H 11
  setServiceChanges: 'select public.admin_set_service_changes_enabled($1, $2) as r',
  removalCharges: 'select public.service_removal_charges($1) as r',
  itemAdd: 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
  itemRemove: 'select public.service_item_remove($1, $2, $3) as r',
  itemSave: 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
  purchaseCharge: 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r',
  purchaseTaskList: 'select public.purchase_task_list() as r',
  purchaseHome: 'select public.purchase_home_counts() as r',
  flightHome: 'select public.flight_home_counts() as r',
  visaHome: 'select public.visa_home_counts() as r',
  // Existing commands used to build scenarios
  bookingConfirm: 'select public.booking_confirm($1, $2) as r',
  openRevision: 'select public.booking_open_revision($1) as r',
  dealDues: 'select public.deal_dues($1) as r',
  refundsDue: 'select public.supplier_refunds_due($1::jsonb, $2, $3) as r',
  refundCreate: 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r',
  inbox: 'select public.notice_inbox($1::bigint, $2) as r',
} as const;

export const MEAL_PLANS = ['EP', 'CP', 'MAP', 'AP', 'AI'] as const;
export const NEW_SELLING = '8123457';

/**
 * Stay of the HOTEL fixture item: check-in 2026-12-10 (Thursday), check-out
 * 2026-12-13, 2 rooms -> nights Thu 10, Fri 11, Sat 12 (LD21: weekend = Friday
 * and Saturday nights).
 */
export const STAY = { checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 2 } as const;

export type Contract = { contractId: string; rowVersion: number; contractNo?: string; status?: string };
export type ChangeRequest = { changeRequestId: string; refNo?: string; status: string; rowVersion: number; outcome?: string };
export type Price = { state: string; contractIds: string[]; nights: Array<{ date: string; ratePaise: string; lineId: string; weekend: boolean }>;
  perRoomTotalPaise: string | null; totalPaise: string | null; endedOn: string | null };

/** Id of a returned object under any of the given keys (return shapes are not frozen for creates). */
export function idOf(r: unknown, ...keys: string[]): string {
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  throw new Error(`no id among ${keys.join(', ')} in ${JSON.stringify(r)}`);
}

export function relbHelpers(getDb: () => TestDb) {
  const h = acc3Helpers(getDb);
  const db = () => getDb();
  const { one, owner } = h;

  /** Refusal with the section-13 SQLSTATE of `token` (or `code`), optional hint; returns the hint. */
  const refusedToken = (actor: Actor, sql: string, params: unknown[], token: string, hint?: RegExp, code?: string) =>
    h.refusedHint(actor, sql, params, token, hint, code ?? TOKENS[token]);
  /** A read's value, or null when refused with an authorization error (the fence). */
  async function readOrNull<T>(actor: Actor, sql: string, params: unknown[]): Promise<T | null> {
    const r = await h.attempt<T>(actor, sql, params);
    if (!r.ok) {
      expect(r.code, `${sql}: ${r.error}`).toMatch(/^(42501|28000)$/);
      return null;
    }
    return r.value;
  }

  // -------------------------------------------------------------------------
  // E — rate contracts
  // -------------------------------------------------------------------------
  const rateContractsOn = async (on = true) => one(SUPER, SQLB.setRateContracts, [on, REASON]);
  /** An active catalogue hotel (owner SQL, SYNTHETIC FIXTURE STEP). */
  async function catalogueHotel(name = `Synthetic Catalogue Hotel ${rid().slice(0, 6)}`, sourceRef: string | null = null): Promise<string> {
    await resetActor(db());
    const [row] = await owner<{ id: string }>(
      `insert into public.hotel_catalogue (legal_entity_id, name, city, source_ref, created_by, updated_by)
       values ($1, $2, 'Synthetic City', $3, $4, $4) returning id`,
      [await h.entityId(), name, sourceRef, U.adminJodhpur]);
    return row!.id;
  }
  /** Supplier selling hotels (approved bank) linked to `hotel`. */
  async function hotelSupplier(hotel: string): Promise<string> {
    const s = await h.purchaseSupplier();
    await one(PURCHASE, SQLB.hotelLink, [s, hotel, rid()]);
    return s;
  }
  /** E2: new room type. ASSUMPTION: a new type passes p_room_type_id null and p_expected_row_version 0; the answer names `roomTypeId`. */
  async function roomType(hotel: string, name = 'Synthetic Deluxe', actor: Actor = PURCHASE): Promise<string> {
    return idOf(await one(actor, SQLB.roomTypeSave, [hotel, null, 0, name, rid()]), 'roomTypeId', 'id');
  }
  /**
   * E3: a new draft contract. ASSUMPTION: p_fields keys are the camelCase of
   * the 9.1 columns (supplierId, hotelId, validFrom, validTo, cancellationTerms,
   * note); a new contract passes p_contract_id null and row version 0; the
   * answer names `contractId` and `rowVersion`.
   */
  async function draftContract(supplier: string, hotel: string, validFrom = '2026-11-01', validTo = '2027-03-31',
    actor: Actor = PURCHASE): Promise<Contract> {
    const r = await one<Record<string, unknown>>(actor, SQLB.contractSave, [null, 0, JSON.stringify({ supplierId: supplier, hotelId: hotel,
      validFrom, validTo, cancellationTerms: 'Synthetic terms: free cancellation up to 7 days', note: null }), rid()]);
    return { contractId: idOf(r, 'contractId', 'id'), rowVersion: Number(r.rowVersion ?? 1), contractNo: r.contractNo as string | undefined };
  }
  const contractRow = async (id: string) => (await owner<Record<string, unknown> & { row_version: number; status: string; contract_no: string;
    version_no: number; end_reason: string | null }>('select * from public.rate_contracts where id = $1', [id]))[0]!;
  /** ASSUMPTION: line keys are the camelCase of 9.1's columns; meal plan key `mealPlan` (code); blackouts `{fromDate, toDate}`. */
  type Line = { seasonFrom: string; seasonTo: string; roomTypeId: string; mealPlan: string; ratePaise: string; weekendRatePaise?: string | null;
    extraAdultPaise?: string | null; childWithBedPaise?: string | null; childWithoutBedPaise?: string | null; note?: string | null };
  const line = (roomTypeId: string, over: Partial<Line> = {}): Line => ({ seasonFrom: '2026-11-01', seasonTo: '2027-03-31', roomTypeId, mealPlan: 'CP',
    ratePaise: '500000', weekendRatePaise: null, extraAdultPaise: null, childWithBedPaise: null, childWithoutBedPaise: null, note: null, ...over });
  async function setLines(contract: string, lines: Line[], blackouts: Array<{ fromDate: string; toDate: string }> = [], actor: Actor = PURCHASE) {
    return one<Record<string, unknown>>(actor, SQLB.linesSet, [contract, (await contractRow(contract)).row_version, JSON.stringify(lines),
      JSON.stringify(blackouts), rid()]);
  }
  const submit = async (contract: string, actor: Actor = PURCHASE) =>
    one<Record<string, unknown>>(actor, SQLB.contractSubmit, [contract, (await contractRow(contract)).row_version, rid()]);
  const decideContract = async (contract: string, decision: 'approve' | 'return', actor: Actor = MANAGER, reason: string | null = null) =>
    one<Record<string, unknown>>(actor, SQLB.contractDecide, [contract, decision, reason, (await contractRow(contract)).row_version, rid()]);
  /** Draft -> lines -> submitted -> approved by MANAGER. */
  async function activeContract(supplier: string, hotel: string, lines: Line[], opts: { validFrom?: string; validTo?: string;
    blackouts?: Array<{ fromDate: string; toDate: string }> } = {}): Promise<string> {
    const c = await draftContract(supplier, hotel, opts.validFrom, opts.validTo);
    await setLines(c.contractId, lines, opts.blackouts ?? []);
    await submit(c.contractId);
    await decideContract(c.contractId, 'approve');
    expect((await contractRow(c.contractId)).status).toBe('active');
    return c.contractId;
  }
  /** authz.rate_contract_price as the owner (stable internal function). */
  async function price(supplier: string, hotel: string, roomTypeId: string, meal: string, checkIn: string = STAY.checkIn,
    checkOut: string = STAY.checkOut, rooms: number = STAY.rooms): Promise<Price> {
    await resetActor(db());
    return (await owner<{ r: Price }>(SQLB.price, [await h.entityId(), supplier, hotel, roomTypeId, meal, checkIn, checkOut, rooms]))[0]!.r;
  }

  // -------------------------------------------------------------------------
  // G — change after a supplier confirmed
  // -------------------------------------------------------------------------
  const changesOn = async (on = true) => one(SUPER, SQLB.setChanges, [on, REASON]);
  const serviceChangesOn = async (on = true) => one(SUPER, SQLB.setServiceChanges, [on, REASON]);
  /**
   * Committed Deal: hotel (+ `extra` items) booked on DEAL, real Accounts
   * approval (billing verified), the hotel task supplier-confirmed by PURCHASE
   * (cost 1,00,000.00 within the 2,00,000.00 budget), people active, the change
   * switch On.
   */
  async function committedDeal(extra: Item[] = [TRANSFER_ITEM], opts: { changes?: boolean; selling?: string } = {}) {
    await h.people();
    const b = await h.book([HOTEL_ITEM, ...extra], opts.selling ? { selling: opts.selling } : {});
    await h.approveReal(b.versionId);
    const hotelTask = h.taskOf(b, 'hotel');
    const supplierId = await h.supplierConfirmed(hotelTask);
    if (opts.changes ?? true) await changesOn();
    return { b, hotelTask, supplierId, hotelItem: b.itemIds[0]! };
  }
  const crRow = async (id: string) => (await owner<Record<string, unknown> & { row_version: number; status: string; change_version_id: string | null;
    ref_no: string; removal_route: string | null; item_ids: string[] }>('select * from public.booking_change_requests where id = $1', [id]))[0]!;
  /**
   * G2. ASSUMPTION: the answer names `changeRequestId` (or `id`), `status`
   * and `rowVersion`.
   */
  async function requestChange(fields: { kind?: string; itemIds?: string[]; changeSummary?: string; reason?: string; customerChargePaise?: string },
    actor: Actor = OWNER, deal: string = DEAL, requestId: string = rid()): Promise<ChangeRequest> {
    const r = await one<Record<string, unknown>>(actor, SQLB.crCreate, [deal, JSON.stringify({ kind: 'change',
      changeSummary: 'Synthetic change: room type to suite', reason: REASON, itemIds: [], ...fields }), requestId]);
    const id = idOf(r, 'changeRequestId', 'id');
    const row = await crRow(id);
    return { changeRequestId: id, refNo: row.ref_no, status: row.status, rowVersion: row.row_version, outcome: r.outcome as string | undefined };
  }
  const decideChange = async (id: string, decision: 'approve' | 'return', actor: Actor = MANAGER, reason: string | null = decision === 'return' ? REASON : null) =>
    one<Record<string, unknown>>(actor, SQLB.crDecide, [id, decision, reason, (await crRow(id)).row_version, rid()]);
  /** G5: `{versionId, rowVersion}`. */
  const openChange = (id: string, actor: Actor = OWNER) => one<{ versionId: string; rowVersion: number; outcome?: string }>(actor, SQLB.crOpen, [id, rid()]);
  /** Edits the hotel item of the change version (room type to a suite); returns the version row version. */
  async function editHotel(itemId: string, versionId: string, rowVersion: number, facts: Record<string, unknown> = { roomType: 'Synthetic Suite' },
    budget = '20000000', actor: Actor = OWNER): Promise<number> {
    return (await one<{ rowVersion: number }>(actor, SQLB.itemSave, [itemId, versionId, rowVersion, JSON.stringify({ ...HOTEL, ...facts }), budget])).rowVersion;
  }
  /** New selling total and a one-line plan on a draft version. */
  async function newTotal(versionId: string, rowVersion: number, selling: string = NEW_SELLING, actor: Actor = OWNER): Promise<number> {
    let rv = (await h.saveSelling(actor, versionId, rowVersion, selling)).rowVersion;
    rv = (await h.savePlan(actor, versionId, rv, [{ seq: 1, label: 'Full payment', amountPaise: selling, dueDate: dayFrom(20) }])).rowVersion;
    return rv;
  }
  /** G6 with the change version's current content hash (from booking_readiness). */
  async function submitChange(id: string, changedItemIds: string[], actor: Actor = OWNER, requestId: string = rid()) {
    const row = await crRow(id);
    const ready = await h.readiness(actor, row.change_version_id!);
    return one<Record<string, unknown>>(actor, SQLB.crSubmit, [id, ready.contentHash, changedItemIds, requestId]);
  }
  /** Addendum O2: open the change version, change the hotel's room type and the total, send it to the Manager. */
  async function sendChange(id: string, hotelItem: string, actor: Actor = OWNER) {
    const v = await openChange(id, actor);
    const rv = await editHotel(hotelItem, v.versionId, v.rowVersion, { roomType: 'Synthetic Suite' }, '20000000', actor);
    await newTotal(v.versionId, rv, NEW_SELLING, actor);
    await submitChange(id, [hotelItem], actor);
    return v;
  }
  /** Request -> change version with the hotel's room type changed (and the total) -> sent -> Manager approval (Addendum O2). */
  async function submittedChange(hotelItem: string, opts: { itemIds?: string[]; selling?: string | null; edit?: (versionId: string, rv: number) => Promise<number> } = {}) {
    const cr = await requestChange({ itemIds: opts.itemIds ?? [hotelItem] });
    const v = await openChange(cr.changeRequestId);
    const rv = opts.edit ? await opts.edit(v.versionId, v.rowVersion) : await editHotel(hotelItem, v.versionId, v.rowVersion);
    if (opts.selling !== null) await newTotal(v.versionId, rv, opts.selling ?? NEW_SELLING);
    await submitChange(cr.changeRequestId, opts.itemIds ?? [hotelItem]);
    // Addendum O2: the Manager approves exactly the version sent; reconfirmations start then.
    const submitted = await decideChange(cr.changeRequestId, 'approve');
    return { cr, versionId: v.versionId, submitted };
  }
  type Reconf = Record<string, unknown> & { id: string; status: string; row_version: number; over_budget: boolean; task_id: string;
    new_rate_paise: string | null; supplier_fee_paise: string | null; recorded_by: string | null };
  const reconfirmations = (crId: string) => owner<Reconf>(
    `select *, new_rate_paise::text as new_rate_paise, supplier_fee_paise::text as supplier_fee_paise
     from public.task_reconfirmations where change_request_id = $1 order by task_id`, [crId]);
  /**
   * Stored supplier confirmation proof on a supplier-confirmed task.
   * ASSUMPTION / CONTRACT GAP: 10.2 requires the reconfirmation proof to be a
   * `supplier_confirmation` purchase_evidence row uploaded after the approval,
   * but only 5.6 (customer_voucher) names an exception to the guard that
   * freezes a confirmed task's evidence; the test uses the existing
   * purchase_evidence_begin / _finish path for it.
   */
  async function reconfirmProof(taskId: string, actor: Actor = PURCHASE): Promise<string> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(actor, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
      [taskId, 'supplier_confirmation', 'reconfirmation.pdf', 'application/pdf', 2048, sha()]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    await one(actor, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
    return ev.evidenceId;
  }
  /** G7. */
  async function recordReconfirm(reconfId: string, taskId: string, fields: { newRatePaise: string; supplierFeePaise?: string; newReference?: string },
    actor: Actor = PURCHASE) {
    const evidenceId = await reconfirmProof(taskId, actor);
    const [r] = await owner<{ row_version: number }>('select row_version from public.task_reconfirmations where id = $1', [reconfId]);
    return one<Record<string, unknown>>(actor, SQLB.reconfirmRecord, [reconfId, r!.row_version, JSON.stringify({ supplierFeePaise: '0',
      newReference: 'SYN-CONF-0002', note: null, ...fields, evidenceId }), rid()]);
  }
  /** Highest cost version number of a task (after a supplier confirmation the committed copy is version + 1). */
  const latestCostVersion = async (taskId: string) =>
    (await owner<{ v: number }>('select max(version_no)::int as v from public.purchase_cost_versions where task_id = $1', [taskId]))[0]!.v;
  /**
   * The agreed cost version: the latest `proposed` version (Phase 1: a committed row is a copy; sm_payment_create and the
   * over-budget approval always name the agreed proposed version — Addendum L7).
   */
  const agreedCostVersion = async (taskId: string) =>
    (await owner<{ v: number }>(`select max(version_no)::int as v from public.purchase_cost_versions where task_id = $1 and stage = 'proposed'`,
      [taskId]))[0]!.v;
  /** Supplier payment request (deposit) against the task's agreed cost version. */
  const payRequest = async (taskId: string, amount: number) => h.purchaseRequest(taskId, amount, { expectedCostVersionNo: await agreedCostVersion(taskId) });
  const reconfRv = async (id: string) => (await owner<{ v: number }>('select row_version as v from public.task_reconfirmations where id = $1', [id]))[0]!.v;

  /** Snapshot of everything "supplier refuses -> nothing changed" compares (16.1 G). */
  async function snapshot(taskId: string, deal: string = DEAL) {
    await resetActor(db());
    const task = await owner(`select status, supplier_reference, supplier_confirmed_by, supplier_confirmed_at::text, assignee_user_id, updated_at::text
      from public.fulfilment_tasks where id = $1`, [taskId]);
    const costs = await owner(`select version_no, stage, amount_paise::text, quote_id from public.purchase_cost_versions where task_id = $1 order by version_no`,
      [taskId]);
    const confirmations = await owner(`select confirmation_no, supplier_reference, amount_paise::text from public.task_confirmations where task_id = $1
      order by confirmation_no`, [taskId]);
    const versions = await owner(`select id, status from public.booking_versions where deal_id = $1 and status in ('confirmed', 'superseded') order by version_no`,
      [deal]);
    const dues = await one<Record<string, unknown>>(ACC, SQLB.dealDues, [deal]);
    await resetActor(db());
    const docs = await owner(`select id, kind, status, number from public.customer_documents where deal_id = $1 order by created_at, id`, [deal]);
    return { task, costs, confirmations, versions, dues, docs };
  }

  // -------------------------------------------------------------------------
  // Shared reads
  // -------------------------------------------------------------------------
  const taskRow = async (id: string) => (await owner<Record<string, unknown> & { status: string; closed_state: string | null;
    closed_change_request_id: string | null }>('select * from public.fulfilment_tasks where id = $1', [id]))[0]!;
  const itemRow = async (id: string) => (await owner<{ state: string }>('select state from public.service_items where id = $1', [id]))[0]!;
  /** Notice rows of `kind` (owner read). */
  const noticesOf = (kind: string) => h.notices(kind);

  return {
    ...h, refusedToken, readOrNull, rateContractsOn, catalogueHotel, hotelSupplier, roomType, draftContract, contractRow, line, setLines, submit,
    decideContract, activeContract, price, changesOn, serviceChangesOn, committedDeal, crRow, requestChange, decideChange, openChange, editHotel,
    newTotal, submitChange, sendChange, submittedChange, reconfirmations, reconfirmProof, recordReconfirm, reconfRv, latestCostVersion, agreedCostVersion, payRequest, snapshot, taskRow, itemRow, noticesOf,
  };
}
