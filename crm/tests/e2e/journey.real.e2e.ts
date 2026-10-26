import { mkdirSync } from 'node:fs';
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import pg from 'pg';
import { confirmLinkPath, expectHardenedAuthCookies, readSessionCookie, writeSessionCookie } from '../helpers/browser-journey';

/**
 * T15: real browser journey against a REAL local Supabase stack (Auth, Data
 * API, Postgres) and the local Mailpit mail sink. Runs only in the CI job that
 * starts `supabase start`, resets the database, seeds the synthetic fixtures
 * and serves the app pointed at that stack. Everything here is synthetic:
 * fixture users, `journey.<timestamp>@example.test` people and the local mail
 * sink. No external email is sent.
 *
 * Required environment:
 *   LOCAL_FIXTURE_PASSWORD  password of the seeded synthetic fixture users
 *   TEST_DATABASE_URL       local Supabase Postgres (fixture steps only)
 *   MAILPIT_URL             optional, default http://127.0.0.1:54324
 * When REQUIRE_REAL_STACK=1 a missing value is a failure, not a skip.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const mailpitUrl = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324').replace(/\/$/, '');
const configured = Boolean(fixturePassword && databaseUrl);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error(
    'REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD and/or TEST_DATABASE_URL are missing: the real browser journey must run, not skip.',
  );
}

const ADMIN_EMAIL = 'admin.jodhpur@example.test';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000007';
const DEAL_ID = 'd0000000-0000-4000-8000-000000000002';
const DEAL_REF = 'SYN-DEL-002';
const shotDir = 'test-results/real-journey';

// Phase 4 Purchase journey (synthetic fixture users, local stack only).
const SALES_EMAIL = 'sales.delhi.a@example.test';
const SALES_ID = 'a0000000-0000-4000-8000-000000000001';
const PURCHASE_EMAIL = 'purchase.jodhpur@example.test';
const PURCHASE_ID = 'a0000000-0000-4000-8000-000000000003';
const JOURNEY_HOTEL = 'Synthetic Hotel (journey)';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const purchaseConfigured = configured && Boolean(supabaseUrl && publishableKey && secretKey);
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

if (process.env.REQUIRE_REAL_STACK === '1' && !purchaseConfigured) {
  throw new Error('REQUIRE_REAL_STACK=1 but the Supabase URL, publishable key or secret key is missing: the Purchase journey must run, not skip.');
}

const cspViolations: string[] = [];
let shotNo = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(page: Page, name: string) {
  shotNo += 1;
  await page.screenshot({ path: `${shotDir}/${String(shotNo).padStart(2, '0')}-${name}.png`, fullPage: true });
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** New browser context that reports every CSP violation (console and securitypolicyviolation events). */
async function newTrackedContext(browser: Browser, label: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.exposeFunction('__reportCspViolation', (v: string) => cspViolations.push(`[${label}] ${v}`));
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCspViolation: (v: string) => void }).__reportCspViolation(
        `${location.pathname}: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`,
      );
    });
  });
  context.on('console', (msg) => {
    if (msg.text().includes('Content Security Policy')) cspViolations.push(`[${label}] console: ${msg.text()}`);
  });
  return context;
}

/** TOTP codes: never reuse a time step for the same secret, never use one about to expire. */
const lastStep = new Map<string, number>();
async function totpCode(secret: string): Promise<string> {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret.replace(/\s/g, '')), digits: 6, period: 30 });
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 30_000);
    const remaining = 30_000 - (now % 30_000);
    const last = lastStep.get(secret);
    if ((last !== undefined && step <= last) || remaining < 4_000) {
      await sleep(remaining + 500);
      continue;
    }
    lastStep.set(secret, step);
    return totp.generate({ timestamp: now });
  }
}

/** Enrols a TOTP factor through the UI, reading the manual setup key from the page. */
async function enrolTotpViaUi(page: Page, label: string): Promise<string> {
  await expect(page).toHaveURL(/\/mfa\/enroll/);
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  await page.getByText('Cannot scan? Enter this setup key instead').click();
  const secretText = await page.locator('p.secret').textContent();
  const secret = (secretText ?? '').trim();
  expect(secret, 'setup key shown on the enrollment page').toMatch(/^[A-Z2-7]+=*$/);
  await shot(page, `${label}-mfa-enroll-qr`);
  await page.getByLabel('6-digit code').fill(await totpCode(secret));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  return secret;
}

async function challengeViaUi(page: Page, secret: string) {
  await expect(page).toHaveURL(/\/mfa\/challenge/);
  await page.getByLabel('6-digit code').fill(await totpCode(secret));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

interface MailpitSummary {
  ID: string;
  To: Array<{ Address: string }>;
}

/** Fetches the newest /auth/confirm link sent to `to` from the local Mailpit REST API. */
async function confirmLinkFor(to: string, notIds: Set<string> = new Set()): Promise<{ id: string; path: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${mailpitUrl}/api/v1/messages?limit=100`);
    expect(res.ok, 'Mailpit REST API reachable').toBe(true);
    const body = (await res.json()) as { messages?: MailpitSummary[] };
    const message = (body.messages ?? []).find(
      (m) => !notIds.has(m.ID) && m.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()),
    );
    if (message) {
      const full = (await (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`)).json()) as {
        HTML?: string;
        Text?: string;
      };
      const match = `${full.HTML ?? ''}\n${full.Text ?? ''}`.match(/https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/);
      expect(match, `confirmation link in the email to ${to}`).not.toBeNull();
      // The template uses the provider's site URL; open the same path on the app under test.
      const url = new URL(match![0].replace(/&amp;/g, '&'));
      return { id: message.ID, path: `${url.pathname}${url.search}` };
    }
    await sleep(1_000);
  }
  throw new Error(`No email to ${to} arrived in Mailpit within 60 s.`);
}

function staffRow(page: Page, email: string): Locator {
  return page.getByRole('row').filter({ hasText: email });
}

async function inviteViaUi(adminPage: Page, name: string, email: string) {
  await adminPage.goto('/app/admin/staff');
  // Batch 4: the Settings frame owns the one h1; each Settings page heading is an h2 (DA-251).
  await expect(adminPage.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(adminPage.getByRole('heading', { level: 2, name: 'Staff', exact: true })).toBeVisible();
  const form = adminPage.locator('form').filter({ has: adminPage.getByRole('button', { name: 'Send invitation' }) });
  await form.getByLabel('Full name').fill(name);
  await form.getByLabel('Work email').fill(email);
  await form.getByLabel('Branch', { exact: true }).selectOption({ label: 'Delhi' });
  await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Sales' });
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(form.getByRole('status').filter({ hasText: 'Done:' })).toBeVisible({ timeout: 30_000 });
}

/** Invitation link -> password -> TOTP -> finish setup, in a fresh browser context. */
async function onboardViaInvite(browser: Browser, label: string, email: string) {
  const context = await newTrackedContext(browser, label);
  const page = await context.newPage();
  const link = await confirmLinkFor(email);
  await page.goto(link.path);
  // Email links land on an interstitial; only the Continue POST spends the token.
  await expect(page).toHaveURL(/\/auth\/accept\?/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accept your invitation');
  await shot(page, `${label}-accept-invitation`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/onboarding\/password/);
  await shot(page, `${label}-choose-password`);
  const password = `Journey-${Date.now()}-Aa9`;
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password').fill(password);
  await page.getByRole('button', { name: 'Save password and continue' }).click();
  await enrolTotpViaUi(page, label);
  await expect(page).toHaveURL(/\/onboarding\/finish/);
  await shot(page, `${label}-finish-setup`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');
  await shot(page, `${label}-home`);
  return { context, page, password };
}

/**
 * SYNTHETIC FIXTURE STEP: there is no assignment UI in this batch, so the test
 * assigns the synthetic Delhi deal to the new person directly in Postgres.
 */
async function assignSyntheticDeal(email: string) {
  const result = await withDb((db) =>
    db.query(
      `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
       select d.id, d.legal_entity_id, p.user_id, 'sales', $3
       from public.deals d cross join public.staff_profiles p
       where d.id = $1 and lower(p.work_email) = lower($2)`,
      [DEAL_ID, email, ADMIN_ID],
    ),
  );
  expect(result.rowCount, 'synthetic assignment inserted').toBe(1);
}

async function expectDealVisible(page: Page, label: string) {
  await page.goto('/app/deals');
  const link = page.getByRole('link', { name: DEAL_REF });
  await expect(link).toBeVisible();
  await shot(page, `${label}-deals-list`);
  await link.click();
  // Direction A header: the reference sits beside the title (customer and trip); still exactly one h1.
  await expect(page).toHaveURL(/\/app\/deals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main')).toContainText(DEAL_REF);
  await shot(page, `${label}-deal-detail`);
}

/** The already-open session must not load deal data any more. */
async function expectBlocked(page: Page, label: string, allowed: RegExp) {
  for (const path of ['/app/deals', `/app/deals/${DEAL_ID}`]) {
    await page.goto(path);
    await expect(page).toHaveURL(allowed);
    await expect(page.locator('body')).not.toContainText(DEAL_REF);
  }
  await shot(page, `${label}-blocked`);
}

/** Purchase's supplier price and agreed cost (Echo-B M1): unique, so Sales' raw HTML can be searched for it. */
const PURCHASE_COST_RUPEES = 25123;
const PURCHASE_COST_TEXT = '25,123';
const PURCHASE_COST_PAISE = '2512300';

test.describe('real stack browser journey (T15)', () => {
  test.skip(!configured, 'Real local Supabase + Mailpit not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL).');
  test.describe.configure({ mode: 'serial' });

  test('invite, onboard, see assigned deal, complete authenticator recovery, deactivation cuts off an open session', async ({ browser }) => {
    test.setTimeout(600_000);
    mkdirSync(shotDir, { recursive: true });
    const stamp = Date.now();

    // SYNTHETIC FIXTURE STEP: the fixture admin's TOTP secret is unknown to the
    // test, so remove any factor left by earlier jobs and enrol a fresh one via the UI.
    await withDb((db) =>
      db.query('delete from auth.mfa_factors where user_id = (select id from auth.users where email = $1)', [ADMIN_EMAIL]),
    );

    const adminContext = await newTrackedContext(browser, 'admin');
    const adminPage = await adminContext.newPage();

    await test.step('fixture admin signs in and enrols TOTP through the UI', async () => {
      await signIn(adminPage, ADMIN_EMAIL, fixturePassword!);
      await enrolTotpViaUi(adminPage, 'admin');
      await expect(adminPage).toHaveURL(/\/app$/);
      await shot(adminPage, 'admin-home');
    });

    const first = { name: `Journey Person ${stamp}`, email: `journey.${stamp}@example.test` };
    await test.step('admin invites a new synthetic person to Delhi Sales', async () => {
      await inviteViaUi(adminPage, first.name, first.email);
      await expect(staffRow(adminPage, first.email)).toContainText('Invited');
      await shot(adminPage, 'admin-invited');
    });

    const user = await test.step('new person opens the Mailpit link, sets password, enrols TOTP, finishes setup', () =>
      onboardViaInvite(browser, 'user1', first.email),
    );

    await test.step('assigned synthetic deal is visible and opens', async () => {
      await assignSyntheticDeal(first.email);
      await expectDealVisible(user.page, 'user1');
    });

    await test.step('admin starts authenticator recovery while the person is signed in', async () => {
      await adminPage.goto('/app/admin/staff');
      const row = staffRow(adminPage, first.email);
      await row.getByText(`Actions for ${first.name}`).click();
      await row.getByLabel('Reason for recovery').fill('Synthetic journey: lost phone, verified in person');
      await row.getByRole('button', { name: 'Start authenticator recovery' }).click();
      await expect(staffRow(adminPage, first.email)).toContainText(/Resetting their authenticator app — step [12] of 3: (removing|waiting)|Done:/, {
        timeout: 30_000,
      });
      await shot(adminPage, 'admin-recovery-started');
    });

    await test.step("the person's open session can no longer load deal data", async () => {
      await expectBlocked(user.page, 'user1-after-recovery', /\/(account-recovery|session-expired)/);
    });

    let newSecret = '';
    let confirmationCode = '';
    await test.step('person signs in again, enrols a new TOTP and gets a confirmation code', async () => {
      // The barrier has second precision; a sign-in in the same second is refused by design.
      await sleep(1_500);
      await signIn(user.page, first.email, user.password);
      newSecret = await enrolTotpViaUi(user.page, 'user1-recovery');
      await expect(user.page).toHaveURL(/\/account-recovery/);
      await expect(user.page.getByRole('heading', { level: 1 })).toHaveText('Set up a new authenticator');
      await shot(user.page, 'user1-recovery-awaiting-registration');
      await user.page.getByRole('button', { name: 'Get my confirmation code' }).click();
      const code = user.page.getByTestId('confirmation-code');
      await expect(code).toBeVisible({ timeout: 30_000 });
      confirmationCode = ((await code.textContent()) ?? '').trim();
      expect(confirmationCode).toMatch(/^[0-9A-Z]{6}$/);
      await shot(user.page, 'user1-recovery-code');
      await user.page.goto('/app/deals');
      await expect(user.page).not.toHaveURL(/\/app\/deals/);
      await expect(user.page.locator('body')).not.toContainText(DEAL_REF);
    });

    await test.step('admin confirms with the synthetic verification method and the code read out', async () => {
      await adminPage.goto('/app/admin/staff');
      const row = staffRow(adminPage, first.email);
      await expect(row).toContainText('Resetting their authenticator app — step 3 of 3: waiting for your confirmation');
      await row.getByText(`Actions for ${first.name}`).click();
      await row.getByLabel('How you verified their identity').selectOption('SYNTHETIC_TEST_CALLBACK');
      await row.getByLabel('Confirmation code').fill(confirmationCode);
      await row.getByLabel('Note').fill('Synthetic journey: code read back over the synthetic callback');
      await shot(adminPage, 'admin-recovery-confirm-form');
      await row.getByRole('button', { name: 'Confirm and restore access' }).click();
      await expect(staffRow(adminPage, first.email)).toContainText('Authenticator app reset finished', { timeout: 30_000 });
      await shot(adminPage, 'admin-recovery-completed');
    });

    await test.step('person must sign in again, then sees the assigned deal with the new authenticator', async () => {
      await user.page.goto('/app/deals');
      await expect(user.page).toHaveURL(/\/(session-expired|sign-in|account-recovery)/);
      await expect(user.page.locator('body')).not.toContainText(DEAL_REF);
      await sleep(1_500);
      await signIn(user.page, first.email, user.password);
      await challengeViaUi(user.page, newSecret);
      await expect(user.page).toHaveURL(/\/app/);
      await expectDealVisible(user.page, 'user1-after-recovery-complete');
    });

    const second = { name: `Journey Leaver ${stamp}`, email: `journey.${stamp}.leaver@example.test` };
    const leaver = await test.step('second synthetic person is invited, onboarded and assigned the deal', async () => {
      await inviteViaUi(adminPage, second.name, second.email);
      const session = await onboardViaInvite(browser, 'user2', second.email);
      await assignSyntheticDeal(second.email);
      await expectDealVisible(session.page, 'user2');
      return session;
    });

    await test.step('admin deactivates the second person while their session is open', async () => {
      await adminPage.goto('/app/admin/staff');
      const row = staffRow(adminPage, second.email);
      await row.getByText(`Actions for ${second.name}`).click();
      await row.getByLabel('Reason for deactivation').fill('Synthetic journey: leaver deactivation check');
      await row.getByRole('button', { name: 'Deactivate staff member' }).click();
      await expect(staffRow(adminPage, second.email)).toContainText(/Deactivated|Done:/, { timeout: 30_000 });
      await shot(adminPage, 'admin-deactivated');
    });

    await test.step("the deactivated person's open session can no longer load deal data", async () => {
      await expectBlocked(leaver.page, 'user2-after-deactivation', /\/(session-expired|access-inactive|sign-in)/);
    });

    await test.step('no Content Security Policy violation anywhere in the journey', async () => {
      expect(cspViolations).toEqual([]);
    });

    await Promise.all([adminContext.close(), user.context.close(), leaver.context.close()]);
  });

  test('Phase 4: Purchase takes a confirmed hotel task, adds a supplier, offer, cost and proof, records the supplier confirmation; Sales sees status only', async ({ browser }) => {
    test.skip(!purchaseConfigured, 'Supabase URL, publishable key or secret key missing for the Purchase journey fixture step.');
    test.setTimeout(420_000);
    mkdirSync(shotDir, { recursive: true });
    const stamp = Date.now();
    const dealRef = `SYN-JRN-${stamp}`;
    const supplierName = `Synthetic Journey Stays ${stamp}`;
    const reference = `SYN-CONF-${stamp}`;
    cspViolations.length = 0;

    // SYNTHETIC FIXTURE STEP: unknown fixture TOTP secrets; remove any factor so
    // this run enrols fresh ones (Sales via the Auth API, Purchase via the UI).
    await withDb((db) =>
      db.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [[SALES_ID, PURCHASE_ID]]),
    );

    const { dealId, taskId, salesSecret } = await test.step('fixture: Sales confirms a synthetic hotel booking (real commands, aal2 Sales session)', () =>
      confirmedHotelTask(dealRef),
    );

    let fileHref = '';
    const purchaseContext = await newTrackedContext(browser, 'purchase');
    const purchase = await purchaseContext.newPage();

    await test.step('Purchase signs in and enrols TOTP through the UI (aal2)', async () => {
      await signIn(purchase, PURCHASE_EMAIL, fixturePassword!);
      await enrolTotpViaUi(purchase, 'purchase');
      await expect(purchase).toHaveURL(/\/app$/);
    });

    await test.step('Purchase adds a supplier through the UI', async () => {
      await purchase.goto('/app/purchase/suppliers');
      await expect(purchase.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible();
      const form = purchase.getByRole('form', { name: 'Add a supplier' });
      await form.getByLabel('Supplier name').fill(supplierName);
      await form.getByLabel('City').fill('Synthetic City');
      await expect(form.getByRole('checkbox', { name: 'Hotel' })).toBeChecked();
      await form.getByRole('button', { name: 'Add supplier' }).click();
      await expect(purchase).toHaveURL(/\/app\/purchase\/suppliers\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
      await expect(purchase.getByRole('heading', { level: 1 })).toHaveText(supplierName);
      await expect(purchase.getByRole('main')).toContainText('Supplier added. Details are marked not verified.');
      await shot(purchase, 'purchase-supplier-added');
    });

    await test.step('Purchase opens the task from the queue and takes it', async () => {
      await purchase.goto('/app/purchase');
      const row = purchase.getByRole('row').filter({ hasText: dealRef });
      // DA-271 status word.
      await expect(row).toContainText('Waiting to be taken');
      await row.getByRole('link', { name: new RegExp(JOURNEY_HOTEL.replace(/[()]/g, '\\$&')) }).click();
      await expect(purchase).toHaveURL(new RegExp(`/app/purchase/${taskId}$`));
      await expect(purchase.getByRole('heading', { level: 1 })).toContainText(JOURNEY_HOTEL);
      await shot(purchase, 'purchase-task-open');
      await purchase.getByRole('button', { name: 'Take this task' }).click();
      await expect(purchase.getByText('In progress · not booked yet').first()).toBeVisible({ timeout: 30_000 });
      await expect(purchase.getByRole('main')).not.toContainText(/selling|margin/i);
      // Batch 4 (DA-16): offers, cost, files and the supplier confirmation are on the Work tab.
      await purchase.goto(`/app/purchase/${taskId}?tab=work`);
      await expect(purchase.getByRole('main')).toContainText('Not confirmed yet · hotel not booked');
      await expect(purchase.getByRole('main')).not.toContainText(/selling|margin/i);
      await shot(purchase, 'purchase-task-taken');
    });

    await test.step('Purchase adds a supplier offer and proposes the agreed cost', async () => {
      await purchase.getByText('Add a supplier offer', { exact: true }).click();
      const offer = purchase.getByRole('form', { name: 'Add a supplier offer' });
      await offer.getByLabel('Supplier', { exact: true }).selectOption({ label: supplierName });
      // A cost no Sales figure can contain (budget ₹30,000, selling ₹76,543.21): searched for in Sales' raw HTML below.
      await offer.getByLabel('Supplier price for the stay (₹)').fill(String(PURCHASE_COST_RUPEES));
      await offer.getByRole('button', { name: 'Add offer' }).click();
      await expect(offer.getByRole('status')).toContainText('Supplier offer added.', { timeout: 30_000 });
      await expect(purchase.getByRole('list', { name: 'Supplier offers' })).toContainText(supplierName);

      await purchase.getByText('Propose the agreed cost', { exact: true }).click();
      const cost = purchase.getByRole('form', { name: 'Propose a cost' });
      await expect(cost.getByLabel('Agreed cost (₹)')).not.toHaveValue('');
      await cost.getByLabel('Agreed cost (₹)').fill(String(PURCHASE_COST_RUPEES));
      await cost.getByRole('button', { name: 'Propose cost' }).click();
      await expect(cost.getByRole('status')).toContainText('Cost proposed as version 1. Nothing is payable yet.', { timeout: 30_000 });
      await expect(purchase.getByRole('list', { name: 'Cost versions, newest first' })).toContainText('version 1');
      await shot(purchase, 'purchase-offer-and-cost');
    });

    await test.step('Purchase uploads two other Purchase files in a row; the file kind stays as chosen (form reset)', async () => {
      const upload = purchase.getByRole('form', { name: 'Upload a Purchase file' });
      await expect(upload.getByLabel('What is this file?')).toHaveValue('supplier_confirmation');
      // Not the first option ("Supplier quote"): a reset lands on the first option of a select, so it would prove nothing.
      await upload.getByLabel('What is this file?').selectOption('other');
      for (const name of ['purchase-note-1.pdf', 'purchase-note-2.pdf']) {
        // The second upload changes nothing but the file: it must be stored with the kind shown.
        await upload.getByLabel('File', { exact: true }).setInputFiles({
          name,
          mimeType: 'application/pdf',
          buffer: Buffer.from(`%PDF-1.4\n% Synthetic journey Purchase file ${name}. Not a real booking.\n%%EOF\n`),
        });
        await upload.getByRole('button', { name: 'Upload file' }).click();
        await expect(purchase.getByRole('list', { name: 'Purchase files' })).toContainText(name, { timeout: 30_000 });
        await expect(upload.getByLabel('What is this file?')).toHaveValue('other');
        await expect(upload.getByLabel('File', { exact: true })).toHaveValue('');
      }
      const kinds = await withDb((db) => db.query<{ kind: string }>(`select kind from public.purchase_evidence where task_id = $1 and file_name like 'purchase-note-%' order by file_name`, [taskId]));
      expect(kinds.rows.map((r) => r.kind)).toEqual(['other', 'other']);
    });

    await test.step('Purchase uploads a small synthetic PDF as the supplier confirmation', async () => {
      const upload = purchase.getByRole('form', { name: 'Upload a Purchase file' });
      await upload.getByLabel('What is this file?').selectOption('supplier_confirmation');
      await upload.getByLabel('File', { exact: true }).setInputFiles({
        name: 'supplier-confirmation.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n% Synthetic journey supplier confirmation. Not a real booking.\n%%EOF\n'),
      });
      await upload.getByRole('button', { name: 'Upload file' }).click();
      await expect(upload.getByRole('status')).toContainText('File uploaded.', { timeout: 30_000 });
      const files = purchase.getByRole('list', { name: 'Purchase files' });
      // Earlier files are on screen too: check the confirmation's own row.
      await expect(files.getByRole('listitem').filter({ hasText: 'supplier-confirmation.pdf' })).toContainText('Stored', { timeout: 30_000 });
      fileHref = (await files.getByRole('link', { name: 'supplier-confirmation.pdf' }).getAttribute('href')) ?? '';
      expect(fileHref).toMatch(/^\/app\/purchase\/files\/[0-9a-f-]{36}$/);
      // Purchase download: authorized, then a short-lived signed Storage URL (never the app origin).
      const download = await purchase.request.get(fileHref, { maxRedirects: 0 });
      expect(download.status()).toBe(302);
      expect(new URL(download.headers()['location'] ?? '', 'http://invalid.test').origin).toBe(new URL(supabaseUrl!).origin);
      await expect(purchase.getByRole('main')).toContainText('Everything needed is here. Record the supplier’s confirmation.');
      await shot(purchase, 'purchase-proof-stored');
    });

    await test.step('Purchase records the supplier confirmation through the dialog', async () => {
      await purchase.getByRole('button', { name: 'Record supplier confirmation' }).click();
      const dialog = purchase.getByRole('dialog', { name: 'Record that the supplier confirmed this hotel?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Go back' })).toBeFocused();
      await dialog.getByLabel('Supplier confirmation reference').fill(reference);
      await shot(purchase, 'purchase-confirm-dialog');
      await dialog.getByRole('button', { name: 'Record supplier confirmation' }).click();
      const main = purchase.getByRole('main');
      await expect(main).toContainText(`Confirmed · reference ${reference}`, { timeout: 30_000 });
      await expect(main).toContainText('No payment, bill or invoice was created.');
      await expect(purchase.getByRole('list', { name: 'Cost versions, newest first' })).toContainText('Committed cost · version 2');
      await expect(purchase.getByRole('button', { name: 'Record supplier confirmation' })).toHaveCount(0);
      await shot(purchase, 'purchase-supplier-confirmed');
    });

    const salesContext = await newTrackedContext(browser, 'sales');
    const sales = await salesContext.newPage();

    await test.step('Sales sees only "Confirmed by supplier": no supplier, reference, cost or Purchase files', async () => {
      await signIn(sales, SALES_EMAIL, fixturePassword!);
      await challengeViaUi(sales, salesSecret);
      await expect(sales).toHaveURL(/\/app$/);
      // Direction A: the service rows live on the Deal's "Services and tasks" tab.
      // Batch 4: every task tab address too (a status-only viewer gets Details for any ?tab=).
      for (const path of [`/app/deals/${dealId}?tab=services`, `/app/purchase/${taskId}`, `/app/purchase/${taskId}?tab=work`, `/app/purchase/${taskId}?tab=files`, `/app/purchase/${taskId}?tab=history`]) {
        await sales.goto(path);
        const main = sales.getByRole('main');
        await expect(main).toContainText('Confirmed by supplier');
        const html = await (await sales.request.get(path)).text();
        for (const hidden of [reference, supplierName, 'Supplier offers', 'Cost history', 'Purchase files', 'supplier-confirmation.pdf', PURCHASE_COST_TEXT]) {
          await expect(main, `${path}: ${hidden}`).not.toContainText(hidden);
          expect(html, `${path} raw HTML: ${hidden}`).not.toContain(hidden);
        }
        // The cost in paise, as it would travel in a page payload.
        expect(html, `${path} raw HTML: cost in paise`).not.toContain(PURCHASE_COST_PAISE);
        await shot(sales, `sales-sees-status-${path.includes('deals') ? 'deal' : `task${path.includes('?tab=') ? `-${path.split('?tab=')[1]}` : ''}`}`);
      }
      // The hidden Purchase facts are absent on every Deal tab, rendered and in the raw page HTML.
      for (const tab of ['', '?tab=services', '?tab=quotations', '?tab=documents', '?tab=money', '?tab=history']) {
        const path = `/app/deals/${dealId}${tab}`;
        await sales.goto(path);
        const main = sales.getByRole('main');
        const html = await (await sales.request.get(path)).text();
        for (const hidden of [reference, supplierName, 'Supplier offers', 'Cost history', 'Purchase files', 'supplier-confirmation.pdf']) {
          await expect(main, `${path}: ${hidden}`).not.toContainText(hidden);
          expect(html, `${path} raw HTML: ${hidden}`).not.toContain(hidden);
        }
      }
      // Sales never receives Purchase files: the same download link is a plain 404.
      const refused = await sales.request.get(fileHref, { maxRedirects: 0 });
      expect(refused.status()).toBe(404);
    });

    await test.step('no Content Security Policy violation in the Purchase journey', async () => {
      expect(cspViolations).toEqual([]);
    });

    await Promise.all([purchaseContext.close(), salesContext.close()]);
  });

  test('sign-in, MFA, session refresh with hardened cookies, and password recovery behind the authenticator', async ({ browser }) => {
    test.skip(!purchaseConfigured, 'Supabase URL, publishable key or secret key missing for the fixture user step.');
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    cspViolations.length = 0;
    const stamp = Date.now();
    const person = { name: `Journey Recovery ${stamp}`, email: `journey.${stamp}.recovery@example.test` };
    const firstPassword = fixturePassword!;
    const newPassword = `Journey-Reset-${stamp}-Aa9`;

    await test.step('fixture: an active synthetic Delhi Sales person (Auth admin API + Postgres)', async () => {
      const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
      const created = await admin.auth.admin.createUser({ email: person.email, password: firstPassword, email_confirm: true });
      if (created.error) throw new Error(`fixture user creation failed (${created.error.status ?? 'no status'})`);
      const userId = created.data.user!.id;
      await withDb(async (db) => {
        await db.query(
          `insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values ($1, $2, $3, 'active', now())`,
          [userId, person.name, person.email],
        );
        await db.query(
          `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
           select $1, b.legal_entity_id, b.id, 'sales', 'active'
           from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
           where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`,
          [userId],
        );
      });
    });

    const context = await newTrackedContext(browser, 'recovery-person');
    const page = await context.newPage();

    await test.step('a wrong password gets the one generic refusal', async () => {
      await signIn(page, person.email, 'Wrong-Password-2026-Aa9');
      await expect(page.getByRole('alert').filter({ hasText: 'Email or password is incorrect' })).toBeVisible();
      await expect(page).toHaveURL(/\/sign-in/);
    });

    const secret = await test.step('sign-in with the password, then TOTP enrolment, reaches the app (aal2)', async () => {
      await signIn(page, person.email, firstPassword);
      const enrolled = await enrolTotpViaUi(page, 'recovery-person');
      await expect(page).toHaveURL(/\/app$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');
      return enrolled;
    });

    await test.step('auth cookies are HttpOnly and SameSite=Lax (not Secure on the plain-http loopback site)', async () => {
      await expectHardenedAuthCookies(context, false);
    });

    await test.step('an expired access token is refreshed by the server; the person stays signed in', async () => {
      const before = await readSessionCookie(context);
      // Mark the stored session expired: the next request must refresh it.
      await writeSessionCookie(context, { ...before, expires_at: Math.floor(Date.now() / 1000) - 60 });
      await page.goto('/app/deals');
      await expect(page).toHaveURL(/\/app\/deals$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const after = await readSessionCookie(context);
      expect(after.refresh_token, 'refresh token rotated').not.toBe(before.refresh_token);
      expect(after.access_token, 'new access token').not.toBe(before.access_token);
      expect(after.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
      await expectHardenedAuthCookies(context, false);
      await shot(page, 'recovery-person-after-refresh');
    });

    await test.step('password recovery: emailed link, then the authenticator, and only then the new password', async () => {
      const recoveryContext = await newTrackedContext(browser, 'recovery-link');
      const r = await recoveryContext.newPage();
      await r.goto('/sign-in');
      await r.getByRole('link', { name: 'Forgot your password?' }).click();
      await expect(r).toHaveURL(/\/forgot-password/);
      await r.getByLabel('Work email').fill(person.email);
      await r.getByRole('button', { name: 'Send reset email' }).click();
      await expect(r.getByRole('status').filter({ hasText: 'we have asked the mail service to send a reset link' })).toBeVisible();
      const link = await confirmLinkPath(mailpitUrl, person.email, 'recovery');
      await r.goto(link.path);
      await expect(r).toHaveURL(/\/auth\/accept\?/);
      await expect(r.getByRole('heading', { level: 1 })).toHaveText('Reset your password');
      await r.getByRole('button', { name: 'Continue' }).click();
      // AUDIT-013: the account has a working authenticator, so the recovery
      // session (aal1) must pass the challenge before any password change.
      await expect(r).toHaveURL(/\/mfa\/challenge\?next=%2Fonboarding%2Fpassword/);
      await r.goto('/onboarding/password');
      await expect(r).toHaveURL(/\/mfa\/challenge/);
      await shot(r, 'recovery-challenge-first');
      await challengeViaUi(r, secret);
      await expect(r).toHaveURL(/\/onboarding\/password/);
      await r.getByLabel('New password', { exact: true }).fill(newPassword);
      await r.getByLabel('Confirm new password').fill(newPassword);
      await r.getByRole('button', { name: 'Save password and continue' }).click();
      await expect(r).toHaveURL(/\/app$/);
      await shot(r, 'recovery-new-password-saved');
      await recoveryContext.close();
    });

    await test.step('the old password no longer works; the new one does, with the authenticator', async () => {
      const fresh = await newTrackedContext(browser, 'recovery-after');
      const f = await fresh.newPage();
      await signIn(f, person.email, firstPassword);
      await expect(f.getByRole('alert').filter({ hasText: 'Email or password is incorrect' })).toBeVisible();
      await signIn(f, person.email, newPassword);
      await challengeViaUi(f, secret);
      await expect(f).toHaveURL(/\/app$/);
      await expect(f.getByRole('heading', { level: 1 })).toContainText('Welcome');
      await fresh.close();
    });

    await test.step('no Content Security Policy violation in the sign-in, refresh and recovery journey', async () => {
      expect(cspViolations).toEqual([]);
    });

    await context.close();
  });

  test('recovery with a lost provider result and failed or unknown cleanup: same-case controls finish it and keep the new authenticator', async ({ browser }) => {
    test.skip(!purchaseConfigured, 'Supabase URL, publishable key or secret key missing for the fixture user step.');
    test.setTimeout(600_000);
    mkdirSync(shotDir, { recursive: true });
    cspViolations.length = 0;
    const stamp = Date.now();
    const person = { name: `Journey Cleanup ${stamp}`, email: `journey.${stamp}.cleanup@example.test` };
    let userId = '';
    const openContexts: BrowserContext[] = [];

    // FAULT INJECTION on the disposable CI stack only: the server's privileged
    // calls run as service_role, so withdrawing one EXECUTE grant makes exactly
    // that step fail (42501) the way a lost write or provider problem would.
    // Every grant is restored in `finally`, whatever happens.
    const FAULTS = {
      providerResult: 'public.record_mfa_recovery_provider_result(uuid, boolean, text)',
      deletionPlan: 'public.get_mfa_recovery_deletion_plan(uuid, text)',
      cleanupResult: 'public.record_mfa_recovery_cleanup_result(uuid, boolean, text)',
    } as const;
    const fault = (fn: string, on: boolean) =>
      withDb((db) => db.query(on ? `revoke execute on function ${fn} from service_role` : `grant execute on function ${fn} to service_role`));
    const caseRow = () =>
      withDb(async (db) => (await db.query<{ id: string; status: string; cleanup_completed_at: Date | null; cleanup_error: string | null; new_factor_id: string | null }>(
        `select id, status, cleanup_completed_at, cleanup_error, new_factor_id from public.mfa_recovery_cases
         where user_id = $1 order by opened_at desc limit 1`, [userId],
      )).rows[0]!);

    try {
      await test.step('fixture: an active synthetic Delhi Sales person (Auth admin API + Postgres)', async () => {
        const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
        const created = await admin.auth.admin.createUser({ email: person.email, password: fixturePassword!, email_confirm: true });
        if (created.error) throw new Error(`fixture user creation failed (${created.error.status ?? 'no status'})`);
        userId = created.data.user!.id;
        await withDb(async (db) => {
          await db.query(
            `insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values ($1, $2, $3, 'active', now())`,
            [userId, person.name, person.email],
          );
          await db.query(
            `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
             select $1, b.legal_entity_id, b.id, 'sales', 'active'
             from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
             where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`,
            [userId],
          );
        });
        await assignSyntheticDeal(person.email);
      });

      const userContext = await newTrackedContext(browser, 'cleanup-person');
      openContexts.push(userContext);
      const userPage = await userContext.newPage();
      await test.step('the person signs in and enrols an authenticator (the one recovery will remove)', async () => {
        await signIn(userPage, person.email, fixturePassword!);
        await enrolTotpViaUi(userPage, 'cleanup-person');
        await expect(userPage).toHaveURL(/\/app$/, { timeout: 30_000 });
        await expectDealVisible(userPage, 'cleanup-person-before');
      });

      await withDb((db) =>
        db.query('delete from auth.mfa_factors where user_id = (select id from auth.users where email = $1)', [ADMIN_EMAIL]),
      );
      const adminContext = await newTrackedContext(browser, 'cleanup-admin');
      openContexts.push(adminContext);
      const adminPage = await adminContext.newPage();
      await test.step('fixture admin signs in and enrols TOTP through the UI', async () => {
        await signIn(adminPage, ADMIN_EMAIL, fixturePassword!);
        await enrolTotpViaUi(adminPage, 'cleanup-admin');
        await expect(adminPage).toHaveURL(/\/app$/);
      });
      const openActions = async () => {
        await adminPage.goto('/app/admin/staff');
        const row = staffRow(adminPage, person.email);
        await row.getByText(`Actions for ${person.name}`).click();
        return row;
      };

      await test.step('provider result cannot be recorded: the case stays pending and the outcome is reported as unknown', async () => {
        await fault(FAULTS.providerResult, true);
        const row = await openActions();
        await row.getByLabel('Reason for recovery').fill('Synthetic journey: lost phone, result write fails');
        await row.getByRole('button', { name: 'Start authenticator recovery' }).click();
        await expect(staffRow(adminPage, person.email)).toContainText('outcome is unknown', { timeout: 30_000 });
        expect((await caseRow()).status).toBe('provider_pending');
        await fault(FAULTS.providerResult, false);
        const fresh = await openActions();
        await expect(fresh).toContainText('Resetting their authenticator app — step 1 of 3: removing the old app');
        await expect(fresh.getByRole('button', { name: 'Start authenticator recovery' })).toHaveCount(0);
        await shot(adminPage, 'cleanup-provider-result-unknown');
      });

      // A second tab keeps the pending-case control open; it goes stale once the case moves on.
      const stalePage = await adminContext.newPage();
      await test.step('a second admin tab shows the same pending-case control (it will go stale)', async () => {
        await stalePage.goto('/app/admin/staff');
        const row = staffRow(stalePage, person.email);
        await row.getByText(`Actions for ${person.name}`).click();
        await expect(row.getByRole('button', { name: `Check and finish removing the old authenticator for ${person.name}` })).toBeVisible();
      });

      await test.step('admin checks and finishes the same case; it moves on without starting a new recovery', async () => {
        const row = staffRow(adminPage, person.email);
        await row.getByRole('button', { name: `Check and finish removing the old authenticator for ${person.name}` }).click();
        await expect(staffRow(adminPage, person.email)).toContainText('Resetting their authenticator app — step 2 of 3: waiting for their new app', { timeout: 30_000 });
        const cases = await withDb(async (db) => (await db.query<{ n: number }>(
          'select count(*)::int as n from public.mfa_recovery_cases where user_id = $1', [userId])).rows[0]!.n);
        expect(cases, 'one recovery case, reconciled in place').toBe(1);
      });

      let newSecret = '';
      let confirmationCode = '';
      await test.step('person signs in again, enrols a new authenticator and gets a confirmation code', async () => {
        await sleep(1_500);
        await signIn(userPage, person.email, fixturePassword!);
        newSecret = await enrolTotpViaUi(userPage, 'cleanup-person-new');
        await expect(userPage).toHaveURL(/\/account-recovery/);
        await userPage.getByRole('button', { name: 'Get my confirmation code' }).click();
        const code = userPage.getByTestId('confirmation-code');
        await expect(code).toBeVisible({ timeout: 30_000 });
        confirmationCode = ((await code.textContent()) ?? '').trim();
        expect(confirmationCode).toMatch(/^[0-9A-Z]{6}$/);
      });

      await test.step('the stale tab resumes the old provider step: refused, nothing changes, the new authenticator survives', async () => {
        const factorsBefore = await withDb(async (db) => (await db.query<{ id: string }>(
          `select id from auth.mfa_factors where user_id = $1 and status = 'verified' order by id`, [userId])).rows);
        expect(factorsBefore, 'the newly enrolled authenticator').toHaveLength(1);
        const row = staffRow(stalePage, person.email);
        await row.getByRole('button', { name: `Check and finish removing the old authenticator for ${person.name}` }).click();
        await expect(staffRow(stalePage, person.email)).toContainText('moved on since the page loaded. Nothing was changed.', { timeout: 30_000 });
        const after = await withDb(async (db) => ({
          factors: (await db.query<{ id: string }>(
            `select id from auth.mfa_factors where user_id = $1 and status = 'verified' order by id`, [userId])).rows,
          cases: (await db.query<{ n: number }>('select count(*)::int as n from public.mfa_recovery_cases where user_id = $1', [userId])).rows[0]!.n,
          status: (await caseRow()).status,
        }));
        expect(after.factors).toEqual(factorsBefore);
        expect(after.cases).toBe(1);
        expect(after.status).toBe('awaiting_admin_confirmation');
        await shot(stalePage, 'cleanup-stale-resume-refused');
        await stalePage.close();
      });

      await test.step('confirmation succeeds but cleanup fails: shown as failed, blocked, with a same-case retry only', async () => {
        await fault(FAULTS.deletionPlan, true);
        const row = await openActions();
        await row.getByLabel('How you verified their identity').selectOption('SYNTHETIC_TEST_CALLBACK');
        await row.getByLabel('Confirmation code').fill(confirmationCode);
        await row.getByRole('button', { name: 'Confirm and restore access' }).click();
        await expect(staffRow(adminPage, person.email)).toContainText('Reset confirmed: removing their other authenticator apps failed', { timeout: 30_000 });
        await fault(FAULTS.deletionPlan, false);
        const c = await caseRow();
        expect(c.status).toBe('completed');
        expect(c.cleanup_error).toMatch(/^plan_lookup/);
        const fresh = await openActions();
        await expect(fresh).not.toContainText('Authenticator app reset finished');
        await expect(fresh.getByRole('button', { name: 'Start authenticator recovery' })).toHaveCount(0);
        await expect(fresh.getByLabel('Confirmation code')).toHaveCount(0);
        await expect(fresh.getByRole('button', { name: `Retry removing other authenticators for ${person.name}` })).toBeVisible();
        await shot(adminPage, 'cleanup-failed');
      });

      await test.step('the person stays blocked while cleanup is not recorded successful', async () => {
        await sleep(1_500);
        await userContext.clearCookies();
        await signIn(userPage, person.email, fixturePassword!);
        // A full aal2 sign-in with the NEW authenticator: only the cleanup gate can block it now.
        await expect(userPage).toHaveURL(/\/mfa\/challenge/, { timeout: 30_000 });
        await challengeViaUi(userPage, newSecret);
        await expect(userPage).not.toHaveURL(/\/mfa\/challenge/, { timeout: 30_000 });
        await expectBlocked(userPage, 'cleanup-person-blocked', /\/(session-expired|account-recovery)/);
      });

      await test.step('retry whose result cannot be recorded is reported as unknown, never as success', async () => {
        await fault(FAULTS.cleanupResult, true);
        const row = await openActions();
        await row.getByRole('button', { name: `Retry removing other authenticators for ${person.name}` }).click();
        await expect(staffRow(adminPage, person.email)).toContainText('outcome is unknown', { timeout: 30_000 });
        await fault(FAULTS.cleanupResult, false);
        const c = await caseRow();
        expect(c.cleanup_error, 'the earlier failure is still the last recorded result').toMatch(/^plan_lookup/);
        await adminPage.goto('/app/admin/staff');
        await expect(staffRow(adminPage, person.email)).not.toContainText('Authenticator app reset finished');
      });

      await test.step('retry on the same case succeeds: an extra authenticator is removed, the new one is kept', async () => {
        // SYNTHETIC FIXTURE STEP: a second, VERIFIED authenticator enrolled through the Auth API (the
        // real threat: a rogue factor), so the successful retry must remove it and keep the registered one.
        const extraFactorId = await (async () => {
          const client = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
          const signedIn = await client.auth.signInWithPassword({ email: person.email, password: fixturePassword! });
          if (signedIn.error) throw new Error(`person sign-in failed (${signedIn.error.status ?? 'no status'})`);
          const keep = (await caseRow()).new_factor_id!;
          const verified = await client.auth.mfa.challengeAndVerify({ factorId: keep, code: await totpCode(newSecret) });
          if (verified.error) throw new Error('person TOTP verification failed');
          const extra = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `journey-extra-${stamp}` });
          if (extra.error) throw new Error('extra factor enrolment failed');
          const extraVerified = await client.auth.mfa.challengeAndVerify({ factorId: extra.data.id, code: await totpCode(extra.data.totp.secret) });
          if (extraVerified.error) throw new Error('extra factor verification failed');
          await client.auth.signOut({ scope: 'local' });
          return extra.data.id;
        })();
        const before = await withDb(async (db) => (await db.query<{ n: number }>(
          `select count(*)::int as n from auth.mfa_factors where user_id = $1 and status = 'verified'`, [userId])).rows[0]!.n);
        expect(before, 'the new and the extra authenticator are both verified before the retry').toBe(2);
        const row = await openActions();
        await row.getByRole('button', { name: `Retry removing other authenticators for ${person.name}` }).click();
        await expect(staffRow(adminPage, person.email)).toContainText('Authenticator app reset finished', { timeout: 30_000 });
        const c = await caseRow();
        expect(c.cleanup_error).toBeNull();
        expect(c.cleanup_completed_at).not.toBeNull();
        const factors = await withDb(async (db) => (await db.query<{ id: string; status: string }>(
          'select id, status from auth.mfa_factors where user_id = $1', [userId])).rows);
        expect(factors).toEqual([{ id: c.new_factor_id, status: 'verified' }]);
        expect(factors.map((f) => f.id)).not.toContain(extraFactorId);
        const retries = await withDb(async (db) => (await db.query<{ n: number }>(
          `select count(*)::int as n from public.audit_events where action = 'staff.mfa_recovery_cleanup_retry_requested'
           and actor_user_id = $1 and target_id = $2`, [ADMIN_ID, c.id])).rows[0]!.n);
        expect(retries, 'each retry is audited against the requesting administrator').toBe(2);
        await shot(adminPage, 'cleanup-retried-completed');
      });

      await test.step('the person signs in with the new authenticator and sees their deal again', async () => {
        await sleep(1_500);
        await userContext.clearCookies();
        await signIn(userPage, person.email, fixturePassword!);
        await challengeViaUi(userPage, newSecret);
        await expect(userPage).toHaveURL(/\/app/, { timeout: 30_000 });
        await expect(userPage).not.toHaveURL(/\/mfa\//);
        await expectDealVisible(userPage, 'cleanup-person-after');
      });

      await test.step('no Content Security Policy violation in the cleanup journey', async () => {
        expect(cspViolations).toEqual([]);
      });
    } finally {
      // Restore every grant even if one restore fails, then report all failures.
      const restoreErrors: unknown[] = [];
      for (const fn of Object.values(FAULTS)) {
        try {
          await fault(fn, false);
        } catch (error) {
          restoreErrors.push(error);
        }
      }
      await Promise.all(openContexts.map((c) => c.close().catch(() => undefined)));
      if (restoreErrors.length > 0) throw new AggregateError(restoreErrors, 'restoring recovery grants failed');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Purchase journey fixtures (synthetic, local stack only)
// ---------------------------------------------------------------------------

async function rpcOk<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn} failed (${error.code ?? 'no code'})`);
  return data as T;
}

/**
 * SYNTHETIC FIXTURE STEP: the Sales booking screens are covered elsewhere, so
 * Sales confirms the booking through the same database commands the UI calls,
 * under Sales' own aal2 session (TOTP enrolled through the Auth API; the
 * secret is reused for the Sales browser sign-in below). Only the acceptance
 * proof object is written with the local service-role key, as the server does.
 */
async function confirmedHotelTask(dealRef: string): Promise<{ dealId: string; taskId: string; salesSecret: string }> {
  const dealId = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
       select b.legal_entity_id, b.id, $1, 'Synthetic Purchase journey deal', $2
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
      [dealRef, SALES_ID],
    );
    expect(rows, 'synthetic journey deal inserted').toHaveLength(1);
    return rows[0]!.id;
  });

  const sales = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
  const signedIn = await sales.auth.signInWithPassword({ email: SALES_EMAIL, password: fixturePassword! });
  if (signedIn.error) throw new Error(`Sales sign-in failed (${signedIn.error.status ?? 'no status'})`);
  const enrolled = await sales.auth.mfa.enroll({ factorType: 'totp', friendlyName: `journey-sales-${Date.now()}` });
  if (enrolled.error) throw new Error('Sales TOTP enrolment failed');
  const salesSecret = enrolled.data.totp.secret;
  const verified = await sales.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(salesSecret) });
  if (verified.error) throw new Error('Sales TOTP verification failed');

  const opened = await rpcOk<{ versionId: string; rowVersion: number }>(sales, 'booking_open_draft', { p_deal_id: dealId });
  await rpcOk(sales, 'booking_save_draft', {
    p_version_id: opened.versionId,
    p_expected_row_version: opened.rowVersion,
    p_facts: {
      hotelName: JOURNEY_HOTEL,
      city: 'Synthetic City',
      checkIn: '2026-12-10',
      checkOut: '2026-12-12',
      rooms: 1,
      roomType: null,
      mealPlan: null,
      adults: 2,
      children: 0,
      inclusions: null,
      specialRequests: null,
      purchaseBudgetPaise: '3000000',
    },
    p_selling_total_paise: '7654321',
    p_selling_total_provided: true,
  });
  const proof = new Uint8Array(1024).fill(37);
  const ev = await rpcOk<{ evidenceId: string; objectPath: string }>(sales, 'booking_begin_evidence', {
    p_version_id: opened.versionId,
    p_kind: 'acceptance_message',
    p_file_name: 'acceptance.pdf',
    p_mime: 'application/pdf',
    p_size_bytes: proof.byteLength,
    p_sha256: 'c'.repeat(64),
  });
  const stored = await createClient(supabaseUrl!, secretKey!, { auth: noPersist })
    .storage.from('booking-evidence')
    .upload(ev.objectPath, new Blob([proof], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
  if (stored.error) throw new Error('acceptance proof upload failed');
  await rpcOk(sales, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true });
  const ready = await rpcOk<{ contentHash: string }>(sales, 'booking_readiness', { p_version_id: opened.versionId });
  const confirmed = await rpcOk<{ taskId: string }>(sales, 'booking_confirm', {
    p_version_id: opened.versionId,
    p_expected_content_hash: ready.contentHash,
  });
  await sales.auth.signOut({ scope: 'local' });
  return { dealId, taskId: confirmed.taskId, salesSecret };
}
