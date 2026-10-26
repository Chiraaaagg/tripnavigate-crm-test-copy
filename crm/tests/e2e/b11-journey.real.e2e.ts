import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, istToday, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * B1.1/B1.2 browser-only fresh-Deal journey (contract §6, plan §8, freeze note §7; B1.2 three steps and identity proof)
 * against a REAL local Supabase stack, served by the production build
 * (playwright.real.config.ts). The lead runs it; it is never run against a
 * hosted database.
 *
 * The Sales owner types EVERY booking fact in the three-step Book now form,
 * including the selling total and the payment plan and an identity proof per
 * adult (with the customer-consent tick), reports a cash payment, uploads the
 * acceptance message and submits; one task per sold service appears. Then
 * Accounts person A records the receipt from the claim and Accounts person B
 * verifies it; Sales sees the claim as verified.
 *
 * Fixture steps (synthetic, local only, never user-entered booking facts):
 * the synthetic finance entity and users of the Accounts journey
 * (supabase/fixtures/journeys/accounts_journey.sql), a fresh run-tagged
 * synthetic Deal owned by the synthetic Sales person, and the
 * service_items_enabled switch for the run (restored afterwards). Read-only
 * checks of the result use the local owner connection.
 *
 * Skips without a real stack; fails (never skips) when REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the B1.1 journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The B1.1 journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_NAME = 'Synthetic Finance Branch';
const USERS = {
  a: { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test', name: 'Synthetic Accounts Finance A' },
  b: { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test', name: 'Synthetic Accounts Finance B' },
  sales: { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test', name: 'Synthetic Sales Finance' },
} as const;
const shotDir = 'test-results/real-journey/b11';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

let switchWasOn: boolean | null = null;

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the B1.1 journey needs the 'test' deployment environment").toBe('test');
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
    switchWasOn = s[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'b11-journey.real.e2e.ts: switch on for the run', false);
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

// Booking form (owner-approved preview, 22 October 2026): three steps on one screen; each step has a
// screen-reader heading "Step n of 3: name"; the footer saves the changed parts and moves on.
const STEP_NAME = { travellers: 'Customer & passengers', stay: 'Trip & services', finish: 'Price & Bill To' } as const;
const step = (page: Page, name: string) => page.getByRole('heading', { level: 2, name: new RegExp(`^Step \\d of 3: ${name.replace(/[&]/g, '\\$&')}$`) });
// Book now v2: the footer only moves between steps (the cards save themselves).
const goToStep = async (page: Page, next: string) => {
  await page.getByRole('button', { name: next === STEP_NAME.stay ? 'Go to step 2' : 'Go to step 3' }).click();
  await expect(page).toHaveURL(new RegExp(`/book/${next === STEP_NAME.stay ? 'stay' : 'finish'}`), { timeout: 30_000 });
};
const CONTACT_TICK = 'I confirmed the contact details with the customer';
const SUBMIT_BUTTON = 'Submit booking and create tasks';
const SUBMIT_DIALOG = 'Submit this booking and create tasks?';
const syntheticPdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);

test.describe('B1.1 browser-only fresh-Deal journey (real local stack)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!configured || switchWasOn === null) return;
    await db(async (client) => {
      await client.query(`select set_config('tripnavigate.change_reason', 'b11-journey.real.e2e.ts: restore the switch after the run', false)`);
      await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
    });
  });

  test('Sales types every fact incl. selling total and plan, submits; tasks appear; Accounts records and verifies the reported payment', async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(shotDir, { recursive: true });
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const ref = `SYN-B11-${tag}`;
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');

    const dealId = await test.step('fixture: synthetic entity and users, a fresh Deal header, the switch on', async () => {
      await loadFixture(fixtureFile);
      return newDeal(ref, 'Synthetic Book now journey');
    });

    const salesContext = await csp.track(browser, 'sales');
    const sales = await signInAndEnrol(salesContext, USERS.sales.email);

    await test.step('Deal page: the header primary "Start booking" opens step 1 of 3', async () => {
      // One start control on any tab (lead ruling 3): the Services tab repeats no start button.
      await sales.goto(`/app/deals/${dealId}?tab=services`);
      await expect(sales.getByRole('button', { name: 'Start booking', exact: true })).toHaveCount(1);
      await sales.goto(`/app/deals/${dealId}`);
      const main = sales.getByRole('main');
      await expect(main).toContainText('Not started');
      await expect(main).toContainText('start the booking');
      // DA-20 honesty line beside the action: starting books nothing and approves no money.
      await expect(main).toContainText('Nothing is booked or paid');
      await expect(sales.getByRole('button', { name: 'Start booking', exact: true })).toHaveCount(1);
      // Exactly one primary action in the header (copy §16.3).
      const start = sales.getByRole('button', { name: 'Start booking' });
      await expect(start).toHaveCount(1);
      await start.click();
      // The step may carry its first section (#customer, or ?at=customer if the fragment fallback is on): both are step 1.
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers(#customer|\\?at=customer)?$`), { timeout: 30_000 });
      await expect(step(sales, STEP_NAME.travellers)).toBeVisible();
    });

    await test.step('B1.2: an old six-step address (full load) lands on the new step with its section', async () => {
      await sales.goto(`/app/deals/${dealId}/book/customer`);
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers(#customer|\\?at=customer)$`), { timeout: 30_000 });
      await expect(sales.locator('#customer-heading')).toBeFocused();
      await sales.goto(`/app/deals/${dealId}/book/payment`);
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/finish(#payment|\\?at=payment)$`), { timeout: 30_000 });
      await expect(sales.locator('#payment-heading')).toBeFocused();
      await sales.goto(`/app/deals/${dealId}/book/travellers`);
    });

    await test.step('step 1: customer, trip and party in one card that saves itself; passengers as compact rows', async () => {
      const main = sales.locator('main');
      await main.getByLabel('Name', { exact: true }).fill('Synthetic Journey Customer');
      await main.getByLabel('Phone', { exact: true }).first().fill('9876500099');
      await main.getByLabel('Destination', { exact: true }).fill('Mumbai');
      await main.getByLabel('Travel date').fill('2026-12-10');
      await main.getByRole('spinbutton', { name: 'Adults' }).fill('2');
      await main.getByLabel('Return date').fill('2026-12-13');
      await main.getByLabel('Trip', { exact: true }).selectOption('domestic');
      await main.getByLabel(CONTACT_TICK).check();
      // Book now v2 (change 2, ruling D1): the card saves itself once every check passes.
      await expect(sales.locator('#pill-customer')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      await expect.poll(() => db(async (client) => (await client.query<{ n: number | null }>(
        `select pax_total as n from public.booking_versions where deal_id = $1 and status = 'draft'`, [dealId])).rows[0]?.n ?? null), { timeout: 30_000 }).toBe(2);
      // Passenger rows come from the counts (no Add passenger); named rows save themselves.
      await main.getByLabel('Passenger 1 full name').fill('Synthetic Traveller One');
      await main.getByLabel('Passenger 2 full name').fill('Synthetic Traveller Two');
      await expect(main.locator('#bf-pax-named')).toHaveText('2 of 2 named');
      await expect.poll(() => db(async (client) => (await client.query<{ n: string }>(
        'select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId])).rows[0]!.n), { timeout: 30_000 }).toBe('2');
    });

    await test.step('step 1: identity proof per adult from the passenger row, consent required', async () => {
      await expect(sales.locator('main')).toContainText('ID proof still needed: Synthetic Traveller One, Synthetic Traveller Two', { timeout: 30_000 });
      for (const [i, who] of ['Synthetic Traveller One', 'Synthetic Traveller Two'].entries()) {
        await sales.locator('main').getByRole('button', { name: `Attach ID proof for ${who}` }).click();
        const dialog = sales.getByRole('dialog', { name: `ID proof · ${who}` });
        // The first adult sends the front and the back together (one dialog, two files).
        const files = i === 0
          ? [
              { name: 'synthetic-id.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic identity proof for ${who} ${ref}`) },
              { name: 'synthetic-id-back.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic identity proof back for ${who} ${ref}`) },
            ]
          : [{ name: 'synthetic-id.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic identity proof for ${who} ${ref}`) }];
        await dialog.getByLabel('ID proof file').setInputFiles(files);
        if (i === 0) {
          // Without the consent tick nothing is sent.
          await dialog.getByRole('button', { name: `Attach ID proof for ${who}` }).click();
          await expect(dialog.getByRole('alert')).toContainText('Tick the customer’s agreement first. Nothing was uploaded.');
        }
        await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
        await dialog.getByRole('button', { name: `Attach ID proof for ${who}` }).click();
        await expect(dialog).toBeHidden({ timeout: 60_000 });
      }
      await expect.poll(() => db(async (client) => (await client.query<{ n: string }>(
        "select count(*)::text as n from public.traveller_id_proofs where deal_id = $1 and status = 'stored'", [dealId])).rows[0]!.n), { timeout: 30_000 }).toBe('3');
      await expect(sales.locator('main')).not.toContainText('ID proof still needed', { timeout: 30_000 });
      await sales.screenshot({ path: `${shotDir}/01-travellers.png`, fullPage: true });
      await goToStep(sales, STEP_NAME.stay);
    });

    await test.step('step 2: a hotel covering every trip night, then a flight; supplier estimates only', async () => {
      const main = sales.locator('main');
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const hotel = sales.getByRole('dialog', { name: 'Add hotel stay' });
      await hotel.getByLabel('City').fill('Mumbai');
      await hotel.getByLabel('Hotel', { exact: true }).fill('Synthetic Sea View Hotel');
      await expect(hotel.getByLabel('Check-in')).toHaveValue('2026-12-10');
      await hotel.getByLabel('Nights').fill('3');
      await hotel.getByLabel('Rooms: our cost per night').fill('15000');
      await expect(hotel).toContainText('₹45,000');
      // Book now v2 (change 16): no adults box, no budget; the people are the chips (both named adults).
      await expect(hotel.locator('#svc-who-line')).toContainText('2 of 2 chosen');
      await expect(hotel.getByLabel(/Purchase budget/)).toHaveCount(0);
      await hotel.getByRole('button', { name: 'Save hotel' }).click();
      await expect(hotel).toBeHidden({ timeout: 30_000 });
      await expect(main).toContainText('Synthetic Sea View Hotel', { timeout: 30_000 });
      await expect(main.getByRole('status').filter({ hasText: /trip nights/ })).toContainText('3 / 3 trip nights have a hotel', { timeout: 30_000 });

      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Flights/ }).click();
      await main.getByRole('button', { name: 'Add flight', exact: true }).click();
      const flight = sales.getByRole('dialog', { name: 'Add flight' });
      await flight.locator('#ap-from').fill('JDH');
      await flight.locator('#ap-from').press('Enter');
      await flight.locator('#ap-to').fill('BOM');
      await flight.locator('#ap-to').press('Enter');
      await expect(flight.getByLabel('Departure date')).toHaveValue('2026-12-10');
      // Passengers flying: every named passenger starts chosen (change 6).
      await expect(flight.locator('#svc-who-line')).toContainText('2 of 2 chosen');
      await flight.locator('#svc-fare-adult').fill('10000');
      await flight.getByRole('button', { name: 'Save flight' }).click();
      await expect(flight).toBeHidden({ timeout: 30_000 });
      await expect(main).toContainText('JDH – BOM', { timeout: 30_000 });
      await sales.screenshot({ path: `${shotDir}/02-stay.png`, fullPage: true });
    });

    await test.step('B1.2: the Deal page "Continue booking" (in-app link) opens the first section that needs input', async () => {
      await sales.goto(`/app/deals/${dealId}`);
      await expect(sales.getByRole('main')).toContainText('Booking in progress');
      const resume = sales.getByRole('link', { name: 'Continue booking' });
      await expect(resume).toHaveCount(1);
      await resume.click();
      // The link opens step 3 (the first step that needs input); the price card is on screen.
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/finish(#price|\\?at=price)?$`), { timeout: 30_000 });
      await expect(sales.locator('section#price')).toBeVisible();
    });

    await test.step('step 3: per-person price, Bill To, a reported cash payment and the plan (each card saves itself)', async () => {
      const main = sales.locator('main');
      const price = main.locator('section#price');
      await price.getByLabel('Adult purchase per person, rupees').fill('40000');
      await price.getByLabel('Adult markup per person, rupees').fill('7500');
      await expect(price.getByLabel('Adult final sale per person, rupees')).toHaveValue('47500.00');
      await expect(price).toContainText('₹95,000');
      await expect.poll(() => db(async (client) => (await client.query<{ t: string | null }>(
        `select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id
         where v.deal_id = $1 and v.status = 'draft'`, [dealId])).rows[0]?.t ?? null), { timeout: 30_000 }).toBe('9500000');

      const bill = main.locator('section#billTo');
      // Bill To is search first; the typed form opens with "Type the details instead".
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('button', { name: 'Use booking contact' }).click();
      await bill.getByLabel('Address', { exact: true }).fill('1 Synthetic Lane');
      await bill.getByLabel('City').fill('Jodhpur');
      await bill.getByLabel('State').selectOption('08');
      await bill.getByLabel('PIN code').fill('342001');
      await expect.poll(() => db(async (client) => (await client.query<{ pin: string | null }>(
        'select postal_code as pin from public.customer_billing_profiles where deal_id = $1', [dealId])).rows[0]?.pin ?? null), { timeout: 30_000 }).toBe('342001');

      // "Payment already received? (optional)" is collapsed (change 9).
      await main.locator('details#sec-claim > summary').click();
      const claim = sales.getByRole('form', { name: 'Tell Accounts about a payment' });
      await claim.getByLabel('How they paid').selectOption('cash');
      // Form reset (React 19): a refused report keeps "Cash" on screen and the retry posts it.
      // A zero amount is refused; only the amount is corrected before reporting again.
      await claim.getByLabel('Amount ₹').fill('0');
      await claim.getByLabel('Paid on').fill(istToday());
      await claim.getByLabel('Paid by').fill('Synthetic Journey Customer');
      await claim.getByRole('button', { name: 'Send to Accounts' }).click();
      await expect(claim).toContainText('Check the fields marked below. What you typed is still here.', { timeout: 30_000 });
      await expect(claim.getByLabel('How they paid')).toHaveValue('cash');
      await claim.getByLabel('Amount ₹').fill('30000');
      await claim.getByRole('button', { name: 'Send to Accounts' }).click();
      await expect(main).toContainText('Reported, not checked yet', { timeout: 30_000 });
      await expect.poll(() => db(async (client) => (await client.query<{ mode: string }>('select mode from public.customer_payment_claims where deal_id = $1', [dealId])).rows.map((r) => r.mode).join(',')), { timeout: 30_000 }).toBe('cash');

      const plan = main.locator('section#plan');
      // A new plan has no rows yet.
      await plan.getByRole('button', { name: 'Add instalment' }).click();
      await plan.getByLabel('Instalment 1', { exact: true }).fill('Advance');
      await plan.locator('#payment-1-amount').fill('30000');
      await plan.locator('#payment-1-due').fill(istToday());
      await plan.getByRole('button', { name: 'Add instalment' }).click();
      await plan.getByLabel('Instalment 2', { exact: true }).fill('Balance');
      await plan.locator('#payment-2-amount').fill('65000');
      await plan.locator('#payment-2-due').fill('2026-12-01');
      await expect(plan).toContainText('matches the total');
      await expect.poll(() => db(async (client) => (await client.query<{ n: string }>(
        'select count(*)::text as n from public.booking_version_instalments where deal_id = $1', [dealId])).rows[0]!.n), { timeout: 30_000 }).toBe('2');
      await expect(sales.locator('#pill-plan')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
    });

    await test.step('step 3: acceptance proof, then "Review and submit"', async () => {
      // Choosing the file uploads it (change 9: its own card).
      await sales.getByLabel('Acceptance file').setInputFiles({ name: 'synthetic-acceptance.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic acceptance for ${ref}`) });
      await expect(sales.locator('section#ok')).toContainText('synthetic-acceptance.pdf', { timeout: 30_000 });
      await expect(sales.locator('#bf-ready').getByRole('heading', { name: 'Ready to submit' })).toBeVisible({ timeout: 30_000 });
      await expect(sales.locator('#bf-ready')).toContainText('7 of 7 done');
      await sales.screenshot({ path: `${shotDir}/03-finish.png`, fullPage: true });
      await sales.locator('main').getByRole('button', { name: 'Review and submit' }).click();
      const dialog = sales.getByRole('dialog', { name: SUBMIT_DIALOG });
      await expect(dialog).toContainText('It creates 2 internal tasks', { timeout: 30_000 });
      await dialog.getByRole('button', { name: SUBMIT_BUTTON }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book$`), { timeout: 60_000 });
      await expect(sales.locator('main')).toContainText('Submitted · accepted version 1');
      await expect(sales.getByRole('region', { name: 'Traveller ID proofs' })).toContainText('Synthetic Traveller Two');
      await sales.screenshot({ path: `${shotDir}/04-submitted.png`, fullPage: true });
    });

    await test.step('one task per sold service, created once; facts came from the browser', async () => {
      const facts = await db(async (client) => {
        const { rows: tasks } = await client.query<{ n: string }>('select count(*)::text as n from public.fulfilment_tasks where deal_id = $1', [dealId]);
        const { rows: total } = await client.query<{ total: string }>(
          `select c.selling_total_paise::text as total from public.booking_version_commercials c
           join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'confirmed'`,
          [dealId],
        );
        const { rows: plan } = await client.query<{ n: string }>('select count(*)::text as n from public.booking_version_instalments where deal_id = $1', [dealId]);
        const { rows: proofs } = await client.query<{ n: string }>(
          "select count(*)::text as n from public.traveller_id_proofs where deal_id = $1 and status = 'stored' and consent_by = $2",
          [dealId, USERS.sales.id],
        );
        return { tasks: tasks[0]!.n, total: total[0]?.total, plan: plan[0]!.n, proofs: proofs[0]!.n };
      });
      expect(facts).toEqual({ tasks: '2', total: '9500000', plan: '2', proofs: '3' });
      await expect(sales.getByRole('region', { name: 'Services and tasks' })).toContainText('Purchase team');
      await expect(sales.getByRole('region', { name: 'Services and tasks' })).toContainText('Flight team');
    });

    const aContext = await csp.track(browser, 'accounts-a');
    const a = await signInAndEnrol(aContext, USERS.a.email);
    await test.step('Accounts A records the receipt from the claim', async () => {
      // Batch 4 (DA-15): reported payments sit on the Money tab of the Accounts deal page.
      await a.goto(`/app/accounts/deals/${dealId}?tab=money`);
      const claims = a.getByRole('region', { name: 'Reported payments' });
      await expect(claims).toContainText('Reported by Sales: record or link the receipt');
      await claims.getByRole('button', { name: 'Record receipt from this claim' }).click();
      const form = a.getByRole('form', { name: 'Record receipt from this claim' });
      await expect(form.getByLabel('Amount received (₹)')).toHaveValue(/30000/);
      await form.getByLabel('Collecting branch').selectOption({ label: BRANCH_NAME });
      await form.getByLabel('Who collected the cash').selectOption({ label: USERS.a.name });
      await form.getByLabel('Payer mobile').fill('9876500099');
      await form.getByRole('button', { name: 'Record receipt from this claim' }).click();
      await expect(claims).toContainText('Receipt recorded, awaiting verification', { timeout: 30_000 });
      // DEC-41: Accounts sees the travellers' ID proofs with an audited download (never Super Admin by role alone).
      // Batch 4: on the Documents tab.
      await a.goto(`/app/accounts/deals/${dealId}?tab=documents`);
      const proofs = a.getByRole('region', { name: 'Traveller ID proofs' });
      await expect(proofs.getByRole('link', { name: /Open/ })).toHaveCount(3);
      const href = await proofs.getByRole('link', { name: /Open/ }).first().getAttribute('href');
      expect(href).toMatch(/^\/app\/id-proofs\//);
      const download = await a.request.get(href!, { maxRedirects: 0 });
      expect(download.status()).toBe(302);
    });

    const bContext = await csp.track(browser, 'accounts-b');
    const b = await signInAndEnrol(bContext, USERS.b.email);
    await test.step('Accounts B verifies it; Sales sees the claim verified', async () => {
      await b.goto(`/app/accounts/deals/${dealId}?tab=receipts`);
      const verify = b.getByRole('form', { name: /^Verify R-/ }).first();
      await verify.getByRole('button', { name: /Verify receipt/ }).click();
      await expect(verify).toHaveCount(0, { timeout: 30_000 });
      await b.goto(`/app/accounts/deals/${dealId}?tab=money`);
      await expect(b.getByRole('region', { name: 'Reported payments' })).toContainText('Verified', { timeout: 30_000 });
      await sales.goto(`/app/deals/${dealId}/book`);
      // DA-291: the claim status and the summary row now use the same words; both must be there.
      await expect(sales.locator('main').getByText('Checked by Accounts')).not.toHaveCount(0);
      expect(await sales.locator('main').getByText('Checked by Accounts').count()).toBeGreaterThanOrEqual(2);
    });

    expect(csp.violations).toEqual([]);
    await Promise.all([salesContext.close(), aContext.close(), bContext.close()]);
  });
});
