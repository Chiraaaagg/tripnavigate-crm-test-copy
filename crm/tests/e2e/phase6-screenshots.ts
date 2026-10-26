import { expect, test } from '@playwright/test';

/**
 * Captures Phase 6 UI states (approved import list on the Bitrix sync page and
 * read-only Bitrix Lead provenance) to docs/implementation/history/phase-6/screenshots.
 * Synthetic preview props only: visual evidence, not evidence of a real intake.
 */
const dir = '../docs/implementation/history/phase-6/screenshots';

const desktop: Array<[string, string]> = [
  ['01-sync-scope-active', 'p6-sync-scope-active'],
  ['02-sync-scope-complete', 'p6-sync-scope-complete'],
  ['03-sync-scope-failed', 'p6-sync-scope-failed'],
  ['04-sync-scope-stale', 'p6-sync-scope-stale'],
  ['05-sync-scope-closed', 'p6-sync-scope-closed'],
  ['06-sync-scope-none', 'p6-sync-scope-none'],
  ['07-sync-scope-switched-off', 'p6-sync-scope-switched-off'],
  ['08-leads-sales', 'p6-leads-sales'],
  ['09-lead-sales', 'p6-lead-sales'],
  ['10-lead-raw-status-stale', 'p6-lead-raw-status-stale'],
  ['11-leads-purchase-denied', 'p6-leads-purchase-denied'],
  ['12-lead-not-found', 'p6-lead-not-found'],
  ['13-sync-scope-unavailable', 'p6-sync-scope-unavailable'],
];
const mobile: Array<[string, string]> = [
  ['21-mobile-sync-scope-active', 'p6-sync-scope-active'],
  ['22-mobile-sync-scope-failed', 'p6-sync-scope-failed'],
  ['23-mobile-leads-sales', 'p6-leads-sales'],
  ['24-mobile-lead-raw-status-stale', 'p6-lead-raw-status-stale'],
  ['25-mobile-lead-not-found', 'p6-lead-not-found'],
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
