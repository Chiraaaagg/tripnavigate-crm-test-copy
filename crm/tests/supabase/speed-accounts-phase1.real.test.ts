import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, assertDatabaseUrlNotOperational, claimsFor } from '../helpers/db';

/**
 * OPT-IN: runs only with ACCOUNTS_SPEED=1 (and TEST_DATABASE_URL), e.g.
 *   ACCOUNTS_SPEED=1 npx vitest run --project supabase tests/supabase/speed-accounts-phase1.real.test.ts
 * It is a local measurement on the volume seeds below, not a CI check
 * (accounts-phase3 contract 16.5): without the opt-in the suite is skipped.
 *
 * Accounts phase speed tests, database part (contract section 12.7 = plan
 * 17.3), Track E. Needs the REAL local stack seeded with
 * scripts/seed-local.mjs and then scripts/perf/accounts-volume.sql
 * (10,000 SYN-PERF Deals ...). Skips otherwise; refuses non-loopback URLs.
 *
 * Each read runs 30 times after one warm-up as the signed-in role (the same
 * JWT claims and SET LOCAL ROLE authenticated PostgREST uses), median and
 * 95th percentile against the targets; `explain (analyze, buffers)` of each
 * read is captured once into the results. "Extra time per command" = p95 of
 * the same command with notices on minus off, 30 runs each, every run in a
 * rolled-back transaction. Background load (9 users) comes from
 * scripts/perf/accounts-load.mjs started separately (ACCOUNTS_LOAD=1 records
 * that it was running).
 *
 * Output: test-results/speed-accounts-phase1.json and a printed table
 * (measure, median, p95, target, pass/miss). A miss fails the test: it blocks
 * the release until fixed or the owner accepts it in writing.
 */

const url = process.env.TEST_DATABASE_URL?.trim() ?? '';
/** Opt-in only (see the header): CI and the ordinary real-stack run skip this suite. */
const speed = process.env.ACCOUNTS_SPEED === '1' && url !== '';
const RUNS = Number(process.env.SPEED_RUNS ?? 30);
type Row = { measure: string; medianMs: number; p95Ms: number; targetMs: number; targetOn: 'p95' | 'median'; pass: boolean; plan?: string };
const results: Row[] = [];

let c: pg.Client;
let seeded = false;
const ACC: Actor = { userId: U.accountsJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

async function asActor<T>(actor: Actor, fn: () => Promise<T>, keep = false): Promise<T> {
  await c.query('begin');
  try {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
    await c.query('set local role authenticated');
    return await fn();
  } finally {
    await c.query(keep ? 'commit' : 'rollback');
  }
}

/** 1 warm-up + RUNS timed runs of `sql` as `actor`, each in its own rolled-back transaction. */
async function measure(name: string, actor: Actor, sql: string, params: unknown[], targetMs: number, targetOn: 'p95' | 'median' = 'p95') {
  const times: number[] = [];
  for (let i = 0; i <= RUNS; i += 1) {
    const ms = await asActor(actor, async () => {
      const t0 = performance.now();
      await c.query(sql, params);
      return performance.now() - t0;
    });
    if (i > 0) times.push(ms);
  }
  const plan = await asActor(actor, async () => (await c.query(`explain (analyze, buffers, format text) ${sql}`, params)).rows
    .map((r: Record<string, string>) => r['QUERY PLAN']).join('\n'));
  const row: Row = { measure: name, medianMs: Math.round(pct(times, 50)), p95Ms: Math.round(pct(times, 95)), targetMs, targetOn,
    pass: (targetOn === 'p95' ? pct(times, 95) : pct(times, 50)) <= targetMs, plan };
  results.push(row);
  return row;
}

/** One statement as `userId` inside the caller's open transaction (claims set, role back to the owner afterwards). */
async function inTx<T = unknown>(userId: string, sql: string, params: unknown[]): Promise<T> {
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor({ userId }))]);
  await c.query('set local role authenticated');
  // No reset on error: the original refusal must surface, not "transaction is aborted".
  const r = (await c.query<{ r: T }>(sql, params)).rows[0]!.r;
  await c.query('reset role');
  return r;
}
const SPEED_ITEMS: Array<[string, unknown]> = [
  ['hotel', { hotelName: 'Synthetic Speed Hotel', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 1, adults: 2,
    roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', children: 0, inclusions: null, specialRequests: null }],
  ['transfer', { route: 'Synthetic airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 2, pickupTime: '09:30', notes: null }],
  ['flight', { entryMode: 'typed', segments: [{ from: 'JDH', to: 'DEL', date: '2026-12-10', airline: 'Air India', flightNo: 'AI 470', departTime: '10:35',
    arriveTime: '11:50' }], passengers: 2, preferredTime: null, cabin: 'Economy', notes: null }],
];

/** Same command with notices on and off (rolled back each run): p95 difference. */
async function extraForNotices(name: string, actor: Actor, setup: (() => Promise<unknown[]>) | null, sql: string, params: unknown[]) {
  const run = async (on: boolean) => {
    const times: number[] = [];
    for (let i = 0; i <= RUNS; i += 1) {
      await c.query('begin');
      try {
        await c.query('update public.notice_settings set notices_enabled = $1 where id', [on]);
        const p = setup ? await setup() : params;
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
        await c.query('set local role authenticated');
        const t0 = performance.now();
        await c.query(sql, p);
        if (i > 0) times.push(performance.now() - t0);
      } finally {
        await c.query('rollback');
      }
    }
    return pct(times, 95);
  };
  const off = await run(false);
  const on = await run(true);
  const row: Row = { measure: `extra time from notice writes: ${name}`, medianMs: Math.round(on), p95Ms: Math.round(on - off), targetMs: 50, targetOn: 'p95',
    pass: on - off <= 50 };
  results.push(row);
  return row;
}

beforeAll(async () => {
  if (!speed) return;
  await assertDatabaseUrlNotOperational(url);
  c = new pg.Client({ connectionString: url });
  await c.connect();
  const [{ n }] = (await c.query<{ n: number }>(`select count(*)::int as n from public.deals where reference like 'SYN-PERF-%'`)).rows as [{ n: number }];
  seeded = n >= 10_000;
}, 120_000);

afterAll(async () => {
  if (results.length) {
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', 'speed-accounts-phase1.json'), JSON.stringify({ at: new Date().toISOString(), runs: RUNS,
      backgroundLoad: process.env.ACCOUNTS_LOAD === '1', commit: process.env.GITHUB_SHA ?? null, results }, null, 2));
    console.info(['measure | median ms | p95 ms | target | pass', ...results.map((r) =>
      `${r.measure} | ${r.medianMs} | ${r.p95Ms} | ${r.targetOn} ≤ ${r.targetMs} | ${r.pass ? 'pass' : 'MISS'}`)].join('\n'));
  }
  await c?.end();
});

describe.skipIf(!speed)('Accounts phase speed (database, contract 12.7)', () => {
  it('seeded volume present', () => {
    expect(seeded, 'run scripts/perf/accounts-volume.sql on this local stack first').toBe(true);
  });

  it('workspace first page (50 rows), each single filter, next page, exact searches: ≤ 300 ms', async () => {
    if (!seeded) return;
    const SQLR = 'select public.accounts_records($1::jsonb, $2, $3) as r';
    const del = (await c.query<{ id: string }>(`select id from public.branches where code = 'DEL' limit 1`)).rows[0]!.id;
    const filters: Array<[string, Record<string, unknown>]> = [
      ['no filter', {}], ['kinds receipt', { kinds: ['receipt'] }], ['tally ready', { tallyStatus: 'ready' }], ['department purchase', { department: 'purchase' }],
      ['originals missing', { originals: 'missing' }], ['branch', { branchId: del }], ['changed since export', { changedSinceExport: true }],
      // Track B's PGlite misses, measured explicitly on real Postgres (lead, 10 Nov).
      ['stage open', { stage: 'open' }], ['review waiting', { reviewStatus: 'waiting' }], ['department flight', { department: 'flight' }],
    ];
    for (const [name, f] of filters) await measure(`workspace first page · ${name}`, ACC, SQLR, [JSON.stringify(f), null, 50], 300);
    await measure('workspace first page · Manager', MANAGER, SQLR, [JSON.stringify({}), null, 50], 300);
    const first = await asActor(ACC, async () => (await c.query<{ r: { nextAfter: string } }>(SQLR, [JSON.stringify({}), null, 50])).rows[0]!.r);
    await measure('workspace next page (keyset)', ACC, SQLR, [JSON.stringify({}), first.nextAfter, 50], 300);
    const refs = (await c.query<Record<string, string>>(`select
        (select receipt_no from public.customer_receipts order by recorded_at desc limit 1) as receipt,
        (select ref_no from public.supplier_payment_requests order by requested_at desc limit 1) as sp,
        (select reference from public.deals where reference like 'SYN-PERF-%' order by reference limit 1) as deal,
        (select number from public.supplier_documents order by uploaded_at desc limit 1) as invoice,
        (select airline_pnr from public.flight_ticket_revisions limit 1) as pnr,
        (select ticket_number from public.flight_ticket_revisions limit 1) as ticket`)).rows[0]!;
    for (const [what, q] of Object.entries(refs)) await measure(`search ${what}`, ACC, SQLR, [JSON.stringify({ q }), null, 50], 300);
    await measure('totals on demand · receipts', ACC, 'select public.accounts_records_totals($1::jsonb) as r', [JSON.stringify({ kinds: ['receipt'] })], 1000);
    await measure('totals on demand · unfiltered', ACC, 'select public.accounts_records_totals($1::jsonb) as r', [JSON.stringify({})], 1000);
    await measure('daily check', ACC, 'select public.accounts_daily_check() as r', [], 300);
    expect(results.filter((r) => !r.pass).map((r) => `${r.measure}: p95 ${r.p95Ms} ms`)).toEqual([]);
  }, 600_000);

  it('dues list for a branch (first 50) ≤ 300 ms; one Deal\'s dues ≤ 100 ms', async () => {
    if (!seeded) return;
    const del = (await c.query<{ id: string }>(`select id from public.branches where code = 'DEL' limit 1`)).rows[0]!.id;
    await measure('dues list · branch first 50', ACC, 'select public.accounts_dues($1::jsonb, $2, $3) as r', [JSON.stringify({ branchId: del }), null, 50], 300);
    await measure('dues list · Manager', MANAGER, 'select public.accounts_dues($1::jsonb, $2, $3) as r', [JSON.stringify({}), null, 50], 300);
    const deal = (await c.query<{ id: string }>(`select id from public.deals where reference = 'SYN-PERF-00001'`)).rows[0]!.id;
    await measure('Deal dues', ACC, 'select public.deal_dues($1) as r', [deal], 100);
    expect(results.filter((r) => r.measure.includes('dues') && !r.pass)).toEqual([]);
  }, 600_000);

  it('bell unread count ≤ 150 ms; inbox first page', async () => {
    if (!seeded) return;
    const busiest = (await c.query<{ u: string }>(`select recipient_user_id as u from public.staff_notices group by 1 order by count(*) desc limit 1`)).rows[0]!.u;
    const who: Actor = { userId: busiest };
    await measure('bell unread count', who, 'select public.notice_unread_count() as r', [], 150);
    await measure('bell inbox first page', who, 'select public.notice_inbox($1::bigint, $2) as r', [null, 50], 300);
    expect(results.filter((r) => r.measure.startsWith('bell') && !r.pass)).toEqual([]);
  }, 600_000);

  it('mark matched / exception (one record) ≤ 500 ms; export of 1,000 rows ≤ 10 s', async () => {
    if (!seeded) return;
    const entry = (await c.query<{ id: string }>(`select e.id from public.finance_journal_entries e join public.deals d on d.id = e.deal_id
      where d.reference like 'SYN-PERF-%' and not exists (select 1 from public.tally_records t where t.record_id = e.id) limit 1`)).rows[0]!.id;
    const today = (await c.query<{ d: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).rows[0]!.d;
    await measure('mark matched', ACC, 'select public.accounts_tally_match($1, $2, $3, $4::jsonb, gen_random_uuid()) as r',
      ['journal_entry', entry, 0, JSON.stringify({ voucherRef: 'SYN-PERF-V', voucherDate: today })], 500);
    await measure('raise exception', ACC, 'select public.accounts_tally_exception($1, $2, $3, $4::jsonb, gen_random_uuid()) as r',
      ['journal_entry', entry, 0, JSON.stringify({ reason: 'Synthetic speed test exception' })], 500);
    const entity = (await c.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`)).rows[0]!.id;
    // A period with about 1,000 ready journal entries (no Tally row yet).
    // At most 366 days (T8): the seed spreads entries over three years, so the window holds fewer than 1,000 rows (row count logged).
    const period = (await c.query<{ f: string; t: string }>(`select greatest(min(d), (now() at time zone 'Asia/Kolkata')::date - 365)::text as f,
      max(d)::text as t from (
      select e.business_date as d from public.finance_journal_entries e
      where e.business_date <= (now() at time zone 'Asia/Kolkata')::date
        and not exists (select 1 from public.tally_records t where t.record_id = e.id)
      order by e.business_date desc limit 1000) x`)).rows[0]!;
    // Switch on through the audited admin command as the fixture super admin (kept for the measured runs).
    await asActor({ userId: U.adminJodhpur }, () => c.query('select public.admin_set_tally_export_enabled($1, true, $2)',
      [entity, 'Synthetic: accounts speed test (local stack)']), true);
    const n = (await c.query<{ n: number }>(`select count(*)::int as n from public.finance_journal_entries e where e.business_date between $1 and $2
      and not exists (select 1 from public.tally_records t where t.record_id = e.id)`, [period.f, period.t])).rows[0]!.n;
    await measure(`export batch (${n} rows, create)`, ACC, 'select public.accounts_tally_export_create($1::jsonb, gen_random_uuid()) as r',
      [JSON.stringify({ entityId: entity, from: period.f, to: period.t, kinds: ['journal_entry'], includeExported: false })], 10_000);
    expect(results.filter((r) => /matched|exception|export/.test(r.measure) && !r.pass)).toEqual([]);
  }, 900_000);

  it('notice writes add ≤ 50 ms to existing commands (p95 on minus off)', async () => {
    if (!seeded) return;
    const deal = (await c.query<{ id: string; v: string }>(`select d.id, v.id as v from public.deals d join public.booking_versions v on v.deal_id = d.id
      where d.reference = 'SYN-PERF-00002'`)).rows[0]!;
    const del = (await c.query<{ id: string }>(`select id from public.branches where code = 'DEL' limit 1`)).rows[0]!.id;
    const dest = (await c.query<{ id: string }>(`select v.id from public.company_destination_versions v where v.status = 'approved' limit 1`)).rows[0]!.id;
    let k = 0;
    await extraForNotices('receipt record', ACC, async () => {
      k += 1;
      return [deal.id, JSON.stringify({ mode: 'bank_transfer', amountPaise: '100000', receivedOn: new Date().toISOString().slice(0, 10), branchId: del,
        payerName: 'Synthetic Speed Payer', payerPan: 'ABCDE1234F', reference: `SYNSPEED${String(k).padStart(6, '0')}`, destinationVersionId: dest }), crypto.randomUUID()];
    }, 'select public.receipt_record($1, $2::jsonb, $3) as r', []);
    const task = (await c.query<{ id: string; a: string }>(`select t.id, t.assignee_user_id as a from public.fulfilment_tasks t
      where t.department = 'purchase' and t.deal_id = $1`, [deal.id])).rows[0]!;
    await extraForNotices('task claim', { userId: task.a }, async () => {
      // Test-only reset inside the rolled-back run: guards off for this one update, back on for the measured command.
      await c.query('set local session_replication_role = replica');
      await c.query(`update public.fulfilment_tasks set status = 'not_started', assignee_user_id = null where id = $1`, [task.id]);
      await c.query('set local session_replication_role = origin');
      return [task.id];
    }, 'select public.purchase_task_claim($1) as r', []);
    await extraForNotices('Accounts review return', ACC, async () => [deal.v, 'Synthetic speed test return reason', crypto.randomUUID()],
      'select public.accounts_review_return($1, $2, $3) as r', []);
    // booking_confirm of a three-item package: every run builds a fresh ready draft (same commands as the booking
    // screens) inside its rolled-back transaction; only the confirm is timed.
    const S = U.salesDelhiA;
    let seqNo = 0;
    await extraForNotices('booking confirm (three-item package)', { userId: S }, async () => {
      seqNo += 1;
      const deal = (await c.query<{ id: string }>(`insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
        select b.legal_entity_id, b.id, $1, 'Synthetic speed confirm deal', $2 from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
        where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [`SYN-SPC-${Date.now()}-${seqNo}`, S])).rows[0]!.id;
      await c.query('update public.workflow_settings set service_items_enabled = true, visa_passport_tasks_enabled = true where id');
      const v = await inTx<{ versionId: string; rowVersion: number }>(S, 'select public.booking_open_draft($1) as r', [deal]);
      let rv = v.rowVersion;
      const items: string[] = [];
      for (const [type, facts] of SPEED_ITEMS) {
        const added = await inTx<{ rowVersion: number; itemId: string }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
          [v.versionId, rv, type, JSON.stringify(facts), '99999999', crypto.randomUUID()]);
        rv = added.rowVersion;
        items.push(added.itemId);
      }
      rv = (await inTx<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [deal, rv, JSON.stringify(
        [{ fullName: 'Synthetic Speed One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Speed Two', type: 'adult', seq: 2 }])])).rowVersion;
      rv = (await inTx<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [v.versionId, rv,
        JSON.stringify({ hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null,
          inclusions: null, specialRequests: null, purchaseBudgetPaise: null }), '4567890'])).rowVersion;
      rv = (await inTx<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r', [v.versionId, rv,
        JSON.stringify({ destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' })])).rowVersion;
      rv = (await inTx<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [v.versionId, rv,
        JSON.stringify({ contactName: 'Synthetic Contact', mobile: '6000500088', email: 'speed.contact@example.test', contactConfirmed: true,
          bookingFor: 'individual', payerDifferent: false, payerName: null }), JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road',
          addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }), 0, crypto.randomUUID()])).rowVersion;
      for (const itemId of items) {
        rv = (await inTx<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [itemId, v.versionId, rv, [1, 2]]))
          .rowVersion;
      }
      rv = (await inTx<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [v.versionId, rv,
        JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: '4567890', dueDate: '2026-12-01' }])])).rowVersion;
      for (const seq of [1, 2]) {
        const f = await inTx<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
          [deal, seq, crypto.randomUUID(), `id-${seq}.jpg`, 'image/jpeg', 2048, 'a'.repeat(64)]);
        await c.query(`insert into storage.objects (bucket_id, name, metadata) values ('traveller-id-proofs', $1, jsonb_build_object('size', 2048::bigint))`, [f.objectPath]);
        await inTx(S, 'select public.traveller_id_proof_finish($1, true) as r', [f.fileId]);
      }
      const ev = await inTx<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
        [v.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, 'b'.repeat(64)]);
      await c.query(`insert into storage.objects (bucket_id, name, metadata) values ('booking-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await inTx(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
      const ready = await inTx<{ contentHash: string; issues: string[] }>(S, 'select public.booking_readiness($1) as r', [v.versionId]);
      if (ready.issues.length) throw new Error(`speed draft not ready: ${ready.issues.join(',')}`);
      return [v.versionId, ready.contentHash];
    }, 'select public.booking_confirm($1, $2) as r', []);
    // supplier_payment_request_create on a seeded hotel task: booking request + Accounts go-ahead + proforma in the run's transaction.
    const hotel = (await c.query<{ id: string; a: string; deal: string }>(`select t.id, t.assignee_user_id as a, t.deal_id as deal from public.fulfilment_tasks t
      join public.deals d on d.id = t.deal_id join public.accounts_booking_reviews r on r.deal_id = d.id and r.status = 'approved'
      where d.reference like 'SYN-PERF-%' and t.department = 'purchase' and d.branch_id = (select id from public.branches where code = 'DEL' limit 1)
        and (select coalesce(sum(l.credit_paise - l.debit_paise), 0) from public.finance_journal_lines l where l.deal_id = d.id and l.account = 'customer_advances') > 100000
      order by d.reference limit 1`)).rows[0]!;
    await extraForNotices('supplier payment request create', { userId: hotel.a }, async () => {
      // Seeded hotel items carry no budget: the Delhi Manager approves the cost above budget first (as the screens require).
      await inTx(U.managerDelhi, 'select public.purchase_cost_approve_over_budget($1, $2) as r', [hotel.id, 1]);
      await inTx(hotel.a, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
        [hotel.id, 1, 'desk@example.test', [], 'Booking request · SYN-PERF · Synthetic', 'Synthetic body.', crypto.randomUUID()]);
      const g = (await c.query<{ id: string; row_version: number }>(`select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`,
        [hotel.id])).rows[0]!;
      await inTx(U.accountsJodhpur, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [g.id, 'approve', null, g.row_version, crypto.randomUUID()]);
      const pf = await inTx<{ evidenceId: string; objectPath: string }>(hotel.a, 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        ['proforma', hotel.id, 'proforma.pdf', 'application/pdf', 2048, 'c'.repeat(64), crypto.randomUUID()]);
      await c.query(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`, [pf.objectPath]);
      await inTx(hotel.a, 'select public.supplier_money_evidence_finish($1, true) as r', [pf.evidenceId]);
      return [hotel.id, JSON.stringify({ expectedCostVersionNo: 1, part: 'deposit', amountPaise: '50000', dueDate: null, note: null,
        proformaEvidenceId: pf.evidenceId, askFunding: false }), crypto.randomUUID()];
    }, 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', []);
    expect(results.filter((r) => r.measure.startsWith('extra time') && !r.pass).map((r) => `${r.measure}: +${r.p95Ms} ms`)).toEqual([]);
  }, 900_000);
});
