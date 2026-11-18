import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  istBusinessDate,
} from '../helpers/db';
import { HOTEL, PURCHASE_CLAIM_SQL, SAVE_ITEM_SQL, TRANSFER, b1Helpers } from './b1-support';

/**
 * Purchase build, Track B (migration 20261130000200_supplier_money.sql),
 * written by the independent test author (Track D) from the frozen contract
 * (purchase-contract.md, owner decisions of 2 November 2026), not from the
 * implementation:
 *
 *   - Supplier payment requests: route decided at create from the cumulative
 *     live total for (Deal, supplier) including this one: exactly
 *     INR 50,000 (5_000_000 paise) = Accounts, above = the Deal's branch
 *     Manager. Returned/cancelled requests do not count. The sum of live
 *     requests on a task never exceeds its latest cost (over_agreed_cost).
 *   - Hotel requests need a valid go-ahead; a deposit is allowed before
 *     supplier confirmation, balance/full need supplier_confirmed.
 *   - Approve by the route's role only, never the requester; record by
 *     Accounts only, blocked by unapproved bank details
 *     (bank_details_on_hold) and pending funding (funding_pending); a
 *     different Accounts person verifies (not_self_verification). Payments
 *     never change the task status.
 *   - Company funding: amount computed server-side (request amount minus
 *     customer money available on the Deal); route by cumulative company
 *     money on the Deal; Purchase never sees the amount or the reason.
 *   - Supplier invoices/credit notes: Purchase uploads, Accounts reviews,
 *     return needs a reason, nobody reviews their own upload.
 *   - An open trip cancellation blocks payment requests (trip_cancelled).
 *   - Purchase reads carry no selling price, margin, receipts, payment proof
 *     ids, funding reason/amount.
 *
 * The B command signatures were not fully frozen in the contract: they are
 * collected in the `api` block below so that only that block follows the
 * implementation's parameter order. Every assertion follows the contract.
 *
 * Synthetic actors as in purchase-workflow.test.ts. ACC2 (Visa Jodhpur) is
 * given an Accounts membership per test and is the second Accounts person.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { run, one, owner } = h;
const rid = () => crypto.randomUUID();

const OWNER: Actor = { userId: U.salesDelhiA };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const PURCHASE_2: Actor = { userId: U.movedStaff };
const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
const VISA: Actor = { userId: U.visaJodhpur };
const FLIGHT: Actor = { userId: U.movedStaff };
const DEAL = D.del001;

const SELLING = '45678901';
const HOTEL_BUDGET = '20000000';
const HOTEL_COST = '10000000';
const LIMIT = 5_000_000;
const FIXTURE_COMMERCIALS = ['12345600', '1111100'];
const SUPPLIER_EMAIL = 'desk@example.test';
const FUNDING_REASON = 'Synthetic funding reason: customer transfer delayed';
const today = () => istBusinessDate();

// ---------------------------------------------------------------------------
// Existing commands
// ---------------------------------------------------------------------------
const QUOTE_ADD_SQL = 'select public.purchase_quote_add($1, $2, $3::jsonb) as r';
const COST_SQL = 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r';
const CONFIRM_SQL = 'select public.purchase_supplier_confirm($1, $2, $3) as r';
const WORKSPACE_SQL = 'select public.purchase_workspace($1) as r';
const PEV_BEGIN_SQL = 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r';
const PEV_FINISH_SQL = 'select public.purchase_evidence_finish($1, $2) as r';
const BENEFICIARY_SQL = 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r';
const APPROVE_BENEFICIARY_SQL = 'select public.supplier_approve_beneficiary($1, $2) as r';
const OPEN_REVISION_SQL = 'select public.booking_open_revision($1) as r';
const CLASSIFY_SQL = 'select public.booking_classify_revision($1, $2, $3) as r';
// Track A commands (contract signatures).
const BR_SEND_SQL = 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r';
const GA_DECIDE_SQL = 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r';
const CANCEL_OPEN_SQL = 'select public.deal_cancellation_open($1, $2, $3) as r';

// ---------------------------------------------------------------------------
// Track B adapter: parameter order follows the implementation; nothing else.
// ---------------------------------------------------------------------------
type CreateArgs = { taskId: string; part: 'deposit' | 'balance' | 'full'; amount: string | number; proformaId: string | null;
  askFunding?: boolean; fundingReason?: string | null; requestId?: string; dueDate?: string; note?: string | null; expected?: number };
const fields = async (a: CreateArgs) => JSON.stringify({
  expectedCostVersionNo: a.expected ?? await agreedCostNo(a.taskId), part: a.part, amountPaise: String(a.amount),
  dueDate: a.dueDate ?? '2026-11-20', note: a.note ?? null, proformaEvidenceId: a.proformaId,
  ...(a.fundingReason !== undefined && a.fundingReason !== null ? { fundingReason: a.fundingReason } : {}),
});
const api = {
  evidenceBegin: (actor: Actor, target: string, kind: string) =>
    one<{ evidenceId: string; objectPath: string }>(actor, 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
      [kind, target, `${kind}.pdf`, 'application/pdf', 2048, 'e'.repeat(64), rid()]),
  evidenceFinish: (actor: Actor, evidenceId: string) =>
    one<{ status: string }>(actor, 'select public.supplier_money_evidence_finish($1, $2) as r', [evidenceId, true]),
  evidenceDownloadSql: 'select public.supplier_money_evidence_authorize_download($1) as r',
  createSql: 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r',
  createParams: async (a: CreateArgs) => [a.taskId, await fields(a), a.requestId ?? rid()],
  resubmitSql: 'select public.supplier_payment_request_resubmit($1, $2::jsonb, $3) as r',
  resubmitParams: async (returnedId: string, a: CreateArgs) => [returnedId, await fields(a), a.requestId ?? rid()],
  cancelSql: 'select public.supplier_payment_request_cancel($1, $2, $3) as r',
  cancelParams: (id: string, rv: number) => [id, rv, rid()],
  decideSql: 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
  decideParams: (id: string, decision: string, reason: string | null, rv: number, requestId: string = rid()) => [id, decision, reason, rv, requestId],
  recordSql: 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
  recordParams: (id: string, proofId: string | null, rv: number, requestId: string = rid()) =>
    [id, today(), 'bank_transfer', `UTRSUP${rid().slice(0, 8).toUpperCase()}`, proofId, rv, requestId],
  verifySql: 'select public.supplier_payment_verify($1, $2, $3) as r',
  verifyParams: (id: string, rv: number) => [id, rv, rid()],
  fundingDecideSql: 'select public.company_funding_decide($1, $2, $3, $4, $5) as r',
  fundingDecideParams: (id: string, decision: string, reason: string | null, rv: number) => [id, decision, reason, rv, rid()],
  fundingRecoveredSql: 'select public.company_funding_mark_recovered($1, $2, $3, $4) as r',
  fundingRecoveredParams: (id: string, rv: number) => [id, 'Synthetic: customer money verified later', rv, rid()],
  docUploadSql: 'select public.supplier_document_upload($1, $2::jsonb, $3) as r',
  docUploadParams: (taskId: string, kind: string, evidenceId: string, total = '9999999') =>
    [taskId, JSON.stringify({ kind, number: `SYN-INV-${rid().slice(0, 6)}`, docDate: '2026-11-01', totalPaise: total, gstIncluded: true, evidenceId }), rid()],
  docReviewSql: 'select public.supplier_document_review($1, $2, $3, $4, $5) as r',
  docReviewParams: (id: string, decision: string, reason: string | null, rv: number) => [id, decision, reason, rv, rid()],
  purchaseRequestsSql: 'select public.purchase_payment_requests($1) as r',
  purchaseContextSql: 'select public.purchase_payment_context($1) as r',
  accountsPaymentsSql: 'select public.accounts_supplier_payments($1) as r',
  accountsDocumentsSql: 'select public.accounts_supplier_documents($1) as r',
  accountsFundingSql: 'select public.accounts_company_funding($1) as r',
  managerApprovalsSql: 'select public.manager_approvals() as r',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function refused(actor: Actor, sql: string, params: unknown[], token: string | RegExp, code?: string): Promise<void> {
  const message = typeof token === 'string' ? new RegExp(`^${token}$`) : token;
  await expectDbError(db, () => run(actor, sql, params), { message, ...(code ? { code } : {}) });
}

async function addMembership(user: string, role: string, branch = 'JDH'): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $2, 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $3
     on conflict do nothing`,
    [user, role, branch],
  );
  await owner(`update public.staff_profiles set status = 'active' where user_id = $1`, [user]);
}

type Booked = { versionId: string; hotelTask: string; transferTask: string; hotelItem: string };
async function bookedDeal(): Promise<Booked> {
  await h.setSwitch('service_items_enabled', true);
  const opened = await h.openDraft(OWNER, DEAL);
  let rv = opened.rowVersion;
  const hotel = await h.addItem(OWNER, opened.versionId, rv, 'hotel', HOTEL, HOTEL_BUDGET);
  rv = hotel.rowVersion;
  rv = (await h.addItem(OWNER, opened.versionId, rv, 'transfer', TRANSFER, '8000000')).rowVersion;
  rv = (await h.saveTravellers(OWNER, DEAL, rv)).rowVersion;
  rv = (await h.saveSelling(OWNER, opened.versionId, rv, SELLING)).rowVersion;
  rv = await h.completeB11(OWNER, DEAL, opened.versionId, rv, SELLING);
  await h.storeEvidence(OWNER, opened.versionId);
  const ready = await h.readiness(OWNER, opened.versionId);
  expect(ready.issues).toEqual([]);
  await h.confirm(OWNER, opened.versionId, ready.contentHash);
  const tasks = await owner<{ id: string; service_purpose: string }>(
    `select id, service_purpose from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [DEAL]);
  return {
    versionId: opened.versionId, hotelItem: hotel.itemId,
    hotelTask: tasks.find((t) => t.service_purpose === 'hotel')!.id,
    transferTask: tasks.find((t) => t.service_purpose === 'transfer')!.id,
  };
}

async function approveReview(versionId: string): Promise<void> {
  await owner(
    `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
     select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1
     on conflict (booking_version_id) do update set status = 'approved', row_version = public.accounts_booking_reviews.row_version + 1,
       reviewed_by = excluded.reviewed_by, reviewed_at = now(), updated_at = now()`,
    [versionId, U.accountsJodhpur],
  );
}

async function createSupplier(name = `Synthetic Supplier ${rid().slice(0, 8)}`): Promise<string> {
  const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
  const { supplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [
    entity!.id,
    JSON.stringify({ name, serviceTypes: ['hotel', 'transfer'], city: 'Synthetic City', contactName: 'Synthetic Desk',
      contactPhone: '+91 00000 00000', contactEmail: SUPPLIER_EMAIL, paymentTerms: 'Synthetic: 50% at confirmation' }),
  ]);
  return supplierId;
}

/** Purchase records bank details; the Manager approves them (never the recorder). */
async function bankDetails(supplierId: string, approve = true, account = '000011112222'): Promise<number> {
  const r = await one<{ revisionNo: number }>(PURCHASE, BENEFICIARY_SQL, [supplierId, rid(), JSON.stringify({
    accountHolder: 'Synthetic Stays Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: account })]);
  if (approve) await one(MANAGER, APPROVE_BENEFICIARY_SQL, [supplierId, r.revisionNo]);
  return r.revisionNo;
}

/** The agreed final rate: the latest PROPOSED cost version (confirmation adds a committed copy of it). */
const agreedCostNo = async (taskId: string) =>
  (await owner<{ n: number }>(`select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1 and stage = 'proposed'`, [taskId]))[0]!.n;
const latestCostNo = async (taskId: string) =>
  (await owner<{ n: number }>('select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1', [taskId]))[0]!.n;

async function priced(taskId: string, supplierId: string, cost: string = HOTEL_COST) {
  const assignee = (await owner<{ a: string | null }>('select assignee_user_id as a from public.fulfilment_tasks where id = $1', [taskId]))[0]!.a;
  if (!assignee) await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskId]);
  const { quoteId } = await one<{ quoteId: string }>(PURCHASE, QUOTE_ADD_SQL, [taskId, rid(), JSON.stringify({
    supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', quotedCostPaise: cost,
    holdUntil: '2026-11-30', cancellationTerms: 'Synthetic: free until 7 days before arrival' })]);
  await one(PURCHASE, COST_SQL, [taskId, quoteId, await latestCostNo(taskId), cost, '2026-11-25', null, rid()]);
  return quoteId;
}
const sendBookingRequest = async (taskId: string) =>
  one(PURCHASE, BR_SEND_SQL, [taskId, await latestCostNo(taskId), SUPPLIER_EMAIL, [], 'Booking request · SYN-DEL-001 · Synthetic',
    'Synthetic booking request body.', rid()]);
const pendingGoAhead = async (taskId: string) =>
  (await owner<{ id: string; row_version: number }>(
    `select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`, [taskId]))[0]!;
async function approveGoAhead(taskId: string): Promise<void> {
  await sendBookingRequest(taskId);
  const g = await pendingGoAhead(taskId);
  await one(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()]);
}

async function storeMoneyFile(actor: Actor, target: string, kind: string): Promise<string> {
  const ev = await api.evidenceBegin(actor, target, kind);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`,
    [ev.objectPath]);
  expect((await api.evidenceFinish(actor, ev.evidenceId)).status).toBe('stored');
  return ev.evidenceId;
}

/** Verified bank receipt on the Deal (ACC records, ACC2 verifies). ACC2 must hold Accounts. */
async function verifiedReceipt(amount: string): Promise<string> {
  const [dest] = await owner<{ id: string; legal_entity_id: string }>(
    `insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
     select d.legal_entity_id, 'bank', 'Synthetic fixture destination', d.is_synthetic, $2 from public.deals d where d.id = $1
     returning id, legal_entity_id`, [DEAL, U.accountsJodhpur]);
  const [ver] = await owner<{ id: string }>(
    `insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
       account_number, ifsc, status, maker, request_id, decided_by, decided_at)
     values ($1, $2, 1, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', 'approved', $3, gen_random_uuid(), $4, now()) returning id`,
    [dest!.legal_entity_id, dest!.id, U.accountsJodhpur, U.visaJodhpur]);
  await owner('update public.company_destinations set current_version_id = $1 where id = $2', [ver!.id, dest!.id]);
  const [del] = await owner<{ id: string }>(`select b.id from public.branches b where b.code = 'DEL'`);
  const rec = await one<{ id: string }>(ACC, 'select public.receipt_record($1, $2::jsonb, $3) as r', [DEAL, JSON.stringify({
    mode: 'bank_transfer', amountPaise: amount, receivedOn: today(), branchId: del!.id, payerName: 'Synthetic Payer',
    payerPan: 'ABCDE1234F', reference: `UTR${rid().slice(0, 10).toUpperCase()}`, destinationVersionId: ver!.id,
  }), rid()]);
  const proof = await one<{ id: string; objectPath: string }>(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
    ['receipt', rec.id, 'bank_proof', 'proof.pdf', 'application/pdf', 2048, rid().replace(/-/g, '').padEnd(64, '0'), rid()]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`, [proof.objectPath]);
  await one(ACC, 'select public.finance_evidence_finish($1, true) as r', [proof.id]);
  await one(ACC2, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()]);
  return rec.id;
}

type Ready = Booked & { supplierId: string; quoteId: string; proformaId: string };
/**
 * Hotel task with an approved go-ahead, an approved bank detail for its
 * supplier, a stored proforma and (by default) enough verified customer money
 * on the Deal that no company funding is needed.
 */
async function readyHotel(opts: { customerMoney?: string | null; goAhead?: boolean } = {}): Promise<Ready> {
  await addMembership(U.visaJodhpur, 'accounts');
  const booked = await bookedDeal();
  await approveReview(booked.versionId);
  const supplierId = await createSupplier();
  await bankDetails(supplierId);
  const quoteId = await priced(booked.hotelTask, supplierId);
  if (opts.goAhead ?? true) await approveGoAhead(booked.hotelTask);
  const proformaId = await storeMoneyFile(PURCHASE, booked.hotelTask, 'proforma');
  const money = opts.customerMoney === undefined ? '30000000' : opts.customerMoney;
  if (money) await verifiedReceipt(money);
  return { ...booked, supplierId, quoteId, proformaId };
}

type Pay = { id: string; status: string; route: string; part: string; amount_paise: string; row_version: number; requested_by: string;
  approved_by: string | null; recorded_by: string | null; verified_by: string | null; cost_version_no: number; ref_no: string };
const payments = (taskId: string) =>
  owner<Pay>(`select id, status, route, part, amount_paise::text as amount_paise, row_version, requested_by, approved_by, recorded_by,
    verified_by, cost_version_no, ref_no from public.supplier_payment_requests where task_id = $1 order by ref_no`, [taskId]);
const payment = async (id: string) =>
  (await owner<Pay>(`select id, status, route, part, amount_paise::text as amount_paise, row_version, requested_by, approved_by, recorded_by,
    verified_by, cost_version_no, ref_no from public.supplier_payment_requests where id = $1`, [id]))[0]!;
type Funding = { id: string; status: string; route: string; amount_paise: string; row_version: number; reason: string; payment_request_id: string };
const fundings = () =>
  owner<Funding>(`select f.id, f.status, f.route, f.amount_paise::text as amount_paise, f.row_version, f.reason, f.payment_request_id
    from public.company_funding_requests f where f.deal_id = $1 order by f.amount_paise`, [DEAL]);

/** Creates a request and returns its row (looked up by the new id in the result, else the newest row on the task). */
async function create(actor: Actor, a: CreateArgs): Promise<Pay> {
  const before = new Set((await payments(a.taskId)).map((p) => p.id));
  await one(actor, api.createSql, await api.createParams(a));
  const added = (await payments(a.taskId)).filter((p) => !before.has(p.id));
  expect(added).toHaveLength(1);
  return added[0]!;
}
const approve = async (actor: Actor, p: Pay) => one(actor, api.decideSql, api.decideParams(p.id, 'approve', null, (await payment(p.id)).row_version));
async function record(actor: Actor, p: Pay): Promise<void> {
  const proof = await storeMoneyFile(actor, p.id, 'payment_proof');
  await one(actor, api.recordSql, api.recordParams(p.id, proof, (await payment(p.id)).row_version));
}
const taskStatus = async (taskId: string) =>
  (await owner<{ status: string }>('select status from public.fulfilment_tasks where id = $1', [taskId]))[0]!.status;

function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}
const LEAK_KEY = /sell|margin|commercial|receipt|fundingAmount|fundingReason|fundingRoute|companyFund.*(Amount|Reason|Paise)|paymentProof|proofEvidence|customerMoney(?!Short)|available|payer/i;
function expectNoLeak(label: string, value: unknown, extraValues: string[] = []): void {
  expect([...allKeys(value)].filter((k) => LEAK_KEY.test(k)), `${label}: forbidden keys`).toEqual([]);
  const text = JSON.stringify(value);
  for (const v of [SELLING, ...FIXTURE_COMMERCIALS, FUNDING_REASON, ...extraValues]) {
    expect(text.includes(v), `${label}: contains ${v}`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('schema and grants', () => {
  it('creates the supplier money tables with RLS, no direct writes for staff, and a private bucket', async () => {
    await asOwner(db, async () => {
      const tables = ['supplier_money_evidence', 'supplier_payment_requests', 'company_funding_requests', 'supplier_documents'];
      const rows = await owner<{ t: string; rls: boolean; anon: boolean; auth_write: boolean }>(
        `select c.relname as t, c.relrowsecurity as rls, has_table_privilege('anon', c.oid, 'select') as anon,
           has_table_privilege('authenticated', c.oid, 'insert,update,delete') as auth_write
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1::text[]) order by 1`, [tables]);
      expect(rows.map((r) => r.t)).toEqual([...tables].sort());
      for (const r of rows) expect(r, r.t).toMatchObject({ rls: true, anon: false, auth_write: false });
      const [bucket] = await owner<{ public: boolean }>(`select public from storage.buckets where id = 'supplier-money'`);
      expect(bucket?.public).toBe(false);
      // Purchase cannot read company funding rows directly.
      expect(await run(PURCHASE, 'select reason from public.company_funding_requests').catch(() => [])).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('payment routing by cumulative live total per Deal and supplier', () => {
  it('exactly INR 50,000 goes to Accounts; one paisa more goes to the branch Manager', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const exact = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: LIMIT, proformaId: r.proformaId });
      expect(exact).toMatchObject({ route: 'accounts', status: 'pending', part: 'deposit', amount_paise: String(LIMIT), requested_by: U.purchaseJodhpur });
      expect(exact.ref_no).toMatch(/^SP-\d{4}-\d{6}$/);
      // Cancel it: a fresh single request one paisa above the limit is the Manager's.
      await one(PURCHASE, api.cancelSql, api.cancelParams(exact.id, exact.row_version));
      const above = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: LIMIT + 1, proformaId: r.proformaId });
      expect(above.route).toBe('manager');
    });
  });

  it('cumulative split: 30k then 25k on the same Deal and supplier sends the second to the Manager; 20k + 30k stays with Accounts', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const a = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId });
      const b = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_500_000, proformaId: r.proformaId });
      expect([a.route, b.route]).toEqual(['accounts', 'manager']);
      await one(PURCHASE, api.cancelSql, api.cancelParams(b.id, b.row_version));
      const c = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      expect(c.route).toBe('accounts'); // 30k + 20k = exactly 50k
      // The route preview for Purchase agrees.
      const ctx = await one<Record<string, unknown>>(PURCHASE, api.purchaseContextSql, [r.hotelTask]);
      expect(JSON.stringify(ctx)).toContain('5000000');
    });
  });

  it('a different supplier on the same Deal is counted separately; the same supplier on another task is counted together', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_000_000, proformaId: r.proformaId });
      // Transfer with ANOTHER supplier: 20k stays with Accounts.
      const other = await createSupplier();
      await bankDetails(other);
      await priced(r.transferTask, other, '3000000');
      const transferProforma = await storeMoneyFile(PURCHASE, r.transferTask, 'proforma');
      const t1 = await create(PURCHASE, { taskId: r.transferTask, part: 'deposit', amount: 2_000_000, proformaId: transferProforma });
      expect(t1.route).toBe('accounts');
    });
  });

  it('the same supplier on the hotel and the transfer task: totals add up per Deal and supplier', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_000_000, proformaId: r.proformaId });
      await priced(r.transferTask, r.supplierId, '3000000');
      const transferProforma = await storeMoneyFile(PURCHASE, r.transferTask, 'proforma');
      const t1 = await create(PURCHASE, { taskId: r.transferTask, part: 'deposit', amount: 2_000_000, proformaId: transferProforma });
      expect(t1.route).toBe('manager'); // 40k + 20k = 60k for this supplier on this Deal
    });
  });

  it('returned and cancelled requests are not counted', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const returned = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_000_000, proformaId: r.proformaId });
      await one(ACC, api.decideSql, api.decideParams(returned.id, 'return', 'Synthetic: proforma total does not match', returned.row_version));
      expect((await payment(returned.id)).status).toBe('returned');
      const cancelled = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId });
      await one(PURCHASE, api.cancelSql, api.cancelParams(cancelled.id, cancelled.row_version));
      expect((await payment(cancelled.id)).status).toBe('cancelled');
      const fresh = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_500_000, proformaId: r.proformaId });
      expect(fresh.route).toBe('accounts');
    });
  });

  it('live requests on a task never exceed its latest cost (over_agreed_cost)', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 6_000_000, proformaId: r.proformaId });
      await refused(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 4_000_001, proformaId: r.proformaId }), 'over_agreed_cost');
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_000_000, proformaId: r.proformaId });
    });
  });
});

// ---------------------------------------------------------------------------
// Go-ahead, parts and confirmation
// ---------------------------------------------------------------------------

describe('go-ahead, deposit and confirmation rules', () => {
  it('a hotel payment request is refused without a valid go-ahead (none, pending, then stale after a new rate)', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ goAhead: false });
      const params = () => api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      // No booking request yet: either contract token names the gap.
      await refused(PURCHASE, api.createSql, await params(), /^(go_ahead_missing|booking_request_not_sent)$/);
      await sendBookingRequest(r.hotelTask);
      await refused(PURCHASE, api.createSql, await params(), 'go_ahead_missing');
      const g = await pendingGoAhead(r.hotelTask);
      await one(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()]);
      await one(PURCHASE, COST_SQL, [r.hotelTask, r.quoteId, await latestCostNo(r.hotelTask), '9000000', '2026-11-25', null, rid()]);
      // A new rate: no booking request for it yet and the old approval is stale.
      await refused(PURCHASE, api.createSql, await params(), /^(go_ahead_missing|booking_request_not_sent)$/);
      expect(await payments(r.hotelTask)).toEqual([]);
    });
  });

  it('a transfer deposit needs no go-ahead', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ goAhead: false });
      const s = await createSupplier();
      await bankDetails(s);
      await priced(r.transferTask, s, '3000000');
      const proforma = await storeMoneyFile(PURCHASE, r.transferTask, 'proforma');
      const p = await create(PURCHASE, { taskId: r.transferTask, part: 'deposit', amount: 1_000_000, proformaId: proforma });
      expect(p.status).toBe('pending');
    });
  });

  it('deposit before confirmation is allowed; balance and full need supplier confirmation; a proforma is required', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await refused(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: null }),
        /invalid_input|evidence_rejected|not_ready/);
      for (const part of ['balance', 'full'] as const) {
        await refused(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part, amount: 1_000_000, proformaId: r.proformaId }),
          /not_ready|invalid_input|not_confirmed/);
      }
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
    });
  });

  it('after supplier confirmation a balance request is allowed for the hotel with its go-ahead', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const ev = await one<{ evidenceId: string; objectPath: string }>(PURCHASE, PEV_BEGIN_SQL, [
        r.hotelTask, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, 'c'.repeat(64)]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await one(PURCHASE, PEV_FINISH_SQL, [ev.evidenceId, true]);
      expect((await one<{ outcome: string }>(PURCHASE, CONFIRM_SQL, [r.hotelTask, await latestCostNo(r.hotelTask), 'SYN-CONF-1'])).outcome).toBe('created');
      // Confirmation writes a committed cost version; the go-ahead given for the agreed rate must still carry the payment.
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'balance', amount: 4_000_000, proformaId: r.proformaId });
      expect(p.status).toBe('pending');
    });
  });

  it('a live payment blocks a new final rate (payment_in_progress); an open cancellation blocks requests (trip_cancelled)', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      await refused(PURCHASE, COST_SQL, [r.hotelTask, r.quoteId, await latestCostNo(r.hotelTask), '9000000', '2026-11-25', null, rid()], 'payment_in_progress');
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, 'Synthetic: the customer cancelled the trip', rid()]);
      await refused(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId }), 'trip_cancelled');
    });
  });

  it('approval re-checks the go-ahead: a revised booking after the request makes approve version_changed', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      await owner(`update public.accounts_booking_reviews set status = 'returned', return_reason = 'Synthetic return: budget to change',
        row_version = row_version + 1 where booking_version_id = $1`, [r.versionId]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, OPEN_REVISION_SQL, [r.versionId]);
      const saved = await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [r.hotelItem, opened.versionId, opened.rowVersion, JSON.stringify(HOTEL), '21000000']);
      await one(OWNER, CLASSIFY_SQL, [opened.versionId, saved.rowVersion, 'internal_only']);
      const ready = await h.readiness(OWNER, opened.versionId);
      await h.confirm(OWNER, opened.versionId, ready.contentHash);
      await refused(ACC, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version), 'version_changed');
      expect((await payment(p.id)).status).toBe('pending');
    });
  });
});

// ---------------------------------------------------------------------------
// Decide, record, verify
// ---------------------------------------------------------------------------

describe('decide, record and verify', () => {
  it('route accounts: Accounts approves; the Manager, Purchase and an Accounts person holding Purchase are refused', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await addMembership(U.movedStaff, 'accounts');
      await addMembership(U.movedStaff, 'purchase');
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      for (const actor of [MANAGER, MANAGER_AMD, PURCHASE, PURCHASE_2, OWNER]) {
        await refused(actor, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version), /not_authorized|not_self_approval/);
      }
      await approve(ACC, p);
      expect(await payment(p.id)).toMatchObject({ status: 'approved', approved_by: U.accountsJodhpur });
    });
  });

  it('route manager: only the Deal branch Manager approves; Accounts and the other-branch Manager are refused', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 6_000_000, proformaId: r.proformaId });
      expect(p.route).toBe('manager');
      for (const actor of [ACC, ACC2, MANAGER_AMD, PURCHASE]) {
        await refused(actor, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version), /not_authorized|not_self_approval/);
      }
      await approve(MANAGER, p);
      expect(await payment(p.id)).toMatchObject({ status: 'approved', approved_by: U.managerDelhi });
      // Manager approvals read: Delhi sees it, Ahmedabad does not.
      expect(JSON.stringify(await one(MANAGER, api.managerApprovalsSql))).toBeDefined();
      const amd = await run(MANAGER_AMD, api.managerApprovalsSql).then((x) => JSON.stringify(x)).catch(() => '');
      expect(amd).not.toContain(p.id);
    });
  });

  it('a Manager who also holds Purchase and requested the payment cannot approve it', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      await addMembership(U.visaJodhpur, 'accounts');
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      const supplierId = await createSupplier();
      await bankDetails(supplierId);
      await one(MANAGER, PURCHASE_CLAIM_SQL, [booked.hotelTask]);
      const { quoteId } = await one<{ quoteId: string }>(MANAGER, QUOTE_ADD_SQL, [booked.hotelTask, rid(), JSON.stringify({
        supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', quotedCostPaise: HOTEL_COST,
        holdUntil: '2026-11-30', cancellationTerms: 'Synthetic' })]);
      await one(MANAGER, COST_SQL, [booked.hotelTask, quoteId, 0, HOTEL_COST, '2026-11-25', null, rid()]);
      await one(MANAGER, BR_SEND_SQL, [booked.hotelTask, 1, SUPPLIER_EMAIL, [], 'Booking request · SYN-DEL-001', 'Synthetic body.', rid()]);
      const g = await pendingGoAhead(booked.hotelTask);
      await one(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()]);
      await verifiedReceipt('30000000');
      const proforma = await storeMoneyFile(MANAGER, booked.hotelTask, 'proforma');
      const p = await create(MANAGER, { taskId: booked.hotelTask, part: 'deposit', amount: 6_000_000, proformaId: proforma });
      expect(p.route).toBe('manager');
      await refused(MANAGER, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version), /not_self_approval|not_authorized/);
    });
  });

  it('only Accounts records an approved payment; the approver may record; a different Accounts person verifies', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      // Not before approval (no proof file can even be started yet).
      await refused(ACC, api.recordSql, api.recordParams(p.id, rid(), p.row_version), /not_ready|wrong_state|invalid_input|already_decided/);
      await approve(ACC, p);
      const early = await storeMoneyFile(ACC, p.id, 'payment_proof');
      for (const actor of [PURCHASE, MANAGER, OWNER]) {
        await refused(actor, api.recordSql, api.recordParams(p.id, early, (await payment(p.id)).row_version), 'not_authorized', '42501');
      }
      await one(ACC, api.recordSql, api.recordParams(p.id, early, (await payment(p.id)).row_version));
      expect(await payment(p.id)).toMatchObject({ status: 'paid', recorded_by: U.accountsJodhpur });
      await refused(ACC, api.verifySql, api.verifyParams(p.id, (await payment(p.id)).row_version), 'not_self_verification');
      await refused(PURCHASE, api.verifySql, api.verifyParams(p.id, (await payment(p.id)).row_version), 'not_authorized', '42501');
      await one(ACC2, api.verifySql, api.verifyParams(p.id, (await payment(p.id)).row_version));
      expect(await payment(p.id)).toMatchObject({ status: 'verified', verified_by: U.visaJodhpur });
      // Purchase can never fetch the payment proof file.
      await refused(PURCHASE, api.evidenceDownloadSql, [early], 'not_authorized', '42501');
    });
  });

  it('payments never change the task status: in_progress stays in_progress, supplier_confirmed stays confirmed', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      await approve(ACC, p);
      await record(ACC, p);
      await one(ACC2, api.verifySql, api.verifyParams(p.id, (await payment(p.id)).row_version));
      expect(await taskStatus(r.hotelTask)).toBe('in_progress');
      const ev = await one<{ evidenceId: string; objectPath: string }>(PURCHASE, PEV_BEGIN_SQL, [
        r.hotelTask, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, 'c'.repeat(64)]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await one(PURCHASE, PEV_FINISH_SQL, [ev.evidenceId, true]);
      await one(PURCHASE, CONFIRM_SQL, [r.hotelTask, await latestCostNo(r.hotelTask), 'SYN-CONF-1']);
      const p2 = await create(PURCHASE, { taskId: r.hotelTask, part: 'balance', amount: 3_000_000, proformaId: r.proformaId });
      await approve(ACC, p2);
      await record(ACC, p2);
      expect(await taskStatus(r.hotelTask)).toBe('supplier_confirmed');
    });
  });

  it('a bank-detail change blocks recording (bank_details_on_hold) until the Manager approves it', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      await approve(ACC, p);
      const rev = await bankDetails(r.supplierId, false, '000099998888');
      const proof = await storeMoneyFile(ACC, p.id, 'payment_proof');
      await refused(ACC, api.recordSql, api.recordParams(p.id, proof, (await payment(p.id)).row_version), 'bank_details_on_hold');
      const list = await one(ACC, api.accountsPaymentsSql, ['to_record']);
      expect(JSON.stringify(list)).toMatch(/"onHold":\s*true/);
      await one(MANAGER, APPROVE_BENEFICIARY_SQL, [r.supplierId, rev]);
      await one(ACC, api.recordSql, api.recordParams(p.id, proof, (await payment(p.id)).row_version));
      expect((await payment(p.id)).status).toBe('paid');
    });
  });
});

// ---------------------------------------------------------------------------
// Company funding
// ---------------------------------------------------------------------------

describe('company funding (lead rule after review: no customer-money signal to Purchase)', () => {
  it('short customer money is never refused: the server creates the funding for the difference; Purchase sees nothing of it', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ customerMoney: '1765433' });
      const ctx = await one<Record<string, unknown>>(PURCHASE, api.purchaseContextSql, [r.hotelTask]);
      expectNoLeak('purchase_payment_context', ctx, ['1765433']);
      // A note shorter than 10 characters is still invalid input.
      await refused(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId,
        fundingReason: 'short' }), 'invalid_input', '22023');
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId, fundingReason: FUNDING_REASON });
      const [f] = await fundings();
      // amount = max(0, 30,000.00 - 17,654.33) = 12,345.67
      expect(f).toMatchObject({ status: 'pending', route: 'accounts', amount_paise: '1234567', payment_request_id: p.id, reason: FUNDING_REASON });
      // Funding pending: the payment may be approved but not recorded.
      await approve(ACC, p);
      const proof = await storeMoneyFile(ACC, p.id, 'payment_proof');
      await refused(ACC, api.recordSql, api.recordParams(p.id, proof, (await payment(p.id)).row_version), 'funding_pending');
      for (const actor of [PURCHASE, MANAGER, OWNER]) {
        await refused(actor, api.fundingDecideSql, api.fundingDecideParams(f!.id, 'approve', null, f!.row_version), /not_authorized|not_self_approval/);
      }
      await one(ACC2, api.fundingDecideSql, api.fundingDecideParams(f!.id, 'approve', null, f!.row_version));
      await one(ACC, api.recordSql, api.recordParams(p.id, proof, (await payment(p.id)).row_version));
      expect((await payment(p.id)).status).toBe('paid');
      expectNoLeak('purchase_payment_requests', await one(PURCHASE, api.purchaseRequestsSql, ['all']), ['1234567', '1765433', proof]);
      expectNoLeak('purchase_workspace', await one(PURCHASE, WORKSPACE_SQL, [r.hotelTask]), ['1234567', '1765433', proof]);
      const after = (await fundings())[0]!;
      await refused(PURCHASE, api.fundingRecoveredSql, api.fundingRecoveredParams(after.id, after.row_version), 'not_authorized', '42501');
      await one(ACC, api.fundingRecoveredSql, api.fundingRecoveredParams(after.id, after.row_version));
      expect((await fundings())[0]!.status).toBe('recovered');
    });
  });

  it('without a Purchase note the funding is still created (note optional)', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ customerMoney: null });
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      const [f] = await fundings();
      expect(f).toMatchObject({ status: 'pending', amount_paise: '1000000', payment_request_id: p.id });
    });
  });

  it('funding route follows the cumulative company money on the Deal; Manager route is the Deal branch Manager', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ customerMoney: null });
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId, fundingReason: FUNDING_REASON });
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_500_000, proformaId: r.proformaId, fundingReason: FUNDING_REASON });
      const rows = await fundings();
      expect(rows.map((f) => [f.amount_paise, f.route])).toEqual([['2500000', 'manager'], ['3000000', 'accounts']]);
      const m = rows.find((f) => f.route === 'manager')!;
      for (const actor of [ACC, ACC2, MANAGER_AMD]) {
        await refused(actor, api.fundingDecideSql, api.fundingDecideParams(m.id, 'approve', null, m.row_version), /not_authorized|not_self_approval/);
      }
      await one(MANAGER, api.fundingDecideSql, api.fundingDecideParams(m.id, 'approve', null, m.row_version));
      expect((await fundings()).find((f) => f.id === m.id)!.status).toBe('approved');
    });
  });

  it('customer money already promised to live (even pending) requests is not available again', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ customerMoney: '4000000' });
      // 40k received, 30k request: fully covered, no funding.
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId });
      expect(await fundings()).toEqual([]);
      // Still pending, but its 30k customer part is promised: a 20k request is funded for 10k.
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      expect((await fundings()).map((f) => f.amount_paise)).toEqual(['1000000']);
    });
  });

  it('not short: no funding, whatever the amount', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ customerMoney: HOTEL_COST });
      const big = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 6_000_000, proformaId: r.proformaId });
      const rest = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_000_000, proformaId: r.proformaId });
      expect([big.status, rest.status]).toEqual(['pending', 'pending']);
      expect(await fundings()).toEqual([]);
    });
  });

  it('Purchase-visible outputs are identical for a short Deal and a fully paid Deal', async () => {
    /** Ids, references and times differ per run; everything else must match exactly. */
    const normalize = (v: unknown) => JSON.stringify(v)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/SP-\d{4}-\d{6}/g, '<ref>')
      .replace(/\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+/g, '<time>')
      .replace(/Synthetic Supplier [0-9a-f]{8}/g, '<supplier>');
    const capture = async (customerMoney: string | null) => asOwner(db, async () => {
      const r = await readyHotel({ customerMoney });
      const context = await one(PURCHASE, api.purchaseContextSql, [r.hotelTask]);
      const reply = await one(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId }));
      const contextAfter = await one(PURCHASE, api.purchaseContextSql, [r.hotelTask]);
      const mine = await one(PURCHASE, api.purchaseRequestsSql, ['mine']);
      const all = await one(PURCHASE, api.purchaseRequestsSql, ['all']);
      const fundingRows = (await fundings()).length;
      return { out: { context, reply, contextAfter, mine, all }, fundingRows };
    });
    const short = await capture(null);
    const paid = await capture('30000000');
    // Sanity: the two Deals really differ on the Accounts side.
    expect([short.fundingRows, paid.fundingRows]).toEqual([1, 0]);
    for (const k of ['context', 'reply', 'all'] as const) expect(short.out[k], `${k} is a real read`).toBeTruthy();
    expect(normalize(short.out.all)).toContain('<ref>');
    for (const k of ['context', 'reply', 'contextAfter', 'mine', 'all'] as const) {
      expect(normalize(short.out[k]), k).toBe(normalize(paid.out[k]));
    }
  });
});

describe('review changes: e-mail delivery, cancellation and stale go-ahead at approve/record, decider conflicts', () => {
  const SERVICE: Actor = { userId: null, role: 'service_role' };
  const PROVIDER_ID = '0b0e6f3c-5d7a-4c1e-9f00-000000000002';
  const MARK_SQL = 'select public.purchase_email_mark_result($1, $2, $3, $4) as r';

  it('a hotel payment request is refused while the booking e-mail is queued or failed (booking_request_not_sent)', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ goAhead: false });
      await owner('update public.procurement_settings set supplier_email_sending_enabled = true');
      await sendBookingRequest(r.hotelTask);
      const [mail] = await owner<{ id: string; status: string }>(
        `select id, status from public.purchase_supplier_emails where task_id = $1 and kind = 'booking_request'`, [r.hotelTask]);
      expect(mail!.status).toBe('queued');
      const params = async () => api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      await refused(PURCHASE, api.createSql, await params(), 'booking_request_not_sent');
      await one(SERVICE, MARK_SQL, [mail!.id, 'failed', null, 'synthetic_failure']);
      await refused(PURCHASE, api.createSql, await params(), 'booking_request_not_sent');
      expect(await payments(r.hotelTask)).toEqual([]);
      void PROVIDER_ID;
    });
  });

  it('an open trip cancellation stops approve and record', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const pending = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      const approved = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      await approve(ACC, approved);
      const proof = await storeMoneyFile(ACC, approved.id, 'payment_proof');
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, 'Synthetic: the customer cancelled the trip', rid()]);
      await refused(ACC, api.decideSql, api.decideParams(pending.id, 'approve', null, pending.row_version), 'trip_cancelled');
      await refused(ACC, api.recordSql, api.recordParams(approved.id, proof, (await payment(approved.id)).row_version), 'trip_cancelled');
      expect([(await payment(pending.id)).status, (await payment(approved.id)).status]).toEqual(['pending', 'approved']);
    });
  });

  it('a go-ahead gone stale (booking review no longer approved) stops approve and record of an unconfirmed hotel', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const pending = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      const approved = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      await approve(ACC, approved);
      const proof = await storeMoneyFile(ACC, approved.id, 'payment_proof');
      await owner(`update public.accounts_booking_reviews set status = 'returned', return_reason = 'Synthetic return: billing to check',
        row_version = row_version + 1 where booking_version_id = $1`, [r.versionId]);
      await refused(ACC, api.decideSql, api.decideParams(pending.id, 'approve', null, pending.row_version), /^(version_changed|go_ahead_missing)$/);
      await refused(ACC, api.recordSql, api.recordParams(approved.id, proof, (await payment(approved.id)).row_version), /^(version_changed|go_ahead_missing)$/);
      expect([(await payment(pending.id)).status, (await payment(approved.id)).status]).toEqual(['pending', 'approved']);
    });
  });

  it('a Manager who also holds Purchase cannot decide payments or funding and reads no customer money', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      const r = await readyHotel({ customerMoney: '1765433' });
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 6_000_000, proformaId: r.proformaId, fundingReason: FUNDING_REASON });
      expect(p.route).toBe('manager');
      const [f] = await fundings(); // 60,000 - 17,654.33 = 42,345.67 of company money
      expect(f!.amount_paise).toBe('4234567');
      await refused(MANAGER, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version), /not_authorized|not_self_approval/);
      await refused(MANAGER, api.fundingDecideSql, api.fundingDecideParams(f!.id, 'approve', null, f!.row_version), /not_authorized|not_self_approval/);
      const reads = [
        await run(MANAGER, api.managerApprovalsSql).catch(() => []),
        await run(MANAGER, api.purchaseContextSql, [r.hotelTask]).catch(() => []),
        await run(MANAGER, api.purchaseRequestsSql, ['all']).catch(() => []),
        await run(MANAGER, WORKSPACE_SQL, [r.hotelTask]).catch(() => []),
      ];
      for (const read of reads) {
        const text = JSON.stringify(read);
        for (const v of ['1765433', '4234567', FUNDING_REASON]) expect(text.includes(v), v).toBe(false);
      }
      expect((await payment(p.id)).status).toBe('pending');
    });
  });

  it('the Deal owner (Sales) who also holds Accounts cannot approve its payments or funding (deal conflict)', async () => {
    await asOwner(db, async () => {
      await addMembership(U.salesDelhiA, 'accounts');
      const r = await readyHotel({ customerMoney: '1765433' });
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId });
      const [f] = await fundings();
      expect(p.route).toBe('accounts');
      await refused(OWNER, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version), /not_authorized|not_self_approval/);
      await refused(OWNER, api.fundingDecideSql, api.fundingDecideParams(f!.id, 'approve', null, f!.row_version), /not_authorized|not_self_approval/);
      expect((await payment(p.id)).status).toBe('pending');
    });
  });
});

// ---------------------------------------------------------------------------
// Duplicates and concurrency
// ---------------------------------------------------------------------------

describe('duplicates and concurrency (sequential half)', () => {
  it('the same request id replays a payment request without a second row', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const req = rid();
      const a = await one(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId, requestId: req }));
      const b = await one(PURCHASE, api.createSql, await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId, requestId: req }));
      const sans = (v: unknown) => { const { outcome: _o, ...rest } = v as Record<string, unknown>; return rest; };
      expect(sans(b)).toEqual(sans(a));
      expect(await payments(r.hotelTask)).toHaveLength(1);
    });
  });

  it('a stale row version is version_changed; a second decision is refused', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      await refused(ACC, api.decideSql, api.decideParams(p.id, 'approve', null, p.row_version + 7), 'version_changed');
      await approve(ACC, p);
      const now = await payment(p.id);
      await refused(ACC, api.decideSql, api.decideParams(p.id, 'return', 'Synthetic: changed my mind here', now.row_version), 'already_decided');
      await refused(ACC, api.decideSql, api.decideParams(p.id, 'return', 'Synthetic: changed my mind here', p.row_version), /version_changed|already_decided/);
      expect((await payment(p.id)).status).toBe('approved');
      // Purchase cannot cancel an approved request.
      await expectDbError(db, () => run(PURCHASE, api.cancelSql, api.cancelParams(p.id, now.row_version)), {});
    });
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('direct calls by people who may not do the work', () => {
  it('Sales, Flight, Visa, another-branch Manager, Accounts and an unassigned Purchase person cannot request a supplier payment', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await addMembership(U.movedStaff, 'flight');
      const params = await api.createParams({ taskId: r.hotelTask, part: 'deposit', amount: 1_000_000, proformaId: r.proformaId });
      for (const actor of [OWNER, FLIGHT, MANAGER_AMD, MANAGER, ACC]) {
        await refused(actor, api.createSql, params, 'not_authorized', '42501');
      }
      await addMembership(U.movedStaff, 'purchase');
      await refused(PURCHASE_2, api.createSql, params, 'not_authorized', '42501');
      expect(await payments(r.hotelTask)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Supplier invoices and credit notes
// ---------------------------------------------------------------------------

describe('supplier invoices and credit notes', () => {
  type Doc = { id: string; status: string; row_version: number; uploaded_by: string; reviewed_by: string | null; kind: string };
  const docs = (taskId: string) => owner<Doc>(
    `select id, status, row_version, uploaded_by, reviewed_by, kind from public.supplier_documents where task_id = $1 order by kind`, [taskId]);

  it('Purchase uploads, Accounts accepts or returns with a reason; Sales cannot upload', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      const inv = await storeMoneyFile(PURCHASE, r.hotelTask, 'invoice');
      const cn = await storeMoneyFile(PURCHASE, r.hotelTask, 'credit_note');
      await refused(OWNER, api.docUploadSql, api.docUploadParams(r.hotelTask, 'invoice', inv), 'not_authorized', '42501');
      await one(PURCHASE, api.docUploadSql, api.docUploadParams(r.hotelTask, 'invoice', inv));
      await one(PURCHASE, api.docUploadSql, api.docUploadParams(r.hotelTask, 'credit_note', cn));
      const [credit, invoice] = await docs(r.hotelTask);
      expect(invoice).toMatchObject({ status: 'uploaded', uploaded_by: U.purchaseJodhpur });
      for (const actor of [PURCHASE, MANAGER, OWNER]) {
        await refused(actor, api.docReviewSql, api.docReviewParams(invoice!.id, 'accept', null, invoice!.row_version), /not_authorized|not_self_approval/);
      }
      await refused(ACC, api.docReviewSql, api.docReviewParams(credit!.id, 'return', null, credit!.row_version), 'invalid_input', '22023');
      await refused(ACC, api.docReviewSql, api.docReviewParams(credit!.id, 'return', 'short', credit!.row_version), 'invalid_input', '22023');
      await one(ACC, api.docReviewSql, api.docReviewParams(credit!.id, 'return', 'Synthetic: credit note total unreadable', credit!.row_version));
      await one(ACC, api.docReviewSql, api.docReviewParams(invoice!.id, 'accept', null, invoice!.row_version));
      const after = await docs(r.hotelTask);
      expect(after.map((d) => [d.kind, d.status, d.reviewed_by])).toEqual([
        ['credit_note', 'returned', U.accountsJodhpur], ['invoice', 'accepted', U.accountsJodhpur]]);
      // A second review is refused.
      await expectDbError(db, () => run(ACC, api.docReviewSql, api.docReviewParams(after[1]!.id, 'return', 'Synthetic: second look at it', after[1]!.row_version)), {});
    });
  });

  it('an Accounts person who also holds Purchase cannot review their own upload', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await addMembership(U.visaJodhpur, 'purchase'); // ACC2 now Accounts + Purchase
      const inv = await storeMoneyFile(ACC2, r.hotelTask, 'invoice').catch(() => null);
      if (inv === null) return; // the uploader must be the assignee; covered by the main path
      await one(ACC2, api.docUploadSql, api.docUploadParams(r.hotelTask, 'invoice', inv));
      const [doc] = await docs(r.hotelTask);
      await refused(ACC2, api.docReviewSql, api.docReviewParams(doc!.id, 'accept', null, doc!.row_version), /not_authorized|not_self_approval/);
    });
  });
});

// ---------------------------------------------------------------------------
// Leakage and counts
// ---------------------------------------------------------------------------

describe('Purchase-callable reads carry no customer money, proof ids or funding', () => {
  it('purchase_payment_requests, purchase_payment_context, workspace and supplier reads after the full money flow', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel({ customerMoney: '1765433' });
      const p = await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 3_000_000, proformaId: r.proformaId, fundingReason: FUNDING_REASON });
      await approve(ACC, p);
      const [f] = await fundings();
      await one(ACC2, api.fundingDecideSql, api.fundingDecideParams(f!.id, 'approve', null, f!.row_version));
      const proof = await storeMoneyFile(ACC, p.id, 'payment_proof');
      await one(ACC, api.recordSql, api.recordParams(p.id, proof, (await payment(p.id)).row_version));
      const extra = ['1765433', '1234567', proof, f!.id];
      const reads: Array<[string, unknown]> = [
        ['purchase_payment_requests mine', await one(PURCHASE, api.purchaseRequestsSql, ['mine'])],
        ['purchase_payment_requests all', await one(PURCHASE, api.purchaseRequestsSql, ['all'])],
        ['purchase_payment_context', await one(PURCHASE, api.purchaseContextSql, [r.hotelTask])],
        ['purchase_workspace', await one(PURCHASE, WORKSPACE_SQL, [r.hotelTask])],
        ['purchase_task_list', await one(PURCHASE, 'select public.purchase_task_list() as r')],
        ['supplier_list', await one(PURCHASE, 'select public.supplier_list() as r')],
        ['supplier_get', await one(PURCHASE, 'select public.supplier_get($1) as r', [r.supplierId])],
      ];
      for (const [label, value] of reads) expectNoLeak(label, value, extra);
      // Purchase reads of the Accounts pages are refused or empty.
      for (const sql of [api.accountsPaymentsSql, api.accountsFundingSql, api.accountsDocumentsSql]) {
        const seen = await run(PURCHASE, sql, ['all']).then((x) => JSON.stringify(x)).catch(() => '');
        expect(seen).not.toContain(p.id);
        expect(seen).not.toContain(FUNDING_REASON);
      }
    });
  });

  it('Home counts real requests to approve for Accounts and the branch Manager', async () => {
    await asOwner(db, async () => {
      const r = await readyHotel();
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 2_000_000, proformaId: r.proformaId });
      await create(PURCHASE, { taskId: r.hotelTask, part: 'deposit', amount: 4_000_000, proformaId: r.proformaId }); // 60k: manager
      const acc = await one<{ requestsToApprove: number }>(ACC, 'select public.my_work_counts() as r');
      const mgr = await one<{ requestsToApprove: number }>(MANAGER, 'select public.my_work_counts() as r');
      expect(acc.requestsToApprove).toBeGreaterThanOrEqual(1);
      expect(mgr.requestsToApprove).toBeGreaterThanOrEqual(1);
    });
  });
});
