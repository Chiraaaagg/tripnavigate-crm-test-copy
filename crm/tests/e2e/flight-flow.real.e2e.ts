import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { challengeViaUi, istToday, signInViaUi, totpCode, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Flight build (contract 4 Nov 2026), Track D, test plan 12.4: the real
 * browser journey of the Flight department against a disposable local
 * Supabase stack served by the production build.
 *
 *   Package Deal with two flight items (onward typed with a blank flight
 *   number on leg 2, return from a screenshot) + a flight-only Deal:
 *    1. Flight: queue shows ONE row with "Show 2 flights"; Take these flights.
 *    2. Return: type the sectors from the screenshot; onward: fill the
 *       missing flight number.
 *    3. Alternate the onward leg 1 for traveller 2 -> the Sales owner
 *       approves on the Deal page; a second alternative is rejected with a
 *       reason -> the traveller is back on the original flight.
 *    4. Passenger itinerary for traveller 3 -> approved.
 *    5. Confirm tickets for the group (one PNR, two travellers, "+" for the
 *       next ticket number); over budget -> the Manager approves the fares
 *       on Approvals -> confirm.
 *    6. Record a direct payment <= INR 50,000 with proof; Accounts A accepts.
 *    7. Sales revises the booking (Accounts returns first): "Booking
 *       changed"; Flight applies; the unchanged sector keeps its tickets.
 *    8. Correct ticket (reason); attach e-tickets; mark done; the Deal page
 *       shows Done and the e-ticket opens for the Sales owner; Deal History
 *       shows flight events.
 *    9. Flight-only Deal: markup/discount, "Save and apply" change, payment
 *       request above INR 50,000 -> Manager approves -> Accounts A records ->
 *       Accounts B verifies.
 *   10. Money fence: Purchase and Visa sessions get no flight money in HTML
 *       or in any network response of the run.
 *   11. axe at 1280 and 375 px on the queue, every workspace tab, the
 *       popup, the payment drawer, the Deal approval card and Approvals; no
 *       sideways scroll; keyboard path through the popup and dialogs with
 *       visible focus and focus return; 200% zoom; reduced motion.
 *
 * It can run only once Tracks A, B and C have landed. Screen labels are the
 * contract's (section 11.1). Run-tagged synthetic staff are created here
 * (no shared fixture user needed). Skips without a real stack; fails (never
 * skips) when REQUIRE_REAL_STACK=1 and anything is missing.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(databaseUrl && supabaseUrl && publishableKey && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL, the Supabase URL, publishable key or secret key is missing: the Flight flow must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Flight flow runs only against a loopback Supabase stack and database.');
}

const shotDir = process.env.FLIGHT_FLOW_SHOTS ?? 'test-results/real-journey/flight-flow';
const fileDir = 'test-results/real-journey/flight-flow-files';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const PASSWORD = `E2e-${randomUUID()}-Pw1`;

const USERS = {
  sales: { id: 'a0000000-0000-4000-8000-0000000006e1', email: 'e2e.fflow.sales@example.test', name: 'E2E Flight Sales', role: 'sales', branch: 'DEL' },
  salesFo: { id: 'a0000000-0000-4000-8000-0000000006e2', email: 'e2e.fflow.sales2@example.test', name: 'E2E Flight Sales Two', role: 'sales', branch: 'DEL' },
  flight: { id: 'a0000000-0000-4000-8000-0000000006e3', email: 'e2e.fflow.flight@example.test', name: 'E2E Flight Desk', role: 'flight', branch: 'JDH' },
  accA: { id: 'a0000000-0000-4000-8000-0000000006e4', email: 'e2e.fflow.accounts.a@example.test', name: 'E2E Flight Accounts A', role: 'accounts', branch: 'JDH' },
  accB: { id: 'a0000000-0000-4000-8000-0000000006e5', email: 'e2e.fflow.accounts.b@example.test', name: 'E2E Flight Accounts B', role: 'accounts', branch: 'DEL' },
  manager: { id: 'a0000000-0000-4000-8000-0000000006e6', email: 'e2e.fflow.manager@example.test', name: 'E2E Flight Manager', role: 'manager', branch: 'DEL' },
  purchase: { id: 'a0000000-0000-4000-8000-0000000006e7', email: 'e2e.fflow.purchase@example.test', name: 'E2E Flight Purchase', role: 'purchase', branch: 'JDH' },
  visa: { id: 'a0000000-0000-4000-8000-0000000006e8', email: 'e2e.fflow.visa@example.test', name: 'E2E Flight Visa', role: 'visa', branch: 'JDH' },
} as const;
type UserKey = keyof typeof USERS;

// Distinctive synthetic money (paise) and ticket values: Purchase and Visa must never see them.
const SELLING_PAISE = '45678901';
const BUDGET_PAISE = '500000'; // ₹5,000 per flight item (₹10,000 for the Deal): the group confirm goes over budget
const BASIC = '612300'; // ₹6,123.00 basic per adult
const MARKUP = '43200';
const DISCOUNT = '12300';
const FO_BASIC = '5512300'; // flight-only fare: above ₹50,000 for one traveller -> payment request to the Manager
const PNR = 'FLW123';
// Ticket numbers are unique per entity across Deals (D8): every run uses its own range (10-digit base from the clock).
const TICKET_BASE = 2_000_000_000 + (Date.now() % 1_000_000_000) * 2;
const ticketNo = (offset: number) => `098-${TICKET_BASE + offset}`;
const TICKET_1 = ticketNo(1);
const TICKET_2 = ticketNo(2);
const TRAVELLERS = [
  { fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 },
  { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 },
  { fullName: 'Synthetic Traveller Three', type: 'adult', seq: 3 },
];
const ONWARD = {
  entryMode: 'typed', passengers: 3, cabin: 'Economy', preferredTime: null, notes: null,
  segments: [
    { from: 'JDH', to: 'DEL', date: '2026-12-10', airline: 'Air India', flightNo: 'AI 470', departTime: '10:35', arriveTime: '11:50' },
    { from: 'DEL', to: 'GOI', date: '2026-12-10', airline: 'Air India', departTime: '14:00', arriveTime: '16:35' },
  ],
};
const RETURN = { entryMode: 'screenshot', passengers: 3, segments: [], cabin: 'Economy', screenshotNote: 'Synthetic: return as in the screenshot' };
const HOTEL = { hotelName: 'E2E Flight Palace', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 2, adults: 3, roomType: 'Synthetic Deluxe',
  mealPlan: 'Breakfast', children: 0, inclusions: null, specialRequests: null };

function moneyPatterns(paise: string): RegExp[] {
  const rupees = (Number(paise) / 100).toFixed(2);
  const [whole, dec] = rupees.split('.') as [string, string];
  const indian = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  const western = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = [...new Set([`${indian}.${dec}`, `${western}.${dec}`, `${whole}.${dec}`])]
    .map((v) => new RegExp(`(?<![\\d,])${v.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d])`));
  out.push(new RegExp(`(?<![0-9a-fA-F])${paise}(?![0-9a-fA-F])`));
  return out;
}
const FORBIDDEN: Array<{ what: string; patterns: RegExp[] }> = [
  { what: 'selling total', patterns: moneyPatterns(SELLING_PAISE) },
  { what: 'flight basic fare', patterns: moneyPatterns(BASIC) },
  { what: 'flight-only basic fare', patterns: moneyPatterns(FO_BASIC) },
  { what: 'markup', patterns: moneyPatterns(MARKUP) },
  { what: 'discount', patterns: moneyPatterns(DISCOUNT) },
  { what: 'flight budget', patterns: moneyPatterns(BUDGET_PAISE) },
];

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const note = (step: string, ok: boolean, detail = '') => results.push({ step, ok, detail });
function check(step: string, ok: boolean, detail: string) {
  note(step, ok, detail);
  expect.soft(ok, `${step}: ${detail}`).toBe(true);
}
let shotNo = 0;
async function shot(page: Page, name: string) {
  shotNo += 1;
  await page.screenshot({ path: join(shotDir, `${String(shotNo).padStart(2, '0')}-${name}.png`), fullPage: true });
}

// ---------------------------------------------------------------------------
// Synthetic fixture steps (local stack only)
// ---------------------------------------------------------------------------
const db = <T>(fn: (client: pg.Client) => Promise<T>) => withDb(databaseUrl!, fn);
const admin = () => createClient(supabaseUrl!, secretKey!, { auth: noPersist });

async function asUser<T = unknown>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return db(async (client) => {
    await client.query('begin');
    try {
      const now = Math.floor(Date.now() / 1000);
      const claims = { sub: userId, role: 'authenticated', aal: 'aal2', aud: 'authenticated', iat: now, exp: now + 900,
        amr: [{ method: 'password', timestamp: now - 30 }, { method: 'totp', timestamp: now - 30 }] };
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query('set local role authenticated');
      const { rows } = await client.query<{ r: T }>(sql, params);
      await client.query('commit');
      return rows[0]?.r as T;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}
async function putObject(bucket: string, path: string, bytes: Uint8Array<ArrayBuffer>, mime: string) {
  const { error } = await admin().storage.from(bucket).upload(path, new Blob([bytes], { type: mime }), { contentType: mime, upsert: false });
  if (error) throw new Error(`upload to ${bucket} failed: ${error.message}`);
}
const fakePdf = (size = 2048): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(size));
  out.fill(32);
  out.set(Buffer.from('%PDF-1.4\n% synthetic test file\n'), 0);
  return out;
};
const fakePng = (): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(2048));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return out;
};
const sha = () => randomBytes(32).toString('hex');

async function prepareUsers(): Promise<Record<UserKey, string>> {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the Flight flow needs the 'test' deployment environment").toBe('test');
  });
  const a = admin();
  for (const u of Object.values(USERS)) {
    const created = await a.auth.admin.createUser({ id: u.id, email: u.email, password: PASSWORD, email_confirm: true });
    if (created.error) {
      if (!/already/i.test(created.error.message)) throw new Error(`could not create ${u.email}: ${created.error.message}`);
      const updated = await a.auth.admin.updateUserById(u.id, { password: PASSWORD });
      if (updated.error) throw new Error(`could not reset ${u.email}: ${updated.error.message}`);
    }
  }
  await db(async (client) => {
    for (const u of Object.values(USERS)) {
      await client.query(`insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
        values ($1, $2, $3, 'active', now()) on conflict (user_id) do nothing`, [u.id, u.name, u.email]);
      await client.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = $3
           and not exists (select 1 from public.memberships m where m.user_id = $1 and m.branch_id = b.id and m.role_code = $2)`,
        [u.id, u.role, u.branch]);
    }
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
  });
  const secrets = {} as Record<UserKey, string>;
  for (const [key, u] of Object.entries(USERS) as Array<[UserKey, (typeof USERS)[UserKey]]>) {
    const c = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
    const signed = await c.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (signed.error) throw new Error(`${key} sign-in failed`);
    const enrolled = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: `fflow-${key}-${Date.now()}` });
    if (enrolled.error) throw new Error(`${key} TOTP enrolment failed`);
    const verified = await c.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(enrolled.data.totp.secret) });
    if (verified.error) throw new Error(`${key} TOTP verification failed`);
    secrets[key] = enrolled.data.totp.secret;
    await c.auth.signOut({ scope: 'local' });
  }
  return secrets;
}

type Booked = { dealId: string; dealRef: string; versionId: string; flightItems: string[]; flightTasks: string[] };

/** SYNTHETIC FIXTURE STEP: the Sales owner confirms a booking through the same commands the booking screens call. */
async function seedBooking(stamp: number, opts: { tag: string; owner: string; items: Array<{ type: string; facts: unknown; budget: string }> }): Promise<Booked> {
  const S = opts.owner;
  const dealRef = `FF-${opts.tag}-${stamp}`;
  const dealId = await db(async (c) => (await c.query<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
     select b.legal_entity_id, b.id, $1, 'E2E Flight flow deal (synthetic)', $2, true
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [dealRef, S])).rows[0]!.id);
  const before = await db(async (c) => (await c.query<{ on: boolean }>('select service_items_enabled as on from public.workflow_settings where id')).rows[0]!.on);
  await db((c) => c.query('update public.workflow_settings set service_items_enabled = true where id'));
  try {
    const opened = await asUser<{ versionId: string; rowVersion: number }>(S, 'select public.booking_open_draft($1) as r', [dealId]);
    const v = opened.versionId;
    let rv = opened.rowVersion;
    const itemIds: string[] = [];
    for (const item of opts.items) {
      const added = await asUser<{ rowVersion: number; itemId: string }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
        [v, rv, item.type, JSON.stringify(item.facts), item.budget, randomUUID()]);
      rv = added.rowVersion;
      itemIds.push(added.itemId);
    }
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [dealId, rv, JSON.stringify(TRAVELLERS)])).rowVersion;
    const nullFacts = { hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null,
      inclusions: null, specialRequests: null, purchaseBudgetPaise: null };
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [v, rv, JSON.stringify(nullFacts), SELLING_PAISE])).rowVersion;
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
      [v, rv, JSON.stringify({ destination: 'Synthetic City, Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-15' })])).rowVersion;
    const billing = await db(async (c) => (await c.query<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [dealId])).rows[0]);
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [v, rv,
      JSON.stringify({ contactName: 'Synthetic Contact', mobile: '9876500011', email: 'contact@example.test', contactConfirmed: true, bookingFor: 'individual', payerDifferent: false, payerName: null }),
      billing ? null : JSON.stringify({ billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }),
      0, randomUUID()])).rowVersion;
    for (const item of itemIds) {
      rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [item, v, rv, [1, 2, 3]])).rowVersion;
    }
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
      [v, rv, JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: SELLING_PAISE, dueDate: '2026-11-01' }])])).rowVersion;
    for (const seq of [1, 2, 3]) {
      const bytes = fakePdf();
      const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
        [dealId, seq, randomUUID(), `id-proof-${seq}.pdf`, 'application/pdf', bytes.byteLength, sha()]);
      await putObject('traveller-id-proofs', begun.objectPath, bytes, 'application/pdf');
      await asUser(S, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
    }
    for (const [i, item] of opts.items.entries()) {
      if ((item.facts as { entryMode?: string }).entryMode !== 'screenshot') continue;
      const png = fakePng();
      const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.service_item_file_begin($1, $2, $3, $4::jsonb, $5) as r',
        [itemIds[i], v, 'flight_screenshot', JSON.stringify({ fileName: 'return-fare.png', mime: 'image/png', sizeBytes: png.byteLength, sha256: sha() }), randomUUID()]);
      await putObject('service-item-files', begun.objectPath, png, 'image/png');
      await asUser(S, 'select public.service_item_file_finish($1, $2) as r', [begun.fileId, true]);
    }
    const proof = fakePdf();
    const ev = await asUser<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
      [v, 'acceptance_message', 'acceptance.pdf', 'application/pdf', proof.byteLength, sha()]);
    await putObject('booking-evidence', ev.objectPath, proof, 'application/pdf');
    await asUser(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
    const ready = await asUser<{ issues: string[]; contentHash: string }>(S, 'select public.booking_readiness($1) as r', [v]);
    expect(ready.issues, 'synthetic booking is ready to confirm').toEqual([]);
    await asUser(S, 'select public.booking_confirm($1, $2) as r', [v, ready.contentHash]);
    const flightTasks = await db(async (c) => (await c.query<{ id: string }>(
      `select t.id from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
       where t.deal_id = $1 and t.department = 'flight' order by i.item_no`, [dealId])).rows.map((r) => r.id));
    const flightItems = itemIds.filter((_, i) => opts.items[i]!.type === 'flight');
    return { dealId, dealRef, versionId: v, flightItems, flightTasks };
  } finally {
    await db((c) => c.query('update public.workflow_settings set service_items_enabled = $1 where id', [before]));
  }
}

/** Confirms every still-pending (sector, traveller) pair as the Flight user, asking for and approving fares when over budget; pays every unpaid batch by request. */
async function completeRemaining(b: Booked): Promise<void> {
  const F = USERS.flight.id;
  const { supplier_id: supplierId } = (await db(async (c) => (await c.query<{ supplier_id: string }>(
    'select supplier_id from public.flight_ticket_batches where deal_id = $1 order by batch_no limit 1', [b.dealId])).rows))[0]!;
  const pending = await db(async (c) => (await c.query<{ sector_id: string; seqs: number[] }>(
    `select p.sector_id, array_agg(p.traveller_seq order by p.traveller_seq) as seqs
     from public.flight_sector_passengers p join public.flight_sectors s on s.id = p.sector_id
     where s.deal_id = $1 and s.status = 'active' and p.ended_at is null and p.held_by_change_id is null
       and not exists (select 1 from public.flight_ticket_revisions r where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)
     group by p.sector_id`, [b.dealId])).rows);
  let n = 0;
  for (const row of pending) {
    const fares = [{ paxType: 'adult', basicPaise: BASIC, kPaise: '50000', yqPaise: '30000', yrPaise: '10000', otherPaise: '10000' }];
    const base = { sectorIds: [row.sector_id], supplierId, fares };
    const preview = await asUser<{ overBudget: boolean }>(F, 'select public.flight_fare_preview($1, $2::jsonb) as r',
      [b.dealId, JSON.stringify({ ...base, travellers: row.seqs.map((seq) => ({ seq })) })]);
    let fareApprovalId: string | null = null;
    if (preview.overBudget) {
      await asUser(F, 'select public.flight_fare_approval_request($1, $2::jsonb, $3) as r',
        [b.dealId, JSON.stringify({ ...base, travellers: row.seqs.map((seq) => ({ seq })) }), randomUUID()]);
      const a = await db(async (c) => (await c.query<{ id: string; row_version: number }>(
        `select id, row_version from public.flight_fare_approvals where deal_id = $1 and status = 'pending'`, [b.dealId])).rows[0]!);
      await asUser(USERS.manager.id, 'select public.flight_fare_approval_decide($1, $2, $3, $4, $5) as r', [a.id, 'approve', null, a.row_version, randomUUID()]);
      fareApprovalId = a.id;
    }
    await asUser(F, 'select public.flight_tickets_confirm($1, $2::jsonb, $3) as r', [b.dealId, JSON.stringify({ ...base, fareApprovalId,
      travellers: row.seqs.map((seq) => ({ seq, crsType: 'amadeus', crsPnr: 'CRS456', airlinePnr: 'FLW456', ticketNumber: ticketNo(100 + (n++) * 10 + seq) })) }), randomUUID()]);
  }
  const unpaid = await db(async (c) => (await c.query<{ id: string }>(
    `select b.id from public.flight_ticket_batches b where b.deal_id = $1
       and not exists (select 1 from public.department_cost_entries e where e.flight_batch_id = b.id and e.expense_status in ('submitted', 'accepted'))
       and not exists (select 1 from public.supplier_payment_requests p where p.flight_batch_id = b.id and p.status in ('approved', 'paid', 'verified'))`, [b.dealId])).rows);
  for (const batch of unpaid) {
    await asUser(F, 'select public.flight_payment_request_create($1, $2::jsonb, $3) as r', [batch.id, JSON.stringify({ dueDate: istToday(), note: null, proformaEvidenceId: null }), randomUUID()]);
    const p = await db(async (c) => (await c.query<{ id: string; route: string; row_version: number }>(
      `select id, route, row_version from public.supplier_payment_requests where flight_batch_id = $1 and status = 'pending'`, [batch.id])).rows[0]!);
    await asUser(p.route === 'manager' ? USERS.manager.id : USERS.accA.id, 'select public.supplier_payment_decide($1, $2, $3, $4, $5) as r',
      [p.id, 'approve', null, p.row_version, randomUUID()]);
  }
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
interface Session { context: BrowserContext; page: Page }
async function signIn(browser: Browser, key: UserKey, secret: string, opts: { reducedMotion?: boolean } = {}): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  await signInViaUi(page, USERS[key].email, PASSWORD);
  await challengeViaUi(page, secret);
  await expect(page).toHaveURL(/\/app(\/|$|\?)/);
  return { context, page };
}
const BODY_READ_MS = 10_000;
function recordResponses(page: Page, into: Array<Promise<{ url: string; body: string; readable: boolean }>>) {
  page.on('response', (res) => {
    const url = res.url();
    if (!url.startsWith('http://127.0.0.1') || /\/_next\/static\//.test(url)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unreadable = new Promise<{ url: string; body: string; readable: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ url, body: '', readable: false }), BODY_READ_MS);
    });
    const read = res.text().then((body) => ({ url, body, readable: true })).catch(() => ({ url, body: '', readable: false }));
    into.push(Promise.race([read, unreadable]).finally(() => clearTimeout(timer)));
  });
}
function leaksIn(text: string): string[] {
  const found: string[] = [];
  for (const f of FORBIDDEN) for (const p of f.patterns) if (p.test(text)) found.push(`${f.what} (${p.source})`);
  if (text.includes(PNR)) found.push('airline PNR');
  return found;
}
async function noSidewaysScroll(page: Page, label: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`11 · no sideways scroll · ${label}`, sw <= cw + 1, `scrollWidth ${sw} vs clientWidth ${cw}`);
}
async function axe(page: Page, label: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (include) builder = builder.include(include);
  const r = await builder.analyze();
  const v = r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  check(`11 · axe · ${label}`, v.length === 0, v.length ? v.join('; ') : 'no violations');
}
async function a11yBothWidths(page: Page, label: string, opts: { include?: string; shotName?: string } = {}) {
  for (const width of [1280, 375, 640]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : width === 640 ? 430 : 860 });
    await page.waitForTimeout(300);
    if (width !== 640) await axe(page, `${label} @${width}`, opts.include);
    await noSidewaysScroll(page, `${label} @${width === 640 ? '200% zoom' : width}`);
    if (opts.shotName && width !== 640) await shot(page, `${opts.shotName}-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}
/** Keyboard: Enter opens the dialog, Tab/Shift+Tab stay inside with visible focus, Escape closes, focus returns. */
async function dialogKeyboard(page: Page, trigger: Locator, label: string) {
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  const opened = await dialog.first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  check(`11 · keyboard · ${label} opens with Enter`, opened, opened ? 'dialog visible' : 'no dialog after Enter');
  if (!opened) return;
  let escaped = 0;
  let invisible = 0;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press(i % 6 === 5 ? 'Shift+Tab' : 'Tab');
    const state = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { inside: false, visible: false };
      const s = getComputedStyle(el);
      return { inside: !!el.closest('[role="dialog"]'), visible: s.outlineStyle !== 'none' || s.boxShadow !== 'none' };
    });
    if (!state.inside) escaped += 1;
    if (!state.visible) invisible += 1;
  }
  check(`11 · keyboard · ${label} focus trapped`, escaped === 0, `${escaped} of 25 key presses left the dialog`);
  check(`11 · keyboard · ${label} focus visible`, invisible === 0, `${invisible} of 25 focus stops had no visible indicator`);
  await page.keyboard.press('Escape');
  const closed = await dialog.first().waitFor({ state: 'hidden', timeout: 5_000 }).then(() => true).catch(() => false);
  check(`11 · keyboard · ${label} Escape closes`, closed, closed ? 'closed' : 'dialog still open');
  const back = await trigger.evaluate((el) => el === document.activeElement).catch(() => false);
  check(`11 · keyboard · ${label} focus returns`, back, back ? 'trigger focused' : 'focus elsewhere');
}
/** Index of the first <option> whose text contains `text` (option values are ids or seqs, not frozen). */
async function optionIndex(select: Locator, text: string): Promise<number> {
  const texts = await select.locator('option').allInnerTexts();
  const i = texts.findIndex((t) => t.includes(text));
  if (i < 0) throw new Error(`no option containing "${text}" (have: ${texts.join(' | ')})`);
  return i;
}
/** "2026-11-05" -> "5 Nov 2026" (text date boxes). */
function finDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}
async function stepRun(name: string, fn: () => Promise<void>) {
  await test.step(name, async () => {
    try {
      await fn();
      note(name, true, 'passed');
    } catch (error) {
      note(name, false, (error as Error).message.replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join(' ').slice(0, 600));
      throw error;
    }
  });
}
const workspace = (dealId: string, tab = 'work') => `/app/flight/deals/${dealId}?tab=${tab}`;

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------
// A missing control fails within 20 s instead of waiting for the whole 30-minute test timeout.
test.use({ actionTimeout: 20_000, navigationTimeout: 60_000 });

test.describe('Flight department: real end-to-end flow (Flight build)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (TEST_DATABASE_URL, Supabase URL and keys).');

  test('queue to done for a package and a flight-only Deal, with money fence, accessibility and keyboard checks', async ({ browser }) => {
    test.setTimeout(1_800_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(fileDir, { recursive: true });
    const stamp = Date.now();
    const pdf = (name: string) => {
      const p = join(fileDir, `${name}-${stamp}.pdf`);
      writeFileSync(p, fakePdf(4096));
      return p;
    };
    const fenceResponses: Array<Promise<{ url: string; body: string; readable: boolean }>> = [];
    let secrets!: Record<UserKey, string>;
    let pkg!: Booked;
    let fo!: Booked;
    const contexts: BrowserContext[] = [];
    let F!: Session;
    let SO!: Session;
    let M!: Session;
    let A!: Session;

    try {
      await stepRun('0 · fixture: staff, package Deal (hotel + onward typed + return screenshot), flight-only Deal', async () => {
        secrets = await prepareUsers();
        pkg = await seedBooking(stamp, { tag: 'PKG', owner: USERS.sales.id, items: [
          { type: 'hotel', facts: HOTEL, budget: '4500000' },
          { type: 'flight', facts: ONWARD, budget: BUDGET_PAISE },
          { type: 'flight', facts: RETURN, budget: BUDGET_PAISE },
        ] });
        fo = await seedBooking(stamp, { tag: 'FO', owner: USERS.salesFo.id, items: [
          { type: 'flight', facts: { ...ONWARD, segments: [ONWARD.segments[0]] }, budget: '99999999' },
        ] });
        expect(pkg.flightTasks).toHaveLength(2);
        expect(fo.flightTasks).toHaveLength(1);
      });

      await stepRun('1 · Flight: one queue row with "Show 2 flights"; Take these flights takes both', async () => {
        F = await signIn(browser, 'flight', secrets.flight, { reducedMotion: true });
        contexts.push(F.context);
        const page = F.page;
        await page.goto('/app/flight');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const row = page.getByRole('row').filter({ hasText: pkg.dealRef });
        await expect(row).toHaveCount(1);
        // 2+ flights: a disclosure ("Show 2 flights", a <details> summary) lists the Deal's flights.
        await row.getByText('Show 2 flights').click();
        await expect(page.getByText(/JDH → DEL → GOI/).first()).toBeVisible();
        await a11yBothWidths(page, 'Flight queue', { shotName: 'flight-queue' });
        await page.goto(workspace(pkg.dealId, 'details'));
        await page.getByRole('button', { name: 'Take these flights' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.fulfilment_tasks where deal_id = $1 and department = 'flight' and status = 'in_progress' and assignee_user_id = $2`,
          [pkg.dealId, USERS.flight.id])).rows[0]!.n), { timeout: 30_000 }).toBe(2);
        // D7: names shown to Flight.
        await expect(page.locator('main')).toContainText('Synthetic Traveller One');
        for (const tab of ['details', 'work', 'files', 'history']) {
          await page.goto(workspace(pkg.dealId, tab));
          await a11yBothWidths(page, `Flight workspace ${tab}`, { shotName: `workspace-${tab}` });
        }
      });

      await stepRun('2 · type the return sectors from the screenshot; fill the missing onward flight number', async () => {
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        const shotRegion = page.getByRole('region', { name: /^Sectors from the screenshot/ }).first();
        // The grid opens with one empty sector row (wait for it rather than adding a second one).
        await expect(shotRegion.getByLabel('Date', { exact: true }).first()).toBeVisible();
        await shotRegion.getByLabel('Date', { exact: true }).first().fill('15 Dec 26');
        await shotRegion.getByLabel('Flight no.', { exact: true }).first().fill('6E 211');
        await shotRegion.getByLabel('From', { exact: true }).first().fill('GOI');
        await shotRegion.getByLabel('To', { exact: true }).first().fill('JDH');
        await shotRegion.getByLabel('Dep time', { exact: true }).first().fill('09:05');
        await shotRegion.getByLabel('Arr time', { exact: true }).first().fill('11:40');
        await shotRegion.getByRole('button', { name: /^Save sectors/ }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.flight_sectors where task_id = $1 and origin = 'screenshot' and status = 'active'`, [pkg.flightTasks[1]])).rows[0]!.n),
        { timeout: 30_000 }).toBe(1);
        await page.getByRole('button', { name: /^Fill missing details of .*DEL → GOI/ }).first().click();
        await page.getByRole('group', { name: 'Missing flight details' }).getByLabel('Flight no.', { exact: true }).fill('AI 883');
        await page.getByRole('button', { name: 'Save details' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.flight_sectors where deal_id = $1 and flight_no = 'AI 883' and status = 'active'`, [pkg.dealId])).rows[0]!.n),
        { timeout: 30_000 }).toBe(1);
      });

      /** Flight: Alternate on the JDH → DEL leg for one traveller (package: sent to Sales). */
      const alternate = async (traveller: string, flightNo: string) => {
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        await page.getByRole('button', { name: /^Alternate .*AI 470/ }).first().click();
        const details = page.getByRole('group', { name: 'New flight details' });
        await details.getByLabel('Flight no.', { exact: true }).fill(flightNo);
        await details.getByLabel('Dep time', { exact: true }).fill('18:20');
        await details.getByLabel('Arr time', { exact: true }).fill('19:35');
        // Prototype bug fixed (FV:2252): the passenger choice is part of the form.
        const who = page.getByRole('group', { name: /^Travellers who move/ });
        await expect(who.getByRole('checkbox')).not.toHaveCount(0);
        await who.getByRole('checkbox', { name: new RegExp(`^${traveller}`) }).check();
        await page.getByLabel('Remark', { exact: true }).fill('Synthetic: customer asked for the evening flight');
        await page.getByRole('button', { name: 'Send to Sales for approval' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.flight_sectors where deal_id = $1 and flight_no = $2 and status = 'pending'`, [pkg.dealId, flightNo])).rows[0]!.n),
        { timeout: 30_000 }).toBe(1);
      };
      const pendingItem = (page: Page, text: RegExp) => page.getByRole('list', { name: 'Flight changes waiting' }).getByRole('listitem').filter({ hasText: text }).first();

      await stepRun('3 · alternate leg 1 for traveller 2 -> Sales owner approves; a second one rejected with a reason', async () => {
        await alternate('Synthetic Traveller Two', 'AI 472');
        SO = await signIn(browser, 'sales', secrets.sales);
        contexts.push(SO.context);
        await SO.page.goto(`/app/deals/${pkg.dealId}?tab=services`);
        const item = pendingItem(SO.page, /AI 472/);
        await expect(item).toContainText('Synthetic Traveller Two');
        await a11yBothWidths(SO.page, 'Deal approval card', { shotName: 'deal-approval-card' });
        await item.getByRole('button', { name: 'Approve' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select status as s from public.flight_changes where deal_id = $1 order by change_no limit 1`, [pkg.dealId])).rows[0]!.s), { timeout: 30_000 }).toBe('approved');
        await alternate('Synthetic Traveller One', 'AI 474');
        await SO.page.goto(`/app/deals/${pkg.dealId}?tab=services`);
        const second = pendingItem(SO.page, /AI 474/);
        await second.getByLabel(/Reason for rejecting/).fill('Synthetic: the customer keeps the original flight');
        await second.getByRole('button', { name: 'Reject' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select status as s from public.flight_changes where deal_id = $1 order by change_no desc limit 1`, [pkg.dealId])).rows[0]!.s), { timeout: 30_000 }).toBe('rejected');
        const onOriginal = await db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.flight_sector_passengers p join public.flight_sectors s on s.id = p.sector_id
           where s.deal_id = $1 and s.flight_no = 'AI 470' and s.status = 'active' and p.traveller_seq = 1 and p.ended_at is null and p.held_by_change_id is null`,
          [pkg.dealId])).rows[0]!.n);
        check('3 · rejected traveller back on the original flight', onOriginal === 1, `${onOriginal} current assignment(s)`);
      });

      await stepRun('4 · passenger itinerary for traveller 3 -> approved', async () => {
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        await page.getByRole('button', { name: 'New itinerary for one traveller' }).first().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Traveller', { exact: true }).selectOption({ index: await optionIndex(dialog.getByLabel('Traveller', { exact: true }), 'Synthetic Traveller Three') });
        // The new itinerary starts from the traveller's current flights: keep one row and retype it.
        await expect(dialog.getByLabel('From', { exact: true }).or(dialog.getByRole('button', { name: 'Add a flight' })).first()).toBeVisible();
        if ((await dialog.getByLabel('From', { exact: true }).count()) === 0) await dialog.getByRole('button', { name: 'Add a flight' }).click();
        while ((await dialog.getByRole('button', { name: /^Remove flight \d+$/ }).count()) > 1) {
          await dialog.getByRole('button', { name: /^Remove flight \d+$/ }).last().click();
        }
        const row = dialog.getByRole('group', { name: 'Flight 1 of the new itinerary' });
        await row.getByLabel('Date', { exact: true }).fill('10 Dec 26');
        await row.getByLabel('Flight no.', { exact: true }).fill('6E 505');
        await row.getByLabel('From', { exact: true }).fill('JDH');
        await row.getByLabel('To', { exact: true }).fill('GOI');
        // 12.3: the time box takes "07:05 pm" (8 characters).
        await row.getByLabel('Dep time', { exact: true }).fill('07:05 pm');
        await row.getByLabel('Arr time', { exact: true }).fill('09:15 pm');
        await dialog.getByLabel('Remark', { exact: true }).fill('Synthetic: direct flight for traveller three');
        await dialog.getByRole('button', { name: 'Send to Sales for approval' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select status as s from public.flight_changes where deal_id = $1 and kind = 'passenger_itinerary'`, [pkg.dealId])).rows[0]?.s), { timeout: 30_000 }).toBe('pending');
        // Pending passenger itinerary is reflected in "x of y" (12.3).
        await page.reload();
        await expect(page.locator('main')).toContainText(/In progress · \d+ of \d+ tickets/);
        await SO.page.goto(`/app/deals/${pkg.dealId}?tab=services`);
        await pendingItem(SO.page, /6E 505/).getByRole('button', { name: 'Approve' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select status as s from public.flight_changes where deal_id = $1 and kind = 'passenger_itinerary'`, [pkg.dealId])).rows[0]?.s), { timeout: 30_000 }).toBe('approved');
      });

      /** Fills passenger line `i` of the open Confirm tickets popup. */
      const fillLine = async (popup: Locator, i: number, traveller: string, t: { crs: string; crsPnr?: string; pnr: string; ticket?: string }) => {
        const passenger = popup.getByLabel('Passenger', { exact: true }).nth(i);
        await passenger.selectOption({ index: await optionIndex(passenger, traveller) });
        await popup.getByLabel('CRS type', { exact: true }).nth(i).selectOption({ label: t.crs });
        if (t.crsPnr) await popup.getByLabel('CRS PNR', { exact: true }).nth(i).fill(t.crsPnr);
        await popup.getByLabel('Airline PNR', { exact: true }).nth(i).fill(t.pnr);
        if (t.ticket) await popup.getByLabel('Ticket number', { exact: true }).nth(i).fill(t.ticket);
      };
      const fillFares = async (popup: Locator, f: { basic: string; markup?: string; discount?: string }) => {
        await popup.getByLabel('Basic amount', { exact: true }).first().fill(f.basic);
        for (const [label, value] of [['K', '500'], ['YQ', '300'], ['YR', '100'], ['Other charges', '100']] as const) {
          await popup.getByLabel(label, { exact: true }).first().fill(value);
        }
        if (f.markup !== undefined) await popup.getByLabel('Markup', { exact: true }).first().fill(f.markup);
        if (f.discount !== undefined) await popup.getByLabel('Discount', { exact: true }).first().fill(f.discount);
      };

      await stepRun('5 · Confirm tickets: one PNR, two travellers, next ticket number; over budget -> Manager approves -> confirm', async () => {
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        // Traveller 1 is on AI 470 and AI 883; traveller 2 on AI 472 (approved) and AI 883: tick the three flights.
        for (const flightNo of ['AI 470', 'AI 472', 'AI 883']) {
          await page.getByRole('checkbox', { name: new RegExp(`^Select .*${flightNo}.* for Confirm tickets$`) }).first().check();
        }
        const open = page.locator('main').getByRole('button', { name: /^Confirm tickets/ }).first();
        await dialogKeyboard(page, open, 'Confirm tickets popup');
        await open.click();
        const popup = page.getByRole('dialog');
        await popup.getByRole('button', { name: 'Add supplier' }).first().click();
        await popup.getByLabel('Name', { exact: true }).fill(`E2E Air Consolidator ${stamp}`);
        await popup.getByRole('button', { name: 'Add supplier' }).last().click();
        const supplier = popup.getByLabel('Paid to (airline or consolidator)');
        // Wait for this run's new supplier (earlier runs' suppliers are listed too), then make sure it is the chosen one.
        await expect.poll(async () => (await supplier.locator('option').allInnerTexts()).some((t) => t.includes(`E2E Air Consolidator ${stamp}`)), { timeout: 20_000 }).toBe(true);
        await supplier.selectOption({ index: await optionIndex(supplier, `E2E Air Consolidator ${stamp}`) });
        await fillLine(popup, 0, 'Synthetic Traveller One', { crs: 'Amadeus', crsPnr: 'CRS123', pnr: PNR.toLowerCase(), ticket: TICKET_1 });
        // The popup opens with one line per traveller still to ticket; remove line 2 and use "+" to copy line 1
        // (same PNRs, next ticket number, next traveller).
        await popup.getByRole('button', { name: 'Remove line 2' }).click();
        await popup.getByRole('button', { name: 'Copy line 1 for the next passenger' }).click();
        await expect(popup.getByLabel('Ticket number', { exact: true }).nth(1)).toHaveValue(TICKET_2);
        const second = popup.getByLabel('Passenger', { exact: true }).nth(1);
        if (!(await second.locator('option:checked').innerText()).includes('Synthetic Traveller Two')) {
          await second.selectOption({ index: await optionIndex(second, 'Synthetic Traveller Two') });
        }
        await fillFares(popup, { basic: '6,123' });
        // Package Deal: no Markup / Discount fields (D4).
        await expect(popup.getByLabel('Markup', { exact: true })).toHaveCount(0);
        await expect(popup.getByLabel('Discount', { exact: true })).toHaveCount(0);
        await expect(popup.getByRole('region', { name: 'Budget check' })).toContainText(/Above the approved budget by ₹/, { timeout: 20_000 });
        await a11yBothWidths(page, 'Confirm tickets popup', { include: '[role="dialog"]', shotName: 'popup-over-budget' });
        await popup.getByRole('button', { name: 'Ask the Manager to approve' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select status as s from public.flight_fare_approvals where deal_id = $1 order by approval_no desc limit 1`, [pkg.dealId])).rows[0]?.s), { timeout: 30_000 }).toBe('pending');
        M = await signIn(browser, 'manager', secrets.manager);
        contexts.push(M.context);
        await M.page.goto('/app/approvals');
        const fares = M.page.getByRole('list', { name: 'Flight fares waiting for approval' }).getByRole('listitem').filter({ hasText: pkg.dealRef }).first();
        await expect(fares).toBeVisible();
        await a11yBothWidths(M.page, 'Manager Approvals', { shotName: 'manager-approvals' });
        await fares.getByRole('button', { name: 'Approve these fares' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select status as s from public.flight_fare_approvals where deal_id = $1 order by approval_no desc limit 1`, [pkg.dealId])).rows[0]?.s), { timeout: 30_000 }).toBe('approved');
        // The popup reopens with the approved fares; the ticket identifiers are typed again (not part of the approval).
        await page.goto(workspace(pkg.dealId));
        await page.getByRole('button', { name: /^Confirm with the approved fares/ }).click();
        const again = page.getByRole('dialog');
        await expect(again.getByLabel('Passenger', { exact: true })).toHaveCount(2);
        await fillLine(again, 0, 'Synthetic Traveller One', { crs: 'Amadeus', crsPnr: 'CRS123', pnr: PNR.toLowerCase(), ticket: TICKET_1 });
        await fillLine(again, 1, 'Synthetic Traveller Two', { crs: 'Amadeus', crsPnr: 'CRS123', pnr: PNR.toLowerCase(), ticket: TICKET_2 });
        // Wait for the live budget check to recognise the approval (the fare preview is asynchronous).
        await expect(again.getByRole('region', { name: 'Budget check' })).toContainText('The Manager approved these fares', { timeout: 20_000 });
        await again.getByRole('button', { name: 'Confirm tickets' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          'select count(*)::int as n from public.flight_ticket_batches where deal_id = $1', [pkg.dealId])).rows[0]!.n), { timeout: 30_000 }).toBe(1);
        const stored = await db(async (c) => (await c.query<{ p: string }>(
          `select distinct airline_pnr as p from public.flight_ticket_revisions where deal_id = $1`, [pkg.dealId])).rows.map((r) => r.p));
        check('5 · PNR stored upper case', stored.length === 1 && stored[0] === PNR, stored.join(','));
        await page.goto(workspace(pkg.dealId));
        await expect(page.getByRole('region', { name: `PNR ${PNR}` })).toBeVisible();
        await expect(page.locator('main')).not.toContainText(/AI AI 470/);
      });

      await stepRun('6 · record a direct payment with proof; Accounts A accepts', async () => {
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        const cost = page.getByRole('region', { name: 'Cost and payment' });
        const open = cost.getByRole('button', { name: 'Record direct payment' }).first();
        await dialogKeyboard(page, open, 'Direct payment drawer');
        await open.click();
        const drawer = page.getByRole('dialog');
        const mode = drawer.getByLabel('Paid by', { exact: true });
        await mode.selectOption({ index: await optionIndex(mode, 'Card') });
        const paidOn = drawer.getByLabel('Paid on', { exact: true });
        await paidOn.fill((await paidOn.getAttribute('type')) === 'date' ? istToday() : finDate(istToday()));
        await drawer.locator('input[type="file"]').setInputFiles(pdf('direct-payment-proof'));
        await drawer.getByRole('button', { name: 'Attach proof' }).click();
        const proof = drawer.getByLabel('Payment proof on file');
        await expect(proof).toBeVisible({ timeout: 30_000 });
        await proof.selectOption({ index: 1 });
        await a11yBothWidths(page, 'Direct payment drawer', { include: '[role="dialog"]', shotName: 'direct-payment' });
        await drawer.getByRole('button', { name: 'Record direct payment' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select expense_status as s from public.department_cost_entries where deal_id = $1 and department = 'flight' and flight_batch_id is not null`, [pkg.dealId])).rows[0]?.s),
        { timeout: 30_000 }).toBe('submitted');
        A = await signIn(browser, 'accA', secrets.accA);
        contexts.push(A.context);
        await A.page.goto('/app/accounts/expenses');
        const row = A.page.locator('article, tr, li').filter({ hasText: pkg.dealRef }).first();
        await expect(row).toContainText(/Flight/);
        await row.getByRole('button', { name: /^Accept/ }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select expense_status as s from public.department_cost_entries where deal_id = $1 and department = 'flight' and flight_batch_id is not null`, [pkg.dealId])).rows[0]?.s),
        { timeout: 30_000 }).toBe('accepted');
      });

      await stepRun('7 · Sales revises the booking: "Booking changed"; Flight applies; unchanged sector keeps its tickets', async () => {
        // SYNTHETIC FIXTURE STEP: the booking commands need the service-items switch (on only for these commands, as when seeding).
        const switchBefore = await db(async (c) => (await c.query<{ on: boolean }>('select service_items_enabled as on from public.workflow_settings where id')).rows[0]!.on);
        await db((c) => c.query('update public.workflow_settings set service_items_enabled = true where id'));
        try {
        await asUser(USERS.accA.id, 'select public.accounts_review_return($1, $2, $3) as r', [pkg.versionId, 'Synthetic: return flight changed', randomUUID()]);
        const opened = await asUser<{ versionId: string; rowVersion: number }>(USERS.sales.id, 'select public.booking_open_revision($1) as r', [pkg.versionId]);
        let rv = (await asUser<{ rowVersion: number }>(USERS.sales.id, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
          [pkg.flightItems[0], opened.versionId, opened.rowVersion, JSON.stringify({ ...ONWARD, segments: [ONWARD.segments[0], { ...ONWARD.segments[1], flightNo: 'AI 885', departTime: '15:10' }] }), BUDGET_PAISE])).rowVersion;
        rv = (await asUser<{ rowVersion: number }>(USERS.sales.id, 'select public.booking_classify_revision($1, $2, $3) as r', [opened.versionId, rv, 'customer_material'])).rowVersion;
        const proof = fakePdf();
        const ev = await asUser<{ evidenceId: string; objectPath: string }>(USERS.sales.id, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
          [opened.versionId, 'acceptance_message', 'acceptance-2.pdf', 'application/pdf', proof.byteLength, sha()]);
        await putObject('booking-evidence', ev.objectPath, proof, 'application/pdf');
        await asUser(USERS.sales.id, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
        const ready = await asUser<{ issues: string[]; contentHash: string }>(USERS.sales.id, 'select public.booking_readiness($1) as r', [opened.versionId]);
        await asUser(USERS.sales.id, 'select public.booking_confirm($1, $2) as r', [opened.versionId, ready.contentHash]);
        void rv;
        } finally {
          await db((c) => c.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchBefore]));
        }
        const before = await db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.flight_ticket_revisions r join public.flight_sectors s on s.id = r.sector_id where s.deal_id = $1 and s.flight_no = 'AI 470'`, [pkg.dealId])).rows[0]!.n);
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        await expect(page.getByText('Booking changed').first()).toBeVisible();
        // Both flights of the Deal follow the new version: apply on each flight that shows the change.
        const lagging = async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.flight_task_state st where st.deal_id = $1 and st.basis_version_id <> authz.task_current_version(st.task_id)`,
          [pkg.dealId])).rows[0]!.n);
        for (let i = 0; i < 3 && (await lagging()) > 0; i += 1) {
          const n = await lagging();
          await page.getByRole('button', { name: 'Apply the new booking' }).first().click();
          await expect.poll(lagging, { timeout: 30_000 }).toBeLessThan(n);
          await page.reload();
        }
        expect(await lagging()).toBe(0);
        const after = await db(async (c) => (await c.query<{ n: number; active: number }>(
          `select count(*)::int as n, count(*) filter (where s.status = 'active')::int as active from public.flight_ticket_revisions r
           join public.flight_sectors s on s.id = r.sector_id where s.deal_id = $1 and s.flight_no = 'AI 470'`, [pkg.dealId])).rows[0]!);
        check('7 · unchanged sector keeps tickets', after.n === before && after.active === before && before > 0, `before ${before}, after ${after.n} (${after.active} active)`);
      });

      await stepRun('8 · correct ticket, attach e-tickets, mark done; Deal page shows Done; e-ticket opens for the Sales owner; Deal History', async () => {
        const page = F.page;
        await page.goto(workspace(pkg.dealId));
        const correct = page.getByRole('button', { name: /^Correct ticket/ }).first();
        await dialogKeyboard(page, correct, 'Correct ticket dialog');
        await correct.click();
        const dlg = page.getByRole('dialog');
        await dlg.getByLabel('Ticket number', { exact: true }).fill(ticketNo(99));
        await dlg.getByLabel('Reason', { exact: true }).fill('Synthetic: the airline reissued the ticket');
        await dlg.getByRole('button', { name: 'Save correction' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          'select max(revision_no)::int as n from public.flight_ticket_revisions where deal_id = $1', [pkg.dealId])).rows[0]!.n), { timeout: 30_000 }).toBe(2);
        // SYNTHETIC FIXTURE STEP: the remaining pairs are confirmed and paid through the same database commands the popup
        // and drawers call (their screens were exercised in steps 5 and 6), so that "Mark flight done" can be pressed.
        await completeRemaining(pkg);
        // E-tickets.
        await page.goto(workspace(pkg.dealId));
        await page.locator('#eticket input[type="file"]').setInputFiles(pdf('e-ticket'));
        await page.getByRole('button', { name: 'Attach selected files' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.department_evidence where task_id = any($1::uuid[]) and kind = 'e_ticket' and status = 'stored'`, [pkg.flightTasks])).rows[0]!.n),
        { timeout: 30_000 }).toBeGreaterThan(0);
        await page.goto(workspace(pkg.dealId));
        const done = page.locator('main').getByRole('button', { name: 'Mark flight done' }).first();
        if ((await done.getAttribute('aria-disabled')) !== 'true') {
          await done.click();
          const confirmDialog = page.getByRole('dialog');
          // Lead UI review (5 Nov 2026): the dialog opens on Cancel.
          await expect(confirmDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
          await expect(confirmDialog).toContainText('Sales and Accounts see that the tickets are issued. Ticket details stay correctable with a reason.');
          await expect(confirmDialog).not.toContainText(/Sector \d/);
          await confirmDialog.getByRole('button', { name: 'Mark flight done' }).click();
          await expect(page.locator('main')).toContainText('Done · ticket issued', { timeout: 30_000 });
        } else {
          const why = await page.locator('main').innerText();
          check('8 · mark done available', false, `still blocked: ${why.slice(0, 300)}`);
        }
        await SO.page.goto(`/app/deals/${pkg.dealId}?tab=services`);
        await expect(SO.page.locator('main')).toContainText(/Done · ticket issued|In progress · \d+ of \d+ tickets|All tickets confirmed/);
        const link = SO.page.getByRole('link', { name: /e-ticket/i }).first();
        const href = await link.getAttribute('href');
        check('8 · e-ticket link for the Sales owner', Boolean(href && /\/app\/flight\/e-tickets\//.test(href)), String(href));
        if (href) {
          const res = await SO.page.request.get(href, { maxRedirects: 0 });
          check('8 · e-ticket opens for the Sales owner', [200, 302, 303, 307].includes(res.status()), `status ${res.status()}`);
          check('8 · e-ticket response is private', /private/.test(res.headers()['cache-control'] ?? ''), res.headers()['cache-control'] ?? 'none');
        }
        await SO.page.goto(`/app/deals/${pkg.dealId}?tab=history`);
        await expect(SO.page.locator('main')).toContainText(/Flight/);
        await expect(SO.page.locator('main')).not.toContainText(PNR);
      });

      await stepRun('9 · flight-only Deal: markup/discount, Save and apply, payment request above ₹50,000 -> Manager -> Accounts A records -> Accounts B verifies', async () => {
        const page = F.page;
        await page.goto(workspace(fo.dealId, 'details'));
        await page.getByRole('button', { name: 'Take these flights' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>(
          `select count(*)::int as n from public.fulfilment_tasks where deal_id = $1 and department = 'flight' and status = 'in_progress'`, [fo.dealId])).rows[0]!.n),
        { timeout: 30_000 }).toBe(1);
        await page.goto(workspace(fo.dealId));
        await page.getByRole('button', { name: /^Alternate .*AI 470/ }).first().click();
        await page.getByRole('group', { name: /^Travellers who move/ }).getByRole('checkbox', { name: /^Synthetic Traveller One/ }).check();
        await page.getByRole('group', { name: 'New flight details' }).getByLabel('Flight no.', { exact: true }).fill('AI 476');
        await page.getByLabel('Remark', { exact: true }).fill('Synthetic: earlier connection');
        await page.getByRole('button', { name: 'Save and apply' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string; k: string }>(
          `select status as s, decider_kind as k from public.flight_changes where deal_id = $1`, [fo.dealId])).rows[0]), { timeout: 30_000 })
          .toEqual({ s: 'approved', k: 'flight_owner' });
        await page.goto(workspace(fo.dealId));
        await page.getByRole('checkbox', { name: /^Select .*AI 476.* for Confirm tickets$/ }).first().check();
        await page.locator('main').getByRole('button', { name: /^Confirm tickets/ }).first().click();
        const popup = page.getByRole('dialog');
        const supplier = popup.getByLabel('Paid to (airline or consolidator)');
        await supplier.selectOption({ index: await optionIndex(supplier, `E2E Air Consolidator ${stamp}`) });
        await fillLine(popup, 0, 'Synthetic Traveller One', { crs: 'Airline direct', pnr: 'FOX123', ticket: ticketNo(500) });
        await expect(popup.getByLabel('CRS PNR', { exact: true })).toHaveCount(0);
        await fillFares(popup, { basic: (Number(FO_BASIC) / 100).toFixed(2), markup: (Number(MARKUP) / 100).toFixed(2), discount: (Number(DISCOUNT) / 100).toFixed(2) });
        await popup.getByRole('button', { name: 'Confirm tickets' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ n: number }>('select count(*)::int as n from public.flight_ticket_batches where deal_id = $1', [fo.dealId])).rows[0]!.n),
        { timeout: 30_000 }).toBe(1);
        await page.reload();
        // Contract 11.1: above ₹50,000 the direct payment is shown unavailable with the reason in words (soft: reported, the flow goes on).
        const direct = page.getByRole('region', { name: 'Cost and payment' }).getByRole('button', { name: 'Record direct payment' });
        await direct.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
        check('9 · direct payment shown unavailable above ₹50,000', (await direct.count()) > 0 && (await direct.first().getAttribute('aria-disabled')) === 'true',
          (await direct.count()) === 0 ? 'no "Record direct payment" control at all (only "Raise payment request")' : `aria-disabled=${await direct.first().getAttribute('aria-disabled')}`);
        await page.getByRole('region', { name: 'Cost and payment' }).getByRole('button', { name: 'Raise payment request' }).first().click();
        await expect(page.getByRole('dialog')).toContainText('Goes to the branch Manager (above ₹50,000 for this supplier on this Deal)');
        await page.getByRole('dialog').getByLabel('Pay by', { exact: true }).fill(istToday(7));
        await page.getByRole('dialog').getByRole('button', { name: 'Send payment request' }).click();
        const pay = async () => db(async (c) => (await c.query<{ id: string; status: string; route: string; ref_no: string }>(
          `select id, status, route, ref_no from public.supplier_payment_requests where deal_id = $1`, [fo.dealId])).rows[0]);
        await expect.poll(async () => (await pay())?.route, { timeout: 30_000 }).toBe('manager');
        await M.page.goto('/app/approvals');
        const ref = (await pay())!.ref_no;
        await M.page.locator('article').filter({ hasText: ref }).first().getByRole('button', { name: 'Approve payment' }).click();
        await expect.poll(async () => (await pay())?.status, { timeout: 30_000 }).toBe('approved');
        const fund = M.page.locator('article').filter({ hasText: ref }).filter({ has: M.page.getByRole('button', { name: 'Approve company funding' }) });
        await M.page.reload();
        // No customer money on this Deal: company funding above ₹50,000 goes to the branch Manager too.
        if (await fund.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
          await fund.first().getByRole('button', { name: 'Approve company funding' }).click();
          await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
            `select f.status as s from public.company_funding_requests f join public.supplier_payment_requests p on p.id = f.payment_request_id where p.ref_no = $1`, [ref])).rows[0]?.s),
          { timeout: 30_000 }).toBe('approved');
        }
        // The supplier's bank details must be approved before Accounts can record (SYNTHETIC FIXTURE STEP: Flight adds them, the Manager approves).
        const supplierRow = await db(async (c) => (await c.query<{ id: string }>('select supplier_id as id from public.flight_ticket_batches where deal_id = $1', [fo.dealId])).rows[0]!);
        const rev = await asUser<{ revisionNo: number }>(USERS.flight.id, 'select public.flight_supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierRow.id, randomUUID(),
          JSON.stringify({ accountHolder: 'E2E Air Consolidator', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000044445555' })]);
        await asUser(USERS.manager.id, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierRow.id, rev.revisionNo]);
        await A.page.goto('/app/accounts/funding');
        const fundA = A.page.locator('article').filter({ hasText: ref }).filter({ has: A.page.getByRole('button', { name: 'Approve company funding' }) });
        if (await fundA.first().isVisible().catch(() => false)) await fundA.first().getByRole('button', { name: 'Approve company funding' }).click();
        await A.page.goto('/app/accounts/supplier-payments?tab=to_record');
        const recRow = A.page.locator('article').filter({ hasText: ref }).first();
        await expect(recRow).toContainText(/Flight/);
        await recRow.getByText('Record the payment', { exact: true }).click();
        await recRow.getByLabel('Paid on', { exact: true }).fill(istToday());
        await recRow.getByLabel('Bank reference (UTR)', { exact: true }).fill(`UTRFF${stamp}`);
        await recRow.getByLabel('Payment proof', { exact: true }).setInputFiles(pdf('payment-proof'));
        await recRow.getByRole('button', { name: 'Record payment' }).click();
        await expect.poll(async () => (await pay())?.status, { timeout: 30_000 }).toBe('paid');
        const B = await signIn(browser, 'accB', secrets.accB);
        contexts.push(B.context);
        await B.page.goto('/app/accounts/supplier-payments?tab=to_verify');
        await B.page.locator('article').filter({ hasText: ref }).first().getByRole('button', { name: 'Mark payment verified' }).click();
        await expect.poll(async () => (await pay())?.status, { timeout: 30_000 }).toBe('verified');
      });

      await stepRun('10 · Purchase and Visa: no flight money in any HTML or network response', async () => {
        for (const key of ['purchase', 'visa'] as const) {
          const S = await signIn(browser, key, secrets[key]);
          contexts.push(S.context);
          recordResponses(S.page, fenceResponses);
          for (const path of ['/app', '/app/flight', workspace(pkg.dealId), workspace(fo.dealId), `/app/deals/${pkg.dealId}`, `/app/deals/${fo.dealId}`,
            '/app/purchase', '/app/visa']) {
            await S.page.goto(path);
            await S.page.waitForLoadState('networkidle');
            const found = leaksIn(await S.page.content());
            check(`10 · ${key} page ${path}`, found.length === 0, found.length ? found.join(', ') : 'clean');
          }
        }
        const bodies = await Promise.all(fenceResponses);
        const hits = bodies.flatMap((b) => leaksIn(b.body).map((l) => `${new URL(b.url).pathname}: ${l}`));
        const read = bodies.filter((b) => b.readable).length;
        check('10 · no flight money in Purchase/Visa network responses', hits.length === 0 && read >= 8,
          read < 8 ? `only ${read} responses readable` : hits.length ? [...new Set(hits)].slice(0, 10).join('; ') : `${read} readable responses clean`);
        // Positive control: the Flight assignee does see the fare, so the check above is meaningful.
        await F.page.goto(workspace(pkg.dealId));
        await F.page.waitForLoadState('networkidle');
        const flightHtml = await F.page.content();
        check('10 · positive control (Flight sees the fare)', moneyPatterns(BASIC).some((p) => p.test(flightHtml)), 'basic fare visible to the Flight assignee');
      });
    } finally {
      writeFileSync(join(shotDir, 'flight-flow-results.json'), JSON.stringify({ stamp, pkg: pkg?.dealRef, fo: fo?.dealRef, results }, null, 2));
      await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    }
  });
});
