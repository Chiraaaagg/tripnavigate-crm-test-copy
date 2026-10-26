import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Voice-note booking form batch (24 October 2026) against a REAL local
 * Supabase stack, served by the production build (playwright.real.config.ts).
 * The lead runs it on a disposable local stack; never against a hosted
 * database. Written by Terra; not run by the author (Atlas holds the stack).
 *
 * Covers what unit tests cannot: the count rule refused with typed counts
 * kept; passenger rows from the counts, saved only when named, no duplicate
 * after save and reload; a saved passenger is never removed by a save
 * without "Remove passenger"; standard requests save and reload; the ID
 * proof button is visible per row; a hotel saves without an adults box; the
 * flight passengers follow the selection and survive a reload; Bill To picks
 * a stored customer (snapshot with the reference kept); Add customer creates
 * a Not checked customer; Accounts checks one and returns one with a reason;
 * a customer CSV check shows the summary and changes nothing.
 *
 * Not covered here: Deal facts from Bitrix (the read switch starts off; its
 * database rules are in tests/db/vn-*.test.ts).
 *
 * Fixture steps (synthetic, local only): the Accounts journey entity and
 * users, a fresh run-tagged Deal header, one stored customer, the
 * service_items_enabled switch for the run (restored afterwards).
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the voice-note journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The voice-note journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const USERS = {
  a: { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test' },
  // Not used in the steps: the shared fixture's staff rows need every fixture user to exist (the spec must run alone too).
  b: { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test' },
  sales: { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test' },
} as const;
const shotDir = 'test-results/real-journey/voice-notes';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

let switchWasOn: boolean | null = null;

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the voice-note journey needs the 'test' deployment environment").toBe('test');
  });
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  for (const user of Object.values(USERS)) {
    const { error } = await admin.auth.admin.createUser({ id: user.id, email: user.email, password: fixturePassword!, email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`could not create ${user.email}: ${error.message}`);
  }
  await db(async (client) => {
    const { rows } = await client.query('select 1 from public.legal_entities where code = $1', [ENTITY_CODE]);
    if (rows.length === 0) {
      await client.query('begin');
      try {
        await client.query(readFileSync(fixtureFile, 'utf8'));
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
    const { rows: s } = await client.query<{ on: boolean }>('select service_items_enabled as "on" from public.workflow_settings where id');
    if (switchWasOn === null) switchWasOn = s[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'vn-journey.real.e2e.ts: switch on for the run', false);
       update public.workflow_settings set service_items_enabled = true where id`,
    );
  });
}

async function newDeal(reference: string, title: string): Promise<string> {
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
       select b.legal_entity_id, b.id, $1, $2, $3 from public.branches b
       where b.legal_entity_id = $4 and b.code = 'FBR' returning id`,
      [reference, title, USERS.sales.id, ENTITY_ID],
    );
    expect(rows, `synthetic deal ${reference}`).toHaveLength(1);
    return rows[0]!.id;
  });
}

/** One stored business customer, entity-wide, Not checked (synthetic; local stack only). */
async function storedCustomer(tag: string): Promise<string> {
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.customer_parties (legal_entity_id, branch_id, party_type, name, contact_person, phone, address_line1, city, state_code, postal_code,
         gst_status, gstin, check_status, created_by, updated_by)
       values ($1, null, 'business', $2, 'Synthetic Party Contact', '9876500091', '1 Synthetic Market', 'Jodhpur', '08', '342001',
         'registered', '08AAAAA0000A1Z5', 'not_checked', $3, $3) returning id`,
      [ENTITY_ID, `Synthetic Stored Traders ${tag}`, USERS.a.id],
    );
    return rows[0]!.id;
  });
}

async function signInAndEnrol(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/);
  return page;
}

test.describe('Voice-note booking form changes on a real local stack', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!configured || switchWasOn === null) return;
    await db(async (client) => {
      await client.query(`select set_config('tripnavigate.change_reason', 'vn-journey.real.e2e.ts: restore the switch after the run', false)`);
      await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
    });
  });

  test('counts, passenger slots, requests, hotel without adults, flight passengers, Bill To from a stored customer, Accounts check', async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(shotDir, { recursive: true });
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');
    const { dealId, partyId } = await test.step('fixture', async () => {
      await loadFixture(fixtureFile);
      return { dealId: await newDeal(`SYN-VN-${tag}`, 'Synthetic voice-note journey'), partyId: await storedCustomer(tag) };
    });
    const salesContext = await csp.track(browser, 'sales');
    const sales = await signInAndEnrol(salesContext, USERS.sales.email);
    const main = sales.locator('main');
    const steps = main.getByRole('navigation', { name: 'Booking steps' });
    const field = (name: string) => main.locator(`[name="${name}"]`).first();

    await test.step('start the booking form', async () => {
      await sales.goto(`/app/deals/${dealId}`);
      await sales.getByRole('button', { name: 'Start booking', exact: true }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
    });

    await test.step('a split larger than the total is refused; the typed counts stay', async () => {
      await field('contactName').fill('Synthetic VN Customer');
      await field('mobile').fill('9876500081');
      await field('destination').fill('Goa');
      await field('tripStart').fill('2026-12-10');
      await field('tripEnd').fill('2026-12-13');
      await field('tripScope').selectOption('domestic');
      await field('paxTotal').fill('5');
      await field('adults').fill('3');
      await field('children').fill('3');
      await field('infants').fill('0');
      await main.getByLabel('I confirmed the contact details with the customer').check();
      await main.getByRole('button', { name: 'Save customer details' }).click();
      await expect(main.getByText(/add up to 5/).first()).toBeVisible({ timeout: 30_000 });
      await expect(field('children')).toHaveValue('3');
      const saved = await db((c) => c.query<{ n: number | null }>('select adults_count as n from public.booking_versions where deal_id = $1 and status = $2', [dealId, 'draft']));
      expect(saved.rows[0]?.n ?? null).toBeNull();
    });

    await test.step('5 = 3 adults + 2 children saves and reloads; five passenger rows appear with their types', async () => {
      await field('children').fill('2');
      await main.getByRole('button', { name: 'Save customer details' }).click();
      await expect(main.getByRole('status').filter({ hasText: 'Customer details saved.' })).toBeVisible({ timeout: 30_000 });
      await sales.reload();
      await expect(field('adults')).toHaveValue('3');
      await expect(main.locator('[name="travellerName"]')).toHaveCount(5);
    });

    await test.step('only named rows are saved; a standard request saves; save + reload never duplicates', async () => {
      const names = main.locator('[name="travellerName"]');
      await names.nth(0).fill('Synthetic Adult One');
      await names.nth(1).fill('Synthetic Adult Two');
      await names.nth(3).fill('Synthetic Child One');
      await main.getByRole('button', { name: 'Save passengers' }).click();
      await expect(main.getByRole('status').filter({ hasText: 'Passengers saved.' })).toBeVisible({ timeout: 30_000 });
      // Standard requests and a child's age live in the passenger's Details drawer ("Save passenger" saves the row).
      const drawer = sales.getByRole('dialog', { name: 'Passenger details' });
      // The save refreshes the page; a refresh that lands while the drawer is open can close it, so each
      // drawer edit is retried as a whole (every action in it is safe to repeat).
      await expect(main).toContainText('All changes saved', { timeout: 30_000 });
      const inDrawer = async (row: number, edit: () => Promise<void>) =>
        expect(async () => {
          if (!(await drawer.isVisible())) await main.getByRole('button', { name: `Details for passenger ${row}` }).click();
          await expect(drawer).toBeVisible({ timeout: 5_000 });
          await edit();
          await drawer.getByRole('button', { name: 'Save passenger' }).click({ timeout: 5_000 });
          await expect(drawer).toBeHidden({ timeout: 15_000 });
        }).toPass({ timeout: 90_000 });
      await inDrawer(1, async () => {
        const box = drawer.getByRole('checkbox', { name: 'Vegetarian meals' });
        if (!(await box.isVisible())) await drawer.getByRole('button', { name: /Choose requests|Change/ }).first().click({ timeout: 5_000 });
        await box.check({ timeout: 5_000 });
      });
      await inDrawer(4, async () => {
        await drawer.getByLabel('Age at travel').fill('8', { timeout: 5_000 });
      });
      // Reopening twice never adds a person: the rows come from the counts, the saved ones keep their places.
      for (let i = 0; i < 2; i += 1) {
        await sales.reload();
        await expect(main.locator('[name="travellerName"]')).toHaveCount(5);
        await expect(names.nth(0)).toHaveValue('Synthetic Adult One');
        const n = await db((c) => c.query<{ n: string }>('select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId]));
        expect(n.rows[0]!.n).toBe('3');
      }
      const rows = await db((c) => c.query<{ full_name: string; traveller_type: string; special_requests: string[] }>('select full_name, traveller_type, special_requests from public.deal_travellers where deal_id = $1 order by seq', [dealId]));
      expect(rows.rows.map((r) => r.full_name)).toEqual(['Synthetic Adult One', 'Synthetic Adult Two', 'Synthetic Child One']);
      expect(rows.rows[0]!.special_requests).toEqual(['vegetarian_meals']);
      const age = await db((c) => c.query<{ age_years: number | null }>('select age_years from public.deal_travellers where deal_id = $1 and full_name = $2', [dealId, 'Synthetic Child One']));
      expect(age.rows[0]?.age_years).toBe(8);
      await sales.reload();
      await expect(main.locator('[name="travellerName"]')).toHaveCount(5);
    });

    await test.step('every named row shows Attach ID proof', async () => {
      await expect(main.getByRole('button', { name: /Attach ID proof for Synthetic Adult One/ })).toBeVisible();
      await expect(main.getByRole('button', { name: /Attach ID proof for Synthetic Child One/ })).toBeVisible();
    });

    await test.step('lowering adults below the named adults is refused; nobody is removed', async () => {
      await field('adults').fill('1');
      await field('paxTotal').fill('3');
      await main.getByRole('button', { name: 'Save customer details' }).click();
      await expect(main.getByText(/Nobody was removed/).first()).toBeVisible({ timeout: 30_000 });
      const n = await db((c) => c.query<{ n: string }>('select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId]));
      expect(n.rows[0]!.n).toBe('3');
      await sales.reload();
    });

    await test.step('a hotel saves without an adults box; it takes the booking adults', async () => {
      await steps.getByRole('button', { name: /Trip & services/ }).click();
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add stay', exact: true }).click();
      const d = sales.getByRole('dialog', { name: 'Add hotel stay' });
      // No adults box: the booking's adults ride as a hidden value and are shown as text.
      await expect(d.locator('input[name="adults"]:not([type="hidden"])')).toHaveCount(0);
      await expect(d.locator('#svc-adults')).toContainText('3');
      await expect(d.getByText('More details')).toHaveCount(0);
      await d.getByLabel('City').fill('Goa');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Beach Stay');
      await d.getByLabel('Check-in').fill('2026-12-10');
      await d.getByLabel('Nights').fill('3');
      await d.getByRole('button', { name: 'Save hotel' }).click();
      await expect(d).toBeHidden({ timeout: 30_000 });
      const facts = await db((c) =>
        c.query<{ adults: number }>(
          `select (f.facts ->> 'adults')::int as adults from public.service_item_facts f
           join public.booking_versions v on v.id = f.booking_version_id
           join public.service_items i on i.id = f.service_item_id
           where v.deal_id = $1 and v.status = 'draft' and i.service_type = 'hotel'`,
          [dealId],
        ),
      );
      expect(facts.rows[0]?.adults).toBe(3);
    });

    await test.step('flight passengers follow the selection and survive a reload', async () => {
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Flights/ }).click();
      await main.getByRole('button', { name: 'Add flight' }).first().click();
      const d = sales.getByRole('dialog', { name: 'Add flight' });
      await d.locator('[name="segmentFrom"]').first().fill('Jodhpur');
      await d.locator('[name="segmentTo"]').first().fill('Goa');
      await d.locator('[name="segmentDate"]').first().fill('2026-12-10');
      // Passengers flying: a toggle button opens a list of checkboxes (one per named passenger).
      await d.getByRole('button', { name: /Choose passengers/ }).click();
      await d.getByRole('checkbox', { name: /Synthetic Adult One/ }).check();
      await d.getByRole('checkbox', { name: /Synthetic Child One/ }).check();
      await d.getByRole('button', { name: /Save flight/ }).click();
      await expect(d).toBeHidden({ timeout: 30_000 });
      const seats = await db((c) =>
        c.query<{ passengers: number; picked: string }>(
          `select (f.facts ->> 'passengers')::int as passengers,
             (select string_agg(p.traveller_seq::text, ',' order by p.traveller_seq) from public.service_item_travellers p where p.service_item_id = f.service_item_id and p.booking_version_id = f.booking_version_id) as picked
           from public.service_item_facts f
           join public.booking_versions v on v.id = f.booking_version_id
           join public.service_items i on i.id = f.service_item_id
           where v.deal_id = $1 and v.status = 'draft' and i.service_type = 'flight'`,
          [dealId],
        ),
      );
      expect(seats.rows[0]).toEqual({ passengers: 2, picked: '1,3' });
      await sales.reload();
      // After a reload the saved choice comes back in the flight editor.
      await main.getByRole('button', { name: /^Edit flight/ }).first().click();
      const again = sales.getByRole('dialog', { name: 'Edit flight' });
      await expect(again.locator('#svc-who-hint')).toHaveText('2 of 3 passengers fly.');
      await expect(again).toContainText('Synthetic Adult One');
      await expect(again).toContainText('Synthetic Child One');
      await again.getByRole('button', { name: 'Cancel' }).click();
      await expect(again).toBeHidden();
    });

    await test.step('Bill To: search first, pick the stored customer; the billing keeps a snapshot and the reference', async () => {
      await steps.getByRole('button', { name: /Price & Bill To/ }).click();
      const bill = main.locator('section#billTo');
      await bill.getByRole('combobox').first().fill('Synthetic Stored');
      await sales.getByRole('option', { name: new RegExp(`Synthetic Stored Traders ${tag}`) }).click();
      await bill.getByRole('button', { name: 'Save Bill To' }).click();
      await expect(bill.getByRole('status').filter({ hasText: 'Bill To saved. Accounts checks it before use.' })).toBeVisible({ timeout: 30_000 });
      const snap = await db((c) => c.query<{ party_id: string; billing_name: string }>('select party_id, billing_name from public.customer_billing_profiles where deal_id = $1', [dealId]));
      expect(snap.rows[0]).toEqual({ party_id: partyId, billing_name: `Synthetic Stored Traders ${tag}` });
      await sales.screenshot({ path: `${shotDir}/bill-to-picked.png`, fullPage: true });
    });

    await test.step('Add customer (Personal) creates a Not checked customer', async () => {
      const bill = main.locator('section#billTo');
      await bill.getByRole('button', { name: /^Add customer/ }).first().click();
      const d = sales.getByRole('dialog', { name: /Add customer/ });
      await d.getByRole('group', { name: 'Customer type' }).getByRole('button', { name: 'Personal' }).click();
      await d.locator('[name="name"]').fill(`Synthetic Added Person ${tag}`);
      await d.locator('[name="phone"]').fill('9876500092');
      await d.locator('[name="addressLine1"]').fill('2 Synthetic Lane');
      await d.locator('[name="city"]').fill('Delhi');
      await d.locator('[name="stateCode"]').selectOption('07');
      await d.locator('[name="postalCode"]').fill('110001');
      await d.getByRole('button', { name: 'Save customer' }).click();
      await expect(d).toBeHidden({ timeout: 30_000 });
      const added = await db((c) => c.query<{ check_status: string }>('select check_status from public.customer_parties where name = $1', [`Synthetic Added Person ${tag}`]));
      expect(added.rows[0]?.check_status).toBe('not_checked');
    });

    await test.step('Sales cannot open the Accounts customer check or its documents (not found, nothing shown)', async () => {
      await sales.goto(`/app/accounts/customers/${partyId}`);
      await expect(sales.getByText('Page not found')).toBeVisible({ timeout: 30_000 });
      await expect(sales.getByText(/Synthetic Party Contact/)).toHaveCount(0);
      await expect(sales.getByRole('button', { name: 'Mark as checked' })).toHaveCount(0);
      const file = await sales.request.get(`/app/accounts/customers/${partyId}/files/00000000-0000-4000-8000-000000000000`, { maxRedirects: 0 });
      expect(file.status()).toBe(404);
    });

    const accountsContext = await csp.track(browser, 'accounts');
    const accounts = await signInAndEnrol(accountsContext, USERS.a.email);
    await test.step('Accounts checks the stored customer and returns the added one with a reason', async () => {
      await accounts.goto('/app/accounts/customers');
      await expect(accounts.getByText(`Synthetic Stored Traders ${tag}`)).toBeVisible({ timeout: 30_000 });
      await accounts.goto(`/app/accounts/customers/${partyId}`);
      await accounts.getByRole('button', { name: 'Mark as checked' }).click();
      await expect(accounts.getByRole('status').filter({ hasText: 'Customer checked.' })).toBeVisible({ timeout: 30_000 });
      const added = await db((c) => c.query<{ id: string }>('select id from public.customer_parties where name = $1', [`Synthetic Added Person ${tag}`]));
      await accounts.goto(`/app/accounts/customers/${added.rows[0]!.id}`);
      await accounts.getByRole('button', { name: 'Return with reason' }).click();
      const back = accounts.getByRole('dialog');
      await back.locator('[name="reason"]').fill('Address PIN does not match the city');
      await back.getByRole('button', { name: 'Return to Sales' }).click();
      // The screen then shows the "Returned to Sales" note with the reason.
      await expect(accounts.locator('main')).toContainText('Returned to Sales', { timeout: 30_000 });
      await expect(accounts.locator('main')).toContainText('Address PIN does not match the city');
      const states = await db((c) => c.query<{ check_status: string }>('select check_status from public.customer_parties where id = any($1::uuid[]) order by check_status', [[partyId, added.rows[0]!.id]]));
      expect(states.rows.map((r) => r.check_status)).toEqual(['checked', 'returned']);
    });

    await test.step('customer CSV: the check shows a summary and changes nothing', async () => {
      const before = await db((c) => c.query<{ n: string }>('select count(*)::text as n from public.customer_parties where legal_entity_id = $1', [ENTITY_ID]));
      await accounts.goto('/app/admin/imports?kind=customer');
      const sample = join(testInfo.project.testDir, '..', 'fixtures', 'imports', 'customers-sample.csv');
      await accounts.locator('input[type="file"][name="file"]').setInputFiles(sample);
      await accounts.getByRole('button', { name: /Check file/ }).click();
      // The result card: checked, not applied (nothing is imported until "Import" with a reason).
      await expect(accounts.getByText('2. Check result')).toBeVisible({ timeout: 60_000 });
      await expect(accounts.getByText('Checked, not applied').first()).toBeVisible();
      await expect(accounts.getByText(/GSTIN first two digits do not match the state/).first()).toBeVisible();
      const after = await db((c) => c.query<{ n: string }>('select count(*)::text as n from public.customer_parties where legal_entity_id = $1', [ENTITY_ID]));
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      await accounts.screenshot({ path: `${shotDir}/import-summary.png`, fullPage: true });
    });

    expect(csp.violations, 'no CSP violations').toEqual([]);
  });
});
