import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  assertDatabaseUrlNotOperational,
  claimsFor,
  createTestDb,
  istBusinessDate,
  resetActor,
  setActor,
} from '../helpers/db';
import { HOTEL, PURCHASE_CLAIM_SQL, b1Helpers } from './b1-support';

/**
 * Purchase build (migrations 20261130000100..0220): REAL concurrency on a
 * local Postgres (TEST_DATABASE_URL). Skipped under PGlite, which is a single
 * connection.
 *
 * Each race opens two separate connections acting as (possibly different)
 * users. The first runs its command inside an open transaction and holds
 * whatever it locked; the second starts its command while the first is still
 * uncommitted; then the first commits and the second finishes. A command that
 * checks-then-inserts without a lock would decide on a snapshot that misses
 * the first change, which is exactly what these tests catch.
 *
 * Setup rows are COMMITTED (separate connections cannot see uncommitted
 * setup), on fresh synthetic Deals (SYN-PCC-<run>-n), never the fixture
 * Deals. afterAll deletes every row of those Deals as the local table owner
 * with triggers off (session_replication_role = replica, test-only, local),
 * removes the temporary Accounts membership and restores the service-items
 * switch, so the rolled-back suites that run after this file see the
 * database as seeded.
 *
 * Synthetic actors: PURCHASE (Purchase Jodhpur), ACC (Accounts Jodhpur),
 * ACC2 (Visa Jodhpur with a temporary Accounts membership), MANAGER (Manager
 * Delhi), OWNER (Sales Delhi A).
 */

const url = process.env.TEST_DATABASE_URL;
const OWNER: Actor = { userId: U.salesDelhiA };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const SELLING = '45678901';
const HOTEL_COST = '10000000';
const FUNDING_REASON = 'Synthetic: customer money not received yet';
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const rid = () => crypto.randomUUID();

let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let monitor: pg.Client;
let c2Pid = 0;
let originalSwitch = false;
let addedMembership = false;
const dealIds: string[] = [];
let seq = 0;

const h = b1Helpers(() => db);

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

beforeAll(async () => {
  if (!url) return;
  await assertDatabaseUrlNotOperational(url);
  db = await createTestDb();
  c1 = await connect();
  c2 = await connect();
  monitor = await connect();
  c2Pid = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
  originalSwitch = (await db.query<{ on: boolean }>('select service_items_enabled as on from public.workflow_settings where id'))[0]!.on;
  const inserted = await db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'
     on conflict do nothing returning 1`, [U.visaJodhpur]);
  addedMembership = inserted.length > 0;
});

afterAll(async () => {
  if (!url || !db) return;
  try {
    await cleanup();
  } finally {
    await Promise.allSettled([c1?.end(), c2?.end(), monitor?.end()]);
    await db.close();
  }
});

/** Deletes every row of the run's Deals (owner, triggers off, one transaction). */
async function cleanup(): Promise<void> {
  await db.exec('begin');
  try {
    await db.exec('set local session_replication_role = replica');
    // This run's Deals plus any left behind by an interrupted earlier run.
    const swept = await db.query<{ id: string }>(`select id from public.deals where reference like 'SYN-PCC-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await db.query<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const suppliers = await db.query<{ id: string }>(
        `select distinct supplier_id as id from public.purchase_quotes where task_id = any($1::uuid[])`, [tasks]).then((r) => r.map((x) => x.id));
      const payments = await db.query<{ id: string }>(
        `select id from public.supplier_payment_requests where deal_id = any($1::uuid[])`, [dealIds]).then((r) => r.map((x) => x.id));
      const byColumn: Record<string, string[]> = {
        deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions, service_item_id: items,
        supplier_id: suppliers, payment_request_id: payments,
      };
      const cols = await db.query<{ t: string; c: string }>(
        `select table_name as t, column_name as c from information_schema.columns
         where table_schema = 'public' and column_name = any($1::text[])
           and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`,
        [Object.keys(byColumn)]);
      for (const { t, c } of cols) {
        const values = byColumn[c]!;
        if (values.length > 0) await db.query(`delete from public.${t} where ${c} = any($1::uuid[])`, [values]);
      }
      const all = [...dealIds, ...versions, ...tasks, ...items, ...suppliers, ...payments];
      await db.query('delete from public.suppliers where id = any($1::uuid[])', [suppliers]);
      await db.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await db.query('delete from public.audit_events where target_id = any($1::uuid[])', [all]);
      await db.query('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await db.query(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    if (addedMembership) {
      await db.query(`delete from public.memberships where user_id = $1 and role_code = 'accounts'`, [U.visaJodhpur]);
    }
    await db.query('update public.workflow_settings set service_items_enabled = $1 where id', [originalSwitch]);
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Setup (committed)
// ---------------------------------------------------------------------------

/** Runs `fn` in one committed owner transaction (actors switch per statement). */
async function committed<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    const out = await fn();
    await resetActor(db);
    await db.exec('commit');
    return out;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

const latestProposed = async (taskId: string) =>
  (await db.query<{ n: number }>(`select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1 and stage = 'proposed'`, [taskId]))[0]!.n;
const latestCost = async (taskId: string) =>
  (await db.query<{ n: number }>('select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1', [taskId]))[0]!.n;

type Ready = { dealId: string; taskId: string; quoteId: string; supplierId: string; proformaId: string };

/**
 * A fresh synthetic Deal with one hotel item, confirmed; Accounts review
 * approved; Purchase claimed it, supplier with approved bank details, final
 * rate INR 1,00,000, booking request sent, go-ahead approved, proforma stored.
 * No customer money: every payment request asks for company funding.
 */
async function readyHotel(opts: { goAhead?: boolean } = {}): Promise<Ready> {
  return committed(async () => {
    seq += 1;
    const [deal] = await db.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
       select b.legal_entity_id, b.id, $1, 'Synthetic purchase concurrency deal', $2
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
      [`SYN-PCC-${runTag}-${seq}`, U.salesDelhiA]);
    const dealId = deal!.id;
    dealIds.push(dealId);
    await db.query('update public.workflow_settings set service_items_enabled = true where id');
    const opened = await h.openDraft(OWNER, dealId);
    let rv = (await h.addItem(OWNER, opened.versionId, opened.rowVersion, 'hotel', HOTEL, '20000000')).rowVersion;
    rv = (await h.saveTravellers(OWNER, dealId, rv)).rowVersion;
    rv = (await h.saveSelling(OWNER, opened.versionId, rv, SELLING)).rowVersion;
    rv = await h.completeB11(OWNER, dealId, opened.versionId, rv, SELLING);
    await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'f'.repeat(64));
    const ready = await h.readiness(OWNER, opened.versionId);
    expect(ready.issues).toEqual([]);
    const confirmed = await h.confirm(OWNER, opened.versionId, ready.contentHash);
    const taskId = confirmed.taskIds![0]!;
    await db.query(
      `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
       select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1`,
      [opened.versionId, U.accountsJodhpur]);
    await h.one(PURCHASE, PURCHASE_CLAIM_SQL, [taskId]);
    const [entity] = await db.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
    const { supplierId } = await h.one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [entity!.id,
      JSON.stringify({ name: `Synthetic Concurrency Stays ${runTag}-${seq}`, serviceTypes: ['hotel'], city: 'Synthetic City',
        contactName: 'Synthetic Desk', contactPhone: '+91 00000 00000', contactEmail: 'desk@example.test', paymentTerms: 'Synthetic' })]);
    const bank = await h.one<{ revisionNo: number }>(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, rid(),
      JSON.stringify({ accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' })]);
    await h.one(MANAGER, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierId, bank.revisionNo]);
    const { quoteId } = await h.one<{ quoteId: string }>(PURCHASE, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [taskId, rid(),
      JSON.stringify({ supplierId, hotelName: 'Synthetic Hotel', roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', quotedCostPaise: HOTEL_COST,
        holdUntil: '2026-11-30', cancellationTerms: 'Synthetic' })]);
    await h.one(PURCHASE, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r',
      [taskId, quoteId, 0, HOTEL_COST, '2026-11-25', null, rid()]);
    if (opts.goAhead ?? true) {
      await h.one(PURCHASE, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
        [taskId, 1, 'desk@example.test', [], `Booking request · SYN-PCC-${runTag}-${seq}`, 'Synthetic body.', rid()]);
      const [g] = await db.query<{ id: string; row_version: number }>(
        `select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`, [taskId]);
      await h.one(ACC, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [g!.id, 'approve', null, g!.row_version, rid()]);
    }
    const ev = await h.one<{ evidenceId: string; objectPath: string }>(PURCHASE,
      'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
      ['proforma', taskId, 'proforma.pdf', 'application/pdf', 2048, 'e'.repeat(64), rid()]);
    await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
    await h.one(PURCHASE, 'select public.supplier_money_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
    return { dealId, taskId, quoteId, supplierId, proformaId: ev.evidenceId };
  });
}

const createFields = async (r: Ready, amount: number, expected?: number) => JSON.stringify({
  expectedCostVersionNo: expected ?? await latestProposed(r.taskId), part: 'deposit', amountPaise: String(amount),
  dueDate: '2026-11-20', note: null, proformaEvidenceId: r.proformaId, fundingReason: FUNDING_REASON,
});
const CREATE_SQL = 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r';

type Pay = { id: string; status: string; route: string; row_version: number; cost_version_no: number; amount_paise: string };
const payments = (taskId: string) => db.query<Pay>(
  `select id, status, route, row_version, cost_version_no, amount_paise::text as amount_paise
   from public.supplier_payment_requests where task_id = $1 order by ref_no`, [taskId]);

/** Committed: a pending request, optionally approved, funding approved, proof stored. */
async function approvedPayment(r: Ready, amount = 3_000_000): Promise<{ pay: Pay; proofId: string }> {
  return committed(async () => {
    await h.one(PURCHASE, CREATE_SQL, [r.taskId, await createFields(r, amount), rid()]);
    const [p] = await payments(r.taskId);
    await h.one(ACC, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r', [p!.id, 'approve', null, p!.row_version, rid()]);
    const [f] = await db.query<{ id: string; row_version: number }>(
      'select id, row_version from public.company_funding_requests where payment_request_id = $1', [p!.id]);
    if (f) await h.one(ACC2, 'select public.company_funding_decide($1, $2, $3, $4, $5) as r', [f.id, 'approve', null, f.row_version, rid()]);
    const ev = await h.one<{ evidenceId: string; objectPath: string }>(ACC,
      'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
      ['payment_proof', p!.id, 'proof.pdf', 'application/pdf', 2048, 'd'.repeat(64), rid()]);
    await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
    await h.one(ACC, 'select public.supplier_money_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
    return { pay: (await payments(r.taskId))[0]!, proofId: ev.evidenceId };
  });
}

// ---------------------------------------------------------------------------
// Racing
// ---------------------------------------------------------------------------

type Outcome = { ok: boolean; result?: unknown; error?: string };
type Step = { actor: Actor; sql: string; params: unknown[] };

async function begin(client: pg.Client, actor: Actor): Promise<void> {
  await client.query('begin');
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  await client.query('set local role authenticated');
}
async function attempt(client: pg.Client, step: Step): Promise<Outcome> {
  try {
    const { rows } = await client.query<{ r: unknown }>(step.sql, step.params);
    return { ok: true, result: rows[0]?.r };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
/** True when the second connection is waiting on a lock (polled up to ~1.5 s). */
async function waitsOnLock(): Promise<boolean> {
  for (let i = 0; i < 15; i += 1) {
    const { rows } = await monitor.query<{ w: string | null }>('select wait_event_type as w from pg_stat_activity where pid = $1', [c2Pid]);
    if (rows[0]?.w === 'Lock') return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * First runs and keeps its transaction open; second starts meanwhile; first
 * commits (or rolls back on error); second finishes and commits (or rolls back).
 */
async function race(first: Step, second: Step): Promise<{ a: Outcome; b: Outcome; secondWaited: boolean }> {
  await begin(c1, first.actor);
  const a = await attempt(c1, first);
  await begin(c2, second.actor);
  const pending = attempt(c2, second);
  const secondWaited = await waitsOnLock();
  await c1.query(a.ok ? 'commit' : 'rollback');
  const b = await pending;
  await c2.query(b.ok ? 'commit' : 'rollback');
  if (process.env.DEBUG_PURCHASE_RACE) console.info(`race ${first.sql.slice(14, 50)} | ${second.sql.slice(14, 50)}: waited=${secondWaited} a=${a.ok ? 'ok' : a.error} b=${b.ok ? 'ok' : b.error}`);
  return { a, b, secondWaited };
}

const enabled = Boolean(url);

describe.skipIf(!enabled)('Purchase build: real concurrency on local Postgres', () => {
  it('(a) two INR 30,000 requests on the same Deal and supplier at once: one Accounts route, one Manager route', async () => {
    const r = await readyHotel();
    const step = async (): Promise<Step> => ({ actor: PURCHASE, sql: CREATE_SQL, params: [r.taskId, await createFields(r, 3_000_000), rid()] });
    const { a, b, secondWaited } = await race(await step(), await step());
    expect(a.ok, a.error).toBe(true);
    expect(b.ok, b.error).toBe(true);
    const rows = await payments(r.taskId);
    expect(rows.map((p) => p.route).sort(), `second waited on a lock: ${secondWaited}`).toEqual(['accounts', 'manager']);
    // Company funding routes follow the same cumulative rule (30k + 30k of company money).
    const funding = await db.query<{ route: string }>(
      'select route from public.company_funding_requests where deal_id = $1 order by route', [r.dealId]);
    expect(funding.map((f) => f.route)).toEqual(['accounts', 'manager']);
  });

  it('(b) two decisions on one payment request at once: one wins, the other is already_decided or version_changed', async () => {
    const r = await readyHotel();
    await committed(async () => { await h.one(PURCHASE, CREATE_SQL, [r.taskId, await createFields(r, 2_000_000), rid()]); });
    const [p] = await payments(r.taskId);
    const DECIDE = 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r';
    const { a, b } = await race(
      { actor: ACC, sql: DECIDE, params: [p!.id, 'approve', null, p!.row_version, rid()] },
      { actor: ACC2, sql: DECIDE, params: [p!.id, 'return', 'Synthetic: proforma total does not match', p!.row_version, rid()] },
    );
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/^(already_decided|version_changed)$/);
    const [after] = await payments(r.taskId);
    expect(after).toMatchObject({ status: 'approved', row_version: p!.row_version + 1 });
  });

  it('(c) two booking-request sends with the same request id at once: one e-mail row, one go-ahead', async () => {
    const r = await readyHotel({ goAhead: false });
    const req = rid();
    const SEND = 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r';
    const params = [r.taskId, await latestCost(r.taskId), 'desk@example.test', [], 'Booking request · SYN-PCC', 'Synthetic body.', req];
    const { a, b } = await race({ actor: PURCHASE, sql: SEND, params }, { actor: PURCHASE, sql: SEND, params });
    expect(a.ok, a.error).toBe(true);
    // The second answers with the same e-mail (existing) or a duplicate refusal, never a new row.
    if (b.ok) expect((b.result as { emailId: string }).emailId).toBe((a.result as { emailId: string }).emailId);
    else expect(b.error).toMatch(/^(duplicate_request|version_changed|task_conflict)$/);
    const emails = await db.query('select id from public.purchase_supplier_emails where task_id = $1', [r.taskId]);
    expect(emails).toHaveLength(1);
    const goAheads = await db.query('select id from public.purchase_go_ahead_requests where task_id = $1', [r.taskId]);
    expect(goAheads).toHaveLength(1);
  });

  it('(d) record and verify at once: verify never lands on an unrecorded payment, and the recorder never verifies', async () => {
    const r = await readyHotel();
    const { pay, proofId } = await approvedPayment(r);
    const RECORD = 'select public.supplier_payment_record($1, $2::date, $3, $4, $5, $6, $7) as r';
    const VERIFY = 'select public.supplier_payment_verify($1, $2, $3) as r';
    const { a, b } = await race(
      { actor: ACC, sql: RECORD, params: [pay.id, istBusinessDate(), 'bank_transfer', 'UTRSYNPCC0001', proofId, pay.row_version, rid()] },
      { actor: ACC2, sql: VERIFY, params: [pay.id, pay.row_version, rid()] },
    );
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/^(already_decided|version_changed|not_ready)$/);
    const [after] = await payments(r.taskId);
    expect(after!.status).toBe('paid');
    // Then the other Accounts person verifies it normally.
    await begin(c2, ACC2);
    const ok = await attempt(c2, { actor: ACC2, sql: VERIFY, params: [pay.id, after!.row_version, rid()] });
    await c2.query(ok.ok ? 'commit' : 'rollback');
    expect(ok.ok, ok.error).toBe(true);
    expect((await payments(r.taskId))[0]!.status).toBe('verified');
  });

  it('(e) a new final rate racing a payment request: no payment is ever bound to a stale cost (both orders)', async () => {
    const PROPOSE = 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r';
    // Order 1: the new rate first, the payment request (for the old rate) meanwhile.
    const r1 = await readyHotel();
    const old1 = await latestProposed(r1.taskId);
    const o1 = await race(
      { actor: PURCHASE, sql: PROPOSE, params: [r1.taskId, r1.quoteId, await latestCost(r1.taskId), '9000000', '2026-11-25', null, rid()] },
      { actor: PURCHASE, sql: CREATE_SQL, params: [r1.taskId, await createFields(r1, 2_000_000, old1), rid()] },
    );
    expect(o1.a.ok, o1.a.error).toBe(true);
    expect(o1.b.ok).toBe(false);
    expect(o1.b.error).toMatch(/^(version_changed|go_ahead_missing)$/);
    expect(await payments(r1.taskId)).toEqual([]);

    // Order 2: the payment request first, the new rate meanwhile: the rate change is refused.
    const r2 = await readyHotel();
    const o2 = await race(
      { actor: PURCHASE, sql: CREATE_SQL, params: [r2.taskId, await createFields(r2, 2_000_000), rid()] },
      { actor: PURCHASE, sql: PROPOSE, params: [r2.taskId, r2.quoteId, await latestCost(r2.taskId), '9000000', '2026-11-25', null, rid()] },
    );
    expect(o2.a.ok, o2.a.error).toBe(true);
    expect(o2.b.ok).toBe(false);
    expect(o2.b.error).toBe('payment_in_progress');

    // Invariant on both Deals: every live payment names the current agreed rate.
    for (const r of [r1, r2]) {
      const agreed = await latestProposed(r.taskId);
      for (const p of await payments(r.taskId)) expect(p.cost_version_no).toBe(agreed);
    }
  });
});

// Keep the actor helpers referenced for the PGlite run (skipped suite).
void setActor;
