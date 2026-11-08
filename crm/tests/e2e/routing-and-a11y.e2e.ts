import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

test.describe('unauthenticated routing', () => {
  test('protected staff pages redirect to sign-in without a session', async ({ page }) => {
    for (const path of ['/app', '/app/deals', '/app/deals/d0000000-0000-4000-8000-000000000001', '/app/leads', '/app/leads/c6000000-0000-4000-8000-000000000001', '/app/admin/staff', '/app/admin/integration']) {
      const response = await page.goto(path);
      expect(response?.ok()).toBe(true);
      await expect(page).toHaveURL(/\/sign-in\?next=/);
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    }
  });

  test('a stale or forged session cookie is treated as an ended session', async ({ page, context }) => {
    await context.addCookies([
      { name: 'sb-127-auth-token', value: 'base64-eyJmb3JnZWQiOnRydWV9', domain: '127.0.0.1', path: '/' },
    ]);
    await page.goto('/app/deals');
    await expect(page).toHaveURL(/\/session-expired$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your session has ended');
  });

  test('MFA, onboarding and recovery pages require a session', async ({ page }) => {
    for (const path of ['/mfa/enroll', '/mfa/challenge', '/onboarding/password', '/onboarding/finish', '/account-recovery']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in(\?.*)?$/);
    }
  });

  test('sign-in links to the forgot-password page', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reset your password');
    await expect(page.getByLabel('Work email')).toBeVisible();
  });

  test('session-ended page covers expiry and revocation without claiming instant provider deletion', async ({ page }) => {
    await page.goto('/session-expired');
    const main = page.locator('main');
    await expect(main).toContainText('Sign out of all devices');
    await expect(main).toContainText('authenticator recovery');
    await expect(main).toContainText('deactivated');
  });

  test('email links land on a Continue form that POSTs the token (scanners cannot spend it)', async ({ page }) => {
    for (const type of ['invite', 'recovery']) {
      await page.goto(`/auth/accept?type=${type}&token_hash=synthetic_token_hash_0123456789`);
      const form = page.locator('form[method="post"][action="/auth/confirm"]');
      await expect(form.locator('input[name="type"]')).toHaveValue(type);
      await expect(form.locator('input[name="token_hash"]')).toHaveValue('synthetic_token_hash_0123456789');
      await expect(form.getByRole('button', { name: 'Continue' })).toBeVisible();
    }
    for (const bad of ['type=signup&token_hash=synthetic_token_hash_0123456789', 'type=invite&token_hash=short', 'type=invite']) {
      await page.goto(`/auth/accept?${bad}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link cannot be used');
      await expect(page.locator('main').getByRole('alert')).toContainText('Error:');
      await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    }
  });

  test('global sign-out with a provider failure says what was and was not done', async ({ page }) => {
    await page.goto('/signed-out?scope=global&provider=failed');
    const alert = page.locator('main').getByRole('alert');
    await expect(alert).toContainText('Database access to CRM data was revoked for all of your sessions');
    await expect(alert).toContainText('could not confirm signing out your other devices');
    await expect(alert).toContainText('Sign out of all devices');
  });

  test('an unconfirmed local sign-out never claims the person signed out', async ({ page }) => {
    await page.goto('/signed-out?provider=failed');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign-out not confirmed');
    const alert = page.locator('main').getByRole('alert');
    await expect(alert).toContainText('this browser may still be signed in');
    await expect(page.locator('main')).not.toContainText('You have been signed out');
  });

  test('global sign-out wording is accurate', async ({ page }) => {
    await page.goto('/signed-out?scope=global');
    const main = page.locator('main');
    await expect(main).toContainText('signed out here and on every other device');
    await expect(main).toContainText('at their next request');
    await expect(main).not.toContainText(/instantly|immediately deleted|all tokens/i);
  });

  test('email links of other types are refused without a way to continue', async ({ page }) => {
    await page.goto('/auth/confirm?token_hash=abc&type=signup');
    await expect(page).toHaveURL(/\/(sign-in\?notice=link_invalid|auth\/accept\?)/);
    await expect(page.locator('main')).toContainText(/That link is invalid or has expired\.|The link is incomplete or invalid\./);
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  });

  test('security headers are present and the framework is not advertised', async ({ request }) => {
    const res = await request.get('/sign-in');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-powered-by']).toBeUndefined();
  });
});

const publicPages = [
  '/sign-in',
  '/forgot-password',
  '/session-expired',
  '/signed-out',
  '/signed-out?scope=global',
  '/signed-out?scope=global&provider=failed',
  '/signed-out?provider=failed',
  '/auth/accept?type=invite&token_hash=synthetic_token_hash_0123456789',
  '/auth/accept?type=recovery&token_hash=synthetic_token_hash_0123456789',
  '/auth/accept?type=signup&token_hash=x',
  '/access-inactive',
  '/mfa/recovery',
];
const galleryStates = [
  'sign-in-error',
  'onboarding-password',
  'mfa-enroll-start',
  'mfa-enroll-qr',
  'mfa-challenge',
  'mfa-challenge-error',
  'finish-onboarding',
  'home-sales',
  'home-accounts',
  'deals-sales',
  'deals-manager-branch-grant',
  'deals-empty',
  'deal-detail-sales',
  'deal-detail-purchase',
  'deal-not-found',
  'my-access-manager',
  'admin-staff',
  'admin-staff-recovery',
  'admin-staff-recovery-no-method',
  'admin-grants',
  'account-recovery-provider-pending',
  'account-recovery-provider-failed',
  'account-recovery-awaiting-reenrollment',
  'account-recovery-register-error',
  'account-recovery-awaiting-confirmation',
  'account-recovery-code-other-device',
  'account-recovery-register-multiple',
  'account-recovery-completed',
  'forgot-password',
  'forgot-password-sent',
  'shell-sign-out-everywhere',
  'deals-bitrix-source',
  'deal-detail-bitrix',
  'deal-detail-bitrix-stale',
  'integration-not-configured',
  'integration-switched-off',
  'integration-healthy',
  'integration-attention',
  'integration-provider-unavailable',
  'integration-stale',
  'integration-reason-codes',
  'integration-action-results',
  'integration-no-permission',
  'integration-worker-never-run',
  'integration-worker-not-recent',
  'integration-backlog',
  'integration-worker-secret-missing',
  'integration-multiple-configs',
  'integration-reconcile-cooldown',
  'finance-destinations',
  'finance-destinations-own',
  'finance-destinations-empty',
  'finance-destinations-add-error',
  'finance-destinations-unavailable',
  'finance-deal-destinations',
  'finance-deal-no-destination',
  'finance-deal-destinations-unavailable',
  'finance-deal-destination-changed',
];

/** Opens every collapsed <details> so axe also checks the forms inside them. */
async function expandAllDetails(page: Page) {
  // After hydration, so React does not report an attribute mismatch.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll('details'))) d.open = true;
  });
}

test.describe('accessibility (axe, WCAG 2.2 A/AA rules)', () => {
  for (const path of [...publicPages, ...galleryStates.map((s) => `/preview/${s}`)]) {
    test(`no detectable violations on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expandAllDetails(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });
  }

  test('Home states only what this viewer can use: no Accounts claim for Sales, no "receipts unavailable"', async ({ page }) => {
    // Direction A (FP-009): the note is on demand, behind "What this CRM does not do yet".
    await page.goto('/preview/home-sales');
    await page.getByText('What this CRM does not do yet').click();
    const next = page.getByRole('region', { name: 'Not available yet' });
    await expect(next).toContainText('Customer billing details and receipts are handled by Accounts staff.');
    await expect(next).not.toContainText(/receipts are in Accounts|receipts.*not available/i);
    await page.goto('/preview/home-accounts');
    await page.getByText('What this CRM does not do yet').click();
    await expect(page.getByRole('region', { name: 'Not available yet' })).toContainText('Customer billing details and receipts are in Accounts.');
  });

  test('keyboard users can skip to main content', async ({ page }) => {
    await page.goto('/preview/home-sales');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('Purchase deal view shows no selling price', async ({ page }) => {
    await page.goto('/preview/deal-detail-purchase');
    // Batch 1: no Money tab at all for Purchase (money-privacy P6), and no amount anywhere.
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Money' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('₹');
    for (const state of ['deal-detail-purchase', 'ws-deal-purchase-money', 'ws-deal-purchase-history']) {
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html, state).not.toMatch(/₹|estimatedMargin|sellingTotal/);
    }
  });
});

test.describe('staff security screens (preview gallery, synthetic props)', () => {
  test('gallery pages are labelled as providerless previews', async ({ page }) => {
    await page.goto('/preview/admin-staff-recovery');
    await expect(page.getByRole('note').filter({ hasText: 'Design preview' })).toContainText('Not evidence of a real journey');
  });

  test('admin staff page shows every recovery state and email status in text', async ({ page }) => {
    await page.goto('/preview/admin-staff-recovery');
    const table = page.getByRole('table', { name: 'Staff in your entities' });
    await expect(table).toContainText('Resetting their authenticator app — step 1 of 3: removing the old app');
    await expect(table).toContainText('Resetting their authenticator app — step 1 of 3: removing the old app failed');
    await expect(table).toContainText('Attempts: 3');
    await expect(table).toContainText('Resetting their authenticator app — step 2 of 3: waiting for their new app');
    await expect(table).toContainText('Resetting their authenticator app — step 3 of 3: waiting for your confirmation');
    await expect(table).toContainText('Authenticator app reset finished');
    await expect(table).toContainText('Reset confirmed: removing their other authenticator apps is not finished');
    await expect(table).toContainText('Reset confirmed: removing their other authenticator apps failed');
    await expect(table).toContainText('Last error: provider_unavailable:503');
    await expect(table).toContainText('Reset confirmed: the clean-up cannot finish');
    await expect(table).toContainText('Handed to the mail service at');
    await expect(table).toContainText('Failed: smtp_rejected');
    await expect(table).toContainText('Pending');
    await expect(page.locator('body')).not.toContainText(/delivered/i);
  });

  test('admin actions: email, recovery warning, retry and confirm controls', async ({ page }) => {
    await page.goto('/preview/admin-staff-recovery');
    await page.getByText('Actions for Synthetic Invited Staff').click();
    await expect(page.getByRole('button', { name: 'Resend invitation' })).toBeVisible();
    await page.getByText('Actions for Synthetic Recovery Done').click();
    await expect(page.getByRole('button', { name: 'Send password reset email' }).first()).toBeVisible();
    const start = page.getByRole('button', { name: 'Start authenticator recovery' });
    await expect(start).toBeVisible();
    await expect(start).toHaveAccessibleDescription(/immediately blocks every current session/);
    await page.getByText('Actions for Synthetic Recovery Failed').click();
    await expect(page.getByRole('button', { name: /Retry removing the old authenticator/ })).toBeVisible();
    // A provider step with no recorded result is reconciled on the same case, never restarted.
    await page.getByText('Actions for Synthetic Recovery Pending').click();
    const check = page.getByRole('button', { name: 'Check and finish removing the old authenticator for Synthetic Recovery Pending' });
    await expect(check).toBeVisible();
    await expect(check).toHaveAccessibleDescription(/does not start a new one/);
    // Cleanup pending or failed: retry cleanup on the same case; no code, no new recovery.
    for (const who of ['Synthetic Cleanup Pending', 'Synthetic Cleanup Failed']) {
      const row = page.getByRole('row').filter({ hasText: who });
      await page.getByText(`Actions for ${who}`).click();
      const retry = row.getByRole('button', { name: `Retry removing other authenticators for ${who}` });
      await expect(retry).toBeVisible();
      await expect(retry).toHaveAccessibleDescription(/do not need a new confirmation code/);
      await expect(row.getByRole('button', { name: 'Start authenticator recovery' })).toHaveCount(0);
      await expect(row.getByLabel('Confirmation code')).toHaveCount(0);
    }
    // Cleanup refused by the database (registered authenticator missing): a new recovery is the only way on.
    const stuck = page.getByRole('row').filter({ hasText: 'Synthetic Cleanup Stuck' });
    await page.getByText('Actions for Synthetic Cleanup Stuck').click();
    await expect(stuck.getByRole('note').filter({ hasText: 'Cleanup of the last recovery cannot finish' })).toBeVisible();
    await expect(stuck.getByRole('button', { name: 'Start authenticator recovery' })).toBeVisible();
    await expect(stuck.getByRole('button', { name: /Retry removing other authenticators/ })).toHaveCount(0);
    await page.getByText('Actions for Synthetic Recovery Confirm').click();
    await expect(page.getByLabel('How you verified their identity')).toBeVisible();
    await expect(page.getByLabel('Confirmation code')).toHaveAttribute('maxlength', '6');
    await expect(page.getByRole('button', { name: 'Confirm and restore access' })).toBeVisible();
  });

  test('without an approved verification method, confirmation is not offered', async ({ page }) => {
    await page.goto('/preview/admin-staff-recovery-no-method');
    await page.getByText('Actions for Synthetic Recovery Confirm').click();
    await expect(
      page.getByText('No identity-verification method has been approved yet; recovery cannot be completed in this environment').first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm and restore access' })).toHaveCount(0);
  });

  test('account recovery pages show state-specific instructions', async ({ page }) => {
    await page.goto('/preview/account-recovery-provider-pending');
    await expect(page.getByText('Your administrator has started recovery. Wait for them to finish.')).toBeVisible();
    await page.goto('/preview/account-recovery-provider-failed');
    await expect(page.getByText('Your administrator has started recovery. Wait for them to finish.')).toBeVisible();
    await page.goto('/preview/account-recovery-awaiting-reenrollment');
    await expect(page.getByRole('link', { name: 'Set up a new authenticator app' })).toHaveAttribute('href', '/mfa/enroll');
    await page.goto('/preview/account-recovery-register-error');
    await expect(page.locator('main').getByRole('alert')).toContainText('Error:');
    await page.goto('/preview/account-recovery-awaiting-confirmation');
    await expect(page.getByRole('heading', { level: 2, name: 'Your confirmation code' })).toBeVisible();
    await expect(page.getByTestId('confirmation-code')).toHaveText('K7Q2XM');
    const steps = page.getByRole('list', { name: 'Recovery progress' });
    await expect(steps.locator('[aria-current="step"]')).toContainText('Read your code to the administrator');
    await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
    await page.goto('/preview/account-recovery-code-other-device');
    await expect(
      page.getByText('Your confirmation code is shown on the device where you set up the new authenticator.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get my confirmation code' })).toHaveCount(0);
    await page.goto('/preview/account-recovery-register-multiple');
    await expect(page.locator('main').getByRole('alert')).toContainText(
      'Error: More than one new authenticator was added. Contact your administrator.',
    );
    await page.goto('/preview/account-recovery-completed');
    await expect(page.locator('main')).toContainText('Sign in again with your password and your new authenticator');
    await expect(page.getByRole('button', { name: 'Sign out and sign in again' })).toBeVisible();
  });

  test('forgot-password success message is generic', async ({ page }) => {
    await page.goto('/preview/forgot-password-sent');
    await expect(page.locator('main').getByRole('status')).toHaveText(
      'If this email belongs to a staff account, we have asked the mail service to send a reset link. It expires soon. You will still need your authenticator app.',
    );
  });

  test('shell offers sign out of this device and of all devices (copy G-16)', async ({ page }) => {
    await page.goto('/preview/shell-sign-out-everywhere');
    await expect(page.getByRole('button', { name: 'Sign out of this device' })).toBeVisible();
    const all = page.getByRole('button', { name: 'Sign out everywhere' });
    await expect(all).toBeVisible();
    await expect(all).toHaveAccessibleDescription(/every other device.*password and authenticator app/);
  });
});

test.describe('Bitrix provenance and sync administration (preview gallery, synthetic props)', () => {
  test('deal list shows Bitrix source, stage, sync time and a text stale marker', async ({ page }) => {
    await page.goto('/preview/deals-bitrix-source');
    const table = page.getByRole('table');
    // Batch 1: stage fallback in the cell; deal number, code and check time in row Details.
    await expect(table).toContainText('#900101');
    await expect(table).toContainText('Stage not recognised (code in details)');
    await expect(table).toContainText('Bitrix code: C1:NEW.');
    await expect(table).toContainText('Last checked with Bitrix');
    await expect(table).toContainText('Not updated from Bitrix for over a day');
    await expect(table).toContainText('Test record');
  });

  test('Bitrix deal detail shows provenance and no synthetic label or amount', async ({ page }) => {
    await page.goto('/preview/deal-detail-bitrix');
    const source = page.getByRole('region', { name: 'Overview' });
    await expect(source).toContainText('#900101');
    await expect(source).toContainText('C1:NEW');
    await expect(source).toContainText('Last checked with Bitrix');
    await expect(page.locator('main')).not.toContainText(/Not updated from Bitrix|Test record/);
    await expect(page.locator('main')).not.toContainText('₹');
    await page.goto('/preview/deal-detail-bitrix-stale');
    await expect(page.locator('main').getByRole('note')).toContainText('Not updated from Bitrix for over a day');
  });

  test('not configured is a real state that names what is missing and offers no check', async ({ page }) => {
    await page.goto('/preview/integration-not-configured');
    const main = page.locator('main');
    await expect(main).toContainText('Not set up');
    const setup = page.getByRole('list', { name: 'Intake health checks' });
    await expect(setup).toContainText('Bitrix credential: Missing on the server');
    await expect(setup).toContainText('Intake configuration: Missing');
    await expect(setup).toContainText('Deployment environment: Not set');
    await expect(setup).toContainText('Background update setting: Missing on the server');
    await expect(setup).toContainText('Last background update: Never. Background updates are not running yet');
    await expect(page.getByRole('button', { name: 'Check Bitrix now' })).toHaveCount(0);
    await page.goto('/preview/integration-switched-off');
    await expect(page.getByRole('list', { name: 'Intake health checks' })).toContainText('The intake configuration is switched off');
  });

  test('"Receiving deals" needs worker evidence; every other worker state is named', async ({ page }) => {
    const cases: Array<[string, string, string]> = [
      ['integration-worker-never-run', 'Background updates have never run', 'Last background update: Never'],
      ['integration-worker-not-recent', 'Background updates stopped', 'more than 15 minutes ago'],
      ['integration-backlog', 'Updates delayed since', 'Oldest waiting item received'],
      ['integration-worker-secret-missing', 'Background updates cannot run', 'Background update setting: Missing on the server'],
      ['integration-multiple-configs', 'Not set up correctly', '2 configurations are enabled'],
    ];
    for (const [state, headline, check] of cases) {
      await page.goto(`/preview/${state}`);
      const main = page.locator('main');
      await expect(main).toContainText(headline);
      await expect(main).not.toContainText('Receiving deals');
      await expect(page.getByRole('list', { name: 'Intake health checks' })).toContainText(check);
    }
  });

  test('reconcile cooldown message from the action is shown as an error', async ({ page }) => {
    await page.goto('/preview/integration-reconcile-cooldown');
    await expect(page.locator('main').getByRole('alert')).toContainText('Error: Synthetic preview: a check ran recently');
  });

  test('healthy state shows counts, last processed time and the reconcile action', async ({ page }) => {
    await page.goto('/preview/integration-healthy');
    await expect(page.locator('main')).toContainText('Receiving deals');
    await expect(page.locator('main')).toContainText('Last deal processed');
    await expect(page.locator('main')).toContainText('Last background update');
    await expect(page.locator('main')).toContainText('Completed');
    // Prompt 6: the cumulative "Processed" counter is replaced by the current total.
    const glance = page.getByRole('region', { name: 'Deals in the CRM and in Bitrix' });
    await expect(glance).toContainText('Auto sync running · last run 12 s ago');
    await expect(glance.getByRole('definition').nth(0)).toHaveText('42');
    await expect(glance.getByRole('term').nth(0)).toHaveText('Available deals');
    await expect(glance.getByRole('term').nth(1)).toHaveText('Bitrix (current settings)');
    await expect(glance.getByRole('definition').nth(1)).toHaveText('42 ✓');
    await expect(glance).toContainText('Last run: 3 fetched, 1 new, 2 updated');
    const openWork = page.getByRole('region', { name: 'Open sync work' });
    await expect(openWork).toContainText('Waiting to process1');
    await expect(openWork).not.toContainText('Processed');
    const check = page.getByRole('button', { name: 'Check Bitrix now' });
    await expect(check).toBeVisible();
    await expect(check).toHaveAccessibleDescription(/Nothing changes in Bitrix/);
    await expect(page.getByText('Nothing needs attention.')).toBeVisible();
  });

  test('attention list explains every reason and error code in plain language with retry', async ({ page }) => {
    await page.goto('/preview/integration-attention');
    const table = page.getByRole('table', { name: /need attention/ });
    for (const text of [
      'not linked to a CRM staff member',
      'not an active member of the pilot branch',
      'deal number that is not a number',
      'does not exist or cannot be read',
      'not configured or was switched off',
      'environment was not set',
      'rate limit',
      'could not read',
      'internal error',
      'already used by another deal',
      'Next automatic try:',
      'Stopped: retries used up',
      '8 of 8',
    ]) {
      await expect(table).toContainText(text);
    }
    await expect(page.getByRole('button', { name: 'Retry Bitrix deal #900201' })).toBeVisible();
    await page.goto('/preview/integration-reason-codes');
    const ignored = page.getByRole('table', { name: /need attention/ });
    for (const text of ['pipeline this CRM does not take', 'stage this CRM does not take', 'before the start date (from 00:00 India time)', 'older version']) {
      await expect(ignored).toContainText(text);
    }
    await expect(ignored.getByRole('button')).toHaveCount(0);
  });

  test('stopped auto sync states since when and why; a Bitrix difference is shown as a number', async ({ page }) => {
    await page.goto('/preview/integration-worker-not-recent');
    const glance = page.getByRole('region', { name: 'Deals in the CRM and in Bitrix' });
    await expect(glance.getByRole('alert')).toContainText('Auto sync stopped since');
    await expect(glance.getByRole('alert')).toContainText("Synthetic preview: the CRM refused the scheduler's secret (HTTP 401).");
    await expect(glance.getByRole('alert')).toContainText('"Check Bitrix now" still works.');
    await expect(glance.getByRole('definition').nth(1)).toHaveText('45 (difference -3)');
  });

  test('provider outage and stale sync are stated in text', async ({ page }) => {
    await page.goto('/preview/integration-provider-unavailable');
    // This preview includes a rejected credential, which never fixes itself, so it leads over the outage.
    await expect(page.locator('main')).toContainText('Bitrix refused the CRM’s login');
    await expect(page.locator('main').getByRole('alert').first()).toContainText('Error: Bitrix rejected the CRM’s access credential');
    await expect(page.locator('main')).toContainText('Bitrix was unavailable');
    await page.goto('/preview/integration-stale');
    await expect(page.locator('main')).toContainText('Receiving deals');
    await expect(page.locator('main')).toContainText('no Bitrix deal has been processed for over 24 hours');
  });

  test('action results use the shared Error:/Done: messages', async ({ page }) => {
    await page.goto('/preview/integration-action-results');
    await expect(page.locator('main').getByRole('alert')).toContainText('Error: Synthetic preview');
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Done:' })).toBeVisible();
  });

  test('Bitrix connection nav item only for integration managers; others get an honest no-permission page', async ({ page }) => {
    await page.goto('/preview/integration-healthy');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Bitrix connection' })).toHaveAttribute('aria-current', 'page');
    await page.goto('/preview/integration-no-permission');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Only staff who manage the Bitrix connection, and who hold no Purchase role, can open this page.');
  });
});

/**
 * T14 (browser half): no Content Security Policy violation on public, MFA and
 * staff screens. Collects both console reports and securitypolicyviolation
 * events (registered before any page script runs).
 */
test.describe('content security policy', () => {
  const cspPaths = [
    '/sign-in',
    '/forgot-password',
    '/session-expired',
    '/mfa/recovery',
    '/auth/accept?type=invite&token_hash=synthetic_token_hash_0123456789',
    '/signed-out?scope=global&provider=failed',
    '/preview/mfa-enroll-start',
    '/preview/mfa-enroll-qr',
    '/preview/mfa-challenge',
    '/preview/mfa-challenge-error',
    '/preview/forgot-password',
    '/preview/admin-staff-recovery',
    '/preview/account-recovery-awaiting-confirmation',
    '/preview/shell-sign-out-everywhere',
    '/preview/integration-attention',
    '/preview/deal-detail-bitrix-stale',
    '/preview/booking-draft-needs-repair',
    '/preview/booking-confirm-dialog',
    '/preview/purchase-queue',
    '/preview/purchase-task-open',
    '/preview/booking-health-off',
  ];
  test('no CSP violations on sign-in, forgot-password, MFA and staff screens', async ({ page, context }) => {
    const violations: string[] = [];
    await context.exposeFunction('__reportCspViolation', (v: string) => violations.push(v));
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __reportCspViolation: (v: string) => void }).__reportCspViolation(
          `${location.pathname}: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`,
        );
      });
    });
    page.on('console', (msg) => {
      if (msg.text().includes('Content Security Policy')) violations.push(`${page.url()}: ${msg.text()}`);
    });
    for (const path of cspPaths) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expandAllDetails(page);
      // Exercise client-side hydration paths (details toggles, form state).
      await page.waitForLoadState('networkidle');
    }
    expect(violations).toEqual([]);
  });
});
