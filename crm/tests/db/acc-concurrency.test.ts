import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  assertDatabaseUrlNotOperational,
  claimsFor,
  createTestDb,
  resetActor,
} from '../helpers/db';
import { ACC, ACC2, FLIGHT, FLIGHT_2, FLIGHT_ITEM, HOTEL_ITEM, MANAGER, OWNER, PURCHASE, SQL, TRANSFER_ITEM, accHelpers, dayFrom, rid, today } from './acc-support';

/**
 * Accounts phase contract test plan 12.1-12.3 "Concurrency", Track E, on a
 * REAL local Postgres (TEST_DATABASE_URL). PGlite is a single connection, so
 * the whole file is skipped there (vitest prints the reason: "Accounts phase:
 * real concurrency on local Postgres (skipped on PGlite: one connection)").
 *
 *  (1) Accounts return vs supplier confirmation on the same Deal (4.2 lock
 *      shape): never both with the return accepted after commitment; no deadlock.
 *  (2) Return vs flight_tickets_confirm: no deadlock (tickets alone no longer block).
 *  (3) Two Accounts people match the same record: one wins, the other
 *      version_changed / already_matched (7.1 advisory lock + row version).
 *  (4) Two exports of the same period at once: no record in both exports.
 *  (5) Match vs export of the same record serialize (no lost update).
 *  (6) Two uploads of the same supplier bill: one duplicate_supplier_document.
 *  (8) Track B (20261203000330): an export vs a writer changing a hashed
 *      column of a record in it: the writer waits; afterwards the change is
 *      in the export or the record reads changed since export.
 *  (7) Notices: two commands notifying the same recipients at once -> no
 *      deadlock, no duplicate rows; B -> A -> B reassignment in separate
 *      transactions gives a fresh task_assigned each time.
 *
 * Setup rows are COMMITTED on fresh synthetic Deals (SYN-ACC-<run>-n), never
 * the fixture Deals. afterAll removes every row of those Deals as the local
 * table owner with triggers off (session_replication_role = replica,
 * test-only, local), the run's exports, memberships and audit rows, and
 * restores the switches.
 */

const url = process.env.TEST_DATABASE_URL;
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();

let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let monitor: pg.Client;
let c2Pid = 0;
let auditStart = '0';
let exportStart = new Date(0).toISOString();
let switches: Record<string, unknown> = {};
let settingsRow = false;
let exportWasOn = false;
/** Accounts phase 2 (Track F, 12.6 setup): exact restore of shared rows the committed steps touch outside the run's Deals. */
const COUNTER_TABLES = ['finance_receipt_counters', 'tally_export_counters', 'customer_refund_counters', 'supplier_payment_counters'];
const countersBefore: Record<string, Array<Record<string, unknown>>> = {};
let settingsBefore: Array<Record<string, unknown>> = [];
let noticeSeqStart = '0';
const addedMemberships: string[] = [];
const dealIds: string[] = [];
let seq = 0;

const h = accHelpers(() => db);

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
  auditStart = (await db.query<{ m: string }>('select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
  exportStart = (await db.query<{ t: string }>('select now()::text as t'))[0]!.t;
  noticeSeqStart = (await db.query<{ m: string }>('select coalesce(max(seq), 0)::text as m from public.staff_notices'))[0]!.m;
  for (const t of COUNTER_TABLES) countersBefore[t] = await db.query(`select * from public.${t}`);
  settingsBefore = await db.query('select * from public.accounts_settings');
  switches = (await db.query<Record<string, unknown>>(
    `select w.service_items_enabled, w.visa_passport_tasks_enabled, n.notices_enabled
     from public.workflow_settings w, public.notice_settings n where w.id and n.id`))[0]!;
  for (const [user, role, branch] of [[U.movedStaff, 'flight', 'JDH'], [U.salesAhmedabad, 'flight', 'JDH'], [U.visaJodhpur, 'accounts', 'JDH']]) {
    const rows = await db.query<{ id: string }>(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $3 on conflict do nothing returning id`, [user, role, branch]);
    addedMemberships.push(...rows.map((r) => r.id));
  }
  await db.query('update public.notice_settings set notices_enabled = true where id');
  const entity = (await db.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  settingsRow = (await db.query<{ n: number }>('select count(*)::int as n from public.accounts_settings where legal_entity_id = $1', [entity]))[0]!.n > 0;
  exportWasOn = (await db.query<{ on: boolean }>('select tally_export_enabled as on from public.accounts_settings where legal_entity_id = $1', [entity]))[0]?.on ?? false;
  await committed(() => h.one({ userId: U.adminJodhpur }, SQL.setTallyExport, [entity, true, 'Synthetic: accounts concurrency suite (local stack)']));
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

async function cleanup(): Promise<void> {
  await db.exec('begin');
  try {
    await db.exec('set local session_replication_role = replica');
    const swept = await db.query<{ id: string }>(`select id from public.deals where reference like 'SYN-ACC-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    // Exports of this run, and any left by an interrupted earlier run on SYN-ACC Deals.
    const exports = (await db.query<{ id: string }>(
      `select id from public.tally_exports where created_at >= $1::timestamptz
       union select l.export_id from public.tally_export_lines l join public.tally_records t on t.id = l.tally_record_id
       join public.deals d on d.id = t.deal_id where d.reference like 'SYN-ACC-%'`, [exportStart])).map((r) => r.id);
    if (exports.length) {
      await db.query('delete from public.tally_export_lines where export_id = any($1::uuid[])', [exports]);
      // tally_records rows that point at these exports belong to the run's Deals: removed with them (no update: row checks).
      await db.query('delete from public.tally_records where last_export_id = any($1::uuid[])', [exports]);
      await db.query('delete from public.tally_exports where id = any($1::uuid[])', [exports]);
    }
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await db.query<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const receipts = await ids('select id from public.customer_receipts where deal_id = any($1::uuid[])');
      const entries = await ids('select id from public.finance_journal_entries where deal_id = any($1::uuid[])');
      const docs = await ids('select id from public.supplier_documents where deal_id = any($1::uuid[])');
      const payments = await ids('select id from public.supplier_payment_requests where deal_id = any($1::uuid[])');
      const suppliers = (await db.query<{ id: string }>(
        `select distinct q.supplier_id as id from public.purchase_quotes q where q.task_id = any($1::uuid[])
         union select distinct supplier_id from public.flight_ticket_batches where deal_id = any($2::uuid[])`, [tasks, dealIds])).map((r) => r.id);
      // Track B (20261203000310/0320): touches point at the Tally rows removed below.
      await db.query(`delete from public.tally_source_touches where tally_record_id in (select id from public.tally_records where record_id = any($1::uuid[]))`,
        [[...entries, ...docs, ...payments]]);
      await db.query('delete from public.tally_records where record_id = any($1::uuid[])', [[...entries, ...docs, ...payments]]);
      const byColumn: Record<string, string[]> = { deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions,
        service_item_id: items, receipt_id: receipts, payment_request_id: payments, document_id: docs };
      const cols = await db.query<{ t: string; c: string }>(
        `select table_name as t, column_name as c from information_schema.columns
         where table_schema = 'public' and column_name = any($1::text[])
           and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`,
        [Object.keys(byColumn)]);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const { t, c } of cols) {
          const values = byColumn[c]!;
          if (values.length > 0) await db.query(`delete from public.${t} where ${c} = any($1::uuid[])`, [values]);
        }
      }
      if (suppliers.length > 0) {
        const supplierCols = await db.query<{ t: string }>(
          `select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'supplier_id'
             and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
        for (const { t } of supplierCols) await db.query(`delete from public.${t} where supplier_id = any($1::uuid[])`, [suppliers]);
        await db.query('delete from public.suppliers where id = any($1::uuid[])', [suppliers]);
      }
      const all = [...dealIds, ...versions, ...tasks, ...items, ...receipts, ...payments, ...docs, ...suppliers];
      await db.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await db.query('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await db.query(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    if (addedMemberships.length > 0) await db.query('delete from public.memberships where id = any($1::uuid[])', [addedMemberships]);
    await db.query('update public.workflow_settings set service_items_enabled = $1, visa_passport_tasks_enabled = $2 where id',
      [switches.service_items_enabled, switches.visa_passport_tasks_enabled]);
    await db.query('update public.notice_settings set notices_enabled = $1 where id', [switches.notices_enabled]);
    if (!settingsRow) await db.query(`delete from public.accounts_settings where legal_entity_id = (select id from public.legal_entities where code = 'HOLIDAY_CHACHA')`);
    else await db.query(`update public.accounts_settings set tally_export_enabled = $1 where legal_entity_id = (select id from public.legal_entities where code = 'HOLIDAY_CHACHA')`, [exportWasOn]);
    // Exact restore of the settings row, number counters, the run's notices (incl. bank-detail notices with no Deal),
    // the synthetic destinations its receipts added and suppliers no Deal row pointed at any more.
    await db.query('delete from public.accounts_settings');
    for (const row of settingsBefore) {
      const cols = Object.keys(row);
      await db.query(`insert into public.accounts_settings (${cols.join(', ')}) select ${cols.map((c) => `r.${c}`).join(', ')}
        from jsonb_populate_record(null::public.accounts_settings, $1::jsonb) r`, [JSON.stringify(row)]);
    }
    for (const t of COUNTER_TABLES) {
      await db.query(`delete from public.${t}`);
      for (const row of countersBefore[t] ?? []) {
        const cols = Object.keys(row);
        await db.query(`insert into public.${t} (${cols.join(', ')}) select ${cols.map((c) => `r.${c}`).join(', ')}
          from jsonb_populate_record(null::public.${t}, $1::jsonb) r`, [JSON.stringify(row)]);
      }
    }
    await db.query('delete from public.staff_notices where seq > $1::bigint', [noticeSeqStart]);
    const dests = (await db.query<{ id: string }>(`select id from public.company_destinations where created_at >= $1::timestamptz
      and label = 'Synthetic fixture destination'`, [exportStart])).map((r) => r.id);
    if (dests.length) {
      await db.query('update public.company_destinations set current_version_id = null where id = any($1::uuid[])', [dests]);
      await db.query('delete from public.company_destination_versions where destination_id = any($1::uuid[])', [dests]);
      await db.query('delete from public.company_destinations where id = any($1::uuid[])', [dests]);
    }
    const strays = (await db.query<{ id: string }>('select id from public.suppliers where created_at >= $1::timestamptz', [exportStart])).map((r) => r.id);
    if (strays.length) {
      const supplierCols = await db.query<{ t: string }>(`select table_name as t from information_schema.columns where table_schema = 'public'
        and column_name = 'supplier_id' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
      for (const { t } of supplierCols) await db.query(`delete from public.${t} where supplier_id = any($1::uuid[])`, [strays]);
      await db.query('delete from public.suppliers where id = any($1::uuid[])', [strays]);
    }
    await db.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
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
     select b.legal_entity_id, b.id, $1, 'Synthetic accounts concurrency deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-ACC-${runTag}-${seq}`, U.salesDelhiA]);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
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

/** Committed: hotel (+ flight) booking on a fresh Deal, approved, money, hotel costed with the go-ahead. */
async function hotelReady(withFlight = false) {
  return committed(async () => {
    const deal = await freshDeal();
    const b = await h.book(withFlight ? [HOTEL_ITEM, FLIGHT_ITEM] : [HOTEL_ITEM], { deal });
    await h.approve(b.versionId);
    await h.receipt(deal, '30000000');
    const task = h.taskOf(b, 'hotel');
    const supplierId = await h.purchaseSupplier();
    await h.purchaseCost(task, supplierId);
    await h.goAhead(task);
    const ev = await h.one<{ evidenceId: string; objectPath: string }>(PURCHASE, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
      [task, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, 'e'.repeat(64)]);
    await q(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
    await h.one(PURCHASE, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
    return { deal, b, task, supplierId };
  });
}
/** Committed: a verified receipt's journal entry on a fresh Deal. */
async function readyEntries(n = 1) {
  return committed(async () => {
    const deal = await freshDeal();
    const b = await h.book([HOTEL_ITEM], { deal });
    await h.approve(b.versionId);
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push((await h.entryOf((await h.receipt(deal, String(100000 + i))).id))!);
    return { deal, entries: out };
  });
}
const exportFields = async () => JSON.stringify({ entityId: await h.entityId(), from: dayFrom(-30), to: today(), kinds: ['journal_entry'], includeExported: false });

describe.skipIf(!url)('Accounts phase: real concurrency on local Postgres (skipped on PGlite: one connection)', () => {
  it('(1) return vs supplier confirmation: never a return accepted after commitment; no deadlock', async () => {
    for (const order of ['return-first', 'confirm-first'] as const) {
      const r = await hotelReady();
      const ret: Step = { actor: ACC, sql: SQL.reviewReturn, params: [r.b.versionId, 'Synthetic return during confirmation', rid()] };
      const conf: Step = { actor: PURCHASE, sql: SQL.supplierConfirm, params: [r.task, 1, 'SYN-CONF-RACE'] };
      const { a, b } = order === 'return-first' ? await race(ret, conf) : await race(conf, ret);
      noDeadlock(a, b);
      const [review] = await q<{ status: string }>('select status from public.accounts_booking_reviews where booking_version_id = $1', [r.b.versionId]);
      const [task] = await q<{ status: string }>('select status from public.fulfilment_tasks where id = $1', [r.task]);
      if (order === 'confirm-first') {
        expect(a.ok, a.error).toBe(true);
        expect(b).toMatchObject({ ok: false, error: 'review_return_committed' });
        expect(review!.status).not.toBe('returned');
      } else {
        expect(a.ok, a.error).toBe(true);
        expect(review!.status).toBe('returned');
        // The confirm then proceeds on a returned review or is refused by its own rules, never a deadlock.
        if (b.ok) expect(task!.status).toBe('supplier_confirmed');
      }
    }
  });

  it('(2) return vs Flight ticket confirmation: no deadlock', async () => {
    const r = await hotelReady(true);
    const flight = await committed(async () => {
      await h.claim(FLIGHT, r.deal);
      const ft = (await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [r.deal]))[0]!.id;
      const [leg] = await h.sectors(ft);
      const supplierId = await h.flightSupplier();
      await h.approvedBank(supplierId);
      return { leg: leg!.id, supplierId };
    });
    const tickets: Step = { actor: FLIGHT, sql: 'select public.flight_tickets_confirm($1, $2::jsonb, $3) as r', params: [r.deal, JSON.stringify({
      sectorIds: [flight.leg], supplierId: flight.supplierId, fareApprovalId: null,
      fares: [{ paxType: 'adult', basicPaise: '500000', kPaise: '50000', yqPaise: '30000', yrPaise: '10000', otherPaise: '10000' }],
      travellers: [{ seq: 1, crsType: 'amadeus', crsPnr: null, airlinePnr: `R${runTag.slice(0, 5)}`, ticketNumber: '098-2410399991' }] }), rid()] };
    const ret: Step = { actor: ACC, sql: SQL.reviewReturn, params: [r.b.versionId, 'Synthetic return during ticketing', rid()] };
    const { a, b } = await race(tickets, ret);
    noDeadlock(a, b);
  });

  it('(3) two Accounts people match the same record: one wins', async () => {
    const { entries } = await readyEntries();
    const step = (actor: Actor, ref: string): Step => ({ actor, sql: SQL.match,
      params: ['journal_entry', entries[0], 0, JSON.stringify({ voucherRef: ref, voucherDate: today() }), rid()] });
    const { a, b, secondWaited } = await race(step(ACC, 'SYN-A'), step(ACC2, 'SYN-B'));
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/^(version_changed|already_matched)$/);
    expect(secondWaited, 'the advisory lock serializes the two').toBe(true);
    expect(await q('select voucher_ref, row_version from public.tally_records where record_id = $1', [entries[0]])).toEqual([{ voucher_ref: 'SYN-A', row_version: 1 }]);
  });

  it('(4) two exports at once: no record exported twice', async () => {
    await readyEntries(3);
    const step = async (actor: Actor): Promise<Step> => ({ actor, sql: SQL.exportCreate, params: [await exportFields(), rid()] });
    const { a, b } = await race(await step(ACC), await step(ACC2));
    noDeadlock(a, b);
    expect(a.ok, a.error).toBe(true);
    if (!b.ok) expect(b.error).toBe('nothing_to_export');
    const dup = await q<{ n: number }>(`select count(*)::int as n from (select record_id from public.tally_export_lines l join public.tally_exports e on e.id = l.export_id
      where e.created_at >= $1::timestamptz group by record_id having count(*) > 1) d`, [exportStart]);
    expect(dup).toEqual([{ n: 0 }]);
  });

  it('(5) match vs export of the same record serialize', async () => {
    const { entries } = await readyEntries();
    const match: Step = { actor: ACC2, sql: SQL.match, params: ['journal_entry', entries[0], 0, JSON.stringify({ voucherRef: 'SYN-M', voucherDate: today() }), rid()] };
    const { a, b } = await race({ actor: ACC, sql: SQL.exportCreate, params: [await exportFields(), rid()] }, match);
    noDeadlock(a, b);
    const [row] = await q<{ status: string; export_count: number }>('select status, export_count from public.tally_records where record_id = $1', [entries[0]]);
    if (a.ok) {
      expect(row!.export_count).toBeGreaterThanOrEqual(1);
      expect(b.ok ? row!.status : 'exported').toMatch(/^(exported|matched)$/);
      if (b.ok) expect(row!.status).toBe('matched');
    }
  });

  it('(6) two uploads of the same supplier bill: one duplicate_supplier_document', async () => {
    const r1 = await hotelReady();
    const r2 = await committed(async () => {
      const deal = await freshDeal();
      const b = await h.book([HOTEL_ITEM], { deal });
      await h.approve(b.versionId);
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, r1.supplierId);
      return { task };
    });
    const files = await committed(async () => [await h.moneyFile(PURCHASE, r1.task, 'invoice'), await h.moneyFile(PURCHASE, r2.task, 'invoice')]);
    const up = (task: string, ev: string): Step => ({ actor: PURCHASE, sql: SQL.docUpload, params: [task, JSON.stringify({ kind: 'invoice',
      number: `SYN-RACE-${runTag}`, docDate: today(), totalPaise: '100000', gstIncluded: true, evidenceId: ev }), rid()] });
    const { a, b } = await race(up(r1.task, files[0]!), up(r2.task, files[1]!));
    expect(a.ok, a.error).toBe(true);
    expect(b).toMatchObject({ ok: false, error: 'duplicate_supplier_document' });
  });

  it('(7) concurrent claims notify Accounts once each; reassignment B -> A -> B gives fresh notices', async () => {
    const r = await hotelReady(true);
    const claimStep = async (): Promise<Step> => ({ actor: OWNER, sql: 'select public.payment_claim_report($1, $2::jsonb, $3) as r',
      params: [r.deal, JSON.stringify(await committed(() => h.cl.bankClaim({ amountPaise: '100000' }, r.deal))), rid()] });
    const { a, b } = await race(await claimStep(), await claimStep());
    noDeadlock(a, b);
    expect(a.ok && b.ok).toBe(true);
    const rows = await q<{ recipient_user_id: string; n: number }>(`select recipient_user_id, count(*)::int as n from public.staff_notices
      where kind = 'payment_reported' and deal_id = $1 group by 1 order by 1`, [r.deal]);
    // Every recipient exactly once per claim (no duplicates). Other Accounts staff (speed seed, journeys) may also
    // be recipients on a shared stack; the two fixture Accounts people must be among them.
    expect(rows.map((x) => x.n)).toEqual(rows.map(() => 2));
    expect(rows.map((x) => x.recipient_user_id)).toEqual(expect.arrayContaining([U.accountsJodhpur, U.visaJodhpur]));
    expect(rows.map((x) => x.recipient_user_id)).not.toContain(U.salesDelhiA);
    await committed(() => h.claim(FLIGHT, r.deal));
    for (const [from, to] of [[U.movedStaff, U.salesAhmedabad], [U.salesAhmedabad, U.movedStaff], [U.movedStaff, U.salesAhmedabad]]) {
      await committed(() => h.one(MANAGER, SQL.groupReassign, [r.deal, from, to, 'Synthetic: covering for leave', rid()]));
    }
    const assigned = await q<{ n: number }>(`select count(*)::int as n from public.staff_notices where kind = 'task_assigned' and deal_id = $1 and recipient_user_id = $2`,
      [r.deal, FLIGHT_2.userId]);
    expect(assigned[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('(8) export vs a writer changing a hashed column: the writer waits; the change is exported or flagged', async () => {
    const r = await committed(async () => {
      const deal = await freshDeal();
      const b = await h.book([HOTEL_ITEM, TRANSFER_ITEM], { deal });
      await h.approve(b.versionId);
      const hotel = h.taskOf(b, 'hotel');
      const transfer = h.taskOf(b, 'transfer');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(hotel, supplierId);
      await h.purchaseCost(transfer, supplierId);
      const doc = await h.uploadDoc(hotel, { number: `SYN-RACE-${runTag}` });
      await h.reviewDoc(doc.id, 'accept', null, ACC2);
      return { doc, transfer };
    });
    const entity = await h.entityId();
    const exportStep: Step = { actor: ACC, sql: SQL.exportCreate, params: [JSON.stringify({ entityId: entity, from: dayFrom(-30), to: today(),
      kinds: ['supplier_document'], includeExported: false }), rid()] };
    // Linking the bill to another task changes its "Linked tasks" value (a hashed input).
    const linkStep: Step = { actor: ACC2, sql: 'select public.supplier_document_link_task($1, $2, $3) as r', params: [r.doc.id, r.transfer, rid()] };
    const { a, b, secondWaited } = await race(exportStep, linkStep);
    noDeadlock(a, b);
    expect(a.ok, a.error).toBe(true);
    expect(b.ok, b.error).toBe(true);
    expect(secondWaited, 'the writer waits for the export (shared vs exclusive entity lock)').toBe(true);
    const exportId = (a.result as { exportId: string }).exportId;
    const [line] = await q<{ linked: string | null }>(`select l."values" ->> 'linkedTasks' as linked from public.tally_export_lines l
      where l.export_id = $1 and l.record_id = $2`, [exportId, r.doc.id]);
    const [flag] = await q<{ changed: boolean }>(`select $1::uuid = any(authz.tally_changed_ids(array[$2::uuid])) as changed`, [r.doc.id, entity]);
    expect(line, 'the bill was in the running export').toBeDefined();
    expect(line!.linked === '1' || flag!.changed, 'the link is in the CSV or the bill reads changed since export').toBe(true);
  });
});
