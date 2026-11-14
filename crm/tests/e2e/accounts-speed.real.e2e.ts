import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type Page, expect, test } from '@playwright/test';
import { USERS, asUser, configured, percentile, prepareUsers, q, signIn, since, type UserKey } from './acc-real-support';

/**
 * Accounts phase speed tests, page part (contract 12.7 = plan 17.3), Track E.
 * Production build on the disposable local stack seeded with
 * scripts/perf/accounts-volume.sql, while scripts/perf/accounts-load.mjs runs
 * the 9 background users (ACCOUNTS_LOAD=1 records that it was running).
 * Each measure: one warm-up, then SPEED_RUNS (30) runs; median and p95.
 *   - page ready = the first table row and the filter bar are visible and no
 *     RPC is pending; desktop 1280 px, and phone 375 px throttled by CDP to
 *     150 ms RTT, 4 Mbit/s down, 1.5 Mbit/s up (AL19);
 *   - exact search, next page (keyset), branch dues list, CSV download (click
 *     to file end);
 *   - notice delay: server response of the causing command -> bell item
 *     visible, with Realtime up and with the WebSocket closed
 *     (page.routeWebSocket, the 30 s fallback path).
 * Results: test-results/accounts-speed.json and a printed table. A miss fails.
 */

// Default mode: one measure's miss or error never stops the others (each test asserts its own targets at the end).
test.describe.configure({ mode: 'default' });
test.skip(!configured, 'needs the real local stack seeded with scripts/perf/accounts-volume.sql');
test.setTimeout(60 * 60_000);

const RUNS = Number(process.env.SPEED_RUNS ?? 30);
type Row = { measure: string; device: string; medianMs: number; p95Ms: number; targetMs: number; targetOn: 'p95' | 'median'; pass: boolean };
const rows: Row[] = [];
let secrets: Record<UserKey, string>;

async function ready(page: Page) {
  await expect(page.getByRole('row').nth(1)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('searchbox').or(page.getByRole('textbox', { name: /find by reference/i })).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}
async function timed(name: string, device: string, targetMs: number, run: () => Promise<number>, targetOn: 'p95' | 'median' = 'p95') {
  await run();
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i += 1) xs.push(await run());
  const row = { measure: name, device, medianMs: percentile(xs, 50), p95Ms: percentile(xs, 95), targetMs, targetOn,
    pass: (targetOn === 'p95' ? percentile(xs, 95) : percentile(xs, 50)) <= targetMs };
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

test.beforeAll(async () => {
  const n = (await q<{ n: number }>(`select count(*)::int as n from public.deals where reference like 'SYN-PERF-%'`))[0]?.n ?? 0;
  expect(n, 'run scripts/perf/accounts-volume.sql first').toBeGreaterThanOrEqual(10_000);
  secrets = await prepareUsers();
});

test.afterAll(() => {
  if (!rows.length) return;
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/accounts-speed.json', JSON.stringify({ at: new Date().toISOString(), runs: RUNS, backgroundLoad: process.env.ACCOUNTS_LOAD === '1',
    commit: process.env.GITHUB_SHA ?? null, rows }, null, 2));
  console.info(['measure | device | median | p95 | target | pass', ...rows.map((r) =>
    `${r.measure} | ${r.device} | ${r.medianMs} | ${r.p95Ms} | ${r.targetOn} ≤ ${r.targetMs} | ${r.pass ? 'pass' : 'MISS'}`)].join('\n'));
});

for (const device of ['desktop', 'phone'] as const) {
  test(`workspace and dues pages (${device})`, async ({ page }) => {
    if (device === 'phone') await phone(page); else await page.setViewportSize({ width: 1280, height: 860 });
    await signIn(page, 'accA', secrets);
    const limit = device === 'phone' ? 3_000 : 1_500;
    for (const [name, query] of [['first page', ''], ['kinds receipt', '?kinds=receipt'], ['tally ready', '?tallyStatus=ready']] as const) {
      await timed(`workspace ${name}`, device, limit, async () => {
        const t0 = performance.now();
        await page.goto(`/app/accounts/records${query}`);
        await ready(page);
        return since(t0);
      });
    }
    // A seeded receipt (journeys on the same stack may add receipts the measured person cannot read).
    const ref = (await q<{ r: string }>(`select r.receipt_no as r from public.customer_receipts r join public.deals d on d.id = r.deal_id
      where d.reference like 'SYN-PERF-%' order by r.recorded_at desc limit 1`))[0]!.r;
    await timed('exact search (receipt)', device, 1_000, async () => {
      const t0 = performance.now();
      await page.goto(`/app/accounts/records?q=${encodeURIComponent(ref)}`);
      await ready(page);
      return since(t0);
    });
    // Each run starts from a fresh first page so "Show more" always loads page 2.
    await timed('next page (keyset)', device, 800, async () => {
      // Records table keyset control (Track D label "Show more").
      const more = page.getByRole('button', { name: /^show more/i }).first();
      await page.goto('/app/accounts/records');
      await ready(page);
      const before = await page.getByRole('row').count();
      const t0 = performance.now();
      await more.click();
      await expect.poll(async () => page.getByRole('row').count(), { timeout: 30_000 }).toBeGreaterThan(before);
      return since(t0);
    });
    await timed('dues list (branch, first 50)', device, 1_500, async () => {
      const t0 = performance.now();
      await page.goto('/app/accounts/dues');
      await expect(page.getByRole('row').nth(1)).toBeVisible();
      return since(t0);
    });
    expect(rows.filter((r) => r.device === device && !r.pass).map((r) => `${r.measure}: ${r.p95Ms} ms`)).toEqual([]);
  });
}

test('CSV export of about 1,000 rows: click to file end ≤ 10 s', async ({ page }) => {
  await signIn(page, 'accA', secrets);
  // A committed export of every ready journal entry of the last 366 days (the seed gives about 700-1,000 rows).
  const entity = (await q<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  const today = (await q<{ d: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text as d`))[0]!.d;
  const from = (await q<{ d: string }>(`select ((now() at time zone 'Asia/Kolkata')::date - 365)::text as d`))[0]!.d;
  const made = await asUser<{ exportId: string; rowCount: number }>(USERS.accA.id, 'select public.accounts_tally_export_create($1::jsonb, $2) as r',
    [JSON.stringify({ entityId: entity, from, to: today, kinds: ['journal_entry'], includeExported: false }), randomUUID()]);
  await timed(`CSV download (${made.rowCount} rows)`, 'desktop', 10_000, async () => {
    const t0 = performance.now();
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.goto(`/app/accounts/tally/exports/${made.exportId}/csv`).catch(() => undefined)]);
    await download.path();
    return since(t0);
  });
  expect(rows.filter((r) => r.measure.startsWith('CSV download') && !r.pass)).toEqual([]);
});

test('notice visible after the causing action: Realtime up (median ≤ 2 s, p95 ≤ 5 s) and after a drop (≤ 35 s)', async ({ page }) => {
  // The measured person must not be flooded by the background load (Accounts get every claim notice): the E2E Purchase
  // person receives one task_assigned notice per run when the Delhi Manager reassigns a seeded Delhi hotel task to them.
  // Badge text: "Notices 12" (no 99+ cap reached in 36 runs).
  await signIn(page, 'purchase', secrets);
  // One distinct seeded Delhi hotel task per run, never handed back, so the unread count only grows.
  const tasks = await q<{ id: string; a: string }>(`select t.id, t.assignee_user_id as a from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where d.reference like 'SYN-PERF-%' and t.department = 'purchase' and t.status = 'in_progress' and t.assignee_user_id <> $1
      and d.branch_id = (select id from public.branches where code = 'DEL' limit 1) order by d.reference limit 80`, [USERS.purchase.id]);
  const MANAGER_DELHI = 'a0000000-0000-4000-8000-000000000005';
  let next = 0;
  const cause = async () => {
    const t = tasks[next]!;
    next += 1;
    const t0 = performance.now();
    await asUser(MANAGER_DELHI, 'select public.purchase_task_reassign($1, $2, $3) as r', [t.id, t.a, USERS.purchase.id]);
    return t0;
  };
  const back = async () => undefined;
  // Notices on for this measure only (audited admin command as the fixture super admin); switched off again at the end.
  const SUPER = 'a0000000-0000-4000-8000-000000000007';
  await asUser(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [true, 'Synthetic: notice delay measure (local stack)']);
  try {
  await page.goto('/app');
  const countBadge = () => page.getByRole('button', { name: /notices|notifications|bell/i }).first().innerText();
  const live = await timed('notice delay (Realtime up)', 'desktop', 5_000, async () => {
    const before = await countBadge();
    const t0 = await cause();
    await expect.poll(countBadge, { timeout: 40_000, intervals: [100] }).not.toBe(before);
    const ms = since(t0);
    await back();
    return ms;
  });
  expect(live.medianMs, 'median ≤ 2 s').toBeLessThanOrEqual(2_000);
  await page.routeWebSocket(/realtime/, (ws) => ws.close());
  await page.reload();
  const runs = Math.min(RUNS, 5);
  const xs: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const before = await countBadge();
    const t0 = await cause();
    await expect.poll(countBadge, { timeout: 60_000, intervals: [250] }).not.toBe(before);
    xs.push(since(t0));
    await back();
  }
  rows.push({ measure: `notice delay (Realtime closed, ${runs} runs)`, device: 'desktop', medianMs: percentile(xs, 50), p95Ms: percentile(xs, 95),
    targetMs: 35_000, targetOn: 'p95', pass: percentile(xs, 95) <= 35_000 });
  } finally {
    await asUser(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [false, 'Synthetic: notice delay measure finished (local stack)']);
  }
  expect(rows.filter((r) => r.measure.startsWith('notice') && !r.pass)).toEqual([]);
});
