import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, assertDatabaseUrlNotOperational, claimsFor, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT_ITEM, HOTEL_ITEM, dayFrom } from './acc-support';
import { ACC, ACC2, FLIGHT, MANAGER, OWNER, REASON, SQL2, SUPER, acc2Helpers, idOf, landed, rid, today, waits } from './acc2-support';

/**
 * Accounts Phase 2 test plan 12.1 "Concurrency" (plan C03/C09), Track F, on
 * a REAL local Postgres (TEST_DATABASE_URL). PGlite is one connection, so the
 * file is skipped there. Each race runs RUNS times (default 50, contract
 * 12.1; ACC2_RACE_RUNS overrides for a quick local pass) and asserts the
 * invariant plus "no deadlock":
 *  (1) release vs release on one Deal → numbers n and n+1, never a duplicate;
 *  (2) draft ADV vs draft ADV for one receipt → one already_recorded;
 *  (3) refund create vs create → one refund_open_exists (two refunds racing cannot exceed money held);
 *  (4) approve vs withdraw → exactly one wins;
 *  (5) payout vs receipt reversal → money held never below zero;
 *  (6) supplier refund record vs record → Σ verified never above expected without a reason;
 *  (7) Flight charge vs cancellation decide → never a charge revision changing the charge after approval;
 *  (8) Tally export vs document cancel → the cancel is exported or the document reads changed since export.
 * Lock order under test (13.1): finance_lock_deal → subject row → Tally entity lock (shared) → cash lock.
 *
 * Setup rows are COMMITTED on fresh synthetic Deals (SYN-ACC2-<run>-n), never
 * the fixture Deals. afterAll removes every row of those Deals as the local
 * table owner with triggers off (session_replication_role = replica,
 * test-only, local), plus the run's exports, memberships and audit rows, and
 * restores every switch it changed (Phase 1 lesson).
 */

const url = process.env.TEST_DATABASE_URL;
const READY = landed('customer_documents', 'customer_document_release', 'customer_refund_requests', 'customer_refund_payout_record',
  'supplier_refund_record', 'flight_cancellation_charge_set');
const RUNS = Number(process.env.ACC2_RACE_RUNS ?? 50);
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const RACE_TIMEOUT = 20 * 60_000;

let db: TestDb;
let c1: pg.Client;
let c2: pg.Client;
let auditStart = '0';
let exportStart = new Date(0).toISOString();
let saved: Record<string, unknown> = {};
/** Shared rows the suite's committed steps touch outside its Deals (round-2 lesson: they broke Phase 1 suites run later). */
const COUNTER_TABLES = ['finance_receipt_counters', 'tally_export_counters', 'customer_refund_counters', 'supplier_payment_counters'];
const countersBefore: Record<string, Array<Record<string, unknown>>> = {};
let settingsBefore: Array<Record<string, unknown>> = [];
let noticeSeqStart = '0';
const addedMemberships: string[] = [];
const dealIds: string[] = [];
let seq = 0;

const h = acc2Helpers(() => db);

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
const entity = async () => (await q<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;

beforeAll(async () => {
  if (!url || !READY) return;
  await assertDatabaseUrlNotOperational(url);
  db = await createTestDb();
  c1 = await connect();
  c2 = await connect();
  auditStart = (await q<{ m: string }>('select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
  exportStart = (await q<{ t: string }>('select now()::text as t'))[0]!.t;
  noticeSeqStart = (await q<{ m: string }>('select coalesce(max(seq), 0)::text as m from public.staff_notices'))[0]!.m;
  for (const t of COUNTER_TABLES) countersBefore[t] = await q(`select * from public.${t}`);
  settingsBefore = await q('select * from public.accounts_settings');
  const e = await entity();
  saved = (await q<Record<string, unknown>>(
    `select w.service_items_enabled, w.visa_passport_tasks_enabled, n.notices_enabled,
            s.tally_export_enabled, s.customer_documents_enabled, s.refunds_enabled
     from public.workflow_settings w cross join public.notice_settings n left join public.accounts_settings s on s.legal_entity_id = $1
     where w.id and n.id`, [e]))[0]!;
  for (const [user, role, branch] of [[U.movedStaff, 'flight', 'JDH'], [U.salesAhmedabad, 'flight', 'JDH'], [U.visaJodhpur, 'accounts', 'JDH']]) {
    const rows = await q<{ id: string }>(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $3 on conflict do nothing returning id`, [user, role, branch]);
    addedMemberships.push(...rows.map((r) => r.id));
  }
  await committed(async () => {
    await h.one(SUPER, SQL2.setTallyExport, [e, true, 'Synthetic: Phase 2 concurrency suite (local stack)']);
    await h.one(SUPER, SQL2.setDocsEnabled, [e, true, 'Synthetic: Phase 2 concurrency suite (local stack)']);
    await h.one(SUPER, SQL2.setRefundsEnabled, [e, true, 'Synthetic: Phase 2 concurrency suite (local stack)']);
  });
}, 120_000);

afterAll(async () => {
  if (!url || !db) return;
  try {
    await cleanup();
  } finally {
    await Promise.allSettled([c1?.end(), c2?.end()]);
    await db.close();
  }
}, 300_000);

async function cleanup(): Promise<void> {
  await db.exec('begin');
  try {
    await db.exec('set local session_replication_role = replica');
    const swept = await q<{ id: string }>(`select id from public.deals where reference like 'SYN-ACC2-%'`);
    for (const { id } of swept) if (!dealIds.includes(id)) dealIds.push(id);
    const exports = (await q<{ id: string }>('select id from public.tally_exports where created_at >= $1::timestamptz', [exportStart])).map((r) => r.id);
    if (exports.length) {
      await q('delete from public.tally_export_lines where export_id = any($1::uuid[])', [exports]);
      await q('delete from public.tally_records where last_export_id = any($1::uuid[])', [exports]);
      await q('delete from public.tally_exports where id = any($1::uuid[])', [exports]);
    }
    if (dealIds.length > 0) {
      const ids = async (sql: string) => (await q<{ id: string }>(sql, [dealIds])).map((r) => r.id);
      const versions = await ids('select id from public.booking_versions where deal_id = any($1::uuid[])');
      const tasks = await ids('select id from public.fulfilment_tasks where deal_id = any($1::uuid[])');
      const items = await ids('select id from public.service_items where deal_id = any($1::uuid[])');
      const receipts = await ids('select id from public.customer_receipts where deal_id = any($1::uuid[])');
      const entries = await ids('select id from public.finance_journal_entries where deal_id = any($1::uuid[])');
      const cdocs = await ids('select id from public.customer_documents where deal_id = any($1::uuid[])');
      const refunds = await ids('select id from public.customer_refund_requests where deal_id = any($1::uuid[])');
      const cancellations = await ids('select id from public.deal_cancellations where deal_id = any($1::uuid[])');
      const sdocs = await ids('select id from public.supplier_documents where deal_id = any($1::uuid[])');
      const payments = await ids('select id from public.supplier_payment_requests where deal_id = any($1::uuid[])');
      const srefunds = await ids('select id from public.supplier_refund_receipts where deal_id = any($1::uuid[])');
      const suppliers = (await q<{ id: string }>(
        `select distinct q.supplier_id as id from public.purchase_quotes q where q.task_id = any($1::uuid[])
         union select distinct supplier_id from public.flight_ticket_batches where deal_id = any($2::uuid[])`, [tasks, dealIds])).map((r) => r.id);
      const tallyIds = [...entries, ...cdocs, ...sdocs, ...payments, ...srefunds];
      await q('delete from public.tally_source_touches where tally_record_id in (select id from public.tally_records where record_id = any($1::uuid[]))', [tallyIds]);
      await q('delete from public.tally_records where record_id = any($1::uuid[])', [tallyIds]);
      await q(`delete from public.refund_evidence where subject_id = any($1::uuid[])`, [[...refunds, ...srefunds, ...cancellations]]);
      const byColumn: Record<string, string[]> = { deal_id: dealIds, task_id: tasks, booking_version_id: versions, version_id: versions,
        service_item_id: items, receipt_id: receipts, payment_request_id: payments, document_id: [...sdocs, ...cdocs], refund_request_id: refunds,
        cancellation_id: cancellations };
      const cols = await q<{ t: string; c: string }>(
        `select table_name as t, column_name as c from information_schema.columns
         where table_schema = 'public' and column_name = any($1::text[])
           and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`,
        [Object.keys(byColumn)]);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const { t, c } of cols) {
          const values = byColumn[c]!;
          if (values.length > 0) await q(`delete from public.${t} where ${c} = any($1::uuid[])`, [values]);
        }
      }
      if (suppliers.length > 0) {
        const supplierCols = await q<{ t: string }>(
          `select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'supplier_id'
             and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
        for (const { t } of supplierCols) await q(`delete from public.${t} where supplier_id = any($1::uuid[])`, [suppliers]);
        await q('delete from public.suppliers where id = any($1::uuid[])', [suppliers]);
      }
      const all = [...dealIds, ...versions, ...tasks, ...items, ...receipts, ...payments, ...sdocs, ...cdocs, ...refunds, ...suppliers];
      await q('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      await q('delete from public.outbox_events where aggregate_id = any($1::uuid[])', [all]);
      await q(`delete from storage.objects where name ~ $1`, [all.join('|') || '^$']);
    }
    if (addedMemberships.length > 0) await q('delete from public.memberships where id = any($1::uuid[])', [addedMemberships]);
    await q('update public.workflow_settings set service_items_enabled = $1, visa_passport_tasks_enabled = $2 where id',
      [saved.service_items_enabled, saved.visa_passport_tasks_enabled]);
    await q('update public.notice_settings set notices_enabled = $1 where id', [saved.notices_enabled]);
    // Exact restore of the settings row (row_version included) and of every number counter the run moved.
    await q('delete from public.accounts_settings');
    for (const row of settingsBefore) {
      const cols = Object.keys(row);
      await q(`insert into public.accounts_settings (${cols.join(', ')}) select ${cols.map((c) => `r.${c}`).join(', ')}
        from jsonb_populate_record(null::public.accounts_settings, $1::jsonb) r`, [JSON.stringify(row)]);
    }
    for (const t of COUNTER_TABLES) {
      await q(`delete from public.${t}`);
      for (const row of countersBefore[t] ?? []) {
        const cols = Object.keys(row);
        await q(`insert into public.${t} (${cols.join(', ')}) select ${cols.map((c) => `r.${c}`).join(', ')}
          from jsonb_populate_record(null::public.${t}, $1::jsonb) r`, [JSON.stringify(row)]);
      }
    }
    // Notices the run wrote (incl. bank-detail notices with no Deal) and the synthetic company destinations its receipts added.
    await q('delete from public.staff_notices where seq > $1::bigint', [noticeSeqStart]);
    const dests = (await q<{ id: string }>(`select id from public.company_destinations where created_at >= $1::timestamptz
      and label = 'Synthetic fixture destination'`, [exportStart])).map((r) => r.id);
    if (dests.length) {
      await q('update public.company_destinations set current_version_id = null where id = any($1::uuid[])', [dests]);
      await q('delete from public.company_destination_versions where destination_id = any($1::uuid[])', [dests]);
      await q('delete from public.company_destinations where id = any($1::uuid[])', [dests]);
    }
    // Suppliers the run created that no Deal row pointed at any more (e.g. a ticket confirmation that failed).
    const strays = (await q<{ id: string }>('select id from public.suppliers where created_at >= $1::timestamptz', [exportStart])).map((r) => r.id);
    if (strays.length) {
      const supplierCols = await q<{ t: string }>(`select table_name as t from information_schema.columns where table_schema = 'public'
        and column_name = 'supplier_id' and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`);
      for (const { t } of supplierCols) await q(`delete from public.${t} where supplier_id = any($1::uuid[])`, [strays]);
      await q('delete from public.suppliers where id = any($1::uuid[])', [strays]);
    }
    await q('delete from public.audit_events where id > $1::bigint', [auditStart]);
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
  const [deal] = await q<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic Phase 2 concurrency deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-ACC2-${runTag}-${seq}`, U.salesDelhiA]);
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
/** Both statements start inside open transactions before either commits; the first commits first. */
async function race(first: Step, second: Step): Promise<{ a: Outcome; b: Outcome }> {
  await begin(c1, first.actor);
  const a = await attempt(c1, first);
  await begin(c2, second.actor);
  const pending = attempt(c2, second);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await c1.query(a.ok ? 'commit' : 'rollback');
  const b = await pending;
  await c2.query(b.ok ? 'commit' : 'rollback');
  return { a, b };
}
const noDeadlock = (...o: Outcome[]) => { for (const x of o) expect(x.error ?? '').not.toMatch(/deadlock/i); };
const held = async (deal: string) => BigInt((await q<{ v: string }>(
  `select coalesce(sum(credit_paise - debit_paise), 0)::text as v from public.finance_journal_lines where deal_id = $1 and account = 'customer_advances'`,
  [deal]))[0]!.v);
const docRow = async (id: string) => (await q<{ row_version: number; content_sha256: string; number: string | null; seq: number | null; status: string }>(
  'select row_version, content_sha256, number, seq, status from public.customer_documents where id = $1', [id]))[0]!;
const refundRow = async (id: string) => (await q<{ row_version: number; status: string; amount_paise: string; customer_charge_paise: string }>(
  'select row_version, status, amount_paise::text as amount_paise, customer_charge_paise::text as customer_charge_paise from public.customer_refund_requests where id = $1',
  [id]))[0]!;

/** Committed: package Deal approved (billing verified) with `amount` verified money. */
const moneyDeal = (amount = '30000000', items = [HOTEL_ITEM]) => committed(async () => {
  const deal = await freshDeal();
  const b = await h.approvedDeal(items, { deal });
  const rec = await h.receipt2(amount, deal);
  return { deal, b, rec };
});

describe.skipIf(!url || !READY)(`Phase 2 real concurrency (skipped on PGlite: one connection${READY ? '' : `; ${waits('B/C', 'Phase 2 tables')}`})`, () => {
  it('(1) release vs release: numbers n and n+1, no duplicate', async () => {
    const { deal } = await moneyDeal();
    const numbers: string[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const [d1, d2] = await committed(async () => {
        const r1 = await h.receipt2(String(10_000 + i), deal);
        const r2 = await h.receipt2(String(20_000 + i), deal);
        return [await h.draft('advance_invoice', { receiptId: r1.id }, deal), await h.draft('advance_invoice', { receiptId: r2.id }, deal)];
      });
      const step = (actor: Actor, d: { id: string; row_version: number; content_sha256: string }): Step =>
        ({ actor, sql: SQL2.docRelease, params: [d.id, d.row_version, d.content_sha256, rid()] });
      const { a, b } = await race(step(ACC, d1!), step(ACC2, d2!));
      noDeadlock(a, b);
      expect(a.ok, a.error).toBe(true);
      expect(b.ok, b.error).toBe(true);
      const s = [(await docRow(d1!.id)).seq!, (await docRow(d2!.id)).seq!].sort((x, y) => x - y);
      expect(s).toEqual([2 * i + 1, 2 * i + 2]);
      numbers.push((await docRow(d1!.id)).number!, (await docRow(d2!.id)).number!);
    }
    expect(new Set(numbers).size).toBe(numbers.length);
  }, RACE_TIMEOUT);

  it('(2) draft ADV vs draft ADV for one receipt: one already_recorded', async () => {
    const { deal } = await moneyDeal();
    for (let i = 0; i < RUNS; i += 1) {
      const rec = await committed(() => h.receipt2(String(30_000 + i), deal));
      const step = (actor: Actor): Step => ({ actor, sql: SQL2.draftCreate, params: [deal, 'advance_invoice', JSON.stringify({ receiptId: rec.id }), rid()] });
      const { a, b } = await race(step(ACC), step(ACC2));
      noDeadlock(a, b);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect([a.error, b.error].filter(Boolean)).toEqual(['already_recorded']);
      expect(await q(`select count(*)::int as n from public.customer_documents where receipt_id = $1 and status in ('draft','released')`, [rec.id]))
        .toEqual([{ n: 1 }]);
    }
  }, RACE_TIMEOUT);

  it('(3) refund create vs create: one refund_open_exists; Σ live ≤ money held', async () => {
    const { deal, rec } = await moneyDeal('2500000');
    await committed(() => h.approveCancellation(deal));
    for (let i = 0; i < RUNS; i += 1) {
      const step = (): Step => ({ actor: OWNER, sql: SQL2.refundCreate, params: [deal, JSON.stringify(h.refundFields({ payeeReceiptId: rec.id,
        amountPaise: '2000000' })), rid()] });
      const { a, b } = await race(step(), step());
      noDeadlock(a, b);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect([a.error, b.error].filter(Boolean)).toEqual(['refund_open_exists']);
      const live = await q<{ id: string; amount_paise: string }>(
        `select id, amount_paise::text as amount_paise from public.customer_refund_requests where deal_id = $1 and status in ('requested','returned','approved')`,
        [deal]);
      expect(live).toHaveLength(1);
      expect(BigInt(live[0]!.amount_paise)).toBeLessThanOrEqual(await held(deal));
      await committed(() => h.one(OWNER, SQL2.refundWithdraw, [live[0]!.id, 1, 'Synthetic: race round finished', rid()]).catch(async () =>
        h.one(OWNER, SQL2.refundWithdraw, [live[0]!.id, (await refundRow(live[0]!.id)).row_version, 'Synthetic: race round finished', rid()])));
    }
  }, RACE_TIMEOUT);

  it('(4) approve vs withdraw: exactly one wins', async () => {
    const { deal, rec } = await moneyDeal('2500000');
    await committed(() => h.approveCancellation(deal));
    for (let i = 0; i < RUNS; i += 1) {
      const r = await committed(() => h.requestRefund(h.refundFields({ payeeReceiptId: rec.id, amountPaise: '100000' }), deal));
      const approve: Step = { actor: MANAGER, sql: SQL2.refundDecide, params: [r.id, 'approve', '100000', '0', null, r.row_version, rid()] };
      const withdraw: Step = { actor: OWNER, sql: SQL2.refundWithdraw, params: [r.id, r.row_version, 'Synthetic: customer withdrew the request', rid()] };
      const { a, b } = i % 2 === 0 ? await race(approve, withdraw) : await race(withdraw, approve);
      noDeadlock(a, b);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      // The loser: version_changed / wrong_state, or not_authorized (the requester may not withdraw an approved request, LD31).
      expect([a.error, b.error].filter(Boolean)[0]).toMatch(/^(version_changed|wrong_state|not_authorized)$/);
      const now = await refundRow(r.id);
      if (now.status === 'approved') {
        await committed(() => h.one(MANAGER, SQL2.refundWithdraw, [r.id, now.row_version, 'Synthetic: race round finished', rid()]));
      }
    }
  }, RACE_TIMEOUT);

  it('(5) payout vs receipt reversal: money held never below zero', async () => {
    for (let i = 0; i < RUNS; i += 1) {
      const { deal, rec } = await moneyDeal('500000');
      const { r, ev } = await committed(async () => {
        await h.approveCancellation(deal);
        const req = await h.requestRefund(h.refundFields({ payeeReceiptId: rec.id, amountPaise: '500000' }), deal);
        await h.decideRefund(req.id, 'approve');
        return { r: { id: req.id, ...(await refundRow(req.id)) }, ev: await h.refundProof('customer_refund', req.id) };
      });
      const payout: Step = { actor: ACC, sql: SQL2.payout, params: [idOfRow(r), r.row_version, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        reference: `SYNRC${String(i).padStart(4, '0')}`, evidenceId: ev }), rid()] };
      const reverse: Step = { actor: ACC, sql: 'select public.receipt_reverse($1, $2, $3, $4) as r', params: [rec.id, 'data_error', 'Synthetic reversal race', rid()] };
      const { a, b } = i % 2 === 0 ? await race(payout, reverse) : await race(reverse, payout);
      noDeadlock(a, b);
      const payoutFirst = i % 2 === 0;
      const [p, rv] = payoutFirst ? [a, b] : [b, a];
      // Reversal committed first: the payout must be refused (7.2 re-check at payout), money held never below zero.
      if (!payoutFirst) {
        expect(rv.ok, rv.error).toBe(true);
        expect(p).toMatchObject({ ok: false, error: 'refund_exceeds_money' });
        expect(await held(deal)).toBeGreaterThanOrEqual(0n);
      } else {
        // Addendum L6: a reversal after a paid-out refund stays allowed; money held may go below zero, and no new
        // refund can be requested while it is. (Dues "due now" and the urgent notice are checked in acc2-refunds once
        // Track C reports the L6 build.)
        expect(p.ok, p.error).toBe(true);
        expect(await held(deal)).toBe(rv.ok ? -500000n : 0n);
        if (rv.ok) {
          const again = await committed(async () => h.attempt(OWNER, SQL2.refundCreate, [deal, JSON.stringify(h.refundFields({ payeeReceiptId: rec.id,
            amountPaise: '1' })), rid()]));
          expect(again.ok, 'L6: no new refund while money held is below zero').toBe(false);
        }
      }
      if (!a.ok || !b.ok) expect([a.error, b.error].filter(Boolean)[0]).toMatch(/^(refund_exceeds_money|wrong_state|version_changed|receipt_refunded|not_ready)$/);
    }
  }, RACE_TIMEOUT);

  it('(6) supplier refund record vs record: Σ verified never above expected without a reason', async () => {
    for (let i = 0; i < Math.min(RUNS, 20); i += 1) {
      const { deal, b } = await moneyDeal('2500000');
      const { chargeId, cancellationId } = await committed(async () => {
        const task = h.taskOf(b, 'hotel');
        await h.purchaseCost(task, await h.purchaseSupplier());
        const cancellationId = await h.openCancellation(deal);
        await h.one({ userId: U.purchaseJodhpur }, SQL2.chargeSet, [task, '100000', '3900000', null, null, 0, rid()]);
        await h.one({ userId: U.purchaseJodhpur }, SQL2.cancelSend, [cancellationId, (await h.cancellationOf(deal))!.row_version, rid()]);
        await h.one(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, (await h.cancellationOf(deal))!.row_version, rid()]);
        return { cancellationId, chargeId: (await q<{ id: string }>(
          'select id from public.purchase_cancellation_charges where cancellation_id = $1 order by revision_no desc limit 1', [cancellationId]))[0]!.id };
      });
      const evs = await committed(async () => [await h.refundProof('supplier_refund', cancellationId), await h.refundProof('supplier_refund', cancellationId, ACC2)]);
      const step = (actor: Actor, ev: string): Step => ({ actor, sql: SQL2.supplierRefundRecord, params: [JSON.stringify({ sourceKind: 'purchase_charge',
        sourceId: chargeId, amountPaise: '3000000', receivedOn: today(), mode: 'bank_transfer', reference: `SYNSRR${i}${actor === ACC ? 'A' : 'B'}`,
        evidenceId: ev, overExpectedReason: null }), rid()] });
      const { a, b: bb } = await race(step(ACC, evs[0]!), step(ACC2, evs[1]!));
      noDeadlock(a, bb);
      expect([a.ok, bb.ok].filter(Boolean)).toHaveLength(1);
      expect([a.error, bb.error].filter(Boolean)).toEqual(['over_expected']);
      const [sum] = await q<{ s: string }>(`select coalesce(sum(amount_paise), 0)::text as s from public.supplier_refund_receipts where source_id = $1 and status = 'verified'`,
        [chargeId]);
      expect(BigInt(sum!.s)).toBeLessThanOrEqual(3900000n);
    }
  }, RACE_TIMEOUT);

  it('(7) Flight charge vs cancellation decide: no deadlock; no airline-charge change lands after approval', async () => {
    for (let i = 0; i < Math.min(RUNS, 20); i += 1) {
      const { deal, batchId, cancellationId } = await committed(async () => {
        const d = await freshDeal();
        await h.approvedDeal([FLIGHT_ITEM], { deal: d });
        const batch = await h.flightBatch(d, [1]);
        const cid = await h.openCancellation(d);
        await h.one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '0',
          refundReportedPaise: null, note: 'Synthetic first charge' }), 0, rid()]);
        await h.one(FLIGHT, SQL2.cancelSend, [cid, (await h.cancellationOf(d))!.row_version, rid()]);
        return { deal: d, batchId: batch.batchId, cancellationId: cid };
      });
      const c = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [cancellationId]))[0]!;
      const change: Step = { actor: FLIGHT, sql: SQL2.flightChargeSet, params: [batchId, JSON.stringify({ airlineChargePaise: '200000', refundExpectedPaise: '0',
        refundReportedPaise: null, note: 'Synthetic changed charge' }), 1, rid()] };
      const decide: Step = { actor: MANAGER, sql: SQL2.cancelDecide, params: [cancellationId, 'approve', null, c.row_version, rid()] };
      const { a, b } = i % 2 === 0 ? await race(change, decide) : await race(decide, change);
      noDeadlock(a, b);
      const [state] = await q<{ status: string; decided_at: string | null }>('select status, decided_at::text from public.deal_cancellations where id = $1',
        [cancellationId]);
      if (state!.status === 'approved') {
        const late = await q<{ n: number }>(`select count(*)::int as n from public.flight_cancellation_charges f join public.deal_cancellations c on c.id = f.cancellation_id
          where f.cancellation_id = $1 and f.entered_at > c.decided_at and f.airline_charge_paise <> 100000`, [cancellationId]);
        expect(late).toEqual([{ n: 0 }]);
      }
      void deal;
    }
  }, RACE_TIMEOUT);

  it('(8) Tally export vs document cancel: the cancel is in the export or the document reads changed since export', async () => {
    const { deal } = await moneyDeal();
    const e = await entity();
    for (let i = 0; i < Math.min(RUNS, 20); i += 1) {
      const doc = await committed(async () => h.release((await h.draft('advance_invoice', { receiptId: (await h.receipt2(String(40_000 + i), deal)).id }, deal)).id));
      const exportStep: Step = { actor: ACC, sql: SQL2.exportCreate, params: [JSON.stringify({ entityId: e, from: dayFrom(-30), to: today(),
        kinds: ['customer_document'], includeExported: false }), rid()] };
      const cancelStep: Step = { actor: ACC2, sql: SQL2.docCancel, params: [doc.id, doc.row_version, 'Synthetic: cancel during an export', rid()] };
      const { a, b } = i % 2 === 0 ? await race(exportStep, cancelStep) : await race(cancelStep, exportStep);
      noDeadlock(a, b);
      const exp = (i % 2 === 0 ? a : b);
      const can = (i % 2 === 0 ? b : a);
      expect(can.ok, can.error).toBe(true);
      if (exp.ok) {
        const exportId = (exp.result as { exportId: string }).exportId;
        const [line] = await q<{ v: unknown }>('select l."values" as v from public.tally_export_lines l where l.export_id = $1 and l.record_id = $2', [exportId, doc.id]);
        const [flag] = await q<{ changed: boolean }>('select $1::uuid = any(authz.tally_changed_ids(array[$2::uuid])) as changed', [doc.id, e]);
        if (line) expect(JSON.stringify(line.v).includes('ancel') || flag!.changed, 'cancel exported or flagged').toBe(true);
      } else {
        expect(exp.error).toMatch(/^(nothing_to_export)$/);
      }
    }
  }, RACE_TIMEOUT);
});

function idOfRow(r: unknown): string {
  return idOf(r);
}

void REASON;
