import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, HOTEL_ITEM } from './acc-support';
import { ACC, DEAL, OWNER, PURCHASE, REASON, SQL3, SUPER, U, WORKER, acc3Helpers, asItems, rid } from './acc3-support';

/**
 * Accounts phase 3, track D (own tests): resolutions and worker paths the
 * independent suite does not reach - 43 resolved by a sent re-send, 45 resolved
 * by a stored boarding pass, 46 stays open in the tick that wrote it, the
 * push test job, device removal drops queued jobs, the 60-day cleanup, the
 * kick is a no-op without pg_net, and the bell inbox carries pushEnabled.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner } = h;
const P256 = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);
const ep = () => `https://fcm.googleapis.com/fcm/send/syn-${rid()}`;

describe('track D resolutions', () => {
  it('43 is resolved when a re-send of the failed message is sent', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.approvedBooking();
      await h.liveDeal();
      await h.messagesOn();
      await h.enqueue(DEAL, 'payment_received', 'receipt:d1', { customerName: 'S', dealReference: 'SYN-DEL-001', amountPaise: '1', balancePaise: '0' });
      await h.dueNow();
      const [email] = (await h.msgClaim()).filter((c) => c.channel === 'email');
      for (let i = 0; i < 4; i += 1) {
        await h.msgComplete(email!.id, false, null, 'provider_error');
        await h.dueNow();
        if (i < 3) await h.msgClaim();
      }
      const failed = await h.notices('message_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.resolved_at).toBeNull();
      await one(OWNER, SQL3.resend, [email!.id, rid()]);
      await h.dueNow();
      const again = (await h.msgClaim()).find((c) => c.channel === 'email');
      expect(again).toBeDefined();
      await h.msgComplete(again!.id, true, `prov-${rid()}`, null);
      expect((await h.notices('message_failed'))[0]!.resolved_at).not.toBeNull();
    });
  });

  it('45 is resolved when a boarding pass of the task is stored', async () => {
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
      await owner(
        `insert into public.flight_boarding_pass_alerts (legal_entity_id, branch_id, deal_id, task_id, sector_id, departure_date)
         select t.legal_entity_id, t.branch_id, t.deal_id, t.id, $2, $3::date from public.fulfilment_tasks t where t.id = $1`,
        [task, sector!.id, sector!.depart_date]);
      const due = await h.notices('boarding_pass_due');
      expect(due.map((n) => n.recipient_user_id)).toEqual([FLIGHT.userId]);
      expect(due[0]).toMatchObject({ priority: 'urgent', shared_key: `bp:${task}:${sector!.id}`, resolved_at: null });
      const id = '0e000000-0000-4000-8000-0000000000b1';
      await owner(
        `insert into public.department_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, status, uploaded_by, stored_at)
         select $1::uuid, t.id, t.legal_entity_id, 'boarding_pass', t.legal_entity_id::text || '/' || t.id::text || '/' || $1::text, 'bp.pdf',
                'application/pdf', 10, repeat('a', 64), 'stored', $2, now()
         from public.fulfilment_tasks t where t.id = $3`,
        [id, FLIGHT.userId, task]);
      expect((await h.notices('boarding_pass_due'))[0]!.resolved_at).not.toBeNull();
    });
  });

  it('46 stays open in the tick that wrote it; the health check sees a good timer after a tick', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await resetActor(db);
      await owner(`update public.timer_settings set last_ok_at = now() - interval '1 hour'`);
      await owner('select authz.timer_health()');
      expect((await h.notices('timer_stalled')).length).toBeGreaterThan(0);
      await one(WORKER, 'select public.timer_tick() as r', []);
      await resetActor(db);
      // Same transaction = same tick: still open (resolved by the NEXT good tick).
      expect((await h.notices('timer_stalled')).every((n) => n.resolved_at === null)).toBe(true);
      expect((await owner<{ ok: boolean }>('select authz.notice_timer_healthy() as ok'))[0]!.ok).toBe(true);
    });
  });
});

describe('track D worker paths', () => {
  it('test job claims without a notice; removing a device drops its queued jobs; inbox carries pushEnabled', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await one(SUPER, SQL3.setPush, [true, REASON]);
      const inbox = await one<{ pushEnabled: boolean }>(ACC, 'select public.notice_inbox(null, 10) as r', []);
      expect(inbox.pushEnabled).toBe(true);
      const d = await one<{ deviceId: string }>(ACC, SQL3.pushRegister, [ep(), P256, AUTH, 'Chrome on Windows', rid()]);
      await one(ACC, SQL3.pushTest, [d.deviceId, rid()]);
      const claimed = asItems<{ jobId: string; test: boolean; notice: unknown; urgent: boolean }>(
        await one(WORKER, SQL3.pushClaim, ['d-test', 10, 60]));
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ test: true, notice: null, urgent: true });
      await one(WORKER, SQL3.pushComplete, [claimed[0]!.jobId, 'd-test', true, 201]);
      const [dev] = await owner<{ last_used_at: string | null }>('select last_used_at from public.staff_push_devices where id = $1', [d.deviceId]);
      expect(dev!.last_used_at).not.toBeNull();
      // A queued job of a removed device is dropped.
      const pd = await one<{ deviceId: string }>(PURCHASE, SQL3.pushRegister, [ep(), P256, AUTH, 'Firefox on Linux', rid()]);
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      const queued = await owner<{ id: string }>(`select id from public.staff_push_jobs where device_id = $1 and status = 'queued'`, [pd.deviceId]);
      expect(queued.length).toBeGreaterThan(0);
      await one(PURCHASE, SQL3.pushRemove, [pd.deviceId, rid()]);
      const after = await owner<{ status: string }>('select status from public.staff_push_jobs where device_id = $1', [pd.deviceId]);
      expect(after.every((j) => j.status === 'dropped')).toBe(true);
    });
  });

  it('Addendum O3: register refuses non push-service endpoints; claim fails such a job; sign out of all devices removes every device', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await one(SUPER, SQL3.setPush, [true, REASON]);
      for (const bad of ['https://push.example.test/ep/1', 'https://fcm.googleapis.com.evil.test/x', 'https://user@fcm.googleapis.com/x']) {
        const r = await h.attempt(ACC, SQL3.pushRegister, [bad, P256, AUTH, 'Chrome on Windows', rid()]);
        expect(r.ok, bad).toBe(false);
      }
      const d1 = await one<{ deviceId: string }>(ACC, SQL3.pushRegister, [ep(), P256, AUTH, 'Chrome on Windows', rid()]);
      await one(ACC, SQL3.pushRegister, ['https://updates.push.services.mozilla.com/wpush/v2/syn', P256, AUTH, 'Firefox on Linux', rid()]);
      // A device row with a foreign endpoint (written before the allowlist) is never sent to.
      await resetActor(db);
      await owner(`insert into public.staff_push_devices (user_id, endpoint, endpoint_hash, p256dh, auth_key, label, request_id)
                   values ($1, 'https://push.example.test/old', repeat('b', 64), $2, $3, 'Old device', gen_random_uuid())`,
        [U.accountsJodhpur, P256, AUTH]);
      const [old] = await owner<{ id: string }>(`select id from public.staff_push_devices where endpoint = 'https://push.example.test/old'`);
      await one(ACC, SQL3.pushTest, [old!.id, rid()]);
      const claimed = asItems<{ jobId: string }>(await one(WORKER, SQL3.pushClaim, ['d-o3', 10, 60]));
      expect(claimed).toEqual([]);
      const [j] = await owner<{ status: string; last_error_code: string }>(
        'select status, last_error_code from public.staff_push_jobs where device_id = $1', [old!.id]);
      expect(j).toEqual({ status: 'failed', last_error_code: 'endpoint_not_allowed' });
      // Worker-side refusal: failed at once, no retry.
      await one(ACC, SQL3.pushTest, [d1.deviceId, rid()]);
      const [c] = asItems<{ jobId: string }>(await one(WORKER, SQL3.pushClaim, ['d-o3', 10, 60]));
      expect((await one<{ outcome: string }>(WORKER, 'select public.push_complete($1, $2, false, null, $3) as r', [c!.jobId, 'd-o3', 'endpoint_not_allowed'])).outcome)
        .toBe('failed');
      // Sign out of all devices.
      const r = await one<{ removed: number }>(ACC, 'select public.push_devices_remove_all($1) as r', [rid()]);
      expect(r.removed).toBe(3);
      const left = await owner<{ n: number }>(`select count(*)::int as n from public.staff_push_devices where user_id = $1 and status = 'active'`, [U.accountsJodhpur]);
      expect(left[0]!.n).toBe(0);
      const removed = await owner<{ reason: string }>(`select removed_reason as reason from public.staff_push_devices where user_id = $1`, [U.accountsJodhpur]);
      expect(removed.every((x) => x.reason === 'signed_out')).toBe(true);
      const audits = await h.audits('notices.push_device_removed');
      expect(audits.filter((a) => (a.details as { reason?: string }).reason === 'signed_out').length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(audits)).not.toContain('fcm.googleapis.com');
      expect(await h.canExecute('anon', 'public.push_devices_remove_all(uuid)')).toBe(false);
    });
  });

  it('60-day cleanup; the kick needs pg_net and does nothing here; staff cannot run the cleanup', async () => {
    await asOwner(db, async () => {
      await h.people();
      await one(SUPER, SQL3.setPush, [true, REASON]);
      const d = await one<{ deviceId: string }>(ACC, SQL3.pushRegister, [ep(), P256, AUTH, 'Chrome on Windows', rid()]);
      await resetActor(db);
      await owner(`update public.staff_push_devices set last_used_at = now() - interval '61 days' where id = $1`, [d.deviceId]);
      const [r] = await owner<{ r: { unused: number } }>('select authz.push_cleanup() as r');
      expect(r!.r.unused).toBe(1);
      const [dev] = await owner<{ status: string; removed_reason: string }>('select status, removed_reason from public.staff_push_devices where id = $1', [d.deviceId]);
      expect(dev).toEqual({ status: 'removed', removed_reason: 'unused_60_days' });
      expect((await owner<{ k: boolean }>('select authz.push_kick() as k'))[0]!.k).toBe(false);
      expect(await h.canExecute('authenticated', 'authz.push_cleanup()')).toBe(false);
      expect((await owner<{ n: string }>(`select function_name as n from public.timer_tasks where name = 'push_cleanup'`))[0]!.n).toBe('authz.push_cleanup');
      void U;
    });
  });
});
