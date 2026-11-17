import { expect } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  expectDbError,
  istBusinessDate,
  resetActor,
} from '../helpers/db';
import { TRAVELLERS } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * Visa and Passport desk build (contract visa-build-2026-11-07/contract.md,
 * frozen 8 Nov 2026), Track E: shared scenario helpers for the
 * tests/db/visa-*.test.ts suites. Written from the contract (sections 4-9,
 * 12 and 16), NOT from the Track A/B/C code: every command is called with
 * the positional signature the contract freezes (section 6).
 *
 * Every scenario runs inside ONE rolled-back owner transaction (asOwner) and
 * impersonates a request only for the statement under test, as the Purchase
 * and Flight suites do.
 *
 * Synthetic actors (supabase/fixtures, all @example.test). The fixtures have
 * one Visa person and one Accounts person, so the suites give existing
 * synthetic users an extra membership inside the rolled-back transaction:
 *   VISA_A      Visa Jodhpur          the desk person (pure Visa in the fence suite)
 *   VISA_B      Moved Staff + Visa    second Visa person (addVisaB; its Sales membership is inactive)
 *   OWNER       Sales Delhi A         Sales owner of SYN-DEL-001 (Delhi)
 *   SALES_B     Sales Delhi B         other Sales (given a Sales assignment on the Deal when a test needs S)
 *   MANAGER     Manager Delhi         branch Manager of the Delhi Deals (M)
 *   MANAGER_AMD Manager Ahmedabad     same entity, other branch
 *   PURCHASE    Purchase Jodhpur
 *   FLIGHT      Sales Ahmedabad + Flight (addFlightPerson)
 *   ACC         Accounts Jodhpur
 *   SUPER       Admin Jodhpur (super_admin)
 * Second Accounts person: VISA_A is given an Accounts membership only in the
 * reviewer-separation tests (addVisaAccounts), never in the fence suite.
 */

export const VISA_A: Actor = { userId: U.visaJodhpur };
export const VISA_B: Actor = { userId: U.movedStaff };
export const OWNER: Actor = { userId: U.salesDelhiA };
export const SALES_B: Actor = { userId: U.salesDelhiB };
export const MANAGER: Actor = { userId: U.managerDelhi };
export const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
export const PURCHASE: Actor = { userId: U.purchaseJodhpur };
export const FLIGHT: Actor = { userId: U.salesAhmedabad };
export const ACC: Actor = { userId: U.accountsJodhpur };
export const SUPER: Actor = { userId: U.adminJodhpur };
export const ANON: Actor = { userId: null };
export const DEAL = D.del001;
export const DEAL2 = D.del002;

export const rid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Contract signatures (sections 6 and 9), positional, in contract order.
// ---------------------------------------------------------------------------
export const SQL = {
  claim: 'select public.visa_task_claim($1) as r', // C1
  setRow: 'select public.visa_application_set_row($1, $2, $3::jsonb, $4) as r', // C2
  docAdd: 'select public.visa_application_document_add($1, $2, $3::jsonb, $4) as r', // C3
  docRemove: 'select public.visa_application_document_remove($1, $2, $3) as r', // C4
  apply: 'select public.visa_applications_apply($1, $2::jsonb, $3) as r', // C5
  decide: 'select public.visa_application_decide($1, $2, $3::jsonb, $4) as r', // C6
  handover: 'select public.visa_application_set_handover($1, $2, $3::jsonb, $4) as r', // C7
  delivered: 'select public.visa_application_mark_delivered($1, $2, $3::jsonb, $4) as r', // C8
  withdraw: 'select public.visa_application_withdraw($1, $2, $3::jsonb, $4) as r', // C9
  reapply: 'select public.visa_application_reapply($1, $2, $3) as r', // C10
  docFileBegin: 'select public.visa_document_file_begin($1, $2, $3, $4, $5) as r', // C11
  feeSend: 'select public.visa_fee_send($1, $2, $3::jsonb, $4) as r', // C12
  confirmTraveller: 'select public.visa_application_confirm_traveller($1, $2, $3) as r', // C13
  noticeAck: 'select public.visa_result_notice_ack($1) as r', // C14
  costSave: 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r', // C15
  costSubmit: 'select public.department_cost_submit($1, $2) as r',
  oldUpdate: 'select public.visa_application_update($1, $2, $3::jsonb) as r', // C16 (revoked)
  oldSetState: 'select public.visa_application_set_state($1, $2, $3, $4) as r', // C16 (revoked)
  oldList: 'select public.visa_task_list() as r',
  oldGet: 'select public.visa_task_get($1) as r',
  workForm: 'select public.department_work_form($1) as r',
  evBegin: 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
  evFinish: 'select public.department_evidence_finish($1, $2) as r',
  evRemove: 'select public.department_evidence_remove($1) as r',
  evDownload: 'select public.department_evidence_authorize_download($1) as r',
  reassign: 'select public.purchase_task_reassign($1, $2, $3) as r',
  // Reads (section 9)
  queue: 'select public.visa_queue() as r',
  workspace: 'select public.visa_workspace($1) as r',
  dealSummary: 'select public.deal_visa_summary($1) as r',
  dealHistory: 'select public.deal_visa_history($1) as r',
  homeCounts: 'select public.visa_home_counts() as r',
  taskHistory: 'select public.department_task_history($1) as r',
  myWorkCounts: 'select public.my_work_counts() as r',
  services: 'select public.deal_services($1) as r',
  // Accounts
  expenseAccept: 'select public.expense_record_accept($1, $2, $3) as r',
  expenseReturn: 'select public.expense_record_return($1, $2, $3, $4) as r',
  expenseList: 'select public.accounts_expense_records($1, $2, $3) as r',
  // Booking and revision path
  reviewReturn: 'select public.accounts_review_return($1, $2, $3) as r',
  openRevision: 'select public.booking_open_revision($1) as r',
  classify: 'select public.booking_classify_revision($1, $2, $3) as r',
  saveItem: 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
  participants: 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
  travellers: 'select public.deal_travellers_save($1, $2, $3::jsonb) as r',
  identity: 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r',
  formGet: 'select public.booking_form_get($1) as r',
} as const;

// ---------------------------------------------------------------------------
// Synthetic visa and passport facts (section 5.5)
// ---------------------------------------------------------------------------
/** Three catalogue labels (section 4) as Sales picks them on the booking form. */
export const STICKER_DOCS = ['Passport copy (front and back)', 'Photo, white background', 'Bank statement (6 months)'];
export const EVISA_DOCS = ['Passport copy (front and back)', 'Photo, white background'];
export const VISA_BASE = { country: 'France', purpose: 'Tourism', travelDate: '2027-02-06', applyBy: null, feePaidBy: 'company', notes: null };
/** Sticker visa, jurisdiction Yes · New Delhi, three documents needed. */
export const STICKER = { ...VISA_BASE, visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', documentsNeeded: STICKER_DOCS };
/** Kind left blank by Sales ("Not decided yet"): the desk may choose (QB5). */
export const BLANK_KIND = {
  ...VISA_BASE, country: 'United Arab Emirates', travelDate: '2026-12-10', feePaidBy: 'customer', visaKind: null, jurisdiction: null,
  jurisdictionPlace: null, documentsNeeded: EVISA_DOCS,
};
export const EVISA = { ...BLANK_KIND, visaKind: 'e_visa' };
export const PASSPORT = { applicationType: 'renewal', officeCity: 'Jodhpur', neededBy: '2026-11-20', notes: null };

/** Section 4 frozen catalogue (code, label), in order. */
export const CATALOGUE: Array<[string, string]> = [
  ['passport_copy', 'Passport copy (front and back)'], ['photo', 'Photo, white background'], ['bank_statement', 'Bank statement (6 months)'],
  ['parent_passport', 'Parent’s passport copy'], ['travel_insurance', 'Travel insurance'], ['stay_proof', 'Hotel booking'],
  ['birth_certificate', 'Birth certificate'], ['parent_consent', 'Parents’ consent letter'], ['onward_ticket', 'Onward flight ticket'],
  ['original_passport', 'Original passport'], ['old_passports', 'Old passports'], ['passport_size_photos_2', 'Passport-size photos (2)'],
  ['aadhaar_card', 'Aadhaar card'], ['pan_card', 'PAN card'], ['itr_last_3_years', 'ITR (last 3 years)'],
  ['salary_slips_3_months', 'Salary slips (3 months)'], ['employment_letter_or_noc', 'Employment letter or NOC'], ['leave_letter', 'Leave letter'],
  ['cover_letter', 'Cover letter'], ['return_flight_booking', 'Return flight booking'], ['visa_application_form_signed', 'Visa application form (signed)'],
  ['marriage_certificate', 'Marriage certificate'], ['invitation_letter', 'Invitation letter'],
  ['business_registration_documents', 'Business registration documents'], ['school_or_college_id', 'School or college ID'],
];

/** Passport number the booking form saves for traveller `seq` (identity sentinel). */
export const passportOf = (seq: number) => `Z${1000000 + seq}`;

// ---------------------------------------------------------------------------
// DTO shapes used by the suites (section 9.2, the keys the tests read)
// ---------------------------------------------------------------------------
export type VisaDoc = { documentId: string; catalogueCode: string | null; label: string; status: 'not_received' | 'received'; source: string;
  remark: string | null; receivedAt: string | null; files: Array<{ evidenceId: string; fileName: string }> };
export type Fee = { entryId: string; costKind: string; amountPaise: string; paidBy: string; paymentMode: string | null; expenseStatus: string | null;
  returnReason: string | null; rowVersion: number; receipt: { evidenceId: string; fileName: string } | null };
export type Applicant = {
  applicationId: string; seq: number; fullName: string | null; type: string; rowVersion: number; state: string; stateText: string; ready: boolean;
  notReady: string[]; removed: boolean; secondApplication: boolean; previousApplicationId: string | null; travellerChanged: null | { was: string; now: string };
  passport: null | { number: string | null; identityRowVersion: number | null };
  visaKind: { value: string | null; source: string | null }; jurisdiction: { required: boolean | null; place: string | null; source: string | null };
  appointment: { date: string | null; time: string | null }; remark: string | null; documents: VisaDoc[]; documentsReceived: number; documentsTotal: number;
  applied: null | { reference: string; appliedOn: string; clubId: string | null; clubWith: string[]; remark: string | null; passportTaken: boolean };
  decision: null | { outcome: string; at: string; remark: string | null; reason: string | null; proof: { evidenceId: string } | null };
  handover: null | { kind: string | null; recipientEmail: string | null; method: string | null; courierNumber: string | null; deliveredOn: string | null };
  closed: null | { at: string; reason: string }; fees: Fee[];
  can: Record<'edit' | 'select' | 'decide' | 'handover' | 'deliver' | 'withdraw' | 'reapply' | 'confirmTraveller', boolean>;
};
export type Workspace = {
  taskId: string; serviceType: 'visa' | 'passport'; dealId: string; status: { code: string; step: string | null; text: string };
  assignee: { name: string | null; isYou: boolean }; canClaim: boolean; canWork: boolean; isManagerView: boolean;
  steps: Array<{ key: string; label: string; met: number; of: number; done: boolean }>;
  bookingChange: null | { versionNo: number; added: Array<{ seq: number }>; removed: Array<{ seq: number }>; back: Array<{ seq: number }>;
    renamed: Array<{ seq: number; oldName: string; newName: string }>; documentsAdded: number; fields: string[] };
  addedAfterCompletion: number; applicants: Applicant[]; previousApplications: Array<{ applicationId: string; seq: number; reference: string; state: string }>;
  readyCount: number; appliedCount: number;
  costSummary: { travellers: Array<Record<string, unknown>>; taskLevel: Array<Record<string, unknown>>; companyTotalPaise: string; customerDirectTotalPaise: string };
  returnedFees: Array<{ entryId: string; costKind: string; amountPaise: string; returnReason: string; rowVersion: number }>;
  catalogue: Array<{ code: string; label: string }> | null; files: Array<Record<string, unknown>>; canUpload: boolean;
} & Record<string, unknown>;

/** One applicant line of C5. */
export const line = (a: Pick<Applicant, 'applicationId' | 'rowVersion'>, over: Record<string, unknown> = {}) => ({
  applicationId: a.applicationId, expectedRowVersion: a.rowVersion, reference: `SYN-REF-${a.applicationId.slice(0, 8)}`,
  appliedOn: istBusinessDate(), governmentFeePaise: '650000', serviceFeePaise: null, ...over,
});
/** IST business date `days` from today. */
export const dayFrom = (days: number) => {
  const d = new Date(`${istBusinessDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export type VisaItem = { type: 'visa' | 'passport'; facts: unknown; participants?: number[] };
export type Booked = { versionId: string; itemIds: string[]; tasks: string[]; byItem: Record<string, string> };

export function visaHelpers(getDb: () => TestDb) {
  const h = b11Helpers(getDb);
  const db = () => getDb();
  const { one, owner, run } = h;

  /** Refusal whose message is exactly the token (and SQLSTATE when given). */
  async function refused(actor: Actor, sql: string, params: unknown[], token: string, code?: string): Promise<void> {
    await expectDbError(db(), () => run(actor, sql, params), { message: new RegExp(`^${token}$`), ...(code ? { code } : {}) });
  }
  /** Refusal with message and hint (regex); returns the hint. */
  async function refusedHint(actor: Actor, sql: string, params: unknown[], token: string, hint?: RegExp): Promise<string> {
    await db().exec('savepoint visa_hint');
    let error: { code?: string; message?: string; hint?: string } | undefined;
    try {
      await run(actor, sql, params);
    } catch (e) {
      error = e as { code?: string; message?: string; hint?: string };
      await db().exec('rollback to savepoint visa_hint');
    }
    if (error === undefined) throw new Error(`expected ${token}, but the statement succeeded`);
    expect(error.message, `hint: ${error.hint ?? ''}`).toBe(token);
    if (hint) expect(error.hint ?? '').toMatch(hint);
    return error.hint ?? '';
  }
  /** Runs a statement inside a savepoint: the value, or the error (the transaction stays usable). */
  async function attempt<T = unknown>(actor: Actor, sql: string, params: unknown[] = []): Promise<{ ok: true; value: T } | { ok: false; error: string; code?: string; hint?: string }> {
    await db().exec('savepoint visa_attempt');
    try {
      const value = await one<T>(actor, sql, params);
      await db().exec('release savepoint visa_attempt');
      return { ok: true, value };
    } catch (e) {
      await db().exec('rollback to savepoint visa_attempt');
      await resetActor(db());
      const err = e as { message: string; code?: string; hint?: string };
      return { ok: false, error: err.message, code: err.code, hint: err.hint };
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
    await owner(`update public.staff_profiles set status = 'active', activated_at = coalesce(activated_at, now()) where user_id = $1 and status <> 'active'`, [user]);
  }
  const addVisaB = () => addRole(U.movedStaff, 'visa');
  const addFlightPerson = () => addRole(U.salesAhmedabad, 'flight');
  /** Second Accounts person for reviewer separation: VISA_A also holds Accounts (never in the fence suite). */
  const addVisaAccounts = () => addRole(U.visaJodhpur, 'accounts');
  /** Other Sales reader (S): a Sales assignment on the Deal for SALES_B. */
  async function addOtherSales(deal: string = DEAL, user: string = U.salesDelhiB): Promise<void> {
    await owner(
      `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
       select id, legal_entity_id, $2, 'sales', $3 from public.deals where id = $1`,
      [deal, user, U.adminJodhpur],
    );
  }

  /** Switches the service items and visa/passport task creation on (owner SQL; live has the visa switch On, section 3.1). */
  async function switchesOn(): Promise<void> {
    await resetActor(db());
    await owner('update public.workflow_settings set service_items_enabled = true, visa_passport_tasks_enabled = true where id');
  }

  /**
   * Confirms a booking on `deal` with visa/passport items: travellers,
   * selling total, the B1.1 steps, identities (passport numbers passportOf(seq)),
   * ID proofs, participants per item and an acceptance proof. The visa switch
   * is On, so booking_confirm creates the tasks at acceptance (V1).
   */
  async function book(opts: { items: VisaItem[]; travellers?: unknown; deal?: string; actor?: Actor }): Promise<Booked> {
    const actor = opts.actor ?? OWNER;
    const deal = opts.deal ?? DEAL;
    await switchesOn();
    const d = await h.draftWithTravellers(actor, deal, opts.travellers ?? TRAVELLERS);
    let rv = d.rowVersion;
    const itemIds: string[] = [];
    for (const item of opts.items) {
      const added = await h.addItem(actor, d.versionId, rv, item.type, item.facts, '0');
      rv = added.rowVersion;
      itemIds.push(added.itemId);
    }
    rv = (await h.saveSelling(actor, d.versionId, rv)).rowVersion;
    rv = await h.completeB11(actor, deal, d.versionId, rv);
    for (const [i, item] of opts.items.entries()) {
      if (item.participants) rv = (await h.saveParticipation(actor, itemIds[i]!, d.versionId, rv, item.participants)).rowVersion;
    }
    const seqs = (await owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [deal])).map((t) => t.seq);
    for (const seq of seqs) await h.saveIdentity(actor, deal, seq, 0, { dateOfBirth: '1990-05-17', nationality: 'Indian', passportNumber: passportOf(seq), passportExpiry: '2030-01-31' });
    await h.storeEvidence(actor, d.versionId);
    const ready = await h.readiness(actor, d.versionId);
    expect(ready.issues, 'synthetic visa booking ready to confirm').toEqual([]);
    await h.confirm(actor, d.versionId, ready.contentHash);
    const tasks = await owner<{ id: string; item: string }>(
      `select t.id, t.service_item_id as item from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
       where t.deal_id = $1 and t.department = 'visa' order by i.item_no`, [deal]);
    expect(tasks.length, 'one visa/passport task per item at acceptance (V1)').toBe(opts.items.length);
    return { versionId: d.versionId, itemIds, tasks: tasks.map((t) => t.id), byItem: Object.fromEntries(tasks.map((t) => [t.item, t.id])) };
  }

  /** One sticker visa task for the four TRAVELLERS, taken by VISA_A. */
  async function stickerTask(opts: { take?: boolean; facts?: unknown; participants?: number[] } = {}) {
    const b = await book({ items: [{ type: 'visa', facts: opts.facts ?? STICKER, participants: opts.participants }] });
    const taskId = b.tasks[0]!;
    if (opts.take ?? true) await one(VISA_A, SQL.claim, [taskId]);
    return { ...b, taskId };
  }

  const workspace = (taskId: string, actor: Actor = VISA_A) => one<Workspace | null>(actor, SQL.workspace, [taskId]);
  async function applicants(taskId: string, actor: Actor = VISA_A): Promise<Applicant[]> {
    const w = await workspace(taskId, actor);
    if (!w) throw new Error('visa_workspace returned null');
    return w.applicants;
  }
  async function app(taskId: string, seq: number, actor: Actor = VISA_A): Promise<Applicant> {
    const found = (await applicants(taskId, actor)).find((a) => a.seq === seq && !a.removed);
    if (!found) throw new Error(`no current applicant for seq ${seq}`);
    return found;
  }
  /** Owner read of the application row (contract table, section 5.1). */
  const appRow = async (applicationId: string) => (await owner<Record<string, unknown>>('select * from public.visa_applications where id = $1', [applicationId]))[0]!;
  const docRows = (applicationId: string) => owner<Record<string, unknown>>(
    'select * from public.visa_application_documents where application_id = $1 order by created_at, label', [applicationId]);
  const taskRow = async (taskId: string) => (await owner<{ status: string; assignee_user_id: string | null; completed_by: string | null }>(
    'select status, assignee_user_id, completed_by from public.fulfilment_tasks where id = $1', [taskId]))[0]!;
  const audits = (action: string, targetId?: string) => owner<{ target_id: string; details: Record<string, unknown>; reason: string | null }>(
    `select target_id, details, reason from public.audit_events where action = $1 and ($2::uuid is null or target_id = $2) order by id`, [action, targetId ?? null]);

  /** C2: appointment date (unless e-visa) and every listed document received; returns the new row version. */
  async function makeReady(taskId: string, seq: number, opts: { appointmentDate?: string | null; actor?: Actor } = {}): Promise<Applicant> {
    const a = await app(taskId, seq, opts.actor);
    const fields: Record<string, unknown> = { documents: a.documents.map((d) => ({ documentId: d.documentId, received: true })) };
    if (opts.appointmentDate !== null) fields.appointmentDate = opts.appointmentDate ?? dayFrom(-2);
    await one(opts.actor ?? VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify(fields), rid()]);
    return app(taskId, seq, opts.actor);
  }

  /** Stored department evidence (begin, storage row, finish); returns its id. */
  async function evidence(actor: Actor, taskId: string, kind: string, applicationId: string | null = null, sha = 'b'.repeat(64)): Promise<string> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(actor, SQL.evBegin,
      [taskId, applicationId, kind, `${kind}.pdf`, 'application/pdf', 2048, sha]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    const fin = await one<{ status: string }>(actor, SQL.evFinish, [ev.evidenceId, true]);
    expect(fin.status).toBe('stored');
    return ev.evidenceId;
  }

  type ApplyResult = { clubId: string | null; applications: Array<{ applicationId: string; rowVersion: number; state: string }>; entryIds: string[]; taskCompleted?: boolean };
  /** C5 for the given ready applicants (company-paid, UPI) with optional shared fields. */
  function apply(taskId: string, lines: unknown[], shared: Record<string, unknown> = {}, requestId: string = rid(), actor: Actor = VISA_A) {
    const fields = { applicants: lines, paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: null, remark: null, ...shared };
    if (fields.paidBy !== 'company' && !('paymentMode' in shared)) delete (fields as Record<string, unknown>).paymentMode;
    return one<ApplyResult>(actor, SQL.apply, [taskId, JSON.stringify(fields), requestId]);
  }
  /** Ready + Applied alone for one passenger (company-paid without receipt: draft fees, VL2). */
  async function appliedAlone(taskId: string, seq: number, over: Record<string, unknown> = {}, shared: Record<string, unknown> = {}): Promise<Applicant> {
    const a = await makeReady(taskId, seq);
    await apply(taskId, [line(a, over)], shared);
    return app(taskId, seq);
  }
  type Decided = { applicationId: string; rowVersion: number; state: string; closed: boolean; taskCompleted: boolean };
  /** C6 Approve / Reject with a stored decision proof for this application. */
  async function decide(taskId: string, a: Applicant, decision: 'approved' | 'rejected', extra: Record<string, unknown> = {}, actor: Actor = VISA_A) {
    const proof = await evidence(actor, taskId, 'authority_outcome', a.applicationId);
    const base = decision === 'rejected' ? { reason: 'Synthetic refusal: bank statement too short' } : {};
    return one<Decided>(actor, SQL.decide, [a.applicationId, a.rowVersion, JSON.stringify({ decision, outcomeEvidenceId: proof, ...base, ...extra }), rid()]);
  }

  /**
   * Accounts returns `baseVersionId`, the Sales owner opens a revision, `edit`
   * changes it (returns the new row version), it is classified `cls` (with a
   * fresh acceptance proof for customer_material) and confirmed ('revised').
   */
  async function revise(baseVersionId: string, edit: (versionId: string, rowVersion: number) => Promise<number>,
    opts: { actor?: Actor; cls?: 'customer_material' | 'format_only' | 'internal_only' } = {}): Promise<string> {
    const actor = opts.actor ?? OWNER;
    const cls = opts.cls ?? 'customer_material';
    await one(ACC, SQL.reviewReturn, [baseVersionId, 'Synthetic return: the visa travellers changed', rid()]);
    const opened = await one<{ versionId: string; rowVersion: number }>(actor, SQL.openRevision, [baseVersionId]);
    const rv = await edit(opened.versionId, opened.rowVersion);
    await one(actor, SQL.classify, [opened.versionId, rv, cls]);
    if (cls === 'customer_material') await h.storeEvidence(actor, opened.versionId, 'acceptance_message', rid().replace(/-/g, '').padEnd(64, '0').slice(0, 64));
    const ready = await h.readiness(actor, opened.versionId);
    expect(ready.issues, 'revision ready to confirm').toEqual([]);
    const done = await h.confirm(actor, opened.versionId, ready.contentHash);
    expect(done.outcome).toBe('revised');
    return opened.versionId;
  }
  /** Current row version of a booking version (owner read). */
  const versionRv = async (versionId: string) => (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]))[0]!.row_version;

  return {
    ...h, refused, refusedHint, attempt, addRole, addVisaB, addFlightPerson, addVisaAccounts, addOtherSales, switchesOn, book, stickerTask,
    workspace, applicants, app, appRow, docRows, taskRow, audits, makeReady, evidence, apply, appliedAlone, decide, revise, versionRv,
  };
}
