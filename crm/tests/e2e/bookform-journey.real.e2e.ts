import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Booking form (owner-approved preview, 22 October 2026; Book now v2 of 26
 * October 2026: cards save themselves, fare per person, screenshot flights) against a REAL local
 * Supabase stack, served by the production build (playwright.real.config.ts).
 * The lead runs it; never against a hosted database. Covers what the gallery
 * cannot: unsaved entries surviving step moves, save and reload of every new
 * field (party, per-person prices in whole paise, supplier estimates, Bill To
 * business without GST), deliberate clearing, hotel night coverage from the
 * server, a private flight screenshot, and a refused save keeping typed input.
 * Submission and the Accounts hand-off are in b11-journey.real.e2e.ts.
 *
 * Fixture steps (synthetic, local only): the Accounts journey entity and
 * users, a fresh run-tagged Deal header, the service_items_enabled switch for
 * the run (restored afterwards). Read-only checks use the local owner
 * connection. Skips without a real stack; fails when REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the booking form journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The booking form journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const USERS = {
  a: { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test', name: 'Synthetic Accounts Finance A' },
  b: { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test', name: 'Synthetic Accounts Finance B' },
  sales: { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test', name: 'Synthetic Sales Finance' },
} as const;
const shotDir = 'test-results/real-journey/bookform';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

let switchWasOn: boolean | null = null;

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the booking form journey needs the 'test' deployment environment").toBe('test');
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
    // Two tests load the fixture: keep the value from before the first one, so afterAll restores it.
    if (switchWasOn === null) switchWasOn = s[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'bookform-journey.real.e2e.ts: switch on for the run', false);
       update public.workflow_settings set service_items_enabled = true where id`,
    );
  });
}

/** A fresh synthetic Deal (header only: no booking fact is written here). */
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

async function signInAndEnrol(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/);
  return page;
}


const syntheticPdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);

test.describe('Booking form on a real local stack', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!configured || switchWasOn === null) return;
    await db(async (client) => {
      await client.query(`select set_config('tripnavigate.change_reason', 'bookform-journey.real.e2e.ts: restore the switch after the run', false)`);
      await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
    });
  });

  test('unsaved entries survive step moves; every new field saves and reloads; coverage, screenshot, Bill To and prices', async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(shotDir, { recursive: true });
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const ref = `SYN-BF-${tag}`;
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');
    const dealId = await test.step('fixture', async () => {
      await loadFixture(fixtureFile);
      return newDeal(ref, 'Synthetic booking form journey');
    });
    const salesContext = await csp.track(browser, 'sales');
    const sales = await signInAndEnrol(salesContext, USERS.sales.email);
    const main = sales.locator('main');
    const steps = main.getByRole('navigation', { name: 'Booking steps' });

    await test.step('start the booking form', async () => {
      await sales.goto(`/app/deals/${dealId}`);
      await sales.getByRole('button', { name: 'Start booking', exact: true }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
    });

    // Book now v2 (owner-approved prototype, 26 October 2026): every card saves itself about 700 ms after
    // the typing stops, and only once all its checks pass (ruling D1); its pill says Saving…, Saved or
    // "Not saved · needs a fix". The draft's stored values are read back from the database here.
    const draftRow = () =>
      db(async (client) => {
        const { rows } = await client.query<{ destination: string | null; pax: number | null; adults: number | null; children: number | null; infants: number | null; email: string | null; phone: string | null }>(
          `select v.trip_destination as destination, v.pax_total as pax, v.adults_count as adults, v.children_count as children, v.infants_count as infants,
             c.email, c.mobile as phone
           from public.booking_versions v left join public.booking_version_contacts c on c.booking_version_id = v.id
           where v.deal_id = $1 and v.status = 'draft'`,
          [dealId],
        );
        return rows[0] ?? null;
      });
    const customerPill = sales.locator('#pill-customer');

    await test.step('typed values survive a move to step 3 and back; an incomplete card is not saved (D1)', async () => {
      await main.getByLabel('Name', { exact: true }).fill('Synthetic Form Customer');
      await main.getByLabel('Phone', { exact: true }).first().fill('9876500077');
      await main.getByLabel('Email', { exact: true }).first().fill('form.customer@example.test');
      await main.getByLabel('Destination', { exact: true }).fill('Udaipur');
      await main.getByLabel('Travel date').fill('2026-12-01');
      await main.getByLabel('Return date').fill('2026-12-07');
      await main.getByRole('spinbutton', { name: 'Adults' }).fill('2');
      await main.getByRole('spinbutton', { name: 'Children' }).fill('1');
      await main.getByRole('spinbutton', { name: 'Infants' }).fill('1');
      await main.getByLabel('Trip', { exact: true }).selectOption('domestic');
      await expect(main.locator('#bf-pax-total')).toContainText('Total: 4.');
      // The contact tick is still missing: nothing is saved yet.
      await expect(customerPill).toHaveAttribute('data-state', 'fix', { timeout: 30_000 });
      await expect(main).toContainText('Check the mobile or email with the customer, then tick the box.');
      await steps.getByRole('button', { name: /Price & Bill To/ }).click();
      await expect(sales).toHaveURL(/\/book\/finish$/);
      await steps.getByRole('button', { name: /Customer & passengers/ }).click();
      await expect(main.getByLabel('Destination', { exact: true })).toHaveValue('Udaipur');
      await expect(main.getByRole('spinbutton', { name: 'Adults' })).toHaveValue('2');
      expect((await draftRow())?.destination ?? null).toBeNull();
    });

    await test.step('the tick saves the card; reload brings it back; a deliberately cleared email stays empty', async () => {
      await main.getByLabel('I confirmed the contact details with the customer').check();
      await expect(customerPill).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      await expect.poll(async () => JSON.stringify(await draftRow()), { timeout: 30_000 }).toContain('"destination":"Udaipur","pax":4,"adults":2,"children":1,"infants":1');
      await sales.reload();
      await expect(main.getByRole('spinbutton', { name: 'Adults' })).toHaveValue('2');
      await expect(main.getByRole('spinbutton', { name: 'Children' })).toHaveValue('1');
      await expect(main.getByLabel('Return date')).toHaveValue('2026-12-07');
      await main.getByLabel('Email', { exact: true }).first().fill('');
      // Changing the phone or email asks for the tick again.
      await expect(main.getByLabel('I confirmed the contact details with the customer')).not.toBeChecked();
      await main.getByLabel('I confirmed the contact details with the customer').check();
      await expect.poll(async () => (await draftRow())?.email ?? 'cleared', { timeout: 30_000 }).toBe('cleared');
      await sales.reload();
      await expect(main.getByLabel('Email', { exact: true }).first()).toHaveValue('');
    });

    await test.step('a wrong phone is not saved and stays as typed; the corrected one saves', async () => {
      await main.getByLabel('Phone', { exact: true }).first().fill('12345');
      await expect(customerPill).toHaveAttribute('data-state', 'fix', { timeout: 30_000 });
      await expect(main).toContainText('Mobile number: 10 digits starting with 6 to 9.');
      await expect(main.getByLabel('Phone', { exact: true }).first()).toHaveValue('12345');
      expect((await draftRow())?.phone).toBe('9876500077');
      await main.getByLabel('Phone', { exact: true }).first().fill('9876500078');
      await main.getByLabel('I confirmed the contact details with the customer').check();
      await expect.poll(async () => (await draftRow())?.phone, { timeout: 30_000 }).toBe('9876500078');
      await expect(customerPill).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
    });

    await test.step('passengers: one row per counted traveller; named rows save themselves', async () => {
      const names = ['Synthetic Form Adult One', 'Synthetic Form Adult Two', 'Synthetic Form Child', 'Synthetic Form Infant'];
      for (const [i, name] of names.entries()) await main.getByLabel(`Passenger ${i + 1} full name`).fill(name);
      await expect(main.locator('#bf-pax-named')).toHaveText('4 of 4 named');
      await expect.poll(async () => db(async (client) => (await client.query<{ n: string }>('select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId])).rows[0]!.n), { timeout: 30_000 }).toBe('4');
      await expect(sales.locator('#pill-passengers')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
    });

    await test.step('step 2: two stays leave one night uncovered; a third stay covers it (an unsaved step-1 value is typed first)', async () => {
      // Echo B-H2: type on step 1; the hotel saves below must not wipe it (the card saves it itself).
      await main.getByLabel('Destination', { exact: true }).fill('Udaipur and Kumbhalgarh');
      await steps.getByRole('button', { name: /Trip & services/ }).click();
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      const addStay = async (checkIn: string, nights: string, hotel: string, rate: string) => {
        await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
        const d = sales.getByRole('dialog', { name: 'Add hotel stay' });
        await d.getByLabel('City').fill('Udaipur');
        await d.getByLabel('Hotel', { exact: true }).fill(hotel);
        await d.getByLabel('Check-in').fill(checkIn);
        await d.getByLabel('Nights').fill(nights);
        await d.getByLabel('Rooms: our cost per night').fill(rate);
        await d.getByRole('button', { name: 'Save hotel' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
      };
      await addStay('2026-12-01', '3', 'Synthetic Lake Hotel', '10000');
      await addStay('2026-12-05', '2', 'Synthetic Hill Hotel', '8000.50');
      await expect(main.getByRole('status').filter({ hasText: /trip nights/ })).toContainText(/5 \/ 6 trip nights have a hotel ·\s*1 missing/, { timeout: 30_000 });
      await addStay('2026-12-04', '1', 'Synthetic Fort Hotel', '9000');
      await expect(main.getByRole('status').filter({ hasText: /trip nights/ })).toContainText('6 / 6 trip nights have a hotel', { timeout: 30_000 });
      await expect(main).toContainText('₹30,000');
      await expect(main).toContainText('₹16,001');
    });

    await test.step('after the hotel saves, the step-1 value is still there and stored; the footer moves on', async () => {
      await steps.getByRole('button', { name: /Customer & passengers/ }).click();
      await expect(main.getByLabel('Destination', { exact: true })).toHaveValue('Udaipur and Kumbhalgarh');
      await expect.poll(async () => (await draftRow())?.destination, { timeout: 30_000 }).toBe('Udaipur and Kumbhalgarh');
      await expect(main).toContainText('All changes saved', { timeout: 30_000 });
      // Echo B-H1: a second save of the same card, without a reload, is not refused as a replay.
      await main.getByLabel('Name', { exact: true }).fill('Synthetic Form Customer Two');
      await expect(customerPill).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      await expect.poll(() => db(async (client) => (await client.query<{ n: string }>(
        `select c.contact_name as n from public.booking_version_contacts c join public.booking_versions v on v.id = c.booking_version_id where v.deal_id = $1 and v.status = 'draft'`, [dealId])).rows[0]?.n), { timeout: 30_000 }).toBe('Synthetic Form Customer Two');
      await main.getByRole('button', { name: 'Go to step 2' }).click();
      await expect(sales).toHaveURL(/\/book\/stay$/, { timeout: 30_000 });
    });

    await test.step('step 2: a car for the whole trip with an estimate; a typed flight with a fare per person; a flight from a private screenshot', async () => {
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Cars/ }).click();
      await main.getByRole('button', { name: 'Add car', exact: true }).click();
      const car = sales.getByRole('dialog', { name: 'Add car' });
      await car.getByRole('radio', { name: 'Full trip' }).click();
      await car.getByLabel('Vehicle', { exact: true }).selectOption('Innova');
      await car.getByLabel('Number of vehicles').fill('2');
      await car.getByLabel(/Rate per vehicle/).fill('25000');
      await car.getByLabel('Route', { exact: true }).fill('Udaipur sightseeing');
      await car.getByLabel('Tour start').fill('2026-12-01');
      await car.getByLabel('Tour end').fill('2026-12-07');
      await car.getByRole('button', { name: 'Save car' }).click();
      await expect(car).toBeHidden({ timeout: 30_000 });
      await expect(main.getByRole('region', { name: /^Cars/ })).toContainText('₹50,000', { timeout: 30_000 });

      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Flights/ }).click();
      await main.getByRole('button', { name: 'Add flight', exact: true }).click();
      const flight = sales.getByRole('dialog', { name: 'Add flight' });
      await flight.locator('#ap-from').fill('DEL');
      await flight.locator('#ap-from').press('Enter');
      await flight.locator('#ap-to').fill('UDR');
      await flight.locator('#ap-to').press('Enter');
      await flight.getByLabel(/^Arrival date/).fill('2026-12-01');
      await flight.getByLabel(/^Airline/).fill('Synthetic Air');
      await flight.locator('#svc-fare-adult').fill('15000');
      await flight.getByRole('button', { name: 'Save flight' }).click();
      await expect(flight).toBeHidden({ timeout: 30_000 });
      await expect(main.getByRole('region', { name: /^Flights/ })).toContainText('Fare per person: Adult ₹15,000', { timeout: 30_000 });

      // Change 19: a flight added from a screenshot saves and uploads in one step.
      await main.getByRole('button', { name: 'Add flight', exact: true }).click();
      const shot = sales.getByRole('dialog', { name: 'Add flight' });
      await shot.getByRole('radio', { name: 'Attach a screenshot' }).click();
      await shot.locator('#svc-screenshot').setInputFiles({ name: 'synthetic-flight.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic flight ${ref}`) });
      await shot.locator('#svc-screenshotNote').fill('Book the 08:00 option');
      await shot.getByRole('button', { name: 'Save flight' }).click();
      await expect(shot).toBeHidden({ timeout: 60_000 });
      await expect(main.getByRole('region', { name: /^Flights/ })).toContainText('From screenshot · Book the 08:00 option', { timeout: 30_000 });
      await main.getByRole('button', { name: 'Edit flight 2' }).click();
      const edit = sales.getByRole('dialog', { name: 'Edit flight' });
      await expect(edit.getByRole('list', { name: 'Flight screenshots' })).toContainText('synthetic-flight.pdf', { timeout: 30_000 });
      const href = await edit.getByRole('link', { name: /synthetic-flight\.pdf/ }).getAttribute('href');
      expect(href).toMatch(new RegExp(`^/app/deals/${dealId}/book/files/`));
      const download = await sales.request.get(href!, { maxRedirects: 0 });
      expect(download.status()).toBe(302);
      await edit.getByRole('button', { name: 'Cancel' }).click();
      await sales.screenshot({ path: `${shotDir}/02-services.png`, fullPage: true });
    });

    await test.step('step 3: per-person prices in three directions save themselves in whole paise; reload shows them', async () => {
      await steps.getByRole('button', { name: /Price & Bill To/ }).click();
      const price = main.locator('section#price');
      await price.getByLabel('Child with bed: people').fill('1');
      await price.getByLabel('Adult purchase per person, rupees').fill('20000');
      await price.getByLabel('Adult markup per person, rupees').fill('1234.56');
      await expect(price.getByLabel('Adult final sale per person, rupees')).toHaveValue('21234.56');
      await price.getByLabel('Child with bed purchase per person, rupees').fill('10000');
      await price.getByLabel('Child with bed final sale per person, rupees').fill('12000');
      await expect(price.getByLabel('Child with bed markup per person, rupees')).toHaveValue('2000.00');
      await price.getByLabel('Infant purchase per person, rupees').fill('0');
      await price.getByLabel('Infant markup per person, rupees').fill('0');
      await expect(price).toContainText('₹54,469.12');
      const sellingTotal = () => db(async (client) => (await client.query<{ t: string | null }>(
        `select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [dealId])).rows[0]?.t ?? null);
      await expect.poll(sellingTotal, { timeout: 30_000 }).toBe('5446912');
      await expect(sales.locator('#pill-price')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      // Echo B-H1: change one amount; it saves again without a reload.
      await price.getByLabel('Adult markup per person, rupees').fill('1300');
      await expect(price.getByLabel('Adult final sale per person, rupees')).toHaveValue('21300.00');
      await expect.poll(sellingTotal, { timeout: 30_000 }).toBe('5460000');
      await sales.reload();
      await expect(main.locator('section#price').getByLabel('Adult final sale per person, rupees')).toHaveValue(/^21300(\.00)?$/);
    });

    await test.step('step 3: Bill To business without GST, with a reason; saved and reloaded', async () => {
      const bill = main.locator('section#billTo');
      // Bill To is search first; the typed form opens with "Type the details instead".
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('radio', { name: 'Business' }).click();
      await bill.getByLabel('Company name').fill('Synthetic Small Firm');
      await bill.getByLabel('Contact name').fill('Synthetic Contact');
      await bill.getByLabel('Phone').fill('9876500088');
      await bill.getByLabel('Address', { exact: true }).fill('2 Synthetic Road');
      await bill.getByLabel('City').fill('Udaipur');
      await bill.getByLabel('State').selectOption('08');
      await bill.getByLabel('PIN code').fill('313001');
      await bill.getByLabel('GST registration').selectOption('unregistered');
      await bill.getByLabel('Reason for no GSTIN').fill('Turnover below the registration threshold');
      const billRow = () => db(async (client) => (await client.query<{ contact: string | null; reason: string | null }>(
        'select contact_person as contact, gst_reason as reason from public.customer_billing_profiles where deal_id = $1', [dealId])).rows[0] ?? null);
      await expect.poll(async () => (await billRow())?.reason ?? null, { timeout: 30_000 }).toBe('Turnover below the registration threshold');
      await expect(sales.locator('#pill-billTo')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      // Echo B-H1: a second Bill To save without a reload (a saved Bill To shows as a summary with "Edit details").
      const editDetails = bill.getByRole('button', { name: 'Edit details' });
      if (await editDetails.isVisible()) await editDetails.click();
      await bill.getByLabel('Contact name').fill('Synthetic Contact Two');
      await expect.poll(async () => (await billRow())?.contact ?? null, { timeout: 30_000 }).toBe('Synthetic Contact Two');
      await expect(main).toContainText('All changes saved', { timeout: 30_000 });
      await sales.reload();
      const after = main.locator('section#billTo');
      await expect(after).toContainText('Synthetic Contact Two');
      await expect(after).toContainText('Turnover below the registration threshold');
      await expect(after).toContainText('Waits for Accounts check');
      await sales.screenshot({ path: `${shotDir}/03-finish.png`, fullPage: true });
    });
    await test.step('the database holds exactly what was typed (paise, estimates, party, Bill To)', async () => {
      const facts = await db(async (client) => {
        const { rows: v } = await client.query<{ id: string; pax: number; children: number; infants: number }>(
          `select id, pax_total as pax, children_count as children, infants_count as infants from public.booking_versions where deal_id = $1 and status = 'draft'`,
          [dealId],
        );
        const versionId = v[0]!.id;
        const { rows: lines } = await client.query<{ category: string; quantity: number; purchase: string | null; sale: string | null; markup: string | null }>(
          `select category, quantity, purchase_paise::text as purchase, sale_paise::text as sale, markup_paise::text as markup from public.booking_version_price_lines where booking_version_id = $1 order by category`,
          [versionId],
        );
        const { rows: est } = await client.query<{ n: string }>('select count(*)::text as n from public.service_item_cost_estimates where booking_version_id = $1', [versionId]);
        const { rows: bill } = await client.query<{ type: string; gst: string; gstin: string | null }>(
          `select bill_to_type as type, gst_status as gst, gstin from public.customer_billing_profiles where deal_id = $1`,
          [dealId],
        );
        return { party: [v[0]!.pax, v[0]!.children, v[0]!.infants], lines, estimates: est[0]!.n, bill: bill[0] };
      });
      expect(facts.party).toEqual([4, 1, 1]);
      expect(facts.lines.find((l) => l.category === 'adult')).toMatchObject({ quantity: 2, purchase: '2000000', sale: '2130000', markup: '130000' });
      expect(facts.lines.find((l) => l.category === 'infant')).toMatchObject({ quantity: 1, purchase: '0', sale: '0' });
      expect(facts.estimates).toBe('5');
      expect(facts.bill).toEqual({ type: 'business', gst: 'unregistered', gstin: null });
    });

    expect(csp.violations).toEqual([]);
    await salesContext.close();
  });

  test('Bill To: Sales proposes a business without GST; Accounts switches it to registered with a GSTIN and verifies; Sales can no longer change it', async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const ref = `SYN-BFA-${tag}`;
    const GSTIN = '08ABCDE1234F1Z5';
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');
    const dealId = await test.step('fixture', async () => {
      await loadFixture(fixtureFile);
      return newDeal(ref, 'Synthetic Bill To hand-off');
    });
    const salesContext = await csp.track(browser, 'sales');
    const sales = await signInAndEnrol(salesContext, USERS.sales.email);
    const main = sales.locator('main');

    await test.step('Sales: Bill To for a business that is not GST registered, with the reason', async () => {
      await sales.goto(`/app/deals/${dealId}`);
      await sales.getByRole('button', { name: 'Start booking', exact: true }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
      await main.getByRole('navigation', { name: 'Booking steps' }).getByRole('button', { name: /Price & Bill To/ }).click();
      const bill = main.locator('section#billTo');
      // Voice-note batch: Bill To is search first; the typed form opens with "Type the details instead".
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('radio', { name: 'Business' }).click();
      await bill.getByLabel('Company name').fill('Synthetic Growing Firm');
      await bill.getByLabel('Contact name').fill('Synthetic Contact');
      await bill.getByLabel('Phone').fill('9876500066');
      await bill.getByLabel('Address', { exact: true }).fill('3 Synthetic Road');
      await bill.getByLabel('City').fill('Jodhpur');
      await bill.getByLabel('State').selectOption('08');
      await bill.getByLabel('PIN code').fill('342001');
      await bill.getByLabel('GST registration').selectOption('unregistered');
      await bill.getByLabel('Reason for no GSTIN').fill('Registration applied for, not issued yet');
      // Book now v2 (change 2): Bill To saves itself once every check passes.
      await expect.poll(() => db(async (client) => (await client.query<{ reason: string | null }>(
        'select gst_reason as reason from public.customer_billing_profiles where deal_id = $1', [dealId])).rows[0]?.reason ?? null), { timeout: 30_000 }).toBe('Registration applied for, not issued yet');
      await expect(sales.locator('#pill-billTo')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
    });

    const aContext = await csp.track(browser, 'accounts-a');
    const a = await signInAndEnrol(aContext, USERS.a.email);
    await test.step('Accounts A sees the Bill To fields and switches the business to GST registered with a GSTIN', async () => {
      // Batch 4 (DA-15, lead ruling D6): billing sits on the Review tab.
      await a.goto(`/app/accounts/deals/${dealId}?tab=review`);
      const section = a.getByRole('region', { name: 'Customer billing details' });
      await expect(section).toContainText('Business');
      await expect(section).toContainText('Synthetic Contact');
      await expect(section).toContainText('Not GST registered. Reason: Registration applied for, not issued yet');
      await section.getByText('Edit billing details').click();
      const form = a.getByRole('form', { name: 'Customer billing details' });
      await expect(form.getByLabel('Reason for no GSTIN')).toHaveValue('Registration applied for, not issued yet');
      await form.getByLabel('GST registration').selectOption('registered');
      await expect(form.getByLabel('Reason for no GSTIN')).toHaveCount(0);
      await form.getByLabel('GSTIN').fill(GSTIN);
      await form.getByRole('button', { name: 'Save billing details' }).click();
      await expect(section).toContainText('GST registered', { timeout: 30_000 });
      await expect(section).toContainText(GSTIN);
    });

    const bContext = await csp.track(browser, 'accounts-b');
    const b = await signInAndEnrol(bContext, USERS.b.email);
    await test.step('Accounts B verifies the edited details', async () => {
      await b.goto(`/app/accounts/deals/${dealId}?tab=review`);
      await b.getByRole('form', { name: 'Check billing details' }).getByRole('button', { name: 'Check billing details' }).click();
      await expect(b.locator('main')).toContainText('Billing details checked', { timeout: 30_000 });
    });

    await test.step('Sales: the checked Bill To is locked with words and shows what Accounts saved', async () => {
      await sales.goto(`/app/deals/${dealId}/book/finish`);
      const bill = main.locator('section#billTo');
      await expect(bill).toContainText('Billing checked by Accounts. Ask Accounts to change it.', { timeout: 30_000 });
      await expect(bill).toContainText(`GST registered · ${GSTIN}`);
      await expect(bill.locator('input, select, textarea')).toHaveCount(0);
    });

    await test.step('the database holds the Accounts version, verified, with no reason left behind', async () => {
      const row = await db(async (client) => {
        const { rows } = await client.query<{ status: string; gst: string; gstin: string | null; reason: string | null }>(
          'select status, gst_status as gst, gstin, gst_reason as reason from public.customer_billing_profiles where deal_id = $1',
          [dealId],
        );
        return rows[0];
      });
      expect(row).toEqual({ status: 'verified', gst: 'registered', gstin: GSTIN, reason: null });
    });

    expect(csp.violations).toEqual([]);
    await Promise.all([salesContext.close(), aContext.close(), bContext.close()]);
  });
});
