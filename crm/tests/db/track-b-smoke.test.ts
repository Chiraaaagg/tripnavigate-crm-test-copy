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
import { HOTEL, PURCHASE_CLAIM_SQL, TRANSFER, b1Helpers } from './b1-support';

/**
 * Track B author's smoke test (the independent suite is
 * tests/db/supplier-money.test.ts by Track D). Covers the reads and Home
 * keys of 20261130000210_supplier_money_reads.sql and the "return an
 * approved request only while it is on hold" rule.
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
const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const DEAL = D.del001;
const today = () => istBusinessDate();

async function addAccounts2(): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'
     on conflict do nothing`,
    [U.visaJodhpur],
  );
}

async function setup(opts: { budget?: string; cost?: string; customerMoney?: string | null } = {}) {
  await addAccounts2();
  await h.setSwitch('service_items_enabled', true);
  const opened = await h.openDraft(OWNER, DEAL);
  let rv = opened.rowVersion;
  rv = (await h.addItem(OWNER, opened.versionId, rv, 'hotel', HOTEL, opts.budget ?? '20000000')).rowVersion;
  rv = (await h.addItem(OWNER, opened.versionId, rv, 'transfer', TRANSFER, '8000000')).rowVersion;
  rv = (await h.saveTravellers(OWNER, DEAL, rv)).rowVersion;
  rv = (await h.saveSelling(OWNER, opened.versionId, rv, '45678901')).rowVersion;
  await h.completeB11(OWNER, DEAL, opened.versionId, rv, '45678901');
  await h.storeEvidence(OWNER, opened.versionId);
  const ready = await h.readiness(OWNER, opened.versionId);
  await h.confirm(OWNER, opened.versionId, ready.contentHash);
  const [task] = await owner<{ id: string }>(
    `select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase' and service_purpose = 'hotel'`, [DEAL]);
  await owner(
    `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
     select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1
     on conflict (booking_version_id) do update set status = 'approved', reviewed_by = excluded.reviewed_by, reviewed_at = now()`,
    [opened.versionId, U.accountsJodhpur],
  );
  const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
  const { supplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [
    entity!.id,
    JSON.stringify({ name: `Synthetic Smoke ${rid().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null,
      contactPhone: null, contactEmail: 'desk@example.test', paymentTerms: null }),
  ]);
  const bank = await one<{ revisionNo: number }>(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [
    supplierId, rid(), JSON.stringify({ accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' })]);
  await one(MANAGER, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierId, bank.revisionNo]);
  await one(PURCHASE, PURCHASE_CLAIM_SQL, [task!.id]);
  const cost = opts.cost ?? '10000000';
  const { quoteId } = await one<{ quoteId: string }>(PURCHASE, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task!.id, rid(),
    JSON.stringify({ supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: null, mealPlan: null, quotedCostPaise: cost,
      holdUntil: null, cancellationTerms: null })]);
  await one(PURCHASE, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r',
    [task!.id, quoteId, 0, cost, null, null, rid()]);
  if (opts.customerMoney !== null) await verifiedReceipt(opts.customerMoney ?? '30000000');
  return { taskId: task!.id, supplierId, versionId: opened.versionId };
}

async function goAhead(taskId: string, approve = true): Promise<void> {
  await one(PURCHASE, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
    [taskId, 1, 'desk@example.test', [], 'Booking request · SYN-DEL-001 · Synthetic', 'Synthetic body.', rid()]);
  if (!approve) return;
  const [g] = await owner<{ id: string; row_version: number }>(
    `select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`, [taskId]);
  await one(ACC, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [g!.id, 'approve', null, g!.row_version, rid()]);
}

async function verifiedReceipt(amount: string): Promise<void> {
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
}

async function moneyFile(actor: Actor, target: string, kind: string): Promise<string> {
  const ev = await one<{ evidenceId: string; objectPath: string }>(actor,
    'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
    [kind, target, `${kind}.pdf`, 'application/pdf', 2048, rid().replace(/-/g, '').padEnd(64, 'a'), rid()]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`,
    [ev.objectPath]);
  await one(actor, 'select public.supplier_money_evidence_finish($1, true) as r', [ev.evidenceId]);
  return ev.evidenceId;
}

async function request(taskId: string, amount: number, extra: Record<string, unknown> = {}) {
  const proforma = await moneyFile(PURCHASE, taskId, 'proforma');
  return one<{ id: string; route: string; refNo: string }>(PURCHASE,
    'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', [taskId, JSON.stringify({
      expectedCostVersionNo: 1, part: 'deposit', amountPaise: String(amount), dueDate: null, note: null,
      proformaEvidenceId: proforma, askFunding: false, ...extra }), rid()]);
}
const rowVersion = async (id: string) =>
  (await owner<{ v: number }>('select row_version as v from public.supplier_payment_requests where id = $1', [id]))[0]!.v;
const counts = (actor: Actor) => one<Record<string, number | null>>(actor, 'select public.supplier_money_home_counts() as r');
type Row = { id: string; canDecide: boolean; canRecord: boolean; canVerify: boolean; holdReason: string | null };
const tab = (actor: Actor, t: string) => one<Row[]>(actor, 'select public.accounts_supplier_payments($1) as r', [t]);

describe('Track B smoke', () => {
  it('Home rows: Purchase go-ahead waiting and returned requests; Accounts and Manager keys; Sales gets nulls', async () => {
    await asOwner(db, async () => {
      const { taskId } = await setup();
      await goAhead(taskId, false);
      expect((await counts(PURCHASE)).purchaseWaitingForGoAhead).toBe(1);
      expect((await counts(ACC)).goAheadToApprove).toBe(1);
      const [g] = await owner<{ id: string; row_version: number }>(
        `select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`, [taskId]);
      await one(ACC, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [g!.id, 'approve', null, g!.row_version, rid()]);
      const p = await request(taskId, 2_000_000);
      expect(p.route).toBe('accounts');
      const acc = await counts(ACC);
      expect(acc.supplierPaymentsToApprove).toBe(1);
      expect(acc.requestsToApprove).toBe(1);
      await one(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
        [p.id, 'return', 'Synthetic: wrong proforma attached', await rowVersion(p.id), rid()]);
      const pur = await counts(PURCHASE);
      expect(pur.paymentRequestsReturned).toBe(1);
      expect(pur.purchaseWaitingForGoAhead).toBe(0);
      const sales = await counts(OWNER);
      expect(sales.goAheadToApprove ?? null).toBeNull();
      expect(sales.paymentRequestsReturned ?? null).toBeNull();
      expect(sales.managerApprovals ?? null).toBeNull();
      expect(typeof (await counts(MANAGER)).managerApprovals).toBe('number');
    });
  });

  it('Accounts tabs carry the right flags through approve, record and verify', async () => {
    await asOwner(db, async () => {
      const { taskId } = await setup();
      await goAhead(taskId);
      const p = await request(taskId, 2_500_000);
      expect((await tab(ACC, 'to_approve')).map((r) => [r.id, r.canDecide])).toEqual([[p.id, true]]);
      await one(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r', [p.id, 'approve', null, await rowVersion(p.id), rid()]);
      expect((await tab(ACC, 'to_record')).map((r) => [r.id, r.canRecord])).toEqual([[p.id, true]]);
      const proof = await moneyFile(ACC, p.id, 'payment_proof');
      // Purchase never downloads a payment proof.
      await expectDbError(db, async () => run(PURCHASE, 'select public.supplier_money_evidence_authorize_download($1) as r', [proof]), { code: '42501' });
      await one(ACC, 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
        [p.id, today(), 'upi', 'UPI-SYN-0001', proof, await rowVersion(p.id), rid()]);
      expect(await tab(ACC, 'to_verify')).toEqual([]);
      expect((await tab(ACC2, 'to_verify')).map((r) => [r.id, r.canVerify])).toEqual([[p.id, true]]);
      await one(ACC2, 'select public.supplier_payment_verify($1, $2, $3) as r', [p.id, await rowVersion(p.id), rid()]);
      expect((await tab(ACC, 'all')).length).toBe(1);
      const ctx = await one<{ requests: Array<{ status: string }>; remainingPaise: string }>(PURCHASE,
        'select public.purchase_payment_context($1) as r', [taskId]);
      expect(ctx.requests[0]!.status).toBe('verified');
      expect(ctx.remainingPaise).toBe('7500000');
    });
  });

  it('an approved request is returned only while it is on hold (new bank details)', async () => {
    await asOwner(db, async () => {
      const { taskId, supplierId } = await setup();
      await goAhead(taskId);
      const p = await request(taskId, 2_000_000);
      await one(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r', [p.id, 'approve', null, await rowVersion(p.id), rid()]);
      await expectDbError(db, async () => run(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
        [p.id, 'return', 'Synthetic: not on hold yet', 2, rid()]), { message: /^already_decided$/ });
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, rid(),
        JSON.stringify({ accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank', ifsc: 'SYNB0000002', accountNumber: '000099998888' })]);
      expect((await tab(ACC, 'to_record'))[0]!.holdReason).toBe('bank_details_on_hold');
      const back = await one<{ status: string }>(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
        [p.id, 'return', 'Synthetic: supplier changed bank details', await rowVersion(p.id), rid()]);
      expect(back.status).toBe('returned');
    });
  });

  it('funding: approve, record, mark recovered; manager approvals list a manager-route request', async () => {
    await asOwner(db, async () => {
      const { taskId } = await setup({ cost: '9000000', customerMoney: '1000000' });
      await goAhead(taskId);
      const p = await request(taskId, 6_000_000, { fundingReason: 'Synthetic: hotel hold expires tomorrow' });
      expect(p.route).toBe('manager');
      expect(p).not.toHaveProperty('companyFundingAsked');
      const mgr = await one<{ payments: Array<{ id: string; canDecide: boolean }>; funding: Array<{ amountPaise: string; route: string }> }>(
        MANAGER, 'select public.manager_approvals() as r');
      expect(mgr.payments.map((x) => [x.id, x.canDecide])).toEqual([[p.id, true]]);
      expect(mgr.funding).toEqual([]); // 50,000 of funding is routed to Accounts
      const [f] = await one<Array<{ id: string; amountPaise: string; route: string; rowVersion: number }>>(ACC,
        'select public.accounts_company_funding($1) as r', ['to_approve']);
      expect([f!.amountPaise, f!.route]).toEqual(['5000000', 'accounts']);
      await one(MANAGER, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r', [p.id, 'approve', null, await rowVersion(p.id), rid()]);
      const proof = await moneyFile(ACC, p.id, 'payment_proof');
      await expectDbError(db, async () => run(ACC, 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
        [p.id, today(), 'bank_transfer', 'UTRSYN0001', proof, await rowVersion(p.id), rid()]), { message: /^funding_pending$/ });
      await one(ACC, 'select public.company_funding_decide($1, $2, $3, $4, $5) as r', [f!.id, 'approve', null, f!.rowVersion, rid()]);
      await one(ACC, 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
        [p.id, today(), 'bank_transfer', 'UTRSYN0001', proof, await rowVersion(p.id), rid()]);
      const [rec] = await one<Array<{ id: string; rowVersion: number; canMarkRecovered: boolean }>>(ACC,
        'select public.accounts_company_funding($1) as r', ['to_recover']);
      expect(rec!.canMarkRecovered).toBe(true);
      const done = await one<{ status: string }>(ACC, 'select public.company_funding_mark_recovered($1, $2, $3, $4) as r',
        [rec!.id, 'Synthetic: customer paid the balance', rec!.rowVersion, rid()]);
      expect(done.status).toBe('recovered');
      const home = await counts(ACC);
      expect(home.fundingToRecover).toBe(0);
    });
  });

  // Review F1 (lead decision): Purchase gets no customer money signal at all.
  type Visible = Record<string, unknown>;
  const omit = (r: object, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
  const purchaseRow = async (id: string) =>
    (await one<Visible[]>(PURCHASE, 'select public.purchase_payment_requests($1) as r', ['mine'])).find((r) => r.id === id)!;
  const sansAmount = (r: Visible) => omit(r, ['id', 'refNo', 'amountPaise', 'requestedAt', 'proformaEvidenceId']);
  const allKeys = (v: unknown, acc: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); allKeys(x, acc); }
    return acc;
  };
  const decide = async (actor: Actor, id: string) =>
    one(actor, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r', [id, 'approve', null, await rowVersion(id), rid()]);

  it('F1: amounts with and without company funding look identical to Purchase; no customer money refusal or key', async () => {
    await asOwner(db, async () => {
      const { taskId } = await setup({ customerMoney: '1000000' });
      await goAhead(taskId);
      // 500,000 is covered by customer money; the pending 500,000 is then promised, so 4,000,000
      // needs 3,500,000 of company money. No note, no ask.
      const small = await request(taskId, 500_000);
      const large = await request(taskId, 4_000_000);
      expect(omit(large, ['id', 'refNo'])).toEqual(omit(small, ['id', 'refNo']));
      expect(sansAmount(await purchaseRow(large.id))).toEqual(sansAmount(await purchaseRow(small.id)));
      const ctx = await one<Visible>(PURCHASE, 'select public.purchase_payment_context($1) as r', [taskId]);
      const keys = [...allKeys([ctx, await one(PURCHASE, 'select public.purchase_payment_requests($1) as r', ['all'])])];
      expect(keys.filter((k) => /customerMoney|companyFunding|funding/i.test(k))).toEqual([]);
      const funding = await owner<{ amount: string; reason: string; payment_request_id: string }>(
        'select amount_paise::text as amount, reason, payment_request_id from public.company_funding_requests where deal_id = $1', [DEAL]);
      expect(funding).toEqual([{ amount: '3500000', reason: 'No note from Purchase', payment_request_id: large.id }]);
      // Accounts approves the funding; the held approved payment still shows to Purchase like any approved one.
      await decide(ACC, small.id);
      await decide(ACC, large.id);
      expect(sansAmount(await purchaseRow(large.id))).toEqual(sansAmount(await purchaseRow(small.id)));
    });
  });

  it('F3/F5/F6: trip cancellation and Purchase-holding managers; Deal Sales cannot approve', async () => {
    await asOwner(db, async () => {
      const { taskId } = await setup({ cost: '9000000' });
      await goAhead(taskId);
      const small = await request(taskId, 1_000_000); // accounts route
      const big = await request(taskId, 6_000_000); // 7,000,000 for this supplier: manager route
      expect([small.route, big.route]).toEqual(['accounts', 'manager']);
      // F5: the branch Manager who also holds Purchase is refused and sees nothing.
      await owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'DEL' on conflict do nothing`,
        [U.managerDelhi]);
      await expectDbError(db, async () => decide(MANAGER, big.id), { message: /^not_authorized$/ });
      expect((await one<{ payments: unknown[] }>(MANAGER, 'select public.manager_approvals() as r')).payments).toEqual([]);
      await owner(`delete from public.memberships where user_id = $1 and role_code = 'purchase'`, [U.managerDelhi]);
      // F6: an Accounts person with a Sales assignment on the Deal cannot approve.
      await owner(`insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
        select d.id, d.legal_entity_id, $2, 'sales' from public.deals d where d.id = $1`, [DEAL, U.accountsJodhpur]);
      await expectDbError(db, async () => decide(ACC, small.id), { message: /^not_self_approval$/ });
      await owner(`update public.deal_assignments set ended_at = now() where deal_id = $1 and user_id = $2`, [DEAL, U.accountsJodhpur]);
      await decide(ACC, small.id);
      // F3: an open trip cancellation stops approval and recording.
      const proof = await moneyFile(ACC, small.id, 'payment_proof');
      await one(MANAGER, 'select public.deal_cancellation_open($1, $2, $3) as r', [DEAL, 'Synthetic: the traveller cancelled the trip', rid()]);
      await expectDbError(db, async () => decide(MANAGER, big.id), { message: /^trip_cancelled$/ });
      await expectDbError(db, async () => run(ACC, 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
        [small.id, today(), 'upi', 'UPI-SYN-0002', proof, await rowVersion(small.id), rid()]), { message: /^trip_cancelled$/ });
    });
  });
});
