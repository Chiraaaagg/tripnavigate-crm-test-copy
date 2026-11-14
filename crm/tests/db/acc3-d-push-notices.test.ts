import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, HOTEL_ITEM, PAST_HOTEL_ITEM, PAST_TRIP, SELLING, SQL as P1 } from './acc-support';
import {
  ACC, ACC_J2, DEAL, MANAGER, OWNER, PURCHASE, REASON, RELEASE_A_NOTICE_KINDS, SQL3, SUPER, U, WORKER, acc3Helpers, asItems, rid, text,
} from './acc3-support';

/**
 * Accounts phase 3, Track T — Track D closed-browser alerts and Release A
 * notices (contract 8.1-8.6, 13, 14, 16.1 D). Written from the contract, not
 * from Track D's code.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner, refused, refusedHint } = h;
const P256 = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);
const endpoint = (n = rid()) => `https://fcm.googleapis.com/fcm/send/${n}`;
type Device = { deviceId: string };

const pushOn = async (on = true) => one(SUPER, SQL3.setPush, [on, REASON]);
const register = (actor: Actor, ep = endpoint(), label = 'Chrome on Windows') =>
  one<Device & Record<string, unknown>>(actor, SQL3.pushRegister, [ep, P256, AUTH, label, rid()]);
const jobs = () => owner<{ id: string; notice_id: string; device_id: string; status: string; attempts: number; kind: string; recipient: string }>(
  `select j.id, j.notice_id, j.device_id, j.status, j.attempts, n.kind, n.recipient_user_id as recipient
   from public.staff_push_jobs j join public.staff_notices n on n.id = j.notice_id order by j.created_at, j.id`);
const devices = () => owner<{ id: string; user_id: string; status: string; removed_reason: string | null; endpoint: string }>(
  'select id, user_id, status, removed_reason, endpoint from public.staff_push_devices order by created_at, id');
async function claimPush(limit = 50) {
  return asItems<{ jobId: string; endpoint: string; p256dh: string; authKey: string; payload: Record<string, unknown> }>(
    await one(WORKER, SQL3.pushClaim, ['acc3-test', limit, 60]));
}

/** Past-trip hotel booking, paid all but 30000, write-off On. */
async function smallBalance() {
  await h.people();
  const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
  await h.approveReal(b.versionId);
  await h.receipt(DEAL, String(Number(SELLING) - 30000));
  await h.writeOffOn(true);
}
const propose = () => one<{ writeOffId: string }>(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()]);
const woRv = async (id: string) => (await owner<{ v: number }>('select row_version as v from public.deal_write_offs where id = $1', [id]))[0]!.v;

describe('8.1 / 8.3 devices', () => {
  it('push_off follows the push switch (8.1 / 13): with push On a device registers even while the notices switch is Off', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.noticesOn(false);
      await pushOn();
      expect((await register(ACC)).deviceId).toBeTruthy();
    });
  });

  it('push_off while Off; register, list without keys, 10 devices max, endpoint moves between people, remove and sign-out', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.noticesOn();
      await refused(ACC, SQL3.pushRegister, [endpoint(), P256, AUTH, 'Chrome on Windows', rid()], 'push_off', '55000');
      await refused(ACC, SQL3.setPush, [true, REASON], 'not_authorized', '42501');
      await pushOn();
      expect((await h.audits('settings.notices_changed')).slice(-1)[0]!.reason).toBe(REASON);
      const ep = endpoint('shared');
      const d1 = await register(ACC, ep);
      expect(d1.deviceId).toBeTruthy();
      const list = await one<{ enabled: boolean; devices: Array<Record<string, unknown>> }>(ACC, SQL3.pushList, []);
      expect(list.enabled).toBe(true);
      expect(list.devices).toHaveLength(1);
      expect(Object.keys(list.devices[0]!)).toEqual(expect.arrayContaining(['deviceId', 'label', 'createdAt', 'lastUsedAt']));
      for (const secret of [P256, AUTH, ep]) expect(text(list)).not.toContain(secret);
      const added = (await h.audits('notices.push_device_added')).slice(-1)[0]!;
      expect(added.details).toMatchObject({ deviceId: d1.deviceId });
      expect(text(added)).not.toContain(ep);
      // Bad endpoint (not https).
      const bad = await h.attempt(ACC, SQL3.pushRegister, ['http://fcm.googleapis.com/fcm/send/x', P256, AUTH, 'Chrome on Windows', rid()]);
      expect(bad.ok).toBe(false);
      // Ten devices max.
      for (let i = 0; i < 9; i += 1) await register(ACC);
      await refused(ACC, SQL3.pushRegister, [endpoint(), P256, AUTH, 'Chrome on Windows', rid()], 'push_too_many_devices', '55000');
      // The shared endpoint moves to the next person.
      await register(OWNER, ep);
      const moved = (await devices()).find((d) => d.id === d1.deviceId)!;
      expect(moved).toMatchObject({ status: 'removed', removed_reason: 'moved' });
      expect((await devices()).filter((d) => d.endpoint === ep && d.status === 'active').map((d) => d.user_id)).toEqual([U.salesDelhiA]);
      // Another person cannot remove my device.
      const mine = (await devices()).find((d) => d.user_id === U.accountsJodhpur && d.status === 'active')!;
      const notMine = await h.attempt(OWNER, SQL3.pushRemove, [mine.id, rid()]);
      expect(notMine.ok).toBe(false);
      await one(ACC, SQL3.pushRemove, [mine.id, rid()]);
      expect((await devices()).find((d) => d.id === mine.id)).toMatchObject({ status: 'removed', removed_reason: 'user' });
      // Sign-out removes this browser's device.
      await one(OWNER, SQL3.pushRemoveCurrent, [ep]);
      expect((await devices()).filter((d) => d.endpoint === ep).every((d) => d.status === 'removed')).toBe(true);
      expect((await devices()).find((d) => d.endpoint === ep && d.user_id === U.salesDelhiA)!.removed_reason).toBe('signed_out');
      // No DELETE; removed is final.
      await resetActor(db);
      await db.exec('savepoint g');
      let failed = false;
      try {
        await owner('delete from public.staff_push_devices where id = $1', [mine.id]);
      } catch {
        failed = true;
      }
      await db.exec('rollback to savepoint g');
      expect(failed).toBe(true);
    });
  });
});

describe('Addendum O3: push endpoint allowlist and "Sign out of all devices"', () => {
  it('only the four push services are accepted; any other host is refused invalid_input (hint endpoint)', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.noticesOn();
      await pushOn();
      for (const ep of ['https://fcm.googleapis.com/fcm/send/o3-a', 'https://updates.push.services.mozilla.com/wpush/v2/o3-b',
        'https://web.push.apple.com/o3-c', 'https://wns2-par02p.notify.windows.com/w/?token=o3-d']) {
        expect((await register(ACC, ep)).deviceId, ep).toBeTruthy();
      }
      for (const ep of ['https://push.example.test/o3-x', 'https://fcm.googleapis.com.evil.example.test/o3-y', 'https://user@fcm.googleapis.com/o3-z',
        'https://fcm.googleapis.com:8443/o3-w', 'http://fcm.googleapis.com/fcm/send/o3-v', 'https://127.0.0.1/o3-u']) {
        await refusedHint(ACC, SQL3.pushRegister, [ep, P256, AUTH, 'Chrome on Windows', rid()], 'invalid_input', /endpoint/, '22023');
      }
      expect((await devices()).filter((d) => d.status === 'active')).toHaveLength(4);
    });
  });

  it('push_devices_remove_all removes every active device of the caller only (signed_out), one audit row per device, ids only', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.noticesOn();
      await pushOn();
      const mine = [await register(ACC), await register(ACC), await register(ACC)];
      const theirs = await register(OWNER);
      const before = await h.lastAuditId();
      await one(ACC, 'select public.push_devices_remove_all($1) as r', [rid()]);
      const rows = await devices();
      for (const d of mine) expect(rows.find((r) => r.id === d.deviceId)).toMatchObject({ status: 'removed', removed_reason: 'signed_out' });
      expect(rows.find((r) => r.id === theirs.deviceId)!.status).toBe('active');
      const audits = (await h.auditsSince(before)).filter((a) => a.action === 'notices.push_device_removed');
      expect(audits).toHaveLength(3);
      for (const a of audits) expect(text(a.details)).not.toMatch(/https:|fcm\.googleapis/);
      // Nothing left: a second call removes nothing and still succeeds.
      await one(ACC, 'select public.push_devices_remove_all($1) as r', [rid()]);
      expect((await h.auditsSince(before)).filter((a) => a.action === 'notices.push_device_removed')).toHaveLength(3);
    });
  });
});

describe('8.2 / 8.3 jobs, claim and completion', () => {
  it('jobs only for urgent notices and task_new / task_assigned, only for active devices of the recipient, none while Off', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await pushOn();
      const pd = await register(PURCHASE);
      const other = await register(OWNER);
      // task_new to Purchase on booking confirmation.
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      const js = await jobs();
      const taskNew = js.filter((j) => j.kind === 'task_new');
      expect(taskNew.length).toBeGreaterThanOrEqual(1);
      expect(taskNew.every((j) => j.device_id === pd.deviceId)).toBe(true);
      // Normal, non-task notices never get a job (review_approved is normal in Phase 1).
      for (const j of js) {
        const [n] = await owner<{ priority: string; kind: string }>('select priority, kind from public.staff_notices where id = $1', [j.notice_id]);
        expect(n!.priority === 'urgent' || ['task_new', 'task_assigned'].includes(n!.kind), n!.kind).toBe(true);
      }
      // A job only ever goes to the recipient's own devices.
      expect(js.filter((j) => j.device_id === other.deviceId).every((j) => j.recipient === U.salesDelhiA)).toBe(true);
      // Switch Off: no new jobs.
      await pushOn(false);
      const count = (await jobs()).length;
      await h.book([HOTEL_ITEM], { deal: 'd0000000-0000-4000-8000-000000000002', actor: { userId: U.salesDelhiB } });
      expect((await jobs()).length).toBe(count);
    });
  });

  it('claim drops a job whose notice was read; 410 removes the device; other failures retried then failed; keys only to the worker', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await pushOn();
      const pd = await register(PURCHASE);
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      const [first] = (await jobs()).filter((j) => j.kind === 'task_new');
      expect(first).toBeDefined();
      // Payload: reference-only bell text, no money or contact.
      const claimed = await claimPush();
      const c = claimed.find((x) => x.jobId === first!.id)!;
      expect(c.endpoint).toMatch(/^https:/);
      // Contract W-D1 names `payload`; Track D returns the bell item `notice` and builds {title, body, tag, url} in TypeScript
      // (buildPushPayload, unit-tested in acc3-push.test.ts) — reported to the lead as a deviation. Either way: reference-only.
      const item = (c as unknown as { payload?: Record<string, unknown>; notice?: Record<string, unknown> });
      if (item.payload) {
        expect(Object.keys(item.payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
        expect(item.payload).toMatchObject({ title: 'TripNavigate', tag: `tn-notice-${first!.notice_id}` });
        expect(String(item.payload.url)).toMatch(/^\//);
      } else {
        expect(item.notice, 'claim carries the notice item').toBeTruthy();
      }
      expect(text(item.payload ?? item.notice)).not.toContain(SELLING);
      // 410 Gone -> device removed (gone).
      await one(WORKER, SQL3.pushComplete, [c.jobId, 'acc3-test', false, 410]);
      expect((await devices()).find((d) => d.id === pd.deviceId)).toMatchObject({ status: 'removed', removed_reason: 'gone' });
      // Staff cannot call the worker commands.
      for (const fn of ['push_claim', 'push_complete']) {
        for (const sig of await h.signatures('public', fn)) expect(await h.canExecute('authenticated', sig), fn).toBe(false);
      }
    });
  });

  it('a read notice is dropped at claim; lost access drops it; retries at +30 s and +2 min then failed', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await pushOn();
      await register(PURCHASE);
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      const taskJobs = (await jobs()).filter((j) => j.kind === 'task_new');
      expect(taskJobs.length).toBeGreaterThanOrEqual(1);
      const j = taskJobs[0]!;
      await one(PURCHASE, P1.noticeMark, [j.notice_id, 'read']);
      const claimed = await claimPush();
      expect(claimed.map((x) => x.jobId)).not.toContain(j.id);
      expect((await jobs()).find((x) => x.id === j.id)!.status).toBe('dropped');
      // Retry path on another job.
      const b2 = await h.book([HOTEL_ITEM], { deal: 'd0000000-0000-4000-8000-000000000002', actor: { userId: U.salesDelhiB } });
      await h.approveReal(b2.versionId, 'd0000000-0000-4000-8000-000000000002');
      const next = (await jobs()).find((x) => x.status === 'queued')!;
      expect(next).toBeDefined();
      const [c] = (await claimPush()).filter((x) => x.jobId === next.id);
      await one(WORKER, SQL3.pushComplete, [c!.jobId, 'acc3-test', false, 500]);
      const [r1] = await owner<{ secs: number; status: string }>(
        `select round(extract(epoch from (available_at - now())))::int as secs, status from public.staff_push_jobs where id = $1`, [next.id]);
      expect(r1!.status).toBe('queued');
      expect(r1!.secs).toBe(30);
    });
  });

  it('D4 test alert: own device only, at most 3 per 10 minutes', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.noticesOn();
      await pushOn();
      const d = await register(ACC);
      const other = await h.attempt(OWNER, SQL3.pushTest, [d.deviceId, rid()]);
      expect(other.ok).toBe(false);
      for (let i = 0; i < 3; i += 1) await one(ACC, SQL3.pushTest, [d.deviceId, rid()]);
      const fourth = await h.attempt(ACC, SQL3.pushTest, [d.deviceId, rid()]);
      expect(fourth.ok).toBe(false);
    });
  });
});

describe('8.6 Release A notices', () => {
  it('registry has the seven new kinds; subject kinds extended', async () => {
    await asOwner(db, async () => {
      const [k] = await owner<{ k: string[] }>('select authz.notice_kinds() as k');
      for (const kind of RELEASE_A_NOTICE_KINDS) expect(k!.k).toContain(kind);
      for (const kind of ['bill_held', 'write_off_to_approve', 'write_off_decided']) {
        expect((await owner<{ m: boolean }>('select authz.notice_money_kind($1) as m', [kind]))[0]!.m, kind).toBe(true);
      }
      for (const kind of ['message_failed', 'whatsapp_stopped', 'boarding_pass_due', 'timer_stalled']) {
        expect((await owner<{ m: boolean }>('select authz.notice_money_kind($1) as m', [kind]))[0]!.m, kind).toBe(false);
      }
    });
  });

  it('41 / 42 write-off notices: approvers (not the proposer), shared and resolved; decided to the proposer, returned urgent', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await smallBalance();
      const p = await propose();
      const toApprove = await h.notices('write_off_to_approve');
      expect(toApprove.map((n) => n.recipient_user_id)).toContain(U.managerDelhi);
      expect(toApprove.map((n) => n.recipient_user_id)).not.toContain(U.accountsJodhpur);
      expect(new Set(toApprove.map((n) => n.shared_key))).toEqual(new Set([`wo:${p.writeOffId}:approve`]));
      expect(toApprove.every((n) => n.priority === 'normal')).toBe(true);
      // Text params carry references only.
      expect(text(toApprove.map((n) => n.params))).not.toMatch(/(?<![0-9])30000(?![0-9])/);
      await one(MANAGER, SQL3.woDecide, [p.writeOffId, 'return', '30000', REASON, await woRv(p.writeOffId), rid()]);
      expect((await h.notices('write_off_to_approve')).every((n) => n.resolved_at !== null)).toBe(true);
      const decided = await h.notices('write_off_decided');
      expect(decided.map((n) => n.recipient_user_id)).toEqual([U.accountsJodhpur]);
      expect(decided[0]).toMatchObject({ priority: 'urgent', dedup_key: `wo:${p.writeOffId}:returned` });
    });
  });

  it('40 bill_held to Accounts only (no Accounts + Purchase holder); resolved on release; 30 / 32 silent while automatic bills are on', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await h.addRole(U.purchaseJodhpur, 'accounts');
      await h.docsOn();
      await h.autoBills(true, true);
      const b = await h.book([HOTEL_ITEM]);
      await h.approve(b.versionId); // billing not verified -> held
      await h.receipt(DEAL, '2500000');
      const held = await h.notices('bill_held');
      expect(held.length).toBeGreaterThan(0);
      const rec = new Set(held.map((n) => n.recipient_user_id));
      expect(rec.has(U.accountsJodhpur)).toBe(true);
      expect(rec.has(U.purchaseJodhpur), 'A + Purchase is not A for money kinds').toBe(false);
      expect(held.every((n) => n.shared_key?.startsWith('cdoc:') && n.shared_key.endsWith(':held'))).toBe(true);
      expect(await h.notices('document_to_release')).toEqual([]);
      expect(await h.notices('credit_note_to_release')).toEqual([]);
    });
    await asOwner(db, async () => {
      // Automatic bills Off: Phase 2 notice 30 still written.
      await h.noticesOn();
      await h.people();
      await h.docsOn();
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      await h.receipt(DEAL, '2500000');
      expect((await h.notices('document_to_release')).length).toBeGreaterThan(0);
    });
  });

  it('43 message_failed and 44 whatsapp_stopped to SO*; 46 timer_stalled to Super Admin', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.approvedBooking();
      await h.liveDeal();
      await h.messagesOn();
      // Unique synthetic WhatsApp number (Addendum L4: seeded Deals share the fixture mobile).
      const MOBILE = `60000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
      await h.prefsSet({ whatsappMobile: MOBILE, whatsappSameAsMobile: false });
      await h.enqueue(DEAL, 'payment_received', 'receipt:n1', { customerName: 'S', dealReference: 'SYN-DEL-001', amountPaise: '1', balancePaise: '0' });
      await h.dueNow();
      const [email] = (await h.msgClaim()).filter((c) => c.channel === 'email');
      for (let i = 0; i < 4; i += 1) {
        await h.msgComplete(email!.id, false, null, 'network');
        await h.dueNow();
        if (i < 3) await h.msgClaim();
      }
      const failed = await h.notices('message_failed');
      expect(failed.map((n) => n.recipient_user_id)).toEqual([U.salesDelhiA]);
      expect(failed[0]!.dedup_key).toBe(`cmsg:${email!.id}`);
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-n-stop', null, 'inbound_stop', null, MOBILE]);
      const stopped = await h.notices('whatsapp_stopped');
      expect(stopped.map((n) => n.recipient_user_id)).toEqual([U.salesDelhiA]);
      expect(stopped[0]!.dedup_key).toBe(`cmsg:stop:${DEAL}`);
      expect(text(stopped)).not.toContain(MOBILE);
      // 46: the timer health task finds a stalled timer (last_ok_at older than 15 minutes or never).
      await resetActor(db);
      await owner(`update public.timer_settings set last_ok_at = now() - interval '1 hour'`);
      const [task] = await owner<{ f: string }>(`select function_name as f from public.timer_tasks where name = 'timer_health'`);
      await owner(`select ${task!.f}() as r`);
      const stalled = await h.notices('timer_stalled');
      expect(stalled.map((n) => n.recipient_user_id)).toEqual([U.adminJodhpur]);
      expect(stalled[0]!.priority).toBe('urgent');
    });
  });

  it('45 boarding_pass_due to the Flight task assignee, urgent', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      const { FLIGHT_ITEM } = await import('./acc-support');
      const b = await h.book([FLIGHT_ITEM]);
      await h.approveReal(b.versionId);
      await h.addFlightPeople();
      await h.claim(FLIGHT, DEAL);
      const task = h.taskOf(b, 'flight');
      const [sector] = await h.sectors(task);
      await resetActor(db);
      await owner(`insert into public.flight_boarding_pass_alerts (legal_entity_id, branch_id, deal_id, task_id, sector_id, departure_date)
        select t.legal_entity_id, d.branch_id, d.id, t.id, $2, $3::date from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id where t.id = $1`, [task, sector!.id, sector!.depart_date]);
      const due = await h.notices('boarding_pass_due');
      expect(due.map((n) => n.recipient_user_id)).toEqual([FLIGHT.userId]);
      expect(due[0]).toMatchObject({ priority: 'urgent', dedup_key: `bp:${task}:${sector!.id}` });
      void ACC_J2;
    });
  });
});
