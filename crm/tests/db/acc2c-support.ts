import { expect } from 'vitest';
import { type Actor, ACC2_FIXTURE_USERS as U2, FIXTURE_USERS as U, type TestDb, activateAcc2People, resetActor } from '../helpers/db';
import { ACC, DEAL, HOTEL_ITEM, MANAGER, OWNER, REASON, SUPER, accHelpers, rid, sha, today } from './acc-support';

/**
 * Accounts phase 2, Track C test support (contract accounts-phase2-2026-11-11
 * section 7): refunds, supplier refunds, Flight/Visa cancellation. Builds on
 * the Phase 1 scenario helpers (acc-support.ts). Every scenario runs inside
 * one rolled-back owner transaction (asOwner).
 *
 * Actors (synthetic, @example.test):
 *   OWNER      Sales Delhi A   Sales owner of SYN-DEL-001 (requester)
 *   MANAGER    Manager Delhi   branch Manager of the Deal (approver)
 *   MANAGER_J2 Manager Jodhpur 2 (another Manager of the entity, LD32)
 *   ACC        Accounts Jodhpur (payer); ACC2 (Visa Jodhpur + Accounts) verifies receipts
 *   ACC_J2     Accounts Jodhpur 2
 */

export const MANAGER_J2: Actor = { userId: U2.managerJodhpur2 };
export const MANAGER_F: Actor = { userId: U2.managerFlightDelhi };
export const ACC_J2: Actor = { userId: U2.accountsJodhpur2 };
export const FLIGHT_J: Actor = { userId: U2.flightJodhpur };
export const VISA_J2: Actor = { userId: U2.visaJodhpur2 };

export const CSQL = {
  create: 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r',
  resubmit: 'select public.customer_refund_request_resubmit($1, $2, $3::jsonb, $4) as r',
  withdraw: 'select public.customer_refund_request_withdraw($1, $2, $3, $4) as r',
  decide: 'select public.customer_refund_decide($1, $2, $3::bigint, $4::bigint, $5, $6, $7) as r',
  evBegin: 'select public.refund_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
  evFinish: 'select public.refund_evidence_finish($1, $2) as r',
  evDownload: 'select public.refund_evidence_authorize_download($1) as r',
  payout: 'select public.customer_refund_payout_record($1, $2, $3::jsonb, $4) as r',
  srRecord: 'select public.supplier_refund_record($1::jsonb, $2) as r',
  srCancel: 'select public.supplier_refund_cancel($1, $2, $3, $4) as r',
  flightCharge: 'select public.flight_cancellation_charge_set($1, $2::jsonb, $3, $4) as r',
  visaChoice: 'select public.visa_application_cancellation_choice($1, $2, $3, $4, $5) as r',
  visaFee: 'select public.visa_cancellation_fee_set($1, $2::bigint, $3, $4, $5) as r',
  setRefunds: 'select public.admin_set_refunds_enabled($1, $2, $3) as r',
  dealRefunds: 'select public.deal_refunds($1) as r',
  list: 'select public.refund_requests_list($1::jsonb, $2, $3) as r',
  due: 'select public.supplier_refunds_due($1::jsonb, $2, $3) as r',
  cancelOpen: 'select public.deal_cancellation_open($1, $2, $3) as r',
  cancelSend: 'select public.deal_cancellation_send($1, $2, $3) as r',
  cancelDecide: 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r',
  cancelSummary: 'select public.deal_cancellation_summary($1) as r',
  managerList: 'select public.manager_cancellation_list() as r',
  purchaseCharge: 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r',
  dealDues: 'select public.deal_dues($1) as r',
  payables: 'select public.accounts_supplier_payables($1) as r',
} as const;

export type Refund = { outcome: string; refundRequestId: string; refNo: string; status: string; rowVersion: number; payoutId?: string;
  journalEntryId?: string };

export function acc2cHelpers(getDb: () => TestDb) {
  const h = accHelpers(getDb);
  const db = () => getDb();
  const { one, owner } = h;

  async function people(): Promise<void> {
    await resetActor(db());
    await activateAcc2People(db());
    await h.addAcc2();
  }
  async function refundsOn(on = true): Promise<void> {
    await one(SUPER, CSQL.setRefunds, [await h.entityId(), on, REASON]);
  }
  /** Approved hotel booking on DEAL with `paid` of verified money, refunds on, people active. */
  async function paidBooking(paid = '5000000', opts: { deal?: string; selling?: string } = {}) {
    await people();
    const b = await h.book([HOTEL_ITEM], { deal: opts.deal ?? DEAL, ...(opts.selling ? { selling: opts.selling } : {}) });
    await h.approve(b.versionId);
    const receipt = paid === '0' ? null : await h.receipt(opts.deal ?? DEAL, paid);
    await refundsOn();
    return { booked: b, receipt };
  }
  /** Cancellation opened and approved by the branch Manager (nothing to charge: LD14). */
  async function cancelApproved(deal: string = DEAL): Promise<string> {
    const opened = await one<{ cancellationId: string; rowVersion: number }>(MANAGER, CSQL.cancelOpen, [deal, REASON, rid()]);
    await one(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, opened.rowVersion, rid()]);
    return opened.cancellationId;
  }
  const request = (fields: Record<string, unknown>, actor: Actor = OWNER, deal: string = DEAL, requestId = rid()) =>
    one<Refund>(actor, CSQL.create, [deal, JSON.stringify({ reason: REASON, ...fields }), requestId]);
  const rv = async (id: string) =>
    (await owner<{ v: number }>('select row_version as v from public.customer_refund_requests where id = $1', [id]))[0]!.v;
  const row = async (id: string) =>
    (await owner<Record<string, unknown>>('select * from public.customer_refund_requests where id = $1', [id]))[0]!;
  async function decide(id: string, decision: 'approve' | 'return', actor: Actor = MANAGER, reason: string | null = null) {
    const r = await row(id);
    return one<Refund>(actor, CSQL.decide, [id, decision, String(r.amount_paise), String(r.customer_charge_paise), reason, r.row_version, rid()]);
  }
  /** Stored refund proof (customer_refund subject = request; supplier_refund subject = cancellation). */
  async function proof(subjectKind: 'customer_refund' | 'supplier_refund', subjectId: string, actor: Actor = ACC): Promise<string> {
    const begun = await one<{ evidenceId: string; objectPath: string }>(actor, CSQL.evBegin,
      [subjectKind, subjectId, 'proof.pdf', 'application/pdf', 2048, sha(), rid()]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`,
      [begun.objectPath]);
    const done = await one<{ status: string }>(actor, CSQL.evFinish, [begun.evidenceId, true]);
    expect(done.status).toBe('stored');
    return begun.evidenceId;
  }
  async function payout(id: string, fields: Record<string, unknown> = {}, actor: Actor = ACC) {
    const evidenceId = fields.evidenceId === undefined ? await proof('customer_refund', id) : fields.evidenceId;
    return one<Refund>(actor, CSQL.payout, [id, await rv(id), JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
      reference: 'SYNRF0001', ...fields, evidenceId }), rid()]);
  }
  const held = async (deal: string = DEAL) =>
    (await owner<{ v: string }>('select authz.refund_money_held($1)::text as v', [deal]))[0]!.v;
  const audit = (action: string) => h.audits(action);
  const asManagerNoSales = async () => {
    // The Deal's Sales owner leaves Sales: the branch Manager asks (7.2).
    await h.dropRole(U.salesDelhiA, 'sales');
  };
  return { ...h, people, refundsOn, paidBooking, cancelApproved, request, rv, row, decide, proof, payout, held, audit, asManagerNoSales };
}

export { ACC, DEAL, MANAGER, OWNER, REASON, SUPER, rid, today };
