import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Direction A Batch 2 browser journey: automatic fill from Bitrix on "Start
 * booking" (migration 20261122000100, contracts A + F, lead ruling D1),
 * against a REAL local Supabase stack served by the production build
 * (playwright.real.config.ts, project real-journey). Never against a hosted
 * database.
 *
 * Two synthetic Bitrix-shaped Deals at "Won - Payment Received", each with a
 * stored Bitrix snapshot (trip dates, a Contact with mobile and e-mail):
 *   1. Switch prefill_auto_fill OFF: "Start booking" leaves the fields empty
 *      and today's "From Bitrix" panel offers "Use Bitrix value" (manual path).
 *   2. Switch ON: "Start booking" shows the Bitrix contact and dates already in
 *      the fields with a "From Bitrix" marker; the contact check and billing
 *      stay empty. Staff clear the e-mail and save; a reload and a page read
 *      never refill it. A later Bitrix change shows "Bitrix now says … Use it ·
 *      Keep mine"; "Keep mine" hides it and keeps the staff value.
 *
 * Fixture steps (synthetic, local only): the Accounts-journey entity and
 * Sales user, the two Deals and their snapshots as the Bitrix sync stores
 * them, and the switches for the run (service_items_enabled, the Bitrix read
 * switch, prefill_auto_fill, the local real-Deal booking gate) changed with a
 * recorded reason through the audited settings tables, each restored after
 * the run. Skips without a real stack; fails (never skips) when
 * REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the Batch 2 automatic-fill journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Batch 2 automatic-fill journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_CODE = 'FBR';
const PORTAL = 'SYNTHETIC_MEMBER_0001';
const SYNTHETIC_INTAKE_CONFIG = 'c0000000-0000-4000-8000-000000000001';
const SALES = { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test' } as const;
const BITRIX = { contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', email: 'bitrix.contact@example.test', start: '2026-12-10', end: '2026-12-14', laterStart: '2026-12-11' } as const;
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

type Saved = { serviceItems: boolean; autoFill: boolean; readSwitch: boolean; realBooking: boolean };
let saved: Saved | null = null;

const REASON = (what: string) => `b2-autofill.real.e2e.ts: ${what}`;

/** Switches change through the audited settings tables with a recorded reason (the settings audit triggers keep who, why, before and after). */
async function setSwitches(s: Saved, why: string) {
  await db(async (client) => {
    await client.query(`select set_config('tripnavigate.change_reason', $1, false)`, [REASON(why)]);
    await client.query('update public.workflow_settings set service_items_enabled = $1, prefill_auto_fill = $2 where id', [s.serviceItems, s.autoFill]);
    await client.query('update public.integration_intake_config set bitrix_trip_facts_read = $2 where id = $1', [SYNTHETIC_INTAKE_CONFIG, s.readSwitch]);
    await client.query('update public.booking_settings set real_booking_enabled = $1 where id', [s.realBooking]);
  });
}

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the Batch 2 journey needs the 'test' deployment environment").toBe('test');
  });
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const { error } = await admin.auth.admin.createUser({ id: SALES.id, email: SALES.email, password: fixturePassword!, email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(`could not create ${SALES.email}: ${error.message}`);
  await db(async (client) => {
    const { rows } = await client.query('select 1 from public.legal_entities where code = $1', [ENTITY_CODE]);
    if (rows.length === 0) {
      await client.query('begin');
      try {
        await client.query(readFileSync(fixtureFile, 'utf8'));
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
    await client.query('delete from auth.mfa_factors where user_id = $1', [SALES.id]);
    const { rows: w } = await client.query<{ s: boolean; a: boolean }>('select service_items_enabled as s, prefill_auto_fill as a from public.workflow_settings where id');
    const { rows: r } = await client.query<{ on: boolean }>('select bitrix_trip_facts_read as "on" from public.integration_intake_config where id = $1', [SYNTHETIC_INTAKE_CONFIG]);
    const { rows: b } = await client.query<{ on: boolean }>('select real_booking_enabled as "on" from public.booking_settings where id');
    saved = { serviceItems: w[0]!.s, autoFill: w[0]!.a, readSwitch: r[0]!.on, realBooking: b[0]!.on };
  });
}

/** Bitrix stand-in: a Deal at "Won - Payment Received" and its stored snapshot (trip dates, a Contact with mobile and e-mail). */
async function bitrixDealWithSnapshot(sourceDealId: number, contactId: number, title: string): Promise<string> {
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const recorded = await admin.rpc('integration_record_bitrix_event', { p_member_id: PORTAL, p_event_type: 'ONCRMDEALADD', p_deal_id: sourceDealId, p_source_ts: Math.floor(Date.now() / 1000) });
  if (recorded.error) throw new Error(`inbox: ${recorded.error.message}`);
  const inboxId = (recorded.data as { inboxId: string }).inboxId;
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
         source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at, source_modified_at,
         last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
       select b.legal_entity_id, b.id, 'BX-' || $1::bigint, $2, $3, false,
         'bitrix', $4, $1, 'UC_AD0SLH', 0, now(), now(), now(), now(), $5, 9001
       from public.branches b where b.legal_entity_id = $6 and b.code = $7 returning id`,
      [sourceDealId, title, SALES.id, PORTAL, inboxId, ENTITY_ID, BRANCH_CODE],
    );
    const dealId = rows[0]!.id;
    await client.query(
      `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end, source_contact_id, source_modified_at)
       select d.id, d.legal_entity_id, null, 2, $2::date, $3::date, $4, now() - interval '2 days' from public.deals d where d.id = $1`,
      [dealId, BITRIX.start, BITRIX.end, contactId],
    );
    await client.query(
      `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
       values ($1, $2, 'contact', $3, $4, array[$5]::text[], array[$6]::text[])
       on conflict (source_portal, party_kind, source_party_id) do update set display_name = excluded.display_name, phones = excluded.phones, emails = excluded.emails`,
      [ENTITY_ID, PORTAL, contactId, BITRIX.contactName, `+91 ${BITRIX.mobile}`, BITRIX.email],
    );
    return dealId;
  });
}

async function signInAndEnrol(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, SALES.email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/);
  return page;
}

// Fields by their input ids (booking form BOOKING_FORM_FIELD_ID; the "From Bitrix" marker sits beside each label).
const contactName = (p: Page) => p.locator('#bf-contact-name');
const mobile = (p: Page) => p.locator('#bf-contact-mobile');
const email = (p: Page) => p.locator('#bf-contact-email');
const tripStart = (p: Page) => p.locator('#bf-trip-start');
const contactTick = (p: Page) => p.getByLabel('I confirmed the contact details with the customer');
// Owner ruling (22 Oct 2026): passive markers only; never a per-value ask.
const perValueAsk = (p: Page) => p.getByRole('button', { name: /^(Use Bitrix value|Use it|Keep mine)/ });

async function startBooking(page: Page, dealId: string) {
  await page.goto(`/app/deals/${dealId}`);
  await page.getByRole('button', { name: 'Start booking' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
}

test.describe('Batch 2 automatic fill from Bitrix (real local stack)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!configured || !saved) return;
    await setSwitches(saved, 'restore the switches after the run');
  });

  test('switch off: manual path; switch on: filled once, marked, never refilled; a later Bitrix change never overwrites and never asks', async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const base = 760_000_000 + Number(tag.slice(-6)) * 10;
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');

    const [offDeal, onDeal] = await test.step('fixture: entity, Sales user, two Bitrix Deals with a snapshot; switches off', async () => {
      await loadFixture(fixtureFile);
      await setSwitches({ serviceItems: true, autoFill: false, readSwitch: true, realBooking: true }, 'automatic fill off for the first deal');
      return Promise.all([bitrixDealWithSnapshot(base + 1, base + 2, `Synthetic fill-off trip ${tag}`), bitrixDealWithSnapshot(base + 3, base + 4, `Synthetic fill-on trip ${tag}`)]);
    });

    const sales = await signInAndEnrol(await csp.track(browser, 'sales'));

    await test.step('switch off: Start booking leaves the fields empty; no Bitrix buttons, one quiet line', async () => {
      await startBooking(sales, offDeal);
      await expect(contactName(sales)).toHaveValue('');
      await expect(mobile(sales)).toHaveValue('');
      await expect(perValueAsk(sales)).toHaveCount(0);
      // Book now v2 (change 15): the marker is a small "From Bitrix" tag inside the label; none when the switch is off.
      await expect(sales.locator('section#customer')).not.toContainText('From Bitrix');
      await expect(contactTick(sales)).not.toBeChecked();
    });

    await test.step('switch on (audited, with a reason): Start booking shows the Bitrix values in the fields, marked', async () => {
      await setSwitches({ serviceItems: true, autoFill: true, readSwitch: true, realBooking: true }, 'automatic fill on for the second deal');
      await startBooking(sales, onDeal);
      await expect(contactName(sales)).toHaveValue(BITRIX.contactName);
      await expect(mobile(sales)).toHaveValue(BITRIX.mobile);
      await expect(email(sales)).toHaveValue(BITRIX.email);
      for (const id of ['bf-contact-name', 'bf-contact-mobile', 'bf-contact-email']) await expect(sales.locator(`label[for="${id}"]`)).toContainText('From Bitrix');
      await expect(perValueAsk(sales)).toHaveCount(0);
      await expect(sales.getByRole('button', { name: 'Fill empty fields from Bitrix' })).toHaveCount(0);
      await expect(sales.locator('main')).not.toContainText('Details are entered by hand.');
      // Never filled: the contact check, Bill To (Accounts checks it).
      await expect(contactTick(sales)).not.toBeChecked();
      await expect(sales.locator('section#billTo')).not.toContainText(BITRIX.contactName);
    });

    await test.step('staff clear the e-mail and save; reloads never refill it', async () => {
      await email(sales).fill('');
      // Book now v2 (change 2, ruling D1): the card saves itself once every check passes, so the trip
      // values the Deal does not give and the contact tick are filled first (changing the e-mail asks again).
      await sales.getByLabel('Destination', { exact: true }).fill('Synthetic Kerala');
      await sales.getByLabel('Trip', { exact: true }).selectOption('domestic');
      await sales.getByRole('spinbutton', { name: 'Adults' }).fill('2');
      await contactTick(sales).check();
      await expect(sales.locator('#pill-customer')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      await expect.poll(() => db(async (client) => (await client.query<{ email: string | null }>(
        `select c.email from public.booking_version_contacts c join public.booking_versions v on v.id = c.booking_version_id where v.deal_id = $1`, [onDeal])).rows.map((r) => r.email ?? 'cleared').join(',')), { timeout: 30_000 }).toBe('cleared');
      for (let i = 0; i < 2; i += 1) {
        await sales.reload();
        await expect(email(sales)).toHaveValue('');
        await expect(contactName(sales)).toHaveValue(BITRIX.contactName);
      }
    });

    await test.step('a later Bitrix change never overwrites what the booking holds and never asks per value', async () => {
      await db((client) =>
        client.query(`update public.deal_source_trip_facts set tour_start = $2::date, source_modified_at = now() where deal_id = $1`, [onDeal, BITRIX.laterStart]),
      );
      await sales.goto(`/app/deals/${onDeal}/book/travellers`);
      await expect(tripStart(sales)).toHaveValue(BITRIX.start);
      await expect(perValueAsk(sales)).toHaveCount(0);
      await sales.reload();
      await expect(tripStart(sales)).toHaveValue(BITRIX.start);
    });

    await test.step('the database agrees: one creation fill, the e-mail cleared by staff, nothing re-armed', async () => {
      const facts = await db(async (client) => {
        const { rows: runs } = await client.query<{ n: string }>(
          `select count(*)::text as n from public.audit_events where action = 'booking.prefill_auto_filled' and details->>'dealId' = $1::text`,
          [onDeal],
        );
        const { rows: c } = await client.query<{ email: string | null; contact_confirmed: boolean }>(
          `select c.email, c.contact_confirmed from public.booking_version_contacts c join public.booking_versions v on v.id = c.booking_version_id where v.deal_id = $1`,
          [onDeal],
        );
        const { rows: offRuns } = await client.query<{ n: string }>(
          `select count(*)::text as n from public.audit_events where action = 'booking.prefill_auto_filled' and details->>'dealId' = $1::text`,
          [offDeal],
        );
        return { runs: runs[0]!.n, email: c[0]?.email ?? null, confirmed: c[0]?.contact_confirmed, offRuns: offRuns[0]!.n };
      });
      // Book now v2 (D1): the card is saved only with the contact tick, so the stored contact is confirmed.
      expect(facts).toEqual({ runs: '1', email: null, confirmed: true, offRuns: '0' });
    });

    expect(csp.violations).toEqual([]);
  });
});
