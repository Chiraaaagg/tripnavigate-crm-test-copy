import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError, resetActor } from '../helpers/db';
import { CONTACT, FLIGHT, HOTEL_ITEM, FLIGHT_ITEM, OTHER_ENTITY, SALES_B, VISA, dayFrom } from './acc-support';
import {
  ACC, CHANNELS, DEAL, LOUD_TYPES, VISA_J2, MANAGER, MESSAGE_TYPES, OWNER, PURCHASE, QUIET_TYPES, REASON, SQL3, SUPER, WORKER, acc3Helpers, rid,
  text,
} from './acc3-support';

/**
 * Accounts phase 3, Track T — Track A database tests (contract 5.1-5.10,
 * 13, 14, 16.1 A). Written from the contract, not from Track A's code.
 *
 * Note on `test_deal` (5.5): every fixture Deal is synthetic, so a trigger
 * firing on one writes a `skipped / test_deal` row when its switch is On —
 * which is how these tests prove "the trigger fired, once". A queued row
 * needs `liveDeal()` (see acc3-support.ts, ASSUMPTION / CONTRACT GAP).
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
/** A unique synthetic WhatsApp number (60000xxxxx) for STOP tests: seeded Deals share the fixture contact mobile (Addendum L4). */
const uniqueMobile = () => `60000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
const ENQ_PARAMS = { customerName: 'Synthetic Contact', dealReference: 'SYN-DEL-001', amountPaise: '2500000', balancePaise: '0' };

/** Approved hotel booking on DEAL (billing verified), relabelled live, every switch On, pilot-only Off. */
async function liveBooked() {
  const b = await h.approvedBooking();
  await h.liveDeal();
  await h.messagesOn();
  return b;
}

describe('5.1 by the CRM actor', () => {
  it('system_rule validates the name; write_system_audit adds by crm and the rule; neither is granted to any role', async () => {
    await asOwner(db, async () => {
      expect((await owner<{ r: string }>(SQL3.systemRule, ['customer_message_dispatch']))[0]!.r).toBe('customer_message_dispatch');
      await expectDbError(db, () => owner(SQL3.systemRule, ['Bad Rule!']), {});
      await expectDbError(db, () => owner(SQL3.systemRule, ['ab']), {});
      const entity = await h.entityId();
      await owner(SQL3.writeSystemAudit, ['accounts.customer_document.auto_drafted', entity, null, 'deal', DEAL, 'adv_on_receipt',
        JSON.stringify({ dealId: DEAL })]);
      const [row] = (await h.audits('accounts.customer_document.auto_drafted')).slice(-1);
      expect(row!.details).toMatchObject({ by: 'crm', rule: 'adv_on_receipt', dealId: DEAL });
      for (const role of ['authenticated', 'anon', 'service_role']) {
        for (const sig of [...await h.signatures('authz', 'system_rule'), ...await h.signatures('authz', 'write_system_audit')]) {
          expect(await h.canExecute(role, sig), `${role} ${sig}`).toBe(false);
        }
      }
    });
  });
});

describe('5.2 timer', () => {
  it('single settings row Off by default; tick is service_role only; tasks run in isolation; runs are recorded', async () => {
    await asOwner(db, async () => {
      const [s] = await owner<{ enabled: boolean }>('select enabled from public.timer_settings');
      expect(s!.enabled).toBe(false);
      expect((await owner<{ n: number }>('select count(*)::int as n from public.timer_settings'))[0]!.n).toBe(1);
      for (const sig of await h.signatures('public', 'timer_tick')) {
        expect(await h.canExecute('authenticated', sig)).toBe(false);
        expect(await h.canExecute('anon', sig)).toBe(false);
        expect(await h.canExecute('service_role', sig)).toBe(true);
      }
      // Two synthetic tasks: one fails, one succeeds (functions created inside the rolled-back transaction).
      await db.exec(`create function public.t_acc_ok() returns jsonb language sql as $$ select '{"done": 1}'::jsonb $$`);
      await db.exec(`create function public.t_acc_fail() returns jsonb language plpgsql as $$ begin raise exception 'synthetic failure'; end $$`);
      await db.exec('grant execute on function public.t_acc_ok(), public.t_acc_fail() to service_role');
      await owner(`insert into public.timer_tasks (name, function_name, every_minutes, enabled) values
        ('t_acc_fail', 'public.t_acc_fail', 1, true), ('t_acc_ok', 'public.t_acc_ok', 1, true)`);
      // Other tracks' registered tasks are switched off for this check so only the two synthetic tasks run.
      await owner(`update public.timer_tasks set enabled = false where name not in ('t_acc_fail', 't_acc_ok')`);
      const before = (await owner<{ n: number }>('select count(*)::int as n from public.timer_runs'))[0]!.n;
      const result = await one<Record<string, unknown>>(WORKER, SQL3.timerTick, []);
      expect(text(result)).not.toContain('synthetic failure');
      const tasks = await owner<{ name: string; last_run_at: string | null; last_error_code: string | null; last_result: unknown }>(
        `select name, last_run_at::text, last_error_code, last_result from public.timer_tasks where name in ('t_acc_fail', 't_acc_ok') order by name`);
      expect(tasks[0]!.last_error_code, 'failing task records an error code').not.toBeNull();
      expect(tasks[1]!.last_run_at, 'good task still ran').not.toBeNull();
      expect(tasks[1]!.last_error_code).toBeNull();
      expect((await owner<{ n: number }>('select count(*)::int as n from public.timer_runs'))[0]!.n).toBe(before + 1);
      const [run] = await owner<{ results: Record<string, unknown> }>('select results from public.timer_runs order by started_at desc limit 1');
      expect(Object.keys(run!.results)).toEqual(expect.arrayContaining(['t_acc_ok']));
      // A task that is not due does not run twice in the same minute.
      const lastOk = tasks[1]!.last_run_at;
      await one(WORKER, SQL3.timerTick, []);
      const [again] = await owner<{ t: string }>(`select last_run_at::text as t from public.timer_tasks where name = 't_acc_ok'`);
      expect(again!.t).toBe(lastOk);
      // Staff can never call it.
      await expectDbError(db, () => h.run(OWNER, SQL3.timerTick, []), {});
    });
  });

  it('task registry: name and function rules; each Release A track registers its own tasks', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => owner(`insert into public.timer_tasks (name, function_name, every_minutes) values ('Bad-Name', 'public.x', 1)`), {});
      await expectDbError(db, () => owner(`insert into public.timer_tasks (name, function_name, every_minutes) values ('ok_name', 'evil.fn', 1)`), {});
      await expectDbError(db, () => owner(`insert into public.timer_tasks (name, function_name, every_minutes) values ('ok_name', 'public.fn', 0)`), {});
      await expectDbError(db, () => owner(`insert into public.timer_tasks (name, function_name, every_minutes) values ('ok_name', 'public.fn', 1441)`), {});
      const names = (await owner<{ name: string }>('select name from public.timer_tasks')).map((r) => r.name);
      // Track A's tasks (5.2, 5.5, 5.6). Other tracks' tasks are checked in their own files.
      expect(names).toEqual(expect.arrayContaining(['timer_health', 'customer_trip_reminders', 'flight_boarding_pass_due']));
    });
  });

  it('A11 timer switch: Super Admin only, reason 10..500, audited without values; nothing is scheduled by a migration', async () => {
    await asOwner(db, async () => {
      await refused(ACC, SQL3.setTimer, [true, REASON], 'not_authorized', '42501');
      await refusedHint(SUPER, SQL3.setTimer, [true, 'short'], 'invalid_input', /reason/);
      await one(SUPER, SQL3.setTimer, [true, REASON]);
      expect((await owner<{ enabled: boolean }>('select enabled from public.timer_settings'))[0]!.enabled).toBe(true);
      const [a] = (await h.audits('settings.timer_changed')).slice(-1);
      expect(a!.reason).toBe(REASON);
      // No cron job exists after migrations (PGlite has no cron schema: vacuously true; real stack: no crm-timer job).
      const [cron] = await owner<{ has: boolean }>(`select to_regclass('cron.job') is not null as has`);
      if (cron!.has) {
        const [n] = await owner<{ n: number }>(`select count(*)::int as n from cron.job where jobname = 'crm-timer'`);
        expect(n!.n).toBe(0);
      }
    });
  });
});

describe('5.4 switches, pilot and templates', () => {
  it('18 switches per entity seeded Off, pilot-only On; A7 refuses WhatsApp On without approved templates', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      const rows = await owner<{ message_type: string; channel: string; enabled: boolean; row_version: number }>(
        'select message_type, channel, enabled, row_version from public.customer_message_switches where legal_entity_id = $1', [entity]);
      expect(rows).toHaveLength(18);
      expect(rows.every((r) => !r.enabled)).toBe(true);
      expect(new Set(rows.map((r) => `${r.message_type}/${r.channel}`)).size).toBe(18);
      for (const t of MESSAGE_TYPES) for (const c of CHANNELS) expect(rows.some((r) => r.message_type === t && r.channel === c)).toBe(true);
      expect((await owner<{ p: boolean }>('select pilot_only as p from public.customer_message_settings where legal_entity_id = $1', [entity]))[0]!.p)
        .toBe(true);
      const wa = rows.find((r) => r.message_type === 'payment_received' && r.channel === 'whatsapp')!;
      await refused(ACC, SQL3.setSwitch, [entity, 'payment_received', 'whatsapp', true, REASON, wa.row_version], 'not_authorized', '42501');
      await refused(SUPER, SQL3.setSwitch, [entity, 'payment_received', 'whatsapp', true, REASON, wa.row_version], 'template_not_approved', '55000');
      await h.templates(['payment_received'], 'approved');
      await one(SUPER, SQL3.setSwitch, [entity, 'payment_received', 'whatsapp', true, REASON, wa.row_version]);
      await refused(SUPER, SQL3.setSwitch, [entity, 'payment_received', 'whatsapp', false, REASON, wa.row_version], 'version_changed', '40001');
      const em = rows.find((r) => r.message_type === 'payment_received' && r.channel === 'email')!;
      await one(SUPER, SQL3.setSwitch, [entity, 'payment_received', 'email', true, REASON, em.row_version]);
      const audit = (await h.audits('settings.messages_changed')).slice(-1)[0]!;
      expect(audit.reason).toBe(REASON);
      // A10 / A8 / A9: Super Admin only.
      await refused(ACC, SQL3.setTemplate, [entity, 'tn_payment_received_en_v1', 'approved', REASON], 'not_authorized', '42501');
      await one(SUPER, SQL3.setTemplate, [entity, 'tn_payment_received_en_v1', 'approved', REASON]);
      await refused(MANAGER, SQL3.setPilotOnly, [entity, false, REASON], 'not_authorized', '42501');
      await one(SUPER, SQL3.setPilotOnly, [entity, false, REASON]);
      await one(SUPER, SQL3.pilotSet, [entity, DEAL, true, REASON]);
    });
  });
});

describe('5.5 cmsg_enqueue', () => {
  it('switch Off: no row at all; On: one row per channel, once per event (replay -> still one)', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.switchOff('payment_received', 'email');
      await h.switchOff('payment_received', 'whatsapp');
      await h.enqueue(DEAL, 'payment_received', 'receipt:x1', ENQ_PARAMS);
      expect(await h.messages(DEAL, 'payment_received')).toEqual([]);
      await h.messagesOn(['payment_received']);
      await h.enqueue(DEAL, 'payment_received', 'receipt:x1', ENQ_PARAMS);
      await h.enqueue(DEAL, 'payment_received', 'receipt:x1', ENQ_PARAMS);
      const rows = await h.messages(DEAL, 'payment_received');
      expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'whatsapp']);
      expect(rows.every((r) => r.status === 'queued' && r.event_key === 'receipt:x1' && r.language === 'en')).toBe(true);
      expect(rows.every((r) => r.template_code === 'tn_payment_received_en_v1')).toBe(true);
      // The address is never stored: only the masked form.
      expect(text(rows)).not.toContain(CONTACT.mobile);
      expect(text(rows)).not.toContain(CONTACT.email);
      expect(rows.find((r) => r.channel === 'whatsapp')!.to_masked).toMatch(/^98x+11$/);
      // One switch only: the other channel writes nothing.
      await h.switchOff('payment_received', 'whatsapp');
      await h.enqueue(DEAL, 'payment_received', 'receipt:x2', ENQ_PARAMS);
      expect((await h.messages(DEAL, 'payment_received')).filter((r) => r.event_key === 'receipt:x2').map((r) => r.channel)).toEqual(['email']);
    });
  });

  it('skip reasons in contract order: test_deal > not_in_pilot > trip_cancelled > channel_off_on_deal > no_contact > opted_out > template_not_approved', async () => {
    await asOwner(db, async () => {
      await h.approvedBooking();
      await h.messagesOn(['payment_received'], CHANNELS, { pilotOnly: true });
      const reasons = async (key: string) => {
        await h.enqueue(DEAL, 'payment_received', key, ENQ_PARAMS);
        const rows = (await h.messages(DEAL, 'payment_received')).filter((r) => r.event_key === key);
        return Object.fromEntries(rows.map((r) => [r.channel, `${r.status}/${r.skip_reason}`]));
      };
      // Synthetic Deal, not in the pilot list: test_deal wins.
      expect(await reasons('k1')).toEqual({ email: 'skipped/test_deal', whatsapp: 'skipped/test_deal' });
      await h.liveDeal();
      expect(await reasons('k2')).toEqual({ email: 'skipped/not_in_pilot', whatsapp: 'skipped/not_in_pilot' });
      await one(SUPER, SQL3.pilotSet, [await h.entityId(), DEAL, true, REASON]);
      // channel off on the Deal + opted out + template not approved.
      await h.prefsSet({ emailOff: true, whatsappOff: false, offReason: REASON });
      await owner(`insert into public.customer_whatsapp_optouts (legal_entity_id, mobile, opted_out_at, source) values ($1, $2, now(), 'staff')`,
        [await h.entityId(), CONTACT.mobile]);
      await h.templates(['payment_received'], 'submitted');
      expect(await reasons('k3')).toEqual({ email: 'skipped/channel_off_on_deal', whatsapp: 'stopped/opted_out' });
      await owner('update public.customer_whatsapp_optouts set restarted_at = now(), restart_source = $2 where mobile = $1', [CONTACT.mobile, 'staff']);
      expect((await reasons('k4')).whatsapp).toBe('skipped/template_not_approved');
      // A cancelled trip comes before the channel switch.
      await h.cancelApproved(DEAL);
      expect(await reasons('k5')).toEqual({ email: 'skipped/trip_cancelled', whatsapp: 'skipped/trip_cancelled' });
    });
  });

  it('no_contact for a Deal without a confirmed booking contact', async () => {
    await asOwner(db, async () => {
      await h.liveDeal();
      await h.messagesOn(['payment_received']);
      await h.enqueue(DEAL, 'payment_received', 'k-nc', ENQ_PARAMS);
      const rows = await h.messages(DEAL, 'payment_received');
      expect(rows.map((r) => `${r.channel}:${r.status}/${r.skip_reason}`).sort()).toEqual(['email:skipped/no_contact', 'whatsapp:skipped/no_contact']);
    });
  });

  it('quiet hours: the five quiet types wait for 08:00 India time between 21:00 and 08:00; the other four never wait', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      for (const [i, type] of MESSAGE_TYPES.entries()) await h.enqueue(DEAL, type, `q:${i}`, ENQ_PARAMS);
      // Expected not_before computed by the database clock in the same transaction (now() is fixed per transaction).
      const rows = await owner<{ message_type: string; ok: boolean; nb: string; quiet_now: boolean }>(
        `select m.message_type, m.not_before::text as nb,
           (extract(hour from now() at time zone 'Asia/Kolkata') >= 21 or extract(hour from now() at time zone 'Asia/Kolkata') < 8) as quiet_now,
           case when m.message_type = any ($2::text[])
                 and (extract(hour from now() at time zone 'Asia/Kolkata') >= 21 or extract(hour from now() at time zone 'Asia/Kolkata') < 8)
             then m.not_before = (date_trunc('day', now() at time zone 'Asia/Kolkata')
                    + case when extract(hour from now() at time zone 'Asia/Kolkata') >= 21 then interval '1 day' else interval '0' end
                    + interval '8 hours') at time zone 'Asia/Kolkata'
             else m.not_before <= now() + interval '1 second' end as ok
         from public.customer_messages m where m.deal_id = $1`, [DEAL, QUIET_TYPES]);
      expect(rows).toHaveLength(MESSAGE_TYPES.length * 2);
      for (const r of rows) expect(r.ok, `${r.message_type} not_before ${r.nb} (quiet now: ${r.quiet_now})`).toBe(true);
      expect(new Set(rows.map((r) => r.message_type))).toEqual(new Set([...QUIET_TYPES, ...LOUD_TYPES]));
    });
  });

  it('language is fixed at queue time (Hindi Deal gets the _hi_ template); later changes do not touch queued rows', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.prefsSet({ language: 'hi' });
      await h.enqueue(DEAL, 'refund_paid', 'payout:x', { customerName: 'S', dealReference: 'SYN-DEL-001', amountPaise: '100' });
      await h.prefsSet({ language: 'en' });
      const rows = await h.messages(DEAL, 'refund_paid');
      expect(rows.every((r) => r.language === 'hi' && r.template_code === 'tn_refund_paid_hi_v1')).toBe(true);
      await expectDbError(db, () => owner(`update public.customer_messages set language = 'en' where deal_id = $1`, [DEAL]), {});
    });
  });

  it('never fails its caller: a bad type or a broken queue returns without raising', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'not_a_type', 'x', {});
      expect(await h.messages(DEAL)).toEqual([]);
      await db.exec('alter table public.customer_messages add constraint t_acc_block check (false) not valid');
      await h.enqueue(DEAL, 'payment_received', 'receipt:blocked', ENQ_PARAMS);
      await db.exec('alter table public.customer_messages drop constraint t_acc_block');
      expect(await h.messages(DEAL)).toEqual([]);
      // The failure is counted on the health task (5.5).
      const [health] = await owner<{ c: string | null }>(`select last_error_code as c from public.timer_tasks where name = 'customer_message_health'`);
      expect(health, 'customer_message_health task registered').toBeDefined();
      expect(health!.c).not.toBeNull();
    });
  });
});

describe('5.5 triggers (each fires once per event)', () => {
  it('payment_received on receipt verify; booking_confirmed once per Deal at the first approval; refund_paid on payout', async () => {
    await asOwner(db, async () => {
      await h.messagesOn(); // synthetic Deal: rows are skipped test_deal, which proves the trigger fired.
      const b = await h.approvedBooking();
      const confirmed = await h.messages(DEAL, 'booking_confirmed');
      expect(confirmed.map((r) => `${r.channel}:${r.event_key}:${r.skip_reason}`).sort())
        .toEqual(['email:deal:test_deal', 'whatsapp:deal:test_deal']);
      expect(b.versionId).toBeTruthy();
      const rec = await h.receipt(DEAL, '2500000');
      const paid = await h.messages(DEAL, 'payment_received');
      expect(paid.map((r) => r.event_key)).toEqual([`receipt:${rec.id}`, `receipt:${rec.id}`]);
      // Params: the customer's own amount and the Deal balance after posting, never below zero.
      const p = paid[0]!.params as Record<string, string>;
      expect(Object.keys(p).sort()).toEqual(['amountPaise', 'balancePaise', 'customerName', 'dealReference'].sort());
      expect(p.amountPaise).toBe('2500000');
      expect(BigInt(p.balancePaise!)).toBeGreaterThanOrEqual(0n);
      // Refund paid on payout insert.
      await h.refundsOn();
      const over = await h.receipt(DEAL, '50000000');
      expect(over.id).toBeTruthy();
      const req = await h.request({ kind: 'overpayment', amountPaise: '100000', outcome: 'payout', payeeKind: 'original_payer', payeeReceiptId: over.id });
      await h.decide(req.refundRequestId, 'approve');
      const paidOut = await h.payout(req.refundRequestId);
      const refund = await h.messages(DEAL, 'refund_paid');
      expect(refund).toHaveLength(2);
      expect(refund[0]!.event_key).toBe(`payout:${paidOut.payoutId}`);
      expect(Object.keys(refund[0]!.params).sort()).toEqual(['amountPaise', 'customerName', 'dealReference'].sort());
      expect(refund.every((r) => r.attachment === null)).toBe(true);
    });
  });

  it('a failing enqueue never fails receipt_verify, accounts_review_approve or customer_refund_payout_record', async () => {
    await asOwner(db, async () => {
      await h.messagesOn();
      await db.exec('alter table public.customer_messages add constraint t_acc_block check (false) not valid');
      const b = await h.approvedBooking();
      const [review] = await owner<{ status: string }>('select status from public.accounts_booking_reviews where booking_version_id = $1', [b.versionId]);
      expect(review!.status).toBe('approved');
      const rec = await h.receipt(DEAL, '50000000');
      const [r] = await owner<{ status: string }>('select status from public.customer_receipts where id = $1', [rec.id]);
      expect(r!.status).toBe('verified');
      await h.refundsOn();
      const req = await h.request({ kind: 'overpayment', amountPaise: '100000', outcome: 'payout', payeeKind: 'original_payer', payeeReceiptId: rec.id });
      await h.decide(req.refundRequestId, 'approve');
      const out = await h.payout(req.refundRequestId);
      expect(out.payoutId ?? out.status).toBeTruthy();
      await db.exec('alter table public.customer_messages drop constraint t_acc_block');
      expect(await h.messages(DEAL)).toEqual([]);
    });
  });
});

describe('5.9 claim, complete, retries and Send again', () => {
  it('claim resolves the address now, re-checks STOP and switch-off; retries +5 / +20 / +60 then failed with one alert', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:c1', ENQ_PARAMS);
      await h.enqueue(DEAL, 'e_ticket', 'eticket:c2', { customerName: 'S', dealReference: 'SYN-DEL-001' });
      await h.dueNow();
      // Switch-off after queueing wins at claim.
      await h.switchOff('e_ticket', 'email');
      await h.switchOff('e_ticket', 'whatsapp');
      const claimed = await h.msgClaim();
      expect(claimed.map((c) => c.id).sort()).toEqual((await h.messages(DEAL, 'payment_received')).map((r) => r.id).sort());
      const email = claimed.find((c) => c.channel === 'email')!;
      expect(email.to).toBe(CONTACT.email);
      expect((claimed.find((c) => c.channel === 'whatsapp')!.to as string)).toContain(CONTACT.mobile);
      // Addendum L4: a switch turned Off after queueing skips the message at claim with reason switched_off.
      for (const m of await h.messages(DEAL, 'e_ticket')) expect(`${m.status}/${m.skip_reason}`).toBe('skipped/switched_off');
      // Email fails three times: +5, +20, +60 minutes, then failed + one message_failed alert.
      const expected = [5, 20, 60];
      for (const minutes of expected) {
        await h.msgComplete(email.id, false, null, 'network'); // Addendum L11: only a failure before the request left is retried
        const [row] = await owner<{ mins: number; status: string; attempts: number }>(
          `select round(extract(epoch from (next_attempt_at - now())) / 60)::int as mins, status, attempts from public.customer_messages where id = $1`,
          [email.id]);
        expect(row!.mins, `retry after ${minutes} minutes`).toBe(minutes);
        expect(row!.status).toBe('queued');
        await h.dueNow();
        expect((await h.msgClaim()).map((c) => c.id)).toContain(email.id);
      }
      await h.msgComplete(email.id, false, null, 'network');
      const failed = await h.messageRow(email.id);
      expect(failed.status).toBe('failed');
      expect(failed.last_error_code).toBe('network');
      const alerts = (await h.alerts('customer_message_alerts')).filter((a) => a.kind === 'message_failed');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ deal_id: DEAL, message_id: email.id });
      const [audit] = (await h.audits('messages.failed')).slice(-1);
      expect(audit!.details).toMatchObject({ by: 'crm', rule: 'customer_message_dispatch', messageId: email.id, dealId: DEAL });
      expect(text(audit)).not.toContain('2500000');
      // WhatsApp sent.
      const wa = claimed.find((c) => c.channel === 'whatsapp')!;
      await h.msgComplete(wa.id, true, 'interakt-syn-1');
      expect(await h.messageRow(wa.id)).toMatchObject({ status: 'sent', provider_message_id: 'interakt-syn-1' });
      expect((await h.audits('messages.sent')).length).toBeGreaterThan(0);
    });
  });

  it('Addendum L11: unknown_outcome is never retried (status unknown, one alert); a delivery report marks a queued or unknown row sent', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:u1', ENQ_PARAMS);
      await h.dueNow();
      const claimed = await h.msgClaim();
      const wa = claimed.find((c) => c.channel === 'whatsapp')!;
      const email = claimed.find((c) => c.channel === 'email')!;
      await h.msgComplete(wa.id, false, null, 'unknown_outcome');
      const row = await h.messageRow(wa.id);
      expect(row).toMatchObject({ status: 'unknown', last_error_code: 'unknown_outcome' });
      await h.dueNow();
      expect((await h.msgClaim()).map((c) => c.id), 'never claimed again').not.toContain(wa.id);
      expect((await h.alerts('customer_message_alerts')).filter((a) => a.kind === 'message_failed' && a.message_id === wa.id)).toHaveLength(1);
      expect((await h.audits('messages.failed')).length).toBeGreaterThan(0);
      // A late "delivered" report proves it went: unknown -> sent (and the provider later says delivered).
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-u-1', wa.id, 'delivered', null, null]);
      expect(['sent', 'delivered']).toContain((await h.messageRow(wa.id)).status);
      // A report for a still-queued row (its send answer was lost) also marks it sent and clears the retry.
      await h.msgComplete(email.id, false, null, 'network');
      expect((await h.messageRow(email.id)).status).toBe('queued');
      await one(WORKER, SQL3.eventRecord, ['resend', 'ev-u-2', email.id, 'sent', null, null]);
      const after = await h.messageRow(email.id);
      expect(after.status).toBe('sent');
      await h.dueNow();
      expect((await h.msgClaim()).map((c) => c.id)).not.toContain(email.id);
    });
  });

  it('Addendum L11: a retry of a quiet-hours type waits for 08:00 India time when the retry falls in 21:00-08:00', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'booking_confirmed', 'deal:q1', { customerName: 'S', dealReference: 'SYN-DEL-001', destination: 'X', tripStart: '2026-12-10',
        tripEnd: '2026-12-13', travellerCount: 2 });
      await h.dueNow();
      const [email] = (await h.msgClaim()).filter((c) => c.channel === 'email');
      await h.msgComplete(email!.id, false, null, 'network');
      const [r] = await owner<{ ok: boolean; at: string }>(
        `select m.next_attempt_at::text as at,
           m.next_attempt_at = (case
             when extract(hour from (now() + interval '5 minutes') at time zone 'Asia/Kolkata') >= 21
               or extract(hour from (now() + interval '5 minutes') at time zone 'Asia/Kolkata') < 8
             then (date_trunc('day', (now() + interval '5 minutes') at time zone 'Asia/Kolkata')
                   + case when extract(hour from (now() + interval '5 minutes') at time zone 'Asia/Kolkata') >= 21 then interval '1 day' else interval '0' end
                   + interval '8 hours') at time zone 'Asia/Kolkata'
             else now() + interval '5 minutes' end) as ok
         from public.customer_messages m where m.id = $1`, [email!.id]);
      expect(r!.ok, `next_attempt_at ${r!.at}`).toBe(true);
    });
  });

  it('A6 Send again: SO or branch Manager, a new row that re-checks everything; refused on a sent message and for others', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:r1', ENQ_PARAMS);
      await h.dueNow();
      const [email] = (await h.msgClaim()).filter((c) => c.channel === 'email');
      for (let i = 0; i < 4; i += 1) {
        await h.msgComplete(email!.id, false, null, 'network');
        await h.dueNow();
        if (i < 3) await h.msgClaim();
      }
      expect((await h.messageRow(email!.id)).status).toBe('failed');
      await refused(PURCHASE, SQL3.resend, [email!.id, rid()], 'not_authorized', '42501');
      await refused(SALES_B, SQL3.resend, [email!.id, rid()], 'not_authorized', '42501');
      const again = await one<Record<string, unknown>>(OWNER, SQL3.resend, [email!.id, rid()]);
      expect(again).toBeTruthy();
      const rows = (await h.messages(DEAL, 'payment_received')).filter((r) => r.resend_of === email!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rule: 'resend', event_key: 'receipt:r1:r1', status: 'queued', channel: 'email' });
      expect((await h.audits('messages.resent')).length).toBe(1);
      // A sent message cannot be sent again.
      const [wa] = (await h.messages(DEAL, 'payment_received')).filter((r) => r.channel === 'whatsapp');
      await h.dueNow();
      await h.msgClaim();
      await h.msgComplete(wa!.id, true, 'interakt-syn-2');
      await refused(MANAGER, SQL3.resend, [wa!.id, rid()], 'wrong_state');
      // Addendum L4: never doubles — refused while the earlier re-send of the same original is still live.
      await refused(MANAGER, SQL3.resend, [email!.id, rid()], 'wrong_state');
      // Once that re-send ended (failed / skipped / stopped), Send again is allowed and re-checked:
      // with the Deal's email channel off the new row is skipped, not queued.
      await owner(`update public.customer_messages set status = 'failed', failed_at = now(), last_error_code = 'provider_error'
        where id = $1`, [rows[0]!.id]);
      await h.prefsSet({ emailOff: true, offReason: REASON });
      await one(MANAGER, SQL3.resend, [email!.id, rid()]);
      const latest = (await h.messages(DEAL, 'payment_received')).filter((r) => r.resend_of === email!.id).slice(-1)[0]!;
      expect(`${latest.status}/${latest.skip_reason}`).toBe('skipped/channel_off_on_deal');
      // That re-send ended skipped -> allowed again; once a re-send was sent, Send again is refused (Addendum L4, migration 0150).
      await h.prefsSet({ emailOff: false });
      await one(OWNER, SQL3.resend, [email!.id, rid()]);
      const third = (await h.messages(DEAL, 'payment_received')).filter((r) => r.resend_of === email!.id).slice(-1)[0]!;
      expect(third.status).toBe('queued');
      await h.dueNow();
      expect((await h.msgClaim()).map((c) => c.id)).toContain(third.id);
      await refused(OWNER, SQL3.resend, [email!.id, rid()], 'wrong_state'); // sending
      await h.msgComplete(third.id, true, 'resend-syn-3');
      await refused(OWNER, SQL3.resend, [email!.id, rid()], 'wrong_state'); // sent
    });
  });

  it('worker commands are not executable by staff', async () => {
    await asOwner(db, async () => {
      for (const fn of ['customer_message_claim', 'customer_message_complete', 'customer_message_event_record']) {
        const sigs = await h.signatures('public', fn);
        expect(sigs.length, fn).toBe(1);
        expect(await h.canExecute('authenticated', sigs[0]!), fn).toBe(false);
        expect(await h.canExecute('anon', sigs[0]!), fn).toBe(false);
        expect(await h.canExecute('service_role', sigs[0]!), fn).toBe(true);
      }
    });
  });
});

describe('5.8 delivery reports, STOP and START', () => {
  it('idempotent on the event id; status moves forward only; bounced fails at once', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:e1', ENQ_PARAMS);
      await h.dueNow();
      const claimed = await h.msgClaim();
      const email = claimed.find((c) => c.channel === 'email')!;
      const wa = claimed.find((c) => c.channel === 'whatsapp')!;
      await h.msgComplete(email.id, true, 'resend-syn-1');
      await h.msgComplete(wa.id, true, 'interakt-syn-1');
      // ASSUMPTION: p_message_ref is the provider message id (Resend id / Interakt id); our id travels as callbackData.
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-1', 'interakt-syn-1', 'read', null, null]);
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-1', 'interakt-syn-1', 'read', null, null]);
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-2', 'interakt-syn-1', 'delivered', null, null]);
      expect((await h.messageRow(wa.id)).status).toBe('read');
      expect((await owner<{ n: number }>(`select count(*)::int as n from public.customer_message_events where provider = 'interakt' and provider_event_id = 'ev-1'`))[0]!.n)
        .toBe(1);
      await one(WORKER, SQL3.eventRecord, ['resend', 'ev-3', 'resend-syn-1', 'bounced', 'bounced', null]);
      expect(await h.messageRow(email.id)).toMatchObject({ status: 'failed', last_error_code: 'bounced' });
      // No address or text is stored with events.
      expect(text(await owner('select * from public.customer_message_events'))).not.toContain(CONTACT.email);
    });
  });

  it('STOP: WhatsApp stopped for that number, e-mail continues, one alert per Deal; START restarts', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      const MOBILE = uniqueMobile();
      await h.prefsSet({ whatsappMobile: MOBILE, whatsappSameAsMobile: false });
      await h.enqueue(DEAL, 'payment_received', 'receipt:s1', ENQ_PARAMS);
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-stop-1', null, 'inbound_stop', null, MOBILE]);
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-stop-1', null, 'inbound_stop', null, MOBILE]);
      const [opt] = await owner<{ source: string; restarted_at: string | null }>(
        'select source, restarted_at from public.customer_whatsapp_optouts where mobile = $1', [MOBILE]);
      expect(opt).toMatchObject({ source: 'stop_reply', restarted_at: null });
      const rows = await h.messages(DEAL, 'payment_received');
      expect(rows.find((r) => r.channel === 'whatsapp')!.status).toBe('stopped');
      expect(rows.find((r) => r.channel === 'email')!.status).toBe('queued');
      const stops = (await h.alerts('customer_message_alerts')).filter((a) => a.kind === 'whatsapp_stopped');
      expect(stops).toHaveLength(1);
      expect(stops[0]!.deal_id).toBe(DEAL);
      // New WhatsApp messages are stopped; e-mail still queues.
      await h.enqueue(DEAL, 'payment_received', 'receipt:s2', ENQ_PARAMS);
      const s2 = (await h.messages(DEAL, 'payment_received')).filter((r) => r.event_key === 'receipt:s2');
      expect(Object.fromEntries(s2.map((r) => [r.channel, `${r.status}/${r.skip_reason ?? ''}`])))
        .toEqual({ email: 'queued/', whatsapp: 'stopped/opted_out' });
      // START restarts.
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-start-1', null, 'inbound_start', null, MOBILE]);
      expect((await owner<{ r: string | null }>('select restarted_at::text as r from public.customer_whatsapp_optouts where mobile = $1',
        [MOBILE]))[0]!.r).not.toBeNull();
      await h.enqueue(DEAL, 'payment_received', 'receipt:s3', ENQ_PARAMS);
      expect((await h.messages(DEAL, 'payment_received')).find((r) => r.event_key === 'receipt:s3' && r.channel === 'whatsapp')!.status).toBe('queued');
    });
  });

  it('A2 restart by the Sales owner after a STOP; audited with the reason', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      const MOBILE = uniqueMobile();
      await h.prefsSet({ whatsappMobile: MOBILE, whatsappSameAsMobile: false });
      await one(WORKER, SQL3.eventRecord, ['interakt', 'ev-stop-2', null, 'inbound_stop', null, MOBILE]);
      await refused(PURCHASE, SQL3.restart, [DEAL, REASON, rid()], 'not_authorized', '42501');
      await one(OWNER, SQL3.restart, [DEAL, REASON, rid()]);
      const [opt] = await owner<{ r: string | null; s: string | null }>(
        'select restarted_at::text as r, restart_source as s from public.customer_whatsapp_optouts where mobile = $1', [MOBILE]);
      expect(opt!.r).not.toBeNull();
      const [a] = (await h.audits('messages.opt_in')).slice(-1);
      expect(a!.reason).toBe(REASON);
      expect(text(a)).not.toContain(MOBILE);
    });
  });
});

describe('5.3 A1 Deal message preferences', () => {
  it('Sales owner and branch Manager set prefs; refusals; audit lists field names, never values', async () => {
    await asOwner(db, async () => {
      await h.approvedBooking();
      await refused(PURCHASE, SQL3.prefsSet, [DEAL, 0, JSON.stringify({ language: 'hi' }), rid()], 'not_authorized', '42501');
      await refusedHint(OWNER, SQL3.prefsSet, [DEAL, 0, JSON.stringify({ language: 'fr' }), rid()], 'invalid_input', /language/);
      await refusedHint(OWNER, SQL3.prefsSet, [DEAL, 0, JSON.stringify({ whatsappMobile: '5123456789' }), rid()], 'invalid_input', /whatsappMobile/);
      await refusedHint(OWNER, SQL3.prefsSet, [DEAL, 0, JSON.stringify({ emailOff: true }), rid()], 'invalid_input', /offReason/);
      await h.prefsSet({ language: 'hi', whatsappMobile: '6000012345', whatsappSameAsMobile: false });
      const row = await h.prefsRow();
      expect(row).toMatchObject({ language: 'hi', whatsapp_mobile: '6000012345' });
      await refused(MANAGER, SQL3.prefsSet, [DEAL, 0, JSON.stringify({ language: 'en' }), rid()], 'version_changed', '40001');
      await one(MANAGER, SQL3.prefsSet, [DEAL, row!.row_version, JSON.stringify({ emailOverride: 'other@example.test' }), rid()]);
      const audits = await h.audits('messages.prefs_changed');
      expect(audits.length).toBe(2);
      expect(audits[0]!.details).toMatchObject({ dealId: DEAL });
      expect((audits[0]!.details as { fields: string[] }).fields).toEqual(expect.arrayContaining(['language', 'whatsappMobile']));
      expect(text(audits)).not.toContain('6000012345');
      expect(text(audits)).not.toContain('other@example.test');
      await expectDbError(db, () => owner('delete from public.deal_message_prefs where deal_id = $1', [DEAL]), {});
    });
  });
});

describe('5.6 hotel voucher and boarding pass', () => {
  async function voucherFile(taskId: string, finish = true) {
    const ev = await one<{ evidenceId: string; objectPath: string }>(PURCHASE, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
      [taskId, 'customer_voucher', 'voucher.pdf', 'application/pdf', 2048, 'c'.repeat(64)]);
    if (!finish) return ev.evidenceId;
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    await one(PURCHASE, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
    return ev.evidenceId;
  }

  it('A5 voucher ready only for a stored customer_voucher on a supplier-confirmed task; once; queues hotel_voucher with the file', async () => {
    await asOwner(db, async () => {
      await h.messagesOn();
      const b = await h.approvedBooking();
      const task = h.taskOf(b, 'hotel');
      await h.supplierConfirmed(task);
      const notStored = await voucherFile(task, false);
      await refusedHint(PURCHASE, SQL3.voucherReady, [notStored, rid()], 'not_ready', /file/);
      const ev = await voucherFile(task);
      await refused(OWNER, SQL3.voucherReady, [ev, rid()], 'not_authorized', '42501');
      const first = await one<{ outcome: string }>(PURCHASE, SQL3.voucherReady, [ev, rid()]);
      expect(first.outcome).toBe('created');
      const again = await one<{ outcome: string }>(PURCHASE, SQL3.voucherReady, [ev, rid()]);
      expect(again.outcome).toBe('existing');
      const rows = await h.messages(DEAL, 'hotel_voucher');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.event_key === `voucher:${ev}`)).toBe(true);
      expect(rows[0]!.attachment).toMatchObject({ source: 'purchase_evidence', id: ev });
      const [audit] = await h.audits('messages.voucher_ready');
      expect(audit!.details).toMatchObject({ taskId: task, evidenceId: ev });
      // R-A3: the task's Purchase reader sees only its own send state; Sales gets null.
      const status = await one<{ taskId: string; items: Array<{ evidenceId: string; messageType: string; email: { state: string } }> }>(
        PURCHASE, SQL3.taskMessageStatus, [task]);
      expect(status.items).toEqual([expect.objectContaining({ evidenceId: ev, messageType: 'hotel_voucher' })]);
      expect(['not_sent', 'waiting', 'sent', 'failed', 'off']).toContain(status.items[0]!.email.state);
      expect(Object.keys(status).sort()).toEqual(['items', 'taskId']);
      expect(await one(OWNER, SQL3.taskMessageStatus, [task])).toBeNull();
    });
  });

  it('A5 refuses a voucher on a task that is not supplier-confirmed (not_ready, hint not_confirmed)', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedBooking();
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier());
      const begun = await h.attempt<{ evidenceId: string; objectPath: string }>(PURCHASE,
        'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r', [task, 'customer_voucher', 'v.pdf', 'application/pdf', 2048, 'd'.repeat(64)]);
      if (!begun.ok) return; // begin itself refuses the kind before confirmation: also within the contract.
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
        [begun.value.objectPath]);
      await one(PURCHASE, 'select public.purchase_evidence_finish($1, true) as r', [begun.value.evidenceId]);
      await refusedHint(PURCHASE, SQL3.voucherReady, [begun.value.evidenceId, rid()], 'not_ready', /not_confirmed/);
    });
  });

  it('boarding_pass kind only for Flight tasks with a ticket batch; stored file queues boarding_pass with the file', async () => {
    await asOwner(db, async () => {
      await h.messagesOn();
      await h.people();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await h.approveReal(b.versionId);
      await h.addFlightPeople();
      const flightTask = h.taskOf(b, 'flight');
      const hotelTask = h.taskOf(b, 'hotel');
      await h.claim(FLIGHT, DEAL);
      const before = await h.attempt(FLIGHT, 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        [flightTask, null, 'boarding_pass', 'bp.pdf', 'application/pdf', 2048, 'b'.repeat(64)]);
      expect(before.ok, 'no ticket batch yet').toBe(false);
      const onHotel = await h.attempt(PURCHASE, 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        [hotelTask, null, 'boarding_pass', 'bp.pdf', 'application/pdf', 2048, 'b'.repeat(64)]);
      expect(onHotel.ok, 'not a Flight task').toBe(false);
      await h.flightBatch(DEAL, [1]);
      const bp = await h.evidence(FLIGHT, flightTask, 'boarding_pass');
      const rows = await h.messages(DEAL, 'boarding_pass');
      expect(rows.map((r) => r.event_key)).toEqual([`bp:${bp}`, `bp:${bp}`]);
      expect(rows[0]!.attachment).toMatchObject({ source: 'department_evidence', id: bp });
      // e_ticket: stored file + a batch exists -> queued once (both trigger moments write one row per channel).
      const et = await h.evidence(FLIGHT, flightTask, 'e_ticket');
      expect((await h.messages(DEAL, 'e_ticket')).map((r) => r.event_key)).toEqual([`eticket:${et}`, `eticket:${et}`]);
      // Flight sees its own files' send state; Visa and Sales do not.
      const st = await one<{ items: Array<{ evidenceId: string }> }>(FLIGHT, SQL3.taskMessageStatus, [flightTask]);
      expect(st.items.map((i) => i.evidenceId).sort()).toEqual([bp, et].sort());
      expect(await one(VISA, SQL3.taskMessageStatus, [flightTask])).toBeNull();
    });
  });

  it('e_ticket stored before any ticket batch is queued when the batch arrives (checked at both moments)', async () => {
    await asOwner(db, async () => {
      await h.messagesOn();
      await h.people();
      const b = await h.book([FLIGHT_ITEM]);
      await h.approveReal(b.versionId);
      await h.addFlightPeople();
      const flightTask = h.taskOf(b, 'flight');
      await h.claim(FLIGHT, DEAL);
      const et = await h.evidence(FLIGHT, flightTask, 'e_ticket');
      expect(await h.messages(DEAL, 'e_ticket')).toEqual([]);
      await h.flightBatch(DEAL, [1]);
      expect((await h.messages(DEAL, 'e_ticket')).map((r) => r.event_key)).toEqual([`eticket:${et}`, `eticket:${et}`]);
    });
  });
});

describe('5.5 trip reminders (timer task)', () => {
  it('trip starting in 3 days gets d3:<tripStart>; replay gives no new row (only after 10:00 India time)', async () => {
    await asOwner(db, async () => {
      const [{ h: hour }] = await owner<{ h: number }>(`select extract(hour from now() at time zone 'Asia/Kolkata')::int as h`) as [{ h: number }];
      await h.messagesOn(['trip_reminder']);
      await h.people();
      const start = dayFrom(3);
      const hotel = { ...HOTEL_ITEM, facts: { ...(HOTEL_ITEM.facts as Record<string, unknown>), checkIn: start, checkOut: dayFrom(5) } };
      const b = await h.book([hotel], { trip: { start, end: dayFrom(5) } });
      await h.approveReal(b.versionId);
      const [task] = await owner<{ f: string }>(`select function_name as f from public.timer_tasks where name = 'customer_trip_reminders'`);
      await resetActor(db);
      await owner(`select ${task!.f}() as r`);
      await owner(`select ${task!.f}() as r`);
      const rows = await h.messages(DEAL, 'trip_reminder');
      if (hour < 10) {
        expect(rows, 'before 10:00 IST nothing is queued').toEqual([]);
        return;
      }
      expect(rows.map((r) => r.event_key)).toEqual([`d3:${start}`, `d3:${start}`]);
      expect((rows[0]!.params as { daysLeft: unknown }).daysLeft?.toString()).toBe('3');
    });
  });
});

describe('5.10 / 14 reads and fences', () => {
  it('R-A1 messages card: SO, branch M, A read it; Purchase, Flight, Visa, other Sales and other entity get null; no amounts or params', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:f1', { ...ENQ_PARAMS, amountPaise: '7654321' });
      for (const actor of [OWNER, MANAGER, ACC]) {
        const card = await one<Record<string, unknown> & { messages: Array<Record<string, unknown>>; prefs: Record<string, unknown> }>(actor,
          SQL3.dealMessages, [DEAL]);
        expect(card, 'reader').not.toBeNull();
        expect(Object.keys(card).sort()).toEqual(['can', 'contactConfirmed', 'dealId', 'messages', 'prefs'].sort());
        expect(card.messages).toHaveLength(2);
        expect(Object.keys(card.messages[0]!)).not.toContain('params');
        expect(text(card)).not.toContain('7654321');
        expect(text(card)).not.toContain(CONTACT.mobile);
        expect(text(card)).not.toContain(CONTACT.email);
      }
      await h.addFlightPeople();
      for (const actor of [PURCHASE, FLIGHT, VISA_J2, SALES_B, OTHER_ENTITY]) expect(await one(actor, SQL3.dealMessages, [DEAL]), 'fenced').toBeNull();
    });
  });

  it('R-A2 admin view: Super Admin only; 18 switches, template previews in both languages, provider keys as booleans only', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      for (const actor of [ACC, MANAGER, OWNER]) expect(await one(actor, SQL3.adminMessages, [entity])).toBeNull();
      const view = await one<Record<string, unknown>>(SUPER, SQL3.adminMessages, [entity]);
      expect(view).not.toBeNull();
      const t = text(view);
      expect(t).toMatch(/configured/);
      // Never a key value.
      expect(t).not.toMatch(/re_[A-Za-z0-9]{10,}/);
      expect((t.match(/tn_[a-z_]+_(en|hi)_v1/g) ?? []).length).toBeGreaterThanOrEqual(18);
    });
  });
});
