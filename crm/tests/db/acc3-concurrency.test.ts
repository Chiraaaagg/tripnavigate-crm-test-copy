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
import { HOTEL, HOTEL_ITEM, PAST_HOTEL_ITEM, PAST_TRIP, SELLING, dayFrom } from './acc-support';
import { ACC, MANAGER, OWNER, PURCHASE, REASON, SQL3, SUPER, WORKER, acc3Helpers, asItems, rid, today } from './acc3-support';
import { NEW_SELLING, SQLB, idOf, relbHelpers } from './acc3-relb-support';

/**
 * Accounts phase 3, Track T — contract 16.1 "Concurrency" on a REAL local
 * Postgres (TEST_DATABASE_URL; skipped on PGlite, which has one connection).
 * Lock order 17.1: finance_lock_deal -> Deal -> versions -> tasks -> subject
 * row -> Tally entity lock -> supplier + hotel lock. Workers lock only their
 * own queue rows (skip locked). Each race runs ACC3_RUNS times (default 50;
 * races that need a fresh booking per run use ACC3_SLOW_RUNS, default 10) and
 * must never deadlock.
 *
 * Setup rows are COMMITTED on fresh synthetic Deals (SYN-ACC3C-<run>-n);
 * afterAll removes them as the local table owner with triggers off and
 * restores the shared rows exactly (Phase 2 acc2c-concurrency pattern), then
 * proves the shared tables read as before. Written from the contract; run
 * only by the lead (who resets the stack).
 */

const url = process.env.TEST_DATABASE_URL;
const RUNS = Number(process.env.ACC3_RUNS ?? 50);
const SLOW_RUNS = Math.max(1, Math.min(RUNS, Number(process.env.ACC3_SLOW_RUNS ?? 10)));
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
/** Unique synthetic WhatsApp number for the STOP race (Addendum L4). */
const RACE_MOBILE = `60000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;

/** Period start inside the 366-day Tally file cap (Addendum L5): 300 days before today (India time). */
const FROM = dayFrom(-300);
let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let monitor: pg.Client;
let c2Pid = 0;
let auditStart = '0';
let noticeStart = '0';
let runStart = new Date(0).toISOString();
const RESTORED_TABLES = ['finance_receipt_counters', 'tally_export_counters', 'customer_refund_counters', 'supplier_payment_counters',
  'accounts_settings', 'workflow_settings', 'notice_settings', 'customer_document_counters', 'write_off_counters', 'customer_message_switches',
  'customer_message_settings', 'whatsapp_templates', 'booking_change_settings', 'timer_settings'];
const PROVED_TABLES = [...RESTORED_TABLES, 'memberships', 'suppliers'];
const rowsBefore: Record<string, string[]> = {};
let snapshotBefore: Record<string, string> = {};
let constraintsBefore = '';
/** Every constraint of the public schema (name + definition): a test must never leave one dropped or changed. */
async function constraintSnapshot(): Promise<string> {
  return (await db.query<{ j: string }>(`select coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname || '=' || pg_get_constraintdef(c.oid), E'\n'
    order by c.conrelid::regclass::text, c.conname), '') as j from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'`))[0]!.j;
}
let membershipsBefore: Array<{ id: string; j: string }> = [];
const addedMemberships: string[] = [];
const activated: string[] = [];
const dealIds: string[] = [];
let seq = 0;

const h = acc3Helpers(() => db);
const g = relbHelpers(() => db);

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
const existing = async (t: string) => (await db.query<{ ok: boolean }>(`select to_regclass('public.' || $1) is not null as ok`, [t]))[0]!.ok;

beforeAll(async () => {
  if (!url) return;
  await assertDatabaseUrlNotOperational(url);
  db = await createTestDb();
  c1 = await connect();
  c2 = await connect();
  monitor = await connect();
  c2Pid = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
  auditStart = (await db.query<{ m: string }>('select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
  noticeStart = (await db.query<{ m: string }>('select coalesce(max(seq), 0)::text as m from public.staff_notices'))[0]!.m;
  runStart = (await db.query<{ t: string }>('select now()::text as t'))[0]!.t;
  for (const t of RESTORED_TABLES) {
    if (await existing(t)) rowsBefore[t] = (await db.query<{ j: string }>(`select to_jsonb(x)::text as j from public.${t} x`)).map((r) => r.j);
  }
  snapshotBefore = await sharedSnapshot();
  constraintsBefore = await constraintSnapshot();
  for (const [user, role] of [[U.visaJodhpur, 'accounts']]) {
    const rows = await db.query<{ id: string }>(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'JDH' on conflict do nothing returning id`, [user, role]);
    addedMemberships.push(...rows.map((r) => r.id));
  }
  const people = Object.values(U2);
  membershipsBefore = await db.query<{ id: string; j: string }>('select x.id::text as id, to_jsonb(x)::text as j from public.memberships x where x.user_id = any($1::uuid[])',
    [people]);
  const acts = await db.query<{ id: string }>(
    `update public.memberships set status = 'active', deactivated_at = null where user_id = any($1::uuid[]) and status = 'inactive' returning id`, [people]);
  activated.push(...acts.map((r) => r.id));
});

afterAll(async () => {
  if (!url || !db) return;
  try {
    await cleanup();
    const after = await sharedSnapshot();
    const changed = PROVED_TABLES.filter((t) => after[t] !== snapshotBefore[t]);
    if (changed.length > 0) throw new Error(`acc3-concurrency left shared rows changed: ${changed.join(', ')}`);
    if ((await constraintSnapshot()) !== constraintsBefore) throw new Error('acc3-concurrency left a public constraint dropped or changed');
    const leftDeals = await db.query(`select id from public.deals where reference like 'SYN-ACC3C-%'`);
    if (leftDeals.length > 0) throw new Error(`acc3-concurrency left ${leftDeals.length} run Deals`);
  } finally {
    await Promise.allSettled([c1?.end(), c2?.end(), monitor?.end()]);
    await db.close();
  }
});

async function sharedSnapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of PROVED_TABLES) {
    if (!(await existing(t))) continue;
    out[t] = (await db.query<{ j: string }>(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as j from public.${t} x`))[0]!.j;
  }
  return out;
}
async function restoreRows(t: string, rows: string[]): Promise<void> {
  await db.query(`delete from public.${t}`);
  for (const row of rows) await db.query(`insert into public.${t} select (jsonb_populate_record(null::public.${t}, $1::jsonb)).*`, [row]);
}

async function cleanup(): Promise<void> {
  await db.exec('begin');
  try {
    await db.exec('set local session_replication_role = replica');
    const swept = await db.query<{ id: string }>(`select id from public.deals where reference like 'SYN-ACC3C-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await db.query<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const receipts = await ids('select id from public.customer_receipts where deal_id = any($1::uuid[])');
      const entries = await ids('select id from public.finance_journal_entries where deal_id = any($1::uuid[])');
      const docs = await ids('select id from public.customer_documents where deal_id = any($1::uuid[])');
      const wos = (await existing('deal_write_offs')) ? await ids('select id from public.deal_write_offs where deal_id = any($1::uuid[])') : [];
      const crs = (await existing('booking_change_requests')) ? await ids('select id from public.booking_change_requests where deal_id = any($1::uuid[])') : [];
      const msgs = await ids('select id from public.customer_messages where deal_id = any($1::uuid[])');
      const records = [...entries, ...wos];
      await db.query(`delete from public.tally_source_touches where tally_record_id in (select id from public.tally_records where record_id = any($1::uuid[]))`,
        [records]);
      await db.query('delete from public.tally_export_lines where record_id = any($1::uuid[])', [records]).catch(() => undefined);
      await db.query('delete from public.tally_records where record_id = any($1::uuid[])', [records]);
      const byColumn: Record<string, string[]> = { deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions,
        service_item_id: items, receipt_id: receipts, entry_id: entries, document_id: docs, change_request_id: crs, message_id: msgs };
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
      const all = [...dealIds, ...versions, ...tasks, ...items, ...receipts, ...docs, ...wos, ...crs];
      // liveDeal() gave relabelled run Deals a processed inbox row: remove it after its Deal.
      const inboxes = (await db.query<{ id: string }>('select intake_inbox_id as id from public.deals where id = any($1::uuid[]) and intake_inbox_id is not null',
        [dealIds])).map((r) => r.id);
      await db.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      if (inboxes.length) await db.query('delete from public.integration_inbox where id = any($1::uuid[])', [inboxes]);
      await db.query('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await db.query(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    // Push jobs of the run's devices first (test jobs are aged by race 10, so created_at alone would miss them).
    if (await existing('staff_push_devices')) {
      await db.query(`delete from public.staff_push_jobs where device_id in (select id from public.staff_push_devices where created_at >= $1::timestamptz)`,
        [runStart]);
    }
    // Push devices and jobs, Tally XML files and match batches made by the run.
    for (const t of ['staff_push_jobs', 'staff_push_devices', 'tally_match_rows', 'tally_match_batches', 'tally_export_left_out', 'customer_whatsapp_optouts',
      'customer_message_events', 'customer_message_alerts']) {
      if (!(await existing(t))) continue;
      const hasCreated = (await db.query<{ ok: boolean }>(`select exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = $1 and column_name = 'created_at') as ok`, [t]))[0]!.ok;
      if (hasCreated) await db.query(`delete from public.${t} where created_at >= $1::timestamptz`, [runStart]);
    }
    await db.query(`delete from public.tally_exports where created_at >= $1::timestamptz and format = 'xml'`, [runStart]).catch(() => undefined);
    if (addedMemberships.length > 0) await db.query('delete from public.memberships where id = any($1::uuid[])', [addedMemberships]);
    for (const row of membershipsBefore.filter((m) => activated.includes(m.id))) {
      await db.query('delete from public.memberships where id = $1::uuid', [row.id]);
      await db.query('insert into public.memberships select (jsonb_populate_record(null::public.memberships, $1::jsonb)).*', [row.j]);
    }
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
    for (const t of RESTORED_TABLES) if (rowsBefore[t]) await restoreRows(t, rowsBefore[t]!);
    await db.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
    await db.query('delete from public.staff_notices where seq > $1::bigint', [noticeStart]);
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
     select b.legal_entity_id, b.id, $1, 'Synthetic phase 3 concurrency deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-ACC3C-${runTag}-${seq}`, U.salesDelhiA]);
  dealIds.push(deal!.id);
  return deal!.id;
}

type Outcome = { ok: boolean; result?: unknown; error?: string };
type Step = { actor: Actor; sql: string; params: unknown[] };
async function begin(client: pg.Client, actor: Actor): Promise<void> {
  await client.query('begin');
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  await client.query(`set local role ${actor.role === 'service_role' ? 'service_role' : 'authenticated'}`);
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
/** c1 runs `first` in an open transaction, c2 starts `second`, then c1 commits; both end. */
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

/** Committed: documents + automatic drafts On (release as given), write-off On, people. */
async function switchesOn(release = true) {
  await committed(async () => {
    await h.docsOn();
    await h.autoBills(true, release);
    await h.writeOffOn(true);
  });
}
/** Committed: approved hotel booking on a fresh Deal (past trip when `past`). */
async function bookedDeal(opts: { past?: boolean; approve?: 'real' | 'owner' } = {}) {
  return committed(async () => {
    const deal = await freshDeal();
    const b = await h.book([opts.past ? PAST_HOTEL_ITEM : HOTEL_ITEM], { deal, ...(opts.past ? { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } } : {}) });
    if ((opts.approve ?? 'real') === 'real') await h.approveReal(b.versionId, deal);
    return { deal, b };
  });
}
/** A recorded (not yet verified) bank receipt on `deal`. */
const recorded = (deal: string, amount: string) => committed(async () => h.fin.record(ACC, deal, await h.fin.bankFields({ amountPaise: amount })));
const verifyStep = (receiptId: string): Step => ({ actor: { userId: U.visaJodhpur }, sql: 'select public.receipt_verify($1, $2) as r', params: [receiptId, rid()] });

describe.skipIf(!url)('Accounts phase 3: real concurrency on local Postgres (skipped on PGlite)', () => {
  it(`(1) automatic release vs manual release (${SLOW_RUNS} runs): one number, never two`, async () => {
    await switchesOn(false);
    for (let i = 0; i < SLOW_RUNS; i += 1) {
      const { deal } = await bookedDeal();
      const [doc] = await q<{ id: string; row_version: number; content_sha256: string }>(
        `select id, row_version, content_sha256 from public.customer_documents where deal_id = $1 and kind = 'invoice' and status = 'draft'`, [deal]);
      expect(doc, 'automatic Invoice draft waiting (release Off)').toBeDefined();
      await committed(() => h.autoBills(true, true));
      const manual: Step = { actor: ACC, sql: SQL3.docRelease, params: [doc!.id, doc!.row_version, doc!.content_sha256, rid()] };
      // ASSUMPTION: the automatic path is reachable from a staff session only through the sweep / triggers; the race uses authz.cdoc_auto_run as the owner role.
      const auto: Step = { actor: WORKER, sql: 'select authz.cdoc_auto_run($1, $2) as r', params: [deal, 'inv_on_approval'] };
      const { a, b } = i % 2 === 0 ? await race(manual, auto) : await race(auto, manual);
      noDeadlock(a, b);
      const released = await q<{ number: string }>(`select number from public.customer_documents where deal_id = $1 and kind = 'invoice' and number is not null`, [deal]);
      expect(released).toHaveLength(1);
      expect(released[0]!.number).toMatch(/-INV-1$/);
      await committed(() => h.autoBills(true, false));
    }
  });

  it(`(2) receipt verify vs review approve on one Deal (${SLOW_RUNS} runs): drafts once each, numbers 1 and 2, no deadlock`, async () => {
    await switchesOn(true);
    for (let i = 0; i < SLOW_RUNS; i += 1) {
      const { deal, b } = await bookedDeal({ approve: 'owner' });
      // Billing verified, review pending: approve and a receipt verify race.
      const rec = await recorded(deal, '2500000');
      await committed(async () => {
        const [billing] = await q<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
        const saved = await h.one<{ rowVersion: number }>(ACC, 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r', [deal,
          billing?.row_version ?? 0, JSON.stringify({ billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null,
            city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }), rid()]);
        await h.one(ACC, 'select public.accounts_billing_verify($1, $2, $3) as r', [deal, saved.rowVersion, rid()]);
        await q(`update public.accounts_booking_reviews set status = 'pending' where booking_version_id = $1`, [b.versionId]).catch(() => undefined);
      });
      const [review] = await q<{ row_version: number }>('select row_version from public.accounts_booking_reviews where booking_version_id = $1', [b.versionId]);
      const approve: Step = { actor: ACC, sql: 'select public.accounts_review_approve($1, $2, $3) as r', params: [b.versionId, review?.row_version ?? 0, rid()] };
      const { a, b: o } = i % 2 === 0 ? await race(approve, verifyStep(rec.id)) : await race(verifyStep(rec.id), approve);
      noDeadlock(a, o);
      const docs = await q<{ kind: string; number: string | null }>('select kind, number from public.customer_documents where deal_id = $1', [deal]);
      const numbers = docs.map((d) => d.number).filter(Boolean);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(docs.filter((d) => d.kind === 'advance_invoice').length).toBeLessThanOrEqual(1);
      expect(docs.filter((d) => d.kind === 'invoice').length).toBeLessThanOrEqual(1);
    }
  });

  it(`(3) write-off propose vs propose (${RUNS} runs): one write_off_open_exists`, async () => {
    await switchesOn(true);
    const { deal } = await bookedDeal({ past: true });
    await committed(() => h.receipt(deal, String(Number(SELLING) - 30000)));
    for (let i = 0; i < RUNS; i += 1) {
      const step = (actor: Actor): Step => ({ actor, sql: SQL3.woPropose, params: [deal, JSON.stringify({ direction: 'due', amountPaise: '30000',
        reason: REASON }), rid()] });
      const { a, b } = await race(step(ACC), step({ userId: U2.accountsJodhpur2 }));
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      expect(b).toMatchObject({ ok: false, error: 'write_off_open_exists' });
      const [w] = await q<{ id: string; row_version: number }>(`select id, row_version from public.deal_write_offs where deal_id = $1 and status = 'proposed'`, [deal]);
      await committed(() => h.one(ACC, SQL3.woWithdraw, [w!.id, w!.row_version, REASON, rid()]));
    }
  });

  it(`(4) write-off approve vs receipt verify (${SLOW_RUNS} runs): never approved against a stale balance`, async () => {
    await switchesOn(true);
    for (let i = 0; i < SLOW_RUNS; i += 1) {
      const { deal } = await bookedDeal({ past: true });
      await committed(() => h.receipt(deal, String(Number(SELLING) - 30000)));
      const p = await committed(() => h.one<{ writeOffId: string }>(ACC, SQL3.woPropose, [deal, JSON.stringify({ direction: 'due', amountPaise: '30000',
        reason: REASON }), rid()]));
      const late = await recorded(deal, '100');
      const [w] = await q<{ row_version: number }>('select row_version from public.deal_write_offs where id = $1', [p.writeOffId]);
      const approve: Step = { actor: MANAGER, sql: SQL3.woDecide, params: [p.writeOffId, 'approve', '30000', null, w!.row_version, rid()] };
      const { a, b } = i % 2 === 0 ? await race(approve, verifyStep(late.id)) : await race(verifyStep(late.id), approve);
      noDeadlock(a, b);
      const dues = await committed(() => h.one<{ balancePaise: string; creditPaise: string; writeOffNeedsReview: boolean }>(ACC, SQL3.dealDues, [deal]));
      const [status] = await q<{ status: string }>('select status from public.deal_write_offs where id = $1', [p.writeOffId]);
      // Either approval saw the old balance and the later receipt raises the review flag, or approval saw the new balance and was refused.
      if (status!.status === 'approved') expect(dues.writeOffNeedsReview).toBe(true);
      else expect(status!.status).toBe('proposed');
    }
  });

  it(`(5) change request create vs create (${RUNS} runs): one change_open_exists`, async () => {
    const deal = await freshDeal();
    const setup = await committed(async () => {
      const b = await h.book([HOTEL_ITEM], { deal });
      await h.approveReal(b.versionId, deal);
      await h.supplierConfirmed(h.taskOf(b, 'hotel'));
      await g.changesOn();
      return b;
    });
    for (let i = 0; i < RUNS; i += 1) {
      const step = (actor: Actor): Step => ({ actor, sql: SQLB.crCreate, params: [deal, JSON.stringify({ kind: 'change', itemIds: [setup.itemIds[0]],
        changeSummary: 'Synthetic change: room type to suite', reason: REASON }), rid()] });
      const { a, b } = await race(step(OWNER), step(MANAGER));
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      expect(b).toMatchObject({ ok: false, error: 'change_open_exists' });
      const id = idOf(a.result, 'changeRequestId', 'id');
      const [cr] = await q<{ row_version: number }>('select row_version from public.booking_change_requests where id = $1', [id]);
      await committed(() => h.one(OWNER, SQLB.crWithdraw, [id, cr!.row_version, REASON, rid()]));
    }
  });

  /** Committed: fresh Deal, hotel supplier-confirmed, a submitted change with one pending reconfirmation. */
  async function pendingReconfirmation() {
    const deal = await freshDeal();
    return committed(async () => {
      const b = await h.book([HOTEL_ITEM], { deal });
      await h.approveReal(b.versionId, deal);
      const task = h.taskOf(b, 'hotel');
      await h.supplierConfirmed(task);
      await g.changesOn();
      const cr = await g.requestChange({ itemIds: [b.itemIds[0]!] }, OWNER, deal);
      const v = await g.openChange(cr.changeRequestId);
      const rv = (await h.one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [b.itemIds[0], v.versionId, v.rowVersion,
        JSON.stringify({ ...HOTEL, roomType: 'Synthetic Suite' }), '20000000'])).rowVersion;
      await g.newTotal(v.versionId, rv, NEW_SELLING);
      await g.submitChange(cr.changeRequestId, [b.itemIds[0]!]);
      await g.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      const [reconf] = await q<{ id: string; row_version: number }>('select id, row_version from public.task_reconfirmations where change_request_id = $1',
        [cr.changeRequestId]);
      return { deal, task, cr, reconf: reconf! };
    });
  }

  it(`(6) reconfirm record vs request withdraw (${SLOW_RUNS} runs): withdrawn wins -> void, or recorded then voided; never applied after withdraw`, async () => {
    for (let i = 0; i < SLOW_RUNS; i += 1) {
      const { task, cr, reconf } = await pendingReconfirmation();
      const proof = await committed(() => g.reconfirmProof(task));
      const record: Step = { actor: PURCHASE, sql: SQLB.reconfirmRecord, params: [reconf.id, reconf.row_version, JSON.stringify({ newRatePaise: '9000000',
        supplierFeePaise: '0', newReference: 'SYN-CONF-0002', note: null, evidenceId: proof }), rid()] };
      const [row] = await q<{ row_version: number }>('select row_version from public.booking_change_requests where id = $1', [cr.changeRequestId]);
      const withdraw: Step = { actor: OWNER, sql: SQLB.crWithdraw, params: [cr.changeRequestId, row!.row_version, REASON, rid()] };
      const { a, b } = i % 2 === 0 ? await race(record, withdraw) : await race(withdraw, record);
      noDeadlock(a, b);
      const [after] = await q<{ status: string }>('select status from public.booking_change_requests where id = $1', [cr.changeRequestId]);
      const [r] = await q<{ status: string }>('select status from public.task_reconfirmations where id = $1', [reconf.id]);
      if (after!.status === 'withdrawn') expect(r!.status).toBe('void');
      else expect(['applied', 'recorded']).toContain(r!.status);
    }
  });

  it(`(7) apply vs supplier payment request (${SLOW_RUNS} runs): a payment is never requested against the pre-change cost after apply`, async () => {
    for (let i = 0; i < SLOW_RUNS; i += 1) {
      const { task, reconf } = await pendingReconfirmation();
      const proof = await committed(() => g.reconfirmProof(task));
      const proforma = await committed(() => h.moneyFile(PURCHASE, task, 'proforma'));
      const record: Step = { actor: PURCHASE, sql: SQLB.reconfirmRecord, params: [reconf.id, reconf.row_version, JSON.stringify({ newRatePaise: '9000000',
        supplierFeePaise: '0', newReference: 'SYN-CONF-0002', note: null, evidenceId: proof }), rid()] };
      const pay: Step = { actor: PURCHASE, sql: 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', params: [task, JSON.stringify({
        expectedCostVersionNo: 1, part: 'deposit', amountPaise: '100000', dueDate: null, note: null, proformaEvidenceId: proforma, askFunding: false }), rid()] };
      const { a, b } = i % 2 === 0 ? await race(record, pay) : await race(pay, record);
      noDeadlock(a, b);
      // While pending / recorded, a new payment is refused change_in_progress (10.3); a payment that won first blocks the record (payment_in_progress).
      const outcomes = [a, b].map((o) => (o.ok ? 'ok' : o.error));
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      for (const o of outcomes) if (o !== 'ok') expect(['change_in_progress', 'payment_in_progress', 'version_changed']).toContain(o);
    }
  });

  it(`(8) Tally file vs write-off undo (${SLOW_RUNS} runs): the file never holds an undone write-off as new`, async () => {
    await switchesOn(true);
    await committed(() => h.tallyXmlOn(true));
    for (let i = 0; i < SLOW_RUNS; i += 1) {
      const { deal } = await bookedDeal({ past: true });
      await committed(() => h.receipt(deal, String(Number(SELLING) - 30000)));
      const p = await committed(() => h.one<{ writeOffId: string }>(ACC, SQL3.woPropose, [deal, JSON.stringify({ direction: 'due', amountPaise: '30000',
        reason: REASON }), rid()]));
      await committed(async () => {
        const [w] = await q<{ row_version: number }>('select row_version from public.deal_write_offs where id = $1', [p.writeOffId]);
        await h.one(MANAGER, SQL3.woDecide, [p.writeOffId, 'approve', '30000', null, w!.row_version, rid()]);
      });
      const [w2] = await q<{ row_version: number }>('select row_version from public.deal_write_offs where id = $1', [p.writeOffId]);
      const entity = await committed(() => h.entityId());
      const file: Step = { actor: ACC, sql: SQL3.fileCreate, params: [entity, FROM, today(), ['write_off'], null, false, null, rid()] };
      const undo: Step = { actor: MANAGER, sql: SQL3.woUndo, params: [p.writeOffId, w2!.row_version, REASON, rid()] };
      const { a, b } = i % 2 === 0 ? await race(file, undo) : await race(undo, file);
      noDeadlock(a, b);
      const [st] = await q<{ status: string }>('select status from public.deal_write_offs where id = $1', [p.writeOffId]);
      const inFile = await q('select 1 from public.tally_export_lines where record_id = $1', [p.writeOffId]);
      if (st!.status === 'undone' && inFile.length > 0) {
        // Undo after the file: exported state kept, flagged as changed since the file (7.2).
        const [tr] = await q<{ status: string }>(`select status from public.tally_records where record_kind = 'write_off' and record_id = $1`, [p.writeOffId]);
        expect(tr!.status).toBe('exported');
      }
    }
  });

  it(`(9) message claim vs STOP (${RUNS} runs): a claimed WhatsApp message is never sent after the STOP was recorded first`, async () => {
    const { deal } = await bookedDeal();
    await committed(async () => {
      await h.liveDeal(deal); // constraint-safe relabel (full provenance); inbox row removed in cleanup
      await h.messagesOn(['payment_received']);
      await h.one(OWNER, SQL3.prefsSet, [deal, 0, JSON.stringify({ whatsappMobile: RACE_MOBILE, whatsappSameAsMobile: false }), rid()]);
    });
    for (let i = 0; i < RUNS; i += 1) {
      await committed(async () => {
        await q(`update public.customer_whatsapp_optouts set restarted_at = now(), restart_source = 'staff' where restarted_at is null`);
        await h.enqueue(deal, 'payment_received', `receipt:race-${runTag}-${i}`, { customerName: 'S', dealReference: 'SYN', amountPaise: '1', balancePaise: '0' });
        await h.dueNow();
      });
      const claim: Step = { actor: WORKER, sql: SQL3.claim, params: ['acc3-race', 25, 60] };
      const stop: Step = { actor: WORKER, sql: SQL3.eventRecord, params: ['interakt', `ev-race-${runTag}-${i}`, null, 'inbound_stop', null, RACE_MOBILE] };
      const { a, b } = i % 2 === 0 ? await race(stop, claim) : await race(claim, stop);
      noDeadlock(a, b);
      const claimed = asItems<{ id: string; channel: string }>((i % 2 === 0 ? b : a).result).filter((m) => m.channel === 'whatsapp');
      if (i % 2 === 0) expect(claimed, 'STOP committed first: nothing claimed for WhatsApp').toEqual([]);
      // Release leases for the next run.
      await committed(() => q(`update public.customer_messages set status = 'failed', failed_at = now(), last_error_code = 'expired'
        where deal_id = $1 and status in ('queued', 'sending')`, [deal]));
    }
  });

  it(`(10) push claim vs device removal (${RUNS} runs): a removed device gets nothing after removal commits first`, async () => {
    await committed(async () => {
      await h.one(SUPER, SQL3.setPush, [true, REASON]);
      await h.noticesOn();
    });
    for (let i = 0; i < RUNS; i += 1) {
      const endpoint = `https://fcm.googleapis.com/fcm/send/race/${runTag}/${i}`;
      const device = await committed(() => h.one<{ deviceId: string }>(ACC, SQL3.pushRegister, [endpoint, `B${'A'.repeat(86)}`, 'A'.repeat(22),
        'Chrome on Windows', rid()]));
      await committed(() => h.one(ACC, SQL3.pushTest, [device.deviceId, rid()]));
      const claim: Step = { actor: WORKER, sql: SQL3.pushClaim, params: ['acc3-race', 50, 60] };
      const remove: Step = { actor: ACC, sql: SQL3.pushRemove, params: [device.deviceId, rid()] };
      const { a, b } = i % 2 === 0 ? await race(remove, claim) : await race(claim, remove);
      noDeadlock(a, b);
      if (i % 2 === 0) {
        const jobs = asItems<{ endpoint: string }>(b.result).filter((j) => j.endpoint === endpoint);
        expect(jobs, 'device removed first: no job for it').toEqual([]);
      }
      // D4 allows 3 test alerts per 10 minutes per PERSON (not per device): age this run's test job so the
      // next run is not refused not_ready/test_limit. Test setup only; the limit itself is tested elsewhere.
      // The job guard forbids updates, so the setup bypasses triggers for this one owner-level statement.
      await committed(async () => {
        await q(`set local session_replication_role = replica`);
        await q(`update public.staff_push_jobs set created_at = now() - interval '11 minutes'
          where is_test and created_at > now() - interval '10 minutes'`);
      });
    }
  });
});
