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
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase, Track B smoke checks (the builder's own checks; the
 * independent suites are Track E's accounts-desk-*.test.ts). Migrations
 * 20261203000200..0250: workspace read, Tally matching and export, GST
 * invoice references, supplier document rules and links, dues.
 * Synthetic data only, every scenario rolled back.
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
const today = () => istBusinessDate();

const OWNER: Actor = { userId: U.salesDelhiA };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
const SUPER: Actor = { userId: U.adminJodhpur };
const DEAL = D.del001;
const SELLING = '45678901';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Page = { items: Row[]; hasMore: boolean; nextAfter: string | null; scope: { mode: string; readOnly: boolean } } | null;

async function refused(actor: Actor, sql: string, params: unknown[], token: string | RegExp, code?: string): Promise<void> {
  const message = typeof token === 'string' ? new RegExp(`^${token}$`) : token;
  await expectDbError(db, () => run(actor, sql, params), { message, ...(code ? { code } : {}) });
}

async function addMembership(user: string, role: string, branch = 'JDH'): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $2, 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $3 on conflict do nothing`,
    [user, role, branch],
  );
  await owner(`update public.staff_profiles set status = 'active' where user_id = $1`, [user]);
}

const latestCostNo = async (taskId: string) =>
  (await owner<{ n: number }>('select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1', [taskId]))[0]!.n;
const agreedCostNo = async (taskId: string) =>
  (await owner<{ n: number }>(`select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1 and stage = 'proposed'`, [taskId]))[0]!.n;

async function storeMoneyFile(actor: Actor, target: string, kind: string): Promise<string> {
  const ev = await one<{ evidenceId: string; objectPath: string }>(actor,
    'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
    [kind, target, `${kind}.pdf`, 'application/pdf', 2048, 'e'.repeat(64), rid()]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
  await one(actor, 'select public.supplier_money_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
  return ev.evidenceId;
}

type Setup = { versionId: string; hotelTask: string; transferTask: string; supplierId: string; proformaId: string; receiptId: string };

/** Package booking (hotel + transfer) on SYN-DEL-001, approved review, priced tasks, go-ahead, verified receipt. */
async function setup(): Promise<Setup> {
  await addMembership(U.visaJodhpur, 'accounts');
  await h.setSwitch('service_items_enabled', true);
  const opened = await h.openDraft(OWNER, DEAL);
  let rv = opened.rowVersion;
  rv = (await h.addItem(OWNER, opened.versionId, rv, 'hotel', HOTEL, '20000000')).rowVersion;
  rv = (await h.addItem(OWNER, opened.versionId, rv, 'transfer', TRANSFER, '8000000')).rowVersion;
  rv = (await h.saveTravellers(OWNER, DEAL, rv)).rowVersion;
  rv = (await h.saveSelling(OWNER, opened.versionId, rv, SELLING)).rowVersion;
  await h.completeB11(OWNER, DEAL, opened.versionId, rv, SELLING);
  await h.storeEvidence(OWNER, opened.versionId);
  const ready = await h.readiness(OWNER, opened.versionId);
  expect(ready.issues).toEqual([]);
  await h.confirm(OWNER, opened.versionId, ready.contentHash);
  const tasks = await owner<{ id: string; service_purpose: string }>(
    `select id, service_purpose from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [DEAL]);
  const hotelTask = tasks.find((t) => t.service_purpose === 'hotel')!.id;
  const transferTask = tasks.find((t) => t.service_purpose === 'transfer')!.id;
  // Approved review (the approval memory trigger runs on insert).
  await owner(
    `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
     select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1`,
    [opened.versionId, U.accountsJodhpur]);

  const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
  const { supplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [
    entity!.id, JSON.stringify({ name: `Synthetic Supplier ${rid().slice(0, 8)}`, serviceTypes: ['hotel', 'transfer'], city: 'Synthetic City',
      contactName: 'Synthetic Desk', contactPhone: '+91 00000 00000', contactEmail: 'desk@example.test', paymentTerms: 'Synthetic terms' })]);
  const rev = await one<{ revisionNo: number }>(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, rid(),
    JSON.stringify({ accountHolder: 'Synthetic Stays Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' })]);
  await one(MANAGER, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierId, rev.revisionNo]);
  for (const task of [hotelTask, transferTask]) {
    await one(PURCHASE, PURCHASE_CLAIM_SQL, [task]);
    const { quoteId } = await one<{ quoteId: string }>(PURCHASE, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task, rid(),
      JSON.stringify({ supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast',
        quotedCostPaise: '1000000', holdUntil: '2026-11-30', cancellationTerms: 'Synthetic terms' })]);
    await one(PURCHASE, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r',
      [task, quoteId, await latestCostNo(task), '1000000', '2026-11-25', null, rid()]);
  }
  await one(PURCHASE, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
    [hotelTask, await latestCostNo(hotelTask), 'desk@example.test', [], 'Booking request · SYN-DEL-001', 'Synthetic body.', rid()]);
  const [ga] = await owner<{ id: string; row_version: number }>(
    `select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`, [hotelTask]);
  await one(ACC, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [ga!.id, 'approve', null, ga!.row_version, rid()]);
  const proformaId = await storeMoneyFile(PURCHASE, hotelTask, 'proforma');

  // Verified bank receipt (PAN and mobile on file) on the Deal.
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
    mode: 'bank_transfer', amountPaise: '30000000', receivedOn: today(), branchId: del!.id, payerName: 'Synthetic Payer',
    payerPan: 'ABCDE1234F', payerMobile: '6000043210', reference: `UTR${rid().slice(0, 10).toUpperCase()}`, destinationVersionId: ver!.id,
  }), rid()]);
  const proof = await one<{ id: string; objectPath: string }>(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
    ['receipt', rec.id, 'bank_proof', 'proof.pdf', 'application/pdf', 2048, rid().replace(/-/g, '').padEnd(64, '0'), rid()]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`, [proof.objectPath]);
  await one(ACC, 'select public.finance_evidence_finish($1, true) as r', [proof.id]);
  await one(ACC2, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()]);
  return { versionId: opened.versionId, hotelTask, transferTask, supplierId, proformaId, receiptId: rec.id };
}

/** Pending -> approved (ACC) -> paid (ACC) -> verified (ACC2) supplier payment on the hotel task. */
async function verifiedPayment(s: Setup): Promise<{ id: string; ref_no: string }> {
  await one(PURCHASE, 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', [s.hotelTask, JSON.stringify({
    expectedCostVersionNo: await agreedCostNo(s.hotelTask), part: 'deposit', amountPaise: '500000', dueDate: '2026-11-20', note: null,
    proformaEvidenceId: s.proformaId }), rid()]);
  const pay = async () => (await owner<{ id: string; ref_no: string; row_version: number }>(
    'select id, ref_no, row_version from public.supplier_payment_requests where task_id = $1', [s.hotelTask]))[0]!;
  let p = await pay();
  await one(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r', [p.id, 'approve', null, p.row_version, rid()]);
  p = await pay();
  const proof = await storeMoneyFile(ACC, p.id, 'payment_proof');
  await one(ACC, 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r',
    [p.id, today(), 'bank_transfer', `UTRSUP${rid().slice(0, 8).toUpperCase()}`, proof, p.row_version, rid()]);
  p = await pay();
  await one(ACC2, 'select public.supplier_payment_verify($1, $2, $3) as r', [p.id, p.row_version, rid()]);
  return p;
}

const UPLOAD = 'select public.supplier_document_upload($1, $2::jsonb, $3) as r';
const docFields = (kind: string, number: string, evidenceId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind, number, docDate: '2026-11-01', totalPaise: '1000000', gstIncluded: true, evidenceId, ...extra });
const RECORDS = 'select public.accounts_records($1::jsonb, $2, $3) as r';

describe('accounts phase track B smoke', () => {
  it('supplier document duplicates, links and credit link', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const inv = await storeMoneyFile(PURCHASE, s.hotelTask, 'invoice');
      const created = await one<{ id: string }>(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'SYN/INV-001', inv), rid()]);
      const inv2 = await storeMoneyFile(PURCHASE, s.hotelTask, 'invoice');
      // Same supplier, kind, normalised number and financial year: refused (case, spaces, slashes, dashes).
      await refused(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'syn inv 001', inv2), rid()], 'duplicate_supplier_document', '23505');
      // The refusal names the existing bill for a caller who may read it (addendum B2).
      await db.exec('savepoint dup');
      const dupDetail = await run(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'SYN INV 001', inv2), rid()])
        .then(() => null, (e: { detail?: string }) => e.detail ?? null);
      await db.exec('rollback to savepoint dup');
      expect(dupDetail).toBe(`existingDocumentId=${created.id}`);
      await refused(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', '--//', inv2), rid()], 'invalid_input', '22023');
      // Other financial year allowed.
      await one(PURCHASE, UPLOAD, [s.hotelTask, JSON.stringify({ kind: 'invoice', number: 'SYN-INV-001', docDate: '2026-03-31',
        totalPaise: '1000000', gstIncluded: true, evidenceId: inv2 }), rid()]);
      // Credit note with the same number and a credit link to the invoice.
      const cn = await storeMoneyFile(PURCHASE, s.hotelTask, 'credit_note');
      await one(PURCHASE, UPLOAD, [s.hotelTask, docFields('credit_note', 'SYN-INV-001', cn, { creditsDocumentId: created.id }), rid()]);
      const [credit] = await owner<{ credits_document_id: string }>(
        `select credits_document_id from public.supplier_documents where kind = 'credit_note' and task_id = $1`, [s.hotelTask]);
      expect(credit!.credits_document_id).toBe(created.id);
      // A credit link on an invoice upload is refused.
      const inv3 = await storeMoneyFile(PURCHASE, s.hotelTask, 'invoice');
      await refused(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'SYN-INV-777', inv3, { creditsDocumentId: created.id }), rid()],
        'invalid_input', '22023');

      // Link the bill to the transfer task (same supplier agreed): by Accounts.
      const LINK = 'select public.supplier_document_link_task($1, $2, $3) as r';
      const targets = await one<{ items: Row[]; links: Row[] }>(ACC, 'select public.supplier_document_link_targets($1) as r', [created.id]);
      expect(targets.items.map((t) => t.taskId)).toEqual([s.transferTask]);
      expect(await one(OWNER, 'select public.supplier_document_link_targets($1) as r', [created.id])).toBeNull();
      await refused(OWNER, LINK, [created.id, s.transferTask, rid()], 'not_authorized', '42501');
      await refused(ACC, LINK, [created.id, s.hotelTask, rid()], 'link_not_allowed', '55000');
      const req = rid();
      const link = await one<{ outcome: string; linkId: string }>(ACC, LINK, [created.id, s.transferTask, req]);
      expect(link.outcome).toBe('created');
      expect((await one<{ outcome: string }>(ACC, LINK, [created.id, s.transferTask, req])).outcome).toBe('existing');
      expect((await one<{ outcome: string }>(ACC, LINK, [created.id, s.transferTask, rid()])).outcome).toBe('existing');
      expect((await owner<{ v: boolean }>('select authz.sm_task_has_invoice($1) as v', [s.transferTask]))[0]!.v).toBe(true);
      // Unlink by Accounts with a reason.
      await refused(ACC, 'select public.supplier_document_unlink_task($1, $2, $3) as r', [link.linkId, 'short', rid()], 'invalid_input', '22023');
      await one(ACC, 'select public.supplier_document_unlink_task($1, $2, $3) as r', [link.linkId, 'Synthetic: linked by mistake', rid()]);
      expect((await owner<{ v: boolean }>('select authz.sm_task_has_invoice($1) as v', [s.transferTask]))[0]!.v).toBe(false);
      // Set-once credit link (S3).
      const cn2 = await storeMoneyFile(PURCHASE, s.hotelTask, 'credit_note');
      const c2 = await one<{ id: string }>(PURCHASE, UPLOAD, [s.hotelTask, docFields('credit_note', 'SYN-CN-9', cn2), rid()]);
      const CREDIT = 'select public.supplier_document_set_credit_link($1, $2, $3) as r';
      await refused(PURCHASE, CREDIT, [c2.id, created.id, rid()], 'not_authorized', '42501');
      await one(ACC, CREDIT, [c2.id, created.id, rid()]);
      await refused(ACC, CREDIT, [c2.id, created.id, rid()], 'already_recorded', '55000');
      // The Accounts list carries the additive keys.
      const list = await one<{ documents: Row[] }>(ACC, `select public.accounts_supplier_documents('all') as r`);
      expect(list.documents[0]).toHaveProperty('linkedTaskCount');
      expect(list.documents[0]).toHaveProperty('creditsDocumentNumber');
      // Review still works (the guard ignores the generated columns).
      const [doc] = await owner<{ id: string; row_version: number }>('select id, row_version from public.supplier_documents where id = $1', [created.id]);
      await one(ACC, 'select public.supplier_document_review($1, $2, $3, $4, $5) as r', [doc!.id, 'accept', null, doc!.row_version, rid()]);
      const audits = await owner<{ action: string }>(
        `select action from public.audit_events where action in ('supplier.document_linked', 'supplier.document_unlinked', 'supplier.credit_note_linked') order by id`);
      expect(audits.map((a) => a.action)).toEqual(['supplier.document_linked', 'supplier.document_unlinked', 'supplier.credit_note_linked']);
    });
  });

  it('workspace rows, search, paging, totals and fences', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const pay = await verifiedPayment(s);
      const inv = await storeMoneyFile(PURCHASE, s.hotelTask, 'invoice');
      await one(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'SYN-WS-42', inv), rid()]);

      const page = await one<Page>(ACC, RECORDS, ['{}', null, 50]);
      expect(page!.scope).toEqual({ mode: 'accounts', readOnly: false });
      const kinds = new Set(page!.items.map((i) => i.kind));
      for (const k of ['receipt', 'supplier_payment', 'supplier_invoice']) expect(kinds.has(k)).toBe(true);
      const receipt = page!.items.find((i) => i.kind === 'receipt')!;
      expect(Object.keys(receipt).sort()).toEqual(['amountPaise', 'bitrixDealId', 'branchName', 'can', 'collectingBranchName', 'createdAt',
        'dealId', 'dealReference', 'department', 'direction', 'files', 'kind', 'link', 'original', 'otherReferences', 'recordDate',
        'recordId', 'reference', 'reviewStatus', 'rowId', 'serviceLabel', 'stage', 'statusCode', 'supplierId', 'supplierName', 'tally', 'taskId']);
      expect(receipt.tally).toMatchObject({ status: 'ready', recordKind: 'journal_entry', rowVersion: 0 });
      expect(JSON.stringify(page)).not.toMatch(/ABCDE1234F|6000043210|Synthetic Payer/);
      const sp = page!.items.find((i) => i.kind === 'supplier_payment')!;
      expect(sp).toMatchObject({ reference: pay.ref_no, stage: 'done', reviewStatus: 'done', direction: 'out' });
      expect(sp.can).toEqual({ match: true, exception: true, reopen: false, linkTask: false });

      // Keyset paging: no duplicates, same rows.
      const all = page!.items.map((i) => i.rowId);
      const seen: string[] = [];
      let after: string | null = null;
      for (let n = 0; n < 30; n += 1) {
        const p: Page = await one<Page>(ACC, RECORDS, ['{}', after, 2]);
        seen.push(...p!.items.map((i) => i.rowId as string));
        if (!p!.hasMore) break;
        after = p!.nextAfter;
      }
      expect(seen).toEqual(all);

      // Exact search.
      const [receiptNo] = await owner<{ n: string }>('select receipt_no as n from public.customer_receipts where id = $1', [s.receiptId]);
      const byR = await one<Page>(ACC, RECORDS, [JSON.stringify({ q: receiptNo!.n }), null, 50]);
      expect(byR!.items.map((i) => i.kind)).toEqual(['receipt']);
      const bySp = await one<Page>(ACC, RECORDS, [JSON.stringify({ q: pay.ref_no.toLowerCase() }), null, 50]);
      expect(bySp!.items.map((i) => i.kind).sort()).toEqual(['supplier_payment']);
      const byDoc = await one<Page>(ACC, RECORDS, [JSON.stringify({ q: 'syn ws/42' }), null, 50]);
      expect(byDoc!.items.map((i) => i.kind)).toEqual(['supplier_invoice']);
      const byDeal = await one<Page>(ACC, RECORDS, [JSON.stringify({ q: 'SYN-DEL-001' }), null, 50]);
      expect(byDeal!.items.length).toBeGreaterThanOrEqual(3);

      // Filters and totals.
      const filtered = await one<Page>(ACC, RECORDS, [JSON.stringify({ kinds: ['supplier_payment'], tallyStatus: 'ready' }), null, 50]);
      expect(filtered!.items).toHaveLength(1);
      await refused(ACC, RECORDS, [JSON.stringify({ colour: 'red' }), null, 50], 'invalid_input', '22023');
      await refused(ACC, RECORDS, ['{}', 'garbage', 50], 'invalid_input', '22023');
      const totals = await one<{ count: number; byKind: Array<{ kind: string; inPaise: string }> }>(ACC,
        'select public.accounts_records_totals($1::jsonb) as r', ['{}']);
      expect(totals.count).toBe(all.length);
      expect(totals.byKind.find((k) => k.kind === 'receipt')!.inPaise).toBe('30000000');

      // Fences: Manager of the Deal's branch read-only; Purchase, Sales, other Manager.
      const m = await one<Page>(MANAGER, RECORDS, ['{}', null, 50]);
      expect(m!.scope).toEqual({ mode: 'manager', readOnly: true });
      expect(m!.items.length).toBe(all.length);
      expect(m!.items.every((i) => !i.can.match && !i.can.exception && !i.can.reopen && !i.can.linkTask)).toBe(true);
      expect(m!.items.every((i) => i.files.links.length === 0)).toBe(true);
      // Links the viewer can open: Manager -> Deal dues card (or none), Accounts -> Accounts screens.
      expect(m!.items.every((i) => ['deal_dues', 'none'].includes(i.link.kind))).toBe(true);
      expect(page!.items.every((i) => !['flight_deal', 'visa_task', 'purchase_task', 'deal_dues'].includes(i.link.kind))).toBe(true);
      expect(receipt.link).toMatchObject({ kind: 'accounts_deal', id: DEAL, dealId: DEAL, ref: receipt.reference });
      // Daily check selections: the verified receipt is not "waiting over a working day".
      expect((await one<Page>(ACC, RECORDS, [JSON.stringify({ overdueCheck: 'receipts_unverified' }), null, 50]))!.items).toEqual([]);
      await refused(ACC, RECORDS, [JSON.stringify({ overdueCheck: 'everything' }), null, 50], 'invalid_input', '22023');
      expect((await one<Page>(MANAGER_AMD, RECORDS, ['{}', null, 50]))!.items).toEqual([]);
      for (const actor of [PURCHASE, OWNER]) expect(await one(actor, RECORDS, ['{}', null, 50])).toBeNull();
      await addMembership(U.managerDelhi, 'flight', 'DEL');
      expect(await one(MANAGER, RECORDS, ['{}', null, 50])).toBeNull();
      await addMembership(U.accountsJodhpur, 'purchase');
      expect(await one(ACC, RECORDS, ['{}', null, 50])).toBeNull();
    });
  });

  it('Tally match, exception, reopen, GST invoice references and the CSV export', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const pay = await verifiedPayment(s);
      const MATCH = 'select public.accounts_tally_match($1, $2, $3, $4::jsonb, $5) as r';
      const EXC = 'select public.accounts_tally_exception($1, $2, $3, $4::jsonb, $5) as r';
      const REOPEN = 'select public.accounts_tally_reopen($1, $2, $3, $4, $5) as r';
      const voucher = JSON.stringify({ voucherRef: 'PMT/2026/17', voucherDate: today() });
      await refused(MANAGER, MATCH, ['supplier_payment', pay.id, 0, voucher, rid()], 'not_authorized', '42501');
      await refused(ACC, MATCH, ['supplier_payment', pay.id, 3, voucher, rid()], 'version_changed', CONFLICT_STATE);
      const m1 = await one<{ rowVersion: number; status: string }>(ACC, MATCH, ['supplier_payment', pay.id, 0, voucher, rid()]);
      expect(m1).toMatchObject({ status: 'matched', rowVersion: 1 });
      await refused(ACC2, MATCH, ['supplier_payment', pay.id, 1, voucher, rid()], 'already_matched', '55000');
      // Matched but never exported: reopen goes back to ready, voucher cleared (Addendum L1); match again.
      expect(await one<{ status: string }>(ACC, REOPEN, ['supplier_payment', pay.id, 1, 'Synthetic: matched by mistake', rid()]))
        .toMatchObject({ status: 'ready', rowVersion: 2 });
      await refused(ACC, REOPEN, ['supplier_payment', pay.id, 2, 'Synthetic: reopen twice', rid()], 'wrong_state', '55000');
      await one(ACC, MATCH, ['supplier_payment', pay.id, 2, voucher, rid()]);
      // Voucher history in the audit (Addendum B7): exception and reopen keep the previous voucher.
      await one(ACC, EXC, ['supplier_payment', pay.id, 3, JSON.stringify({ reason: 'Synthetic: posted to the wrong ledger' }), rid()]);
      await one(ACC, REOPEN, ['supplier_payment', pay.id, 4, 'Synthetic: back to matched', rid()]);
      const history = await owner<{ action: string; details: Row }>(`select action, details from public.audit_events
        where action in ('accounts.tally_matched', 'accounts.tally_exception_raised', 'accounts.tally_reopened') and target_id = $1 order by id`, [pay.id]);
      expect(history.map((a) => [a.action, a.details.voucherRef ?? a.details.previousVoucherRef])).toEqual([
        ['accounts.tally_matched', 'PMT/2026/17'], ['accounts.tally_reopened', 'PMT/2026/17'], ['accounts.tally_matched', 'PMT/2026/17'],
        ['accounts.tally_exception_raised', 'PMT/2026/17'], ['accounts.tally_reopened', 'PMT/2026/17']]);
      // Exception on the receipt's journal entry; reopen refused (never exported).
      const [entry] = await owner<{ id: string }>(`select id from public.finance_journal_entries where receipt_id = $1`, [s.receiptId]);
      await one(ACC, EXC, ['journal_entry', entry!.id, 0, JSON.stringify({ reason: 'Synthetic: amount differs in Tally', tallyAmountPaise: '29999900' }), rid()]);
      await refused(ACC, MATCH, ['journal_entry', entry!.id, 1, voucher, rid()], 'tally_exception_open', '55000');
      // Exception from ready, never exported: reopen goes back to ready; raise it again for the rest of the test.
      expect(await one<{ status: string }>(ACC, REOPEN, ['journal_entry', entry!.id, 1, 'Synthetic: try to reopen', rid()]))
        .toMatchObject({ status: 'ready' });
      await one(ACC, EXC, ['journal_entry', entry!.id, 2, JSON.stringify({ reason: 'Synthetic: amount differs in Tally again' }), rid()]);

      // GST invoice reference.
      const ADD = 'select public.accounts_tally_invoice_add($1, $2::jsonb, $3) as r';
      const g = await one<{ id: string; rowVersion: number }>(ACC, ADD, [DEAL, JSON.stringify({ invoiceRef: 'HC/2026-27/0042', invoiceDate: today() }), rid()]);
      await refused(ACC2, ADD, [D.del002, JSON.stringify({ invoiceRef: 'hc 2026 27 0042', invoiceDate: today() }), rid()], 'duplicate_tally_invoice', '23505');
      await refused(MANAGER, ADD, [DEAL, JSON.stringify({ invoiceRef: 'HC/9', invoiceDate: today() }), rid()], 'not_authorized', '42501');

      // Export: off by default; the policy manager switches it on.
      const CREATE = 'select public.accounts_tally_export_create($1::jsonb, $2) as r';
      const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
      const fields = JSON.stringify({ entityId: entity!.id, from: '2026-01-01', to: today(),
        kinds: ['journal_entry', 'supplier_payment', 'tally_gst_invoice'], includeExported: false });
      await refused(ACC, CREATE, [fields, rid()], 'tally_export_off', '55000');
      await refused(ACC, 'select public.admin_set_tally_export_enabled($1, $2, $3) as r', [entity!.id, true, 'Synthetic: switch on for test'], 'not_authorized', '42501');
      await one(SUPER, 'select public.admin_set_tally_export_enabled($1, $2, $3) as r', [entity!.id, true, 'Synthetic: switch on for test']);
      // Matched (payment), exception (receipt entry) and GST rows are never exported.
      await refused(ACC, CREATE, [fields, rid()], 'nothing_to_export', '55000');
      const inv = await storeMoneyFile(PURCHASE, s.hotelTask, 'invoice');
      const doc = await one<{ id: string }>(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'SYN-EXP-1', inv), rid()]);
      await one(ACC, 'select public.supplier_document_review($1, $2, $3, $4, $5) as r', [doc.id, 'accept', null, 1, rid()]);
      const f2 = JSON.stringify({ entityId: entity!.id, from: '2026-01-01', to: today(), kinds: ['supplier_document', 'supplier_payment'], includeExported: false });
      // Same-name temporary tables made earlier in the session (other shape, a row) are never used (20261203000350).
      await owner('create temporary table tally_export_work (junk text)');
      await owner(`insert into tally_export_work values ('x')`);
      await owner('create temporary table tally_export_src (junk integer)');
      const req = rid();
      const ex = await one<{ exportId: string; exportNo: string; rowCount: number; outcome: string }>(ACC, CREATE, [f2, req]);
      expect(ex).toMatchObject({ outcome: 'created', rowCount: 1 });
      expect(ex.exportNo).toMatch(/^TE-\d{4}-000001$/);
      expect((await one<{ outcome: string }>(ACC, CREATE, [f2, req])).outcome).toBe('existing');
      await refused(ACC, CREATE, [f2, rid()], 'nothing_to_export', '55000');
      const again = await one<{ rowCount: number; alreadyExportedCount: number }>(ACC, CREATE,
        [JSON.stringify({ ...JSON.parse(f2), includeExported: true }), rid()]);
      expect(again).toMatchObject({ rowCount: 1, alreadyExportedCount: 1 });
      const [tr] = await owner<{ status: string; export_count: number }>(
        `select status, export_count from public.tally_records where record_kind = 'supplier_document' and record_id = $1`, [doc.id]);
      expect(tr).toEqual({ status: 'exported', export_count: 2 });
      // Lines (snapshots) and one audit per download.
      const header = await one<{ fileName: string; rowCount: number }>(ACC, 'select public.accounts_tally_export_download_log($1) as r', [ex.exportId]);
      expect(header.fileName).toBe(`tripnavigate-${ex.exportNo}.csv`);
      const lines = await one<{ lines: Array<{ lineNo: number; values: Record<string, string | null> }>; nextAfter: number | null }>(ACC,
        'select public.accounts_tally_export_lines($1, $2, $3) as r', [ex.exportId, 0, 1000]);
      expect(lines.lines).toHaveLength(1);
      expect(lines.lines[0]!.values).toMatchObject({ recordType: 'Supplier invoice', reference: 'SYN-EXP-1', amount: '10000.00', exportNo: ex.exportNo });
      expect(await one(MANAGER, 'select public.accounts_tally_export_lines($1, $2, $3) as r', [ex.exportId, 0, 1000])).toBeNull();
      const audits = await owner<{ action: string; n: number }>(
        `select action, count(*)::int as n from public.audit_events where action like 'accounts.tally_export%' group by action order by action`);
      expect(audits).toEqual([{ action: 'accounts.tally_export_created', n: 2 }, { action: 'accounts.tally_export_downloaded', n: 1 }]);
      // Matched after export -> reopen to exported.
      const [trow] = await owner<{ row_version: number }>(
        `select row_version from public.tally_records where record_kind = 'supplier_document' and record_id = $1`, [doc.id]);
      await one(ACC, MATCH, ['supplier_document', doc.id, trow!.row_version, voucher, rid()]);
      const re = await one<{ status: string }>(ACC, REOPEN, ['supplier_document', doc.id, trow!.row_version + 1, 'Synthetic: wrong voucher', rid()]);
      expect(re.status).toBe('exported');
      // Masked PAN/mobile and ledgers of a receipt line.
      const [mask] = await owner<{ v: Record<string, string> }>(
        `select authz.tally_line_values(authz.tally_source_json('journal_entry', $1), 'TE-2026-000099', 1, null, false) as v`, [entry!.id]);
      expect(mask!.v).toMatchObject({ pan: 'XXXXX1234X', mobile: 'XXXXXX3210', recordType: 'Receipt', debitLedger: 'Bank', creditLedger: 'Customer advances' });

      // Withdraw the GST reference.
      await one(ACC, 'select public.accounts_tally_invoice_withdraw($1, $2, $3, $4) as r', [g.id, 1, 'Synthetic: typed on the wrong Deal', rid()]);

      // Exception owner (H4): configurable, validated.
      const OWNER_SQL = 'select public.admin_set_accounts_exception_owner($1, $2, $3) as r';
      await refused(SUPER, OWNER_SQL, [entity!.id, U.purchaseJodhpur, 'Synthetic: name the owner'], 'invalid_input', '22023');
      await one(SUPER, OWNER_SQL, [entity!.id, U.visaJodhpur, 'Synthetic: name the owner']);
      const check = await one<{ exceptionOwner: { set: boolean; userId: string }; exceptionsOpen: { count: number } }>(ACC, 'select public.accounts_daily_check() as r');
      expect(check.exceptionOwner).toMatchObject({ set: true, userId: U.visaJodhpur });
      expect(check.exceptionsOpen.count).toBe(1);
      expect((check as unknown as Row).filters).toMatchObject({ receiptsAwaitingVerificationOverOneWorkingDay: { overdueCheck: 'receipts_unverified' } });
      expect(await one(MANAGER, 'select public.accounts_daily_check() as r')).toBeNull();
      const settingsAudit = await owner<{ details: { columns: string[] } }>(
        `select details from public.audit_events where action = 'settings.accounts_changed' order by id`);
      // Accounts phase 2 (B, 6.2): the audit function lists all four switch columns on the row's first write.
      // Accounts phase 3 (contract 6.1, 16.6 setup update by Track T): it also lists Track B's six new columns, whose order is not frozen.
      const PHASE3_COLUMNS = ['auto_bills_enabled', 'auto_bills_since', 'auto_bill_release_enabled', 'write_off_enabled', 'write_off_limit_paise', 'tally_xml_enabled',
        'tally_company_name'];
      const audited = settingsAudit.map((a) => a.details.columns);
      expect(audited).toHaveLength(2);
      expect(audited[0]!.slice(0, 4)).toEqual(['exception_owner_user_id', 'tally_export_enabled', 'customer_documents_enabled', 'refunds_enabled']);
      expect([...audited[0]!.slice(4)].sort()).toEqual([...PHASE3_COLUMNS].sort());
      expect(audited[1]).toEqual(['exception_owner_user_id']);
    });
  });

  it('dues: approved basis, oldest-first allocation, fences, payables without a difference', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      await verifiedPayment(s);
      const DUES = 'select public.deal_dues($1) as r';
      const dues = await one<Row>(ACC, DUES, [DEAL]);
      expect(dues).toMatchObject({
        totalPaise: SELLING, verifiedPaise: '30000000', balancePaise: String(Number(SELLING) - 30000000), status: 'overdue',
        basis: { versionNo: 1, kind: 'approved', newerVersionPending: false, provisional: false },
      });
      expect(dues.instalments).toEqual([{ seq: 1, label: 'Full payment', dueDate: '2026-11-01', amountPaise: SELLING,
        coveredPaise: '30000000', openPaise: String(Number(SELLING) - 30000000), status: 'overdue', partlyPaid: true }]);
      expect(dues.supplierPayables[0]).not.toHaveProperty('differencePaise');
      expect(dues.supplierPayables[0]).toMatchObject({ paidPaise: '500000', verifiedPaise: '500000' });
      const ownerView = await one<Row>(OWNER, DUES, [DEAL]);
      expect(ownerView.supplierPayables).toBeNull();
      expect(ownerView.verifiedPaise).toBe('30000000');
      expect(await one(PURCHASE, DUES, [DEAL])).toBeNull();
      const m = await one<Row>(MANAGER, DUES, [DEAL]);
      expect(m.supplierPayables).not.toBeNull();
      expect(dues.viewer).toBe('accounts');
      expect(m.viewer).toBe('manager');
      expect(ownerView.viewer).toBe('sales');
      const opts = await one<{ branches: Row[]; suppliers: Row[]; owners: Row[] }>(MANAGER, 'select public.accounts_filter_options() as r');
      expect(opts.branches.map((b) => b.name)).toHaveLength(1);
      expect(opts.suppliers.map((x) => x.supplierId)).toContain(s.supplierId);
      expect((await one<{ branches: Row[] }>(ACC, 'select public.accounts_filter_options() as r')).branches.length).toBeGreaterThan(1);
      expect(await one(OWNER, 'select public.accounts_filter_options() as r')).toBeNull();
      const LIST = 'select public.accounts_dues($1::jsonb, $2, $3) as r';
      const list = await one<{ items: Row[] }>(ACC, LIST, ['{}', null, 50]);
      expect(list.items.map((i) => i.dealReference)).toEqual(['SYN-DEL-001']);
      expect((await one<{ items: Row[] }>(ACC, LIST, [JSON.stringify({ status: ['paid'] }), null, 50])).items).toEqual([]);
      expect((await one<{ items: unknown[] }>(OWNER, LIST, ['{}', null, 50])).items).toHaveLength(1);
      expect(await one(PURCHASE, LIST, ['{}', null, 50])).toBeNull();
      await refused(ACC, LIST, [JSON.stringify({ colour: 'red' }), null, 50], 'invalid_input', '22023');
      // Review returned after approval: the approved version stays the basis.
      await owner(`update public.accounts_booking_reviews set status = 'returned', return_reason = 'Synthetic: returned for a test',
        row_version = row_version + 1 where booking_version_id = $1`, [s.versionId]);
      expect((await one<Row>(ACC, DUES, [DEAL])).basis).toMatchObject({ kind: 'approved' });
      // The dues functions never read sm_customer_money_available.
      const bodies = await owner<{ src: string }>(
        `select prosrc as src from pg_proc where proname in ('accounts_dues', 'deal_dues', 'dues_compute', 'dues_supplier_payables')`);
      expect(bodies).toHaveLength(4);
      expect(bodies.every((b) => !b.src.includes('sm_customer_money_available'))).toBe(true);
    });
  });

  it('extra reads: exports list, admin settings, payables, originals, reversal rows', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
      const exportsView = await one<{ entities: Row[]; items: unknown[] }>(ACC, 'select public.accounts_tally_exports($1) as r', [50]);
      expect(exportsView.entities[0]).toMatchObject({ entityId: entity!.id, exportEnabled: false });
      expect(await one(MANAGER, 'select public.accounts_tally_exports($1) as r', [50])).toBeNull();
      const settings = await one<Row>(SUPER, 'select public.admin_accounts_settings($1) as r', [entity!.id]);
      expect(settings).toMatchObject({ exceptionOwnerUserId: null, tallyExportEnabled: false, rowVersion: 0 });
      expect(settings.candidates.map((c: Row) => c.userId)).toContain(U.accountsJodhpur);
      expect(await one(ACC, 'select public.admin_accounts_settings($1) as r', [entity!.id])).toBeNull();
      expect(await one<Row>(MANAGER, 'select public.accounts_supplier_payables($1) as r', [DEAL])).toMatchObject({ dealReference: 'SYN-DEL-001' });
      expect(await one(OWNER, 'select public.accounts_supplier_payables($1) as r', [DEAL])).toBeNull();
      // A recorded bank receipt without its proof is a missing original (bank proof).
      const [ver] = await owner<{ id: string }>(`select id from public.company_destination_versions where status = 'approved' order by created_at desc limit 1`);
      const [del] = await owner<{ id: string }>(`select b.id from public.branches b where b.code = 'DEL'`);
      await one(ACC, 'select public.receipt_record($1, $2::jsonb, $3) as r', [DEAL, JSON.stringify({
        mode: 'bank_transfer', amountPaise: '100000', receivedOn: today(), branchId: del!.id, payerName: 'Synthetic Payer',
        payerPan: 'ABCDE1234F', reference: `UTR${rid().slice(0, 10).toUpperCase()}`, destinationVersionId: ver!.id }), rid()]);
      // A receipt collected in Ahmedabad for the Delhi Deal: the Ahmedabad Manager sees it (AL8) without a dues link.
      const [amd] = await owner<{ id: string }>(`select b.id from public.branches b where b.code = 'AMD'`);
      const amdRec = await one<{ id: string }>(ACC, 'select public.receipt_record($1, $2::jsonb, $3) as r', [DEAL, JSON.stringify({
        mode: 'bank_transfer', amountPaise: '100000', receivedOn: today(), branchId: amd!.id, payerName: 'Synthetic Payer',
        payerPan: 'ABCDE1234F', reference: `UTR${rid().slice(0, 10).toUpperCase()}`, destinationVersionId: ver!.id }), rid()]);
      const amdRow = (await one<Page>(MANAGER_AMD, RECORDS, ['{}', null, 50]))!.items.find((i) => i.recordId === amdRec.id)!;
      expect(amdRow.link).toMatchObject({ kind: 'none' });
      const delRow = (await one<Page>(MANAGER, RECORDS, ['{}', null, 50]))!.items.find((i) => i.recordId === amdRec.id)!;
      expect(delRow.link).toMatchObject({ kind: 'deal_dues', id: DEAL });
      const originals = await one<Page>(ACC, RECORDS, [JSON.stringify({ originals: 'missing' }), null, 50]);
      expect(originals!.items.map((i) => i.original?.what)).toContain('bank_proof');
      // The GST reference of the approved Deal is expected (trip not ended).
      const expected = await one<Page>(ACC, RECORDS, [JSON.stringify({ originals: 'expected' }), null, 50]);
      expect(expected!.items.map((i) => i.original?.what)).toContain('gst_invoice_ref');
      // Reversal: its own row with its own Tally status; the receipt row stays.
      await one(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [s.receiptId, 'bank_return', 'Synthetic reversal reason', rid()]);
      const rev = await one<Page>(ACC, RECORDS, [JSON.stringify({ kinds: ['receipt_reversal', 'receipt'] }), null, 50]);
      expect(rev!.items.filter((i) => i.kind === 'receipt_reversal')).toHaveLength(1);
      expect(rev!.items.find((i) => i.kind === 'receipt_reversal')!.tally).toMatchObject({ status: 'ready', recordKind: 'journal_entry' });
      const dues = await one<Row>(ACC, 'select public.deal_dues($1) as r', [DEAL]);
      expect(dues.verifiedPaise).toBe('0');
    });
  });
});

// ---------------------------------------------------------------------------
// "Changed since export" touches (20261203000320): every hashed source column
// is covered by a touch trigger, and a direct change flags the record.
// ---------------------------------------------------------------------------

/** alias in authz.tally_source_set -> tables it may stand for. */
const SOURCE_ALIASES: Record<string, string[]> = {
  e: ['finance_journal_entries'], l: ['finance_journal_lines', 'supplier_document_tasks'], r: ['customer_receipts'],
  dep: ['cash_deposits'], d: ['deals'], b: ['branches'], p: ['supplier_payment_requests'], s: ['suppliers'],
  x: ['supplier_documents'], c: ['supplier_documents', 'department_cost_entries'], t: ['fulfilment_tasks'], g: ['deal_tally_invoices'],
  // Accounts phase 2 (Track D, 8.2): customer documents (and the credited one), supplier refunds, refund payouts and requests.
  cd: ['customer_documents'], cc: ['customer_documents'], sr: ['supplier_refund_receipts'], po: ['customer_refund_payouts'], rf: ['customer_refund_requests'],
  // Accounts phase 3 (contract 7.2, Track C write_off kind; 16.6 setup update by Track T).
  w: ['deal_write_offs'],
};
/** Read but not hashed: ids, and display names replaced by ids in authz.tally_hash. */
const NOT_HASHED = new Set(['b.name', 's.name', 'd.reference']);
/**
 * Accounts phase 3 (contract 6.6 / 7.2; 16.6 setup update by Track T): a write-off's facts are immutable (its guard
 * refuses any change; proved in acc3-b-write-off.test.ts), so only its status needs the touch trigger 7.2 names.
 */
const IMMUTABLE = new Set(['w.direction', 'w.ref_no', 'w.amount_paise', 'w.deal_id', 'w.branch_id']);

describe('changed since export: complete source touches', () => {
  it('every alias.column the hash reads is covered by a touch trigger (guard for future columns)', async () => {
    await asOwner(db, async () => {
      const [fnSrc] = await owner<{ src: string }>(`select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'authz' and p.proname = 'tally_source_set'`);
      const tokens = [...new Set([...fnSrc!.src.matchAll(/\b([a-z]{1,3})\.([a-z_]+)\b/g)].map((m) => `${m[1]}.${m[2]}`))]
        .filter((t) => !t.startsWith('public.') && !t.startsWith('authz.'));
      const triggers = await owner<{ tbl: string; def: string }>(`select c.relname as tbl, pg_get_triggerdef(t.oid) as def
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc f on f.oid = t.tgfoid
        where not t.tgisinternal and f.proname in ('tally_touch_source', 'tally_touch_deal', 'tally_touch_document')`);
      const columns = await owner<{ tbl: string; col: string }>(`select table_name as tbl, column_name as col from information_schema.columns
        where table_schema = 'public'`);
      const has = (tbl: string, col: string) => columns.some((c) => c.tbl === tbl && c.col === col);
      const covered = (tbl: string, col: string) => triggers.some((t) => t.tbl === tbl && /UPDATE/.test(t.def)
        && (!/ WHEN /.test(t.def) || t.def.includes(`old.${col} IS DISTINCT FROM new.${col}`)));
      const missing: string[] = [];
      for (const token of tokens) {
        const [alias, col] = token.split('.') as [string, string];
        if (col === 'id' || NOT_HASHED.has(token) || IMMUTABLE.has(token)) continue;
        const tables = SOURCE_ALIASES[alias];
        if (!tables) { missing.push(`${token}: unknown alias (add it to SOURCE_ALIASES and a touch trigger)`); continue; }
        const owners = tables.filter((t) => has(t, col));
        if (owners.length === 0) { missing.push(`${token}: no such column`); continue; }
        if (!owners.some((t) => covered(t, col))) missing.push(`${token}: no touch trigger`);
      }
      expect(missing).toEqual([]);
    });
  });

  it('a direct change to each hashed column of an exported record flags it; nothing else does', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const pay = await verifiedPayment(s);
      const inv = await storeMoneyFile(PURCHASE, s.hotelTask, 'invoice');
      const doc = await one<{ id: string }>(PURCHASE, UPLOAD, [s.hotelTask, docFields('invoice', 'SYN-TOUCH-1', inv), rid()]);
      const cnEv = await storeMoneyFile(PURCHASE, s.hotelTask, 'credit_note');
      const cn = await one<{ id: string }>(PURCHASE, UPLOAD, [s.hotelTask, docFields('credit_note', 'SYN-TOUCH-CN', cnEv, { creditsDocumentId: doc.id }), rid()]);
      for (const id of [doc.id, cn.id]) {
        await one(ACC, 'select public.supplier_document_review($1, $2, $3, $4, $5) as r', [id, 'accept', null, 1, rid()]);
      }
      // A company-paid expense, accepted (paid_on empty so created_at gives its date).
      const [exp] = await owner<{ id: string }>(`insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department,
          cost_kind, amount_paise, paid_by, payment_mode, reference, expense_status, submitted_by, submitted_at, reviewed_by, reviewed_at, request_id, created_by)
        select t.id, t.deal_id, t.legal_entity_id, t.branch_id, 'purchase', 'other', 120000, 'company', 'card', 'SYN-CARD-1', 'accepted',
          $2, now(), $3, now(), gen_random_uuid(), $2
        from public.fulfilment_tasks t where t.id = $1 returning id`, [s.hotelTask, U.purchaseJodhpur, U.accountsJodhpur]);
      const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
      await one(SUPER, 'select public.admin_set_tally_export_enabled($1, $2, $3) as r', [entity!.id, true, 'Synthetic: switch on for test']);
      const ex = await one<{ rowCount: number }>(ACC, 'select public.accounts_tally_export_create($1::jsonb, $2) as r', [JSON.stringify({
        entityId: entity!.id, from: '2026-01-01', to: today(), kinds: ['journal_entry', 'supplier_payment', 'supplier_document', 'expense'],
        includeExported: false }), rid()]);
      expect(ex.rowCount).toBe(5);
      const [entry] = await owner<{ id: string }>(`select id from public.finance_journal_entries where receipt_id = $1`, [s.receiptId]);
      const [jdh] = await owner<{ id: string }>(`select id from public.branches where code = 'JDH'`);
      const { supplierId: otherSupplier } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [
        entity!.id, JSON.stringify({ name: `Synthetic Other ${rid().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Synthetic City',
          contactName: 'Synthetic Desk', contactPhone: '+91 00000 00000', contactEmail: 'other@example.test', paymentTerms: 'Synthetic terms' })]);

      const changed = async () => new Set((await one<Page>(ACC, RECORDS, [JSON.stringify({ changedSinceExport: true }), null, 100]))!
        .items.map((i) => i.tally.recordId as string));
      expect(await changed()).toEqual(new Set());

      type Case = [string, string, string, string, unknown[]];
      const cases: Case[] = [
        ['finance_journal_entries.business_date', 'finance_journal_entries_append_only', entry!.id, 'update public.finance_journal_entries set business_date = business_date - 1 where id = $1', [entry!.id]],
        ['finance_journal_entries.kind', 'finance_journal_entries_append_only', entry!.id, `update public.finance_journal_entries set kind = 'receipt_cash' where id = $1`, [entry!.id]],
        ['finance_journal_entries.branch_id', 'finance_journal_entries_append_only', entry!.id, 'update public.finance_journal_entries set branch_id = $2 where id = $1', [entry!.id, jdh!.id]],
        ['finance_journal_entries.deal_id', 'finance_journal_entries_append_only', entry!.id, 'update public.finance_journal_entries set deal_id = $2 where id = $1', [entry!.id, D.del002]],
        ['finance_journal_lines.account', 'finance_journal_lines_append_only', entry!.id, `update public.finance_journal_lines set account = 'cash_in_hand' where entry_id = $1 and debit_paise > 0`, [entry!.id]],
        ['finance_journal_lines.debit/credit', 'finance_journal_lines_append_only', entry!.id, `update public.finance_journal_lines set debit_paise = case when debit_paise > 0 then debit_paise + 1 else 0 end,
           credit_paise = case when credit_paise > 0 then credit_paise + 1 else 0 end where entry_id = $1`, [entry!.id]],
        ['customer_receipts.receipt_no', 'customer_receipts_a_guard', entry!.id, `update public.customer_receipts set receipt_no = 'R-2026-27-999999' where id = $1`, [s.receiptId]],
        ['customer_receipts.payer_name', 'customer_receipts_a_guard', entry!.id, `update public.customer_receipts set payer_name = 'Synthetic Other Payer' where id = $1`, [s.receiptId]],
        ['customer_receipts.mode', 'customer_receipts_a_guard', entry!.id, `update public.customer_receipts set mode = 'upi' where id = $1`, [s.receiptId]],
        ['customer_receipts.reference', 'customer_receipts_a_guard', entry!.id, `update public.customer_receipts set reference = 'UTRCHANGED01', reference_norm = 'UTRCHANGED01' where id = $1`, [s.receiptId]],
        ['customer_receipts.payer_pan', 'customer_receipts_a_guard', entry!.id, `update public.customer_receipts set payer_pan = 'PQRSX6789K' where id = $1`, [s.receiptId]],
        ['customer_receipts.payer_mobile', 'customer_receipts_a_guard', entry!.id, `update public.customer_receipts set payer_mobile = '6000456780' where id = $1`, [s.receiptId]],
        ['supplier_payment_requests.paid_on', 'supplier_payment_requests_b_guard', pay.id, 'update public.supplier_payment_requests set paid_on = paid_on - 1 where id = $1', [pay.id]],
        ['supplier_payment_requests.ref_no', 'supplier_payment_requests_b_guard', pay.id, `update public.supplier_payment_requests set ref_no = 'SP-2026-999999' where id = $1`, [pay.id]],
        ['supplier_payment_requests.amount_paise', 'supplier_payment_requests_b_guard', pay.id, 'update public.supplier_payment_requests set amount_paise = amount_paise + 1 where id = $1', [pay.id]],
        ['supplier_payment_requests.payment_mode', 'supplier_payment_requests_b_guard', pay.id, `update public.supplier_payment_requests set payment_mode = 'upi' where id = $1`, [pay.id]],
        ['supplier_payment_requests.bank_reference', 'supplier_payment_requests_b_guard', pay.id, `update public.supplier_payment_requests set bank_reference = 'UTRSUPCHANGED' where id = $1`, [pay.id]],
        ['supplier_payment_requests.supplier_id', 'supplier_payment_requests_b_guard', pay.id, 'update public.supplier_payment_requests set supplier_id = $2 where id = $1', [pay.id, otherSupplier]],
        ['supplier_payment_requests.deal_id', 'supplier_payment_requests_b_guard', pay.id, 'update public.supplier_payment_requests set deal_id = $2 where id = $1', [pay.id, D.del002]],
        ['supplier_documents.doc_date', 'supplier_documents_b_guard', doc.id, 'update public.supplier_documents set doc_date = doc_date - 1 where id = $1', [doc.id]],
        ['supplier_documents.number', 'supplier_documents_b_guard', doc.id, `update public.supplier_documents set number = 'SYN-TOUCH-2' where id = $1`, [doc.id]],
        ['supplier_documents.number -> its credit note', 'supplier_documents_b_guard', cn.id, `update public.supplier_documents set number = 'SYN-TOUCH-3' where id = $1`, [doc.id]],
        ['supplier_documents.total_paise', 'supplier_documents_b_guard', doc.id, 'update public.supplier_documents set total_paise = total_paise + 1 where id = $1', [doc.id]],
        ['supplier_documents.gst_included', 'supplier_documents_b_guard', doc.id, 'update public.supplier_documents set gst_included = not gst_included where id = $1', [doc.id]],
        ['supplier_documents.supplier_id', 'supplier_documents_b_guard', doc.id, 'update public.supplier_documents set supplier_id = $2 where id = $1', [doc.id, otherSupplier]],
        ['supplier_documents.deal_id', 'supplier_documents_b_guard', doc.id, 'update public.supplier_documents set deal_id = $2 where id = $1', [doc.id, D.del002]],
        ['supplier_documents.kind', 'supplier_documents_b_guard', doc.id, `update public.supplier_documents set kind = 'credit_note' where id = $1`, [doc.id]],
        ['supplier_documents.credits_document_id', 'supplier_documents_b_guard', cn.id, 'update public.supplier_documents set credits_document_id = null where id = $1', [cn.id]],
        ['supplier_document_tasks insert', 'none', doc.id, `insert into public.supplier_document_tasks (legal_entity_id, document_id, task_id, deal_id, branch_id, linked_by, request_id)
           select t.legal_entity_id, $1, t.id, t.deal_id, t.branch_id, $3, gen_random_uuid() from public.fulfilment_tasks t where t.id = $2`, [doc.id, s.transferTask, U.accountsJodhpur]],
        ['department_cost_entries.created_at', 'department_cost_entries_a_guard', exp!.id, `update public.department_cost_entries set created_at = created_at - interval '2 days' where id = $1`, [exp!.id]],
        ['department_cost_entries.paid_on', 'department_cost_entries_a_guard', exp!.id, `update public.department_cost_entries set paid_on = date '2026-01-02' where id = $1`, [exp!.id]],
        ['department_cost_entries.amount_paise', 'department_cost_entries_a_guard', exp!.id, 'update public.department_cost_entries set amount_paise = amount_paise + 1 where id = $1', [exp!.id]],
        ['department_cost_entries.payment_mode', 'department_cost_entries_a_guard', exp!.id, `update public.department_cost_entries set payment_mode = 'cash' where id = $1`, [exp!.id]],
        ['department_cost_entries.reference', 'department_cost_entries_a_guard', exp!.id, `update public.department_cost_entries set reference = 'SYN-CARD-2' where id = $1`, [exp!.id]],
        ['department_cost_entries.department', 'department_cost_entries_a_guard', exp!.id, `update public.department_cost_entries set department = 'visa' where id = $1`, [exp!.id]],
        ['department_cost_entries.deal_id', 'department_cost_entries_a_guard', exp!.id, 'update public.department_cost_entries set deal_id = $2 where id = $1', [exp!.id, D.del002]],
      ];
      const TOUCH_ONLY = new Set(['finance_journal_entries.kind', 'finance_journal_entries.branch_id']);
      const misses: string[] = [];
      for (const [name, guard, recordId, sql, params] of cases) {
        // Fire pending deferred checks first (ALTER TABLE refuses while trigger events are queued).
        await db.exec('set constraints all immediate');
        await db.exec('set constraints all deferred');
        await db.exec('savepoint touch_case');
        if (guard !== 'none') await db.exec(`alter table public.${guard.replace(/_(append_only|a_guard|b_guard)$/, '')} disable trigger ${guard}`);
        await owner(sql, params);
        // Two inputs do not change the CSV values in this setup (a receipt entry's kind within receipt kinds;
        // the entry branch while the Deal's branch is used): they must touch, and the hash then says unchanged.
        if (TOUCH_ONLY.has(name)) {
          const [t] = await owner<{ n: number }>(`select count(*)::int as n from public.tally_source_touches x
            join public.tally_records r on r.id = x.tally_record_id where r.record_id = $1`, [recordId]);
          if (t!.n !== 1 || (await changed()).has(recordId)) misses.push(name);
        } else if (!(await changed()).has(recordId)) misses.push(name);
        await db.exec('rollback to savepoint touch_case');
      }
      expect(misses).toEqual([]);
      // A change outside the hashed columns flags nothing (the receipt's note is not exported).
      await owner(`update public.supplier_payment_requests set row_version = row_version + 1, updated_at = now() where id = $1`, [pay.id]);
      expect(await changed()).toEqual(new Set());
    });
  });
});
