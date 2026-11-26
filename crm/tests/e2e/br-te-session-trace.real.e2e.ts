import { type BrowserContext, type Page, test } from '@playwright/test';
import {
  configured,
  db,
  fillCustomer,
  footerSettled,
  footerText,
  loadFixture,
  mainAlerts,
  newDeal,
  newSalesContext,
  pillState,
  Recorder,
  requestedFile,
  restoreSwitch,
  SALES,
  saveMessageSettings,
  sleep,
  startBooking,
} from './booking-reliability-support';

/**
 * Trace T-e of the booking reliability build contract (item B1-8). Tests
 * only, not a gate. Records what happens TODAY when the session ends while a
 * Book now form is open, in three cases:
 *
 *   A. the auth cookie is gone (signed out in another tab, cookies cleared);
 *   B. the auth cookie is present but no longer valid (tampered or expired);
 *   C. the token is still valid but the database ended the session (session
 *      barrier moved, as "sign out everywhere" and MFA recovery do).
 *
 * For each: which request is answered by whom (the proxy or the server action),
 * with what status and redirect headers, where the page goes, and what the form
 * shows. The contract builds the session-ended behaviour against this trace
 * (and changes src/proxy.ts only if the proxy answers the action itself).
 *
 * Runs ONLY when targeted.yml names this file (JOURNEY_FILES). Writes
 * test-results/real-journey/booking-reliability/te-session-*.json.
 */

const requested = requestedFile('br-te-session-trace.real.e2e.ts');

test.use({ trace: 'on', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

interface ActionHop {
  atMs: number;
  method: string;
  path: string;
  status: number | null;
  location: string | null;
  actionRedirect: string | null;
  contentType: string | null;
  redirectedFromPath: string | null;
  nextAction: boolean;
}

function traceRequests(page: Page, t0: number) {
  const hops: ActionHop[] = [];
  const navigations: Array<{ atMs: number; url: string }> = [];
  page.on('response', (res) => {
    const req = res.request();
    const u = new URL(res.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return;
    const h = req.headers();
    const from = req.redirectedFrom();
    const interesting = (req.method() === 'POST' && h['next-action']) || from !== null || /\/(sign-in|session-expired)/.test(u.pathname) || res.status() >= 300;
    if (!interesting || u.pathname.startsWith('/_next/static')) return;
    const rh = res.headers();
    hops.push({
      atMs: Date.now() - t0,
      method: req.method(),
      path: `${u.pathname}${u.search}`,
      status: res.status(),
      location: rh['location'] ?? null,
      actionRedirect: rh['x-action-redirect'] ?? null,
      contentType: rh['content-type'] ?? null,
      redirectedFromPath: from ? new URL(from.url()).pathname : null,
      nextAction: Boolean(h['next-action']),
    });
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push({ atMs: Date.now() - t0, url: new URL(frame.url()).pathname });
  });
  return { hops, navigations };
}

async function authCookies(context: BrowserContext) {
  return (await context.cookies()).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
}

async function screenState(page: Page) {
  return {
    url: new URL(page.url()).pathname,
    footer: await footerText(page),
    customerPill: await pillState(page, 'pill-customer'),
    alerts: await mainAlerts(page),
    destinationOnScreen: await page.locator('main').getByLabel('Destination', { exact: true }).inputValue({ timeout: 2_000 }).catch(() => null),
  };
}

test.describe('T-e: session ended while Book now is open @measurement', () => {
  test.skip(!requested, 'Measurement only: runs when targeted.yml names this file (JOURNEY_FILES).');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async () => {
    const rec = Recorder.active;
    Recorder.active = null;
    if (rec && !rec.saved) await rec.save({ endedBy: 'afterEach (timeout or failure before the end of the test)' }).catch(() => undefined);
  });

  test.afterAll(async () => {
    if (requested) await restoreSwitch('br-te-session-trace.real.e2e.ts');
  });

  const CASES = [
    { key: 'A-cookie-gone', title: 'A. auth cookie gone' },
    { key: 'B-cookie-invalid', title: 'B. auth cookie present but invalid' },
    { key: 'C-db-session-ended', title: 'C. token valid, session ended in the database (barrier moved)' },
  ] as const;

  for (const c of CASES) {
    test(`${c.title} @measurement`, async ({ browser }, testInfo) => {
      test.setTimeout(5 * 60_000);
      const rec = new Recorder(`te-session-${c.key}`, testInfo);
      await loadFixture(testInfo);
      // A barrier moved by the previous case is in the past by more than a second.
      await sleep(1_500);
      const deal = await newDeal(String(Date.now()).slice(-8), `Synthetic session trace ${c.key}`);
      const { context, page } = await newSalesContext(browser, rec, 'sales');
      const main = page.locator('main');
      const t0 = Date.now();
      const trace = traceRequests(page, t0);
      rec.facts.case = c.title;

      await rec.run(page, 'setup: start, customer card saved', async () => {
        await startBooking(rec, page, deal.id);
        await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
        await footerSettled(page);
      });
      const hopsBefore = trace.hops.length;
      const navBefore = trace.navigations.length;

      await rec.run(page, `end the session: ${c.key}`, async () => {
        const before = await authCookies(context);
        rec.facts.authCookieNamesBefore = before.map((x) => x.name);
        if (c.key === 'A-cookie-gone') {
          await context.clearCookies({ name: /^sb-.*-auth-token(\.\d+)?$/ });
        } else if (c.key === 'B-cookie-invalid') {
          await context.addCookies(before.map((x) => ({ name: x.name, value: 'base64-bm90LWEtc2Vzc2lvbg', domain: x.domain, path: x.path, expires: x.expires, httpOnly: x.httpOnly, secure: x.secure, sameSite: x.sameSite })));
        } else {
          await db(async (cl) => {
            await cl.query('select authz.move_session_barrier($1)', [SALES.id]);
          });
        }
        rec.facts.authCookieNamesAfter = (await authCookies(context)).map((x) => x.name);
      });

      await rec.run(page, 'edit the destination (autosave) and wait 8 s', async () => {
        const dest = main.getByLabel('Destination', { exact: true });
        await dest.fill('');
        await dest.pressSequentially('Jodhpur after session end', { delay: 15 });
        await sleep(8_000);
        rec.facts.afterAutosave = await screenState(page);
        await rec.shot(page, 'after-autosave');
      });

      await rec.run(page, 'press Save message settings (an explicit save) and wait 4 s', async () => {
        if (!(await page.locator('#book-message-prefs').count())) throw new Error('Messages to the customer card not shown');
        await saveMessageSettings(rec, page, `session ended ${c.key}`).catch((e: unknown) => rec.problem('save-message-session-ended', String(e).slice(0, 200), page.url()));
        await sleep(4_000);
        rec.facts.afterExplicitSave = await screenState(page);
        await rec.shot(page, 'after-explicit-save');
      });

      rec.facts.actionHops = trace.hops.slice(hopsBefore);
      rec.facts.navigations = trace.navigations.slice(navBefore);
      rec.facts.stored = await db(async (cl) => (await cl.query("select trip_destination as d from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows[0] ?? null).catch((e: unknown) => String(e).slice(0, 200));
      rec.facts.answeredBy = (() => {
        const posts = trace.hops.slice(hopsBefore).filter((h) => h.nextAction);
        const proxy = posts.filter((h) => h.status !== null && h.status >= 300 && h.status < 400 && h.location);
        const action = posts.filter((h) => h.status === 200 || h.actionRedirect);
        return { actionPosts: posts.length, proxyRedirects: proxy.length, answeredByActionRuntime: action.length };
      })();
      await rec.save();
      await context.close();
    });
  }
});
