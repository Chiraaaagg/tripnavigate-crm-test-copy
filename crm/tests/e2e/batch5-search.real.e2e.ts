import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, istToday, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Direction A Batch 5 browser journey: search across Leads and Deals
 * (contracts.md §E, DEC-58, FP-011, FP-017), against a REAL local Supabase
 * stack served by the production build (playwright.real.config.ts, project
 * real-journey). Never against a hosted database.
 *
 *   1. A Sales user with more Deals than one list page finds a Deal that is
 *      not on page 1, by its reference and by words of its title (the
 *      "Customer and trip" column), and opens it from the result.
 *   2. "Show more" loads the next 20 matches without repeating rows.
 *   3. A Deal in another branch with the same title words is never found
 *      (by title or by its reference): the database list policies decide.
 *   4. The search words never appear in the page address.
 *   5. Sales finds a Lead by its reference in the Leads search (Echo-B L6).
 *   6. A Purchase user gets no Leads: the Leads page shows the no-permission
 *      words and no search box.
 *
 * Fixture steps (synthetic, local only): the Accounts-journey entity and its
 * Sales user, 55 plain synthetic Deals owned by Sales in the Sales branch,
 * one synthetic Deal in the head-office branch owned by its Accounts user, one Lead
 * owned by Sales (stored as the Bitrix sync stores it, under a fresh intake
 * manifest of the synthetic intake config), and one run Purchase user. Nothing is restored: the rows are synthetic and tagged.
 * Skips without a real stack; fails (never skips) when REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the Batch 5 search journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Batch 5 search journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const SALES_BRANCH = 'b0000000-0000-4000-8000-0000000000f2';
const OTHER_BRANCH = 'b0000000-0000-4000-8000-0000000000f1';
const SALES = { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test' } as const;
/** Accounts Finance A, head-office branch (accounts_journey.sql): owns the other branch's Deal. */
const OTHER_BRANCH_ACCOUNTS = 'a0000000-0000-4000-8000-000000000101';
const PORTAL = 'SYNTHETIC_MEMBER_0001';
const SYNTHETIC_INTAKE_CONFIG = 'c0000000-0000-4000-8000-000000000001';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);
const LIST_PAGE_SIZE = 50;
const FILLER = 55;

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the Batch 5 journey needs the 'test' deployment environment").toBe('test');
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
  });
}

/**
 * Plain synthetic Deals (no Bitrix number, so the list puts them after every
 * Bitrix Deal, ordered by id). The target gets the highest id of the run, so
 * it is the last of the run's Deals in the list and never on page 1.
 */
async function insertDeals(tag: string) {
  const hex = tag.padStart(8, '0').slice(-8);
  const id = (prefix: string, n: number) => `${prefix}${hex.slice(0, 4)}-${hex.slice(4, 8)}-4000-8000-${String(n).padStart(12, '0')}`;
  return db(async (client) => {
    for (let i = 0; i < FILLER; i += 1) {
      await client.query(
        `insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id) values ($1, $2, $3, $4, $5, $6)`,
        [id('fff5', i), ENTITY_ID, SALES_BRANCH, `SYN-S5-${tag}-${String(i).padStart(2, '0')}`, `Synthetic Zanskar ${tag} trip ${i}`, SALES.id],
      );
    }
    const target = { id: id('ffff', 999), reference: `SYN-S5-${tag}-TARGET`, title: `Synthetic Ladakh honeymoon ${tag}` };
    await client.query(
      `insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id) values ($1, $2, $3, $4, $5, $6)`,
      [target.id, ENTITY_ID, SALES_BRANCH, target.reference, target.title, SALES.id],
    );
    // Same title words, another branch, owned by that branch's Accounts user (a synthetic Deal must have an owner): Sales may not see it.
    const hidden = { reference: `SYN-S5-${tag}-HIDDEN`, title: `Synthetic Ladakh honeymoon ${tag} (head office)` };
    await client.query(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id) values ($1, $2, $3, $4, $5)`,
      [ENTITY_ID, OTHER_BRANCH, hidden.reference, hidden.title, OTHER_BRANCH_ACCOUNTS],
    );
    return { target, hidden };
  });
}

/** Bitrix stand-in: a Lead header owned by Sales, as the sync stores it (same steps as b12-quote-to-booking.real.e2e.ts). */
async function bitrixLead(sourceLeadId: number, title: string): Promise<string> {
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const recorded = await admin.rpc('integration_record_bitrix_event', { p_member_id: PORTAL, p_event_type: 'ONCRMLEADADD', p_deal_id: sourceLeadId, p_source_ts: Math.floor(Date.now() / 1000) });
  if (recorded.error) throw new Error(`inbox ONCRMLEADADD: ${recorded.error.message}`);
  const inboxId = (recorded.data as { inboxId: string }).inboxId;
  return db(async (client) => {
    await client.query(
      `select public.integration_manifest_close(m.id, 'batch5-search') from public.intake_manifests m
       where m.config_id = $1 and m.source_object = 'lead' and m.status = 'active'`,
      [SYNTHETIC_INTAKE_CONFIG],
    );
    const { rows: m } = await client.query<{ r: { manifestId: string } }>(
      `select public.integration_manifest_create($1, 'lead', 'WEBFORM', $2::date,
         $2::date::timestamp at time zone 'Asia/Kolkata', ($2::date::timestamp at time zone 'Asia/Kolkata') + interval '1 day',
         $3::bigint[], 'batch5-search') as r`,
      [SYNTHETIC_INTAKE_CONFIG, istToday(), [sourceLeadId]],
    );
    const { rows } = await client.query<{ id: string }>(
      `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
         source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
       values ($1, $2, 'BXL-' || $3::bigint, $4, $5, $6, $3, 'NEW', 'WEBFORM', now(), now(), now(), now(), $7, $8) returning id`,
      [ENTITY_ID, SALES_BRANCH, sourceLeadId, title, SALES.id, PORTAL, inboxId, m[0]!.r.manifestId],
    );
    expect(rows, `synthetic Bitrix Lead BXL-${sourceLeadId}`).toHaveLength(1);
    return rows[0]!.id;
  });
}

async function runPurchaseUser(tag: string): Promise<string> {
  const email = `batch5-search.purchase.${tag}@example.test`;
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const created = await admin.auth.admin.createUser({ email, password: fixturePassword!, email_confirm: true });
  if (created.error) throw new Error(`could not create ${email}: ${created.error.message}`);
  const id = created.data.user!.id;
  await db(async (client) => {
    await client.query(`insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values ($1, $2, $3, 'active', now())`, [id, `Synthetic Purchase ${tag}`, email]);
    await client.query(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status) values ($1, $2, $3, 'purchase', 'active')`, [id, ENTITY_ID, SALES_BRANCH]);
  });
  return email;
}

async function signInAndEnrol(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/);
  return page;
}

// Accessible names from luna-batch5-props.md and Mercury DA-300 to DA-314; the results block by its slot
// (the section "Search results" contains the table region "Deal search results", Echo-B M1).
const searchBox = (p: Page, noun: 'deals' | 'leads') => p.getByRole('searchbox', { name: `Search ${noun}`, exact: true });
const results = (p: Page) => p.locator('[data-slot="search-results"]');
const resultRows = (p: Page) => results(p).getByRole('row');

/** Search and wait for the answer: the results block (rows or the no-result state), no longer busy. */
async function search(page: Page, words: string, noun: 'deals' | 'leads' = 'deals') {
  await searchBox(page, noun).fill(words);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(results(page)).toBeVisible({ timeout: 30_000 });
  await expect(results(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
}

test.describe('Batch 5 search across Leads and Deals (real local stack)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test('Sales finds a Deal that is not on page 1 by reference and by title, never another branch, and a Lead by reference; Purchase gets no Leads', async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');

    const { target, hidden } = await test.step('fixture: entity, Sales user, 55 Sales Deals, a target Deal and another branch\'s Deal', async () => {
      await loadFixture(fixtureFile);
      return insertDeals(tag);
    });

    const sales = await signInAndEnrol(await csp.track(browser, 'sales'), SALES.email);

    await test.step('the target is not on page 1 of the Deals list', async () => {
      await sales.goto('/app/deals');
      const visible = await db(async (client) => {
        const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from public.deals where owner_user_id = $1 and removed_at is null`, [SALES.id]);
        return Number(rows[0]!.n);
      });
      expect(visible, 'Sales sees more Deals than one list page').toBeGreaterThan(LIST_PAGE_SIZE);
      await expect(sales.locator('main')).not.toContainText(target.reference);
    });

    await test.step('by reference: the result row is the target, and opens it', async () => {
      await search(sales, target.reference);
      await expect(resultRows(sales).filter({ hasText: target.reference })).toHaveCount(1);
      await expect(resultRows(sales).filter({ hasText: target.reference })).toContainText(target.title);
      await expect(resultRows(sales).filter({ hasText: hidden.reference })).toHaveCount(0);
      // The words travel only in the POST body.
      expect(sales.url()).not.toContain(tag);
      expect(sales.url()).not.toContain('Ladakh');
    });

    await test.step('by title words: the target, never the other branch\'s Deal with the same words', async () => {
      await sales.getByRole('button', { name: 'Clear search' }).click();
      await search(sales, `Ladakh honeymoon ${tag}`);
      await expect(resultRows(sales).filter({ hasText: target.reference })).toHaveCount(1);
      await expect(resultRows(sales).filter({ hasText: hidden.reference })).toHaveCount(0);
      await expect(resultRows(sales).filter({ hasText: '(head office)' })).toHaveCount(0);
      expect(sales.url()).not.toContain('Ladakh');
    });

    await test.step('the other branch\'s reference finds nothing', async () => {
      await sales.getByRole('button', { name: 'Clear search' }).click();
      await search(sales, hidden.reference);
      // The no-result line repeats the typed words, so check rows, never the whole page text.
      await expect(resultRows(sales)).toHaveCount(0);
      await expect(results(sales)).toContainText('No deal you can see');
      await expect(sales.locator('main')).not.toContainText('(head office)');
    });

    await test.step('Show more loads the next matches without repeating rows', async () => {
      await sales.getByRole('button', { name: 'Clear search' }).click();
      await search(sales, `Zanskar ${tag}`);
      const rowsWithTag = resultRows(sales).filter({ hasText: new RegExp(`SYN-S5-${tag}-\\d\\d`) });
      await expect(rowsWithTag).toHaveCount(20);
      await sales.locator('[data-slot="search-more"]').click();
      await expect(rowsWithTag).toHaveCount(40, { timeout: 30_000 });
      const refs = await rowsWithTag.allTextContents();
      expect(new Set(refs).size, 'no row repeats across pages').toBe(refs.length);
    });

    await test.step('open the target from a search result', async () => {
      await sales.getByRole('button', { name: 'Clear search' }).click();
      await search(sales, target.reference);
      await resultRows(sales).filter({ hasText: target.reference }).getByRole('link').first().click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${target.id}`));
    });

    await test.step('Leads: Sales finds a Lead by its reference (Echo-B L6)', async () => {
      const sourceLeadId = 880_000_000 + Number(tag.slice(-6));
      const leadId = await bitrixLead(sourceLeadId, `Synthetic Spiti enquiry ${tag}`);
      await sales.goto('/app/leads');
      await search(sales, `BXL-${sourceLeadId}`, 'leads');
      await expect(resultRows(sales).filter({ hasText: `BXL-${sourceLeadId}` })).toHaveCount(1);
      await expect(resultRows(sales).filter({ hasText: `BXL-${sourceLeadId}` })).toContainText(`Synthetic Spiti enquiry ${tag}`);
      expect(sales.url()).not.toContain(String(sourceLeadId));
      await resultRows(sales).filter({ hasText: `BXL-${sourceLeadId}` }).getByRole('link').first().click();
      await expect(sales).toHaveURL(new RegExp(`/app/leads/${leadId}`));
    });

    await test.step('Purchase gets no Leads: the no-permission words and no search box', async () => {
      const purchase = await signInAndEnrol(await csp.track(browser, 'purchase'), await runPurchaseUser(tag));
      await purchase.goto('/app/leads');
      await expect(purchase.getByRole('status').filter({ hasText: 'Leads are not part of your role. Sales handles leads in Bitrix.' })).toBeVisible();
      await expect(searchBox(purchase, 'leads')).toHaveCount(0);
      await expect(purchase.locator('main')).not.toContainText('BXL-');
      await expect(purchase.getByRole('table')).toHaveCount(0);
    });

    expect(csp.violations).toEqual([]);
  });
});
