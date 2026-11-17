import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACC2_FIXTURE_USERS as U2,
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  assertDatabaseUrlNotOperational,
  claimsFor,
  createTestDb,
  resetActor,
} from '../helpers/db';
import { ACC2, FLIGHT, FLIGHT_ITEM, HOTEL_ITEM } from './acc-support';
import { ACC, CSQL, MANAGER, OWNER, REASON, acc2cHelpers, rid, today } from './acc2c-support';

/**
 * Accounts phase 2 contract 12.1 "Concurrency" for Track C, on a REAL local
 * Postgres (TEST_DATABASE_URL; skipped on PGlite: one connection). Lock order
 * 13.1: finance_lock_deal -> request / cancellation row -> cash-branch lock.
 *  (1) refund create vs create on one Deal: exactly one live request.
 *  (2) approve vs withdraw: one wins, the other wrong_state; never both.
 *  (3) payout vs receipt reversal: never more paid out than held - charge.
 *  (4) supplier refund record vs cancel: both serialize, no lost update.
 *  (5) Flight charge vs cancellation decide: approval never on stale charges.
 * No deadlock in ACC2C_RUNS runs each (default 50; Flight races 10, each
 * needs a fresh Deal). Setup rows are COMMITTED on fresh synthetic Deals
 * (SYN-ACC2C-<run>-n); afterAll removes them as the local table owner with
 * triggers off (session_replication_role = replica, test-only, local) and
 * restores memberships, switches and audit rows.
 *
 * Lead fix-forward (12 Nov 2026, the Track F pattern of acc-concurrency /
 * acc2-concurrency): the shared rows a committed step moves outside the
 * run's Deals — number counters, the accounts_settings rows (row_version
 * included), the workflow and notice switch rows, the memberships the run
 * activated, the synthetic company destinations its receipts added and stray
 * suppliers — are restored exactly, and afterAll proves the snapshot of those
 * tables equals the one taken before the run (a later Phase 1 numbering
 * suite on the same stack depends on it).
 */

const url = process.env.TEST_DATABASE_URL;
const RUNS = Number(process.env.ACC2C_RUNS ?? 50);
const FLIGHT_RUNS = Math.max(1, Math.min(RUNS, Number(process.env.ACC2C_FLIGHT_RUNS ?? 10)));
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();

let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let monitor: pg.Client;
let c2Pid = 0;
let auditStart = '0';
let noticeStart = '0';
let runStart = new Date(0).toISOString();
/** Shared tables restored row for row (no identity or generated columns). */
const RESTORED_TABLES = ['finance_receipt_counters', 'tally_export_counters', 'customer_refund_counters', 'supplier_payment_counters',
  'accounts_settings', 'workflow_settings', 'notice_settings'];
/** Shared tables that must read exactly as before the run (RESTORED_TABLES plus rows removed or reset by id). */
const PROVED_TABLES = [...RESTORED_TABLES, 'company_destinations', 'company_destination_versions', 'memberships', 'suppliers'];
/** Saved rows as the server's JSON text (to_jsonb keeps microseconds; a JS Date would not). */
const rowsBefore: Record<string, string[]> = {};
let snapshotBefore: Record<string, string> = {};
let membershipsBefore: Array<{ id: string; j: string }> = [];
const addedMemberships: string[] = [];
const activated: string[] = [];
const dealIds: string[] = [];
let seq = 0;

const c = acc2cHelpers(() => db);

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  if (!url) return;
  await assertDatabaseUrlNotOperational(url);
  db = await createTestDb();
  c1 = await connect();
  c2 = await connect();
  monitor = await connect();
  c2Pid = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
  auditStart = (await db.query<{ m: string }>('select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
  // Every notice written while the suite runs (committed setup steps fan out notices, e.g. bank details to approve).
  noticeStart = (await db.query<{ m: string }>('select coalesce(max(seq), 0)::text as m from public.staff_notices'))[0]!.m;
  runStart = (await db.query<{ t: string }>('select now()::text as t'))[0]!.t;
  for (const t of RESTORED_TABLES) rowsBefore[t] = (await db.query<{ j: string }>(`select to_jsonb(x)::text as j from public.${t} x`)).map((r) => r.j);
  snapshotBefore = await sharedSnapshot();
  // Second Accounts person (receipt verification) and Flight people, committed for the run.
  for (const [user, role] of [[U.visaJodhpur, 'accounts'], [U.movedStaff, 'flight'], [U.salesAhmedabad, 'flight']]) {
    const rows = await db.query<{ id: string }>(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'JDH' on conflict do nothing returning id`, [user, role]);
    addedMemberships.push(...rows.map((r) => r.id));
  }
  membershipsBefore = await db.query<{ id: string; j: string }>('select x.id::text as id, to_jsonb(x)::text as j from public.memberships x where x.user_id = any($1::uuid[])',
    [[U2.accountsJodhpur2, U2.managerJodhpur2]]);
  const acts = await db.query<{ id: string }>(
    `update public.memberships set status = 'active', deactivated_at = null where user_id = any($1::uuid[]) and status = 'inactive' returning id`,
    [[U2.accountsJodhpur2, U2.managerJodhpur2]]);
  activated.push(...acts.map((r) => r.id));
  await committed(async () => c.refundsOn(true));
});

afterAll(async () => {
  if (!url || !db) return;
  try {
    await cleanup();
    // Proof: every shared table reads exactly as before the run.
    const after = await sharedSnapshot();
    const changed = PROVED_TABLES.filter((t) => after[t] !== snapshotBefore[t]);
    if (changed.length > 0) {
      const detail = changed.map((t) => `${t}: before ${snapshotBefore[t]!.slice(0, 400)} | after ${after[t]!.slice(0, 400)}`).join('\n');
      throw new Error(`acc2c-concurrency left shared rows changed (${changed.join(', ')}):\n${detail}`);
    }
  } finally {
    await Promise.allSettled([c1?.end(), c2?.end(), monitor?.end()]);
    await db.close();
  }
});

/** Each shared table as one canonical JSON text (rows sorted by their JSON). */
async function sharedSnapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of PROVED_TABLES) {
    out[t] = (await db.query<{ j: string }>(
      `select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as j from public.${t} x`))[0]!.j;
  }
  return out;
}

/** Delete every row of `t` and put back the saved rows exactly (inside the cleanup transaction). */
async function restoreRows(t: string, rows: string[]): Promise<void> {
  await db.query(`delete from public.${t}`);
  // Every column straight from the saved JSON (server-side cast, exact timestamps).
  for (const row of rows) await db.query(`insert into public.${t} select (jsonb_populate_record(null::public.${t}, $1::jsonb)).*`, [row]);
}

async function cleanup(): Promise<void> {
  await db.exec('begin');
  try {
    await db.exec('set local session_replication_role = replica');
    const swept = await db.query<{ id: string }>(`select id from public.deals where reference like 'SYN-ACC2C-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await db.query<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const receipts = await ids('select id from public.customer_receipts where deal_id = any($1::uuid[])');
      const entries = await ids('select id from public.finance_journal_entries where deal_id = any($1::uuid[])');
      const requests = await ids('select id from public.customer_refund_requests where deal_id = any($1::uuid[])');
      const cancellations = await ids('select id from public.deal_cancellations where deal_id = any($1::uuid[])');
      const suppliers = (await db.query<{ id: string }>(
        'select distinct supplier_id as id from public.flight_ticket_batches where deal_id = any($1::uuid[])', [dealIds])).map((r) => r.id);
      await db.query(`delete from public.tally_source_touches where tally_record_id in (select id from public.tally_records where record_id = any($1::uuid[]))`,
        [entries]);
      await db.query('delete from public.tally_records where record_id = any($1::uuid[])', [entries]);
      const byColumn: Record<string, string[]> = { deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions,
        service_item_id: items, receipt_id: receipts, refund_request_id: requests, cancellation_id: cancellations, entry_id: entries };
      const cols = await db.query<{ t: string; c: string }>(
        `select table_name as t, column_name as c from information_schema.columns
         where table_schema = 'public' and column_name = any($1::text[])
           and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`,
        [Object.keys(byColumn)]);
      for (let pass = 0; pass < 3; pass += 1) {
        for (const { t, c: col } of cols) {
          const values = byColumn[col]!;
          if (values.length > 0) await db.query(`delete from public.${t} where ${col} = any($1::uuid[])`, [values]);
        }
      }
      if (suppliers.length > 0) {
        const supplierCols = await db.query<{ t: string }>(
          `select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'supplier_id'
             and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
        for (const { t } of supplierCols) await db.query(`delete from public.${t} where supplier_id = any($1::uuid[])`, [suppliers]);
        await db.query('delete from public.suppliers where id = any($1::uuid[])', [suppliers]);
      }
      const all = [...dealIds, ...versions, ...tasks, ...items, ...receipts, ...requests, ...cancellations];
      await db.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await db.query('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await db.query(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    if (addedMemberships.length > 0) await db.query('delete from public.memberships where id = any($1::uuid[])', [addedMemberships]);
    // Activated fixture memberships go back to their exact saved rows.
    // (Triggers are off in this transaction, so delete + insert of the same row is safe and copies every column exactly.)
    for (const row of membershipsBefore.filter((m) => activated.includes(m.id))) {
      await db.query('delete from public.memberships where id = $1::uuid', [row.id]);
      await db.query('insert into public.memberships select (jsonb_populate_record(null::public.memberships, $1::jsonb)).*', [row.j]);
    }
    // Synthetic company destinations the run's receipts added (finance-support), and suppliers no Deal pointed at any more.
    const dests = (await db.query<{ id: string }>(`select id from public.company_destinations where created_at >= $1::timestamptz
      and label = 'Synthetic fixture destination'`, [runStart])).map((r) => r.id);
    if (dests.length) {
      await db.query('update public.company_destinations set current_version_id = null where id = any($1::uuid[])', [dests]);
      await db.query('delete from public.company_destination_versions where destination_id = any($1::uuid[])', [dests]);
      await db.query('delete from public.company_destinations where id = any($1::uuid[])', [dests]);
    }
    const strays = (await db.query<{ id: string }>('select id from public.suppliers where created_at >= $1::timestamptz', [runStart])).map((r) => r.id);
    if (strays.length) {
      const supplierCols = await db.query<{ t: string }>(`select table_name as t from information_schema.columns where table_schema = 'public'
        and column_name = 'supplier_id' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
      for (const { t } of supplierCols) await db.query(`delete from public.${t} where supplier_id = any($1::uuid[])`, [strays]);
      await db.query('delete from public.suppliers where id = any($1::uuid[])', [strays]);
    }
    // Exact restore of the counters, the accounts_settings rows (row_version included) and the switch rows.
    for (const t of RESTORED_TABLES) await restoreRows(t, rowsBefore[t] ?? []);
    await db.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
    await db.query('delete from public.staff_notices where seq > $1::bigint', [noticeStart]);
    // Replay memory of this run's commands, and the refund numbering as it was.
    await db.query('delete from public.finance_command_results where created_at >= $1::timestamptz', [runStart]);
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

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

async function freshDeal(): Promise<string> {
  seq += 1;
  const [deal] = await db.query<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic refund concurrency deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-ACC2C-${runTag}-${seq}`, U.salesDelhiA]);
  dealIds.push(deal!.id);
  return deal!.id;
}

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
async function waitsOnLock(): Promise<boolean> {
  for (let i = 0; i < 15; i += 1) {
    const { rows } = await monitor.query<{ w: string | null }>('select wait_event_type as w from pg_stat_activity where pid = $1', [c2Pid]);
    if (rows[0]?.w === 'Lock') return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
/** c1 runs `first` inside an open transaction, c2 starts `second` (it should wait), then c1 commits. */
async function race(first: Step, second: Step): Promise<{ a: Outcome; b: Outcome; secondWaited: boolean }> {
  await begin(c1, first.actor);
  const a = await attempt(c1, first);
  await begin(c2, second.actor);
  const pending = attempt(c2, second);
  const secondWaited = await waitsOnLock();
  await c1.query(a.ok ? 'commit' : 'rollback');
  const b = await pending;
  await c2.query(b.ok ? 'commit' : 'rollback');
  return { a, b, secondWaited };
}
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
const noDeadlock = (...o: Outcome[]) => { for (const x of o) expect(x.error ?? '').not.toMatch(/deadlock/i); };
const fields = (receiptId: string, amount: string, charge = '1000000') => JSON.stringify({ reason: REASON, kind: 'cancellation', outcome: 'payout',
  customerChargePaise: charge, amountPaise: amount, payeeKind: 'original_payer', payeeReceiptId: receiptId });
const reqRow = async (id: string) =>
  (await q<{ status: string; row_version: number; amount_paise: string; customer_charge_paise: string }>(
    'select status, row_version, amount_paise::text, customer_charge_paise::text from public.customer_refund_requests where id = $1', [id]))[0]!;

/** Committed: approved hotel booking on a fresh Deal with verified money and an approved cancellation (nothing to charge). */
async function cancelledDeal(paid = '9000000') {
  return committed(async () => {
    const deal = await freshDeal();
    const b = await c.book([HOTEL_ITEM], { deal });
    await c.approve(b.versionId);
    const receipt = await c.receipt(deal, paid);
    await c.cancelApproved(deal);
    return { deal, receipt };
  });
}

describe.skipIf(!url)('Accounts phase 2 Track C: real concurrency on local Postgres (skipped on PGlite: one connection)', () => {
  it(`(1) refund create vs create (${RUNS} runs): exactly one live request; the other refund_open_exists`, async () => {
    const { deal, receipt } = await cancelledDeal();
    for (let i = 0; i < RUNS; i += 1) {
      const step = (): Step => ({ actor: OWNER, sql: CSQL.create, params: [deal, fields(receipt.id, '1000'), rid()] });
      const { a, b, secondWaited } = await race(step(), step());
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      expect(b).toMatchObject({ ok: false, error: 'refund_open_exists' });
      if (i === 0) expect(secondWaited).toBe(true);
      const live = await q<{ id: string; row_version: number }>(
        `select id, row_version from public.customer_refund_requests where deal_id = $1 and status in ('requested', 'returned', 'approved')`, [deal]);
      expect(live).toHaveLength(1);
      await committed(() => c.one(OWNER, CSQL.withdraw, [live[0]!.id, live[0]!.row_version, REASON, rid()]));
    }
  });

  it(`(2) approve vs withdraw (${RUNS} runs): one wins, never both`, async () => {
    const { deal, receipt } = await cancelledDeal();
    for (let i = 0; i < RUNS; i += 1) {
      const r = await committed(() => c.one<{ refundRequestId: string }>(OWNER, CSQL.create, [deal, fields(receipt.id, '1000'), rid()]));
      const row = await reqRow(r.refundRequestId);
      const approve: Step = { actor: MANAGER, sql: CSQL.decide, params: [r.refundRequestId, 'approve', row.amount_paise, row.customer_charge_paise,
        null, row.row_version, rid()] };
      const withdraw: Step = { actor: OWNER, sql: CSQL.withdraw, params: [r.refundRequestId, row.row_version, REASON, rid()] };
      const { a, b } = i % 2 === 0 ? await race(approve, withdraw) : await race(withdraw, approve);
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      expect(b.ok).toBe(false);
      expect(['wrong_state', 'version_changed', 'not_authorized']).toContain(b.error);
      const after = await reqRow(r.refundRequestId);
      expect(['approved', 'withdrawn']).toContain(after.status);
      if (after.status === 'approved') {
        await committed(() => c.one(MANAGER, CSQL.withdraw, [r.refundRequestId, after.row_version, REASON, rid()]));
      }
    }
  });

  it(`(3) payout vs receipt reversal (${RUNS} runs): never more paid out than held - charge`, async () => {
    const { deal } = await cancelledDeal('1000000');
    for (let i = 0; i < RUNS; i += 1) {
      // Fresh money for this run: 1,000,000 more; refund all of it but the charge's share.
      const setup = await committed(async () => {
        const receipt = await c.receipt(deal, '1000000');
        const held = BigInt(await c.held(deal));
        const r = await c.one<{ refundRequestId: string }>(OWNER, CSQL.create, [deal, fields(receipt.id, String(held - 1000000n)), rid()]);
        await c.decide(r.refundRequestId, 'approve');
        const ev = await c.proof('customer_refund', r.refundRequestId);
        return { receipt, r, ev, rv: (await reqRow(r.refundRequestId)).row_version };
      });
      const payout: Step = { actor: ACC2, sql: CSQL.payout, params: [setup.r.refundRequestId, setup.rv, JSON.stringify({ mode: 'bank_transfer',
        paidOn: today(), reference: `SYNRF${String(i).padStart(4, '0')}`, evidenceId: setup.ev }), rid()] };
      const reverse: Step = { actor: ACC, sql: 'select public.receipt_reverse($1, $2, $3, $4) as r',
        params: [setup.receipt.id, 'bank_return', 'Synthetic reversal during payout', rid()] };
      const { a, b } = i % 2 === 0 ? await race(payout, reverse) : await race(reverse, payout);
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      const after = await reqRow(setup.r.refundRequestId);
      if (i % 2 === 0) {
        // Payout first: paid within held - charge at payout time; the later reversal is not a refund and goes through.
        expect(after.status).toBe('paid');
        expect(b.ok, b.error).toBe(true);
      } else {
        // Reversal first: held fell under amount + charge, so the payout is refused.
        expect(b).toMatchObject({ ok: false, error: 'refund_exceeds_money' });
        expect(after.status).toBe('approved');
        await committed(() => c.one(MANAGER, CSQL.withdraw, [setup.r.refundRequestId, after.row_version, REASON, rid()]));
      }
      const held = BigInt((await q<{ v: string }>('select authz.refund_money_held($1)::text as v', [deal]))[0]!.v);
      const paidOut = BigInt((await q<{ v: string }>('select coalesce(sum(amount_paise), 0)::text as v from public.customer_refund_payouts where deal_id = $1',
        [deal]))[0]!.v);
      expect(paidOut >= 0n).toBe(true);
      // Top up so the next run starts from held >= charge.
      if (held < 1000000n) await committed(() => c.receipt(deal, String(1000000n - held)));
    }
  });

  it(`(6) Addendum L7: payout vs a new request with kept credit reserved (${RUNS} runs): never more out than held - charge - kept`, async () => {
    // held 9,000,000; settlement keep_credit 2,000,000 with charge 1,000,000 approved (credit reserved).
    const { deal, receipt } = await cancelledDeal('9000000');
    await committed(async () => {
      const kept = await c.one<{ refundRequestId: string }>(OWNER, CSQL.create, [deal, JSON.stringify({ reason: REASON, kind: 'cancellation',
        outcome: 'keep_credit', customerChargePaise: '1000000', amountPaise: '2000000' }), rid()]);
      await c.decide(kept.refundRequestId, 'approve');
    });
    for (let i = 0; i < RUNS; i += 1) {
      const held = BigInt(await c.held(deal));
      const max = held - 1000000n - 2000000n;
      if (max < 2n) await committed(() => c.receipt(deal, '1000000'));
      const heldNow = BigInt(await c.held(deal));
      const setup = await committed(async () => {
        const r = await c.one<{ refundRequestId: string }>(OWNER, CSQL.create, [deal, fields(receipt.id, '1'), rid()]);
        await c.decide(r.refundRequestId, 'approve');
        const ev = await c.proof('customer_refund', r.refundRequestId);
        return { r, ev, rv: (await reqRow(r.refundRequestId)).row_version };
      });
      const pay: Step = { actor: ACC2, sql: CSQL.payout, params: [setup.r.refundRequestId, setup.rv, JSON.stringify({ mode: 'bank_transfer',
        paidOn: today(), reference: `SYNKC${String(i).padStart(5, '0')}`, evidenceId: setup.ev }), rid()] };
      // The new request asks for everything left after the payout would be made, so only one order can succeed.
      const ask: Step = { actor: OWNER, sql: CSQL.create, params: [deal, fields(receipt.id, String(heldNow - 1000000n - 2000000n)), rid()] };
      const { a, b } = i % 2 === 0 ? await race(pay, ask) : await race(ask, pay);
      noDeadlock(a, b);
      const [paid, asked] = i % 2 === 0 ? [a, b] : [b, a];
      expect(paid.ok, paid.error).toBe(true);
      // While the payout's request is live a new request is refund_open_exists; after the payout the reserved kept
      // credit and the charge leave no room: refund_exceeds_money.
      expect(asked).toMatchObject({ ok: false, error: i % 2 === 0 ? 'refund_exceeds_money' : 'refund_open_exists' });
      const out = await q<{ v: string }>(`select coalesce(sum(amount_paise), 0)::text as v from public.customer_refund_payouts where deal_id = $1`, [deal]);
      const heldAfter = BigInt(await c.held(deal));
      expect(heldAfter >= 1000000n + 2000000n, `run ${i}: held ${heldAfter} paid ${out[0]!.v}`).toBe(true);
      // Clear whatever is live for the next run.
      const live = await q<{ id: string; row_version: number; status: string }>(
        `select id, row_version, status from public.customer_refund_requests where deal_id = $1 and (status in ('requested', 'returned')
           or (status = 'approved' and outcome = 'payout'))`, [deal]);
      for (const l of live) {
        await committed(() => c.one(l.status === 'approved' ? MANAGER : OWNER, CSQL.withdraw, [l.id, l.row_version, REASON, rid()]));
      }
    }
  });

  it(`(4) supplier refund record vs cancel (${RUNS} runs): serialized, no lost update`, async () => {
    const setup = await committed(async () => {
      const deal = await freshDeal();
      const b = await c.book([FLIGHT_ITEM], { deal });
      await c.approve(b.versionId);
      const batch = await c.flightBatch(deal, [1]);
      const opened = await c.one<{ cancellationId: string }>(MANAGER, CSQL.cancelOpen, [deal, REASON, rid()]);
      await c.one(FLIGHT, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: '0', refundExpectedPaise: '999999999' }), 0, rid()]);
      const [cx] = await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]);
      const sent = await c.one<{ rowVersion: number }>(FLIGHT, CSQL.cancelSend, [opened.cancellationId, cx!.row_version, rid()]);
      await c.one(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, sent.rowVersion, rid()]);
      const [charge] = await q<{ id: string }>('select id from public.flight_cancellation_charges where batch_id = $1', [batch.batchId]);
      return { deal, cancellationId: opened.cancellationId, chargeId: charge!.id };
    });
    const record = async (i: number, ev: string): Promise<Step> => ({ actor: ACC, sql: CSQL.srRecord, params: [JSON.stringify({
      sourceKind: 'flight_charge', sourceId: setup.chargeId, amountPaise: '100', receivedOn: today(), mode: 'bank_transfer',
      reference: `SYNSR${String(i).padStart(5, '0')}`, evidenceId: ev }), rid()] });
    for (let i = 0; i < RUNS; i += 1) {
      const prepared = await committed(async () => {
        const ev1 = await c.proof('supplier_refund', setup.cancellationId);
        const first = await c.one<{ supplierRefundId: string }>(ACC, CSQL.srRecord, (await record(i * 2, ev1)).params);
        const ev2 = await c.proof('supplier_refund', setup.cancellationId);
        return { first: first.supplierRefundId, ev2 };
      });
      const cancel: Step = { actor: ACC2, sql: CSQL.srCancel, params: [prepared.first, 1, REASON, rid()] };
      const rec = await record(i * 2 + 1, prepared.ev2);
      const { a, b } = i % 2 === 0 ? await race(cancel, rec) : await race(rec, cancel);
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      expect(b.ok, b.error).toBe(true);
    }
    const sums = await q<{ verified: string; rejected: string }>(
      `select count(*) filter (where status = 'verified')::text as verified, count(*) filter (where status = 'rejected')::text as rejected
       from public.supplier_refund_receipts where deal_id = $1`, [setup.deal]);
    expect(sums[0]).toEqual({ verified: String(RUNS), rejected: String(RUNS) });
  });

  it(`(5) Flight charge vs cancellation decide (${FLIGHT_RUNS} runs): approval never on stale charges; no deadlock`, async () => {
    for (let i = 0; i < FLIGHT_RUNS; i += 1) {
      const s = await committed(async () => {
        const deal = await freshDeal();
        const b = await c.book([FLIGHT_ITEM], { deal });
        await c.approve(b.versionId);
        const batch = await c.flightBatch(deal, [1]);
        const opened = await c.one<{ cancellationId: string }>(MANAGER, CSQL.cancelOpen, [deal, REASON, rid()]);
        await c.one(FLIGHT, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: '100', refundExpectedPaise: '100' }), 0, rid()]);
        const [cx] = await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]);
        const sent = await c.one<{ rowVersion: number }>(FLIGHT, CSQL.cancelSend, [opened.cancellationId, cx!.row_version, rid()]);
        return { batch, cancellationId: opened.cancellationId, rv: sent.rowVersion };
      });
      const decide: Step = { actor: MANAGER, sql: CSQL.cancelDecide, params: [s.cancellationId, 'approve', null, s.rv, rid()] };
      const charge: Step = { actor: FLIGHT, sql: CSQL.flightCharge, params: [s.batch.batchId,
        JSON.stringify({ airlineChargePaise: '200', refundExpectedPaise: '50' }), 1, rid()] };
      const { a, b } = i % 2 === 0 ? await race(decide, charge) : await race(charge, decide);
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      const [cx] = await q<{ status: string }>('select status from public.deal_cancellations where id = $1', [s.cancellationId]);
      if (i % 2 === 0) {
        // Approved first: the airline charge can no longer change (LD13).
        expect(cx!.status).toBe('approved');
        expect(b).toMatchObject({ ok: false, error: 'already_decided' });
      } else {
        // Charge first: the case is back to charges_entered, so the decision sees a new row version.
        expect(b).toMatchObject({ ok: false, error: 'version_changed' });
        expect(cx!.status).toBe('charges_entered');
      }
    }
  });
});
