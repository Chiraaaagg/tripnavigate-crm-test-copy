import { expect } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  expectDbError,
  istBusinessDate,
  resetActor,
  setActor,
} from '../helpers/db';
import { HOTEL, TRAVELLERS, b1Helpers } from './b1-support';
import { b11Helpers } from './b11-support';
import { BILL_TO, formHelpers, line } from './booking-form-support';

/**
 * Flight department build (contract flight-contract.md, frozen 4 Nov 2026),
 * Track D: shared scenario helpers for the flight-*.test.ts suites. Written
 * from the contract (sections 4-9 and 12), NOT from the Track A/B code: every
 * command below is called with the positional signature the contract freezes.
 *
 * Every scenario runs inside ONE rolled-back owner transaction (asOwner) and
 * impersonates a request only for the statement under test, exactly like the
 * Purchase suites (tests/helpers/db.ts).
 *
 * Synthetic actors (supabase/fixtures, all @example.test). The fixtures have
 * no dedicated Flight person, Jodhpur Manager or second Accounts person, so
 * the suites give existing synthetic users an extra membership inside the
 * rolled-back transaction, as the Purchase and B1 suites already do:
 *   OWNER      Sales Delhi A        Sales owner of SYN-DEL-001 (Delhi)
 *   SALES_B    Sales Delhi B        other Sales (owns SYN-DEL-002)
 *   MANAGER    Manager Delhi        branch Manager of the Delhi Deals
 *   MANAGER_AMD Manager Ahmedabad   same entity, other branch
 *   PURCHASE   Purchase Jodhpur
 *   VISA       Visa Jodhpur         (pure Visa: never given another role in fence tests)
 *   ACC        Accounts Jodhpur
 *   ACC2       Visa Jodhpur + Accounts membership (second Accounts person; payment suites only)
 *   FLIGHT     Moved Staff + Flight membership (its fixture Sales membership is inactive)
 *   FLIGHT_2   Sales Ahmedabad + Flight membership (second Flight person)
 *   SUPER      Admin Jodhpur (super_admin)
 */

export const OWNER: Actor = { userId: U.salesDelhiA };
export const SALES_B: Actor = { userId: U.salesDelhiB };
export const MANAGER: Actor = { userId: U.managerDelhi };
export const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
export const PURCHASE: Actor = { userId: U.purchaseJodhpur };
export const VISA: Actor = { userId: U.visaJodhpur };
export const ACC: Actor = { userId: U.accountsJodhpur };
export const ACC2: Actor = { userId: U.visaJodhpur };
export const FLIGHT: Actor = { userId: U.movedStaff };
export const FLIGHT_2: Actor = { userId: U.salesAhmedabad };
export const SUPER: Actor = { userId: U.adminJodhpur };
export const ANON: Actor = { userId: null };
export const SVC: Actor = { userId: null, role: 'service_role' };
export const DEAL = D.del001;
export const DEAL2 = D.del002;
export const DEAL_B = D.b001;

export const rid = () => crypto.randomUUID();
export const LIMIT = 5_000_000;
export const SELLING = '45678901'; // distinctive selling total: a leak in any flight read
export const FIXTURE_COMMERCIALS = ['12345600', '1111100'];

// ---------------------------------------------------------------------------
// Contract signatures (section 6 / 9), positional, in contract order.
// ---------------------------------------------------------------------------
export const SQL = {
  // A1-A12
  groupClaim: 'select public.flight_group_claim($1, $2) as r',
  taskClaim: 'select public.flight_task_claim($1) as r',
  groupReassign: 'select public.flight_group_reassign($1, $2, $3, $4, $5) as r',
  purchaseReassign: 'select public.purchase_task_reassign($1, $2, $3) as r',
  changeApply: 'select public.flight_booking_change_apply($1, $2, $3, $4) as r',
  screenshotSave: 'select public.flight_screenshot_sectors_save($1, $2, $3::jsonb, $4) as r',
  fillBlanks: 'select public.flight_sector_fill_blanks($1, $2, $3::jsonb, $4) as r',
  changeSubmit: 'select public.flight_change_submit($1, $2::jsonb, $3) as r',
  changeDecide: 'select public.flight_change_decide($1, $2, $3, $4, $5) as r',
  changeWithdraw: 'select public.flight_change_withdraw($1, $2, $3) as r',
  changeAck: 'select public.flight_change_acknowledge($1) as r',
  ticketCorrect: 'select public.flight_ticket_correct($1, $2, $3, $4::jsonb, $5, $6) as r',
  groupComplete: 'select public.flight_group_complete($1, $2::uuid[], $3) as r',
  evBegin: 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
  evFinish: 'select public.department_evidence_finish($1, $2) as r',
  evDownload: 'select public.department_evidence_authorize_download($1) as r',
  // A reads
  queue: 'select public.flight_queue() as r',
  workspace: 'select public.flight_workspace($1) as r',
  dealSummary: 'select public.deal_flight_summary($1) as r',
  dealHistory: 'select public.deal_flight_history($1) as r',
  homeCounts: 'select public.flight_home_counts() as r',
  taskHistory: 'select public.department_task_history($1) as r',
  // B1-B13
  supplierList: 'select public.flight_supplier_list() as r',
  supplierCreate: 'select public.flight_supplier_create($1::jsonb, $2) as r',
  supplierBeneficiary: 'select public.flight_supplier_add_beneficiary($1, $2, $3::jsonb) as r',
  supplierApproveBeneficiary: 'select public.supplier_approve_beneficiary($1, $2) as r',
  farePreview: 'select public.flight_fare_preview($1, $2::jsonb) as r',
  fareApprovalRequest: 'select public.flight_fare_approval_request($1, $2::jsonb, $3) as r',
  fareApprovalDecide: 'select public.flight_fare_approval_decide($1, $2, $3, $4, $5) as r',
  fareApprovalWithdraw: 'select public.flight_fare_approval_withdraw($1, $2, $3) as r',
  ticketsConfirm: 'select public.flight_tickets_confirm($1, $2::jsonb, $3) as r',
  directPayment: 'select public.flight_direct_payment_save($1, $2, $3::jsonb, $4) as r',
  paymentRequest: 'select public.flight_payment_request_create($1, $2::jsonb, $3) as r',
  money: 'select public.flight_money($1) as r',
  paymentContext: 'select public.flight_payment_context($1) as r',
  // Existing commands and reads the flight build widens
  costSave: 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r',
  costSubmit: 'select public.department_cost_submit($1, $2) as r',
  expenseAccept: 'select public.expense_record_accept($1, $2, $3) as r',
  expenseReturn: 'select public.expense_record_return($1, $2, $3, $4) as r',
  expenseList: 'select public.accounts_expense_records($1, $2, $3) as r',
  paymentDecide: 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
  paymentRecord: 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
  paymentVerify: 'select public.supplier_payment_verify($1, $2, $3) as r',
  fundingDecide: 'select public.company_funding_decide($1, $2, $3, $4, $5) as r',
  smEvidenceBegin: 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
  smEvidenceFinish: 'select public.supplier_money_evidence_finish($1, $2) as r',
  supplierDocUpload: 'select public.supplier_document_upload($1, $2::jsonb, $3) as r',
  managerApprovals: 'select public.manager_approvals() as r',
  smHomeCounts: 'select public.supplier_money_home_counts() as r',
  accountsPayments: 'select public.accounts_supplier_payments($1) as r',
  accountsDocuments: 'select public.accounts_supplier_documents($1) as r',
  myWorkCounts: 'select public.my_work_counts() as r',
  cancelOpen: 'select public.deal_cancellation_open($1, $2, $3) as r',
  // Booking revision path
  reviewReturn: 'select public.accounts_review_return($1, $2, $3) as r',
  openRevision: 'select public.booking_open_revision($1) as r',
  classify: 'select public.booking_classify_revision($1, $2, $3) as r',
  saveItem: 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
  participants: 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
  fileBegin: 'select public.service_item_file_begin($1, $2, $3, $4::jsonb, $5) as r',
  fileFinish: 'select public.service_item_file_finish($1, $2) as r',
  // Deprecated (A13) and legacy reads
  legacyList: 'select public.flight_task_list() as r',
  legacyGet: 'select public.flight_task_get($1) as r',
} as const;

// ---------------------------------------------------------------------------
// Synthetic flight facts (BF2 shape, authz.validate_service_facts('flight'))
// ---------------------------------------------------------------------------
export type Leg = {
  from: string; to: string; date: string; airline?: string | null; flightNo?: string | null;
  departTime?: string | null; arriveTime?: string | null; arrivalDate?: string | null;
};
export const LEG_JDH_DEL: Leg = { from: 'JDH', to: 'DEL', date: '2026-12-10', airline: 'Air India', flightNo: 'AI 470', departTime: '10:35', arriveTime: '11:50' };
export const LEG_DEL_GOI: Leg = { from: 'DEL', to: 'GOI', date: '2026-12-10', airline: 'Air India', flightNo: 'AI 883', departTime: '14:00', arriveTime: '16:35' };
export const LEG_GOI_JDH: Leg = { from: 'GOI', to: 'JDH', date: '2026-12-15', airline: 'IndiGo', flightNo: '6E 211', departTime: '09:05', arriveTime: '11:40' };
/** A booked leg with blanks (no airline, flight number or times): Flight may fill them (A5). */
export const LEG_BLANK: Leg = { from: 'DEL', to: 'BOM', date: '2026-12-11' };

export const typedFlight = (legs: Leg[], passengers = 4, extra: Record<string, unknown> = {}) => ({
  entryMode: 'typed', segments: legs, passengers, preferredTime: null, cabin: 'Economy', notes: null, ...extra,
});
export const screenshotFlight = (passengers = 4) => ({
  entryMode: 'screenshot', segments: [], passengers, cabin: 'Economy', screenshotNote: 'Synthetic: return flight from the fare screenshot',
});

/** Sector rows for A4/A6 (Flight-entered). */
export const sectorInput = (s: Partial<{ sectorId: string | null; from: string; to: string; departDate: string; departTime: string;
  arriveDate: string | null; arriveTime: string; flightNo: string; airline: string; cabin: string }> = {}) => ({
  sectorId: null, from: 'GOI', to: 'JDH', departDate: '2026-12-15', departTime: '09:05', arriveDate: null, arriveTime: '11:40',
  flightNo: '6E 211', airline: 'IndiGo', cabin: 'Economy', ...s,
});
export const changeSector = (s: Partial<{ from: string; to: string; departDate: string; departTime: string; arriveDate: string | null;
  arriveTime: string; flightNo: string; airline: string; cabin: string }> = {}) => {
  const { sectorId, ...rest } = sectorInput(s as Record<string, string>);
  void sectorId;
  return rest;
};

// ---------------------------------------------------------------------------
// Ticket and fare input (B8)
// ---------------------------------------------------------------------------
let ticketSeq = 0;
/** A fresh, valid synthetic ticket number (13 digits with one dash). */
export function nextTicket(prefix = '098'): string {
  ticketSeq += 1;
  return `${prefix}-${String(2410394500 + ticketSeq).padStart(10, '0')}`;
}
let pnrSeq = 0;
/** A fresh 6-character PNR (letters and digits, upper case). */
export function nextPnr(): string {
  pnrSeq += 1;
  return `Q${String(pnrSeq).padStart(3, '0')}X${'ABCDEFGHJK'[pnrSeq % 10]}`;
}

export type FareIn = { paxType: 'adult' | 'child' | 'infant'; basicPaise: string; kPaise: string; yqPaise: string; yrPaise: string; otherPaise: string;
  markupPaise?: string; discountPaise?: string };
/** Supplier cost per person 6,000.00 (basic 5,000 + K 500 + YQ 300 + YR 100 + other 100). */
export const fare = (paxType: FareIn['paxType'], over: Partial<FareIn> = {}): FareIn => ({
  paxType, basicPaise: '500000', kPaise: '50000', yqPaise: '30000', yrPaise: '10000', otherPaise: '10000', ...over,
});
export const SUPPLIER_PER_PERSON = 600_000;

export type TravellerTicket = { seq: number; crsType: string; crsPnr: string | null; airlinePnr: string; ticketNumber: string };
export const ticketFor = (seq: number, over: Partial<TravellerTicket> = {}): TravellerTicket => ({
  seq, crsType: 'amadeus', crsPnr: nextPnr(), airlinePnr: nextPnr(), ticketNumber: nextTicket(), ...over,
});

export const confirmFields = (f: { sectorIds: string[]; supplierId: string; fareApprovalId?: string | null; fares: FareIn[];
  travellers: TravellerTicket[] }) => JSON.stringify({ fareApprovalId: null, ...f });

// ---------------------------------------------------------------------------
// Scanning JSON for leaked values
// ---------------------------------------------------------------------------
export function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}
/** True when `text` contains `value` as a standalone token (not part of a longer number). */
export const containsToken = (text: string, value: string) => new RegExp(`(?<![0-9A-Za-z])${value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9A-Za-z])`).test(text);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export type FlightItem = { type: string; facts: unknown; budget?: string | null; participants?: number[] };
export type Booked = {
  versionId: string;
  rowVersion: number;
  itemIds: string[];
  /** Flight item ids in item order. */
  flightItems: string[];
  /** Flight task ids in item order. */
  flightTasks: string[];
  allTasks: string[];
};

export function flightHelpers(getDb: () => TestDb) {
  const h = b11Helpers(getDb);
  const fh = formHelpers(getDb);
  const db = () => getDb();
  const { one, owner, run } = h;

  /** Refusal whose message is exactly the token (and SQLSTATE when given). */
  async function refused(actor: Actor, sql: string, params: unknown[], token: string, code?: string): Promise<void> {
    await expectDbError(db(), () => run(actor, sql, params), { message: new RegExp(`^${token}$`), ...(code ? { code } : {}) });
  }
  /** Refusal with message, code and hint (regex); returns the hint. */
  async function refusedHint(actor: Actor, sql: string, params: unknown[], token: string, hint?: RegExp): Promise<string> {
    await db().exec('savepoint flight_hint');
    let error: { code?: string; message?: string; hint?: string } | undefined;
    try {
      await run(actor, sql, params);
    } catch (e) {
      error = e as { code?: string; message?: string; hint?: string };
      await db().exec('rollback to savepoint flight_hint');
    }
    if (error === undefined) throw new Error(`expected ${token}, but the statement succeeded`);
    expect(error.message, `hint: ${error.hint ?? ''}`).toBe(token);
    if (hint) expect(error.hint ?? '').toMatch(hint);
    return error.hint ?? '';
  }

  /** Runs a statement inside a savepoint: the value, or the error message (the transaction stays usable). */
  async function attempt<T = unknown>(actor: Actor, sql: string, params: unknown[] = []): Promise<{ ok: true; value: T } | { ok: false; error: string; code?: string }> {
    await db().exec('savepoint flight_attempt');
    try {
      const value = await one<T>(actor, sql, params);
      await db().exec('release savepoint flight_attempt');
      return { ok: true, value };
    } catch (e) {
      await db().exec('rollback to savepoint flight_attempt');
      await resetActor(db());
      return { ok: false, error: (e as Error).message, code: (e as { code?: string }).code };
    }
  }

  async function addRole(user: string, role: string, branch = 'JDH'): Promise<void> {
    await resetActor(db());
    await owner(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active'
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $3
       on conflict do nothing`,
      [user, role, branch],
    );
    await owner(`update public.staff_profiles set status = 'active' where user_id = $1 and status <> 'active'`, [user]);
  }
  /** FLIGHT and FLIGHT_2 get their Flight memberships. */
  async function addFlightPeople(): Promise<void> {
    await addRole(U.movedStaff, 'flight');
    await addRole(U.salesAhmedabad, 'flight');
  }
  const addSecondAccounts = () => addRole(U.visaJodhpur, 'accounts');

  /**
   * Confirms a booking on `deal` owned by `actor` with the given items (each
   * with facts, budget, participants), the B1.1 steps, ID proofs, the
   * acceptance proof and a stored screenshot for every screenshot flight.
   */
  async function confirmBooking(opts: {
    actor?: Actor; deal?: string; items: FlightItem[]; travellers?: unknown; scope?: 'domestic' | 'international';
  }): Promise<Booked> {
    const actor = opts.actor ?? OWNER;
    const deal = opts.deal ?? DEAL;
    await h.setSwitch('service_items_enabled', true);
    const opened = await h.openDraft(actor, deal);
    let rv = opened.rowVersion;
    const itemIds: string[] = [];
    for (const item of opts.items) {
      const added = await h.addItem(actor, opened.versionId, rv, item.type, item.facts, item.budget === undefined ? '2800000' : item.budget);
      rv = added.rowVersion;
      itemIds.push(added.itemId);
    }
    rv = (await h.saveTravellers(actor, deal, rv, opts.travellers ?? TRAVELLERS)).rowVersion;
    rv = (await h.saveSelling(actor, opened.versionId, rv, SELLING)).rowVersion;
    rv = await h.completeB11(actor, deal, opened.versionId, rv, SELLING);
    for (const [i, item] of opts.items.entries()) {
      if (item.participants) {
        rv = (await one<{ rowVersion: number }>(actor, SQL.participants, [itemIds[i], opened.versionId, rv, item.participants])).rowVersion;
      }
    }
    if (opts.scope === 'international') {
      rv = (await h.saveTrip(actor, opened.versionId, rv, { destination: 'Synthetic City, Thailand', scope: 'international', start: '2026-12-10', end: '2026-12-15' })).rowVersion;
    }
    for (const [i, item] of opts.items.entries()) {
      if (item.type === 'flight' && (item.facts as { entryMode?: string }).entryMode === 'screenshot') {
        await storeScreenshot(actor, itemIds[i]!, opened.versionId);
      }
    }
    await h.storeEvidence(actor, opened.versionId);
    const ready = await h.readiness(actor, opened.versionId);
    expect(ready.issues, 'synthetic flight booking ready to confirm').toEqual([]);
    const confirmed = await h.confirm(actor, opened.versionId, ready.contentHash);
    expect(confirmed.outcome).toBe('created');
    const flightItems = itemIds.filter((_, i) => opts.items[i]!.type === 'flight');
    const tasks = await owner<{ id: string; department: string }>(
      `select t.id, t.department from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
       where t.deal_id = $1 order by i.item_no`, [deal]);
    const rowVersion = (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [opened.versionId]))[0]!.row_version;
    return {
      versionId: opened.versionId, rowVersion, itemIds, flightItems,
      flightTasks: tasks.filter((t) => t.department === 'flight').map((t) => t.id),
      allTasks: tasks.map((t) => t.id),
    };
  }

  /** A package Deal (hotel + the given flights). */
  const packageDeal = (flights: FlightItem[], opts: { deal?: string; actor?: Actor; travellers?: unknown } = {}) =>
    confirmBooking({ ...opts, items: [{ type: 'hotel', facts: HOTEL, budget: '4500000' }, ...flights] });
  /** A flight-only Deal (flights only; definition L2). */
  const flightOnlyDeal = (flights: FlightItem[], opts: { deal?: string; actor?: Actor; travellers?: unknown } = {}) =>
    confirmBooking({ ...opts, items: flights });

  async function storeScreenshot(actor: Actor, itemId: string, versionId: string): Promise<string> {
    const file = { fileName: 'fare-quote.png', mime: 'image/png', sizeBytes: 2048, sha256: 'c'.repeat(64) };
    const begun = await one<{ fileId: string; objectPath: string }>(actor, SQL.fileBegin, [itemId, versionId, 'flight_screenshot', JSON.stringify(file), rid()]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('service-item-files', $1, jsonb_build_object('size', 2048::bigint))`,
      [begun.objectPath]);
    await one(actor, SQL.fileFinish, [begun.fileId, true]);
    return begun.fileId;
  }

  /**
   * Accounts returns the base version, the Sales owner opens a revision, `edit`
   * changes it (returns the new row version), classified customer_material
   * with a fresh acceptance proof, then confirmed (outcome 'revised').
   */
  async function revise(baseVersionId: string, edit: (versionId: string, rowVersion: number) => Promise<number>,
    opts: { actor?: Actor; deal?: string } = {}): Promise<string> {
    const actor = opts.actor ?? OWNER;
    await one(ACC, SQL.reviewReturn, [baseVersionId, 'Synthetic return: the flight changed', rid()]);
    const opened = await one<{ versionId: string; rowVersion: number }>(actor, SQL.openRevision, [baseVersionId]);
    let rv = await edit(opened.versionId, opened.rowVersion);
    rv = (await one<{ rowVersion: number }>(actor, SQL.classify, [opened.versionId, rv, 'customer_material'])).rowVersion;
    await h.storeEvidence(actor, opened.versionId, 'acceptance_message', 'd'.repeat(64));
    const ready = await h.readiness(actor, opened.versionId);
    expect(ready.issues, 'revision ready to confirm').toEqual([]);
    const done = await h.confirm(actor, opened.versionId, ready.contentHash);
    expect(done.outcome).toBe('revised');
    void rv;
    return opened.versionId;
  }
  /** Replaces a flight item's facts in a revision draft. */
  const saveFlightFacts = async (actor: Actor, itemId: string, versionId: string, rowVersion: number, facts: unknown, budget = '2800000') =>
    (await one<{ rowVersion: number }>(actor, SQL.saveItem, [itemId, versionId, rowVersion, JSON.stringify(facts), budget])).rowVersion;

  const claim = (actor: Actor = FLIGHT, deal: string = DEAL, requestId: string = rid()) =>
    one<{ dealId: string; taskIds: string[]; claimedTaskIds: string[]; outcome: string }>(actor, SQL.groupClaim, [deal, requestId]);

  type SectorRow = { id: string; task_id: string; origin: string; status: string; booking_leg_no: number | null; from_place: string; to_place: string;
    depart_date: string; depart_time: string | null; arrive_time: string | null; flight_no: string | null; airline: string | null; row_version: number;
    change_id: string | null; basis_version_id: string };
  /** Sector rows of a task (owner read of the contract table), by date, time, leg. */
  const sectors = (taskId: string, status: string | null = 'active') => owner<SectorRow>(
    `select id, task_id, origin, status, booking_leg_no, from_place, to_place, depart_date::text, depart_time, arrive_time, flight_no, airline,
            row_version, change_id, basis_version_id
     from public.flight_sectors where task_id = $1 and ($2::text is null or status = $2)
     order by depart_date, depart_time nulls last, booking_leg_no nulls last, created_at, id`, [taskId, status]);
  /** Current (not ended) assignments of a sector: seq and hold. */
  const onSector = (sectorId: string) => owner<{ traveller_seq: number; held_by_change_id: string | null }>(
    `select traveller_seq, held_by_change_id from public.flight_sector_passengers where sector_id = $1 and ended_at is null order by traveller_seq`, [sectorId]);
  const seqsOn = async (sectorId: string) => (await onSector(sectorId)).map((r) => r.traveller_seq);
  const stateRow = async (taskId: string) => (await owner<{ basis_version_id: string; row_version: number }>(
    'select basis_version_id, row_version from public.flight_task_state where task_id = $1', [taskId]))[0];
  const taskRow = async (taskId: string) => (await owner<{ status: string; assignee_user_id: string | null; completed_at: string | null }>(
    'select status, assignee_user_id, completed_at from public.fulfilment_tasks where id = $1', [taskId]))[0]!;

  /** Flight creates a flight supplier (B2); returns its id (looked up by the unique name). */
  async function flightSupplier(actor: Actor = FLIGHT, name = `Synthetic Air Consolidator ${rid().slice(0, 8)}`): Promise<string> {
    await one(actor, SQL.supplierCreate, [JSON.stringify({ name, city: 'Synthetic City', contactName: 'Synthetic Desk',
      contactPhone: '+91 00000 00000', contactEmail: 'air.desk@example.test' }), rid()]);
    const [row] = await owner<{ id: string }>('select id from public.suppliers where lower(name) = lower($1)', [name]);
    return row!.id;
  }
  /** Bank details recorded by Flight (B3) and approved by the Manager (existing can_verify_suppliers). */
  async function approvedBank(supplierId: string): Promise<void> {
    const rev = await one<{ revisionNo: number }>(FLIGHT, SQL.supplierBeneficiary, [supplierId, rid(),
      JSON.stringify({ accountHolder: 'Synthetic Air Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000033334444' })]);
    await one(MANAGER, SQL.supplierApproveBeneficiary, [supplierId, rev.revisionNo]);
  }

  /** Flight confirms tickets for `seqs` on `sectorIds` (B8); fares per type present among them. */
  async function confirmTickets(o: { deal?: string; sectorIds: string[]; supplierId: string; seqs: number[]; fareApprovalId?: string | null;
    fares?: FareIn[]; tickets?: Record<number, Partial<TravellerTicket>>; actor?: Actor; requestId?: string }) {
    const types = await travellerTypes(o.deal ?? DEAL, o.seqs);
    const kind = await dealKind(o.deal ?? DEAL);
    const fares = o.fares ?? [...new Set(types)].map((t) => fare(t, kind === 'flight_only' ? { markupPaise: '0', discountPaise: '0' } : {}));
    return one<{ batchId: string; batchNo: number; ticketCount: number; travellersConfirmed: number; stillPending: number }>(o.actor ?? FLIGHT,
      SQL.ticketsConfirm, [o.deal ?? DEAL, confirmFields({ sectorIds: o.sectorIds, supplierId: o.supplierId, fareApprovalId: o.fareApprovalId ?? null,
        fares, travellers: o.seqs.map((s) => ticketFor(s, o.tickets?.[s])) }), o.requestId ?? rid()]);
  }
  const travellerTypes = async (deal: string, seqs: number[]) => {
    const rows = await owner<{ seq: number; traveller_type: 'adult' | 'child' | 'infant' }>(
      'select seq, traveller_type from public.deal_travellers where deal_id = $1 and seq = any($2::int[]) order by seq', [deal, seqs]);
    return rows.map((r) => r.traveller_type);
  };
  const dealKind = async (deal: string) => (await owner<{ k: string }>('select authz.flight_deal_kind($1) as k', [deal]))[0]!.k;

  /** Stored department evidence (begin, storage row, finish) on a task. */
  async function evidence(actor: Actor, taskId: string, kind: string, mime = 'application/pdf'): Promise<string> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(actor, SQL.evBegin,
      [taskId, null, kind, `${kind}.${mime === 'application/pdf' ? 'pdf' : 'png'}`, mime, 2048, 'b'.repeat(64)]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    const fin = await one<{ status: string }>(actor, SQL.evFinish, [ev.evidenceId, true]);
    expect(fin.status).toBe('stored');
    return ev.evidenceId;
  }

  /** Direct payment with a stored proof on the batch's cost task (B9). */
  async function directPay(batchId: string, actor: Actor = FLIGHT, requestId: string = rid()) {
    const [batch] = await owner<{ cost_task_id: string }>('select cost_task_id from public.flight_ticket_batches where id = $1', [batchId]);
    const proof = await evidence(actor, batch!.cost_task_id, 'direct_payment_proof');
    return one<Record<string, unknown>>(actor, SQL.directPayment, [batchId, null, JSON.stringify({
      paymentMode: 'card', paidOn: istBusinessDate(), reference: 'SYN-CARD-0001', proofEvidenceId: proof }), requestId]);
  }
  const paymentOf = async (batchId: string) => (await owner<{ id: string; status: string; route: string; row_version: number; amount_paise: string;
    approved_by: string | null; recorded_by: string | null }>(
    `select id, status, route, row_version, amount_paise::text, approved_by, recorded_by from public.supplier_payment_requests
     where flight_batch_id = $1 order by requested_at desc limit 1`, [batchId]))[0];

  /**
   * Book now v2 (form rules 2) Deal with a party of 5 (4 adults, 1 child) but
   * only the 4 TRAVELLERS named, one screenshot flight on every named
   * traveller: authz.flight_unnamed_count = pax_total 5 - 4 participants = 1
   * (section 4, L6). Readiness allows fewer named travellers than the party.
   */
  async function unnamedDeal(deal: string = DEAL, actor: Actor = OWNER, flights = 1): Promise<Booked> {
    await h.setSwitch('service_items_enabled', true);
    const s = await fh.start(actor, deal);
    let rv = (await h.saveTravellers(actor, deal, s.rowVersion, TRAVELLERS)).rowVersion;
    const shot = await fh.saveService(actor, s.versionId, rv, { type: 'flight', facts: screenshotFlight(4), participants: [1, 2, 3, 4], budget: '2800000' });
    rv = shot.rowVersion;
    const extra: string[] = [];
    for (let i = 1; i < flights; i += 1) {
      const more = await fh.saveService(actor, s.versionId, rv, { type: 'flight', facts: screenshotFlight(4), participants: [1, 2, 3, 4], budget: '2800000' });
      rv = more.rowVersion;
      extra.push(more.itemId);
    }
    rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_trip_save($1, $2, $3::jsonb) as r', [s.versionId, rv,
      JSON.stringify({ destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-15', paxTotal: 5, children: 1, infants: 0 })])).rowVersion;
    const billingRow = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
    rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [s.versionId, rv,
      JSON.stringify({ contactName: 'Synthetic Contact', mobile: '9876500011', email: 'contact@example.test', contactConfirmed: true, bookingFor: 'individual',
        payerDifferent: false, payerName: null, customerType: 'individual', market: 'india' }), JSON.stringify(BILL_TO), billingRow[0]?.row_version ?? 0, rid()])).rowVersion;
    rv = (await fh.savePrices(actor, s.versionId, rv, [line('adult', 4, '1000000', '234567', '1234567'), line('child_bed', 1, '500000', '100000', '600000'),
      line('child_no_bed', 0), line('infant', 0)])).rowVersion;
    rv = (await h.savePlan(actor, s.versionId, rv, [{ seq: 1, label: 'Full payment', amountPaise: '5538268', dueDate: '2026-11-01' }])).rowVersion;
    for (const seq of [1, 2, 3, 4]) await h.storeIdProof(actor, deal, seq);
    await storeScreenshot(actor, shot.itemId, s.versionId);
    for (const itemId of extra) await storeScreenshot(actor, itemId, s.versionId);
    await h.storeEvidence(actor, s.versionId);
    const ready = await h.readiness(actor, s.versionId);
    expect(ready.issues, 'unnamed-traveller booking ready to confirm').toEqual([]);
    await h.confirm(actor, s.versionId, ready.contentHash);
    const tasks = await owner<{ id: string }>(
      `select t.id from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
       where t.deal_id = $1 and t.department = 'flight' order by i.item_no`, [deal]);
    void rv;
    return { versionId: s.versionId, rowVersion: rv, itemIds: [shot.itemId, ...extra], flightItems: [shot.itemId, ...extra], flightTasks: tasks.map((t) => t.id),
      allTasks: tasks.map((t) => t.id) };
  }

  /** Owner read: business date in IST (the finance clock). */
  const today = () => istBusinessDate();

  return {
    ...h, refused, refusedHint, attempt, addRole, addFlightPeople, addSecondAccounts, confirmBooking, packageDeal, flightOnlyDeal, storeScreenshot,
    revise, saveFlightFacts, unnamedDeal, claim, sectors, onSector, seqsOn, stateRow, taskRow, flightSupplier, approvedBank, confirmTickets, travellerTypes,
    dealKind, evidence, directPay, paymentOf, today,
  };
}

export { b1Helpers, setActor };
