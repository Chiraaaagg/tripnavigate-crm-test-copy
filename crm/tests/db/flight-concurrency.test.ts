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
} from '../helpers/db';
import {
  ACC2, FLIGHT, FLIGHT_2, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, OWNER, SQL, changeSector, confirmFields, fare, flightHelpers, nextTicket, rid,
  ticketFor, typedFlight,
} from './flight-support';

/**
 * Flight build, test plan 12.1 "Concurrency": the eleven races of the
 * contract, on a REAL local Postgres (TEST_DATABASE_URL). PGlite is a single
 * connection, so the whole file is skipped there (reason printed by vitest:
 * "Flight build: real concurrency on local Postgres").
 *
 * Each race opens two connections acting as (possibly different) users. The
 * first runs its command inside an open transaction and holds what it
 * locked; the second starts meanwhile; then the first commits and the
 * second finishes. A command that checks-then-writes without the group lock
 * (authz.flight_lock_group) or the finance lock decides on a stale snapshot,
 * which is exactly what these tests catch.
 *
 * Setup rows are COMMITTED, on fresh synthetic Deals (SYN-FCC-<run>-n), never
 * the fixture Deals. afterAll deletes every row of those Deals as the local
 * table owner with triggers off (session_replication_role = replica,
 * test-only, local), removes the temporary memberships, restores the
 * service-items switch and deletes every audit row the run committed.
 *
 * Synthetic actors as in flight-support.ts (FLIGHT, FLIGHT_2, MANAGER,
 * OWNER, ACC, ACC2 with a temporary Accounts membership).
 */

const url = process.env.TEST_DATABASE_URL;
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();

let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let monitor: pg.Client;
let c2Pid = 0;
let originalSwitch = false;
let auditStart = '0';
const addedMemberships: string[] = [];
const dealIds: string[] = [];
let seq = 0;

const h = flightHelpers(() => db);

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
  originalSwitch = (await db.query<{ on: boolean }>('select service_items_enabled as on from public.workflow_settings where id'))[0]!.on;
  for (const [user, role, branch] of [[U.movedStaff, 'flight', 'JDH'], [U.salesAhmedabad, 'flight', 'JDH'], [U.visaJodhpur, 'accounts', 'JDH']]) {
    const rows = await db.query<{ id: string }>(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $3 on conflict do nothing returning id`, [user, role, branch]);
    addedMemberships.push(...rows.map((r) => r.id));
  }
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
    const swept = await db.query<{ id: string }>(`select id from public.deals where reference like 'SYN-FCC-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await db.query<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const batches = await ids('select id from public.flight_ticket_batches where deal_id = any($1::uuid[])');
      // Suppliers of the run's batches AND every supplier ready() created by name (most races never confirm a batch);
      // also those an interrupted earlier run left behind. Otherwise active flight suppliers with approved bank
      // revisions stay and inflate later counts (e.g. the Manager's requestsToApprove in b1-counts-progress).
      const suppliers = await db.query<{ id: string }>(
        `select distinct supplier_id as id from public.flight_ticket_batches where deal_id = any($1::uuid[])
         union select id from public.suppliers where name like 'Synthetic Concurrency Air %'`, [dealIds]).then((r) => r.map((x) => x.id));
      const payments = await ids('select id from public.supplier_payment_requests where deal_id = any($1::uuid[])');
      const byColumn: Record<string, string[]> = {
        deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions, service_item_id: items, batch_id: batches,
        flight_batch_id: batches, payment_request_id: payments,
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
      if (suppliers.length > 0) {
        const supplierCols = await db.query<{ t: string }>(
          `select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'supplier_id'
             and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
        for (const { t } of supplierCols) await db.query(`delete from public.${t} where supplier_id = any($1::uuid[])`, [suppliers]);
        await db.query('delete from public.suppliers where id = any($1::uuid[])', [suppliers]);
      }
      const all = [...dealIds, ...versions, ...tasks, ...items, ...batches, ...payments, ...suppliers];
      await db.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await db.query('delete from public.audit_events where target_id = any($1::uuid[])', [all]);
      await db.query('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await db.query(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    if (addedMemberships.length > 0) await db.query('delete from public.memberships where id = any($1::uuid[])', [addedMemberships]);
    await db.query('update public.workflow_settings set service_items_enabled = $1 where id', [originalSwitch]);
    await db.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

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

async function freshDeal(): Promise<string> {
  seq += 1;
  const [deal] = await db.query<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic flight concurrency deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-FCC-${runTag}-${seq}`, U.salesDelhiA]);
  dealIds.push(deal!.id);
  return deal!.id;
}

type Ready = { dealId: string; tasks: string[]; legs: string[]; supplierId: string; versionId: string; itemId: string };
/** Committed: a package Deal (hotel + typed JDH-DEL-GOI), optionally taken by FLIGHT, with a flight supplier. */
async function ready(opts: { take?: boolean; budget?: string; kind?: 'package' | 'flight_only' } = {}): Promise<Ready> {
  return committed(async () => {
    const dealId = await freshDeal();
    const flights = [{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]), budget: opts.budget ?? '99999999' }];
    const b = opts.kind === 'flight_only' ? await h.flightOnlyDeal(flights, { deal: dealId }) : await h.packageDeal(flights, { deal: dealId });
    let legs: string[] = [];
    if (opts.take ?? true) {
      await h.claim(FLIGHT, dealId);
      legs = (await h.sectors(b.flightTasks[0]!)).map((s) => s.id);
    }
    const supplierId = await h.flightSupplier(FLIGHT, `Synthetic Concurrency Air ${runTag}-${seq}`);
    await h.approvedBank(supplierId);
    return { dealId, tasks: b.flightTasks, legs, supplierId, versionId: b.versionId, itemId: b.flightItems[0]! };
  });
}

// ---------------------------------------------------------------------------
// Racing (same harness as purchase-concurrency.test.ts)
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
  if (process.env.DEBUG_FLIGHT_RACE) console.info(`race: waited=${secondWaited} a=${a.ok ? 'ok' : a.error} b=${b.ok ? 'ok' : b.error}`);
  return { a, b, secondWaited };
}

const ADULT = [fare('adult')];
const confirmStep = (r: Ready, seqs: number[], sectorIds = r.legs, over: { ticketNumber?: string; fareApprovalId?: string | null; fares?: ReturnType<typeof fare>[] } = {}): Step => ({
  actor: FLIGHT, sql: SQL.ticketsConfirm, params: [r.dealId, confirmFields({ sectorIds, supplierId: r.supplierId, fareApprovalId: over.fareApprovalId ?? null,
    fares: over.fares ?? ADULT, travellers: seqs.map((s) => ticketFor(s, over.ticketNumber ? { ticketNumber: over.ticketNumber } : {})) }), rid()],
});
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);

describe.skipIf(!url)('Flight build: real concurrency on local Postgres', () => {
  it('(1) two Flight people take the same Deal at once: one wins, the other task_conflict', async () => {
    const r = await ready({ take: false });
    const { a, b } = await race({ actor: FLIGHT, sql: SQL.groupClaim, params: [r.dealId, rid()] },
      { actor: FLIGHT_2, sql: SQL.groupClaim, params: [r.dealId, rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('task_conflict');
    const rows = await q<{ assignee_user_id: string }>('select distinct assignee_user_id from public.fulfilment_tasks where deal_id = $1 and department = $2', [r.dealId, 'flight']);
    expect(rows).toEqual([{ assignee_user_id: U.movedStaff }]);
    expect(await q('select count(*)::int as n from public.flight_sectors where deal_id = $1', [r.dealId])).toEqual([{ n: 2 }]);
  });

  it('(2) claim racing a Manager reassign: one consistent assignee and Deal assignment', async () => {
    const r = await ready({ take: false });
    const { a } = await race({ actor: FLIGHT, sql: SQL.groupClaim, params: [r.dealId, rid()] },
      { actor: MANAGER, sql: SQL.groupReassign, params: [r.dealId, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()] });
    expect(a.ok, a.error).toBe(true);
    const assignees = await q<{ a: string }>(`select distinct assignee_user_id::text as a from public.fulfilment_tasks
      where deal_id = $1 and department = 'flight' and status = 'in_progress'`, [r.dealId]);
    expect(assignees).toHaveLength(1);
    const open = await q<{ u: string }>(`select user_id::text as u from public.deal_assignments where deal_id = $1 and assignment_kind = 'flight' and ended_at is null`, [r.dealId]);
    expect(open.map((o) => o.u)).toEqual([assignees[0]!.a]);
  });

  it('(3) two confirms for the same traveller and sector: one wins, the other already_confirmed', async () => {
    const r = await ready();
    const { a, b } = await race(confirmStep(r, [1], [r.legs[0]!]), confirmStep(r, [1], [r.legs[0]!]));
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('already_confirmed');
    expect(await q('select count(*)::int as n from public.flight_ticket_revisions where sector_id = $1 and traveller_seq = 1', [r.legs[0]])).toEqual([{ n: 1 }]);
  });

  it('(4) the same ticket number on two Deals at once: one ticket_number_taken', async () => {
    const r1 = await ready();
    const r2 = await ready();
    const n = nextTicket('555');
    const { a, b } = await race(confirmStep(r1, [1], [r1.legs[0]!], { ticketNumber: n }), confirmStep(r2, [1], [r2.legs[0]!], { ticketNumber: n }));
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('ticket_number_taken');
    expect(await q(`select count(*)::int as n from public.flight_ticket_numbers where ticket_digits = $1`, [n.replace(/-/g, '')])).toEqual([{ n: 1 }]);
  });

  it('(5) approve and reject one change at once: one already_decided (or version_changed)', async () => {
    const r = await ready();
    const change = await committed(async () => h.one<{ changeId: string }>(FLIGHT, SQL.changeSubmit, [r.tasks[0], JSON.stringify({ kind: 'alternative',
      fromSectorIds: [r.legs[0]], travellerSeqs: [1], remark: 'Synthetic: evening flight', sectors: [changeSector({ from: 'JDH', to: 'DEL',
        departDate: '2026-12-10', departTime: '18:20', arriveTime: '19:35', flightNo: 'AI 472', airline: 'Air India' })] }), rid()]));
    const [row] = await q<{ row_version: number }>('select row_version from public.flight_changes where id = $1', [change.changeId]);
    const { a, b } = await race(
      { actor: OWNER, sql: SQL.changeDecide, params: [change.changeId, 'approve', null, row!.row_version, rid()] },
      { actor: OWNER, sql: SQL.changeDecide, params: [change.changeId, 'reject', 'Synthetic: the customer said no', row!.row_version, rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/^(already_decided|version_changed)$/);
    expect(await q('select status from public.flight_changes where id = $1', [change.changeId])).toEqual([{ status: 'approved' }]);
  });

  it('(6) change approve racing a booking change apply: consistent end state, no orphan holds', async () => {
    const r = await ready();
    const change = await committed(async () => h.one<{ changeId: string }>(FLIGHT, SQL.changeSubmit, [r.tasks[0], JSON.stringify({ kind: 'alternative',
      fromSectorIds: [r.legs[1]], travellerSeqs: [2], remark: 'Synthetic: later connection', sectors: [changeSector({ from: 'DEL', to: 'GOI',
        departDate: '2026-12-10', departTime: '19:00', arriveTime: '21:20', flightNo: 'AI 889', airline: 'Air India' })] }), rid()]));
    const v2 = await committed(async () => h.revise(r.versionId, async (v, rv) => h.saveFlightFacts(OWNER, r.itemId, v, rv,
      typedFlight([LEG_JDH_DEL, { ...LEG_DEL_GOI, flightNo: 'AI 885' }])), { deal: r.dealId }));
    const [row] = await q<{ row_version: number }>('select row_version from public.flight_changes where id = $1', [change.changeId]);
    const { a, b } = await race(
      { actor: FLIGHT, sql: SQL.changeApply, params: [r.tasks[0], r.versionId, v2, rid()] },
      { actor: OWNER, sql: SQL.changeDecide, params: [change.changeId, 'approve', null, row!.row_version, rid()] });
    expect(a.ok, a.error).toBe(true);
    // The approval is either refused (version_changed / already_decided, change superseded) or came first: never both effects half-applied.
    const [c] = await q<{ status: string }>('select status from public.flight_changes where id = $1', [change.changeId]);
    if (!b.ok) expect(b.error).toMatch(/^(version_changed|already_decided)$/);
    expect(['superseded', 'approved']).toContain(c!.status);
    expect(await q(`select count(*)::int as n from public.flight_sector_passengers p join public.flight_changes ch on ch.id = p.held_by_change_id
      where p.deal_id = $1 and p.ended_at is null and ch.status <> 'pending'`, [r.dealId])).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from public.flight_sectors where deal_id = $1 and status = 'pending'`, [r.dealId])).toEqual([{ n: 0 }]);
  });

  it('(7) direct payment and payment request on the same (Deal, supplier) at once (INR 30,000 each): the rule holds in both orders', async () => {
    const twoBatches = async () => {
      const r = await ready();
      return committed(async () => {
        const make = async (s: number) => (await h.one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [r.dealId, confirmFields({ sectorIds: [r.legs[0]!],
          supplierId: r.supplierId, fares: [fare('adult', { basicPaise: '2900000' })], travellers: [ticketFor(s)] }), rid()])).batchId;
        const x = await make(1);
        const y = await make(2);
        const { t } = (await q<{ t: string }>('select cost_task_id as t from public.flight_ticket_batches where id = $1', [x]))[0]!;
        return { r, x, y, proof: await h.evidence(FLIGHT, t!, 'direct_payment_proof') };
      });
    };
    const direct = (batch: string, proof: string): Step => ({ actor: FLIGHT, sql: SQL.directPayment, params: [batch, null, JSON.stringify({
      paymentMode: 'card', paidOn: istBusinessDate(), reference: null, proofEvidenceId: proof }), rid()] });
    const request = (batch: string): Step => ({ actor: FLIGHT, sql: SQL.paymentRequest, params: [batch,
      JSON.stringify({ dueDate: istBusinessDate(), note: null, proformaEvidenceId: null }), rid()] });
    // Direct first: the request must see it and route to the Manager.
    const one = await twoBatches();
    const o1 = await race(direct(one.x, one.proof), request(one.y));
    expect(o1.a.ok, o1.a.error).toBe(true);
    expect(o1.b.ok, o1.b.error).toBe(true);
    expect((await q<{ route: string }>('select route from public.supplier_payment_requests where flight_batch_id = $1', [one.y]))[0]!.route).toBe('manager');
    // Request first: the direct payment must see it and be refused.
    const two = await twoBatches();
    const o2 = await race(request(two.y), direct(two.x, two.proof));
    expect(o2.a.ok, o2.a.error).toBe(true);
    expect(o2.b.ok).toBe(false);
    expect(o2.b.error).toBe('direct_payment_over_limit');
  });

  it('(8) confirm with an approval racing a second batch: fare_approval_mismatch', async () => {
    const r = await ready({ budget: '2000000' });
    const big = fare('adult', { basicPaise: '2000000' }); // 2,100,000: over budget alone
    const approvalId = await committed(async () => {
      await h.one(FLIGHT, SQL.fareApprovalRequest, [r.dealId, JSON.stringify({ sectorIds: [r.legs[0]], supplierId: r.supplierId, fares: [big],
        travellers: [{ seq: 1 }] }), rid()]);
      const [a] = await q<{ id: string; row_version: number }>(`select id, row_version from public.flight_fare_approvals where deal_id = $1 and status = 'pending'`, [r.dealId]);
      await h.one(MANAGER, SQL.fareApprovalDecide, [a!.id, 'approve', null, a!.row_version, rid()]);
      return a!.id;
    });
    const { a, b } = await race(confirmStep(r, [2], [r.legs[0]!]), confirmStep(r, [1], [r.legs[0]!], { fareApprovalId: approvalId, fares: [big] }));
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('fare_approval_mismatch');
  });

  it('(9) mark done racing a change submit: one wins', async () => {
    const r = await ready();
    await committed(async () => {
      await h.one(FLIGHT, SQL.ticketsConfirm, [r.dealId, confirmFields({ sectorIds: r.legs, supplierId: r.supplierId,
        fares: [fare('adult'), fare('child')], travellers: [1, 2, 3, 4].map((s) => ticketFor(s)) }), rid()]);
      const [batch] = await q<{ id: string }>('select id from public.flight_ticket_batches where deal_id = $1', [r.dealId]);
      await h.directPay(batch!.id);
      await h.evidence(FLIGHT, r.tasks[0]!, 'e_ticket');
    });
    const { a, b } = await race(
      { actor: FLIGHT, sql: SQL.groupComplete, params: [r.dealId, r.tasks, rid()] },
      { actor: FLIGHT, sql: SQL.changeSubmit, params: [r.tasks[0], JSON.stringify({ kind: 'added_extra', fromSectorIds: [], travellerSeqs: [1],
        remark: 'Synthetic: extra journey', sectors: [changeSector()] }), rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(await q(`select count(*)::int as n from public.flight_changes where deal_id = $1`, [r.dealId])).toEqual([{ n: 0 }]);
    void ACC2;
  });

  it('(10) two corrections with the same expected revision: one version_changed', async () => {
    const r = await ready();
    const t = ticketFor(1);
    await committed(async () => {
      await h.one(FLIGHT, SQL.ticketsConfirm, [r.dealId, confirmFields({ sectorIds: [r.legs[0]!], supplierId: r.supplierId, fares: ADULT, travellers: [t] }), rid()]);
    });
    const fields = (n: string) => JSON.stringify({ crsType: t.crsType, crsPnr: t.crsPnr, airlinePnr: t.airlinePnr, ticketNumber: n });
    const { a, b } = await race(
      { actor: FLIGHT, sql: SQL.ticketCorrect, params: [r.legs[0], 1, 1, fields(nextTicket('556')), 'Synthetic: reissued ticket one', rid()] },
      { actor: MANAGER, sql: SQL.ticketCorrect, params: [r.legs[0], 1, 1, fields(nextTicket('557')), 'Synthetic: reissued ticket two', rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('version_changed');
    expect(await q('select max(revision_no)::int as n from public.flight_ticket_revisions where sector_id = $1 and traveller_seq = 1', [r.legs[0]])).toEqual([{ n: 2 }]);
  });

  it('(11) the same request id twice at once: one effect', async () => {
    const r = await ready();
    const step = confirmStep(r, [1, 2], r.legs);
    const { a, b } = await race(step, step);
    expect(a.ok, a.error).toBe(true);
    if (!b.ok) expect(b.error).toMatch(/^(duplicate_request|already_confirmed)$/);
    else expect((b.result as { batchId: string }).batchId).toBe((a.result as { batchId: string }).batchId);
    expect(await q('select count(*)::int as n from public.flight_ticket_batches where deal_id = $1', [r.dealId])).toEqual([{ n: 1 }]);
  });
});
