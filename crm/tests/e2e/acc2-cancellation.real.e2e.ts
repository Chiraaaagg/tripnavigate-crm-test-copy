import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  FLIGHT, USERS, type UserKey, VISA, approveBooking, asUser, configured, confirmedBooking, freshDeal, istToday, noServiceWorker, outbound, prepareUsers,
  putObject, q, restoreSwitches, saveSwitches, session, sha, stamp, switchesOn, ticketBatch, verifiedCash,
} from './acc2-real-support';

/**
 * Accounts Phase 2 test plan 12.4 journey 4 "Flight/Visa cancellation",
 * Track F: flight + visa Deal; cancellation opened → Flight urgent notice →
 * airline charges entered on the Flight task's Trip cancelled panel →
 * Manager approval → tickets shown cancelled → Visa blocked (fee save
 * refused, trip_cancelled) → withdraw one application, let the other finish →
 * supplier (airline) refund recorded and verified in one step by one Accounts
 * person (Addendum L1). Item 5: no outbound request, no service worker.
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

type Applicant = { applicationId: string; rowVersion: number; seq: number; removed?: boolean; documents: Array<{ documentId: string }> };

test('4. Flight and Visa cancellation', async ({ browser }) => {
  const ref = `ACC2CX-${stamp}`;
  const dealId = await freshDeal(ref);
  const v = await confirmedBooking(dealId, [['flight', FLIGHT], ['visa', VISA]], 4);
  await approveBooking(dealId, v.versionId);
  await verifiedCash(dealId, '300000', 4, 'Synthetic Cancel Payer');
  const batchId = await ticketBatch(dealId, 4);

  // Visa: both applicants applied (company-paid fee) before the cancellation.
  const visaTask = (await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'visa'`, [dealId]))[0]!.id;
  await asUser(USERS.visa.id, 'select public.visa_task_claim($1) as r', [visaTask]);
  const ws = await asUser<{ applicants: Applicant[] }>(USERS.visa.id, 'select public.visa_workspace($1) as r', [visaTask]);
  const lines: Array<Record<string, unknown>> = [];
  for (const a of ws.applicants.filter((x) => !x.removed)) {
    await asUser(USERS.visa.id, 'select public.visa_application_set_row($1, $2, $3::jsonb, $4) as r', [a.applicationId, a.rowVersion, JSON.stringify({
      documents: a.documents.map((d) => ({ documentId: d.documentId, received: true })), appointmentDate: istToday() }), randomUUID()]);
  }
  const ready = await asUser<{ applicants: Applicant[] }>(USERS.visa.id, 'select public.visa_workspace($1) as r', [visaTask]);
  for (const a of ready.applicants.filter((x) => !x.removed)) {
    lines.push({ applicationId: a.applicationId, expectedRowVersion: a.rowVersion, reference: `SYN-REF-${a.applicationId.slice(0, 8)}`, appliedOn: istToday(),
      governmentFeePaise: '650000', serviceFeePaise: null });
  }
  await asUser(USERS.visa.id, 'select public.visa_applications_apply($1, $2::jsonb, $3) as r', [visaTask, JSON.stringify({ applicants: lines, paidBy: 'company',
    paymentMode: 'upi', receiptEvidenceId: null, remark: null }), randomUUID()]);

  // Manager opens the cancellation: Flight gets the urgent "enter the airline charges" notice.
  const opened = await asUser<{ cancellationId: string }>(USERS.manager.id, 'select public.deal_cancellation_open($1, $2, $3) as r',
    [dealId, 'Synthetic: customer cancelled the trip', randomUUID()]);
  const flightNotices = await q<{ recipient_user_id: string; priority: string }>(
    `select recipient_user_id, priority from public.staff_notices where deal_id = $1 and kind = 'flight_charges_to_enter'`, [dealId]);
  expect(flightNotices.map((n) => n.recipient_user_id)).toContain(USERS.flight.id);
  expect(flightNotices.every((n) => n.priority === 'urgent')).toBe(true);

  // Flight enters the airline charges on the Trip cancelled panel.
  const fl = await session(browser, 'flight', secrets);
  await fl.page.goto(`/app/flight/deals/${dealId}?tab=work`);
  await expect(fl.page.getByText(/Trip cancelled/i).first()).toBeVisible();
  await fl.page.getByRole('button', { name: /^Enter airline charges/ }).first().click();
  const chargeForm = fl.page.getByRole('dialog').or(fl.page.locator('form', { has: fl.page.getByLabel('What the airline keeps (₹)') })).first();
  await chargeForm.getByLabel('What the airline keeps (₹)').fill('1500');
  await chargeForm.getByLabel('Refund expected (₹)').fill('4000');
  await chargeForm.getByLabel('Note').fill('Synthetic: airline keeps the fare difference');
  await chargeForm.getByRole('button', { name: 'Save charges' }).click();
  await expect.poll(async () => (await q<{ n: number }>('select count(*)::int as n from public.flight_cancellation_charges where batch_id = $1', [batchId]))[0]!.n)
    .toBe(1);
  const c1 = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]))[0]!;
  await asUser(USERS.flight.id, 'select public.deal_cancellation_send($1, $2, $3) as r', [opened.cancellationId, c1.row_version, randomUUID()]);
  const c2 = (await q<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]))[0]!;
  await asUser(USERS.manager.id, 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r', [opened.cancellationId, 'approve', null, c2.row_version,
    randomUUID()]);
  await fl.page.reload();
  await expect(fl.page.getByText('Tickets cancelled').first()).toBeVisible();
  await noServiceWorker(fl.page);
  await fl.ctx.close();

  // Visa: blocked after approval; withdraw one application, let the other finish.
  await expect(asUser(USERS.visa.id, 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r', [visaTask, null, 0, JSON.stringify({ costKind: 'other',
    amountPaise: '25000', paidBy: 'company', paymentMode: 'cash', paidOn: istToday(), applicationId: null }), randomUUID()])).rejects.toThrow(/^trip_cancelled$/);
  const vs = await session(browser, 'visa', secrets);
  await vs.page.goto(`/app/visa/${visaTask}?tab=work`);
  await expect(vs.page.getByText(/Trip cancelled/i).first()).toBeVisible();
  const apps = await q<{ id: string; row_version: number }>(`select id, row_version from public.visa_applications where task_id = $1 and submitted_at is not null
    order by created_at, id`, [visaTask]);
  expect(apps.length).toBeGreaterThanOrEqual(2);
  // First application on the screen: Decide → Withdraw the application.
  await vs.page.getByRole('button', { name: /^Decide the application of / }).first().click();
  const decide = vs.page.getByRole('dialog');
  await decide.getByRole('radio', { name: 'Withdraw the application' }).check();
  await decide.getByLabel('Reason').fill('Synthetic: trip cancelled by the customer');
  await decide.getByRole('button', { name: 'Save the choice' }).click();
  await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.visa_applications where task_id = $1
    and cancellation_choice = 'withdraw'`, [visaTask]))[0]!.n).toBe(1);
  const left = await q<{ id: string; row_version: number }>(`select id, row_version from public.visa_applications where task_id = $1 and submitted_at is not null
    and cancellation_choice is null order by created_at, id`, [visaTask]);
  apps.splice(0, apps.length, ...(await q<{ id: string; row_version: number }>(`select id, row_version from public.visa_applications where task_id = $1
    and cancellation_choice = 'withdraw'`, [visaTask])), ...left);
  await asUser(USERS.visa.id, 'select public.visa_application_cancellation_choice($1, $2, $3, $4, $5) as r', [apps[1]!.id, apps[1]!.row_version, 'finish',
    'Synthetic: decision expected in two days', randomUUID()]);
  const states = await q<{ id: string; state: string; cancellation_choice: string }>(
    'select id, state, cancellation_choice from public.visa_applications where id = any($1::uuid[])', [[apps[0]!.id, apps[1]!.id]]);
  expect(states.find((x) => x.id === apps[0]!.id)).toMatchObject({ state: 'withdrawn', cancellation_choice: 'withdraw' });
  expect(states.find((x) => x.id === apps[1]!.id)!.cancellation_choice).toBe('finish');
  await vs.page.goto(`/app/visa/${visaTask}?tab=work`);
  const visaText = (await vs.page.locator('body').innerText());
  expect(visaText, 'Visa never sees customer money').not.toMatch(/Money held|customer charge/i);
  await vs.ctx.close();

  // Airline refund received: one Accounts person records it; verified at once (L1).
  const [charge] = await q<{ id: string }>('select id from public.flight_cancellation_charges where batch_id = $1 order by revision_no desc limit 1', [batchId]);
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(USERS.accA.id, 'select public.refund_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
    ['supplier_refund', opened.cancellationId, 'airline-refund.pdf', 'application/pdf', 2048, sha(), randomUUID()]);
  await putObject('finance-evidence', ev.objectPath);
  await asUser(USERS.accA.id, 'select public.refund_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
  const acc = await session(browser, 'accA', secrets);
  await acc.page.goto('/app/accounts/refunds');
  await expect(acc.page.getByText(ref).first()).toBeVisible();
  await asUser(USERS.accA.id, 'select public.supplier_refund_record($1::jsonb, $2) as r', [JSON.stringify({ sourceKind: 'flight_charge', sourceId: charge!.id,
    amountPaise: '400000', receivedOn: istToday(), mode: 'bank_transfer', reference: `SYNAIR${String(stamp).slice(-6)}`, evidenceId: ev.evidenceId,
    overExpectedReason: null }), randomUUID()]);
  const [sr] = await q<{ status: string; recorded_by: string; verified_by: string }>(
    'select status, recorded_by, verified_by from public.supplier_refund_receipts where source_id = $1', [charge!.id]);
  expect(sr).toEqual({ status: 'verified', recorded_by: USERS.accA.id, verified_by: USERS.accA.id });
  // The whole expected refund (₹4,000) is now received, so it is no longer due: it leaves Accounts › Refunds
  // (open list only). Waiting there for "verified" passed only when some OTHER open refund on the stack showed
  // "Received (verified)" (round-3 flake). The Deal's refund card shows the verified receipt.
  await acc.page.reload();
  await expect(acc.page.getByText(ref)).toHaveCount(0);
  // R4: the refund cards sit on the Accounts deal page's Refunds tab.
  await acc.page.goto(`/app/accounts/deals/${dealId}?tab=refunds`);
  const supplierRefunds = acc.page.getByRole('region', { name: 'Refunds expected from suppliers' });
  await expect(supplierRefunds.getByText('All received', { exact: true })).toBeVisible();
  await expect(supplierRefunds.getByRole('list', { name: /^Refunds received for / }).getByText('Verified', { exact: true })).toBeVisible();
  await acc.ctx.close();
});

test('5. no outbound request to any other host during the run', () => {
  expect(outbound).toEqual([]);
});
