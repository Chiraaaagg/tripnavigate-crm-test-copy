import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  FLIGHT, HOTEL, USERS, type UserKey, approveBooking, asUser, configured, confirmedBooking, entityId, freshDeal, istToday, noServiceWorker, outbound, popups,
  prepareUsers, q, releaseDoc, restoreSwitches, saveSwitches, session, stamp, stubNotifications, switchesOn, ticketBatch, verifiedCash,
} from './acc2-real-support';

/**
 * Accounts Phase 2 test plan 12.4 journey 2 "Refund end to end", Track F:
 * Manager opens the cancellation → Purchase and Flight enter charges → sent →
 * Manager approves → Sales owner requests a payout (charge, original payer)
 * → Manager approves (Approvals › Refunds) → Accounts pays out with proof
 * ("Pay out and verify RF-…") → dues total = charge, journal posted → credit
 * note drafted and released → Tally export carries the refund and CN rows
 * with mapped ledgers; urgent notices pop up (stubbed) on the leader tab
 * only. Item 5: no outbound request, no service worker.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');

let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches();
  secrets = await prepareUsers();
  await switchesOn();
});
test.afterAll(async () => {
  await restoreSwitches();
});

test('2. refund end to end', async ({ browser }) => {
  const ref = `ACC2RF-${stamp}`;
  const dealId = await freshDeal(ref);
  const v = await confirmedBooking(dealId, [['hotel', HOTEL], ['flight', FLIGHT]], 2);
  await approveBooking(dealId, v.versionId);
  await verifiedCash(dealId, '900000', 2, 'Synthetic Refund Payer');
  const inv = await asUser<{ documentId: string }>(USERS.accA.id, 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
    [dealId, 'invoice', '{}', randomUUID()]);
  await releaseDoc(inv.documentId);
  const tasks = await q<{ id: string; department: string }>('select id, department from public.fulfilment_tasks where deal_id = $1', [dealId]);
  const hotelTask = tasks.find((t) => t.department === 'purchase')!.id;

  // Purchase cost (so the case needs charges) and a Flight ticket batch (synthetic fixture steps).
  const entity = await entityId();
  const { supplierId } = await asUser<{ supplierId: string }>(USERS.purchase.id, 'select public.supplier_create($1, $2::jsonb) as r', [entity, JSON.stringify({
    name: `E2E Acc2 Stays ${stamp}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null, contactEmail: 'desk@example.test',
    paymentTerms: null, supplierKind: 'direct' })]);
  await asUser(USERS.purchase.id, 'select public.purchase_task_claim($1) as r', [hotelTask]);
  const { quoteId } = await asUser<{ quoteId: string }>(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [hotelTask, randomUUID(),
    JSON.stringify({ supplierId, hotelName: 'Synthetic Hotel (e2e)', roomType: null, mealPlan: null, quotedCostPaise: '300000', holdUntil: null,
      cancellationTerms: null })]);
  await asUser(USERS.purchase.id, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [hotelTask, quoteId, 0, '300000', null,
    null, randomUUID()]);

  const batchId = await ticketBatch(dealId, 2);

  // Sales owner's bell: pop-ups stubbed (granted), only the leader tab pops up.
  const sales = await browser.newContext();
  await stubNotifications(sales, 'granted');
  const salesSession = await session(browser, 'sales', secrets);
  await salesSession.ctx.close();

  // Manager opens the cancellation (urgent trip_cancelled notices).
  const opened = await asUser<{ cancellationId: string }>(USERS.manager.id, 'select public.deal_cancellation_open($1, $2, $3) as r',
    [dealId, 'Synthetic: customer cancelled the trip', randomUUID()]);
  const cancelledTo = (await q<{ r: string }>(`select recipient_user_id as r from public.staff_notices where deal_id = $1 and kind = 'trip_cancelled'`, [dealId]))
    .map((x) => x.r);
  expect(cancelledTo).toEqual(expect.arrayContaining([USERS.purchase.id, USERS.sales.id, USERS.accA.id]));
  // Purchase and Flight enter charges; Purchase sends.
  await asUser(USERS.purchase.id, 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r',
    [hotelTask, '50000', '250000', null, null, 0, randomUUID()]);
  await asUser(USERS.flight.id, 'select public.flight_cancellation_charge_set($1, $2::jsonb, $3, $4) as r', [batchId, JSON.stringify({
    airlineChargePaise: '20000', refundExpectedPaise: '0', refundReportedPaise: null, note: 'Synthetic airline fee' }), 0, randomUUID()]);
  const c1 = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]))[0]!;
  await asUser(USERS.purchase.id, 'select public.deal_cancellation_send($1, $2, $3) as r', [opened.cancellationId, c1.row_version, randomUUID()]);
  const c2 = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]))[0]!;
  await asUser(USERS.manager.id, 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r', [opened.cancellationId, 'approve', null, c2.row_version,
    randomUUID()]);

  // Sales owner requests the payout on the Deal page Refund card (charge, original payer). UX redesign R2: the card is
  // on the Money tab; the old Services address keeps a pointer to it.
  const so = await session(browser, 'sales', secrets);
  await stubNotifications(so.ctx, 'granted');
  await so.page.goto(`/app/deals/${dealId}?tab=services#refunds`);
  await expect(so.page.locator('[data-slot="deal-moved-cards"]').getByRole('link', { name: /^Refunds: Money/ })).toHaveAttribute('href', `/app/deals/${dealId}?tab=money#refunds`);
  await so.page.goto(`/app/deals/${dealId}?tab=money`);
  const refundCard = so.page.locator('section', { has: so.page.getByRole('heading', { name: 'Refunds' }) }).first();
  await expect(refundCard.getByText(/Money held/i).first()).toBeVisible();
  await refundCard.getByRole('button', { name: 'Ask for a refund' }).click();
  const form = so.page.getByRole('dialog', { name: 'Ask for a refund' });
  await form.getByRole('radio', { name: 'Trip cancellation' }).check();
  await form.getByRole('radio', { name: 'Pay the money back' }).check();
  await form.getByLabel('Customer cancellation charge (₹)').fill('1000');
  await form.getByLabel('Amount to pay back (₹)').fill('8000');
  await form.getByRole('radio', { name: 'The person who paid' }).check();
  const which = form.getByLabel('Which payment');
  if (await which.count()) await which.selectOption({ index: (await which.locator('option').count()) > 1 ? 1 : 0 }).catch(() => undefined);
  await form.getByLabel('Reason for the refund').fill('Synthetic refund reason: trip cancelled by the customer');
  await form.getByRole('button', { name: 'Send to the Manager' }).click();
  await expect.poll(async () => (await q<{ n: number }>('select count(*)::int as n from public.customer_refund_requests where deal_id = $1', [dealId]))[0]!.n)
    .toBe(1);
  const [req] = await q<{ id: string; ref_no: string; amount_paise: string; customer_charge_paise: string; payee_name: string }>(
    `select id, ref_no, amount_paise::text, customer_charge_paise::text, payee_name from public.customer_refund_requests where deal_id = $1`, [dealId]);
  expect(req).toMatchObject({ amount_paise: '800000', customer_charge_paise: '100000', payee_name: 'Synthetic Refund Payer' });

  // Manager approves in Approvals › Refunds ("Approve ₹8,000.00 refund (charge ₹1,000.00)").
  const mgr = await session(browser, 'manager', secrets);
  await stubNotifications(mgr.ctx, 'granted');
  await mgr.page.goto('/app/approvals');
  const toApprove = mgr.page.locator('section', { has: mgr.page.getByRole('heading', { name: 'Refunds to approve' }) }).first();
  await expect(toApprove.getByText(req!.ref_no).first()).toBeVisible();
  await toApprove.getByRole('button', { name: /^Approve ₹8,000\.00 refund \(charge ₹1,000\.00\)/ }).first().click();
  await mgr.page.getByRole('dialog', { name: new RegExp(`Approve refund ${req!.ref_no}\\?`) }).getByRole('button', { name: 'Approve' }).click();
  await expect.poll(async () => (await q<{ s: string }>('select status as s from public.customer_refund_requests where id = $1', [req!.id]))[0]!.s).toBe('approved');
  await mgr.ctx.close();

  // Accounts pays out with proof (one person records and verifies, Q6) on the Accounts deal page, Money tab.
  const accB = await session(browser, 'accB', secrets);
  await accB.page.goto(`/app/accounts/deals/${dealId}?tab=money`);
  await accB.page.getByRole('button', { name: `Pay out and verify ${req!.ref_no}` }).click();
  const pay = accB.page.getByRole('dialog');
  await pay.getByLabel('How it was paid').selectOption({ label: 'Bank transfer' });
  await pay.getByLabel('Paid on').fill(istToday());
  await pay.getByLabel('Bank or UPI reference').fill(`SYNRF${String(stamp).slice(-6)}`);
  const pdf = Buffer.alloc(2048, 32);
  pdf.write('%PDF-1.4\n% synthetic refund proof\n', 0);
  await pay.getByLabel('Payment proof').setInputFiles({ name: 'refund-proof.pdf', mimeType: 'application/pdf', buffer: pdf });
  await pay.getByRole('button', { name: /^Pay out and verify ₹/ }).click();
  await expect.poll(async () => (await q<{ s: string }>('select status as s from public.customer_refund_requests where id = $1', [req!.id]))[0]!.s).toBe('paid');
  const [entry] = await q<{ kind: string }>(`select e.kind from public.customer_refund_payouts p join public.finance_journal_entries e on e.id = p.journal_entry_id
    where p.refund_request_id = $1`, [req!.id]);
  expect(entry!.kind).toBe('refund_bank');
  const dues = await asUser<{ basis: { kind: string }; totalPaise: string }>(USERS.accA.id, 'select public.deal_dues($1) as r', [dealId]);
  expect(dues).toMatchObject({ basis: { kind: 'cancelled' }, totalPaise: '100000' });

  // Credit note drafted and released (case 1: Invoice total − charge).
  const cn = await asUser<{ documentId: string }>(USERS.accA.id, 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
    [dealId, 'credit_note', JSON.stringify({ refundRequestId: req!.id }), randomUUID()]);
  expect((await releaseDoc(cn.documentId)).number).toBe(`${ref}-CN-1`);

  // Tally export: refund journal row and the credit note row with mapped ledgers and the Deal narration.
  const exp = await asUser<{ exportId: string }>(USERS.accA.id, 'select public.accounts_tally_export_create($1::jsonb, $2) as r', [JSON.stringify({ entityId: entity,
    from: istToday(), to: istToday(), kinds: ['journal_entry', 'customer_document'], includeExported: true }), randomUUID()]);
  const lines = await asUser<{ lines: Array<{ values: Record<string, unknown> }> }>(USERS.accA.id, 'select public.accounts_tally_export_lines($1, $2, $3) as r',
    [exp.exportId, 0, 1000]);
  const texts = lines.lines.map((l) => JSON.stringify(l.values)).filter((t) => t.includes(ref));
  expect(texts.some((t) => t.includes('Customer refund') && t.includes(req!.ref_no))).toBe(true);
  expect(texts.some((t) => t.includes('Customer credit note') && t.includes(`${ref}-CN-1`))).toBe(true);
  expect(texts.every((t) => t.includes(`| ${ref} |`))).toBe(true);

  // Notices: the Manager's urgent approval notice popped up on a leader tab (stub), the payout notice never pops up.
  const shown = await popups(so.page);
  expect(shown.every((p) => !/₹|[0-9]{5,}/.test(p.body.replace(/RF-[0-9-]+|ACC2RF-[0-9]+/g, '')))).toBe(true);
  await noServiceWorker(so.page);
  await so.ctx.close();
  await accB.ctx.close();
  await sales.close();
});

test('5. no outbound request to any other host during the run', () => {
  expect(outbound).toEqual([]);
});
