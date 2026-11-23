import { randomBytes } from 'node:crypto';
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
import { ACTIVITY, CONTACT, HOTEL, TRANSFER, TRAVELLERS, TRIP } from './b1-support';
import { claimHelpers } from './b11-claims-support';
import { financeHelpers, insertApprovedDestination } from './finance-support';
import { LEG_JDH_DEL, flightHelpers, nextPnr, nextTicket, typedFlight } from './flight-support';
import { PASSPORT, STICKER, line as visaLine, visaHelpers } from './visa-e-support';

/**
 * Accounts phase (contract accounts-phase-2026-11-10/contract.md, frozen
 * 10 Nov 2026), Track E: shared scenario helpers for tests/db/acc-*.test.ts.
 * Written from the contract (sections 4-9 and 12), NOT from the Track A-D
 * code: every new command and read is called with the positional signature
 * the contract freezes (sections 5, 7 and 8).
 *
 * Every scenario runs inside ONE rolled-back owner transaction (asOwner) and
 * impersonates a request only for the statement under test, like the
 * Purchase, Flight and Visa suites.
 *
 * Synthetic actors (supabase/fixtures, all @example.test). The fixtures do not
 * yet have the Accounts-phase users the contract asks the lead for (section
 * 13: a second and third Accounts person, a Manager per branch, a Manager
 * holding Flight), so the suites give existing synthetic users an extra
 * membership inside the rolled-back transaction:
 *   OWNER        Sales Delhi A        Sales owner of SYN-DEL-001 (Delhi)
 *   SALES_B      Sales Delhi B        other Sales (owns SYN-DEL-002)
 *   MANAGER      Manager Delhi        branch Manager of the Delhi Deals (M)
 *   MANAGER_AMD  Manager Ahmedabad    Manager of the other branch
 *   PURCHASE     Purchase Jodhpur
 *   ACC          Accounts Jodhpur     (A)
 *   ACC2         Visa Jodhpur + Accounts (addAcc2; never in the fence suite)
 *   ACC3         Invited Staff, activated + Accounts (addAcc3; the synthetic exception owner)
 *   FLIGHT       Moved Staff + Flight (flight-support)
 *   FLIGHT_2     Sales Ahmedabad + Flight
 *   VISA         Visa Jodhpur (pure Visa in the fence suite)
 *   SUPER        Admin Jodhpur (super_admin)
 *   OTHER_ENTITY Sales Entity B
 */

export const OWNER: Actor = { userId: U.salesDelhiA };
export const SALES_B: Actor = { userId: U.salesDelhiB };
export const MANAGER: Actor = { userId: U.managerDelhi };
export const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
export const PURCHASE: Actor = { userId: U.purchaseJodhpur };
export const ACC: Actor = { userId: U.accountsJodhpur };
export const ACC2: Actor = { userId: U.visaJodhpur };
export const ACC3: Actor = { userId: U.invitedStaff };
export const FLIGHT: Actor = { userId: U.movedStaff };
export const FLIGHT_2: Actor = { userId: U.salesAhmedabad };
export const VISA: Actor = { userId: U.visaJodhpur };
export const SUPER: Actor = { userId: U.adminJodhpur };
export const OTHER_ENTITY: Actor = { userId: U.salesEntityB };
/** Visa desk person in the everyKind scenario (Sales Ahmedabad + Visa), so Visa Jodhpur can be ACC2. */
export const VISA_DESK: Actor = { userId: U.salesAhmedabad };
export const ANON: Actor = { userId: null };
export const DEAL = D.del001;
export const DEAL2 = D.del002;
export const DEAL_AMD = D.amd001;
export const DEAL_B = D.b001;

export const rid = () => crypto.randomUUID();
export const sha = () => randomBytes(32).toString('hex');
export const today = () => istBusinessDate();
/** IST business date `days` from today (negative = past). */
export function dayFrom(days: number): string {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Distinctive selling total (a leak sentinel in every non-money read). */
export const SELLING = '9123457';
export const REASON = 'Synthetic reason for the accounts phase test';

// ---------------------------------------------------------------------------
// Contract signatures, positional, in contract order.
// ---------------------------------------------------------------------------
export const SQL = {
  // Phase 0 (section 5)
  formGet: 'select public.booking_form_get($1) as r',
  readiness: 'select public.booking_readiness($1) as r',
  checklist: 'select public.intake_checklist($1) as r',
  proofsForTask: 'select public.traveller_id_proofs_for_task($1) as r',
  idProofBegin: 'select public.traveller_id_proof_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
  idProofFinish: 'select public.traveller_id_proof_finish($1, $2) as r',
  reviewReturn: 'select public.accounts_review_return($1, $2, $3) as r',
  reviewApprove: 'select public.accounts_review_approve($1, $2, $3) as r',
  billingSave: 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r',
  billingVerify: 'select public.accounts_billing_verify($1, $2, $3) as r',
  dealDetail: 'select public.accounts_deal_detail($1) as r',
  paymentCancel: 'select public.supplier_payment_request_cancel($1, $2, $3) as r',
  flightMoney: 'select public.flight_money($1) as r',
  flightPaymentRequest: 'select public.flight_payment_request_create($1, $2::jsonb, $3) as r',
  groupReassign: 'select public.flight_group_reassign($1, $2, $3, $4, $5) as r',
  // Workspace and dues (section 8.1-8.3)
  records: 'select public.accounts_records($1::jsonb, $2, $3) as r',
  recordsTotals: 'select public.accounts_records_totals($1::jsonb) as r',
  dailyCheck: 'select public.accounts_daily_check() as r',
  dues: 'select public.accounts_dues($1::jsonb, $2, $3) as r',
  dealDues: 'select public.deal_dues($1) as r',
  payables: 'select public.accounts_supplier_payables($1) as r',
  // Tally (section 7.1, 7.2)
  match: 'select public.accounts_tally_match($1, $2, $3, $4::jsonb, $5) as r',
  exception: 'select public.accounts_tally_exception($1, $2, $3, $4::jsonb, $5) as r',
  reopen: 'select public.accounts_tally_reopen($1, $2, $3, $4, $5) as r',
  invoiceAdd: 'select public.accounts_tally_invoice_add($1, $2::jsonb, $3) as r',
  invoiceWithdraw: 'select public.accounts_tally_invoice_withdraw($1, $2, $3, $4) as r',
  setExceptionOwner: 'select public.admin_set_accounts_exception_owner($1, $2, $3) as r',
  setTallyExport: 'select public.admin_set_tally_export_enabled($1, $2, $3) as r',
  exportCreate: 'select public.accounts_tally_export_create($1::jsonb, $2) as r',
  exportLines: 'select public.accounts_tally_export_lines($1, $2, $3) as r',
  exportDownload: 'select public.accounts_tally_export_download_log($1) as r',
  // Supplier documents (section 7.3)
  docUpload: 'select public.supplier_document_upload($1, $2::jsonb, $3) as r',
  docReview: 'select public.supplier_document_review($1, $2, $3, $4, $5) as r',
  docLink: 'select public.supplier_document_link_task($1, $2, $3) as r',
  docUnlink: 'select public.supplier_document_unlink_task($1, $2, $3) as r',
  docCredit: 'select public.supplier_document_set_credit_link($1, $2, $3) as r',
  accountsDocuments: 'select public.accounts_supplier_documents($1) as r',
  // Notices (section 7.5, 8.4)
  noticeMark: 'select public.notice_mark($1, $2) as r',
  noticeMarkAll: 'select public.notice_mark_all_read() as r',
  noticePrefsSet: 'select public.notice_preferences_set($1::jsonb) as r',
  noticePrefsGet: 'select public.notice_preferences_get() as r',
  inbox: 'select public.notice_inbox($1::bigint, $2) as r',
  history: 'select public.notice_history($1::bigint, $2) as r',
  unread: 'select public.notice_unread_count() as r',
  setNotices: 'select public.admin_set_notices_enabled($1, $2) as r',
  visaAck: 'select public.visa_result_notice_ack($1) as r',
  // Purchase booking change (section 7.6, 8.5)
  changeAck: 'select public.purchase_booking_change_ack($1, $2, $3) as r',
  change: 'select public.purchase_booking_change($1) as r',
  purchaseHome: 'select public.purchase_home_counts() as r',
  // Existing commands used to build scenarios
  purchaseClaim: 'select public.purchase_task_claim($1) as r',
  purchaseReassign: 'select public.purchase_task_reassign($1, $2, $3) as r',
  supplierCreate: 'select public.supplier_create($1, $2::jsonb) as r',
  supplierBeneficiary: 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r',
  supplierApproveBeneficiary: 'select public.supplier_approve_beneficiary($1, $2) as r',
  quoteAdd: 'select public.purchase_quote_add($1, $2, $3::jsonb) as r',
  costPropose: 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r',
  bookingRequestSend: 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
  goAheadDecide: 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r',
  supplierConfirm: 'select public.purchase_supplier_confirm($1, $2, $3) as r',
  smEvidenceBegin: 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
  smEvidenceFinish: 'select public.supplier_money_evidence_finish($1, $2) as r',
  paymentCreate: 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r',
  paymentDecide: 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
  paymentRecord: 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
  paymentVerify: 'select public.supplier_payment_verify($1, $2, $3) as r',
  cancelOpen: 'select public.deal_cancellation_open($1, $2, $3) as r',
  openRevision: 'select public.booking_open_revision($1) as r',
  classify: 'select public.booking_classify_revision($1, $2, $3) as r',
  saveItem: 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
  confirm: 'select public.booking_confirm($1, $2) as r',
} as const;

// ---------------------------------------------------------------------------
// Frozen vocabularies (contract sections 6-9)
// ---------------------------------------------------------------------------
export const WORKSPACE_KINDS = [
  'receipt', 'receipt_reversal', 'claim', 'cash_deposit', 'cash_count', 'supplier_payment', 'company_funding', 'supplier_invoice',
  'supplier_credit_note', 'expense', 'flight_ticket_batch', 'visa_application', 'tally_gst_invoice', 'original',
] as const;
export const ROW_KEYS = [
  'rowId', 'kind', 'recordId', 'recordDate', 'createdAt', 'reference', 'otherReferences', 'dealId', 'dealReference', 'bitrixDealId', 'branchName',
  'collectingBranchName', 'department', 'taskId', 'serviceLabel', 'supplierId', 'supplierName', 'amountPaise', 'direction', 'statusCode', 'stage',
  'reviewStatus', 'tally', 'files', 'original', 'link', 'can',
].sort();
export const TALLY_KEYS = ['status', 'rowVersion', 'recordKind', 'changedSinceExport', 'lastExportedAt', 'exportCount', 'voucherRef', 'exceptionReason',
  // Additive (Track B): T1-T3 take the Tally record id (for a receipt, its journal entry), which 8.1's tally object
  // does not name; voucherDate sits next to voucherRef. Reported to the lead as a contract gap.
  'recordId', 'voucherDate'].sort();
/** CSV column (7.4) -> key of tally_export_lines.values (key names are not frozen by the contract). */
export const CSV_VALUE_KEYS: Record<string, string> = {
  'Export no': 'exportNo', Line: 'line', 'Record type': 'recordType', 'Voucher type hint': 'voucherType', Date: 'date', Reference: 'reference',
  Deal: 'deal', 'Bitrix Deal id': 'bitrixDealId', Branch: 'branch', Party: 'party', 'Debit ledger hint': 'debitLedger',
  'Credit ledger hint': 'creditLedger', 'Amount (INR)': 'amount', Mode: 'mode', 'Bank reference': 'bankReference', PAN: 'pan', Mobile: 'mobile',
  'GST included': 'gstIncluded', 'Credit note for': 'creditNoteFor', 'Linked tasks': 'linkedTasks', 'Already exported on': 'alreadyExportedOn',
  'Changed since last export': 'changedSinceLastExport', 'CRM record id': 'crmRecordId',
};
export const DUES_ROW_KEYS = [
  'dealId', 'dealReference', 'branchName', 'ownerName', 'basis', 'totalPaise', 'verifiedPaise', 'balancePaise', 'overduePaise', 'dueNowPaise', 'nextDue',
  'reportedPaise', 'awaitingVerificationPaise', 'creditPaise', 'status', 'cancellation',
  // Section 4.4 flag (reportedPaise > 0); 8.3's row list omits it, 4.4 names it.
  'reported',
].sort();
export const NOTICE_KINDS = [
  'task_new', 'task_assigned', 'booking_changed', 'review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'trip_cancelled',
  'payment_reported', 'receipt_to_verify', 'payment_to_approve', 'payment_to_record', 'payment_to_verify', 'payment_decided', 'funding_to_approve',
  'bank_details_to_approve', 'go_ahead_to_approve', 'go_ahead_decided', 'cost_over_budget', 'fare_to_approve', 'fare_decided', 'expense_returned',
  'supplier_bill_returned', 'visa_result', 'tally_exception',
] as const;
export const NOTICE_PARAM_KEYS = ['dealReference', 'department', 'refNo', 'serviceType', 'versionNo', 'status'];
export const CSV_COLUMNS = [
  'Export no', 'Line', 'Record type', 'Voucher type hint', 'Date', 'Reference', 'Deal', 'Bitrix Deal id', 'Branch', 'Party', 'Debit ledger hint',
  'Credit ledger hint', 'Amount (INR)', 'Mode', 'Bank reference', 'PAN', 'Mobile', 'GST included', 'Credit note for', 'Linked tasks',
  'Already exported on', 'Changed since last export', 'CRM record id',
];

// ---------------------------------------------------------------------------
// DTO shapes the suites read (section 8)
// ---------------------------------------------------------------------------
export type TallyCell = { status: string; rowVersion: number; recordKind: string | null; changedSinceExport: boolean; lastExportedAt: string | null;
  exportCount: number; voucherRef?: string | null; exceptionReason?: string | null };
export type WorkRow = {
  rowId: string; kind: string; recordId: string; recordDate: string; createdAt: string; reference: string | null; otherReferences: string[];
  dealId: string | null; dealReference: string | null; bitrixDealId: string | null; branchName: string | null; collectingBranchName: string | null;
  department: string | null; taskId: string | null; serviceLabel: string | null; supplierId: string | null; supplierName: string | null;
  amountPaise: string | null; direction: string; statusCode: string; stage: string; reviewStatus: string; tally: TallyCell;
  files: { count: number; links?: Array<{ kind: string; evidenceId: string; fileName: string }> };
  original: null | { what: string; state: 'expected' | 'missing'; since: string; ownerRole: string; ownerName: string | null };
  link: { kind: string; id: string }; can: { match: boolean; exception: boolean; reopen: boolean; linkTask: boolean };
};
export type WorkPage = { items: WorkRow[]; nextAfter: string | null; hasMore?: boolean } & Record<string, unknown>;
export type DuesRow = {
  dealId: string; dealReference: string; branchName: string; ownerName: string | null;
  basis: { versionNo: number; kind: 'approved' | 'awaiting_review'; newerVersionPending: boolean };
  totalPaise: string; verifiedPaise: string; balancePaise: string; overduePaise: string; dueNowPaise: string; nextDue: { date: string; openPaise: string } | null;
  reportedPaise: string; awaitingVerificationPaise: string; creditPaise: string; status: string; cancellation: 'open' | 'approved' | null;
};
export type DealDues = DuesRow & {
  instalments: Array<{ seq: number; label: string; dueDate: string; amountPaise: string; coveredPaise: string; openPaise: string; status: string; partlyPaid: boolean }>;
  tallyInvoices?: Array<{ id: string; invoiceRef: string; invoiceDate: string; tallyStatus: string }>;
  supplierPayables?: Array<Record<string, unknown>>;
} & Record<string, unknown>;
export type Notice = {
  noticeId: string; seq: number; kind: string; priority: 'urgent' | 'normal'; escalated: boolean; createdAt: string; readAt: string | null;
  doneAt: string | null; resolvedAt: string | null; resolvedReason: string | null; dealId: string | null; dealReference: string | null;
  taskId: string | null; department: string | null; params: Record<string, unknown>; link: { kind: string; id: string } | null;
};
export type Inbox = { enabled: boolean; unreadCount: number; urgentCount: number; latestSeq: number | string | null; soundOn: boolean; items: Notice[] };

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
/** True when `text` contains `value` as a standalone token (not part of a longer number or word). */
export const containsToken = (text: string, value: string) =>
  new RegExp(`(?<![0-9A-Za-z])${value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9A-Za-z])`).test(text);

/** Synthetic sentinels (section 12.4): never in a workspace row, notice or audit detail. */
export const SENTINEL = {
  pan: 'ABCDE1234F',
  panCash: 'PQRSX6789K',
  mobile: '6000043210',
  payerName: 'Synthetic Payer',
  passport: 'Z1000001',
  selling: SELLING,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export type Item = { type: string; facts: unknown; budget?: string | null; participants?: number[] };
export type Drafted = { versionId: string; rowVersion: number; itemIds: string[]; deal: string };
export type Booked = Drafted & { tasks: Array<{ id: string; department: string; serviceType: string; itemId: string }> };
export type Plan = Array<{ seq: number; label: string; amountPaise: string; dueDate: string }>;

export const FLIGHT_ITEM: Item = { type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' };
export const HOTEL_ITEM: Item = { type: 'hotel', facts: HOTEL, budget: '20000000' };
export const TRANSFER_ITEM: Item = { type: 'transfer', facts: TRANSFER, budget: '8000000' };
export const ACTIVITY_ITEM: Item = { type: 'activity', facts: ACTIVITY, budget: '1200000' };
export const VISA_ITEM: Item = { type: 'visa', facts: STICKER, budget: '0' };
export const PASSPORT_ITEM: Item = { type: 'passport', facts: PASSPORT, budget: '0' };
/** A hotel whose stay ended five days ago and the matching past trip (originals turn missing, section 4.5). */
export const PAST_HOTEL_ITEM: Item = { type: 'hotel', facts: { ...HOTEL, checkIn: dayFrom(-10), checkOut: dayFrom(-5) }, budget: '20000000' };
export const PAST_TRIP = { start: dayFrom(-10), end: dayFrom(-5) };
export { CONTACT, HOTEL, TRAVELLERS, TRIP, nextPnr, nextTicket };

export function accHelpers(getDb: () => TestDb) {
  const fh = flightHelpers(getDb);
  const fin = financeHelpers(getDb);
  const cl = claimHelpers(getDb);
  const db = () => getDb();
  const { one, owner, run } = fh;

  /** Refusal whose message is exactly the token (and SQLSTATE when given). */
  async function refused(actor: Actor, sql: string, params: unknown[], token: string, code?: string): Promise<void> {
    await expectDbError(db(), () => run(actor, sql, params), { message: new RegExp(`^${token}$`), ...(code ? { code } : {}) });
  }
  /** Refusal with message and hint; returns the hint. */
  async function refusedHint(actor: Actor, sql: string, params: unknown[], token: string, hint?: RegExp, code?: string): Promise<string> {
    await db().exec('savepoint acc_hint');
    let error: { code?: string; message?: string; hint?: string } | undefined;
    try {
      await run(actor, sql, params);
    } catch (e) {
      error = e as { code?: string; message?: string; hint?: string };
      await db().exec('rollback to savepoint acc_hint');
      await resetActor(db());
    }
    if (error === undefined) throw new Error(`expected ${token}, but the statement succeeded`);
    expect(error.message, `hint: ${error.hint ?? ''}`).toBe(token);
    if (code) expect(error.code).toBe(code);
    if (hint) expect(error.hint ?? '').toMatch(hint);
    return error.hint ?? '';
  }
  /** Runs a statement inside a savepoint: the value, or the error (the transaction stays usable). */
  async function attempt<T = unknown>(actor: Actor, sql: string, params: unknown[] = []):
    Promise<{ ok: true; value: T } | { ok: false; error: string; code?: string; hint?: string }> {
    await db().exec('savepoint acc_attempt');
    try {
      const value = await one<T>(actor, sql, params);
      await db().exec('release savepoint acc_attempt');
      return { ok: true, value };
    } catch (e) {
      await db().exec('rollback to savepoint acc_attempt');
      await resetActor(db());
      const err = e as { message: string; code?: string; hint?: string };
      return { ok: false, error: err.message, code: err.code, hint: err.hint };
    }
  }

  const entityId = fin.entityId;
  const branchId = fin.branchId;
  const addRole = fh.addRole;
  /** Second Accounts person (Visa Jodhpur): receipts recorded by ACC are verified by ACC2. */
  const addAcc2 = () => addRole(U.visaJodhpur, 'accounts');
  /** Third Accounts person (Invited Staff, activated): the synthetic exception owner. */
  const addAcc3 = () => addRole(U.invitedStaff, 'accounts');
  async function dropRole(user: string, role: string): Promise<void> {
    await resetActor(db());
    await owner(`update public.memberships set status = 'inactive' where user_id = $1 and role_code = $2`, [user, role]);
  }

  /** Owner SQL: service items and visa/passport task creation on (live has both On). */
  async function switchesOn(): Promise<void> {
    await resetActor(db());
    await owner('update public.workflow_settings set service_items_enabled = true, visa_passport_tasks_enabled = true where id');
  }

  /**
   * A complete booking draft on `deal` with the given items: travellers, selling
   * total, trip, contact and billing proposal, participants (every traveller;
   * the first one on a passport item), the instalment plan, identities when a
   * visa/passport item is present, a stored screenshot for screenshot flights
   * and the acceptance proof. ID proofs only when `idProofs` (default true).
   */
  async function draft(items: Item[], opts: { deal?: string; actor?: Actor; travellers?: unknown; idProofs?: boolean | number[]; plan?: Plan;
    selling?: string; scope?: 'domestic' | 'international'; trip?: Record<string, unknown> } = {}): Promise<Drafted> {
    const actor = opts.actor ?? OWNER;
    const deal = opts.deal ?? DEAL;
    const selling = opts.selling ?? SELLING;
    await switchesOn();
    const opened = await fh.openDraft(actor, deal);
    let rv = opened.rowVersion;
    const itemIds: string[] = [];
    for (const item of items) {
      const added = await fh.addItem(actor, opened.versionId, rv, item.type, item.facts, item.budget === undefined ? '0' : item.budget);
      rv = added.rowVersion;
      itemIds.push(added.itemId);
    }
    rv = (await fh.saveTravellers(actor, deal, rv, opts.travellers ?? TRAVELLERS)).rowVersion;
    rv = (await fh.saveSelling(actor, opened.versionId, rv, selling)).rowVersion;
    rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
      [opened.versionId, rv, JSON.stringify({ ...TRIP, ...(opts.scope === 'international' ? { scope: 'international' } : {}), ...(opts.trip ?? {}) })])).rowVersion;
    const billingRow = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
    rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r',
      [opened.versionId, rv, JSON.stringify(CONTACT), billingRow.length ? null : JSON.stringify({
        billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08',
        postalCode: '342001', gstin: null }), 0, rid()])).rowVersion;
    const seqs = (await owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [deal])).map((t) => t.seq);
    for (const [i, item] of items.entries()) {
      const who = item.participants ?? (item.type === 'passport' ? seqs.slice(0, 1) : seqs);
      rv = (await one<{ rowVersion: number }>(actor, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
        [itemIds[i], opened.versionId, rv, who])).rowVersion;
    }
    const plan = opts.plan ?? [{ seq: 1, label: 'Full payment', amountPaise: selling, dueDate: dayFrom(30) }];
    rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
      [opened.versionId, rv, JSON.stringify(plan)])).rowVersion;
    if (items.some((i) => i.type === 'visa' || i.type === 'passport')) {
      for (const seq of seqs) {
        await fh.saveIdentity(actor, deal, seq, 0, { dateOfBirth: '1990-05-17', nationality: 'Indian', passportNumber: `Z${1000000 + seq}`,
          passportExpiry: '2030-01-31' });
      }
    }
    const proofSeqs = opts.idProofs === false ? [] : Array.isArray(opts.idProofs) ? opts.idProofs : seqs;
    for (const seq of proofSeqs) await fh.storeIdProof(actor, deal, seq);
    for (const [i, item] of items.entries()) {
      if (item.type === 'flight' && (item.facts as { entryMode?: string }).entryMode === 'screenshot') {
        await fh.storeScreenshot(actor, itemIds[i]!, opened.versionId);
      }
    }
    await fh.storeEvidence(actor, opened.versionId);
    const versionRv = (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [opened.versionId]))[0]!.row_version;
    return { versionId: opened.versionId, rowVersion: versionRv, itemIds, deal };
  }

  /** Confirms a ready draft (asserts no readiness issue). */
  async function confirmDraft(d: Drafted, actor: Actor = OWNER): Promise<Booked> {
    const ready = await fh.readiness(actor, d.versionId);
    expect(ready.issues, 'synthetic booking ready to confirm').toEqual([]);
    await fh.confirm(actor, d.versionId, ready.contentHash);
    const tasks = await owner<{ id: string; department: string; service_type: string; item_id: string }>(
      `select t.id, t.department, i.service_type, i.id as item_id from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
       where t.deal_id = $1 order by i.item_no, t.id`, [d.deal]);
    return { ...d, tasks: tasks.map((t) => ({ id: t.id, department: t.department, serviceType: t.service_type, itemId: t.item_id })) };
  }
  const book = async (items: Item[], opts: Parameters<typeof draft>[1] = {}) => confirmDraft(await draft(items, opts), opts.actor ?? OWNER);
  const taskOf = (b: Booked, type: string, n = 0) => b.tasks.filter((t) => t.serviceType === type)[n]!.id;

  /** Accounts approval as the owner would record it (SYNTHETIC FIXTURE STEP; the real command is tested in acc-dues). */
  async function approve(versionId: string): Promise<void> {
    await resetActor(db());
    await owner(
      `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
       select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1
       on conflict (booking_version_id) do update set status = 'approved', reviewed_by = excluded.reviewed_by, reviewed_at = now(),
         row_version = public.accounts_booking_reviews.row_version + 1`,
      [versionId, U.accountsJodhpur],
    );
  }
  /** The real Accounts approval: billing saved and verified by ACC, then accounts_review_approve. */
  async function approveReal(versionId: string, deal: string = DEAL): Promise<void> {
    const [billing] = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
    const saved = await one<{ rowVersion: number }>(ACC, SQL.billingSave, [deal, billing?.row_version ?? 0, JSON.stringify({
      billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08',
      postalCode: '342001', gstin: null }), rid()]);
    await one(ACC, SQL.billingVerify, [deal, saved.rowVersion, rid()]);
    const [review] = await owner<{ row_version: number }>('select row_version from public.accounts_booking_reviews where booking_version_id = $1', [versionId]);
    await one(ACC, SQL.reviewApprove, [versionId, review?.row_version ?? 0, rid()]);
  }

  /** Purchase supplier with approved bank details (Manager approves the beneficiary). */
  async function purchaseSupplier(): Promise<string> {
    const { supplierId } = await one<{ supplierId: string }>(PURCHASE, SQL.supplierCreate, [await entityId(), JSON.stringify({
      name: `Synthetic Stays ${rid().slice(0, 8)}`, serviceTypes: ['hotel', 'transfer', 'activity'], city: 'Synthetic City', contactName: null,
      contactPhone: null, contactEmail: 'desk@example.test', paymentTerms: null })]);
    const bank = await one<{ revisionNo: number }>(PURCHASE, SQL.supplierBeneficiary, [supplierId, rid(), JSON.stringify({
      accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' })]);
    await one(MANAGER, SQL.supplierApproveBeneficiary, [supplierId, bank.revisionNo]);
    return supplierId;
  }
  /** Purchase takes the task and proposes the cost with `supplierId`'s quote (version 1). */
  async function purchaseCost(taskId: string, supplierId: string, cost = '10000000', actor: Actor = PURCHASE): Promise<void> {
    await one(actor, SQL.purchaseClaim, [taskId]);
    const { quoteId } = await one<{ quoteId: string }>(actor, SQL.quoteAdd, [taskId, rid(), JSON.stringify({ supplierId,
      hotelName: 'Synthetic Hotel (fixture)', roomType: null, mealPlan: null, quotedCostPaise: cost, holdUntil: null, cancellationTerms: null })]);
    await one(actor, SQL.costPropose, [taskId, quoteId, 0, cost, null, null, rid()]);
  }
  /** Booking request sent and the go-ahead approved by Accounts. */
  async function goAhead(taskId: string, approveIt = true): Promise<void> {
    await one(PURCHASE, SQL.bookingRequestSend, [taskId, 1, 'desk@example.test', [], 'Booking request · SYN · Synthetic', 'Synthetic body.', rid()]);
    if (!approveIt) return;
    const [g] = await owner<{ id: string; row_version: number }>(
      `select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`, [taskId]);
    await one(ACC, SQL.goAheadDecide, [g!.id, 'approve', null, g!.row_version, rid()]);
  }
  /** Whole Purchase path up to supplier confirmation (needs an approved review). */
  async function supplierConfirmed(taskId: string, supplierId?: string): Promise<string> {
    const s = supplierId ?? await purchaseSupplier();
    await purchaseCost(taskId, s);
    await goAhead(taskId);
    await confirmSupplier(taskId);
    return s;
  }
  /** Supplier confirmation proof stored and purchase_supplier_confirm (cost version 1, go-ahead already approved). */
  async function confirmSupplier(taskId: string): Promise<void> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(PURCHASE, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
      [taskId, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, sha()]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    await one(PURCHASE, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
    await one(PURCHASE, SQL.supplierConfirm, [taskId, 1, 'SYN-CONF-0001']);
  }
  /** SYNTHETIC FIXTURE STEP: a task taken by `user` and completed (owner SQL, two legal status moves). */
  async function completeTask(taskId: string, user: string): Promise<void> {
    await resetActor(db());
    await owner(`update public.fulfilment_tasks set status = 'in_progress', assignee_user_id = $2 where id = $1 and status <> 'in_progress'`, [taskId, user]);
    await owner(`update public.fulfilment_tasks set status = 'completed', completed_by = $2, completed_at = now() where id = $1`, [taskId, user]);
  }
  /** Stored supplier-money file of `kind` on `target` (task or request). */
  async function moneyFile(actor: Actor, target: string, kind: string): Promise<string> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(actor, SQL.smEvidenceBegin,
      [kind, target, `${kind}.pdf`, 'application/pdf', 2048, sha(), rid()]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    await one(actor, SQL.smEvidenceFinish, [ev.evidenceId, true]);
    return ev.evidenceId;
  }
  /** Purchase payment request (deposit) on a costed task. */
  async function purchaseRequest(taskId: string, amount: number, extra: Record<string, unknown> = {}, actor: Actor = PURCHASE) {
    const proforma = await moneyFile(actor, taskId, 'proforma');
    return one<{ id: string; route: string; refNo: string; rowVersion: number }>(actor, SQL.paymentCreate, [taskId, JSON.stringify({
      expectedCostVersionNo: 1, part: 'deposit', amountPaise: String(amount), dueDate: null, note: null, proformaEvidenceId: proforma,
      askFunding: false, ...extra }), rid()]);
  }
  const paymentRv = async (id: string) =>
    (await owner<{ v: number }>('select row_version as v from public.supplier_payment_requests where id = $1', [id]))[0]!.v;
  /** Approve (by route), record (ACC) and verify (ACC2) a supplier payment request. */
  async function payThrough(paymentId: string, until: 'approved' | 'paid' | 'verified' = 'verified', approver: Actor = ACC): Promise<void> {
    await one(approver, SQL.paymentDecide, [paymentId, 'approve', null, await paymentRv(paymentId), rid()]);
    if (until === 'approved') return;
    const proof = await moneyFile(ACC, paymentId, 'payment_proof');
    await one(ACC, SQL.paymentRecord, [paymentId, today(), 'bank_transfer', `SYNREF${rid().slice(0, 6)}`, proof, await paymentRv(paymentId), rid()]);
    if (until === 'paid') return;
    await one(ACC2, SQL.paymentVerify, [paymentId, await paymentRv(paymentId), rid()]);
  }

  /** Supplier invoice / credit note upload on a Purchase task (agreed quote's supplier). */
  async function uploadDoc(taskId: string, fields: { kind?: 'invoice' | 'credit_note'; number: string; docDate?: string; totalPaise?: string;
    creditsDocumentId?: string }, actor: Actor = PURCHASE, requestId: string = rid()) {
    const kind = fields.kind ?? 'invoice';
    const evidenceId = await moneyFile(actor, taskId, kind);
    const body: Record<string, unknown> = { kind, number: fields.number, docDate: fields.docDate ?? today(), totalPaise: fields.totalPaise ?? '10000000',
      gstIncluded: true, evidenceId };
    if (fields.creditsDocumentId) body.creditsDocumentId = fields.creditsDocumentId;
    return one<{ outcome: string; id: string; status: string; rowVersion: number }>(actor, SQL.docUpload, [taskId, JSON.stringify(body), requestId]);
  }
  const docRv = async (id: string) => (await owner<{ v: number }>('select row_version as v from public.supplier_documents where id = $1', [id]))[0]!.v;
  const reviewDoc = async (id: string, decision: 'accept' | 'return', reason: string | null = null, actor: Actor = ACC) =>
    one(actor, SQL.docReview, [id, decision, reason, await docRv(id), rid()]);

  /** Flight: people, a package-or-flight-only Deal is booked by the caller; group claim, supplier with bank, one batch for `seqs`. */
  async function flightBatch(deal: string, seqs: number[] = [1], opts: { supplierId?: string; tickets?: Record<number, Record<string, string>> } = {}) {
    await fh.addFlightPeople();
    const flightTask = (await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight' order by created_at, id`,
      [deal]))[0]!.id;
    const assignee = (await owner<{ a: string | null }>('select assignee_user_id as a from public.fulfilment_tasks where id = $1', [flightTask]))[0]!.a;
    if (!assignee) await fh.claim(FLIGHT, deal);
    const [leg] = await fh.sectors(flightTask);
    const supplierId = opts.supplierId ?? await fh.flightSupplier();
    if (!opts.supplierId) await fh.approvedBank(supplierId);
    const batch = await fh.confirmTickets({ deal, sectorIds: [leg!.id], supplierId, seqs, tickets: opts.tickets as never });
    return { ...batch, supplierId, flightTask, legId: leg!.id };
  }

  /** Workspace page as `actor` (null when refused by the fence). */
  const records = (actor: Actor, filter: Record<string, unknown> = {}, after: string | null = null, limit = 100) =>
    one<WorkPage | null>(actor, SQL.records, [JSON.stringify(filter), after, limit]);
  /** Every workspace row across pages (asserts each page is non-null). */
  async function allRecords(actor: Actor, filter: Record<string, unknown> = {}, limit = 100): Promise<WorkRow[]> {
    const out: WorkRow[] = [];
    let after: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const page: WorkPage | null = await records(actor, filter, after, limit);
      expect(page, 'workspace page').not.toBeNull();
      out.push(...page!.items);
      if (!page!.nextAfter) break;
      after = page!.nextAfter;
    }
    return out;
  }
  const rowsOf = (rows: WorkRow[], kind: string) => rows.filter((r) => r.kind === kind);

  /** Journal entry ids of a receipt (by kind). */
  const entryOf = async (receiptId: string, kindLike = 'receipt_%') =>
    (await owner<{ id: string }>('select id from public.finance_journal_entries where receipt_id = $1 and kind like $2 order by posted_at, id',
      [receiptId, kindLike]))[0]?.id;
  const tallyRow = async (kind: string, id: string) => (await owner<Record<string, unknown> & { row_version: number; status: string }>(
    'select * from public.tally_records where record_kind = $1 and record_id = $2', [kind, id]))[0];
  const audits = (action: string) => owner<{ target_type: string; target_id: string; details: Record<string, unknown>; reason: string | null }>(
    'select target_type, target_id::text, details, reason from public.audit_events where action = $1 order by id', [action]);

  /** Tally export switched on for the entity by the policy manager (SUPER). */
  async function exportOn(): Promise<void> {
    await one(SUPER, SQL.setTallyExport, [await entityId(), true, REASON]);
  }

  /** Notices kill switch (owner SQL; the admin command is tested in acc-notices). */
  async function noticesOn(on = true): Promise<void> {
    await resetActor(db());
    await owner('update public.notice_settings set notices_enabled = $1 where id', [on]);
  }
  type NoticeRow = { id: string; seq: string; recipient_user_id: string; kind: string; priority: string; deal_id: string | null; task_id: string | null;
    subject_kind: string; subject_id: string; params: Record<string, unknown>; dedup_key: string; shared_key: string | null; actor_user_id: string | null;
    read_at: string | null; done_at: string | null; resolved_at: string | null; resolved_reason: string | null };
  const notices = (kind?: string, recipient?: string) => owner<NoticeRow>(
    `select id, seq::text, recipient_user_id, kind, priority, deal_id, task_id, subject_kind, subject_id, params, dedup_key, shared_key, actor_user_id,
            read_at, done_at, resolved_at, resolved_reason
     from public.staff_notices where ($1::text is null or kind = $1) and ($2::uuid is null or recipient_user_id = $2) order by seq`,
    [kind ?? null, recipient ?? null]);
  const recipientsOf = async (kind: string, subjectId?: string) =>
    (await notices(kind)).filter((n) => !subjectId || n.subject_id === subjectId || n.task_id === subjectId || n.deal_id === subjectId)
      .map((n) => n.recipient_user_id).sort();
  const inbox = (actor: Actor, after: number | null = null, limit = 100) => one<Inbox>(actor, SQL.inbox, [after, limit]);

  /** Verified bank receipt on `deal` (recorded by ACC, verified by ACC2, collecting branch `branch`). */
  async function receipt(deal: string, amount: string, over: Record<string, unknown> = {}) {
    const fields = await fin.bankFields({ amountPaise: amount, ...over });
    const rec = await fin.record(ACC, deal, fields);
    await fin.proof(ACC, 'receipt', rec.id, 'bank_proof');
    await fin.verify(ACC2, rec.id);
    return rec;
  }

  /**
   * One Deal (DEAL, Delhi; hotel + flight + sticker visa, approved) with one
   * record of every workspace source (section 8.1 kind list). Second Accounts
   * person ACC2; the visa desk person is Sales Ahmedabad + Visa (VISA_DESK).
   * Collected-elsewhere cash (JDH) for AL8. Returns every id the suites need.
   */
  async function everyKind() {
    await addAcc2();
    await fh.addFlightPeople();
    await addRole(U.salesAhmedabad, 'visa');
    const b = await book([HOTEL_ITEM, FLIGHT_ITEM, { ...VISA_ITEM, participants: [1] }]);
    await approve(b.versionId);
    // Customer money: bank (collected DEL) and cash collected by the Jodhpur branch.
    const bank = await receipt(DEAL, '2500000');
    const cash = await fin.record(ACC, DEAL, await fin.cashFields({ amountPaise: '1000000' }));
    await fin.verify(ACC2, cash.id);
    const pending = await fin.record(ACC, DEAL, await fin.bankFields({ amountPaise: '700000' }));
    const reversed = await receipt(DEAL, '300000');
    await fin.reverse(ACC, reversed.id, 'data_error');
    const claim = await cl.report(OWNER, await cl.bankClaim({ amountPaise: '400000' }));
    // Cash deposit of the Jodhpur cash (verified by ACC2) and a cash count.
    const jdh = await branchId('JDH');
    const slip = await fin.proof(ACC, 'branch', jdh, 'deposit_slip');
    const deposit = await one<{ id: string }>(ACC, 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r',
      [jdh, [cash.id], today(), 'SYN-SLIP-01', slip, rid()]);
    await one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [deposit.id, rid()]);
    const count = await one<{ id: string }>(ACC, 'select public.cash_reconciliation_record($1, $2::date, $3::bigint, $4, $5) as r',
      [jdh, today(), '0', null, rid()]);
    // Purchase: a verified supplier payment, a funded request, an invoice and a credit note.
    const hotelTask = taskOf(b, 'hotel');
    const supplierId = await purchaseSupplier();
    await purchaseCost(hotelTask, supplierId);
    await goAhead(hotelTask);
    const paid = await purchaseRequest(hotelTask, 2_000_000);
    await payThrough(paid.id, 'verified');
    const funded = await purchaseRequest(hotelTask, 3_000_000, { fundingReason: 'Synthetic funding reason: customer transfer delayed' });
    const [funding] = await owner<{ id: string }>('select id from public.company_funding_requests where payment_request_id = $1', [funded.id]);
    const invoice = await uploadDoc(hotelTask, { number: 'SYN/INV-001', totalPaise: '10000000' });
    const credit = await uploadDoc(hotelTask, { kind: 'credit_note', number: 'SYN/CN-001', totalPaise: '100000' });
    // Flight: one ticket batch (PNRs and ticket number) with a company direct payment (expense).
    const pnr = nextPnr();
    const ticket = nextTicket();
    const batch = await flightBatch(DEAL, [1], { tickets: { 1: { airlinePnr: pnr, ticketNumber: ticket } } });
    await fh.directPay(batch.batchId);
    const [flightExpense] = await owner<{ id: string }>('select id from public.department_cost_entries where flight_batch_id = $1', [batch.batchId]);
    // Visa: applied with a company-paid fee and no receipt (draft fee -> fee receipt original).
    const vh = visaHelpers(getDb);
    const visaTask = taskOf(b, 'visa');
    await one(VISA_DESK, 'select public.visa_task_claim($1) as r', [visaTask]);
    const a = await vh.makeReady(visaTask, 1, { actor: VISA_DESK });
    await vh.apply(visaTask, [visaLine(a)], {}, rid(), VISA_DESK);
    const [application] = await owner<{ id: string; reference: string }>(
      'select id, reference from public.visa_applications where task_id = $1 and submitted_at is not null', [visaTask]);
    const [visaFee] = await owner<{ id: string }>(`select id from public.department_cost_entries where task_id = $1 and paid_by = 'company'`, [visaTask]);
    // Deal Tally GST invoice reference (T4).
    const gst = await one<{ tallyInvoiceId?: string; id?: string }>(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({
      invoiceRef: 'HC/25-26/0042', invoiceDate: today(), note: null }), rid()]);
    return {
      booked: b, bank, cash, pending, reversed, claim, deposit, count, hotelTask, supplierId, paid, funded, funding: funding?.id,
      invoice, credit, batch, pnr, ticket, flightExpense: flightExpense?.id, visaTask, application, visaFee: visaFee?.id,
      gstId: gst.tallyInvoiceId ?? gst.id,
    };
  }

  /**
   * SYNTHETIC FIXTURE STEP (owner SQL): `n` copies of a verified bank receipt
   * on `deal` with their receipt_bank journal entries (balanced lines), all
   * Tally-ready, for the 10,000-row export limit (T8). Copies the template
   * row's columns so every table check still applies.
   */
  async function bulkReadyEntries(deal: string, n: number): Promise<void> {
    const template = await receipt(deal, '100');
    await resetActor(db());
    const cols = (await owner<{ c: string }>(
      `select string_agg(quote_ident(column_name), ', ' order by ordinal_position) as c from information_schema.columns
       where table_schema = 'public' and table_name = 'customer_receipts' and is_generated = 'NEVER'
         and column_name not in ('id', 'receipt_no', 'request_id', 'reference', 'reference_norm')`))[0]!.c;
    await owner(`create temporary table acc_bulk on commit drop as
      select gen_random_uuid() as id, g as n from generate_series(1, $1::int) g`, [n]);
    await owner(`insert into public.customer_receipts (id, receipt_no, request_id, reference, reference_norm, ${cols})
      select b.id, 'R-2026-27-' || lpad((900000 + b.n)::text, 6, '0'), gen_random_uuid(), 'SYNBULK' || lpad(b.n::text, 8, '0'), 'SYNBULK' || lpad(b.n::text, 8, '0'), ${cols.split(', ').map((c) => `r.${c}`).join(', ')}
      from acc_bulk b cross join public.customer_receipts r where r.id = $1`, [template.id]);
    await owner(`insert into public.finance_journal_entries (id, legal_entity_id, kind, receipt_id, deal_id, branch_id, business_date, posted_by)
      select b.id, r.legal_entity_id, 'receipt_bank', b.id, r.deal_id, r.branch_id, r.received_on, r.recorded_by
      from acc_bulk b join public.customer_receipts r on r.id = b.id`);
    await owner(`insert into public.finance_journal_lines (entry_id, account, deal_id, branch_id, debit_paise, credit_paise)
      select e.id, x.account, e.deal_id, e.branch_id, x.d, x.c
      from acc_bulk b join public.finance_journal_entries e on e.id = b.id
      cross join (values ('bank', 100::bigint, 0::bigint), ('customer_advances', 0::bigint, 100::bigint)) x(account, d, c)`);
  }

  return {
    ...fh, fin, cl, refused, refusedHint, attempt, entityId, branchId, addRole, addAcc2, addAcc3, dropRole, switchesOn, draft, confirmDraft, book,
    taskOf, approve, approveReal, completeTask, confirmSupplier, purchaseSupplier, purchaseCost, goAhead, supplierConfirmed, moneyFile, purchaseRequest, paymentRv, payThrough,
    uploadDoc, docRv, reviewDoc, flightBatch, records, allRecords, rowsOf, entryOf, tallyRow, audits, exportOn, noticesOn, notices, recipientsOf,
    inbox, receipt, everyKind, bulkReadyEntries, insertApprovedDestination: (deal: string, kind: 'bank' | 'upi') => insertApprovedDestination(db(), deal, kind),
  };
}

export { setActor };
