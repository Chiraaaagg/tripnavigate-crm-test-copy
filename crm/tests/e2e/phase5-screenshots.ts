import { expect, test } from '@playwright/test';

/**
 * Captures Phase 5 UI states (imported Bitrix deals and sync problems) to
 * docs/implementation/history/phase-5/screenshots. Synthetic preview props only:
 * visual evidence, not evidence of a real intake.
 */
const dir = '../docs/implementation/history/phase-5/screenshots';

const desktop: Array<[string, string]> = [
  ['01-deals-sales', 'intake-deals-sales'],
  ['02-deal-sales-up-to-date', 'intake-deal-sales'],
  ['03-deal-sales-raw-stage', 'intake-deal-sales-raw-stage'],
  ['04-deal-sales-stale', 'intake-deal-sales-stale'],
  ['05-deals-purchase', 'intake-deals-purchase'],
  ['06-deal-purchase', 'intake-deal-purchase'],
  ['07-sync-healthy', 'intake-sync-healthy'],
  ['08-sync-problems', 'intake-sync-problems'],
  ['09-sync-auth-failed', 'intake-sync-auth-failed'],
  ['10-sync-worker-down', 'intake-sync-worker-down'],
  ['11-sync-every-code', 'intake-sync-every-code'],
  ['12-sync-sales-denied', 'intake-sync-sales-denied'],
];
const mobile: Array<[string, string]> = [
  ['21-mobile-deals-sales', 'intake-deals-sales'],
  ['22-mobile-deal-sales-stale', 'intake-deal-sales-stale'],
  ['23-mobile-deal-purchase', 'intake-deal-purchase'],
  ['24-mobile-sync-problems', 'intake-sync-problems'],
  ['25-mobile-sync-worker-down', 'intake-sync-worker-down'],
];

for (const [name, state] of desktop) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.goto(`/preview/${state}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true, animations: 'disabled' });
  });
}

for (const [name, state] of mobile) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/preview/${state}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true, animations: 'disabled' });
  });
}
