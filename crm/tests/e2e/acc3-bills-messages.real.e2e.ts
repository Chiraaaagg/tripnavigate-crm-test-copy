import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  FLIGHT, HOTEL, ROUTES, SELLING, USERS, type UserKey, VISA, allLiveOff, allowedOutbound, approveBooking, asService, asUser, bookingWithTrip, configured,
  dayFromToday, departmentFile, documentsOf, doubleRequests, failNext, freshDeal, leaks, liveOff, liveOn, messagesDueNow, messagesOf, messagesOn, HARNESS_SKIP, providerHarness,
  noServiceWorker, prepareUsers, purchaseFile, q, restoreSwitches3, saveSwitches3, session, setPrefs, sha, putObject, stamp, startDoubles, stopDoubles,
  supplierConfirmedHotel, switchesOn3, ticketBatch, tickUntil, timerTick, verifiedCash,
} from './acc3-real-support';

/**
 * Accounts Phase 3 test plan 16.4, journeys 1 and 2 (Track T, written from
 * the contract): bills by themselves (6.2-6.4) and the nine customer
 * messages (5.3-5.10). Production build on the disposable stack; Resend and
 * Interakt are the local doubles of acc3-real-support.ts; the timer runs
 * through scripts/timer-tick.mjs.
 *
 * Test data (Addendum L5): the pilot Deals are relabelled live for the
 * non-money events (liveOn / liveOff of acc3-real-support.ts). CONTRACT GAP
 * (reported): in the 'test' environment the finance gate refuses money
 * commands on a live Deal, so booking confirmed, payment received and refund
 * paid are proven on the synthetic Deal (rows skipped `test_deal`, with their
 * type, template, language, once-only key and amounts) and not sent.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');
test.setTimeout(15 * 60_000);
test.use({ actionTimeout: 30_000 });

let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches3();
  secrets = await prepareUsers();
  await startDoubles();
});
test.afterAll(async () => {
  await allLiveOff();
  await restoreSwitches3();
  await stopDoubles();
});

/** Billing saved and verified by Accounts A (the Advance Invoice check `billing_not_verified`). */
async function verifyBilling(dealId: string): Promise<void> {
  const billing = (await q<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [dealId]))[0];
  const saved = await asUser<{ rowVersion: number }>(USERS.accA.id, 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r', [dealId,
    billing?.row_version ?? 0, JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur',
      stateCode: '08', postalCode: '342001', gstin: null }), randomUUID()]);
  await asUser(USERS.accA.id, 'select public.accounts_billing_verify($1, $2, $3) as r', [dealId, saved.rowVersion, randomUUID()]);
}

test('1. bills by themselves: released without a click, held with the reason, released by the sweep, never sent', async ({ browser }) => {
  await switchesOn3({ autoBills: true, release: true });
  // Customer message switches stay Off for this journey: nothing can reach a customer.
  const before = doubleRequests().length;

  // A: billing verified, receipt verified → Advance Invoice released by the CRM (number <ref>-ADV-1).
  const refA = `ACC3BL-${stamp}-1`;
  const dealA = await freshDeal(refA);
  const vA = await bookingWithTrip(dealA, 20, 23, 11);
  await verifyBilling(dealA);
  await verifiedCash(dealA, '500000', 11);
  await expect.poll(async () => (await documentsOf(dealA)).filter((d) => d.kind === 'advance_invoice' && d.status === 'released').length,
    { timeout: 30_000 }).toBe(1);
  const adv = (await documentsOf(dealA)).find((d) => d.kind === 'advance_invoice')!;
  expect(adv).toMatchObject({ number: `${refA}-ADV-1`, auto_rule: 'adv_on_receipt', created_by: null, released_by: null });
  expect(adv.release_rule).toMatch(/^[a-z][a-z0-9_.]{2,59}$/);

  // Booking approved → Invoice released by the CRM.
  const review = (await q<{ row_version: number }>('select row_version from public.accounts_booking_reviews where booking_version_id = $1', [vA.versionId]))[0];
  await asUser(USERS.accB.id, 'select public.accounts_review_approve($1, $2, $3) as r', [vA.versionId, review?.row_version ?? 0, randomUUID()]);
  await expect.poll(async () => (await documentsOf(dealA)).filter((d) => d.kind === 'invoice' && d.status === 'released').length, { timeout: 30_000 }).toBe(1);
  expect((await documentsOf(dealA)).find((d) => d.kind === 'invoice')).toMatchObject({ number: `${refA}-INV-1`, auto_rule: 'inv_on_approval' });

  // Deal Documents card (Accounts): "Made by the CRM".
  const acc = await session(browser, 'accA', secrets);
  // Released documents say who issued and drafted them: "Issued <date> by the CRM, rule: … · drafted by the CRM, rule: …"
  // ("Made by the CRM" is the words of a CRM draft and of the Bills list, labels.ts madeByLine / list.tsx).
  await acc.page.goto(ROUTES.accountsDeal(dealA));
  await expect(acc.page.getByText(new RegExp(`${refA}-ADV-1`)).first()).toBeVisible();
  await expect(acc.page.getByText(/^Issued .* by the CRM, rule: released automatically after every check passed · drafted by the CRM/).first()).toBeVisible();

  // B: billing never verified → the Advance Invoice is held with the reason and listed in Bills to check.
  const refB = `ACC3BL-${stamp}-2`;
  const dealB = await freshDeal(refB);
  await bookingWithTrip(dealB, 20, 23, 12);
  await verifiedCash(dealB, '300000', 12);
  await expect.poll(async () => (await documentsOf(dealB)).find((d) => d.kind === 'advance_invoice')?.auto_state ?? null, { timeout: 30_000 }).toBe('held');
  const held = (await documentsOf(dealB)).find((d) => d.kind === 'advance_invoice')!;
  expect(held.hold_reasons).toContain('billing_not_verified');
  expect(held.number).toBeNull();
  await acc.page.goto(ROUTES.billsToCheck);
  const row = acc.page.getByRole('row', { name: new RegExp(refB) }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText(/Held/)).toBeVisible();
  // Notice 40 to Accounts (reference-only text).
  await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.staff_notices where kind = 'bill_held' and deal_id = $1`, [dealB]))[0]!.n)
    .toBeGreaterThan(0);

  // Fixed (billing verified) → released by the CRM (the trigger or, at the latest, the one-minute sweep run by the timer).
  await verifyBilling(dealB);
  await tickUntil(async () => (await documentsOf(dealB)).some((d) => d.kind === 'advance_invoice' && d.status === 'released'));
  expect((await documentsOf(dealB)).find((d) => d.kind === 'advance_invoice')!.number).toBe(`${refB}-ADV-1`);

  // Nothing queued to the customer for any bill, nothing sent to a provider.
  expect(await messagesOf(dealA)).toEqual([]);
  expect(await messagesOf(dealB)).toEqual([]);
  expect(doubleRequests().slice(before)).toEqual([]);
  await noServiceWorker(acc.page);
  await acc.ctx.close();
});

test('2. messages: nine types on a pilot Deal, Hindi, STOP, failure and "Send again", test Deal sends nothing', async ({ browser }) => {
  test.skip(!providerHarness, HARNESS_SKIP);
  await switchesOn3({ autoBills: false });
  const ref = `ACC3MS-${stamp}`;
  const deal = await freshDeal(ref);
  const hindi = await freshDeal(`ACC3MH-${stamp}`);
  const testDeal = await freshDeal(`ACC3MT-${stamp}`);
  // Pilot mode stays On (default); only the two pilot Deals may send.
  await messagesOn([deal, hindi]);

  // Book now: language and "WhatsApp number is the same as mobile" (A1, Book now passes them).
  const v = await bookingWithTrip(deal, 3, 6, 21, { items: [['hotel', { ...HOTEL, checkIn: dayFromToday(3), checkOut: dayFromToday(6) }],
    ['flight', { ...FLIGHT, segments: [{ ...FLIGHT.segments[0], date: dayFromToday(1) }] }], ['visa', { ...VISA, travelDate: dayFromToday(3) }]] });
  await setPrefs(deal, { language: 'en', whatsappSameAsMobile: true });
  const vh = await bookingWithTrip(hindi, 1, 4, 22);
  await setPrefs(hindi, { language: 'hi', whatsappSameAsMobile: true });
  const vt = await bookingWithTrip(testDeal, 30, 33, 23);

  // MONEY EVENTS (finance gate: the Deal must stay synthetic in the 'test' environment, so 5.5 skips them `test_deal`;
  // CONTRACT GAP reported — Addendum L5 relabelling cannot cover these three types). The trigger still proves the event,
  // the type, the template, the language, "once" and the amounts on the row.
  // Booking confirmed — once per Deal, at the first Accounts approval (LD8).
  await approveBooking(deal, v.versionId);
  await approveBooking(hindi, vh.versionId);
  await approveBooking(testDeal, vt.versionId);
  const confirmed = await messagesOf(deal, 'booking_confirmed');
  expect(confirmed.map((m) => `${m.channel}:${m.status}:${m.skip_reason}`).sort()).toEqual(['email:skipped:test_deal', 'whatsapp:skipped:test_deal']);
  expect(confirmed.every((m) => m.template_code === 'tn_booking_confirmed_en_v1' && m.event_key === 'deal')).toBe(true);
  expect((await messagesOf(hindi, 'booking_confirmed')).every((m) => m.language === 'hi' && m.template_code === 'tn_booking_confirmed_hi_v1')).toBe(true);
  // Payment received (amount and balance of this customer only).
  await verifiedCash(deal, '1000000', 21);
  const paid = await messagesOf(deal, 'payment_received');
  expect(paid.map((m) => m.channel).sort()).toEqual(['email', 'whatsapp']);
  expect(paid[0]!.params).toMatchObject({ amountPaise: '1000000' });
  expect(BigInt(String(paid[0]!.params.balancePaise))).toBe(BigInt(SELLING) - 1000000n);
  await verifiedCash(hindi, '300000', 25);
  // Set-up of the later events while still synthetic (supplier go-ahead, Flight supplier and tickets touch money).
  const hotel = await supplierConfirmedHotel(deal);
  const hotelH = await supplierConfirmedHotel(hindi);
  await ticketBatch(deal, 21);
  // Voucher files are stored now too: Purchase work on a live Deal needs the live supplier-confirmation switch
  // (authz.procurement_gate_issue); "Ready for customer" (the message event) has no such gate.
  const voucher = await purchaseFile(hotel.taskId, 'customer_voucher');
  const voucher2 = await purchaseFile(hotel.taskId, 'customer_voucher');
  const voucherH = await purchaseFile(hotelH.taskId, 'customer_voucher');
  const voucherH2 = await purchaseFile(hotelH.taskId, 'customer_voucher');

  // NON-MONEY EVENTS: both pilot Deals relabelled live (Addendum L5) → queued and sent.
  await liveOn(deal);
  await liveOn(hindi);
  // Hotel voucher: Purchase marks a stored voucher "Ready for customer" on the supplier-confirmed task (A5).
  await asUser(USERS.purchase.id, 'select public.purchase_voucher_mark_ready($1, $2) as r', [voucher, randomUUID()]);
  expect((await messagesOf(deal, 'hotel_voucher')).map((m) => `${m.event_key}:${m.status}`)).toEqual([`voucher:${voucher}:queued`, `voucher:${voucher}:queued`]);
  await asUser(USERS.purchase.id, 'select public.purchase_voucher_mark_ready($1, $2) as r', [voucherH, randomUUID()]);
  expect((await messagesOf(hindi, 'hotel_voucher')).every((m) => m.status === 'queued' && m.language === 'hi')).toBe(true);
  // E-ticket: a stored e_ticket file of the Flight task with a ticket batch (5.6).
  const [flightTask] = await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight' order by created_at limit 1`, [deal]);
  const eTicket = await departmentFile(USERS.flight.id, flightTask!.id, 'e_ticket');
  expect((await messagesOf(deal, 'e_ticket')).map((m) => `${m.event_key}:${m.status}`)).toEqual([`eticket:${eTicket}:queued`, `eticket:${eTicket}:queued`]);
  // Notice 45 (flight within 24 hours, no boarding pass yet): the timer task, run now (clock moved by the test).
  await q('select authz.flight_boarding_pass_due()');
  const bp = await departmentFile(USERS.flight.id, flightTask!.id, 'boarding_pass');
  expect((await messagesOf(deal, 'boarding_pass')).map((m) => `${m.event_key}:${m.status}`)).toEqual([`bp:${bp}:queued`, `bp:${bp}:queued`]);

  // Visa status: SYNTHETIC FIXTURE STEP — a visa result notice row (the Visa desk's decision) on a visa application of the Deal.
  const [visaTask] = await q<{ id: string; item: string; branch: string; entity: string }>(`select t.id, t.service_item_id as item, t.branch_id as branch,
      t.legal_entity_id as entity from public.fulfilment_tasks t where t.deal_id = $1 and t.department = 'visa' limit 1`, [deal]);
  expect(visaTask, 'the pilot Deal has a visa task').toBeDefined();
  const app = (await q<{ id: string }>('select id from public.visa_applications where task_id = $1 and traveller_seq = 1', [visaTask!.id]))[0]
    ?? (await q<{ id: string }>(`insert into public.visa_applications (task_id, service_item_id, deal_id, legal_entity_id, traveller_seq)
      values ($1, $2, $3, $4, 1) returning id`, [visaTask!.id, visaTask!.item, deal, visaTask!.entity]))[0]!;
  await q(`insert into public.visa_result_notices (legal_entity_id, branch_id, deal_id, task_id, application_id, traveller_seq, outcome)
    values ($1, $2, $3, $4, $5, 1, 'approved')`, [visaTask!.entity, visaTask!.branch, deal, visaTask!.id, app.id]);
  const visa = await messagesOf(deal, 'visa_status');
  expect(visa.map((m) => `${m.event_key}:${m.status}`)).toEqual([`visa:${app.id}:approved:queued`, `visa:${app.id}:approved:queued`]);
  expect(visa[0]!.params).toMatchObject({ outcome: 'approved' });

  // Trip reminders D-3 (this Deal) and D-1 (the Hindi Deal): timer task customer_trip_reminders, from 10:00 India time (run now).
  const istHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  if (istHour >= 10) {
    await q('select authz.customer_trip_reminders()');
    expect((await messagesOf(deal, 'trip_reminder')).map((m) => m.event_key)).toContain(`d3:${v.start}`);
    expect((await messagesOf(hindi, 'trip_reminder')).map((m) => m.event_key)).toContain(`d1:${vh.start}`);
    expect((await messagesOf(deal, 'trip_reminder')).find((m) => m.event_key.startsWith('d3'))!.params).toMatchObject({ daysLeft: '3' }); // template variables are text
  }

  // Clock moved by the test (quiet hours), then the timer sends: every queued message reaches a provider double.
  const live = async () => [...await messagesOf(deal), ...await messagesOf(hindi)].filter((m) => m.status !== 'skipped');
  await messagesDueNow(deal);
  await messagesDueNow(hindi);
  await tickUntil(async () => (await live()).every((m) => !['queued', 'sending'].includes(m.status)), 120_000);
  expect((await live()).filter((m) => !['sent', 'delivered', 'read'].includes(m.status))).toEqual([]);
  const resend = doubleRequests('resend');
  const interakt = doubleRequests('interakt');
  expect(resend.length).toBeGreaterThan(0);
  expect(interakt.length).toBeGreaterThan(0);
  // Interakt body: template with the code, +91 and the callbackData = message id; never another customer's number.
  const body = JSON.parse(interakt.at(-1)!.body) as { countryCode: string; callbackData: string; type: string; template: { name: string; languageCode: string } };
  expect(body).toMatchObject({ countryCode: '+91', type: 'Template' });
  expect(body.template.name).toMatch(/^tn_[a-z_]+_(en|hi)_v[0-9]+$/);
  expect((await live()).map((m) => m.id)).toContain(body.callbackData);
  // Hindi Deal → Hindi template.
  expect(interakt.some((r) => /"languageCode":"hi"/.test(r.body))).toBe(true);
  // E-mail carries the attachment for the voucher; WhatsApp a link (LD7) — the double sees no file bytes in Interakt bodies.
  expect(interakt.every((r) => !/%PDF/.test(r.body))).toBe(true);

  // STOP on WhatsApp: the webhook route (signed) or, without the secret in this shell, the worker command (fixture step).
  const waMobile = (await q<{ m: string }>(`select c.mobile as m from public.booking_version_contacts c where c.booking_version_id = $1`, [vh.versionId]))[0]!.m;
  if (process.env.INTERAKT_WEBHOOK_SECRET) {
    const stopEvent = { type: 'message_received', data: { message: { message: 'STOP', chat_message_type: 'CustomerMessage' }, customer: { phone_number: waMobile,
      country_code: '+91' } }, id: `synthetic-stop-${stamp}` };
    const raw = JSON.stringify(stopEvent);
    // Addendum L4: `Interakt-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body).
    const sig = createHmac('sha256', process.env.INTERAKT_WEBHOOK_SECRET).update(raw).digest('hex');
    const res = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3100'}/api/integrations/interakt/webhook`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'interakt-signature': `sha256=${sig}` }, body: raw });
    expect(res.status).toBeLessThan(300);
    const bad = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3100'}/api/integrations/interakt/webhook`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'interakt-signature': 'sha256=00' }, body: raw });
    expect(bad.status).toBe(401);
  } else {
    await asService(`select public.customer_message_event_record('interakt', $1, null, 'inbound_stop', null, $2) as r`, [`synthetic-stop-${stamp}`, waMobile]);
  }
  expect((await q<{ n: number }>(`select count(*)::int as n from public.customer_whatsapp_optouts where mobile = $1 and restarted_at is null`, [waMobile]))[0]!.n).toBe(1);
  // Next message for the Hindi Deal (a second voucher): WhatsApp stopped, e-mail queued.
  await asUser(USERS.purchase.id, 'select public.purchase_voucher_mark_ready($1, $2) as r', [voucherH2, randomUUID()]);
  const afterStop = (await messagesOf(hindi, 'hotel_voucher')).filter((m) => m.event_key === `voucher:${voucherH2}`);
  expect(afterStop.find((m) => m.channel === 'whatsapp')).toMatchObject({ status: 'stopped', skip_reason: 'opted_out' });
  expect(afterStop.find((m) => m.channel === 'email')!.status).toBe('queued');
  // The Deal card shows the banner with "Restart WhatsApp" to the Sales owner.
  const so = await session(browser, 'sales', secrets);
  await so.page.goto(ROUTES.deal(hindi, 'services'));
  await expect(so.page.getByText('Customer stopped WhatsApp').first()).toBeVisible();
  await expect(so.page.getByRole('button', { name: 'Restart WhatsApp' }).first()).toBeVisible();
  await messagesDueNow(hindi);
  await tickUntil(async () => (await live()).every((m) => !['queued', 'sending'].includes(m.status)), 60_000);

  // A failed send shows on the Deal; "Send again" works after the contact is corrected.
  failNext('resend', 4);
  await asUser(USERS.purchase.id, 'select public.purchase_voucher_mark_ready($1, $2) as r', [voucher2, randomUUID()]);
  const failing = (await messagesOf(deal, 'hotel_voucher')).find((m) => m.event_key === `voucher:${voucher2}` && m.channel === 'email')!;
  for (let i = 0; i < 6; i += 1) {
    await messagesDueNow(deal);
    await timerTick();
    if ((await q<{ s: string }>('select status as s from public.customer_messages where id = $1', [failing.id]))[0]!.s === 'failed') break;
  }
  expect((await q<{ status: string; last_error_code: string }>('select status, last_error_code from public.customer_messages where id = $1', [failing.id]))[0])
    .toMatchObject({ status: 'failed', last_error_code: 'provider_error' });
  await setPrefs(deal, { emailOverride: `e2e.acc3.corrected.${stamp}@example.test` });
  await so.page.goto(ROUTES.deal(deal, 'services'));
  await expect(so.page.getByText(/^Failed/).first()).toBeVisible();
  await so.page.getByRole('button', { name: 'Send again: Hotel voucher by E-mail' }).first().click();
  await expect.poll(async () => (await q<{ n: number }>('select count(*)::int as n from public.customer_messages where resend_of = $1', [failing.id]))[0]!.n).toBe(1);
  await messagesDueNow(deal);
  const resentStatus = async () => (await q<{ s: string }>('select status as s from public.customer_messages where resend_of = $1', [failing.id]))[0]?.s;
  await tickUntil(async () => ['sent', 'delivered'].includes((await resentStatus()) ?? ''));
  expect(doubleRequests('resend').some((r) => r.body.includes(`e2e.acc3.corrected.${stamp}@example.test`))).toBe(true);

  // Refund paid (on the Hindi Deal: hotel only): back to synthetic for the money steps (finance gate); the payout's
  // trigger proves the event and the amount. Cancellation with the hotel's supplier charges, as the Phase 2 refund journey.
  await liveOff(hindi);
  const opened = await asUser<{ cancellationId: string }>(USERS.manager.id, 'select public.deal_cancellation_open($1, $2, $3) as r',
    [hindi, 'Synthetic: customer cancelled the trip', randomUUID()]);
  await asUser(USERS.purchase.id, 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r',
    [hotelH.taskId, '50000', '250000', null, null, 0, randomUUID()]);
  const c1 = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]))[0]!;
  await asUser(USERS.purchase.id, 'select public.deal_cancellation_send($1, $2, $3) as r', [opened.cancellationId, c1.row_version, randomUUID()]);
  const c2 = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]))[0]!;
  await asUser(USERS.manager.id, 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r', [opened.cancellationId, 'approve', null, c2.row_version,
    randomUUID()]);
  const [receipt] = await q<{ id: string }>(`select id from public.customer_receipts where deal_id = $1 and status = 'verified' limit 1`, [hindi]);
  const req = await asUser<{ refundRequestId: string }>(USERS.sales.id, 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r', [hindi,
    JSON.stringify({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '0', amountPaise: '100000', payeeKind: 'original_payer',
      payeeReceiptId: receipt!.id, payeeName: null, payeeReason: null, reason: 'Synthetic refund reason: trip cancelled by the customer' }), randomUUID()]);
  const rr = (await q<{ row_version: number }>('select row_version from public.customer_refund_requests where id = $1', [req.refundRequestId]))[0]!;
  await asUser(USERS.manager.id, 'select public.customer_refund_decide($1, $2, $3::bigint, $4::bigint, $5, $6, $7) as r',
    [req.refundRequestId, 'approve', '100000', '0', null, rr.row_version, randomUUID()]);
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(USERS.accA.id, 'select public.refund_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
    ['customer_refund', req.refundRequestId, 'proof.pdf', 'application/pdf', 2048, sha(), randomUUID()]);
  await putObject('finance-evidence', ev.objectPath);
  await asUser(USERS.accA.id, 'select public.refund_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
  const rv2 = (await q<{ row_version: number }>('select row_version from public.customer_refund_requests where id = $1', [req.refundRequestId]))[0]!;
  await asUser(USERS.accA.id, 'select public.customer_refund_payout_record($1, $2, $3::jsonb, $4) as r', [req.refundRequestId, rv2.row_version,
    JSON.stringify({ mode: 'bank_transfer', paidOn: dayFromToday(0), reference: `SYNRF${String(stamp).slice(-6)}`, evidenceId: ev.evidenceId }), randomUUID()]);
  const refund = await messagesOf(hindi, 'refund_paid');
  expect(refund.map((m) => `${m.channel}:${m.skip_reason}`).sort()).toEqual(['email:test_deal', 'whatsapp:test_deal']);
  expect(refund[0]!.params).toMatchObject({ amountPaise: '100000' });

  // Test Deal: synthetic and not in the pilot list → skipped rows only, nothing reaches a double.
  const testRows = await messagesOf(testDeal);
  expect(testRows.length).toBeGreaterThan(0);
  expect(testRows.every((m) => m.status === 'skipped' && ['test_deal', 'not_in_pilot'].includes(m.skip_reason ?? ''))).toBe(true);
  expect(doubleRequests().some((r) => r.body.includes(`ACC3MT-${stamp}`))).toBe(false);

  // No customer data in notices (fence of section 14): mobile, e-mail and amounts never appear.
  const noticeText = JSON.stringify(await q('select params from public.staff_notices where deal_id = any($1::uuid[])', [[deal, hindi]]));
  expect(leaks(noticeText, [waMobile, '1000000', `e2e.acc3.contact.21@example.test`])).toEqual([]);
  await noServiceWorker(so.page);
  await so.ctx.close();
});

test('9. no outbound request except the app, the local Supabase and the provider doubles', () => {
  expect(allowedOutbound()).toEqual([]);
});
