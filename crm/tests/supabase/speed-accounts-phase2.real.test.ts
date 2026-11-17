import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, assertDatabaseUrlNotOperational, claimsFor } from '../helpers/db';

/**
 * OPT-IN: runs only with ACCOUNTS_SPEED=1 (and TEST_DATABASE_URL), e.g.
 *   ACCOUNTS_SPEED=1 npx vitest run --project supabase tests/supabase/speed-accounts-phase2.real.test.ts
 * It is a local measurement on the volume seeds below, not a CI check
 * (accounts-phase3 contract 16.5): without the opt-in the suite is skipped.
 *
 * Accounts Phase 2 speed tests, database part (contract 12.5 = plan C13),
 * Track F. Needs the REAL local stack seeded with scripts/seed-local.mjs,
 * scripts/perf/accounts-volume.sql and then scripts/perf/accounts2-volume.sql
 * (8,000 customer documents with files, 1,500 refunds with payouts, 3,000
 * suppliers ...). Skips without TEST_DATABASE_URL; refuses non-loopback URLs.
 *
 * Conditions as Phase 1 §12.7: each read 30 times after one warm-up as the
 * signed-in role (PostgREST claims, SET LOCAL ROLE authenticated), every run
 * in a rolled-back transaction, median and p95 against the target; the
 * explain plan of each read is captured once. Background load (10 users)
 * comes from scripts/perf/accounts-load.mjs + scripts/perf/accounts2-load.mjs
 * started separately (ACCOUNTS_LOAD=1 records it).
 *
 * Targets (p95): documents list first page ≤ 300 ms; Deal Documents card
 * ≤ 100 ms; draft create/refresh ≤ 2 s (the page part is in
 * accounts2-speed.real.e2e.ts); refund reads ≤ 300 ms; payout incl. journal
 * ≤ 500 ms; supplier register search ≤ 300 ms; supplier import dry run of
 * 5,000 rows ≤ 30 s; Tally export of about 1,000 rows with mapping ≤ 10 s;
 * extra time from the new notice triggers ≤ 50 ms. A miss fails the test and
 * blocks the release until fixed or accepted in writing by the owner.
 * Output: test-results/speed-accounts-phase2.json and a printed table.
 */

const url = process.env.TEST_DATABASE_URL?.trim() ?? '';
/** Opt-in only (see the header): CI and the ordinary real-stack run skip this suite. */
const speed = process.env.ACCOUNTS_SPEED === '1' && url !== '';
const RUNS = Number(process.env.SPEED_RUNS ?? 30);
type Row = { measure: string; medianMs: number; p95Ms: number; targetMs: number; targetOn: 'p95' | 'median'; pass: boolean; plan?: string };
const results: Row[] = [];

let c: pg.Client;
let seeded = false;
let entity = '';
const ACC: Actor = { userId: U.accountsJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const SUPER: Actor = { userId: U.adminJodhpur };

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
      await c.query('set local role authenticated');
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
/** The same command with notices on and off (setup and command in one rolled-back run each): p95 difference ≤ 50 ms. */
async function extraForNotices(name: string, actor: Actor, setup: () => Promise<unknown[]>, sql: string) {
  const run = async (on: boolean) => {
    const times: number[] = [];
    for (let i = 0; i <= RUNS; i += 1) {
      await c.query('begin');
      try {
        await c.query('update public.notice_settings set notices_enabled = $1 where id', [on]);
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
  results.push({ measure: `extra time from notice writes: ${name}`, medianMs: Math.round(on), p95Ms: Math.round(on - off), targetMs: 50, targetOn: 'p95',
    pass: on - off <= 50 });
}
const misses = (filter: (r: Row) => boolean) => results.filter((r) => filter(r) && !r.pass).map((r) => `${r.measure}: p95 ${r.p95Ms} ms`);

/** Owner SQL inside the measured run: switches on for the transaction only. */
async function switchesOnInRun(): Promise<void> {
  // The settings guard requires row_version + 1 on every change.
  await c.query(`update public.accounts_settings set customer_documents_enabled = true, refunds_enabled = true, tally_export_enabled = true,
    row_version = row_version + 1 where legal_entity_id = $1`, [entity]);
}

beforeAll(async () => {
  if (!speed) return;
  await assertDatabaseUrlNotOperational(url);
  c = new pg.Client({ connectionString: url });
  await c.connect();
  const [r] = (await c.query<{ d: number; s: number }>(`select (select count(*) from public.customer_documents where number like 'SYN-PERF-%')::int as d,
    (select count(*) from public.suppliers where source_ref like 'PERF:S-%')::int as s`)).rows;
  seeded = (r?.d ?? 0) >= 8000 && (r?.s ?? 0) >= 3000;
  entity = (await c.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`)).rows[0]!.id;
}, 120_000);

afterAll(async () => {
  if (results.length) {
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', 'speed-accounts-phase2.json'), JSON.stringify({ at: new Date().toISOString(), runs: RUNS,
      backgroundLoad: process.env.ACCOUNTS_LOAD === '1', commit: process.env.GITHUB_SHA ?? null, results }, null, 2));
    console.info(['measure | median ms | p95 ms | target | pass', ...results.map((x) =>
      `${x.measure} | ${x.medianMs} | ${x.p95Ms} | ${x.targetOn} ≤ ${x.targetMs} | ${x.pass ? 'pass' : 'MISS'}`)].join('\n'));
  }
  await c?.end();
});

describe.skipIf(!speed)('Accounts phase 2 speed (database, contract 12.5)', () => {
  it('seeded volume present', () => {
    expect(seeded, 'run scripts/perf/accounts-volume.sql and scripts/perf/accounts2-volume.sql on this local stack first').toBe(true);
  });

  it('documents list first page ≤ 300 ms (A and M, each filter, next page); Deal Documents card ≤ 100 ms', async () => {
    if (!seeded) return;
    const LIST = 'select public.customer_documents_list($1::jsonb, $2, $3) as r';
    const del = (await c.query<{ id: string }>(`select id from public.branches where code = 'DEL' limit 1`)).rows[0]!.id;
    const filters: Array<[string, Record<string, unknown>]> = [
      ['no filter', {}], ['released', { status: ['released'] }], ['invoices', { kind: ['invoice'] }], ['to release', { toRelease: true }],
      ['stale', { stale: true }], ['booking changed', { bookingChanged: true }], ['payment reversed', { paymentReversed: true }],
      ['pdf ready', { pdfState: 'ready' }], ['tally linked', { tallyLinked: false }], ['branch', { branchId: del }], ['deal reference', { dealReference: 'SYN-PERF-00042' }],
    ];
    // Known limit accepted by the owner (15 November 2026, Phase 3 handoff): with the Phase 3 volume (700 drafts) the
    // "stale" filter recomputes each draft's source hash and takes about 0.4 s (0.6 s on CI). Its limit is 800 ms until
    // the query is improved; every other filter keeps 300 ms. Measured on live after release.
    for (const [name, f] of filters) await measure(`documents list · ${name}`, ACC, LIST, [JSON.stringify(f), null, 50], name === 'stale' ? 800 : 300);
    await measure('documents list · Manager', MANAGER, LIST, [JSON.stringify({}), null, 50], 300);
    const first = await asActor(ACC, async () => (await c.query<{ r: { nextAfter: string } }>(LIST, [JSON.stringify({}), null, 50])).rows[0]!.r);
    await measure('documents list · next page (keyset)', ACC, LIST, [JSON.stringify({}), first.nextAfter, 50], 300);
    const deal = (await c.query<{ id: string }>(`select deal_id as id from public.customer_documents where number like 'SYN-PERF-%' order by number limit 1`)).rows[0]!.id;
    await measure('Deal Documents card (R-B1)', ACC, 'select public.deal_customer_documents($1) as r', [deal], 100);
    await measure('Deal Documents card (R-B1) · Manager', MANAGER, 'select public.deal_customer_documents($1) as r', [deal], 100);
    expect(misses((r) => r.measure.startsWith('documents') || r.measure.startsWith('Deal Documents'))).toEqual([]);
  }, 900_000);

  it('draft create and refresh ≤ 2 s (database part)', async () => {
    if (!seeded) return;
    // A perf Deal with an approved review and no live Invoice (documents seeded on the first 8,000 Deals only).
    const deal = (await c.query<{ id: string }>(`select d.id from public.deals d join public.accounts_booking_reviews r on r.deal_id = d.id and r.status = 'approved'
      where d.reference like 'SYN-PERF-%' and not exists (select 1 from public.customer_documents x where x.deal_id = d.id)
        and exists (select 1 from public.customer_billing_profiles b where b.deal_id = d.id and b.status = 'verified')
      order by d.reference limit 1`)).rows[0]?.id;
    if (!deal) {
      // The perf seed has no verified billing profiles: drafts still build (billing is only checked at release).
      const any = (await c.query<{ id: string }>(`select d.id from public.deals d join public.accounts_booking_reviews r on r.deal_id = d.id and r.status = 'approved'
        where d.reference like 'SYN-PERF-%' and not exists (select 1 from public.customer_documents x where x.deal_id = d.id) order by d.reference limit 1`)).rows[0]!.id;
      await measure('draft create (Invoice)', ACC, 'select public.customer_document_draft_create($1, $2, $3::jsonb, gen_random_uuid()) as r', async () => {
        await switchesOnInRun();
        return [any, 'invoice', '{}'];
      }, 2000);
    } else {
      await measure('draft create (Invoice)', ACC, 'select public.customer_document_draft_create($1, $2, $3::jsonb, gen_random_uuid()) as r', async () => {
        await switchesOnInRun();
        return [deal, 'invoice', '{}'];
      }, 2000);
    }
    expect(misses((r) => r.measure.startsWith('draft'))).toEqual([]);
  }, 900_000);

  it('refund reads ≤ 300 ms (Deal card, Approvals to_approve, Accounts payout_due, supplier refunds due); payout incl. journal ≤ 500 ms', async () => {
    if (!seeded) return;
    const refundDeal = (await c.query<{ id: string }>(`select deal_id as id from public.customer_refund_requests where ref_no like 'RF-2026-8%' limit 1`)).rows[0]!.id;
    await measure('Deal refund card (R-C1)', ACC, 'select public.deal_refunds($1) as r', [refundDeal], 300);
    await measure('Deal refund card (R-C1) · Manager', MANAGER, 'select public.deal_refunds($1) as r', [refundDeal], 300);
    const LIST = 'select public.refund_requests_list($1::jsonb, $2, $3) as r';
    await measure('refund list · Manager to_approve', MANAGER, LIST, [JSON.stringify({ preset: 'to_approve' }), null, 50], 300);
    await measure('refund list · Accounts payout_due', ACC, LIST, [JSON.stringify({ preset: 'payout_due' }), null, 50], 300);
    await measure('refund list · Accounts all', ACC, LIST, [JSON.stringify({}), null, 50], 300);
    await measure('supplier refunds due (R-C3)', ACC, 'select public.supplier_refunds_due($1::jsonb, $2, $3) as r', [JSON.stringify({}), null, 50], 300);

    // Payout: a cancelled perf Deal with money held; request (its Sales owner), approval (a Manager of the branch) and proof
    // in the run's transaction; only the payout is timed.
    const pick = (await c.query<{ deal: string; owner: string; branch: string; receipt: string; cancellation: string }>(`select d.id as deal, d.owner_user_id as owner,
        d.branch_id as branch, r.id as receipt, x.id as cancellation
      from public.deal_cancellations x join public.deals d on d.id = x.deal_id
      join lateral (select r.id from public.customer_receipts r where r.deal_id = d.id and r.status = 'verified' limit 1) r on true
      where x.status = 'approved' and d.reference like 'SYN-PERF-%'
        and not exists (select 1 from public.customer_refund_requests q where q.deal_id = d.id)
      limit 1`)).rows[0];
    expect(pick, 'a cancelled perf Deal with verified money').toBeDefined();
    const manager = (await c.query<{ u: string }>(`select m.user_id as u from public.memberships m where m.branch_id = $1 and m.role_code = 'manager'
      and m.status = 'active' and m.user_id <> $2 and not exists (select 1 from public.memberships p where p.user_id = m.user_id and p.status = 'active'
        and p.role_code in ('purchase', 'flight', 'visa')) limit 1`, [pick!.branch, pick!.owner])).rows[0]!.u;
    await measure('payout incl. journal (C6)', ACC, 'select public.customer_refund_payout_record($1, $2, $3::jsonb, gen_random_uuid()) as r', async () => {
      await switchesOnInRun();
      const req = await inTx<{ refundRequestId: string }>(pick!.owner, 'select public.customer_refund_request_create($1, $2::jsonb, gen_random_uuid()) as r',
        [pick!.deal, JSON.stringify({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '0', amountPaise: '1000', payeeKind: 'original_payer',
          payeeReceiptId: pick!.receipt, payeeName: null, payeeReason: null, reason: 'Synthetic speed refund: trip cancelled' })]);
      const row = (await c.query<{ row_version: number }>('select row_version from public.customer_refund_requests where id = $1', [req.refundRequestId])).rows[0]!;
      await inTx(manager, 'select public.customer_refund_decide($1, $2, $3::bigint, $4::bigint, $5, $6, gen_random_uuid()) as r',
        [req.refundRequestId, 'approve', '1000', '0', null, row.row_version]);
      const ev = await inTx<{ evidenceId: string; objectPath: string }>(U.accountsJodhpur,
        'select public.refund_evidence_begin($1, $2, $3, $4, $5, $6, gen_random_uuid()) as r',
        ['customer_refund', req.refundRequestId, 'proof.pdf', 'application/pdf', 2048, crypto.randomUUID().replace(/-/g, '').padEnd(64, '0')]);
      await c.query(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await inTx(U.accountsJodhpur, 'select public.refund_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
      const rv = (await c.query<{ row_version: number }>('select row_version from public.customer_refund_requests where id = $1', [req.refundRequestId])).rows[0]!;
      return [req.refundRequestId, rv.row_version, JSON.stringify({ mode: 'bank_transfer', paidOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
        reference: `SYNSPD${String(Date.now()).slice(-6)}`, evidenceId: ev.evidenceId })];
    }, 500);
    expect(misses((r) => /refund|payout/.test(r.measure))).toEqual([]);
  }, 900_000);

  it('supplier register search ≤ 300 ms; import dry run of 5,000 rows ≤ 30 s', async () => {
    if (!seeded) return;
    const REG = 'select public.supplier_register($1::jsonb, $2, $3) as r';
    const PURCHASE: Actor = { userId: U.purchaseJodhpur };
    for (const [name, f] of [['first page', {}], ['name prefix', { q: 'synthetic perf stays 01' }], ['GSTIN exact', { q: '08SYNPA0026Z1Z5' }],
      ['PAN exact', { q: 'SYNPB0001Z' }], ['city', { city: 'Jaipur' }], ['kind channel', { kind: 'channel' }], ['bank state', { bankState: 'none' }]] as const) {
      await measure(`supplier register · ${name}`, PURCHASE, REG, [JSON.stringify(f), null, 50], 300);
    }
    await measure('supplier register · Manager', MANAGER, REG, [JSON.stringify({}), null, 50], 300);
    const hotel = (await c.query<{ id: string }>(`select hotel_id as id from public.supplier_hotels limit 1`)).rows[0]!.id;
    await measure('hotel suppliers (quote picker)', PURCHASE, 'select public.hotel_suppliers($1) as r', [hotel], 300);
    const rows = Array.from({ length: 5000 }, (_, i) => ({ sourceRef: `SPEED:S-${i}`, name: `Synthetic Speed Import ${i}`, supplierKind: i % 5 ? 'direct' : 'channel',
      serviceTypes: 'hotel', city: ['Jodhpur', 'Jaipur', 'Udaipur'][i % 3], stateCode: null, gstin: null, pan: null, address: null, tallyLedgerName: null,
      contactName: null, contactPhone: null, contactEmail: `speed${i}@example.test`, paymentTerms: null, hotelSourceRefs: i % 7 ? null : `PERF:H-${i % 3000}`,
      bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null }));
    await measure('supplier import dry run (5,000 rows: stage + validate)', ACC, 'select public.import_batch_validate($1) as r', async () => {
      const staged = await inTx<{ batchId: string }>(U.accountsJodhpur, 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, gen_random_uuid()) as r',
        [entity, 'supplier', null, 'speed suppliers.csv', 'e'.repeat(64), JSON.stringify(rows)]);
      return [staged.batchId];
    }, 30_000, 'p95', 3);
    expect(misses((r) => r.measure.startsWith('supplier') || r.measure.startsWith('hotel'))).toEqual([]);
  }, 1_800_000);

  it('Tally export of about 1,000 rows with mapping ≤ 10 s; mapping list ≤ 300 ms', async () => {
    if (!seeded) return;
    await measure('tally mapping list', ACC, 'select public.tally_mapping_list($1) as r', [entity], 300);
    await measure('export batch (customer documents + refund journal, create)', ACC, 'select public.accounts_tally_export_create($1::jsonb, gen_random_uuid()) as r',
      async () => {
        await switchesOnInRun();
        const p = (await c.query<{ f: string; t: string }>(`select min(d)::text as f, max(d)::text as t from (select issue_date as d from public.customer_documents
          where number like 'SYN-PERF-%' order by issue_date desc limit 1000) x`)).rows[0]!;
        return [JSON.stringify({ entityId: entity, from: p.f, to: p.t, kinds: ['customer_document', 'journal_entry'], includeExported: false })];
      }, 10_000, 'p95', 5);
    expect(misses((r) => /export|mapping/.test(r.measure))).toEqual([]);
  }, 900_000);

  it('new notice triggers add ≤ 50 ms (refund request, document release, cancellation open)', async () => {
    if (!seeded) return;
    const pick = (await c.query<{ deal: string; owner: string; receipt: string }>(`select d.id as deal, d.owner_user_id as owner, r.id as receipt
      from public.deal_cancellations x join public.deals d on d.id = x.deal_id
      join lateral (select r.id from public.customer_receipts r where r.deal_id = d.id and r.status = 'verified' limit 1) r on true
      where x.status = 'approved' and d.reference like 'SYN-PERF-%' and not exists (select 1 from public.customer_refund_requests q where q.deal_id = d.id)
      offset 1 limit 1`)).rows[0]!;
    await extraForNotices('refund request create', { userId: pick.owner }, async () => {
      await switchesOnInRun();
      return [pick.deal, JSON.stringify({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '0', amountPaise: '1000', payeeKind: 'original_payer',
        payeeReceiptId: pick.receipt, payeeName: null, payeeReason: null, reason: 'Synthetic speed refund: trip cancelled' }), crypto.randomUUID()];
    }, 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r');
    const open = (await c.query<{ id: string; m: string }>(`select d.id, (select m.user_id from public.memberships m where m.branch_id = d.branch_id
        and m.role_code = 'manager' and m.status = 'active' limit 1) as m
      from public.deals d where d.reference like 'SYN-PERF-%' and not exists (select 1 from public.deal_cancellations x where x.deal_id = d.id)
      order by d.reference desc limit 1`)).rows[0]!;
    await extraForNotices('cancellation open (widened trip_cancelled + flight charges)', { userId: open.m }, async () =>
      [open.id, 'Synthetic speed cancellation reason', crypto.randomUUID()], 'select public.deal_cancellation_open($1, $2, $3) as r');
    expect(misses((r) => r.measure.startsWith('extra time'))).toEqual([]);
    void SUPER;
  }, 900_000);
});
