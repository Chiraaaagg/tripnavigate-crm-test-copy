import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  HOTEL, USERS, type UserKey, approveBooking, asUser, configured, confirmedBooking, freshDeal, noServiceWorker, outbound, prepareUsers, q, releaseDoc,
  renderCustomerOnce, restoreSwitches, saveSwitches, session, stamp, switchesOn, verifiedCash,
} from './acc2-real-support';

/**
 * Accounts Phase 2 test plan 12.4 journey 1 "Document release end to end",
 * Track F (production build on the disposable stack, local render worker):
 * receipt recorded and verified → ADV draft → release …-ADV-1 → PDF made by
 * the local worker (sha256 stored) → download as Sales owner and Manager,
 * refused for Purchase → review approved → Invoice draft → link GST invoice
 * number → release …-INV-1 → revision approved → "Booking changed since
 * release" → replace → …-INV-2, old "Replaced by". Item 5: no outbound
 * request, no service worker. Screen labels are the contract's (section 11).
 * Skips without a real stack; teardown restores every switch.
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

test('1. document release end to end', async ({ browser }) => {
  const ref = `ACC2DOC-${stamp}`;
  const dealId = await freshDeal(ref);
  const v = await confirmedBooking(dealId, [['hotel', HOTEL]], 1);
  await approveBooking(dealId, v.versionId);
  const rec = await verifiedCash(dealId, '500000', 1);

  // Accounts: the Accounts deal page, Documents tab, "Customer documents" card offers the payment; draft and release on screen.
  const acc = await session(browser, 'accA', secrets);
  const docsUrl = `/app/accounts/deals/${dealId}?tab=documents`;
  await acc.page.goto(docsUrl);
  const card = acc.page.locator('section', { has: acc.page.getByRole('heading', { name: 'Customer documents' }) }).first();
  await card.getByRole('button', { name: new RegExp(`^Create draft Advance Invoice for ${rec.receiptNo}`) }).click();
  await card.getByRole('button', { name: /^Release (as |this )/ }).first().click();
  const confirmDialog = acc.page.getByRole('dialog');
  await expect(confirmDialog.getByRole('heading', { name: /^Release (as .+|this Advance Invoice)\?$/ })).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^Release/ }).last().click();
  await expect(card.getByText(`${ref}-ADV-1`).first()).toBeVisible();
  const [adv] = await q<{ id: string; number: string; status: string }>(
    `select id, number, status from public.customer_documents where deal_id = $1 and kind = 'advance_invoice'`, [dealId]);
  expect(adv).toMatchObject({ number: `${ref}-ADV-1`, status: 'released' });

  // PDF made by the local worker (one job), stored with sha256.
  const lines = await renderCustomerOnce();
  expect(JSON.stringify(lines)).not.toMatch(/failed|refused/);
  const [file] = await q<{ sha256: string; size_bytes: number }>('select sha256, size_bytes from public.customer_document_files where document_id = $1', [adv!.id]);
  expect(file!.sha256).toMatch(/^[0-9a-f]{64}$/);

  // Download as Sales owner and Manager; Purchase is refused.
  for (const key of ['sales', 'manager'] as const) {
    const s = await session(browser, key, secrets);
    const res = await s.page.request.get(`/app/deals/${dealId}/documents/${adv!.id}/pdf`);
    expect(res.status(), key).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(res.headers()['content-disposition']).toContain(`${ref}-ADV-1.pdf`);
    await s.ctx.close();
  }
  const pur = await session(browser, 'purchase', secrets);
  const refused = await pur.page.request.get(`/app/deals/${dealId}/documents/${adv!.id}/pdf`);
  expect([403, 404]).toContain(refused.status());
  await pur.ctx.close();
  const downloads = await q<{ n: number }>(`select count(*)::int as n from public.audit_events where action = 'accounts.customer_document.downloaded'
    and target_id = $1`, [adv!.id]);
  expect(downloads[0]!.n).toBe(2);

  // Invoice: draft from the approved booking, link the GST number, release INV-1.
  const inv = await asUser<{ documentId: string }>(USERS.accA.id, 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
    [dealId, 'invoice', '{}', randomUUID()]);
  const gst = await asUser<{ tallyInvoiceId?: string; id?: string }>(USERS.accA.id, 'select public.accounts_tally_invoice_add($1, $2::jsonb, $3) as r',
    [dealId, JSON.stringify({ invoiceRef: `HC/E2E/${String(stamp).slice(-5)}`, invoiceDate: '2026-11-11', note: null }), randomUUID()]);
  const gstId = gst.tallyInvoiceId ?? gst.id ?? (await q<{ id: string }>('select id from public.deal_tally_invoices where deal_id = $1', [dealId]))[0]!.id;
  await acc.page.goto(docsUrl);
  await card.getByRole('button', { name: /^Link GST invoice number for Invoice draft/ }).click();
  const linkDialog = acc.page.getByRole('dialog');
  const gstSelect = linkDialog.getByLabel('Tally GST invoice reference');
  const gstOption = gstSelect.locator('option', { hasText: `HC/E2E/${String(stamp).slice(-5)}` });
  await gstSelect.selectOption(await gstOption.getAttribute('value') ?? { index: 1 });
  await linkDialog.getByRole('button', { name: 'Link the number' }).click();
  await expect.poll(async () => (await q<{ t: string | null }>('select tally_invoice_id as t from public.customer_documents where id = $1',
    [inv.documentId]))[0]!.t).toBe(gstId);
  expect((await releaseDoc(inv.documentId)).number).toBe(`${ref}-INV-1`);

  // Revision approved on a later version: "Booking changed since release"; replace → INV-2; old reads "Replaced by".
  await asUser(USERS.accA.id, 'select public.accounts_review_return($1, $2, $3) as r', [v.versionId, 'Synthetic return: selling total changes', randomUUID()]);
  const opened = await asUser<{ versionId: string; rowVersion: number }>(USERS.sales.id, 'select public.booking_open_revision($1) as r', [v.versionId]);
  let rv = (await asUser<{ rowVersion: number }>(USERS.sales.id, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [opened.versionId,
    opened.rowVersion, JSON.stringify({ hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null,
      children: null, inclusions: null, specialRequests: null, purchaseBudgetPaise: null }), '47000000'])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(USERS.sales.id, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: '47000000', dueDate: '2026-12-01' }])])).rowVersion;
  await asUser(USERS.sales.id, 'select public.booking_classify_revision($1, $2, $3) as r', [opened.versionId, rv, 'customer_material']);
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(USERS.sales.id, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [opened.versionId, 'acceptance_message', 'acceptance-2.pdf', 'application/pdf', 2048, 'd'.repeat(63) + '1']);
  const { putObject } = await import('./acc2-real-support');
  await putObject('booking-evidence', ev.objectPath);
  await asUser(USERS.sales.id, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
  const ready = await asUser<{ contentHash: string }>(USERS.sales.id, 'select public.booking_readiness($1) as r', [opened.versionId]);
  await asUser(USERS.sales.id, 'select public.booking_confirm($1, $2) as r', [opened.versionId, ready.contentHash]);
  await approveBooking(dealId, opened.versionId);
  await acc.page.goto(docsUrl);
  await expect(card.getByText('Booking changed since release').first()).toBeVisible();
  await card.getByRole('button', { name: new RegExp(`^Replace Invoice ${ref}-INV-1`) }).click();
  const rep = acc.page.getByRole('dialog');
  await rep.getByLabel('Why it is replaced').fill('Synthetic: booking total changed after release');
  await rep.getByRole('button', { name: 'Make the replacement draft' }).click();
  await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.customer_documents where deal_id = $1 and replaces_document_id = $2
    and status = 'draft'`, [dealId, inv.documentId]))[0]!.n).toBe(1);
  const [draft] = await q<{ id: string }>(`select id from public.customer_documents where deal_id = $1 and replaces_document_id = $2 and status = 'draft'`,
    [dealId, inv.documentId]);
  expect((await releaseDoc(draft!.id)).number).toBe(`${ref}-INV-2`);
  await acc.page.goto(docsUrl);
  await expect(card.getByText(new RegExp(`Replaced by ${ref}-INV-2`)).first()).toBeVisible();
  // Nothing in the documents says "not a tax invoice" (Q1).
  await expect(acc.page.getByText(/not a tax invoice/i)).toHaveCount(0);
  await noServiceWorker(acc.page);
  await acc.ctx.close();
});

test('5. no outbound request to any other host during the run', () => {
  expect(outbound).toEqual([]);
});
