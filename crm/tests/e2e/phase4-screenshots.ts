import { expect, test } from '@playwright/test';

/**
 * Captures Phase 4 UI states to docs/implementation/history/phase-4/screenshots.
 * Synthetic preview props only: visual evidence, not evidence of a real journey.
 */
const dir = '../docs/implementation/history/phase-4/screenshots';

const desktop: Array<[string, string]> = [
  ['01-procurement-empty', 'procurement-empty'],
  ['02-procurement-in-progress', 'procurement-in-progress'],
  ['03-procurement-ready', 'procurement-ready'],
  ['04-procurement-over-budget', 'procurement-over-budget'],
  ['05-procurement-confirm-not-ready', 'procurement-confirm-not-ready'],
  ['06-procurement-gate-off', 'procurement-gate-off'],
  ['07-procurement-supplier-confirmed', 'procurement-supplier-confirmed'],
  ['08-procurement-colleague-view', 'procurement-colleague-view'],
  ['09-procurement-sales-view', 'procurement-sales-view'],
  ['10-suppliers-list', 'suppliers-list'],
  ['11-suppliers-empty', 'suppliers-empty'],
  ['12-supplier-detail', 'supplier-detail'],
  ['13-procurement-manager-view', 'procurement-manager-view'],
  ['14-procurement-over-budget-approved', 'procurement-over-budget-approved'],
  ['15-procurement-released', 'procurement-released'],
  ['16-supplier-detail-manager', 'supplier-detail-manager'],
  ['17-supplier-detail-verified', 'supplier-detail-verified'],
];
const mobile: Array<[string, string]> = [
  ['21-mobile-procurement-in-progress', 'procurement-in-progress'],
  ['22-mobile-procurement-supplier-confirmed', 'procurement-supplier-confirmed'],
  ['23-mobile-supplier-detail', 'supplier-detail'],
  ['24-mobile-procurement-manager-view', 'procurement-manager-view'],
  ['25-mobile-supplier-detail-manager', 'supplier-detail-manager'],
];

const viewportOnly = (state: string) => state.includes('confirm-not-ready');

for (const [name, state] of desktop) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.goto(`/preview/${state}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: !viewportOnly(state), animations: 'disabled' });
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
