import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { ACC2_FIXTURE_USERS as U2, type Actor, FIXTURE_USERS as U, type TestDb, activateAcc2People, resetActor } from '../helpers/db';
import {
  ACC, ACC2, DEAL, FLIGHT, HOTEL_ITEM, MANAGER, MANAGER_AMD, OWNER, PURCHASE, REASON, SUPER, type Booked, type Item, accHelpers, rid, sha, today,
} from './acc-support';

/**
 * Accounts Phase 2 (contract accounts-phase2-2026-11-11/contract.md, frozen
 * 11 Nov 2026, with Addenda L1 and L2), Track F: shared helpers for
 * tests/db/acc2-*.test.ts. Written FROM THE CONTRACT (sections 4-10, 12),
 * NOT from the Track A-E code: every command and read is called with the
 * positional signature the contract freezes.
 *
 * Gating: each suite is skipped (with a reason vitest prints) until the
 * contract objects it needs exist in a Phase 2 migration file
 * (20261204000100 and later). `landed(...)` scans those files' text, so the
 * suites switch on by themselves as each track lands.
 *
 * Actors: the Phase 1 synthetic actors of acc-support.ts. Until the lead adds
 * the Phase 2 fixtures (contract section 15: second and third Accounts
 * person per entity, a Manager per branch plus a second Jodhpur Manager, a
 * Manager holding Flight, a Deal without active Sales owner, Flight and Visa
 * people), the suites give existing synthetic users an extra membership
 * inside the rolled-back transaction (addRole), as Phase 1 did. Recipient
 * assertions use "contains" / "does not contain" so extra seeded staff never
 * break them (Phase 1 lesson).
 *
 * Addendum L2: supplier kind values are 'direct' and 'channel'.
 * Addendum L1: supplier refunds are recorded and verified in one step;
 * supplier_refund_cancel replaces verify/reject; notice kind 34 is dropped.
 */

// ---------------------------------------------------------------------------
// Gating on landed migrations
// ---------------------------------------------------------------------------
const migrationsDir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
let phase2Text: string | null = null;
/** Text of every Phase 2 migration (20261204000100 and later), comments included. */
export function phase2Sql(): string {
  if (phase2Text === null) {
    phase2Text = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && f >= '20261204000100')
      .sort()
      .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
      .join('\n');
  }
  return phase2Text;
}
/**
 * True when every named object is created by a Phase 2 migration: a function
 * (`create [or replace] function public.|authz.<name>(`) or a table
 * (`create table [if not exists] public.<name>`). A name with a dot
 * (`table.column`) checks an `add column [if not exists] <column>` line.
 */
export function landed(...names: string[]): boolean {
  const text = phase2Sql();
  return names.every((name) => {
    if (name.includes('.')) {
      const col = name.split('.')[1]!;
      return new RegExp(`add\\s+column\\s+(if\\s+not\\s+exists\\s+)?${col}\\b`, 'i').test(text);
    }
    return new RegExp(`create\\s+(or\\s+replace\\s+)?(function|table|view)\\s+(if\\s+not\\s+exists\\s+)?(public|authz)\\.${name}\\b`, 'i').test(text);
  });
}
/** Reason vitest prints for a skipped Phase 2 suite. */
export const waits = (track: string, ...names: string[]) => `waits for Track ${track} (${names.join(', ')} not in a 20261204* migration yet)`;

// ---------------------------------------------------------------------------
// Contract signatures (positional, contract order)
// ---------------------------------------------------------------------------
export const SQL2 = {
  // Track A (5.5-5.7, 13.3)
  supplierCreate: 'select public.supplier_create($1, $2::jsonb) as r',
  supplierUpdate: 'select public.supplier_update($1, $2, $3::jsonb) as r',
  flightSupplierCreate: 'select public.flight_supplier_create($1::jsonb, $2) as r',
  flightSupplierUpdate: 'select public.flight_supplier_update($1, $2, $3::jsonb) as r',
  contactSave: 'select public.supplier_contact_save($1, $2, $3, $4::jsonb, $5) as r',
  contactRemove: 'select public.supplier_contact_remove($1, $2, $3, $4) as r',
  hotelLink: 'select public.supplier_hotel_link($1, $2, $3) as r',
  hotelUnlink: 'select public.supplier_hotel_unlink($1, $2, $3) as r',
  register: 'select public.supplier_register($1::jsonb, $2, $3) as r',
  masterGet: 'select public.supplier_master_get($1) as r',
  hotelSuppliers: 'select public.hotel_suppliers($1) as r',
  nameKey: 'select authz.supplier_name_key($1) as k',
  nearDuplicates: 'select authz.supplier_near_duplicates($1, $2, $3, $4, $5, $6, $7, $8) as r',
  quoteAdd: 'select public.purchase_quote_add($1, $2, $3::jsonb) as r',
  workspace: 'select public.purchase_workspace($1) as r',
  formGet: 'select public.booking_form_get($1) as r',
  importStage: 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7) as r',
  importValidate: 'select public.import_batch_validate($1) as r',
  importApply: 'select public.import_batch_apply($1, $2, $3, $4) as r',
  importGet: 'select public.import_batch_get($1, $2, $3) as r',
  importCancel: 'select public.import_batch_cancel($1, $2) as r',
  // Track B (6.7, 6.9)
  draftCreate: 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
  docRefresh: 'select public.customer_document_refresh($1, $2, $3) as r',
  docRelease: 'select public.customer_document_release($1, $2, $3, $4) as r',
  docDiscard: 'select public.customer_document_discard($1, $2, $3, $4) as r',
  docCancel: 'select public.customer_document_cancel($1, $2, $3, $4) as r',
  docReplace: 'select public.customer_document_replace($1, $2, $3, $4) as r',
  docLinkTally: 'select public.customer_document_link_tally($1, $2, $3, $4) as r',
  docRenderRetry: 'select public.customer_document_render_retry($1, $2) as r',
  setDocsEnabled: 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r',
  docDownload: 'select public.customer_document_authorize_download($1) as r',
  renderClaim: 'select public.customer_document_render_claim($1, $2) as r',
  renderInput: 'select public.customer_document_render_input($1, $2) as r',
  renderComplete: 'select public.customer_document_render_complete($1, $2, $3, $4, $5::jsonb) as r',
  dealDocs: 'select public.deal_customer_documents($1) as r',
  docGet: 'select public.customer_document_get($1) as r',
  docsList: 'select public.customer_documents_list($1::jsonb, $2, $3) as r',
  // Track C (7.3, 7.5, Addendum L1)
  refundCreate: 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r',
  refundResubmit: 'select public.customer_refund_request_resubmit($1, $2, $3::jsonb, $4) as r',
  refundWithdraw: 'select public.customer_refund_request_withdraw($1, $2, $3, $4) as r',
  refundDecide: 'select public.customer_refund_decide($1, $2, $3::bigint, $4::bigint, $5, $6, $7) as r',
  refundEvidenceBegin: 'select public.refund_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
  refundEvidenceFinish: 'select public.refund_evidence_finish($1, $2) as r',
  refundEvidenceDownload: 'select public.refund_evidence_authorize_download($1) as r',
  payout: 'select public.customer_refund_payout_record($1, $2, $3::jsonb, $4) as r',
  supplierRefundRecord: 'select public.supplier_refund_record($1::jsonb, $2) as r',
  supplierRefundCancel: 'select public.supplier_refund_cancel($1, $2, $3, $4) as r',
  flightChargeSet: 'select public.flight_cancellation_charge_set($1, $2::jsonb, $3, $4) as r',
  visaChoice: 'select public.visa_application_cancellation_choice($1, $2, $3, $4, $5) as r',
  visaFeeSet: 'select public.visa_cancellation_fee_set($1, $2::bigint, $3, $4, $5) as r',
  setRefundsEnabled: 'select public.admin_set_refunds_enabled($1, $2, $3) as r',
  dealRefunds: 'select public.deal_refunds($1) as r',
  refundList: 'select public.refund_requests_list($1::jsonb, $2, $3) as r',
  supplierRefundsDue: 'select public.supplier_refunds_due($1::jsonb, $2, $3) as r',
  // Cancellation (existing signatures)
  cancelOpen: 'select public.deal_cancellation_open($1, $2, $3) as r',
  chargeSet: 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r',
  cancelSend: 'select public.deal_cancellation_send($1, $2, $3) as r',
  cancelDecide: 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r',
  cancelSummary: 'select public.deal_cancellation_summary($1) as r',
  managerCancellations: 'select public.manager_cancellation_list() as r',
  flightMoney: 'select public.flight_money($1) as r',
  visaWorkspace: 'select public.visa_workspace($1) as r',
  costSave: 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r',
  feeSend: 'select public.visa_fee_send($1, $2, $3::jsonb, $4) as r',
  dealDues: 'select public.deal_dues($1) as r',
  payables: 'select public.accounts_supplier_payables($1) as r',
  // Track D (8.1, 8.2, 8.5)
  mappingList: 'select public.tally_mapping_list($1) as r',
  mappingSet: 'select public.tally_mapping_set($1, $2, $3::jsonb, $4, $5) as r',
  exportCreate: 'select public.accounts_tally_export_create($1::jsonb, $2) as r',
  exportLines: 'select public.accounts_tally_export_lines($1, $2, $3) as r',
  setTallyExport: 'select public.admin_set_tally_export_enabled($1, $2, $3) as r',
  prefsGet: 'select public.notice_preferences_get() as r',
  prefsSet: 'select public.notice_preferences_set($1::jsonb) as r',
  inbox: 'select public.notice_inbox($1::bigint, $2) as r',
} as const;

// ---------------------------------------------------------------------------
// Frozen vocabularies
// ---------------------------------------------------------------------------
/** Section 8.3 new notice kinds (34 dropped by Addendum L1). */
export const NEW_NOTICE_KINDS = [
  'refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid', 'document_to_release', 'document_to_check', 'credit_note_to_release',
  'supplier_refund_due', 'cancellation_to_approve', 'flight_charges_to_enter', 'visa_cancel_decide', 'refund_to_request',
] as const;
/** Section 8.1 row kinds and service classes. */
export const MAPPING_ROW_KINDS = [
  'receipt_bank', 'receipt_cash', 'receipt_reversal', 'cash_deposit', 'customer_refund_bank', 'customer_refund_cash', 'supplier_payment', 'supplier_invoice',
  'supplier_credit_note', 'expense', 'customer_advance_invoice', 'customer_invoice', 'customer_credit_note', 'supplier_refund', 'tally_gst_invoice',
  // Accounts phase 3 (contract 7.1 / 7.2, Addendum L5; 16.6 setup update by Track T): the two write-off Journal rows.
  'write_off_due', 'write_off_excess',
] as const;
export const SERVICE_CLASSES = ['any', 'hotel', 'transfer', 'activity', 'flight_domestic', 'flight_international', 'package_domestic', 'package_overseas',
  'visa', 'passport', 'misc'] as const;
/** Section 8.1 pre-fill: service class -> [Invoice credit ledger, Invoice voucher type, Credit-note voucher type]. */
export const PREFILL: Record<string, [string, string, string]> = {
  hotel: ['Hotel Booking', 'Hotel Invoice', 'Hotel Cn'],
  flight_domestic: ['Domestic Air Ticket', 'Domestic Tkt', 'Domestic CN'],
  flight_international: ['International Air Ticket', 'International Tkt', 'Int. Cn'],
  package_domestic: ['Domestic Package', 'Package Invoice', 'Package Cn'],
  package_overseas: ['Overseas Package', 'Package Invoice', 'Package Cn'],
  visa: ['Visa', 'Visa Inv', 'VisaCn'],
  passport: ['Passport', 'Passport Inv', 'Miscellaneous CN'],
  transfer: ['Transport', 'Transport Inv', 'Miscellaneous CN'],
  activity: ['Excursion', 'Misc Inv', 'Miscellaneous CN'],
  misc: ['Miscellaneous', 'Misc Inv', 'Miscellaneous CN'],
};
/** Section 8.1 voucher types only (ledgers stay null, LD20). */
export const PREFILL_VOUCHER_ONLY: Record<string, string> = {
  receipt_bank: 'Receipt', receipt_cash: 'Receipt', receipt_reversal: 'Journal', cash_deposit: 'Contra', supplier_payment: 'Payment',
  supplier_invoice: 'Purchase', supplier_credit_note: 'Debit Note M', expense: 'Payment', customer_refund_bank: 'Payment', customer_refund_cash: 'Payment',
  supplier_refund: 'Receipt', customer_advance_invoice: 'Receipt',
};
/** Section 8.2: the Phase 1 CSV columns with the new ones inserted after "Credit ledger hint". */
export const PHASE1_CSV = [
  'Export no', 'Line', 'Record type', 'Voucher type hint', 'Date', 'Reference', 'Deal', 'Bitrix Deal id', 'Branch', 'Party', 'Debit ledger hint',
  'Credit ledger hint', 'Amount (INR)', 'Mode', 'Bank reference', 'PAN', 'Mobile', 'GST included', 'Credit note for', 'Linked tasks',
  'Already exported on', 'Changed since last export', 'CRM record id',
];
export const NEW_CSV = ['Service', 'Tally debit ledger', 'Tally credit ledger', 'Tally voucher type', 'Mapping missing', 'Narration', 'Tally number'];
export const PHASE2_CSV = [...PHASE1_CSV.slice(0, 12), ...NEW_CSV, ...PHASE1_CSV.slice(12)];
/** Section 9 new refusal tokens and codes. */
export const NEW_TOKENS: Record<string, string> = {
  documents_off: '55000', billing_not_verified: '55000', document_stale: '40001', receipt_not_verified: '55000', has_credit_notes: '55000',
  refunds_off: '55000', refund_open_exists: '23505', refund_exceeds_money: '22023', evidence_missing: '55000', over_expected: '22023',
};
/** Document number (6.1). */
export const NUMBER_RE = /^.{1,40}-(ADV|INV|CN)-[0-9]{1,4}$/;
/** The company GSTIN (section 6.5: the existing Jodhpur value for every branch). */
export const COMPANY_GSTIN = '08AAFCH9191M1ZV';
/** Lead's Phase 2 fixture people (activate with h.people.fixtures(...)). */
export const P2 = {
  ACC_2: { userId: U2.accountsJodhpur2 } as Actor,
  ACC_3: { userId: U2.accountsJodhpur3 } as Actor,
  MANAGER_JDH: { userId: U2.managerJodhpur } as Actor,
  MANAGER_JDH_2: { userId: U2.managerJodhpur2 } as Actor,
  MANAGER_FLIGHT_DEL: { userId: U2.managerFlightDelhi } as Actor,
  FLIGHT_JDH: { userId: U2.flightJodhpur } as Actor,
  VISA_2: { userId: U2.visaJodhpur2 } as Actor,
};
/** Synthetic sentinels for the Phase 2 fence scan. */
export const SENTINEL2 = {
  supplierPan: 'AAAPZ4321K',
  supplierGstin: '08AAAPZ4321K1Z5',
  accountNumber: '100000005501',
  accountLast4: '5501',
  refundAmount: '1234567',
  charge: '234567',
};

/** Customer refund request fields (7.3 C1), with defaults for a cancellation payout to the original payer. */
export type RefundFields = {
  kind: 'cancellation' | 'overpayment'; outcome: 'payout' | 'keep_credit' | 'charge_only'; customerChargePaise: string; amountPaise: string;
  payeeKind: 'original_payer' | 'other' | null; payeeReceiptId: string | null; payeeName: string | null; payeeReason: string | null; reason: string;
};

/** The id returned by a command (contract DTOs name it after the subject; tolerate `id`). */
export function idOf(r: unknown, ...keys: string[]): string {
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of [...keys, 'documentId', 'refundRequestId', 'supplierRefundId', 'supplierId', 'contactId', 'linkId', 'payoutId', 'mappingId', 'id']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  throw new Error(`no id in ${JSON.stringify(r)}`);
}

export function acc2Helpers(getDb: () => TestDb) {
  const h = accHelpers(getDb);
  const { one, owner } = h;
  const db = () => getDb();

  // ---------------------------------------------------------------- people
  /** Phase 2 people (section 15) as in-transaction memberships until the lead's fixtures land. */
  const people = {
    /** Second Accounts person (receipts recorded by ACC are verified by ACC2). */
    acc2: () => h.addAcc2(),
    /** Third Accounts person. */
    acc3: () => h.addAcc3(),
    /** Second Delhi Manager (Manager Ahmedabad also given Delhi). */
    manager2Del: () => h.addRole(U.managerAhmedabad, 'manager', 'DEL'),
    flight: () => h.addFlightPeople(),
    /** Deal without an active Sales owner: the owner loses Sales inside the transaction. */
    noSalesOwner: () => h.dropRole(U.salesDelhiA, 'sales'),
    /** Lead's Phase 2 fixture people (supabase/fixtures/accounts_phase2_people.sql; inactive until activated). */
    fixtures: async (...who: Array<keyof typeof U2>) => {
      await resetActor(db());
      await activateAcc2People(db(), who.length ? who : undefined);
    },
  };

  // ---------------------------------------------------------------- switches
  async function docsOn(on = true): Promise<void> {
    await one(SUPER, SQL2.setDocsEnabled, [await h.entityId(), on, REASON]);
  }
  async function refundsOn(on = true): Promise<void> {
    await one(SUPER, SQL2.setRefundsEnabled, [await h.entityId(), on, REASON]);
  }
  async function exportOn(): Promise<void> {
    await one(SUPER, SQL2.setTallyExport, [await h.entityId(), true, REASON]);
  }

  // ---------------------------------------------------------------- Deals
  /**
   * A confirmed booking on `deal` (default: one hotel = package class),
   * billing saved and verified by ACC and the review approved (real
   * commands, approveReal). ACC2 is added so receipts can be verified.
   */
  async function approvedDeal(items: Item[] = [HOTEL_ITEM], opts: Parameters<typeof h.book>[1] = {}): Promise<Booked> {
    await people.acc2();
    const b = await h.book(items, opts);
    await h.approveReal(b.versionId, opts.deal ?? DEAL);
    return b;
  }
  /** Verified bank receipt on `deal` (ACC records, ACC2 verifies). */
  const receipt = (amount: string, deal: string = DEAL, over: Record<string, unknown> = {}) => h.receipt(deal, amount, over);
  /** Money held per the contract definition (4): Σ(credit − debit) of customer_advances for the Deal. */
  async function held(deal: string = DEAL): Promise<bigint> {
    const [r] = await owner<{ v: string }>(
      `select coalesce(sum(l.credit_paise - l.debit_paise), 0)::text as v from public.finance_journal_lines l
       where l.deal_id = $1 and l.account = 'customer_advances'`, [deal]);
    return BigInt(r!.v);
  }

  // ---------------------------------------------------------------- documents
  type DocRow = { id: string; kind: string; status: string; number: string | null; seq: number | null; row_version: number; content_sha256: string;
    content: Record<string, unknown>; total_paise: string; receipt_id: string | null; replaces_document_id: string | null; tally_invoice_id: string | null;
    issue_date: string | null; credits_document_id: string | null; refund_request_id: string | null };
  const docRow = async (id: string) => (await owner<DocRow>(
    `select id, kind, status, number, seq, row_version, content_sha256, content, total_paise::text as total_paise, receipt_id, replaces_document_id,
            tally_invoice_id, issue_date::text as issue_date, credits_document_id, refund_request_id
     from public.customer_documents where id = $1`, [id]))[0]!;
  const docsOf = (deal: string = DEAL) => owner<DocRow>(
    `select id, kind, status, number, seq, row_version, content_sha256, content, total_paise::text as total_paise, receipt_id, replaces_document_id,
            tally_invoice_id, issue_date::text as issue_date, credits_document_id, refund_request_id
     from public.customer_documents where deal_id = $1 order by created_at, id`, [deal]);
  async function draft(kind: 'advance_invoice' | 'invoice' | 'credit_note', source: Record<string, unknown>, deal: string = DEAL, actor: Actor = ACC,
    requestId: string = rid()): Promise<DocRow> {
    const r = await one(actor, SQL2.draftCreate, [deal, kind, JSON.stringify(source), requestId]);
    return docRow(idOf(r, 'documentId'));
  }
  async function release(id: string, actor: Actor = ACC): Promise<DocRow> {
    const d = await docRow(id);
    await one(actor, SQL2.docRelease, [id, d.row_version, d.content_sha256, rid()]);
    return docRow(id);
  }
  /** Draft and release an Advance Invoice for `receiptId`. */
  const releasedAdvance = async (receiptId: string, deal: string = DEAL) => release((await draft('advance_invoice', { receiptId }, deal)).id);
  const releasedInvoice = async (deal: string = DEAL) => release((await draft('invoice', {}, deal)).id);

  /** A Tally GST invoice reference on the Deal (Phase 1 T4). */
  async function gstInvoice(ref = `HC/25-26/${String(Math.floor(Math.random() * 9000) + 1000)}`, deal: string = DEAL): Promise<string> {
    await one(ACC, 'select public.accounts_tally_invoice_add($1, $2::jsonb, $3) as r', [deal, JSON.stringify({ invoiceRef: ref, invoiceDate: today(), note: null }), rid()]);
    return (await owner<{ id: string }>('select id from public.deal_tally_invoices where deal_id = $1 order by created_at desc, id limit 1', [deal]))[0]!.id;
  }

  // ---------------------------------------------------------------- cancellation
  const cancellationOf = async (deal: string = DEAL) => (await owner<{ id: string; status: string; row_version: number }>(
    'select id, status, row_version from public.deal_cancellations where deal_id = $1', [deal]))[0];
  /** Manager opens the cancellation. */
  async function openCancellation(deal: string = DEAL, actor: Actor = MANAGER): Promise<string> {
    const r = await one<{ cancellationId: string }>(actor, SQL2.cancelOpen, [deal, 'Synthetic: customer cancelled the trip', rid()]);
    return r.cancellationId;
  }
  /**
   * Cancellation approved. With no Purchase cost and no ticket batch the
   * Manager decides straight from open (LD14); otherwise the caller enters
   * and sends the charges first and passes `sent = true`.
   */
  async function approveCancellation(deal: string = DEAL, approver: Actor = MANAGER): Promise<string> {
    let c = await cancellationOf(deal);
    if (!c) {
      await openCancellation(deal);
      c = (await cancellationOf(deal))!;
    }
    await one(approver, SQL2.cancelDecide, [c.id, 'approve', null, c.row_version, rid()]);
    return c.id;
  }

  // ---------------------------------------------------------------- refunds
  const refundRow = async (id: string) => (await owner<{ id: string; status: string; row_version: number; ref_no: string; amount_paise: string;
    customer_charge_paise: string; outcome: string; kind: string; payee_name: string | null }>(
    `select id, status, row_version, ref_no, amount_paise::text as amount_paise, customer_charge_paise::text as customer_charge_paise, outcome, kind, payee_name
     from public.customer_refund_requests where id = $1`, [id]))[0]!;
  function refundFields(over: Partial<RefundFields> = {}): RefundFields {
    return { kind: 'cancellation', outcome: 'payout', customerChargePaise: '0', amountPaise: '100000', payeeKind: 'original_payer', payeeReceiptId: null,
      payeeName: null, payeeReason: null, reason: 'Synthetic refund reason: trip cancelled by the customer', ...over };
  }
  async function requestRefund(fields: RefundFields, deal: string = DEAL, actor: Actor = OWNER, requestId: string = rid()) {
    const r = await one(actor, SQL2.refundCreate, [deal, JSON.stringify(fields), requestId]);
    return refundRow(idOf(r, 'refundRequestId'));
  }
  async function decideRefund(id: string, decision: 'approve' | 'return', approver: Actor = MANAGER, reason: string | null = null) {
    const r = await refundRow(id);
    return one(approver, SQL2.refundDecide, [id, decision, r.amount_paise, r.customer_charge_paise,
      decision === 'return' ? (reason ?? 'Synthetic return: check the charge') : reason, r.row_version, rid()]);
  }
  /** A stored refund proof file (C5) on `subjectId`. */
  async function refundProof(subjectKind: 'customer_refund' | 'supplier_refund', subjectId: string, actor: Actor = ACC, hash: string = sha()): Promise<string> {
    const begun = await one<Record<string, unknown>>(actor, SQL2.refundEvidenceBegin,
      [subjectKind, subjectId, 'refund-proof.pdf', 'application/pdf', 2048, hash, rid()]);
    const evidenceId = idOf(begun, 'evidenceId');
    const objectPath = String(begun.objectPath ?? (await owner<{ p: string }>('select object_path as p from public.refund_evidence where id = $1', [evidenceId]))[0]!.p);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [objectPath]);
    await one(actor, SQL2.refundEvidenceFinish, [evidenceId, true]);
    return evidenceId;
  }
  async function payout(id: string, over: Record<string, unknown> = {}, actor: Actor = ACC) {
    const evidenceId = over.evidenceId ?? await refundProof('customer_refund', id, actor);
    const r = await refundRow(id);
    return one<Record<string, unknown>>(actor, SQL2.payout, [id, r.row_version, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
      reference: `SYNRF${rid().slice(0, 6)}`, ...over, evidenceId }), rid()]);
  }
  /**
   * Package Deal (hotel) approved, `amount` verified money, cancellation
   * approved by the Manager (nothing to charge, LD14), refunds and documents
   * on. Returns the receipt and the cancellation id.
   */
  async function cancelledWithMoney(amount = '2500000', deal: string = DEAL) {
    const b = await approvedDeal([HOTEL_ITEM], { deal });
    const rec = await receipt(amount, deal);
    await refundsOn();
    const cancellationId = await approveCancellation(deal);
    return { booked: b, receipt: rec, cancellationId };
  }

  // ---------------------------------------------------------------- suppliers
  const supplierRow = async (id: string) => (await owner<Record<string, unknown> & { row_version: number; verification_status: string }>(
    'select * from public.suppliers where id = $1', [id]))[0]!;
  /** Purchase creates a supplier with the Phase 2 fields. */
  async function newSupplier(fields: Record<string, unknown> = {}, actor: Actor = PURCHASE) {
    const r = await one<{ supplierId: string; rowVersion: number; warnings: unknown[] }>(actor, SQL2.supplierCreate, [await h.entityId(), JSON.stringify({
      name: `Synthetic Stays ${rid().slice(0, 8)}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null,
      contactEmail: 'desk@example.test', paymentTerms: null, supplierKind: 'direct', ...fields })]);
    return r;
  }
  /** Full field set of a supplier (supplier_update replaces every field, as today) merged with `change`. */
  async function supplierFields(id: string, change: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const s = await supplierRow(id) as Record<string, unknown>;
    return { name: s.name, serviceTypes: s.service_types, city: s.city, contactName: s.contact_name, contactPhone: s.contact_phone,
      contactEmail: s.contact_email, paymentTerms: s.payment_terms, supplierKind: s.supplier_kind, gstin: s.gstin, pan: s.pan, stateCode: s.state_code,
      address: s.address, ...change };
  }
  /** supplier_update (or flight_supplier_update) with the full field set and the current row version. */
  async function updateSupplier(id: string, change: Record<string, unknown>, actor: Actor = PURCHASE, flight = false) {
    const fields = await supplierFields(id, change);
    if (flight) {
      delete fields.serviceTypes;
      delete fields.paymentTerms;
    }
    return one<{ rowVersion: number; warnings: Array<{ supplierId: string; reasons: string[] }> }>(actor, flight ? SQL2.flightSupplierUpdate : SQL2.supplierUpdate,
      [id, (await supplierRow(id)).row_version, JSON.stringify(fields)]);
  }
  /** An active catalogue hotel (owner SQL, SYNTHETIC FIXTURE STEP). */
  async function catalogueHotel(name = `Synthetic Catalogue Hotel ${rid().slice(0, 6)}`, sourceRef: string | null = null): Promise<string> {
    await resetActor(db());
    const [row] = await owner<{ id: string }>(
      `insert into public.hotel_catalogue (legal_entity_id, name, city, source_ref, created_by, updated_by)
       values ($1, $2, 'Synthetic City', $3, $4, $4) returning id`,
      [await h.entityId(), name, sourceRef, U.adminJodhpur]);
    return row!.id;
  }
  const history = (supplierId: string) => owner<{ source: string; field: string; old_value: string | null; new_value: string | null; changed_by: string | null }>(
    'select source, field, old_value, new_value, changed_by from public.supplier_changes where supplier_id = $1 order by id', [supplierId]);

  // ---------------------------------------------------------------- notices
  const recipients = async (kind: string, subjectId?: string) => (await h.notices(kind)).filter((n) => !subjectId || n.subject_id === subjectId
    || n.deal_id === subjectId || n.task_id === subjectId).map((n) => n.recipient_user_id);

  // ---------------------------------------------------------------- scans
  /** Every string value in `value` (deep). */
  function strings(value: unknown, acc: string[] = []): string[] {
    if (typeof value === 'string') acc.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, acc));
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => strings(v, acc));
    return acc;
  }
  /** Asserts the refusal token (and optional SQLSTATE); returns the hint. */
  const refusedToken = (actor: Actor, sql: string, params: unknown[], token: string, hint?: RegExp) =>
    h.refusedHint(actor, sql, params, token, hint, NEW_TOKENS[token]);

  return {
    ...h, people, docsOn, refundsOn, exportOn2: exportOn, approvedDeal, receipt2: receipt, held, docRow, docsOf, draft, release, releasedAdvance,
    releasedInvoice, gstInvoice, cancellationOf, openCancellation, approveCancellation, refundRow, refundFields, requestRefund, decideRefund, refundProof,
    payout, cancelledWithMoney, supplierRow, supplierFields, updateSupplier, newSupplier, catalogueHotel, history, recipients, strings, refusedToken,
  };
}

/** Value of a read, or null when refused (any authorization SQLSTATE). */
export async function readOrNull<T>(h: ReturnType<typeof acc2Helpers>, actor: Actor, sql: string, params: unknown[]): Promise<T | null> {
  const r = await h.attempt<T>(actor, sql, params);
  if (!r.ok) {
    expect(r.code, `${sql} as ${actor.userId}: ${r.error}`).toMatch(/^(42501|28000|P0001)$/);
    return null;
  }
  return r.value;
}

export { ACC, ACC2, DEAL, FLIGHT, MANAGER, MANAGER_AMD, OWNER, PURCHASE, REASON, SUPER, rid, sha, today };
