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
import { ACC, OWNER, SQL, STICKER, VISA_A, VISA_B, line, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build, test plan 12.1 "Concurrency" (1)-(9), on a REAL local Postgres
 * (TEST_DATABASE_URL). PGlite is a single connection, so the whole file is
 * skipped there (reason printed by vitest: "Visa build: real concurrency on
 * local Postgres").
 *
 * Each race opens two connections acting as (possibly different) users. The
 * first runs its command inside an open transaction and holds what it
 * locked; the second starts meanwhile; then the first commits and the second
 * finishes. Lock order of section 5.7: task row, then applications by id;
 * fee commands take the Deal finance lock first.
 *
 * Setup rows are COMMITTED, on fresh synthetic Deals (SYN-VCC-<run>-n), never
 * the fixture Deals. afterAll deletes every row of those Deals as the local
 * table owner with triggers off (session_replication_role = replica,
 * test-only, local), removes the temporary memberships, restores the two
 * switches and deletes every audit row the run committed.
 *
 * Actors as in visa-e-support.ts (VISA_A, VISA_B with a temporary Visa
 * membership, OWNER, ACC).
 */

const url = process.env.TEST_DATABASE_URL;
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();

let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let monitor: pg.Client;
let c2Pid = 0;
let originalSwitches: { s: boolean; v: boolean } = { s: false, v: false };
let auditStart = '0';
const addedMemberships: string[] = [];
const dealIds: string[] = [];
let seq = 0;

const h = visaHelpers(() => db);

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
  const [sw] = await db.query<{ s: boolean; v: boolean }>(
    'select service_items_enabled as s, visa_passport_tasks_enabled as v from public.workflow_settings where id');
  originalSwitches = sw!;
  for (const [user, role, branch] of [[U.movedStaff, 'visa', 'JDH']]) {
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
    const swept = await db.query<{ id: string }>(`select id from public.deals where reference like 'SYN-VCC-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await db.query<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const applications = await ids('select id from public.visa_applications where deal_id = any($1::uuid[])');
      const entries = await ids('select id from public.department_cost_entries where deal_id = any($1::uuid[])');
      const evidence = await ids(`select id from public.department_evidence where task_id in
        (select id from public.fulfilment_tasks where deal_id = any($1::uuid[]))`);
      const notices = await ids('select id from public.visa_result_notices where deal_id = any($1::uuid[])');
      const travellers = await ids('select id from public.deal_travellers where deal_id = any($1::uuid[])');
      const byColumn: Record<string, string[]> = {
        deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions, service_item_id: items, application_id: applications,
        traveller_id: travellers,
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
      // Rows keyed by their own id (in case a table lacks the columns above).
      for (const [table, list] of [['visa_result_notices', notices], ['department_cost_entries', entries], ['department_evidence', evidence],
        ['visa_applications', applications]] as Array<[string, string[]]>) {
        if (list.length > 0) await db.query(`delete from public.${table} where id = any($1::uuid[])`, [list]);
      }
      const all = [...dealIds, ...versions, ...tasks, ...items, ...applications, ...entries, ...evidence, ...notices, ...travellers];
      await db.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await db.query('delete from public.audit_events where target_id = any($1::uuid[])', [all]);
      await db.query('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await db.query(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    if (addedMemberships.length > 0) await db.query('delete from public.memberships where id = any($1::uuid[])', [addedMemberships]);
    await db.query('update public.workflow_settings set service_items_enabled = $1, visa_passport_tasks_enabled = $2 where id',
      [originalSwitches.s, originalSwitches.v]);
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
     select b.legal_entity_id, b.id, $1, 'Synthetic visa concurrency deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-VCC-${runTag}-${seq}`, U.salesDelhiA]);
  dealIds.push(deal!.id);
  return deal!.id;
}

type Ready = { dealId: string; taskId: string; versionId: string; itemId: string };
/** Committed: a sticker visa for the four travellers on a fresh Deal, optionally taken by VISA_A. */
async function ready(opts: { take?: boolean } = {}): Promise<Ready> {
  return committed(async () => {
    const dealId = await freshDeal();
    const b = await h.book({ deal: dealId, items: [{ type: 'visa', facts: STICKER }] });
    if (opts.take ?? true) await h.one(VISA_A, SQL.claim, [b.tasks[0]]);
    return { dealId, taskId: b.tasks[0]!, versionId: b.versionId, itemId: b.itemIds[0]! };
  });
}

// ---------------------------------------------------------------------------
// Racing (same harness as flight-concurrency.test.ts)
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
  if (process.env.DEBUG_VISA_RACE) console.info(`race: waited=${secondWaited} a=${a.ok ? 'ok' : a.error} b=${b.ok ? 'ok' : b.error}`);
  return { a, b, secondWaited };
}

const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
const applyFields = (lines: unknown[], shared: Record<string, unknown> = {}) =>
  JSON.stringify({ applicants: lines, paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: null, remark: null, ...shared });
const appRow = async (id: string) => (await q<{ state: string; row_version: number; removed_at: string | null; closed_at: string | null;
  superseded_at: string | null; handover_method: string | null }>(
  'select state, row_version, removed_at, closed_at, superseded_at, handover_method from public.visa_applications where id = $1', [id]))[0]!;
const notDeadlock = (o: Outcome) => expect(o.error ?? '', 'no deadlock').not.toMatch(/deadlock/i);

describe.skipIf(!url)('Visa build: real concurrency on local Postgres', () => {
  it('(1) two Visa people take the same task at once: one wins, the other task_conflict', async () => {
    const r = await ready({ take: false });
    const { a, b } = await race({ actor: VISA_A, sql: SQL.claim, params: [r.taskId] }, { actor: VISA_B, sql: SQL.claim, params: [r.taskId] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('task_conflict');
    expect(await q('select assignee_user_id from public.fulfilment_tasks where id = $1', [r.taskId])).toEqual([{ assignee_user_id: U.visaJodhpur }]);
    // One current application per participant (the loser created none).
    expect(await q('select count(*)::int as n from public.visa_applications where task_id = $1 and superseded_at is null', [r.taskId])).toEqual([{ n: 4 }]);
  });

  it('(2) two Applied for the same applicant with different request ids: one wins, the other version_changed or wrong_state', async () => {
    const r = await ready();
    const a1 = await committed(() => h.makeReady(r.taskId, 1));
    const step = (ref: string): Step => ({ actor: VISA_A, sql: SQL.apply, params: [r.taskId, applyFields([line(a1, { reference: ref })]), rid()] });
    const { a, b, secondWaited } = await race(step('SYN-VCC-A'), step('SYN-VCC-B'));
    expect(a.ok, a.error).toBe(true);
    expect(secondWaited).toBe(true);
    expect(b.ok).toBe(false);
    expect(['version_changed', 'wrong_state']).toContain(b.error);
    expect(await q(`select count(*)::int as n from public.department_cost_entries where application_id = $1`, [a1.applicationId])).toEqual([{ n: 1 }]);
    expect((await appRow(a1.applicationId)).state).toBe('decision_pending');
  });

  it('(3) the same request id twice in parallel: one effect', async () => {
    const r = await ready();
    const a1 = await committed(() => h.makeReady(r.taskId, 1));
    const req = rid();
    const step: Step = { actor: VISA_A, sql: SQL.apply, params: [r.taskId, applyFields([line(a1, { reference: 'SYN-VCC-SAME' })]), req] };
    const { a, b } = await race(step, step);
    expect(a.ok, a.error).toBe(true);
    // The second replays the stored result, or (if it read the old version first) is refused; never a second effect.
    if (b.ok) expect(b.result).toMatchObject({ outcome: 'existing' });
    else expect(['version_changed', 'wrong_state', 'duplicate_request']).toContain(b.error);
    expect(await q(`select count(*)::int as n from public.department_cost_entries where application_id = $1`, [a1.applicationId])).toEqual([{ n: 1 }]);
    expect(await q(`select count(*)::int as n from public.audit_events where action = 'visa.application_applied' and target_id = $1`, [a1.applicationId]))
      .toEqual([{ n: 1 }]);
  });

  it('(4) clubbed Applied for three vs a row save on one of them: consistent, one refused', async () => {
    const r = await ready();
    const apps = await committed(async () => [await h.makeReady(r.taskId, 1), await h.makeReady(r.taskId, 2), await h.makeReady(r.taskId, 3)]);
    const { a, b } = await race(
      { actor: VISA_A, sql: SQL.apply, params: [r.taskId, applyFields(apps.map((x, i) => line(x, { reference: `SYN-VCC-CLUB-${i}` }))), rid()] },
      { actor: VISA_A, sql: SQL.setRow, params: [apps[1]!.applicationId, apps[1]!.rowVersion, JSON.stringify({ remark: 'Synthetic racing remark' }), rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('version_changed');
    for (const x of apps) expect((await appRow(x.applicationId)).state).toBe('decision_pending');
    expect(await q(`select count(distinct club_id)::int as n, count(*)::int as c from public.visa_applications where task_id = $1 and club_id is not null`,
      [r.taskId])).toEqual([{ n: 1, c: 3 }]);
  });

  it('(4b) the row save first: the clubbed Applied is refused as a whole (nothing saved for any of the three)', async () => {
    const r = await ready();
    const apps = await committed(async () => [await h.makeReady(r.taskId, 1), await h.makeReady(r.taskId, 2), await h.makeReady(r.taskId, 3)]);
    const { a, b } = await race(
      { actor: VISA_A, sql: SQL.setRow, params: [apps[1]!.applicationId, apps[1]!.rowVersion, JSON.stringify({ remark: 'Synthetic racing remark' }), rid()] },
      { actor: VISA_A, sql: SQL.apply, params: [r.taskId, applyFields(apps.map((x, i) => line(x, { reference: `SYN-VCC-CLUB2-${i}` }))), rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('version_changed');
    for (const x of apps) expect((await appRow(x.applicationId)).state).toBe('docs_pending');
    expect(await q('select count(*)::int as n from public.department_cost_entries where task_id = $1', [r.taskId])).toEqual([{ n: 0 }]);
  });

  it('(5) Applied vs a revision confirm removing that applicant: no deadlock, applied and flagged removed', async () => {
    const r = await ready();
    const prep = await committed(async () => {
      const a2 = await h.makeReady(r.taskId, 2);
      await h.one(ACC, SQL.reviewReturn, [r.versionId, 'Synthetic return: traveller two is not going', rid()]);
      const opened = await h.one<{ versionId: string; rowVersion: number }>(OWNER, SQL.openRevision, [r.versionId]);
      const rv = (await h.saveParticipation(OWNER, r.itemId, opened.versionId, opened.rowVersion, [1, 3, 4])).rowVersion;
      await h.one(OWNER, SQL.classify, [opened.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'f'.repeat(64));
      const readiness = await h.readiness(OWNER, opened.versionId);
      expect(readiness.issues).toEqual([]);
      return { a2, revisionId: opened.versionId, hash: readiness.contentHash };
    });
    const { a, b } = await race(
      { actor: VISA_A, sql: SQL.apply, params: [r.taskId, applyFields([line(prep.a2, { reference: 'SYN-VCC-REV' })]), rid()] },
      { actor: OWNER, sql: 'select public.booking_confirm($1, $2) as r', params: [prep.revisionId, prep.hash] });
    notDeadlock(a);
    notDeadlock(b);
    expect(a.ok, a.error).toBe(true);
    expect(b.ok, b.error).toBe(true);
    const row = await appRow(prep.a2.applicationId);
    // Section 7 sync step 3: removed, records kept, state unchanged (applied blocks completion until closed, VL1).
    expect(row.state).toBe('decision_pending');
    expect(row.removed_at).not.toBeNull();
    expect(await q('select status from public.fulfilment_tasks where id = $1', [r.taskId])).toEqual([{ status: 'in_progress' }]);
  });

  it('(5b) the revision confirm first, then Applied for the removed applicant: no deadlock, Applied refused applicant_removed', async () => {
    const r = await ready();
    const prep = await committed(async () => {
      const a2 = await h.makeReady(r.taskId, 2);
      await h.one(ACC, SQL.reviewReturn, [r.versionId, 'Synthetic return: traveller two is not going', rid()]);
      const opened = await h.one<{ versionId: string; rowVersion: number }>(OWNER, SQL.openRevision, [r.versionId]);
      const rv = (await h.saveParticipation(OWNER, r.itemId, opened.versionId, opened.rowVersion, [1, 3, 4])).rowVersion;
      await h.one(OWNER, SQL.classify, [opened.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'e'.repeat(64));
      const readiness = await h.readiness(OWNER, opened.versionId);
      return { a2, revisionId: opened.versionId, hash: readiness.contentHash };
    });
    const { a, b } = await race(
      { actor: OWNER, sql: 'select public.booking_confirm($1, $2) as r', params: [prep.revisionId, prep.hash] },
      { actor: VISA_A, sql: SQL.apply, params: [r.taskId, applyFields([line(prep.a2, { reference: 'SYN-VCC-REV2' })]), rid()] });
    notDeadlock(a);
    notDeadlock(b);
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(['applicant_removed', 'version_changed']).toContain(b.error);
    const row = await appRow(prep.a2.applicationId);
    expect(row.state).toBe('docs_pending');
    expect(row.removed_at).not.toBeNull();
  });

  // Lead review fix (20261202000140 item 3): the revision trigger locks the Deal's not-started and in-progress visa tasks,
  // so a claim racing a revision confirm that removes a traveller sees the removal either way.
  for (const order of ['claim first', 'revision first'] as const) {
    it(`(10) claim racing a revision confirm that removes traveller 2 (${order}): flagged removed, Applied for them refused`, async () => {
      const r = await ready({ take: false });
      const prep = await committed(async () => {
        await h.one(ACC, SQL.reviewReturn, [r.versionId, 'Synthetic return: traveller two is not going', rid()]);
        const opened = await h.one<{ versionId: string; rowVersion: number }>(OWNER, SQL.openRevision, [r.versionId]);
        const rv = (await h.saveParticipation(OWNER, r.itemId, opened.versionId, opened.rowVersion, [1, 3, 4])).rowVersion;
        await h.one(OWNER, SQL.classify, [opened.versionId, rv, 'customer_material']);
        await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', order === 'claim first' ? 'c'.repeat(64) : 'd'.repeat(64));
        const readiness = await h.readiness(OWNER, opened.versionId);
        expect(readiness.issues).toEqual([]);
        return { revisionId: opened.versionId, hash: readiness.contentHash };
      });
      const claim: Step = { actor: VISA_A, sql: SQL.claim, params: [r.taskId] };
      const confirm: Step = { actor: OWNER, sql: 'select public.booking_confirm($1, $2) as r', params: [prep.revisionId, prep.hash] };
      const { a, b } = order === 'claim first' ? await race(claim, confirm) : await race(confirm, claim);
      notDeadlock(a);
      notDeadlock(b);
      expect(a.ok, a.error).toBe(true);
      expect(b.ok, b.error).toBe(true);
      const apps = await q<{ id: string; traveller_seq: number; removed_at: string | null }>(
        'select id, traveller_seq, removed_at from public.visa_applications where task_id = $1 and superseded_at is null order by traveller_seq', [r.taskId]);
      // Seq 2 is either never created (revision first) or flagged removed (claim first); never a live application.
      expect(apps.filter((x) => x.traveller_seq === 2 && x.removed_at === null)).toEqual([]);
      expect(apps.filter((x) => x.removed_at === null).map((x) => x.traveller_seq)).toEqual([1, 3, 4]);
      const two = apps.find((x) => x.traveller_seq === 2);
      if (two) {
        const outcome = await committed(async () => {
          await h.makeReady(r.taskId, 1);
          const ws = (await h.workspace(r.taskId))!;
          const removed = ws.applicants.find((x) => x.applicationId === two.id)!;
          return h.attempt(VISA_A, SQL.apply, [r.taskId, applyFields([line(removed, { reference: `SYN-VCC-RM-${order.length}` })]), rid()]);
        });
        expect(outcome.ok).toBe(false);
        // C5 lists both refusals for a removed applicant (applicant_removed, or not_ready with the "removed" token).
        expect(['applicant_removed', 'not_ready']).toContain(outcome.ok ? '' : outcome.error);
      }
    });
  }

  it('(6) two decisions on one application: one version_changed', async () => {
    const r = await ready();
    const prep = await committed(async () => {
      const a1 = await h.appliedAlone(r.taskId, 1);
      const p1 = await h.evidence(VISA_A, r.taskId, 'authority_outcome', a1.applicationId, 'c'.repeat(64));
      const p2 = await h.evidence(VISA_A, r.taskId, 'authority_outcome', a1.applicationId, 'd'.repeat(64));
      return { a1, p1, p2 };
    });
    const { a, b } = await race(
      { actor: VISA_A, sql: SQL.decide, params: [prep.a1.applicationId, prep.a1.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: prep.p1 }), rid()] },
      { actor: VISA_A, sql: SQL.decide, params: [prep.a1.applicationId, prep.a1.rowVersion, JSON.stringify({ decision: 'rejected', outcomeEvidenceId: prep.p2,
        reason: 'Synthetic racing refusal' }), rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('version_changed');
    expect((await appRow(prep.a1.applicationId)).state).toBe('issued');
    expect(await q('select outcome from public.visa_result_notices where application_id = $1', [prep.a1.applicationId])).toEqual([{ outcome: 'approved' }]);
  });

  it('(7) Fix fee (C12) vs Accounts accept of the same entry: one wins', async () => {
    const r = await ready();
    const prep = await committed(async () => {
      const a1 = await h.makeReady(r.taskId, 1);
      const receipt = await h.evidence(VISA_A, r.taskId, 'fee_receipt', null, 'a'.repeat(64));
      const applied = await h.apply(r.taskId, [line(a1, { reference: 'SYN-VCC-FEE' })], { receiptEvidenceId: receipt });
      const [entry] = await q<{ id: string; row_version: number }>('select id, row_version from public.department_cost_entries where id = any($1::uuid[])',
        [applied.entryIds]);
      // Submitted -> returned by Accounts, so both the fix and (after it) an accept are possible.
      await h.one(ACC, SQL.expenseReturn, [entry!.id, entry!.row_version, 'Synthetic: the amount does not match the receipt', rid()]);
      const [ret] = await q<{ row_version: number }>('select row_version from public.department_cost_entries where id = $1', [entry!.id]);
      return { entryId: entry!.id, rowVersion: ret!.row_version };
    });
    const { a, b } = await race(
      { actor: VISA_A, sql: SQL.feeSend, params: [prep.entryId, prep.rowVersion, JSON.stringify({ amountPaise: '660000', remark: 'Synthetic: corrected amount' }), rid()] },
      { actor: ACC, sql: SQL.expenseAccept, params: [prep.entryId, prep.rowVersion + 1, rid()] });
    notDeadlock(a);
    notDeadlock(b);
    expect(a.ok, a.error).toBe(true);
    // Accounts read the resubmission only after the fix committed; whichever way, the entry ends in one consistent state.
    const [row] = await q<{ expense_status: string; amount_paise: string; reviewed_by: string | null }>(
      'select expense_status, amount_paise::text, reviewed_by from public.department_cost_entries where id = $1', [prep.entryId]);
    if (b.ok) expect(row).toMatchObject({ expense_status: 'accepted', amount_paise: '660000', reviewed_by: U.accountsJodhpur });
    else {
      expect(['version_changed', 'wrong_state']).toContain(b.error);
      expect(row).toMatchObject({ expense_status: 'submitted', amount_paise: '660000' });
    }
  });

  it('(7b) Accounts accept first vs Fix fee on the same submitted entry: the fix is refused cost_locked', async () => {
    const r = await ready();
    const prep = await committed(async () => {
      const a1 = await h.makeReady(r.taskId, 1);
      const receipt = await h.evidence(VISA_A, r.taskId, 'fee_receipt', null, '9'.repeat(64));
      const applied = await h.apply(r.taskId, [line(a1, { reference: 'SYN-VCC-FEE2' })], { receiptEvidenceId: receipt });
      const [entry] = await q<{ id: string; row_version: number }>('select id, row_version from public.department_cost_entries where id = any($1::uuid[])',
        [applied.entryIds]);
      return { entryId: entry!.id, rowVersion: entry!.row_version };
    });
    const { a, b } = await race(
      { actor: ACC, sql: SQL.expenseAccept, params: [prep.entryId, prep.rowVersion, rid()] },
      { actor: VISA_A, sql: SQL.feeSend, params: [prep.entryId, prep.rowVersion, JSON.stringify({ amountPaise: '660000', remark: null }), rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(['cost_locked', 'version_changed']).toContain(b.error);
    expect(await q('select expense_status, amount_paise::text as a from public.department_cost_entries where id = $1', [prep.entryId]))
      .toEqual([{ expense_status: 'accepted', a: '650000' }]);
  });

  it('(8) re-apply vs handover on the same refused application: one wins', async () => {
    const r = await ready();
    const a2 = await committed(async () => {
      const applied = await h.appliedAlone(r.taskId, 2);
      const d = await h.decide(r.taskId, applied, 'rejected');
      return { applicationId: applied.applicationId, rowVersion: d.rowVersion };
    });
    const { a, b } = await race(
      { actor: VISA_A, sql: SQL.reapply, params: [a2.applicationId, a2.rowVersion, rid()] },
      { actor: VISA_A, sql: SQL.handover, params: [a2.applicationId, a2.rowVersion, JSON.stringify({ method: 'not_with_us', courierNumber: null, remark: null }), rid()] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok).toBe(false);
    expect(['version_changed', 'application_closed']).toContain(b.error);
    const row = await appRow(a2.applicationId);
    expect(row.superseded_at).not.toBeNull();
    expect(row.handover_method).toBeNull();
    expect(await q('select count(*)::int as n from public.visa_applications where task_id = $1 and traveller_seq = 2 and superseded_at is null', [r.taskId]))
      .toEqual([{ n: 1 }]);
  });

  it('(9) two acknowledgements of one notice: one sets it', async () => {
    const r = await ready();
    const noticeId = await committed(async () => {
      const applied = await h.appliedAlone(r.taskId, 1);
      await h.decide(r.taskId, applied, 'approved');
      const [n] = await q<{ id: string }>('select id from public.visa_result_notices where task_id = $1', [r.taskId]);
      return n!.id;
    });
    const { a, b } = await race({ actor: OWNER, sql: SQL.noticeAck, params: [noticeId] }, { actor: OWNER, sql: SQL.noticeAck, params: [noticeId] });
    expect(a.ok, a.error).toBe(true);
    expect(b.ok, b.error).toBe(true);
    expect(a.result).toMatchObject({ outcome: 'updated' });
    expect(b.result).toMatchObject({ outcome: 'existing' });
    expect(await q('select seen_by from public.visa_result_notices where id = $1', [noticeId])).toEqual([{ seen_by: U.salesDelhiA }]);
  });
});
