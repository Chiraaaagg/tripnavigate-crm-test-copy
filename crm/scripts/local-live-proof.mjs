#!/usr/bin/env node
// Phase 5 end-to-end proof in a REAL browser (installed Google Chrome via
// Playwright) against the LOCAL stack: Supabase + `npm run dev` on :3000 + cron.
//
//   node scripts/local-live-proof.mjs accounts   bootstrap the local test admin,
//        onboard it (password + TOTP via otpauth), invite + onboard the local
//        test salesperson, invite the owner's admin (OWNER_ADMIN_EMAIL, required
//        for this step) and set its password (MFA is left for the owner to scan).
//   node scripts/local-live-proof.mjs prove      admin sees all deals + waiting;
//        link test salesperson to a real Bitrix user; salesperson sees only
//        that user's deals; unlink -> empty; re-link -> back. Screenshots.
//   node scripts/local-live-proof.mjs counts     Super Admin counts in the UI
//        (Home, Deals pages, Bitrix sync full check) vs the database.
//   node scripts/local-live-proof.mjs watch      keeps the salesperson's and the
//        admin's deal lists open and reports when the deal count / titles
//        change without a reload (for the live Bitrix create/edit test).
//
// Local test accounts live in .env.test-accounts.json (git-ignored, local
// only). Deal titles are blurred in screenshots. Never prints secrets.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3000';
const MAILPIT = 'http://127.0.0.1:54324';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ACCOUNTS = new URL('../.env.test-accounts.json', import.meta.url);
const SHOTS = new URL('../../docs/implementation/history/local-live-screenshots/', import.meta.url);
// The owner's real admin address is never written in source: pass it in the environment.
const OWNER_ADMIN_EMAIL = process.env.OWNER_ADMIN_EMAIL;
const TEST_ADMIN = { email: 'local.test.admin@example.test', name: 'Local Test Admin' };
const TEST_SALES = { email: 'local.test.sales@example.test', name: 'Local Test Sales' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`proof  ${m}`);
const readAccounts = () => (existsSync(ACCOUNTS) ? JSON.parse(readFileSync(ACCOUNTS, 'utf8')) : {});
const saveAccounts = (a) => writeFileSync(ACCOUNTS, `${JSON.stringify(a, null, 2)}\n`);
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

async function q(sql, params = []) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

const lastStep = new Map();
async function totp(secret) {
  const t = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret.replace(/\s/g, '')), digits: 6, period: 30 });
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 30_000);
    const left = 30_000 - (now % 30_000);
    if ((lastStep.get(secret) ?? -1) >= step || left < 4_000) {
      await sleep(left + 500);
      continue;
    }
    lastStep.set(secret, step);
    return t.generate({ timestamp: now });
  }
}

/** `next dev` compiles each route on first use; allow for that. */
async function newCtx(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  context.setDefaultTimeout(120_000);
  context.setDefaultNavigationTimeout(180_000);
  return context;
}

let shotNo = 0;
async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  if (await page.locator('h1', { hasText: 'Something went wrong' }).count()) throw new Error(`error page on ${page.url()}`);
  // Let the live indicator settle (Live / Updating every 30 s).
  await page.locator('.live-indicator', { hasNotText: 'Connecting' }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  // Blur deal titles (customer names) and Bitrix person emails before capturing.
  await page.addStyleTag({ content: 'td.deal-title, .deal-title, td .hint-email { filter: blur(5px) !important; }' }).catch(() => undefined);
  await page.evaluate(() => {
    for (const table of document.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
      // Deal titles (customer names) and Bitrix people (employee names / emails).
      const cols = heads
        .map((h, i) => (h === 'Title' || (h ?? '').startsWith('Bitrix user') ? i : -1))
        .filter((i) => i >= 0);
      for (const row of table.querySelectorAll('tbody tr')) for (const col of cols) row.children[col]?.classList.add('deal-title');
    }
    for (const sel of document.querySelectorAll('select[name="bitrixUserId"]')) sel.classList.add('deal-title');
    const h1 = document.querySelector('h1');
    if (h1 && /^BX-\d+:/.test(h1.textContent ?? '')) h1.classList.add('deal-title');
  });
  shotNo += 1;
  const file = new URL(`${String(shotNo).padStart(2, '0')}-${name}.png`, SHOTS);
  await page.screenshot({ path: fileURLToPath(file), fullPage: true });
  log(`screenshot ${file.pathname.split('/').pop()}`);
}

async function confirmLink(to, notIds = new Set()) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const body = await (await fetch(`${MAILPIT}/api/v1/messages?limit=100`)).json();
    const m = (body.messages ?? []).find((x) => !notIds.has(x.ID) && x.To.some((t) => t.Address.toLowerCase() === to));
    if (m) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      const match = `${full.HTML ?? ''}\n${full.Text ?? ''}`.match(/https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/);
      if (!match) throw new Error(`no confirm link in the email to ${to}`);
      const url = new URL(match[0].replace(/&amp;/g, '&'));
      return `${url.pathname}${url.search}`;
    }
    await sleep(1_000);
  }
  throw new Error(`no email to ${to} in Mailpit`);
}

async function acceptAndSetPassword(page, email) {
  await page.goto(BASE + (await confirmLink(email)));
  await page.waitForURL(/\/auth\/accept\?/);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/onboarding\/password/);
  await page.waitForLoadState('networkidle');
  const password = `Local-${randomBytes(9).toString('base64url')}-Aa9`;
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password').fill(password);
  await page.getByRole('button', { name: 'Save password and continue' }).click();
  await page.waitForURL(/\/mfa\/enroll/);
  return password;
}

async function enrolAndFinish(page) {
  // In `next dev` the button may be clicked before hydration; retry until the key appears.
  const summary = page.getByText('Cannot scan? Enter this setup key instead');
  for (let i = 0; i < 20 && !(await summary.isVisible()); i += 1) {
    await page.getByRole('button', { name: 'Set up authenticator app' }).click().catch(() => undefined);
    await summary.waitFor({ timeout: 5_000 }).catch(() => undefined);
  }
  await summary.click();
  const secret = ((await page.locator('p.secret').textContent()) ?? '').trim();
  await page.getByLabel('6-digit code').fill(await totp(secret));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.waitForURL(/\/onboarding\/finish/);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.waitForURL(/\/app$/);
  return secret;
}

async function signIn(browser, account) {
  const context = await newCtx(browser);
  const page = await context.newPage();
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel('Work email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/mfa\/challenge/);
  await page.getByLabel('6-digit code').fill(await totp(account.totpSecret));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.waitForURL(/\/app/);
  return { context, page };
}

async function invite(page, person, roleLabel, branchLabel) {
  await page.goto(`${BASE}/app/admin/staff`);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Send invitation' }) });
  await form.getByLabel('Full name').fill(person.name);
  await form.getByLabel('Work email').fill(person.email);
  await form.getByLabel('Branch', { exact: true }).selectOption({ label: branchLabel });
  await form.getByLabel('Role', { exact: true }).selectOption({ label: roleLabel });
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await form.getByRole('status').filter({ hasText: /Invitation handed|already existed/ }).waitFor({ timeout: 60_000 });
}

async function dealRows(page) {
  await page.goto(`${BASE}/app/deals`);
  try {
    await page.getByRole('heading', { level: 1, name: 'Deals' }).waitFor({ timeout: 60_000 });
  } catch (error) {
    const h1 = await page.locator('h1').first().textContent().catch(() => null);
    throw new Error(`deals page did not load: url ${page.url()}, h1 ${JSON.stringify(h1)}`);
  }
  const rows = page.locator('table tbody tr');
  return rows.count();
}

/** Resume an onboarding that stopped after the password step (sign in -> enrol -> finish). */
async function resumeOnboarding(browser, pending) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Work email').fill(pending.email);
  await page.getByLabel('Password', { exact: true }).fill(pending.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/mfa\/enroll/);
  await page.waitForLoadState('networkidle');
  const totpSecret = await enrolAndFinish(page);
  await ctx.close();
  return totpSecret;
}

// ---------------------------------------------------------------------------

async function accounts() {
  const acc = readAccounts();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    if (!acc.testAdmin && acc.pending?.email === TEST_ADMIN.email) {
      acc.testAdmin = { ...TEST_ADMIN, password: acc.pending.password, totpSecret: await resumeOnboarding(browser, acc.pending) };
      delete acc.pending;
      saveAccounts(acc);
      log('test admin is active (aal2, resumed)');
    }
    if (!acc.testAdmin) {
      log('bootstrapping the local test admin (bootstrap-first-admin.mjs)');
      execFileSync(
        process.execPath,
        ['scripts/bootstrap-first-admin.mjs', '--email', TEST_ADMIN.email, '--display-name', TEST_ADMIN.name, '--branch-code', 'JDH', '--confirm-project-ref', 'local'],
        {
          env: { ...process.env, APP_ENV: 'local', SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY, BOOTSTRAP_OPERATOR: 'Claude Code local proof', SITE_URL: BASE },
          stdio: 'inherit',
        },
      );
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      const password = await acceptAndSetPassword(page, TEST_ADMIN.email);
      saveAccounts({ ...acc, pending: { email: TEST_ADMIN.email, password } });
      const totpSecret = await enrolAndFinish(page);
      acc.testAdmin = { ...TEST_ADMIN, password, totpSecret };
      saveAccounts(acc);
      await ctx.close();
      log('test admin is active (aal2)');
    }
    const admin = await signIn(browser, acc.testAdmin);
    if (!acc.testSales && acc.pending?.email === TEST_SALES.email) {
      acc.testSales = { ...TEST_SALES, password: acc.pending.password, totpSecret: await resumeOnboarding(browser, acc.pending) };
      delete acc.pending;
      saveAccounts(acc);
    }
    if (!acc.testSales) {
      await invite(admin.page, TEST_SALES, 'Sales', 'Jodhpur (head office)');
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      const password = await acceptAndSetPassword(page, TEST_SALES.email);
      saveAccounts({ ...acc, pending: { email: TEST_SALES.email, password } });
      const totpSecret = await enrolAndFinish(page);
      acc.testSales = { ...TEST_SALES, password, totpSecret };
      saveAccounts(acc);
      await ctx.close();
      log('test salesperson is active (aal2)');
    }
    if (!acc.ownerAdmin) {
      if (!OWNER_ADMIN_EMAIL) throw new Error('OWNER_ADMIN_EMAIL is required to invite the owner admin');
      await invite(admin.page, { email: OWNER_ADMIN_EMAIL, name: 'Webmaster' }, 'Super Admin', 'Jodhpur (head office)');
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      const password = await acceptAndSetPassword(page, OWNER_ADMIN_EMAIL);
      // Stop here: the owner scans their own QR code on the next sign-in.
      acc.ownerAdmin = { email: OWNER_ADMIN_EMAIL, password, mfa: 'not enrolled: owner scans the QR at first sign-in' };
      saveAccounts(acc);
      await ctx.close();
      log(`owner admin ${OWNER_ADMIN_EMAIL}: password set, MFA left for the owner`);
    }
    await admin.context.close();
  } finally {
    await browser.close();
  }
}

async function prove() {
  const acc = readAccounts();
  if (!acc.testAdmin || !acc.testSales) throw new Error('run "accounts" first');
  const [salesRow] = await q('select user_id from public.staff_profiles where work_email = $1', [TEST_SALES.email]);
  // A real Bitrix responsible with a handful of stored deals (readable screenshots).
  const candidates = await q(`select source_assigned_by_id::text as id, count(*)::int as n from public.deals
                              where source_system = 'bitrix' group by 1 order by (count(*) between 2 and 15) desc, count(*) desc limit 1`);
  if (candidates.length === 0) throw new Error('no stored deals yet; wait for the first sync');
  const bitrixUser = acc.linkedBitrixUser ?? candidates[0].id;
  acc.linkedBitrixUser = bitrixUser;
  saveAccounts(acc);
  const expected = (await q(`select count(*)::int as n from public.deals where source_assigned_by_id = $1`, [bitrixUser]))[0].n;
  const total = (await q(`select count(*)::int as n from public.deals`))[0].n;
  log(`stored deals: ${total}; Bitrix user #${bitrixUser} is responsible for ${expected}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = {};
  try {
    const admin = await signIn(browser, acc.testAdmin);
    const sales = await signIn(browser, acc.testSales);

    // Make sure the salesperson starts unlinked.
    await q('select 1'); // connectivity
    await admin.page.goto(`${BASE}/app/admin/staff`);
    const row = () => admin.page.getByRole('row').filter({ hasText: TEST_SALES.email });
    if (await row().getByRole('button', { name: /^Unlink/ }).count()) {
      await row().getByRole('button', { name: /^Unlink/ }).click();
      await row().getByText('Link Bitrix user').waitFor({ timeout: 30_000 });
    }

    results.adminRows = await dealRows(admin.page);
    const waiting = await admin.page.getByText('Waiting for owner', { exact: true }).count();
    await shot(admin.page, 'admin-all-deals-with-waiting-for-owner');
    await admin.page.goto(`${BASE}/app/admin/integration`);
    await admin.page.getByRole('heading', { name: 'Deals waiting for an owner' }).waitFor({ timeout: 60_000 });
    results.integrationPageOk = await admin.page.getByRole('heading', { name: 'Sync settings' }).isVisible();
    await shot(admin.page, 'admin-bitrix-sync-page');
    results.salesBefore = await dealRows(sales.page);
    await shot(sales.page, 'salesperson-before-link-sees-nothing');

    // Grant: link the salesperson to the Bitrix user (UI).
    await admin.page.goto(`${BASE}/app/admin/staff`);
    await row().getByText('Link Bitrix user').click();
    await row().locator('select[name="bitrixUserId"]').selectOption(bitrixUser);
    await row().getByRole('button', { name: 'Link and give access' }).click();
    await row().getByRole('button', { name: /^Unlink/ }).waitFor({ timeout: 30_000 });
    results.staffPageOk = await admin.page.getByRole('heading', { name: 'Add staff from Bitrix' }).isVisible();
    await shot(admin.page, 'admin-staff-linked');
    results.salesAfterLink = await dealRows(sales.page);
    await shot(sales.page, 'salesperson-sees-only-own-deals');
    const relations = await sales.page.locator('table tbody tr td:nth-child(5)').allTextContents();
    results.salesAllOwned = relations.every((t) => t.trim() === 'You own this deal');

    // Revoke: unlink (UI) -> the salesperson's list empties on the next refresh.
    await admin.page.goto(`${BASE}/app/admin/staff`);
    await row().getByRole('button', { name: /^Unlink/ }).click();
    await row().getByText('Link Bitrix user').waitFor({ timeout: 30_000 });
    results.salesAfterRevoke = await dealRows(sales.page);
    await shot(sales.page, 'salesperson-after-revoke-empty');

    // Re-grant.
    await row().getByText('Link Bitrix user').click();
    await row().locator('select[name="bitrixUserId"]').selectOption(bitrixUser);
    await row().getByRole('button', { name: 'Link and give access' }).click();
    await row().getByRole('button', { name: /^Unlink/ }).waitFor({ timeout: 30_000 });
    results.salesAfterRegrant = await dealRows(sales.page);
    await shot(sales.page, 'salesperson-after-regrant');

    results.expected = expected;
    results.total = total;
    results.waitingShownToAdmin = waiting;
    results.salesSeesWaiting = await sales.page.getByText('Waiting for owner', { exact: true }).count();
    console.log(JSON.stringify(results, null, 2));
    const ok =
      results.adminRows === Math.min(total, 500) &&
      results.salesBefore === 0 &&
      results.salesAfterLink === expected &&
      results.salesAllOwned &&
      results.salesAfterRevoke === 0 &&
      results.salesAfterRegrant === expected &&
      results.salesSeesWaiting === 0 &&
      results.integrationPageOk &&
      results.staffPageOk;
    log(ok ? 'PROOF PASSED' : 'PROOF FAILED');
    if (!ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function watch() {
  const acc = readAccounts();
  const minutes = Number(process.argv[3] ?? 10);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const admin = await signIn(browser, acc.testAdmin);
    await admin.page.goto(`${BASE}/app/deals`);
    const indicator = await admin.page.locator('.live-indicator').textContent({ timeout: 20_000 });
    const snapshot = async () =>
      admin.page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('table tbody tr')].map((tr) => [tr.children[0]?.textContent?.trim() ?? '', tr.textContent ?? '']),
        ),
      );
    let before = await snapshot();
    log(`watching /app/deals as admin WITHOUT reloading (indicator: ${indicator?.trim()}); ${minutes} min`);
    const started = Date.now();
    while (Date.now() - started < minutes * 60_000) {
      await sleep(500);
      const now = await snapshot();
      for (const [ref, text] of Object.entries(now)) {
        if (!(ref in before)) log(`NEW ${ref} seen at ${new Date().toISOString()}`);
        else if (before[ref] !== text) log(`CHANGED ${ref} seen at ${new Date().toISOString()}`);
      }
      before = now;
    }
  } finally {
    await browser.close();
  }
}

/** Live refresh on real deals: salesperson page stays open (no reload) while the admin links / unlinks them. */
async function liveGrant() {
  const acc = readAccounts();
  const bitrixUser = acc.linkedBitrixUser;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const admin = await signIn(browser, acc.testAdmin);
    const sales = await signIn(browser, acc.testSales);
    const row = () => admin.page.getByRole('row').filter({ hasText: TEST_SALES.email });
    await admin.page.goto(`${BASE}/app/admin/staff`);
    if (await row().getByRole('button', { name: /^Unlink/ }).count()) {
      await row().getByRole('button', { name: /^Unlink/ }).click();
      await row().getByText('Link Bitrix user').waitFor();
    }
    await sales.page.goto(`${BASE}/app/deals`);
    await sales.page.locator('.live-indicator', { hasText: 'Live' }).waitFor({ timeout: 30_000 });
    const rows = () => sales.page.locator('table tbody tr').count();
    log(`salesperson page open, indicator Live, rows ${await rows()}`);
    await row().getByText('Link Bitrix user').click();
    await row().locator('select[name="bitrixUserId"]').selectOption(bitrixUser);
    const t0 = Date.now();
    await row().getByRole('button', { name: 'Link and give access' }).click();
    for (;;) {
      if ((await rows()) > 0) break;
      if (Date.now() - t0 > 120_000) throw new Error('deals did not appear within 120 s');
      await sleep(100);
    }
    const appeared = Date.now() - t0;
    log(`GRANT: ${await rows()} deals appeared on the salesperson's open page ${appeared} ms after the admin clicked Link (no reload)`);
    await shot(sales.page, 'live-grant-appeared-without-reload');
    console.log(JSON.stringify({ grantAppearedMs: appeared, rows: await rows() }));
  } finally {
    await browser.close();
  }
}

/**
 * Super Admin counts in the real UI: Home total, Deals "Showing X-Y of N" and
 * pages, and the Bitrix sync page full check ("Bitrix: N · CRM: N"). Compares
 * them with the database. Screenshots blur deal titles.
 */
async function counts() {
  const acc = readAccounts();
  if (!acc.testAdmin) throw new Error('run "accounts" first');
  const stored = (await q(`select count(*)::int as n from public.deals where removed_at is null`))[0].n;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page } = await signIn(browser, acc.testAdmin);
    await page.goto(`${BASE}/app`);
    const home = (await page.locator('dd').first().textContent())?.trim();
    await page.goto(`${BASE}/app/deals`);
    const caption = (await page.locator('table caption').textContent())?.trim();
    const rows = await page.locator('tbody tr').count();
    const firstTen = (await page.locator('tbody tr td:first-child').allTextContents()).slice(0, 10).map((t) => t.trim());
    await page.goto(`${BASE}/app/deals?sort=id_asc`);
    const firstTenAsc = (await page.locator('tbody tr td:first-child').allTextContents()).slice(0, 10).map((t) => t.trim());
    await page.goto(`${BASE}/app/deals`);
    const pager = (await page.locator('nav.pager').textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim();
    await shot(page, 'superadmin-deals-page-1');
    await page.goto(`${BASE}/app/deals?page=2`);
    const caption2 = (await page.locator('table caption').textContent().catch(() => ''))?.trim();
    await page.goto(`${BASE}/app/admin/integration`);
    const check = (await page.locator('[aria-labelledby="full-check-heading"]').textContent())?.replace(/\s+/g, ' ').trim();
    const glance = (await page.locator('[aria-label="Automatic sync"]').locator('xpath=..').textContent())?.replace(/\s+/g, ' ').trim();
    await shot(page, 'superadmin-bitrix-sync-counts');
    console.log(JSON.stringify({ storedNotRemoved: stored, homeVisible: home, dealsCaption: caption, rowsOnPage1: rows, firstTen, firstTenAsc, pager, page2Caption: caption2, syncGlance: glance, fullCheck: check }, null, 2));
  } finally {
    await browser.close();
  }
}

const mode = process.argv[2];
if (mode === 'counts') await counts();
else if (mode === 'accounts') await accounts();
else if (mode === 'prove') await prove();
else if (mode === 'watch') await watch();
else if (mode === 'live-grant') await liveGrant();
else {
  console.error('usage: node scripts/local-live-proof.mjs accounts|prove|watch [minutes]');
  process.exit(2);
}
