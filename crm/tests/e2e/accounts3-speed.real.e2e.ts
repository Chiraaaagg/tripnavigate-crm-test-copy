import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { percentile, since } from './acc-real-support';
import {
  HOTEL, ROUTES, USERS, type UserKey, approveBooking, asUser, bookingWithTrip, configured, dayFromToday, doubleRequests, freshDeal, messagesDueNow, messagesOf,
  messagesOn, prepareUsers, purchaseFile, q, releaseDoc, renderCustomerOnce, restoreSwitches3, saveSwitches3, signIn, stamp, startDoubles, stopDoubles,
  supplierConfirmedHotel, switchesOn3, timerTick, verifiedCash,
} from './acc3-real-support';

/**
 * Accounts Phase 3 speed tests, page and pipeline part (contract
 * accounts-phase3-2026-11-12 section 16.5 = plan §9), Track T. Production
 * build on the disposable local stack seeded with scripts/perf/accounts-volume.sql,
 * accounts2-volume.sql and accounts3-volume.sql while
 * scripts/perf/accounts3-load.mjs runs the background users (ACCOUNTS_LOAD=1
 * records it). Each measure: one warm-up, then SPEED_RUNS (30) runs; median
 * and p95. Desktop 1280 px and phone 375 px throttled by CDP (150 ms RTT,
 * 4 Mbit/s down, 1.5 Mbit/s up), as Phase 1 and 2.
 *   - Accounts › Small balances and Accounts › Bills to check: ≤ 1.5 s desktop / ≤ 3 s phone;
 *   - Deal page with "Messages to customer" and History of changes: ≤ 1.5 s desktop / ≤ 3 s phone
 *     (the card's own addition, ≤ 150 ms, is measured on the database in speed-accounts-phase3.real.test.ts);
 *   - Rate contracts list (Purchase): ≤ 1.5 s desktop / ≤ 3 s phone;
 *   - bill PDF ready after release (local worker): ≤ 10 s;
 *   - customer message handed to the provider double after the event: p95 ≤ 2 min, median ≤ 60 s;
 *   - change submit, reconfirm record and apply (each step): ≤ 800 ms on fresh bookings.
 * Results: test-results/accounts3-speed.json and a printed table. A miss fails.
 * CONTRACT GAP: message journeys need a non-synthetic pilot Deal or a lead fixture
 * (the message-pipeline measure needs a Deal that is not skipped as test_deal).
 */

test.describe.configure({ mode: 'default' });
test.skip(!configured, 'needs the real local stack seeded with scripts/perf/accounts-volume.sql, accounts2-volume.sql and accounts3-volume.sql');
test.setTimeout(60 * 60_000);

const RUNS = Number(process.env.SPEED_RUNS ?? 30);
type Row = { measure: string; device: string; medianMs: number; p95Ms: number; targetMs: number; medianTargetMs?: number; pass: boolean };
const rows: Row[] = [];
let secrets: Record<UserKey, string>;

async function timed(name: string, device: string, targetMs: number, run: () => Promise<number>, runs = RUNS, medianTargetMs?: number) {
  await run();
  const xs: number[] = [];
  for (let i = 0; i < runs; i += 1) xs.push(await run());
  const median = percentile(xs, 50);
  const row = { measure: name, device, medianMs: median, p95Ms: percentile(xs, 95), targetMs, medianTargetMs,
    pass: percentile(xs, 95) <= targetMs && (medianTargetMs === undefined || median <= medianTargetMs) };
  rows.push(row);
  return row;
}
async function phone(page: Page) {
  await page.setViewportSize({ width: 375, height: 812 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8 });
}
async function ready(page: Page, heading: string | RegExp) {
  await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
}

test.beforeAll(async () => {
  const n = (await q<{ n: number }>(`select count(*)::int as n from public.rate_contracts where note = 'SYN-PERF rate contract'`).catch(() => [{ n: 0 }]))[0]?.n ?? 0;
  expect(n, 'run scripts/perf/accounts3-volume.sql first').toBeGreaterThanOrEqual(2000);
  await saveSwitches3();
  secrets = await prepareUsers();
  await startDoubles();
  await switchesOn3({ autoBills: true, release: true, writeOff: true, tallyXml: true, rateContracts: true, changes: true });
});
test.afterAll(async () => {
  await restoreSwitches3();
  await stopDoubles();
  if (rows.length) {
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/accounts3-speed.json', JSON.stringify({ at: new Date().toISOString(), runs: RUNS, backgroundLoad: process.env.ACCOUNTS_LOAD === '1',
      rows }, null, 2));
    console.info(['measure | device | median ms | p95 ms | target | pass', ...rows.map((r) =>
      `${r.measure} | ${r.device} | ${r.medianMs} | ${r.p95Ms} | ≤ ${r.targetMs}${r.medianTargetMs ? ` (median ≤ ${r.medianTargetMs})` : ''} | ${r.pass ? 'pass' : 'MISS'}`)]
      .join('\n'));
  }
});

let historyDeal: string | null = null;
/** A fresh synthetic Deal with an applied change (history to show) — SYNTHETIC FIXTURE STEP, not timed. */
async function dealWithHistory(): Promise<string> {
  if (historyDeal) return historyDeal;
  const id = await freshDeal(`ACC3SPH-${stamp}`);
  const v = await bookingWithTrip(id, 30, 33, 91);
  await approveBooking(id, v.versionId);
  // The "Messages to customer" card is shown only while customer messages are switched on: switch e-mail on for this
  // pilot Deal (saveSwitches3 / restoreSwitches3 put every switch back in afterAll).
  await messagesOn([id], ['email']);
  historyDeal = id;
  return id;
}

// ASSUMPTION: page headings are U's (section 15 names the screens, not the heading text).
const PAGES: Array<{ name: string; who: UserKey; path: () => Promise<string>; heading: string | RegExp }> = [
  { name: 'Accounts › Small balances', who: 'accA', path: async () => ROUTES.smallBalances, heading: /Small balances/ },
  { name: 'Accounts › Bills to check', who: 'accA', path: async () => ROUTES.billsToCheck, heading: /Bills to check|Customer documents/ },
  { name: 'Deal page with Messages to customer and History of changes', who: 'sales', path: async () => ROUTES.deal(await dealWithHistory()),
    heading: /Messages to customer/ },
  { name: 'Suppliers › Rate contracts', who: 'purchase', path: async () => ROUTES.rateContracts, heading: /Rate contracts/ },
  { name: 'Approvals (Manager: write-offs, change requests, rate contracts)', who: 'manager', path: async () => ROUTES.approvals, heading: /Approvals/ },
];

for (const p of PAGES) {
  test(`${p.name}: ≤ 1.5 s desktop, ≤ 3 s phone`, async ({ browser }) => {
    for (const device of ['desktop', 'phone'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await ctx.newPage();
      await signIn(page, p.who, secrets);
      if (device === 'phone') await phone(page);
      const path = await p.path();
      await timed(p.name, device, device === 'desktop' ? 1500 : 3000, async () => {
        const t0 = performance.now();
        await page.goto(path);
        await ready(page, p.heading);
        return since(t0);
      });
      await ctx.close();
    }
    expect(rows.filter((r) => r.measure === p.name && !r.pass).map((r) => `${r.device}: p95 ${r.p95Ms} ms`)).toEqual([]);
  });
}

test('bill PDF ready after release (local worker) ≤ 10 s', async () => {
  // Automatic release on: verified billing + verified receipt releases the Advance Invoice; then the local worker renders it.
  const deals: string[] = [];
  for (let k = 0; k < 6; k += 1) {
    const id = await freshDeal(`ACC3SPB-${stamp}-${k}`);
    const v = await bookingWithTrip(id, 30, 33, 100 + k);
    await approveBooking(id, v.versionId);
    deals.push(id);
  }
  for (let n = 0; n < 20; n += 1) {
    const out = await renderCustomerOnce();
    if (!out.some((l) => l.outcome === 'completed')) break;
  }
  let i = 0;
  await timed('verified receipt → automatic Advance Invoice → PDF stored', 'worker', 10_000, async () => {
    const id = deals[i]!;
    i += 1;
    const t0 = performance.now();
    await verifiedCash(id, '100000', 200 + i);
    const [doc] = await q<{ id: string; status: string }>(`select id, status from public.customer_documents where deal_id = $1 and kind = 'advance_invoice'`, [id]);
    if (doc?.status === 'draft') await releaseDoc(doc.id);
    await renderCustomerOnce();
    await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.customer_document_files f join public.customer_documents d
      on d.id = f.document_id where d.deal_id = $1`, [id]))[0]!.n, { timeout: 30_000 }).toBe(1);
    return since(t0);
  }, 5);
  expect(rows.filter((r) => r.measure.startsWith('verified receipt') && !r.pass)).toEqual([]);
});

test('customer message handed to the provider double after the event: p95 ≤ 2 min, median ≤ 60 s', async () => {
  await startDoubles();
  const id = await freshDeal(`ACC3SPM-${stamp}`);
  const v = await bookingWithTrip(id, 30, 33, 120);
  await messagesOn([id]);
  await approveBooking(id, v.versionId);
  let k = 0;
  await timed('payment received → handed to the provider double', 'pipeline', 120_000, async () => {
    k += 1;
    const before = doubleRequests().length;
    const t0 = performance.now();
    await verifiedCash(id, String(10000 + k), 300 + k);
    // The server action schedules dispatch with after(); scripts here call the command directly, so the timer is the path measured.
    await messagesDueNow(id);
    while (doubleRequests().length === before && performance.now() - t0 < 180_000) {
      await timerTick();
      if (doubleRequests().length === before) await new Promise((r) => setTimeout(r, 1000));
    }
    return since(t0);
  }, Math.min(RUNS, 10), 60_000);
  expect((await messagesOf(id, 'payment_received')).length).toBeGreaterThan(0);
  expect(rows.filter((r) => r.measure.startsWith('payment received') && !r.pass)).toEqual([]);
});

test('change submit, reconfirm record and apply ≤ 800 ms each (fresh bookings)', async () => {
  const N = 5;
  const cases: Array<{ deal: string; item: string; task: string; cr: string; cv: string }> = [];
  for (let k = 0; k < N + 1; k += 1) {
    const deal = await freshDeal(`ACC3SPC-${stamp}-${k}`);
    const v = await bookingWithTrip(deal, 30, 33, 400 + k, { budget: '400000' });
    await approveBooking(deal, v.versionId);
    const hotel = await supplierConfirmedHotel(deal, '300000');
    const cr = await asUser<{ changeRequestId?: string; id?: string }>(USERS.sales.id, 'select public.booking_change_request_create($1, $2::jsonb, $3) as r',
      [deal, JSON.stringify({ kind: 'change', itemIds: [v.itemIds[0]], changeSummary: 'Synthetic speed: one day later', reason: 'Synthetic speed: new dates' }),
        randomUUID()]);
    const crId = cr.changeRequestId ?? cr.id!;
    // Addendum O2 order: request (draft) -> the Sales owner fills the change version -> submit -> the Manager approves that version
    // -> Purchase reconfirms -> apply.
    const cv = (await asUser<{ versionId: string }>(USERS.sales.id, 'select public.booking_change_open_version($1, $2) as r', [crId, randomUUID()])).versionId;
    const vrv = (await q<{ v: number }>('select row_version as v from public.booking_versions where id = $1', [cv]))[0]!.v;
    await asUser(USERS.sales.id, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r', [v.itemIds[0], cv, vrv,
      JSON.stringify({ ...HOTEL, checkIn: dayFromToday(31), checkOut: dayFromToday(34) }), '400000']);
    cases.push({ deal, item: v.itemIds[0]!, task: hotel.taskId, cr: crId, cv });
  }
  let i = 0;
  await timed('change submit (G6)', 'database', 800, async () => {
    const c = cases[i]!;
    i += 1;
    const ready = await asUser<{ contentHash: string }>(USERS.sales.id, 'select public.booking_readiness($1) as r', [c.cv]);
    const t0 = performance.now();
    await asUser(USERS.sales.id, 'select public.booking_change_submit($1, $2, $3::uuid[], $4) as r', [c.cr, ready.contentHash, [c.item], randomUUID()]);
    return since(t0);
  }, N);
  i = 0;
  await timed('change approve by the Manager (G4, Addendum O2: approves the submitted version)', 'database', 800, async () => {
    const c = cases[i]!;
    i += 1;
    const rv = (await q<{ v: number }>('select row_version as v from public.booking_change_requests where id = $1', [c.cr]))[0]!.v;
    const t0 = performance.now();
    await asUser(USERS.manager.id, 'select public.booking_change_request_decide($1, $2, $3, $4, $5) as r', [c.cr, 'approve', null, rv, randomUUID()]);
    return since(t0);
  }, N);
  i = 0;
  await timed('reconfirm record within budget, which applies the change (G7 + 10.4)', 'database', 800, async () => {
    const c = cases[i]!;
    i += 1;
    const [r] = await q<{ id: string; row_version: number }>('select id, row_version from public.task_reconfirmations where change_request_id = $1', [c.cr]);
    const proof = await purchaseFile(c.task, 'supplier_confirmation');
    const t0 = performance.now();
    await asUser(USERS.purchase.id, 'select public.task_reconfirm_record($1, $2, $3::jsonb, $4) as r', [r!.id, r!.row_version, JSON.stringify({
      newRatePaise: '350000', supplierFeePaise: '0', newReference: `SYN-SPD-${i}`, evidenceId: proof, note: null }), randomUUID()]);
    return since(t0);
  }, N);
  expect((await q<{ n: number }>(`select count(*)::int as n from public.booking_change_requests where id = any($1::uuid[]) and status = 'applied'`,
    [cases.slice(0, N).map((c) => c.cr)]))[0]!.n).toBe(N);
  expect(rows.filter((r) => r.device === 'database' && !r.pass).map((r) => `${r.measure}: p95 ${r.p95Ms} ms`)).toEqual([]);
});
