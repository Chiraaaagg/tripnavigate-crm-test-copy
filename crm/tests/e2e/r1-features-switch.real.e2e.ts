import { expect, test } from '@playwright/test';
import { cspRecorder, enrolTotpViaUi, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl } from '../helpers/test-env.mjs';

/**
 * UX redesign R1, real journey (build plan 4.4; owner answers D9 and Q1): a
 * Super Admin changes one Features switch end to end on the local stack,
 * leaving the reason empty. Production build (playwright.real.config.ts,
 * project real-journey), strict nonce CSP, synthetic fixture admin only;
 * never against a hosted database.
 *
 * Steps: sign in, enrol an authenticator, open Settings · Features, press
 * "Change" on Referral drafts, check the confirm dialog (Cancel focused
 * first, the reason marked optional), confirm with the box empty, see the
 * result line and the row in its new state, and read the audit row: person,
 * change, time and the reason "No reason given". Restores the switch.
 * Fails on any Content Security Policy violation.
 *
 * Skips without a real stack; fails (never skips) when REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const configured = Boolean(fixturePassword && databaseUrl);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD or TEST_DATABASE_URL is missing: the R1 Features journey must run, not skip.');
}
if (configured && !isLoopbackDatabaseUrl(databaseUrl)) {
  throw new Error('The R1 Features journey runs only against a loopback database.');
}

const ADMIN_EMAIL = 'admin.jodhpur@example.test';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000007';
const TITLE = 'Referral drafts';
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

test.describe('R1: a Super Admin changes a Features switch with no reason', () => {
  test.skip(!configured, 'Real local Supabase not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL).');

  test('Change → confirm with an empty reason → saved as "No reason given" with the person and the time', async ({ browser }) => {
    test.setTimeout(240_000);
    let before: boolean | null = null;
    const started = new Date();
    await db(async (client) => {
      // SYNTHETIC FIXTURE STEP: the fixture admin's TOTP secret is unknown, so remove any factor and enrol a fresh one.
      await client.query('delete from auth.mfa_factors where user_id = $1', [ADMIN_ID]);
      const { rows } = await client.query<{ referral_drafts: boolean }>('select referral_drafts from public.workflow_settings where id');
      before = rows[0]?.referral_drafts ?? null;
    });
    expect(before, 'the workflow settings row exists').not.toBeNull();
    const target = before ? 'off' : 'on';

    const csp = cspRecorder();
    const context = await csp.track(browser, 'admin');
    const page = await context.newPage();
    try {
      await test.step('the Super Admin signs in and enrols an authenticator', async () => {
        await signInViaUi(page, ADMIN_EMAIL, fixturePassword!);
        await enrolTotpViaUi(page);
        await expect(page).toHaveURL(/\/app$/);
      });

      const row = page.locator('[data-slot="setting-row"][data-key="referral_drafts"]');
      await test.step('Settings · Features shows the switch as a row with its state in words', async () => {
        await page.goto('/app/admin/workflow');
        // The Settings frame's area heading (h1); the page repeats the name as its own section heading (h2).
        await expect(page.getByRole('heading', { level: 1, name: 'Features' })).toBeVisible();
        await expect(row).toContainText(TITLE);
        await expect(row).toContainText(`State: ${before ? 'On' : 'Off'}`);
      });

      await test.step('Change opens one confirm dialog: Cancel first, reason optional', async () => {
        await row.getByRole('button', { name: `Change ${TITLE}` }).click();
        const dialog = page.getByRole('alertdialog', { name: `Turn ${TITLE} ${target}?` });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await expect(dialog.getByLabel('Why are you changing it?')).toHaveValue('');
        await expect(dialog).toContainText('(optional)');
        await dialog.getByRole('button', { name: `Turn ${TITLE} ${target}` }).click();
        await expect(dialog).toHaveCount(0);
        await expect(row.getByRole('status')).toContainText(`${TITLE} is now ${target}. Recorded with your name and the time (no reason given).`);
      });

      await test.step('the row shows the new state after the page reloads', async () => {
        await page.reload();
        await expect(row).toContainText(`State: ${target === 'on' ? 'On' : 'Off'}`);
        await expect(row).toContainText('by you');
      });

      await test.step('the audit row names the person, the change and the time, with "No reason given"', async () => {
        await db(async (client) => {
          const { rows } = await client.query<{ actor_user_id: string; reason: string; occurred_at: Date; details: { changes?: Record<string, { from: boolean; to: boolean }> } }>(
            `select actor_user_id, reason, occurred_at, details from public.audit_events
              where action = 'settings.workflow_changed' and occurred_at >= $1 order by id desc limit 1`,
            [started],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ actor_user_id: ADMIN_ID, reason: 'No reason given' });
          expect(rows[0]!.details.changes?.referral_drafts).toEqual({ from: before, to: target === 'on' });
          expect(rows[0]!.occurred_at.getTime()).toBeGreaterThanOrEqual(started.getTime() - 5_000);
        });
      });

      expect(csp.violations, 'no Content Security Policy violation').toEqual([]);
    } finally {
      await context.close();
      // Restore the switch for later journeys (audited reason, owner SQL in the local stack only).
      await db(async (client) => {
        await client.query(`select set_config('tripnavigate.change_reason', $1, false)`, ['r1-features-switch.real.e2e.ts: restore the synthetic switch after the run']);
        await client.query('update public.workflow_settings set referral_drafts = $1 where id', [before]);
      });
    }
  });
});
