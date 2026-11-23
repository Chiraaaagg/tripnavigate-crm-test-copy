import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  HOTEL, PUSH_HOST, PUSH_PATH, USERS, type UserKey, allowedOutbound, approvedDeal, asUser, configured, doubleRequests, leaks, HARNESS_SKIP, providerHarness, openAlertSettings,
  prepareUsers, q, restoreSwitches3, saveSwitches3, serviceWorkers, session, stamp, startDoubles, stopDoubles, stubPush, switchesOn3, tickUntil,
} from './acc3-real-support';

/**
 * Accounts Phase 3 test plan 16.4, journey 5 (closed-browser alerts, 8.1-8.4)
 * and the service-worker half of journey 9, Track T, written from the
 * contract. The browser's PushManager is stubbed so the subscription points
 * at the local push double; the real service worker (/sw.js) registers only
 * after "Turn on alerts on this device" (bell › "Sound, pop-up and alert
 * settings", screen 15.8). The subscription endpoint is https on a fake push
 * host; the provider harness of acc3-real-support.ts routes web-push's send
 * to the local push double as plain JSON (needs the harness shell env).
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');
test.setTimeout(10 * 60_000);
test.use({ actionTimeout: 30_000 });

let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches3();
  secrets = await prepareUsers();
  await startDoubles();
  await switchesOn3({ push: true });
});
test.afterAll(async () => {
  // Leave no active device behind (10-device cap per person; removal is audited and final).
  for (const d of await q<{ id: string; user_id: string }>(`select id, user_id from public.staff_push_devices where endpoint like $1 and status = 'active'`,
    [`https://${PUSH_HOST}${PUSH_PATH}/acc3-%`])) {
    await asUser(d.user_id, 'select public.push_device_remove($1, $2) as r', [d.id, randomUUID()]).catch(() => undefined);
  }
  await restoreSwitches3();
  await stopDoubles();
});

type PushBody = { title?: string; body?: string; tag?: string; url?: string };
const pushBodies = (endpoint: string): PushBody[] => doubleRequests('push').filter((r) => r.path.includes(endpoint.split('/').at(-1)!) || r.body.includes(endpoint))
  .map((r) => { try { return JSON.parse(r.body) as PushBody; } catch { return {}; } });

test('5. alerts: opt in on a test browser → urgent notice → push sent to the stub within 30 s → click opens the right page; removed device gets nothing', async ({ browser }) => {
  test.skip(!providerHarness, HARNESS_SKIP);
  const endpoint = `https://${PUSH_HOST}${PUSH_PATH}/acc3-${stamp}`;
  const so = await session(browser, 'sales', secrets);
  await stubPush(so.ctx, endpoint);
  // Before opt-in: no service worker at all (Phase 2 rule now "no service worker before opt-in").
  await openAlertSettings(so.page);
  expect(await serviceWorkers(so.page)).toEqual([]);

  // "Alerts on this device": on for this browser; the device list shows it with a label derived from the browser.
  await so.page.getByRole('button', { name: /^Turn on alerts on this device/ }).click();
  await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.staff_push_devices where user_id = $1 and endpoint = $2
    and status = 'active'`, [USERS.sales.id, endpoint]))[0]!.n).toBe(1);
  expect((await serviceWorkers(so.page)).some((u) => u.endsWith('/sw.js'))).toBe(true);
  const [device] = await q<{ id: string; label: string }>(`select id, label from public.staff_push_devices where endpoint = $1`, [endpoint]);
  expect(device!.label).toMatch(/^.{1,60}$/);
  await openAlertSettings(so.page);
  await expect(so.page.getByText(device!.label).first()).toBeVisible();
  // No read ever returns the endpoint or the keys.
  const list = await asUser(USERS.sales.id, 'select public.push_devices_list() as r');
  expect(JSON.stringify(list)).not.toContain(endpoint);
  expect(JSON.stringify(list)).not.toMatch(/p256dh|authKey|auth_key/);

  // "Send a test alert": the fixed body.
  await so.page.getByRole('button', { name: /^Send a test alert/ }).click();
  await tickUntil(async () => pushBodies(endpoint).some((b) => b.body === 'Test alert — alerts work on this device'), 30_000);

  // Urgent notice for the Sales owner: the Manager opens a trip cancellation on their Deal (trip_cancelled is urgent).
  const { dealId, reference } = await approvedDeal('ACC3AL', 51, [['hotel', HOTEL]]);
  const t0 = Date.now();
  await asUser(USERS.manager.id, 'select public.deal_cancellation_open($1, $2, $3) as r', [dealId, 'Synthetic: customer cancelled the trip', randomUUID()]);
  const [notice] = await q<{ id: string }>(`select id from public.staff_notices where kind = 'trip_cancelled' and deal_id = $1 and recipient_user_id = $2`,
    [dealId, USERS.sales.id]);
  expect(notice, 'urgent notice for the Sales owner').toBeDefined();
  await tickUntil(async () => (await q<{ s: string }>(`select status as s from public.staff_push_jobs where notice_id = $1`, [notice!.id]))[0]?.s === 'sent', 30_000);
  expect(Date.now() - t0, 'closed-browser alert after the event ≤ 30 s').toBeLessThanOrEqual(30_000);
  const payload = pushBodies(endpoint).find((b) => b.tag === `tn-notice-${notice!.id}`);
  expect(payload, 'the payload reached the push double').toBeDefined();
  expect(payload!.title).toBe('TripNavigate');
  // Reference-only text: the Deal reference, never a customer name, phone, amount, PNR or ticket number.
  expect(payload!.body).toContain(reference);
  expect(leaks(JSON.stringify(payload), ['Synthetic Contact', 'Synthetic Acc3 One', '45678913', 'e2e.acc3.contact.51@example.test'])).toEqual([]);
  // Click: the notice link is a same-origin path; opening it shows the right page.
  expect(payload!.url).toMatch(/^\/app\//);
  await so.page.goto(payload!.url!);
  await expect(so.page.getByText(reference).first()).toBeVisible();

  // Remove this device: nothing more is sent to it.
  await openAlertSettings(so.page);
  await so.page.getByRole('button', { name: /^Remove .*\(this device\)$/ }).click();
  await expect.poll(async () => (await q<{ s: string }>('select status as s from public.staff_push_devices where id = $1', [device!.id]))[0]!.s).toBe('removed');
  const before = pushBodies(endpoint).length;
  const removedAt = (await q<{ t: string }>('select now()::text as t'))[0]!.t;
  const other = await approvedDeal('ACC3AL', 52, [['hotel', HOTEL]]);
  await asUser(USERS.manager.id, 'select public.deal_cancellation_open($1, $2, $3) as r', [other.dealId, 'Synthetic: customer cancelled the trip', randomUUID()]);
  await tickUntil(async () => true);
  expect((await q<{ n: number }>(`select count(*)::int as n from public.staff_push_jobs where device_id = $1 and created_at > $2::timestamptz`,
    [device!.id, removedAt]))[0]!.n).toBe(0);
  expect(pushBodies(endpoint).length).toBe(before);
  await so.ctx.close();

  // A person who never opted in has no service worker.
  const mgr = await session(browser, 'manager', secrets);
  await openAlertSettings(mgr.page);
  expect(await serviceWorkers(mgr.page)).toEqual([]);
  await mgr.ctx.close();
});

test('9. no outbound request except the app, the local Supabase and the local doubles', () => {
  expect(allowedOutbound()).toEqual([]);
});
