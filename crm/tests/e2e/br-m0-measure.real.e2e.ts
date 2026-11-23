import { expect, type Page, type Request, test } from '@playwright/test';
import {
  attachProof,
  configured,
  db,
  fillCustomer,
  footerSettled,
  gotoStep,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  Recorder,
  requestedFile,
  restoreSwitch,
  sleep,
  startBooking,
  TRIP,
} from './booking-reliability-support';

/**
 * Measurement M0 of the booking reliability build contract (item B1-6). Tests
 * only, not a gate: it records, per save, what one Book now save costs, so
 * the lead can choose BOOK_SAVE_REFRESH_MODE and whether menu prefetch is
 * switched off. The same file runs unchanged on each variant branch
 * (claude/booking-fix-gate-m0-v0 to -v3, never merged):
 *
 *   V0 as today; V1 no revalidatePath on a draft save, one router.refresh();
 *   V2 refresh() from next/cache only, no router.refresh(); V3 best of V1/V2
 *   plus prefetch={false} on the frame's menu links.
 *
 * Recorded per save (passenger autosave x3, ID-proof attach, hotel drawer save):
 * requests by kind and path (server action, page GET, prefetch), and calls of
 * booking_form_get, booking_panel, intake_checklist and my_work_counts made
 * through the Data API (pg_stat_statements; nested calls are not counted).
 * Then: whether the Deal page shows the new values when opened by its link,
 * and whether a menu link shows its loading state at once.
 *
 * Runs ONLY when targeted.yml names this file (JOURNEY_FILES). Writes
 * test-results/real-journey/booking-reliability/m0-<variant>.json.
 */

const requested = requestedFile('br-m0-measure.real.e2e.ts');
const VARIANT = process.env.M0_VARIANT ?? process.env.GITHUB_REF_NAME ?? 'unknown';
const FUNCTIONS = ['booking_form_get', 'booking_panel', 'intake_checklist', 'my_work_counts'] as const;

test.use({ trace: 'on', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

interface Seen {
  atMs: number;
  method: string;
  path: string;
  kind: 'server-action' | 'prefetch' | 'rsc' | 'document' | 'other';
}

function watchRequests(page: Page, t0: number): Seen[] {
  const seen: Seen[] = [];
  const kindOf = (r: Request): Seen['kind'] => {
    const h = r.headers();
    if (r.method() === 'POST' && h['next-action']) return 'server-action';
    if (h['next-router-prefetch'] || h['purpose'] === 'prefetch') return 'prefetch';
    if (h['rsc'] === '1' || r.url().includes('_rsc=')) return 'rsc';
    if (r.resourceType() === 'document') return 'document';
    return 'other';
  };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return;
    if (u.pathname.startsWith('/_next/static') || /\.(png|svg|ico|woff2?|css|js)$/.test(u.pathname)) return;
    seen.push({ atMs: Date.now() - t0, method: r.method(), path: u.pathname, kind: kindOf(r) });
  });
  return seen;
}

/** Data API calls per function so far (pg_stat_statements; null when the view is not readable). */
async function functionCalls(): Promise<Record<string, number> | null> {
  return db(async (c) => {
    await c.query('create extension if not exists pg_stat_statements with schema extensions').catch(() => undefined);
    const out: Record<string, number> = {};
    for (const fn of FUNCTIONS) {
      const { rows } = await c.query<{ n: string }>(
        `select coalesce(sum(calls), 0)::text as n from extensions.pg_stat_statements
          where query ilike '%' || $1 || '%' and query not ilike '%pg_stat_statements%'`,
        [`"${fn}"`],
      );
      out[fn] = Number(rows[0]?.n ?? '0');
    }
    return out;
  }).catch(() => null);
}

function diff(after: Record<string, number> | null, before: Record<string, number> | null) {
  if (!after || !before) return null;
  return Object.fromEntries(Object.keys(after).map((k) => [k, after[k]! - (before[k] ?? 0)]));
}

function summarise(rows: Seen[]) {
  const byKind = (k: Seen['kind']) => rows.filter((r) => r.kind === k);
  const paths = (k: Seen['kind']) => {
    const m = new Map<string, number>();
    for (const r of byKind(k)) m.set(`${r.method} ${r.path}`, (m.get(`${r.method} ${r.path}`) ?? 0) + 1);
    return Object.fromEntries(m);
  };
  return {
    serverActionPosts: byKind('server-action').length,
    pageGets: byKind('rsc').length + byKind('document').length,
    prefetchGets: byKind('prefetch').length,
    pageGetPaths: { ...paths('rsc'), ...paths('document') },
    prefetchPaths: paths('prefetch'),
  };
}

test.describe('M0: requests and reads per Book now save @measurement', () => {
  test.skip(!requested, 'Measurement only: runs when targeted.yml names this file (JOURNEY_FILES).');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterAll(async () => {
    if (requested) await restoreSwitch('br-m0-measure.real.e2e.ts');
  });

  test(`M0 measurement (${VARIANT}) @measurement`, async ({ browser }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const rec = new Recorder(`m0-${VARIANT.replace(/[^a-z0-9-]+/gi, '-')}`, testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic M0 measurement');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const t0 = Date.now();
    const seen = watchRequests(page, t0);
    const main = page.locator('main');
    const perSave: Array<Record<string, unknown>> = [];
    rec.facts.variant = VARIANT;
    rec.facts.dealKind = deal.kind;

    /** One measured save: requests from the action until 4 s after the screen settled, plus Data API calls. */
    const measure = async (label: string, act: () => Promise<void>) => {
      await sleep(2_500);
      const from = seen.length;
      const before = await functionCalls();
      const started = Date.now();
      await act();
      await footerSettled(page).catch(() => undefined);
      await sleep(4_000);
      const rows = seen.slice(from);
      const after = await functionCalls();
      const row = { save: label, ms: Date.now() - started, ...summarise(rows), dataApiCalls: diff(after, before), detail: rows.map((r) => `${r.atMs} ${r.kind} ${r.method} ${r.path}`) };
      perSave.push(row);
      rec.facts.perSave = perSave;
    };

    await rec.run(page, 'setup: start, customer card with 3 adults', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '3', children: '0', infants: '0' });
      await footerSettled(page);
    });
    for (const n of [1, 2, 3]) {
      await rec.run(page, `passenger autosave ${n}`, () => measure(`passenger autosave ${n}`, () => nameRow(rec, page, n, `Synthetic Mzero Adult ${['One', 'Two', 'Three'][n - 1]}`, deal.id, n)));
    }
    await rec.run(page, 'ID-proof attach', () => measure('ID-proof attach', () => attachProof(rec, page, 'Synthetic Mzero Adult One', 'm0', false)));
    await rec.run(page, 'hotel drawer save', async () => {
      await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'step 1 → step 2');
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await footerSettled(page).catch(() => undefined);
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Mzero Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('7000');
      await measure('hotel drawer save', async () => {
        await d.getByRole('button', { name: 'Save hotel' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
      });
    });

    await rec.run(page, 'next save of another card after the saves (version still current)', async () => {
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 2 → step 1');
      await measure('customer card edit after the saves', async () => {
        const dest = main.getByLabel('Destination', { exact: true });
        await dest.fill('');
        await dest.pressSequentially('Jodhpur Mzero', { delay: 15 });
      });
    });
    rec.facts.footerAfterAllSaves = await page.locator('[data-slot="step-footer"] p').first().textContent().catch(() => null);
    rec.facts.alertsAfterAllSaves = await main.locator('[role="alert"]').allTextContents().catch(() => []);

    await rec.run(page, 'Deal page opened by its link shows the new values', async () => {
      const link = page.locator(`a[href="/app/deals/${deal.id}"]`).first();
      const viaLink = (await link.count()) > 0;
      const started = Date.now();
      if (viaLink) await link.click();
      else await page.goto(`/app/deals/${deal.id}`);
      await expect(page).toHaveURL(new RegExp(`/app/deals/${deal.id}$`), { timeout: 30_000 });
      await sleep(2_000);
      const text = (await main.textContent().catch(() => '')) ?? '';
      rec.facts.dealPage = {
        viaLink,
        ms: Date.now() - started,
        showsPassenger: text.includes('Synthetic Mzero Adult One'),
        showsHotel: text.includes('Synthetic Mzero Hotel'),
        showsNewDestination: text.includes('Jodhpur Mzero'),
      };
    });

    await rec.run(page, 'menu link shows its loading state at once', async () => {
      const link = page.locator('nav a[href="/app/deals"]').first();
      const started = Date.now();
      await link.click();
      let busyAtMs: number | null = null;
      for (let i = 0; i < 60 && busyAtMs === null; i += 1) {
        if ((await page.locator('main [aria-busy="true"], main [role="status"]:has-text("Loading")').count().catch(() => 0)) > 0) busyAtMs = Date.now() - started;
        else if (/\/app\/deals$/.test(page.url()) && (await main.getByRole('heading').count().catch(() => 0)) > 0) break;
        await sleep(50);
      }
      await expect(page).toHaveURL(/\/app\/deals$/, { timeout: 30_000 });
      rec.facts.menuLink = { loadingStateAtMs: busyAtMs, urlChangedMs: Date.now() - started };
    });

    rec.facts.storedAfter = await db(async (c) => ({
      travellers: (await c.query('select seq, full_name from public.deal_travellers where deal_id = $1 order by seq', [deal.id])).rows,
      destination: (await c.query("select trip_destination from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows,
    })).catch((e: unknown) => String(e).slice(0, 200));
    rec.facts.allPrefetchPaths = summarise(seen).prefetchPaths;
    await rec.save();
    await context.close();
  });
});
