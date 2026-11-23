import { randomBytes } from 'node:crypto';
import { type Actor, FIXTURE_USERS as U, type TestDb, claimsFor, resetActor } from '../helpers/db';
import { DEAL, daysAgo, financeHelpers, insertApprovedDestination, rid, today } from './finance-support';

/**
 * Shared helpers for the B1.1b advance-claim PGlite suites
 * (tests/db/b11-claims-*.test.ts; migration 20261119000200_b11_payment_claims.sql).
 * Built on finance-support (same actors, same rolled-back owner transaction
 * per scenario). Synthetic data only.
 *
 * Actors: SALES owns SYN-DEL-001 (DEAL) and reads its commercials; MANAGER is
 * the Delhi branch Manager; ACC records receipts; ACC2 (Synthetic Visa Jodhpur
 * given an accounts membership) verifies.
 */

export const CLAIMS_SUITE_LOCK = '5000000001';

export const FLIGHT: Actor = { userId: U.visaJodhpur };
export const VISA: Actor = { userId: U.visaJodhpur };

export type ClaimResult = {
  outcome: string;
  id: string;
  status: string;
  rowVersion?: number;
  receiptId?: string;
  receiptNo?: string;
};

export const REPORT = 'select public.payment_claim_report($1, $2::jsonb, $3) as r';
export const WITHDRAW = 'select public.payment_claim_withdraw($1, $2, $3, $4) as r';
export const FROM_CLAIM = 'select public.receipt_record_from_claim($1, $2::jsonb, $3) as r';
export const LINK = 'select public.payment_claim_link_receipt($1, $2, $3, $4) as r';
export const NOT_RECEIVED = 'select public.payment_claim_mark_not_received($1, $2, $3) as r';
export const SALES_VIEW = 'select public.deal_payment_claims($1) as r';
export const ACCOUNTS_LIST = 'select public.accounts_payment_claims($1, $2, $3) as r';
export const ACCOUNTS_DETAIL = 'select public.accounts_deal_detail($1) as r';
export const TO_PROCESS = 'select authz.finance_claims_to_process_count() as r';

export const utr = () => `UTR${randomBytes(5).toString('hex').toUpperCase()}`;
export const chequeNo = () => String(100000 + Math.floor(Math.random() * 899999));

export function claimHelpers(getDb: () => TestDb) {
  const f = financeHelpers(getDb);
  const db = () => getDb();

  async function setSwitch(on: boolean): Promise<void> {
    await resetActor(db());
    await f.owner('update public.workflow_settings set service_items_enabled = $1 where id', [on]);
  }

  /** A confirmed hotel booking on DEAL (selling total 9876543 paise), then the switch on. */
  async function bookedDeal(dealId: string = DEAL): Promise<string> {
    await setSwitch(false);
    const versionId = await f.confirmedBooking(dealId);
    await setSwitch(true);
    return versionId;
  }

  /** A hotel draft on DEAL without a selling total, then the switch on. */
  async function draftDeal(dealId: string = DEAL, actor: Actor = { userId: U.salesDelhiA }): Promise<string> {
    await setSwitch(false);
    const opened = await f.one<{ versionId: string }>(actor, 'select public.booking_open_draft($1) as r', [dealId]);
    await setSwitch(true);
    return opened.versionId;
  }

  async function bankClaim(over: Record<string, unknown> = {}, dealId: string = DEAL): Promise<Record<string, unknown>> {
    const kind = over.mode === 'upi' ? 'upi' : 'bank';
    const destination = 'destinationVersionId' in over ? {} : { destinationVersionId: await insertApprovedDestination(db(), dealId, kind) };
    return {
      ...destination,
      mode: 'bank_transfer',
      amountPaise: '2500000',
      paidOn: today(),
      payerName: 'Synthetic Payer',
      reference: utr(),
      ...over,
    };
  }
  const cashClaim = (over: Record<string, unknown> = {}) => ({
    mode: 'cash', amountPaise: '1000000', paidOn: daysAgo(1), payerName: 'Synthetic Cash Payer', ...over,
  });
  const chequeClaim = (over: Record<string, unknown> = {}) => ({
    mode: 'cheque', amountPaise: '3000000', paidOn: today(), payerName: 'Synthetic Cheque Payer',
    chequeNumber: chequeNo(), chequeDate: today(), ...over,
  });

  const report = (actor: Actor, fields: Record<string, unknown>, dealId: string = DEAL, requestId = rid()) =>
    f.one<ClaimResult>(actor, REPORT, [dealId, JSON.stringify(fields), requestId]);
  const withdraw = (actor: Actor, claimId: string, rowVersion = 1, reason = 'Synthetic withdrawal reason', requestId = rid()) =>
    f.one<ClaimResult>(actor, WITHDRAW, [claimId, rowVersion, reason, requestId]);
  const fromClaim = (actor: Actor, claimId: string, fields: Record<string, unknown>, requestId = rid()) =>
    f.one<ClaimResult>(actor, FROM_CLAIM, [claimId, JSON.stringify(fields), requestId]);
  const link = (actor: Actor, claimId: string, receiptId: string, reason: string | null = null, requestId = rid()) =>
    f.one<ClaimResult>(actor, LINK, [claimId, receiptId, reason, requestId]);
  const notReceived = (actor: Actor, claimId: string, reason = 'Synthetic: no such credit in the bank statement', requestId = rid()) =>
    f.one<ClaimResult>(actor, NOT_RECEIVED, [claimId, reason, requestId]);
  const salesView = (actor: Actor, dealId: string = DEAL) => f.one<SalesView | null>(actor, SALES_VIEW, [dealId]);
  const accountsList = (actor: Actor, filter: string, after: string | null = null, limit: number | null = null) =>
    f.one<ClaimsPage>(actor, ACCOUNTS_LIST, [filter, after, limit]);

  /**
   * Receipt fields for recording from a claim: the claim facts plus the
   * Accounts-only fields (branch, payer identifier, MICR, destination).
   */
  async function receiptFieldsFor(claim: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = {
      mode: claim.mode,
      amountPaise: claim.amountPaise,
      receivedOn: claim.paidOn,
      branchId: await f.branchId(claim.mode === 'cash' ? 'JDH' : 'DEL'),
      payerName: claim.payerName,
    };
    if (claim.mode === 'bank_transfer' || claim.mode === 'upi') {
      Object.assign(base, { reference: claim.reference, destinationVersionId: claim.destinationVersionId, payerPan: 'ABCDE1234F' });
    } else if (claim.mode === 'cash') {
      Object.assign(base, { collectorUserId: U.accountsJodhpur, payerPan: 'PQRSX6789K' });
    } else {
      Object.assign(base, {
        chequeNumber: claim.chequeNumber, chequeDate: claim.chequeDate, micrCode: '110002003', accountPayee: true,
        payerMobile: '9876543210',
      });
    }
    return { ...base, ...over };
  }

  /**
   * Test-only provenance relaxation (as in stage7-lost-deal-booking): DEAL
   * becomes an imported Bitrix Deal in `stage` but stays synthetic, so the
   * finance gate of the test environment still lets it through.
   */
  async function markImported(stage = 'PREPARATION', dealId: string = DEAL): Promise<void> {
    await db().exec('alter table public.deals drop constraint deals_provenance');
    await db().exec('alter table public.deals drop constraint deals_source_assigned_by_provenance');
    await f.owner(
      `update public.deals set source_system = 'bitrix', source_portal = 'SYNTHETIC_MEMBER_0001',
         source_deal_id = 990001, source_assigned_by_id = 101, source_stage_id = $2 where id = $1`,
      [dealId, stage],
    );
  }

  /**
   * authz.finance_claims_to_process_count() is not executable by
   * authenticated (my_work_counts calls it as definer): evaluate it as the
   * owner with the actor's JWT claims, as a SECURITY DEFINER caller would.
   */
  async function toProcess(actor: Actor): Promise<number | null> {
    await resetActor(db());
    await db().query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
    const [row] = await db().query<{ r: number | null }>(TO_PROCESS);
    await resetActor(db());
    return row!.r;
  }

  /**
   * The claim row as JSON, so bigint columns compare the same on PGlite and
   * on real Postgres (node-pg returns int8 as a string; jsonb as a number).
   */
  async function claimRow(id: string) {
    return (await f.owner<{ r: Record<string, unknown> }>(
      'select to_jsonb(c) as r from public.customer_payment_claims c where c.id = $1', [id]))[0]!.r;
  }

  return {
    ...f, setSwitch, bookedDeal, draftDeal, bankClaim, cashClaim, chequeClaim, report, withdraw, fromClaim, link,
    notReceived, salesView, accountsList, receiptFieldsFor, claimRow, markImported, toProcess,
  };
}

export interface SalesView {
  dealId: string;
  sellingTotalPaise: string | null;
  reportedPaise: string;
  confirmedPaise: string;
  balancePaise: string | null;
  canReport: boolean;
  reportBlock: string | null;
  destinations: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown> & { claimId: string; status: string; displayStatus: string }>;
}

export interface ClaimsPage {
  items: Array<Record<string, unknown> & { claimId: string; status: string; displayStatus: string }>;
  hasMore: boolean;
  nextAfter: string | null;
  totalCount: number;
}
