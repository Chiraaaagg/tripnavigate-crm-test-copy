import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { CONTACT, FLIGHT, FLIGHT_ITEM } from './acc-support';
import { DEAL, MANAGER, OWNER, REASON, SQL3, SUPER, WORKER, acc3Helpers, rid, text } from './acc3-support';

/**
 * Accounts phase 3, track A's own database checks for customer messages
 * (migrations 20261205000110..0140): the parts of the builder's design that
 * Track T's acc3-a-messages suite does not pin - the status guard, a switch
 * turned Off after queueing (switched_off), a missing file at claim
 * (file_missing), lease loss, base params from the booking, delivery reports
 * by our id, STOP alerts only while the trip has not ended, and the R-A3
 * state words. Uses Track T's scenario helpers (acc3-support.ts).
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

async function liveBooked() {
  const b = await h.approvedBooking();
  await h.liveDeal();
  await h.messagesOn();
  return b;
}

describe('cmsg_enqueue params and guard', () => {
  it('base params come from the confirmed booking and win over caller values; only allowlisted keys are kept', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:p1', { customerName: 'Typed Name', amountPaise: '1200', balancePaise: '0', pan: 'ABCDE1234F' });
      const [row] = await h.messages(DEAL, 'payment_received');
      expect(row!.params).toEqual({ customerName: CONTACT.contactName, dealReference: expect.any(String), amountPaise: '1200', balancePaise: '0' });
      expect(text(row)).not.toContain('ABCDE1234F');
    });
  });

  it('status moves forward only; content is immutable; no delete', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'e_ticket', 'eticket:g1');
      const [row] = await h.messages(DEAL, 'e_ticket');
      await expectDbError(db, () => owner(`update public.customer_messages set status = 'delivered' where id = $1`, [row!.id]), { code: '42501' });
      await expectDbError(db, () => owner(`update public.customer_messages set params = '{}' where id = $1`, [row!.id]), { code: '42501' });
      await expectDbError(db, () => owner('delete from public.customer_messages where id = $1', [row!.id]), { code: '42501' });
    });
  });
});

describe('claim and complete edges', () => {
  it('a switch turned Off after queueing: skipped switched_off at claim', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'refund_paid', 'payout:s1', { amountPaise: '100' });
      await h.switchOff('refund_paid', 'email');
      await h.dueNow();
      const claimed = await h.msgClaim();
      expect(claimed.map((c) => c.channel)).toEqual(['whatsapp']);
      const email = (await h.messages(DEAL, 'refund_paid')).find((r) => r.channel === 'email')!;
      expect(`${email.status}/${email.skip_reason}`).toBe('skipped/switched_off');
    });
  });

  it('an attachment that is no longer stored: skipped file_missing', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'e_ticket', 'eticket:f1', {}, { source: 'department_evidence', id: '00000000-0000-4000-8000-0000000000ff' });
      await h.dueNow();
      expect(await h.msgClaim()).toEqual([]);
      const rows = await h.messages(DEAL, 'e_ticket');
      expect(rows.map((r) => `${r.status}/${r.skip_reason}`)).toEqual(['skipped/file_missing', 'skipped/file_missing']);
    });
  });

  it('a worker that lost its lease gets "stale"; a not_configured failure is final and raises no alert', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:l1', { amountPaise: '100', balancePaise: '0' });
      await h.dueNow();
      const [first] = await h.msgClaim();
      const stale = await one<{ outcome: string }>(WORKER, SQL3.complete, [first!.id, 'other-worker', true, 'x-1', null]);
      expect(stale.outcome).toBe('stale');
      await h.msgComplete(first!.id, false, null, 'not_configured');
      expect(await h.messageRow(first!.id)).toMatchObject({ status: 'failed', last_error_code: 'not_configured' });
      expect((await h.alerts('customer_message_alerts')).filter((a) => a.message_id === first!.id)).toEqual([]);
    });
  });
});

describe('delivery reports and STOP', () => {
  it('a report may name our message id (Interakt callbackData) and arrive before complete: the provider id is kept', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:d1', { amountPaise: '100', balancePaise: '0' });
      await h.dueNow();
      const wa = (await h.msgClaim()).find((c) => c.channel === 'whatsapp')!;
      await one(WORKER, SQL3.eventRecord, ['interakt', 'message_api_delivered:p-1', wa.id, 'delivered', null, null]);
      expect((await h.messageRow(wa.id)).status).toBe('delivered');
      await h.msgComplete(wa.id, true, 'p-1');
      expect(await h.messageRow(wa.id)).toMatchObject({ status: 'delivered', provider_message_id: 'p-1' });
      const unknown = await one<{ outcome: string }>(WORKER, SQL3.eventRecord, ['interakt', 'message_api_read:zz', 'zz', 'read', null, null]);
      expect(unknown.outcome).toBe('recorded');
    });
  });

  it('STOP: one alert for a Deal whose trip has not ended; a second STOP while opted out keeps one opt-out row', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      const ended = (await owner<{ e: boolean }>(`select coalesce(max(trip_end) < (now() at time zone 'Asia/Kolkata')::date, false) as e
        from public.booking_versions where deal_id = $1 and status = 'confirmed'`, [DEAL]))[0]!.e;
      await one(WORKER, SQL3.eventRecord, ['interakt', 'message_received:stop-a', null, 'inbound_stop', null, CONTACT.mobile]);
      await one(WORKER, SQL3.eventRecord, ['interakt', 'message_received:stop-b', null, 'inbound_stop', null, CONTACT.mobile]);
      const stops = (await h.alerts('customer_message_alerts')).filter((a) => a.kind === 'whatsapp_stopped' && a.deal_id === DEAL);
      expect(stops).toHaveLength(ended ? 0 : 1);
      expect((await owner('select 1 from public.customer_whatsapp_optouts where mobile = $1', [CONTACT.mobile]))).toHaveLength(1);
    });
  });
});

describe('reads', () => {
  it('R-A1: prefs show masks only and can.restartWhatsapp after a STOP', async () => {
    await asOwner(db, async () => {
      await h.approvedBooking();
      await h.messagesOn();
      await one(WORKER, SQL3.eventRecord, ['interakt', 'message_received:stop-r', null, 'inbound_stop', null, CONTACT.mobile]);
      const card = await one<{ prefs: Record<string, unknown>; can: Record<string, boolean> }>(OWNER, SQL3.dealMessages, [DEAL]);
      expect(card.prefs).toMatchObject({ optedOut: true, language: 'en', rowVersion: 0 });
      expect(card.prefs.whatsappMasked).toMatch(/^\d{2}x{6}\d{2}$/);
      expect(card.can).toEqual({ editPrefs: true, restartWhatsapp: true });
      expect(text(card)).not.toContain(CONTACT.mobile);
    });
  });

  it('R-A2: Super Admin gets switches, templates, providers (unknown in the database) and the timer state', async () => {
    await asOwner(db, async () => {
      const view = await one<Record<string, unknown> & { switches: unknown[]; templates: unknown[]; providers: Array<{ configured: unknown }>;
        timer: Record<string, unknown> }>(SUPER, SQL3.adminMessages, [await h.entityId()]);
      expect(view.switches).toHaveLength(18);
      expect(view.templates).toHaveLength(18);
      expect(view.providers.every((p) => p.configured === null)).toBe(true);
      expect(view.timer).toMatchObject({ enabled: false });
      await one(SUPER, SQL3.setPilotOnly, [await h.entityId(), false, REASON]);
      const entity = await h.entityId();
      await expectDbError(db, () => h.run(SUPER, SQL3.pilotSet, [entity, rid(), true, REASON]), { code: '22023' });
    });
  });
});

describe('Send again never doubles a message (Addendum L4)', () => {
  it('refused while an earlier re-send of the same original is live; allowed again once it failed; replay returns existing', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:once', { amountPaise: '100', balancePaise: '0' });
      await h.dueNow();
      const email = (await h.msgClaim()).find((c) => c.channel === 'email')!;
      await h.msgComplete(email.id, false, null, 'rejected');
      expect((await h.messageRow(email.id)).status).toBe('failed');
      const req = rid();
      const first = await one<{ outcome: string; messageId: string; status: string }>(OWNER, SQL3.resend, [email.id, req]);
      expect(first).toMatchObject({ outcome: 'created', status: 'queued' });
      // Replay of the same request: existing, no new row.
      expect(await one(OWNER, SQL3.resend, [email.id, req])).toMatchObject({ outcome: 'existing', messageId: first.messageId });
      // The first re-send is live (queued): a second press is refused, from the original or from any member of the chain.
      await h.refused(MANAGER, SQL3.resend, [email.id, rid()], 'wrong_state', '55000');
      // Live while sending too; then it fails: Send again is allowed again (from the original or from the failed re-send).
      await h.dueNow();
      expect((await h.msgClaim()).map((c) => c.id)).toContain(first.messageId);
      await h.refused(OWNER, SQL3.resend, [email.id, rid()], 'wrong_state', '55000');
      await h.msgComplete(first.messageId, false, null, 'rejected');
      const card = await one<{ messages: Array<{ id: string; can: { resend: boolean } }> }>(OWNER, SQL3.dealMessages, [DEAL]);
      expect(card.messages.find((m) => m.id === email.id)!.can.resend).toBe(true);
      const second = await one<{ outcome: string; messageId: string }>(OWNER, SQL3.resend, [first.messageId, rid()]);
      expect(second.outcome).toBe('created');
      // A sent re-send also blocks (the customer already got it).
      await h.dueNow();
      await h.msgClaim();
      await h.msgComplete(second.messageId, true, 'resend-once-1');
      await h.refused(OWNER, SQL3.resend, [email.id, rid()], 'wrong_state', '55000');
      const after = await one<{ messages: Array<{ id: string; can: { resend: boolean } }> }>(OWNER, SQL3.dealMessages, [DEAL]);
      expect(after.messages.filter((m) => m.can.resend)).toEqual([]);
    });
  });
});

describe('screen reads (0160)', () => {
  it('prefs_get, Deal lookup by exact reference (Super Admin only) and the voucher slot of a Purchase task', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedBooking();
      const prefs = await one<Record<string, unknown>>(OWNER, 'select public.deal_message_prefs_get($1) as r', [DEAL]);
      expect(prefs).toMatchObject({ dealId: DEAL, language: 'en', whatsappSameAsMobile: true, rowVersion: 0 });
      expect(await one(h.PURCHASE, 'select public.deal_message_prefs_get($1) as r', [DEAL])).toBeNull();
      const [deal] = await owner<{ reference: string }>('select reference from public.deals where id = $1', [DEAL]);
      const entity = await h.entityId();
      const found = await one<{ dealId: string; inPilot: boolean }>(SUPER, 'select public.customer_message_deal_lookup($1, $2) as r',
        [entity, deal!.reference.toLowerCase()]);
      expect(found).toMatchObject({ dealId: DEAL, inPilot: false });
      expect(await one(SUPER, 'select public.customer_message_deal_lookup($1, $2) as r', [entity, 'NO-SUCH-REF'])).toBeNull();
      expect(await one(OWNER, 'select public.customer_message_deal_lookup($1, $2) as r', [entity, deal!.reference])).toBeNull();
      const task = h.taskOf(b, 'hotel');
      const before = await one<{ kind: string; taskConfirmed: boolean; can: { upload: boolean }; files: unknown[] }>(h.PURCHASE,
        'select public.task_customer_files($1) as r', [task]);
      expect(before).toMatchObject({ kind: 'customer_voucher', taskConfirmed: false, can: { upload: false }, files: [] });
      expect(await one(OWNER, 'select public.task_customer_files($1) as r', [task])).toBeNull();
    });
  });
});

describe('boarding pass slots (0170)', () => {
  it('one slot per active flight and traveller with names and a short label; a stored file links to one slot once', async () => {
    await asOwner(db, async () => {
      await h.messagesOn();
      await h.people();
      const b = await h.book([FLIGHT_ITEM]);
      await h.approveReal(b.versionId);
      await h.addFlightPeople();
      const task = h.taskOf(b, 'flight');
      await h.claim(FLIGHT, DEAL);
      await h.flightBatch(DEAL, [1]);
      type Files = { slots: Array<{ sectorId: string; sectorLabel: string; passengerSeq: number; passengerName: string; evidenceId: string | null }>;
        files: Array<{ evidenceId: string; sectorId: string | null; passengerSeq: number | null }> };
      const before = await one<Files>(FLIGHT, 'select public.task_customer_files($1) as r', [task]);
      expect(before.slots.length).toBeGreaterThan(0);
      const slot = before.slots[0]!;
      expect(slot.sectorLabel).toMatch(/^.+–.+ \d{2} [A-Z][a-z]{2}$/);
      expect(slot.passengerName.length).toBeGreaterThan(0);
      expect(slot.evidenceId).toBeNull();
      const bp = await h.evidence(FLIGHT, task, 'boarding_pass');
      await h.refusedHint(FLIGHT, 'select public.boarding_pass_slot_link($1, $2, $3) as r', [bp, slot.sectorId, 99], 'invalid_input', /passengerSeq/);
      expect(await one<{ outcome: string }>(FLIGHT, 'select public.boarding_pass_slot_link($1, $2, $3) as r', [bp, slot.sectorId, slot.passengerSeq]))
        .toMatchObject({ outcome: 'created' });
      expect(await one<{ outcome: string }>(FLIGHT, 'select public.boarding_pass_slot_link($1, $2, $3) as r', [bp, slot.sectorId, slot.passengerSeq]))
        .toMatchObject({ outcome: 'existing' });
      await h.refused(OWNER, 'select public.boarding_pass_slot_link($1, $2, $3) as r', [bp, slot.sectorId, slot.passengerSeq], 'not_authorized', '42501');
      const after = await one<Files>(FLIGHT, 'select public.task_customer_files($1) as r', [task]);
      expect(after.slots.find((x) => x.sectorId === slot.sectorId && x.passengerSeq === slot.passengerSeq)!.evidenceId).toBe(bp);
      expect(after.files.find((f) => f.evidenceId === bp)).toMatchObject({ sectorId: slot.sectorId, passengerSeq: slot.passengerSeq });
      expect(text(after)).not.toContain(CONTACT.mobile);
    });
  });
});

describe('WhatsApp number kept when another setting is saved (0180)', () => {
  it('a save without whatsappSameAsMobile keeps the separate number; R-A1 shows whatsappSameAsMobile', async () => {
    await asOwner(db, async () => {
      await h.approvedBooking();
      await h.prefsSet({ whatsappMobile: '6000012345', whatsappSameAsMobile: false });
      type Card = { prefs: { whatsappSameAsMobile: boolean; whatsappMasked: string; rowVersion: number } };
      let card = await one<Card>(OWNER, SQL3.dealMessages, [DEAL]);
      expect(card.prefs).toMatchObject({ whatsappSameAsMobile: false, whatsappMasked: '60xxxxxx45' });
      await h.prefsSet({ language: 'hi' });
      expect((await h.prefsRow())).toMatchObject({ language: 'hi', whatsapp_mobile: '6000012345' });
      card = await one<Card>(OWNER, SQL3.dealMessages, [DEAL]);
      expect(card.prefs.whatsappSameAsMobile).toBe(false);
      await h.prefsSet({ whatsappSameAsMobile: true });
      expect((await h.prefsRow())!.whatsapp_mobile).toBeNull();
      expect((await one<Card>(OWNER, SQL3.dealMessages, [DEAL])).prefs.whatsappSameAsMobile).toBe(true);
    });
  });
});

describe('no duplicate after an unclear send (0190)', () => {
  it('unknown_outcome: never claimed again, one alert, Send again allowed; a later delivery report marks it sent', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'payment_received', 'receipt:u1', { amountPaise: '100', balancePaise: '0' });
      await h.dueNow();
      const claimed = await h.msgClaim();
      const email = claimed.find((c) => c.channel === 'email')!;
      const wa = claimed.find((c) => c.channel === 'whatsapp')!;
      expect(await h.msgComplete(email.id, false, null, 'unknown_outcome')).toMatchObject({ status: 'unknown' });
      expect(await h.messageRow(email.id)).toMatchObject({ status: 'unknown', last_error_code: 'unknown_outcome' });
      await h.dueNow();
      expect((await h.msgClaim()).map((c) => c.id)).not.toContain(email.id);
      expect((await h.alerts('customer_message_alerts')).filter((a) => a.message_id === email.id)).toHaveLength(1);
      const card = await one<{ messages: Array<{ id: string; status: string; can: { resend: boolean } }> }>(OWNER, SQL3.dealMessages, [DEAL]);
      expect(card.messages.find((m) => m.id === email.id)).toMatchObject({ status: 'unknown', can: { resend: true } });
      // A 2xx without a provider id is still sent.
      expect(await h.msgComplete(wa.id, true, null)).toMatchObject({ status: 'sent' });
      // A report for the unknown row: sent after all.
      await one(WORKER, SQL3.eventRecord, ['resend', 'evt-u1', email.id, 'delivered', null, null]);
      expect((await h.messageRow(email.id)).status).toBe('delivered');
    });
  });

  it('a delivery report for a row waiting for a retry marks it sent and clears the retry', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'refund_paid', 'payout:u2', { amountPaise: '100' });
      await h.dueNow();
      const email = (await h.msgClaim()).find((c) => c.channel === 'email')!;
      await h.msgComplete(email.id, false, null, 'provider_error');
      expect((await h.messageRow(email.id)).status).toBe('queued');
      await one(WORKER, SQL3.eventRecord, ['interakt', 'message_api_sent:u2', email.id, 'sent', null, null]);
      expect(await h.messageRow(email.id)).toMatchObject({ status: 'sent', last_error_code: null });
      await h.dueNow();
      expect((await h.msgClaim()).map((c) => c.id)).not.toContain(email.id);
    });
  });

  it('a retry of a quiet type follows quiet hours; Send again locks the chain root', async () => {
    await asOwner(db, async () => {
      await liveBooked();
      await h.enqueue(DEAL, 'booking_changed', 'cr:u3');
      await h.dueNow();
      const email = (await h.msgClaim()).find((c) => c.channel === 'email')!;
      await h.msgComplete(email.id, false, null, 'provider_error');
      const [r] = await owner<{ ok: boolean }>(`select next_attempt_at = authz.cmsg_not_before('booking_changed', now() + interval '5 minutes') as ok
        from public.customer_messages where id = $1`, [email.id]);
      expect(r!.ok).toBe(true);
      const [root] = await owner<{ r: string }>('select authz.cmsg_root($1) as r', [email.id]);
      expect(root!.r).toBe(email.id);
    });
  });
});
