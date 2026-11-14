import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACC2_FIXTURE_USERS as U2, type Actor, FIXTURE_USERS as U, assertDatabaseUrlNotOperational, claimsFor } from '../helpers/db';

/**
 * Accounts Phase 3 speed tests, database part (contract
 * accounts-phase3-2026-11-12 section 16.5 = plan §9), Track T. Written from
 * the contract, not from the tracks' code. Needs the REAL local stack seeded
 * with scripts/seed-local.mjs, scripts/perf/accounts-volume.sql,
 * accounts2-volume.sql and then accounts3-volume.sql (30,000 customer
 * messages, 2,000 contracts / 40,000 rate lines, 500 change requests / 800
 * reconfirmations, 3,000 push devices, 5,000 write-offs, 20,000 Tally XML
 * lines). Skips without TEST_DATABASE_URL; refuses non-loopback URLs.
 *
 * Conditions as Phase 1 §12.7: each measure 30 times after one warm-up as
 * the signed-in role (PostgREST claims, SET LOCAL ROLE authenticated), every
 * run in a rolled-back transaction, median and p95 against the target; the
 * explain plan of each read is captured once. Background load (10 users)
 * comes from scripts/perf/accounts3-load.mjs started separately
 * (ACCOUNTS_LOAD=1 records it).
 *
 * Targets (p95, 16.5): automatic bill draft and checks add ≤ 100 ms to the
 * step that caused it; message and bill triggers together add ≤ 100 ms to a
 * command; "Messages to customer" card ≤ 150 ms (its addition to the Deal
 * page); contract rate lookup ≤ 300 ms; rate-sheet dry run of 5,000 lines
 * ≤ 30 s; change history ≤ 1.5 s; change request create / approve / open
 * version ≤ 800 ms each (submit, reconfirm and apply are timed in
 * accounts3-speed.real.e2e.ts on fresh bookings); Tally file of 1,000
 * entries ≤ 10 s; matching upload preview of 1,000 vouchers ≤ 15 s; small
 * balances and Bills to check ≤ 300 ms; timer tick with empty queues ≤ 2 s.
 * A miss fails the test and blocks the release until fixed or accepted in
 * writing by the owner. Output: test-results/speed-accounts-phase3.json.
 */

const url = process.env.TEST_DATABASE_URL?.trim() ?? '';
const RUNS = Number(process.env.SPEED_RUNS ?? 30);
type Row = { measure: string; medianMs: number; p95Ms: number; targetMs: number; targetOn: 'p95' | 'median'; pass: boolean; plan?: string };
const results: Row[] = [];

let c: pg.Client;
let seeded = false;
let entity = '';
const ACC: Actor = { userId: U.accountsJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const SUPER: Actor = { userId: U.adminJodhpur };

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
async function asActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
    await c.query(actor.role === 'service_role' ? 'set local role service_role' : 'set local role authenticated');
    return await fn();
  } finally {
    await c.query('rollback');
  }
}
/** One statement as `userId` inside the caller's open transaction (role back to the owner afterwards). */
async function inTx<T = unknown>(userId: string, sql: string, params: unknown[]): Promise<T> {
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor({ userId }))]);
  await c.query('set local role authenticated');
  const r = (await c.query<{ r: T }>(sql, params)).rows[0]!.r;
  await c.query('reset role');
  return r;
}
/** 1 warm-up + RUNS timed runs of `sql` as `actor`; `setup` (owner, same transaction) gives the parameters of each run. */
async function measure(name: string, actor: Actor, sql: string, params: unknown[] | (() => Promise<unknown[]>), targetMs: number,
  targetOn: 'p95' | 'median' = 'p95', runs = RUNS) {
  const times: number[] = [];
  for (let i = 0; i <= runs; i += 1) {
    await c.query('begin');
    try {
      const p = typeof params === 'function' ? await params() : params;
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
      await c.query(actor.role === 'service_role' ? 'set local role service_role' : 'set local role authenticated');
      const t0 = performance.now();
      await c.query(sql, p);
      if (i > 0) times.push(performance.now() - t0);
    } finally {
      await c.query('rollback');
    }
  }
  let plan: string | undefined;
  if (typeof params !== 'function') {
    plan = await asActor(actor, async () => (await c.query(`explain (analyze, buffers, format text) ${sql}`, params)).rows
      .map((r: Record<string, string>) => r['QUERY PLAN']).join('\n'));
  }
  const row: Row = { measure: name, medianMs: Math.round(pct(times, 50)), p95Ms: Math.round(pct(times, 95)), targetMs, targetOn,
    pass: (targetOn === 'p95' ? pct(times, 95) : pct(times, 50)) <= targetMs, plan };
  results.push(row);
  return row;
}
/** The same command with the Phase 3 switches on and off (setup and command in one rolled-back run each): p95 difference ≤ target. */
async function extraFrom(name: string, actor: Actor, switches: (on: boolean) => Promise<void>, setup: () => Promise<unknown[]>, sql: string, targetMs: number) {
  const run = async (on: boolean) => {
    const times: number[] = [];
    for (let i = 0; i <= RUNS; i += 1) {
      await c.query('begin');
      try {
        await switches(on);
        const p = await setup();
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
  results.push({ measure: `extra time: ${name}`, medianMs: Math.round(on), p95Ms: Math.round(on - off), targetMs, targetOn: 'p95', pass: on - off <= targetMs });
}
const misses = (filter: (r: Row) => boolean) => results.filter((r) => filter(r) && !r.pass).map((r) => `${r.measure}: p95 ${r.p95Ms} ms`);
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Owner SQL inside the measured run: Phase 2 + Phase 3 accounts switches on for the transaction only (settings guard: row_version + 1). */
async function accountsSwitches(on: boolean): Promise<void> {
  await c.query(`update public.accounts_settings set customer_documents_enabled = $2, auto_bills_enabled = $2, auto_bill_release_enabled = true,
    write_off_enabled = $2, tally_xml_enabled = $2, tally_company_name = coalesce(tally_company_name, 'Synthetic Perf Company'),
    row_version = row_version + 1 where legal_entity_id = $1`, [entity, on]);
}
/** Owner SQL: every customer message switch, pilot mode Off and every template approved (or all Off). */
async function messageSwitches(on: boolean): Promise<void> {
  await c.query('update public.customer_message_switches set enabled = $2 where legal_entity_id = $1', [entity, on]);
  await c.query('update public.customer_message_settings set pilot_only = not $2 where legal_entity_id = $1', [entity, on]);
  if (on) await c.query(`update public.whatsapp_templates set status = 'approved' where legal_entity_id = $1`, [entity]);
}
async function activatePhase2People(): Promise<void> {
  await c.query(`update public.memberships set status = 'active', deactivated_at = null where user_id = any ($1::uuid[]) and status = 'inactive'`,
    [[U2.accountsJodhpur2, U2.managerJodhpur]]);
}

beforeAll(async () => {
  if (!url) return;
  await assertDatabaseUrlNotOperational(url);
  c = new pg.Client({ connectionString: url });
  await c.connect();
  const r = (await c.query<{ m: number; rc: number; wo: number }>(`select
      (select count(*) from public.customer_messages)::int as m,
      (select count(*) from public.rate_contracts where note = 'SYN-PERF rate contract')::int as rc,
      (select count(*) from public.deal_write_offs where ref_no like 'WO-2026-5%')::int as wo`).catch(() => ({ rows: [{ m: 0, rc: 0, wo: 0 }] }))).rows[0]!;
  seeded = r.m >= 30_000 && r.rc >= 2000 && r.wo >= 5000;
  entity = (await c.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`)).rows[0]!.id;
}, 120_000);

afterAll(async () => {
  if (results.length) {
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', 'speed-accounts-phase3.json'), JSON.stringify({ at: new Date().toISOString(), runs: RUNS,
      backgroundLoad: process.env.ACCOUNTS_LOAD === '1', commit: process.env.GITHUB_SHA ?? null, results }, null, 2));
    console.info(['measure | median ms | p95 ms | target | pass', ...results.map((x) =>
      `${x.measure} | ${x.medianMs} | ${x.p95Ms} | ${x.targetOn} ≤ ${x.targetMs} | ${x.pass ? 'pass' : 'MISS'}`)].join('\n'));
  }
  await c?.end();
});

describe.skipIf(!url)('Accounts phase 3 speed (database, contract 16.5)', () => {
  it('seeded volume present', () => {
    expect(seeded, 'run scripts/perf/accounts-volume.sql, accounts2-volume.sql and accounts3-volume.sql on this local stack first').toBe(true);
  });

  it('small balances and Bills to check ≤ 300 ms (A and M, presets, next page)', async () => {
    if (!seeded) return;
    const SB = 'select public.small_balances_list($1::jsonb, $2, $3) as r';
    // ASSUMPTION: p_filter jsonb with key `preset` (to_propose, to_approve, needs_review), as the Phase 2 lists.
    for (const preset of [null, 'to_propose', 'to_approve', 'needs_review']) {
      await measure(`small balances · A · ${preset ?? 'all'}`, ACC, SB, [JSON.stringify(preset ? { preset } : {}), null, 50], 300);
    }
    await measure('small balances · M · to_approve', MANAGER, SB, [JSON.stringify({ preset: 'to_approve' }), null, 50], 300);
    const first = await asActor(ACC, async () => (await c.query<{ r: { nextAfter?: string | null } | null }>(SB, [JSON.stringify({}), null, 50])).rows[0]!.r);
    if (first?.nextAfter) await measure('small balances · next page (keyset)', ACC, SB, [JSON.stringify({}), first.nextAfter, 50], 300);
    const DOCS = 'select public.customer_documents_list($1::jsonb, $2, $3) as r';
    // ASSUMPTION: the new preset is passed as {preset: 'toCheck'}; autoState filter as {autoState: 'held'}.
    await measure('Bills to check (preset toCheck)', ACC, DOCS, [JSON.stringify({ preset: 'toCheck' }), null, 50], 300);
    await measure('documents list · autoState held', ACC, DOCS, [JSON.stringify({ autoState: 'held' }), null, 50], 300);
    await measure('write-off monthly totals (M)', MANAGER, 'select public.write_off_monthly($1::date) as r', [`${istToday().slice(0, 7)}-01`], 300);
    expect(misses((r) => /small balances|Bills|documents|monthly/.test(r.measure))).toEqual([]);
  }, 900_000);

  it('"Messages to customer" card ≤ 150 ms (SO, M, A); Settings › Customer messages read', async () => {
    if (!seeded) return;
    const busiest = (await c.query<{ id: string; owner: string }>(`select m.deal_id as id, d.owner_user_id as owner from public.customer_messages m
      join public.deals d on d.id = m.deal_id group by m.deal_id, d.owner_user_id order by count(*) desc limit 1`)).rows[0]!;
    const CARD = 'select public.deal_customer_messages($1) as r';
    await measure('Messages card · A (busiest Deal)', ACC, CARD, [busiest.id], 150);
    await measure('Messages card · branch M', MANAGER, CARD, [busiest.id], 150);
    await measure('Messages card · Sales owner', { userId: busiest.owner }, CARD, [busiest.id], 150);
    await measure('Settings › Customer messages (R-A2)', SUPER, 'select public.admin_customer_messages($1) as r', [entity], 300);
    expect(misses((r) => r.measure.startsWith('Messages card'))).toEqual([]);
  }, 900_000);

  it('contract rate lookup ≤ 300 ms (two seasons, weekend nights); rate contracts list', async () => {
    if (!seeded) return;
    // A seeded active contract and one of its hotel's room types.
    const k = (await c.query<{ supplier: string; hotel: string; room: string }>(`select r.supplier_id as supplier, r.hotel_id as hotel,
        t.id as room from public.rate_contracts r
      join lateral (select id from public.hotel_room_types t where t.hotel_id = r.hotel_id and t.status = 'active' order by name limit 1) t on true
      where r.note = 'SYN-PERF rate contract' and r.status = 'active' order by r.contract_no limit 1`)).rows[0]!;
    const task = (await c.query<{ id: string }>(`select t.id from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
      where d.reference like 'SYN-PERF-%' and t.department = 'purchase' limit 1`)).rows[0]!.id;
    await c.query('update public.procurement_settings set rate_contracts_enabled = true where true').catch(() => undefined);
    await measure('contract rate lookup (R-E3)', PURCHASE, 'select public.rate_contract_lookup($1, $2, $3, $4, $5) as r', async () => {
      await c.query('update public.procurement_settings set rate_contracts_enabled = true where true');
      return [task, k.supplier, k.hotel, k.room, 'CP'];
    }, 300);
    // The task's own stay dates are used (9.2: never typed again); a second meal plan exercises another line set.
    await measure('contract rate lookup (R-E3), MAP', PURCHASE, 'select public.rate_contract_lookup($1, $2, $3, $4, $5) as r', async () => {
      await c.query('update public.procurement_settings set rate_contracts_enabled = true where true');
      return [task, k.supplier, k.hotel, k.room, 'MAP'];
    }, 300);
    await measure('rate contracts list (P)', PURCHASE, 'select public.rate_contracts_list($1::jsonb, $2, $3) as r', [JSON.stringify({}), null, 50], 300);
    await measure('rate contracts list (M, to_approve)', MANAGER, 'select public.rate_contracts_list($1::jsonb, $2, $3) as r',
      [JSON.stringify({ preset: 'to_approve' }), null, 50], 300);
    expect(misses((r) => /rate|price/.test(r.measure))).toEqual([]);
  }, 900_000);

  it('rate-sheet dry run of 5,000 lines ≤ 30 s', async () => {
    if (!seeded) return;
    const pairs = (await c.query<{ s: string; h: string }>(`select s.source_ref as s, h.source_ref as h from public.supplier_hotels l
      join public.suppliers s on s.id = l.supplier_id join public.hotel_catalogue h on h.id = l.hotel_id
      where s.source_ref like 'PERF:S-%' and h.source_ref like 'PERF:H-%' order by s.source_ref limit 250`)).rows;
    const year = Number(istToday().slice(0, 4)) + 1;
    // 250 contracts × 20 lines (3 room types × 3 meal plans × 2 seasons + 2) = 5,000 rows (contract 9.4 columns).
    const rows = pairs.flatMap((p, i) => {
      const lines: Array<Record<string, unknown>> = [];
      for (const season of [1, 2]) for (const room of ['Deluxe Room', 'Premium Room', 'Family Suite']) for (const meal of ['EP', 'CP', 'MAP']) {
        lines.push({ supplierRef: p.s, hotelRef: p.h, validFrom: `${year}-01-01`, validTo: `${year}-12-31`,
          seasonFrom: season === 1 ? `${year}-01-01` : `${year}-07-01`, seasonTo: season === 1 ? `${year}-06-30` : `${year}-12-31`, roomType: room,
          mealPlan: meal, rate: String(4000 + i % 50 * 10), weekendRate: i % 3 ? null : '4500', extraAdult: '1500', childWithBed: '1000',
          childWithoutBed: null, blackoutDates: i % 5 ? null : `${year}-12-24..${year}-12-26`, cancellationTerms: 'Synthetic speed terms' });
      }
      lines.push({ ...lines[0]!, roomType: 'Deluxe Room', mealPlan: 'AI', seasonFrom: `${year}-01-01`, seasonTo: `${year}-12-31`, rate: '9000' });
      lines.push({ ...lines[0]!, roomType: 'Premium Room', mealPlan: 'AI', seasonFrom: `${year}-01-01`, seasonTo: `${year}-12-31`, rate: '9500' });
      return lines;
    }).slice(0, 5000);
    expect(rows.length).toBe(5000);
    // ASSUMPTION: the rate sheet uses the Phase 2 import_batch_stage (entity, kind, scope, file name, sha, rows, request) and
    // import_batch_validate (batch) as the dry run (contract 9.4 "existing upload").
    await measure('rate-sheet dry run (5,000 lines: stage + validate)', PURCHASE, 'select public.import_batch_validate($1) as r', async () => {
      await c.query('update public.procurement_settings set rate_contracts_enabled = true where true');
      const staged = await inTx<{ batchId: string }>(U.purchaseJodhpur,
        'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, gen_random_uuid()) as r',
        [entity, 'rate_sheet', null, 'speed rate sheet.csv', 'f'.repeat(64), JSON.stringify(rows)]);
      return [staged.batchId];
    }, 30_000, 'p95', 3);
    expect(misses((r) => r.measure.startsWith('rate-sheet'))).toEqual([]);
  }, 1_800_000);

  it('change history ≤ 1.5 s; change request create / approve / open version ≤ 800 ms each', async () => {
    if (!seeded) return;
    const busiest = (await c.query<{ id: string; owner: string }>(`select r.deal_id as id, d.owner_user_id as owner from public.booking_change_requests r
      join public.deals d on d.id = r.deal_id where r.ref_no like 'CR-2026-6%' group by r.deal_id, d.owner_user_id order by count(*) desc, r.deal_id limit 1`)).rows[0]!;
    const HIST = 'select public.deal_change_history($1) as r';
    await measure('change history (R-G4) · M', MANAGER, HIST, [busiest.id], 1500);
    await measure('change history (R-G4) · A', ACC, HIST, [busiest.id], 1500);
    await measure('change history (R-G4) · Sales owner', { userId: busiest.owner }, HIST, [busiest.id], 1500);
    await measure('Deal change requests card (R-G1)', MANAGER, 'select public.deal_change_requests($1) as r', [busiest.id], 800);
    await measure('change requests list (M, to_approve)', MANAGER, 'select public.change_requests_list($1::jsonb, $2, $3) as r',
      [JSON.stringify({ preset: 'to_approve' }), null, 50], 300);
    // Change request create (draft) and change version open on a perf Deal (Addendum O2 order: create -> open -> the Sales owner fills it
    // -> submit -> the Manager approves). The perf seed's Deals are skeletal (no supplier-confirmed hotel, no hotel facts row, no booking
    // contact), so each rolled-back run first confirms one perf hotel task and gives its item a facts row (SYNTHETIC FIXTURE STEP, not
    // timed). Submit, Manager approval and reconfirm need a complete booking: tests/e2e/accounts3-speed.real.e2e.ts times them on fresh bookings.
    const deal = (await c.query<{ id: string; owner: string; task: string; item: string }>(`select d.id, d.owner_user_id as owner, t.id as task,
        t.service_item_id as item from public.deals d
      join public.fulfilment_tasks t on t.deal_id = d.id and t.department = 'purchase' and t.status = 'in_progress' and t.closed_state is null
      join public.accounts_booking_reviews a on a.deal_id = d.id and a.status = 'approved'
      where d.reference like 'SYN-PERF-%' and exists (select 1 from public.purchase_quotes q where q.task_id = t.id)
        and not exists (select 1 from public.booking_change_requests r where r.deal_id = d.id)
      order by d.reference desc limit 1`)).rows[0];
    expect(deal, 'a perf Deal with an approved review, a quoted hotel task and no change request (accounts3-volume.sql)').toBeDefined();
    const fields = JSON.stringify({ kind: 'change', itemIds: [deal!.item], changeSummary: 'Synthetic speed: room type to a suite',
      reason: 'Synthetic speed: customer asked for a bigger room' });
    const committedHotel = async () => {
      await c.query('update public.booking_change_settings set changes_enabled = true where true');
      await c.query(`update public.fulfilment_tasks t set status = 'supplier_confirmed', supplier_reference = 'SYN-PERF-CONF',
        supplier_confirmed_by = t.assignee_user_id, supplier_confirmed_at = now(),
        selected_quote_id = (select q.id from public.purchase_quotes q where q.task_id = t.id order by q.created_at limit 1) where t.id = $1`, [deal!.task]);
      await c.query('set local session_replication_role = replica');
      await c.query(`insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts, purchase_budget_paise, facts_hash)
        select i.id, v.id, i.legal_entity_id, f.facts, 20000000, encode(sha256(convert_to(f.facts::text, 'UTF8')), 'hex')
        from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
        join public.booking_versions v on v.deal_id = t.deal_id and v.status = 'confirmed'
        cross join lateral (select jsonb_build_object('hotelName', 'Synthetic Perf Hotel', 'city', 'Synthetic City', 'checkIn', v.trip_start::text,
          'checkOut', (v.trip_start + 3)::text, 'rooms', 1, 'adults', 2, 'roomType', 'Synthetic Deluxe', 'mealPlan', 'Breakfast') as facts) f
        where t.id = $1 on conflict do nothing`, [deal!.task]);
      await c.query('set local session_replication_role = origin');
    };
    const CREATE = 'select public.booking_change_request_create($1, $2::jsonb, gen_random_uuid()) as r';
    await measure('change request create (G2, draft)', { userId: deal!.owner }, CREATE, async () => { await committedHotel(); return [deal!.id, fields]; }, 800);
    await measure('change version open (G5)', { userId: deal!.owner }, 'select public.booking_change_open_version($1, gen_random_uuid()) as r', async () => {
      await committedHotel();
      const cr = await inTx<{ changeRequestId?: string; id?: string }>(deal!.owner, CREATE, [deal!.id, fields]);
      return [cr.changeRequestId ?? cr.id!];
    }, 800);
    expect(misses((r) => /change/.test(r.measure))).toEqual([]);
  }, 1_800_000);

  it('Tally file of 1,000 entries ≤ 10 s; matching upload preview of 1,000 vouchers ≤ 15 s; preview read', async () => {
    if (!seeded) return;
    const period = (await c.query<{ f: string; t: string }>(`select min(d)::text as f, max(d)::text as t from (select e.business_date as d
      from public.finance_journal_entries e join public.deals x on x.id = e.deal_id where x.reference like 'SYN-PERF-%'
      order by e.business_date desc limit 1000) y`)).rows[0]!;
    const FILE_ARGS = [entity, period.f, period.t, ['journal_entry', 'supplier_payment', 'supplier_refund', 'write_off'], null];
    await measure('Tally file preview (R-C2)', ACC, 'select public.accounts_tally_file_preview($1, $2::date, $3::date, $4::text[], $5::uuid[]) as r', async () => {
      await accountsSwitches(true);
      return FILE_ARGS;
    }, 10_000, 'p95', 10);
    await measure('Tally file create, about 1,000 entries (C3)', ACC,
      'select public.accounts_tally_file_create($1, $2::date, $3::date, $4::text[], $5::uuid[], true, $6, gen_random_uuid()) as r', async () => {
        await accountsSwitches(true);
        return [...FILE_ARGS, 'Synthetic speed: include the week again'];
      }, 10_000, 'p95', 5);
    const lines = (await c.query<{ narration: string }>(`select l."values"->>'narration' as narration from public.tally_export_lines l
      join public.tally_exports e on e.id = l.export_id where e.format = 'xml' order by e.created_at desc, l.line_no limit 1000`)).rows;
    // Staged row keys of accounts_tally_match_stage (proved by tests/db/acc3-c-tally-file.test.ts): tnTag, voucherRef, voucherDate,
    // voucherType, amountPaise. The tag is the TN:<file>/<line> at the end of the frozen narration.
    const rows = lines.map((l, i) => ({ tnTag: /TN:\S+$/.exec(l.narration ?? '')?.[0] ?? null, voucherRef: `SPD-${i + 1}`, voucherDate: istToday(),
      voucherType: i % 2 ? 'Receipt' : 'Journal', amountPaise: i % 50 ? '100000' : '100100' }));
    await measure('Tally matching upload preview, 1,000 vouchers (C4)', ACC,
      'select public.accounts_tally_match_stage($1, $2, $3, $4::jsonb, gen_random_uuid()) as r', async () => {
        await accountsSwitches(true);
        return [entity, 'speed-daybook.xml', Math.random().toString(16).slice(2).padEnd(64, 'a').slice(0, 64), JSON.stringify(rows)];
      }, 15_000, 'p95', 5);
    await measure('Tally files list (R-C1)', ACC, 'select public.accounts_tally_exports($1) as r', [50], 300);
    expect(misses((r) => /Tally/.test(r.measure))).toEqual([]);
  }, 1_800_000);

  it('timer tick with empty queues ≤ 2 s', async () => {
    if (!seeded) return;
    await measure('timer tick, empty queues (service role)', { userId: null, role: 'service_role' }, 'select public.timer_tick() as r', async () => {
      await c.query(`update public.customer_messages set next_attempt_at = now() + interval '1 day' where status in ('queued', 'sending')`);
      await c.query(`update public.staff_push_jobs set available_at = now() + interval '1 day' where status in ('queued', 'sending')`).catch(() => undefined);
      return [];
    }, 2000);
    expect(misses((r) => r.measure.startsWith('timer'))).toEqual([]);
  }, 900_000);

  it('automatic bill draft and checks add ≤ 100 ms; message and bill triggers together add ≤ 100 ms (receipt verify, review approve)', async () => {
    if (!seeded) return;
    // A perf Deal with an approved review and verified billing is not in the seed: verify a fresh cash receipt on a perf Deal
    // (recorded by Accounts Jodhpur, verified by Accounts Jodhpur 2) inside each run.
    const deal = (await c.query<{ id: string; branch: string }>(`select d.id, d.branch_id as branch from public.deals d
      join public.accounts_booking_reviews a on a.deal_id = d.id and a.status = 'approved'
      where d.reference like 'SYN-PERF-%' order by d.reference
      limit 1 offset (select count(*) / 2 from public.deals x join public.accounts_booking_reviews y on y.deal_id = x.id and y.status = 'approved'
        where x.reference like 'SYN-PERF-%')`)).rows[0]!;
    const setup = async () => {
      await activatePhase2People();
      const rec = await inTx<{ id: string }>(U.accountsJodhpur, 'select public.receipt_record($1, $2::jsonb, gen_random_uuid()) as r', [deal.id, JSON.stringify({
        mode: 'cash', amountPaise: '100000', receivedOn: istToday(), branchId: deal.branch, collectorUserId: U.accountsJodhpur,
        payerName: 'Synthetic Speed Payer', payerPan: `SPDQZ${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}Q` })]);
      return [rec.id];
    };
    const VERIFY = 'select public.receipt_verify($1, gen_random_uuid()) as r';
    const ACC_J2: Actor = { userId: U2.accountsJodhpur2 };
    await extraFrom('automatic bill draft and checks (receipt verify → Advance Invoice)', ACC_J2,
      async (on) => { await accountsSwitches(on); await messageSwitches(false); }, setup, VERIFY, 100);
    await extraFrom('message + bill triggers together (receipt verify)', ACC_J2,
      async (on) => { await accountsSwitches(on); await messageSwitches(on); }, setup, VERIFY, 100);
    expect(misses((r) => r.measure.startsWith('extra time'))).toEqual([]);
  }, 1_800_000);
});
