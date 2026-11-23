import { type BrowserContext, expect, test } from '@playwright/test';
import { BOOK_RELIABILITY_TEXT as W, ERROR_TEXT } from '../../src/modules/fulfilment/contracts';
import {
  configured,
  db,
  fillCustomer,
  footerSettled,
  loadFixture,
  newDeal,
  newSalesContext,
  Recorder,
  requestedBrFile,
  restoreSwitch,
  SALES,
  saveActiveRecorder,
  signInAgainInNewTab,
  sleep,
  startBooking,
  storedDestination,
  until,
  watchRequests,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-8 (BR-35): a session that ends
 * while Book now is open says so, keeps the typing and links to sign-in.
 * REAL local Supabase stack, production build. The three cases of trace T-e
 * (build contract addendum 2):
 *
 *   A. the auth cookie is gone;
 *   B. the auth cookie is present but invalid;
 *   C. the token is valid but the database ended the session (barrier moved).
 *
 * In each case, after an autosave of the customer card, the FIXED behaviour
 * (contract section 6 B1-8, stress test e) is asserted:
 *   - the page does not navigate (stays on the step);
 *   - the card shows ERROR_TEXT.session with link W8, which opens sign-in in
 *     a new tab;
 *   - the typed value is still on the page and nothing was stored;
 *   - nothing is re-sent by itself;
 *   - after signing in again in another tab, "Try again" stores the value once.
 * So each test fails on main and passes once C0 (staffForAction, proxy) and
 * slices S4 and S3 are merged.
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-session-ended.real.e2e.ts';
const requested = requestedBrFile(FILE);
const AUTH_COOKIE = /^sb-.*-auth-token(\.\d+)?$/;

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

const CASES = [
  { key: 'A-cookie-gone', title: 'A. auth cookie gone' },
  { key: 'B-cookie-invalid', title: 'B. auth cookie present but invalid' },
  { key: 'C-db-session-ended', title: 'C. token valid, session ended in the database' },
] as const;

async function endSession(context: BrowserContext, key: (typeof CASES)[number]['key']) {
  const cookies = (await context.cookies()).filter((c) => AUTH_COOKIE.test(c.name));
  expect(cookies.length, 'an auth cookie to end').toBeGreaterThan(0);
  if (key === 'A-cookie-gone') {
    await context.clearCookies({ name: AUTH_COOKIE });
  } else if (key === 'B-cookie-invalid') {
    await context.addCookies(cookies.map((x) => ({ name: x.name, value: 'base64-bm90LWEtc2Vzc2lvbg', domain: x.domain, path: x.path, expires: x.expires, httpOnly: x.httpOnly, secure: x.secure, sameSite: x.sameSite })));
  } else {
    await db(async (c) => {
      await c.query('select authz.move_session_barrier($1)', [SALES.id]);
    });
  }
}

test.describe('B1-8: session ended while editing (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  for (const c of CASES) {
    test(`${c.title}: message and sign-in link, typing kept, nothing sent, stored once after signing in again @br`, async ({ browser }, testInfo) => {
      test.setTimeout(5 * 60_000);
      const rec = new Recorder(`br-session-${c.key}`, testInfo);
      await loadFixture(testInfo);
      await sleep(1_500); // a barrier moved by an earlier case is more than a second in the past
      const deal = await newDeal(String(Date.now()).slice(-8), `Synthetic session ended ${c.key}`);
      const { context, page, secret } = await newSalesContext(browser, rec, 'sales');
      const main = page.locator('main');
      const seen = watchRequests(page);
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await footerSettled(page);
      const stepPath = new URL(page.url()).pathname;
      const before = await storedDestination(deal.id);
      const typed = `Jodhpur after session end ${c.key.slice(0, 1)}`;

      await endSession(context, c.key);
      const dest = main.getByLabel('Destination', { exact: true });
      await dest.fill('');
      await dest.pressSequentially(typed, { delay: 15 });

      await expect(main.getByText(ERROR_TEXT.session).first(), 'ERROR_TEXT.session on the card').toBeVisible({ timeout: 20_000 });
      expect(new URL(page.url()).pathname, 'the page does not navigate').toBe(stepPath);
      const link = main.getByRole('link', { name: W.signInNewTab }).first();
      await expect(link, 'W8 link').toBeVisible();
      expect(await link.getAttribute('target'), 'opens in a new tab').toBe('_blank');
      expect(await link.getAttribute('href'), 'goes to sign-in').toMatch(/\/sign-in/);
      await expect(dest, 'typed value kept').toHaveValue(typed);
      expect(await storedDestination(deal.id), 'nothing stored while signed out').toBe(before);

      const postsBefore = seen.filter((r) => r.kind === 'server-action').length;
      await sleep(6_000);
      expect(seen.filter((r) => r.kind === 'server-action').length - postsBefore, 'nothing re-sent by itself').toBe(0);
      expect(new URL(page.url()).pathname).toBe(stepPath);

      await signInAgainInNewTab(context, secret);
      expect(page.isClosed()).toBe(false);
      await expect(dest, 'typed value still kept after signing in elsewhere').toHaveValue(typed);
      await main.getByRole('button', { name: W.tryAgain }).first().click();
      await until(async () => (await storedDestination(deal.id)) === typed, 30_000, 'typed destination stored after "Try again"');
      await footerSettled(page);
      await expect(main.getByText(ERROR_TEXT.session)).toHaveCount(0);
      const versions = await db(async (cl) => Number((await cl.query<{ n: string }>("select count(*)::text as n from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows[0]!.n));
      expect(versions, 'one draft').toBe(1);
      rec.facts.requests = seen.slice(-30);
      await rec.save();
      await context.close();
    });
  }
});
