import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type Browser, type BrowserContext, type Page, expect } from '@playwright/test';
import { istToday } from '../helpers/browser-journey';
import { USERS, type UserKey, asUser, configured, prepareUsers, putObject, q, sha, signIn, supabaseUrl } from './acc-real-support';

/**
 * Accounts Phase 2 (contract 2026-11-11, test plan 12.4), Track F: shared
 * steps of the real journeys tests/e2e/acc2-*.real.e2e.ts (disposable local
 * stack, production build, local render worker). Reuses the Phase 1 E2E
 * users of acc-real-support.ts (Sales, Accounts A/B, Manager, Purchase,
 * Flight, Visa; random password and TOTP per run).
 *
 * Phase 1 lessons applied: every switch a journey changes is saved first and
 * restored in teardown (restoreSwitches); every Deal and contact mobile is
 * unique per run (stamp); notice recipient checks use "contains". The lead's
 * Phase 2 fixture people (accounts_phase2_people.sql, inactive by default)
 * are activated only for the run and put back (activateFixturePeople /
 * restoreFixturePeople).
 *
 * Set-up steps (booking, money, Purchase) are SYNTHETIC FIXTURE STEPS through
 * the database commands the screens call; the Phase 2 screens are driven in
 * the browser. Nothing runs unless every URL is a loopback address
 * (acc-real-support refuses otherwise).
 */

export { USERS, asUser, configured, istToday, prepareUsers, putObject, q, sha, signIn, supabaseUrl, type UserKey };

export const SUPER = 'a0000000-0000-4000-8000-000000000007';
export const REASON = 'Synthetic: Accounts phase 2 real journey (local stack)';
export const stamp = Date.now();
/** A unique 10-digit synthetic mobile per run and slot (Phase 1 lesson). */
export const mobile = (slot: number) => `9${String((stamp + slot * 7919) % 1_000_000_000).padStart(9, '0')}`;
export const entityId = async () => (await q<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;

// ---------------------------------------------------------------- switches
type Saved = { workflow?: Record<string, unknown>; notices?: boolean; accounts?: Record<string, unknown> | null; fixtureIds: string[] };
const saved: Saved = { fixtureIds: [] };
/** Saves every switch the journeys may change (call in beforeAll, before any change). */
export async function saveSwitches(): Promise<void> {
  saved.workflow = (await q<Record<string, unknown>>('select service_items_enabled, visa_passport_tasks_enabled from public.workflow_settings where id'))[0];
  saved.notices = (await q<{ n: boolean }>('select notices_enabled as n from public.notice_settings where id'))[0]?.n;
  saved.accounts = (await q<Record<string, unknown>>(
    `select tally_export_enabled, customer_documents_enabled, refunds_enabled from public.accounts_settings where legal_entity_id = $1`, [await entityId()]))[0] ?? null;
}
/** Switches on through the audited admin commands as the fixture Super Admin. */
export async function switchesOn(): Promise<void> {
  const e = await entityId();
  await q('update public.workflow_settings set service_items_enabled = true, visa_passport_tasks_enabled = true where id');
  await asUser(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [true, REASON]);
  await asUser(SUPER, 'select public.admin_set_tally_export_enabled($1, $2, $3) as r', [e, true, REASON]);
  await asUser(SUPER, 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r', [e, true, REASON]);
  await asUser(SUPER, 'select public.admin_set_refunds_enabled($1, $2, $3) as r', [e, true, REASON]);
}
/** Puts every saved switch back (teardown; audited commands where they exist). */
export async function restoreSwitches(): Promise<void> {
  const e = await entityId();
  const done = 'Synthetic: Accounts phase 2 real journey finished (local stack)';
  if (saved.workflow) {
    await q('update public.workflow_settings set service_items_enabled = $1, visa_passport_tasks_enabled = $2 where id',
      [saved.workflow.service_items_enabled, saved.workflow.visa_passport_tasks_enabled]);
  }
  if (saved.notices !== undefined) await asUser(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [saved.notices, done]).catch(() => undefined);
  const a = saved.accounts;
  await asUser(SUPER, 'select public.admin_set_tally_export_enabled($1, $2, $3) as r', [e, Boolean(a?.tally_export_enabled), done]).catch(() => undefined);
  await asUser(SUPER, 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r', [e, Boolean(a?.customer_documents_enabled), done]).catch(() => undefined);
  await asUser(SUPER, 'select public.admin_set_refunds_enabled($1, $2, $3) as r', [e, Boolean(a?.refunds_enabled), done]).catch(() => undefined);
  await restoreFixturePeople();
}
/** Activates lead fixture people for the run (memberships start inactive); remembered for restore. */
export async function activateFixturePeople(ids: string[]): Promise<void> {
  const rows = await q<{ user_id: string }>(
    `update public.memberships set status = 'active', deactivated_at = null where user_id = any($1::uuid[]) and status = 'inactive' returning user_id`, [ids]);
  saved.fixtureIds.push(...rows.map((r) => r.user_id));
}
export async function restoreFixturePeople(): Promise<void> {
  if (saved.fixtureIds.length === 0) return;
  await q(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = any($1::uuid[])`, [saved.fixtureIds]);
  saved.fixtureIds = [];
}

// ---------------------------------------------------------------- browser sessions
export const outbound: string[] = [];
const allowedHosts = () => new Set([new URL(supabaseUrl!).host, new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3100').host]);
/** Signed-in context; records any request to a host other than the app and the local Supabase (12.4 item 5). */
export async function session(browser: Browser, key: UserKey, secrets: Record<UserKey, string>):
  Promise<{ ctx: BrowserContext; page: Page; bodies: string[] }> {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const bodies: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (!allowedHosts().has(new URL(url).host)) outbound.push(url);
  });
  page.on('response', async (r) => {
    if (/json|text\/(html|plain|x-component)/.test(r.headers()['content-type'] ?? '')) bodies.push(await r.text().catch(() => ''));
  });
  await signIn(page, key, secrets);
  return { ctx, page, bodies };
}
export async function noServiceWorker(page: Page): Promise<void> {
  const n = await page.evaluate(async () => ('serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0));
  expect(n, 'no service worker (8.4)').toBe(0);
}
/** Stubs the browser Notification API in a context (pop-ups recorded, never shown). */
export async function stubNotifications(ctx: BrowserContext, permission: 'granted' | 'default' | 'denied' = 'granted'): Promise<void> {
  await ctx.addInitScript((perm) => {
    const w = window as unknown as { __popups: Array<{ title: string; body: string; tag: string }>; __asks: number; Notification: unknown };
    w.__popups = [];
    w.__asks = 0;
    class FakeNotification {
      static permission = perm;
      static async requestPermission() { w.__asks += 1; return perm; }
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body: string; tag: string }) { w.__popups.push({ title, body: opts.body, tag: opts.tag }); }
      close() {}
    }
    w.Notification = FakeNotification;
  }, permission);
}
export const popups = (page: Page) => page.evaluate(() => (window as unknown as { __popups?: Array<{ title: string; body: string }> }).__popups ?? []);

// ---------------------------------------------------------------- Deals and bookings
/** SYNTHETIC FIXTURE STEP: a new synthetic Delhi Deal owned by the E2E Sales user. */
export async function freshDeal(ref: string): Promise<string> {
  return (await q<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
     select b.legal_entity_id, b.id, $1, 'E2E Accounts phase 2 deal (synthetic)', $2, true
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [ref, USERS.sales.id]))[0]!.id;
}
export const SELLING = '45678913';
export const HOTEL = { hotelName: 'Synthetic Hotel (e2e)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 1, adults: 2,
  roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', children: 0, inclusions: null, specialRequests: null };
export const FLIGHT = { entryMode: 'typed', segments: [{ from: 'JDH', to: 'DEL', date: '2026-12-10', airline: 'Air India', flightNo: 'AI 470', departTime: '10:35',
  arriveTime: '11:50' }], passengers: 2, preferredTime: null, cabin: 'Economy', notes: null };
export const VISA = { country: 'France', purpose: 'Tourism', travelDate: '2027-02-06', applyBy: null, feePaidBy: 'company', notes: null, visaKind: 'sticker',
  jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', documentsNeeded: ['Passport copy (front and back)'] };

type Version = { versionId: string; rowVersion: number };
/** Booking draft with travellers, selling total, trip, contact, billing proposal, plan, ID proofs and acceptance; confirmed. */
export async function confirmedBooking(dealId: string, items: Array<[string, unknown]>, slot: number): Promise<Version & { itemIds: string[] }> {
  const S = USERS.sales.id;
  const opened = await asUser<Version>(S, 'select public.booking_open_draft($1) as r', [dealId]);
  let rv = opened.rowVersion;
  const itemIds: string[] = [];
  for (const [type, facts] of items) {
    const added = await asUser<{ rowVersion: number; itemId: string }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
      [opened.versionId, rv, type, JSON.stringify(facts), '99999999', randomUUID()]);
    rv = added.rowVersion;
    itemIds.push(added.itemId);
  }
  const travellers = [{ fullName: 'Synthetic Acc2 One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Acc2 Two', type: 'adult', seq: 2 }];
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [dealId, rv, JSON.stringify(travellers)])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [opened.versionId, rv,
    JSON.stringify({ hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null,
      inclusions: null, specialRequests: null, purchaseBudgetPaise: null }), SELLING])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify({ destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' })])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [opened.versionId, rv,
    JSON.stringify({ contactName: 'Synthetic Contact', mobile: mobile(slot), email: `e2e.acc2.contact.${slot}@example.test`, contactConfirmed: true,
      bookingFor: 'individual', payerDifferent: false, payerName: null }), JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road',
      addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }), 0, randomUUID()])).rowVersion;
  for (const itemId of itemIds) {
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
      [itemId, opened.versionId, rv, [1, 2]])).rowVersion;
  }
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: SELLING, dueDate: istToday() }])])).rowVersion;
  if (items.some(([type]) => type === 'visa')) {
    for (const seq of [1, 2]) {
      await asUser(S, 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r', [dealId, seq, 0, JSON.stringify({ dateOfBirth: '1990-05-17',
        nationality: 'Indian', passportNumber: `Z${7100000 + slot * 10 + seq}`, passportExpiry: '2030-01-31' })]);
    }
  }
  if (items.some(([type]) => type !== 'flight')) {
    for (const seq of [1, 2]) {
      const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
        [dealId, seq, randomUUID(), `id-${seq}.pdf`, 'application/pdf', 2048, sha()]);
      await putObject('traveller-id-proofs', begun.objectPath);
      await asUser(S, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
    }
  }
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [opened.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, sha()]);
  await putObject('booking-evidence', ev.objectPath);
  await asUser(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
  const r = await asUser<{ issues: string[]; contentHash: string }>(S, 'select public.booking_readiness($1) as r', [opened.versionId]);
  expect(r.issues).toEqual([]);
  await asUser(S, 'select public.booking_confirm($1, $2) as r', [opened.versionId, r.contentHash]);
  return { versionId: opened.versionId, rowVersion: rv, itemIds };
}

/** Accounts A saves and verifies billing; Accounts B approves the review (real commands). */
export async function approveBooking(dealId: string, versionId: string): Promise<void> {
  const billing = (await q<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [dealId]))[0];
  const saved2 = await asUser<{ rowVersion: number }>(USERS.accA.id, 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r', [dealId,
    billing?.row_version ?? 0, JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur',
      stateCode: '08', postalCode: '342001', gstin: null }), randomUUID()]);
  await asUser(USERS.accA.id, 'select public.accounts_billing_verify($1, $2, $3) as r', [dealId, saved2.rowVersion, randomUUID()]);
  const review = (await q<{ row_version: number }>('select row_version from public.accounts_booking_reviews where booking_version_id = $1', [versionId]))[0];
  await asUser(USERS.accB.id, 'select public.accounts_review_approve($1, $2, $3) as r', [versionId, review?.row_version ?? 0, randomUUID()]);
}

/** Cash receipt recorded by Accounts A (collected in Delhi), verified by Accounts B. Unique payer PAN per slot (cash cap). */
export async function verifiedCash(dealId: string, amountPaise: string, slot: number, payerName = 'Synthetic Acc2 Payer'): Promise<{ id: string; receiptNo: string }> {
  const del = (await q<{ id: string }>(`select id from public.branches where code = 'DEL' limit 1`))[0]!.id;
  const rec = await asUser<{ id: string; receiptNo: string }>(USERS.accA.id, 'select public.receipt_record($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({
    mode: 'cash', amountPaise, receivedOn: istToday(), branchId: del, collectorUserId: USERS.accA.id, payerName,
    payerPan: `ACCQZ${String((stamp + slot) % 10000).padStart(4, '0')}Q` }), randomUUID()]);
  await asUser(USERS.accB.id, 'select public.receipt_verify($1, $2) as r', [rec.id, randomUUID()]);
  return rec;
}

// ---------------------------------------------------------------- render worker
/** Runs the local render worker once on the customer queue (offline Chromium). Returns its JSON lines. */
export async function renderCustomerOnce(): Promise<Array<Record<string, unknown>>> {
  const crm = join(import.meta.dirname, '..', '..');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(crm, 'scripts', 'render-worker.mjs'), '--once', '--queue', 'customer', '--worker', `acc2-e2e-${stamp}`], {
      cwd: crm,
      env: { ...process.env, APP_ENV: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`render worker exit ${code}: ${err.slice(0, 400)}`));
      else resolve(out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l }; } }));
    });
  });
}

/** Releases a customer document draft (Accounts A) with the hash the screen showed. */
export async function releaseDoc(documentId: string, actor: string = USERS.accA.id): Promise<{ number: string }> {
  const d = (await q<{ row_version: number; content_sha256: string }>('select row_version, content_sha256 from public.customer_documents where id = $1',
    [documentId]))[0]!;
  await asUser(actor, 'select public.customer_document_release($1, $2, $3, $4) as r', [documentId, d.row_version, d.content_sha256, randomUUID()]);
  return (await q<{ number: string }>('select number from public.customer_documents where id = $1', [documentId]))[0]!;
}

/**
 * SYNTHETIC FIXTURE STEP: the E2E Flight user takes the Deal's flight group, adds a Flight supplier with
 * Manager-approved bank details and confirms tickets for travellers 1 and 2 on the first active sector.
 * Returns the ticket batch id. PNR and ticket numbers are unique per run.
 */
export async function ticketBatch(dealId: string, slot: number): Promise<string> {
  await asUser(USERS.flight.id, 'select public.flight_group_claim($1, $2) as r', [dealId, randomUUID()]);
  const [sector] = await q<{ id: string }>(`select s.id from public.flight_sectors s where s.deal_id = $1 and s.status = 'active' order by s.created_at limit 1`,
    [dealId]);
  const name = `E2E Acc2 Air ${stamp}-${slot}`;
  await asUser(USERS.flight.id, 'select public.flight_supplier_create($1::jsonb, $2) as r', [JSON.stringify({ name, city: 'Synthetic City',
    contactName: 'Synthetic Air Desk', contactPhone: '+91 00000 00000', contactEmail: 'air.desk@example.test' }), randomUUID()]);
  const supplierId = (await q<{ id: string }>('select id from public.suppliers where name = $1', [name]))[0]!.id;
  const rev = await asUser<{ revisionNo: number }>(USERS.flight.id, 'select public.flight_supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId,
    randomUUID(), JSON.stringify({ accountHolder: 'Synthetic Air Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000033334444' })])
    .catch(async () => asUser<{ revisionNo: number }>(USERS.flight.id, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, randomUUID(),
      JSON.stringify({ accountHolder: 'Synthetic Air Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000033334444' })]));
  await asUser(USERS.manager.id, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierId, rev.revisionNo]);
  const tail = String((stamp + slot) % 1_000_000).padStart(6, '0');
  const kind = (await q<{ k: string }>('select authz.flight_deal_kind($1) as k', [dealId]))[0]!.k;
  const fare = { paxType: 'adult', basicPaise: '500000', kPaise: '50000', yqPaise: '30000', yrPaise: '10000', otherPaise: '10000',
    ...(kind === 'flight_only' ? { markupPaise: '0', discountPaise: '0' } : {}) };
  const letters = (n: number) => String.fromCharCode(65 + (n % 26));
  const done = await asUser<{ batchId: string }>(USERS.flight.id, 'select public.flight_tickets_confirm($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({
    sectorIds: [sector!.id], supplierId, fareApprovalId: null, fares: [fare],
    // Ticket number 098- + 10 digits; airline PNR six letters/digits, unique per run.
    travellers: [1, 2].map((seq) => ({ seq, crsType: 'amadeus', crsPnr: `${letters(seq)}${letters(slot)}${tail.slice(2, 6)}`, airlinePnr: `${letters(slot)}${letters(seq)}${tail.slice(0, 4)}`,
      ticketNumber: `098-24${tail}${slot % 10}${seq}` })) }),
    randomUUID()]).catch((e: { message: string; hint?: string }) => { throw new Error(`flight_tickets_confirm ${e.message} (hint ${e.hint ?? '-'})`); });
  return done.batchId;
}
