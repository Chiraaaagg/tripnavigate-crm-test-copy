import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { percentile, since } from './acc-real-support';
import {
  HOTEL, USERS, type UserKey, approveBooking, asUser, configured, confirmedBooking, freshDeal, prepareUsers, q, releaseDoc, renderCustomerOnce, restoreSwitches,
  saveSwitches, signIn, stamp, switchesOn, verifiedCash,
} from './acc2-real-support';

/**
 * OPT-IN: runs only with ACCOUNTS_SPEED=1, e.g.
 *   ACCOUNTS_SPEED=1 npx playwright test --config=playwright.real.config.ts tests/e2e/accounts2-speed.real.e2e.ts
 * It is a local measurement on the volume seeds, not a CI check; without the
 * opt-in every test here is skipped.
 *
 * Accounts Phase 2 speed tests, page part (contract 12.5 = plan C13), Track F.
 * Production build on the disposable local stack seeded with
 * scripts/perf/accounts-volume.sql and scripts/perf/accounts2-volume.sql,
 * while scripts/perf/accounts-load.mjs and accounts2-load.mjs run the
 * background users (ACCOUNTS_LOAD=1 records it). Each measure: one warm-up,
 * then SPEED_RUNS (30) runs; median and p95. Desktop 1280 px and phone
 * 375 px throttled by CDP (150 ms RTT, 4 Mbit/s down, 1.5 Mbit/s up), as
 * Phase 1.
 *   - Accounts › Documents first page: ≤ 1.5 s desktop / ≤ 3 s phone;
 *   - refund screens (Deal refund card, Approvals › Refunds, Accounts ›
 *     Refunds): ≤ 1.5 s desktop / ≤ 3 s phone;
 *   - draft create + preview visible: ≤ 2 s;
 *   - release → PDF stored by the local worker (one job): ≤ 10 s.
 * Results: test-results/accounts2-speed.json and a printed table. A miss fails.
 * Teardown restores every switch it turned on.
 */

test.describe.configure({ mode: 'default' });
// OPT-IN local measurement (not a CI check): runs only with ACCOUNTS_SPEED=1 on a stack seeded with the volume files.
test.skip(!configured || process.env.ACCOUNTS_SPEED !== '1',
  'opt-in speed measurement: set ACCOUNTS_SPEED=1 on the real local stack seeded with scripts/perf/accounts-volume.sql and accounts2-volume.sql');
test.setTimeout(60 * 60_000);

const RUNS = Number(process.env.SPEED_RUNS ?? 30);
type Row = { measure: string; device: string; medianMs: number; p95Ms: number; targetMs: number; pass: boolean };
const rows: Row[] = [];
let secrets: Record<UserKey, string>;

async function timed(name: string, device: string, targetMs: number, run: () => Promise<number>, runs = RUNS) {
  await run();
  const xs: number[] = [];
  for (let i = 0; i < runs; i += 1) xs.push(await run());
  const row = { measure: name, device, medianMs: percentile(xs, 50), p95Ms: percentile(xs, 95), targetMs, pass: percentile(xs, 95) <= targetMs };
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
/** Page ready: the main content shows its first data (a row or the card heading) and no request is pending. */
async function ready(page: Page, heading: string | RegExp) {
  // The page's own card or section heading (Track E labels), then no request pending.
  await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
}

test.beforeAll(async () => {
  const n = (await q<{ n: number }>(`select count(*)::int as n from public.customer_documents where number like 'SYN-PERF-%'`))[0]?.n ?? 0;
  expect(n, 'run scripts/perf/accounts2-volume.sql first').toBeGreaterThanOrEqual(8_000);
  await saveSwitches();
  secrets = await prepareUsers();
  await switchesOn();
});
test.afterAll(async () => {
  await restoreSwitches();
  if (rows.length) {
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/accounts2-speed.json', JSON.stringify({ at: new Date().toISOString(), runs: RUNS, backgroundLoad: process.env.ACCOUNTS_LOAD === '1',
      rows }, null, 2));
    console.info(['measure | device | median ms | p95 ms | target | pass', ...rows.map((r) =>
      `${r.measure} | ${r.device} | ${r.medianMs} | ${r.p95Ms} | ≤ ${r.targetMs} | ${r.pass ? 'pass' : 'MISS'}`)].join('\n'));
  }
});

const PAGES: Array<{ name: string; who: UserKey; path: () => Promise<string>; heading: string | RegExp }> = [
  { name: 'Accounts › Documents first page', who: 'accA', path: async () => '/app/accounts/documents', heading: 'Customer documents' },
  // The Deal page Refunds card as the Sales owner, on a fresh synthetic Deal with an approved cancellation and a refund
  // waiting for approval (SYN-PERF Deals are not visible on the Deal page to the E2E staff, and the Accounts deal page
  // cannot parse their seeded receipt snapshots).
  { name: 'Deal refund card', who: 'sales', heading: 'Refunds', path: async () => `/app/deals/${await refundDeal()}?tab=services` },
  { name: 'Approvals › Refunds', who: 'manager', path: async () => '/app/approvals', heading: /^Refunds to approve/ },
  { name: 'Accounts › Refunds', who: 'accA', path: async () => '/app/accounts/refunds', heading: 'Customer refunds to pay out' },
  // Accounts deal page on a seeded SYN-PERF Deal (documents and refunds cards), after the lead's seed fix (snapshot versionNo).
  { name: 'Accounts deal page (SYN-PERF, Money tab)', who: 'accA', heading: 'Refunds', path: async () =>
    `/app/accounts/deals/${(await q<{ id: string }>(`select deal_id as id from public.customer_refund_requests where ref_no like 'RF-2026-8%' limit 1`))[0]!.id}?tab=money` },
  { name: 'Accounts deal page (SYN-PERF, Documents tab)', who: 'accA', heading: 'Customer documents', path: async () =>
    `/app/accounts/deals/${(await q<{ id: string }>(`select deal_id as id from public.customer_documents where number like 'SYN-PERF-%' limit 1`))[0]!.id}?tab=documents` },
];

let refundDealId: string | null = null;
/** SYNTHETIC FIXTURE STEP (not timed): booking approved, ₹5,000 received, cancellation approved, refund of ₹1,000 asked. */
async function refundDeal(): Promise<string> {
  if (refundDealId) return refundDealId;
  const id = await freshDeal(`ACC2SPR-${stamp}`);
  const v = await confirmedBooking(id, [['hotel', HOTEL]], 300);
  await approveBooking(id, v.versionId);
  const rec = await verifiedCash(id, '500000', 300);
  const c = await asUser<{ cancellationId: string }>(USERS.manager.id, 'select public.deal_cancellation_open($1, $2, $3) as r',
    [id, 'Synthetic: customer cancelled the trip', randomUUID()]);
  const rv = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [c.cancellationId]))[0]!.row_version;
  await asUser(USERS.manager.id, 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r', [c.cancellationId, 'approve', null, rv, randomUUID()]);
  await asUser(USERS.sales.id, 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r', [id, JSON.stringify({ kind: 'cancellation',
    outcome: 'payout', customerChargePaise: '0', amountPaise: '100000', payeeKind: 'original_payer', payeeReceiptId: rec.id, payeeName: null, payeeReason: null,
    reason: 'Synthetic speed refund: trip cancelled' }), randomUUID()]);
  refundDealId = id;
  return id;
}

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

test('draft create + preview visible ≤ 2 s; release → PDF stored by the local worker ≤ 10 s', async ({ browser }) => {
  // Perf Deals beyond the seeded documents with verified money and an approved review: one ADV candidate each.
  // Fresh synthetic Deals (approved booking, verified billing, one verified receipt): the Accounts deal page cannot open
  // SYN-PERF Deals (seed receipts lack destination versionNo). Set-up is not timed.
  const N = Math.min(RUNS, 30) + 1;
  const deals: Array<{ id: string }> = [];
  for (let k = 0; k < N; k += 1) {
    const id = await freshDeal(`ACC2SPD-${stamp}-${k}`);
    const v = await confirmedBooking(id, [['hotel', HOTEL]], 100 + k);
    await approveBooking(id, v.versionId);
    await verifiedCash(id, '100000', 100 + k);
    deals.push({ id });
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await signIn(page, 'accA', secrets);
  let i = 0;
  await timed('draft create + preview visible', 'desktop', 2000, async () => {
    const d = deals[i]!;
    i += 1;
    await page.goto(`/app/accounts/deals/${d.id}?tab=documents`);
    await page.waitForLoadState('networkidle');
    const t0 = performance.now();
    await page.getByRole('button', { name: /^Create draft Advance Invoice/ }).first().click();
    // Preview visible: the draft's release button and its preview are on the card.
    await expect(page.getByRole('button', { name: /^Release (as |this )/ }).first()).toBeVisible({ timeout: 30_000 });
    return since(t0);
  }, Math.min(RUNS, deals.length - 1));
  await ctx.close();
  // Release → PDF stored (one job by the local worker), 5 runs: billing verified first (release rule).
  // Drain jobs left by earlier runs first, so each timed run renders exactly its own document (one job per worker call).
  for (let n = 0; n < 20; n += 1) {
    const out = await renderCustomerOnce();
    if (!out.some((l) => l.outcome === 'completed')) break;
  }
  const released: string[] = [];
  let k = 0;
  await timed('release → PDF stored (local worker)', 'worker', 10_000, async () => {
    const d = deals[k]!;
    k += 1;
    const [doc] = await q<{ id: string }>(`select id from public.customer_documents where deal_id = $1 and status = 'draft'`, [d.id]);
    const billing = (await q<{ row_version: number; status: string }>('select row_version, status from public.customer_billing_profiles where deal_id = $1', [d.id]))[0];
    if (billing?.status !== 'verified') {
      const saved = await asUser<{ rowVersion: number }>(USERS.accA.id, 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r', [d.id,
        billing?.row_version ?? 0, JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur',
          stateCode: '08', postalCode: '342001', gstin: null }), randomUUID()]);
      await asUser(USERS.accA.id, 'select public.accounts_billing_verify($1, $2, $3) as r', [d.id, saved.rowVersion, randomUUID()]);
    }
    const t0 = performance.now();
    await releaseDoc(doc!.id);
    await renderCustomerOnce();
    await expect.poll(async () => (await q<{ n: number }>('select count(*)::int as n from public.customer_document_files where document_id = $1', [doc!.id]))[0]!.n,
      { timeout: 30_000 }).toBe(1);
    released.push(doc!.id);
    return since(t0);
  }, 4);
  expect(rows.filter((r) => (r.measure.startsWith('draft') || r.measure.startsWith('release')) && !r.pass).map((r) => `${r.measure}: p95 ${r.p95Ms} ms`)).toEqual([]);
});
