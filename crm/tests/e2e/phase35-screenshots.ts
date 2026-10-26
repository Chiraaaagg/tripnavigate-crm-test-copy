import { expect, test } from '@playwright/test';

/**
 * Captures Phase 3.5 UI states to docs/implementation/history/phase-3-5/screenshots.
 * Synthetic preview props only: visual evidence, not evidence of a real
 * journey. Earlier phases' directories are never written.
 */
const dir = '../docs/implementation/history/phase-3-5/screenshots';

const desktop: Array<[string, string]> = [
  ['01-booking-none', 'booking-none'],
  ['02-booking-draft-needs-repair', 'booking-draft-needs-repair'],
  ['03-booking-draft-ready', 'booking-draft-ready'],
  ['04-booking-confirm-dialog', 'booking-confirm-dialog'],
  ['05-booking-save-conflict', 'booking-save-conflict'],
  ['06-booking-gate-off-ready', 'booking-gate-off-ready'],
  ['07-booking-draft-ready-assignee', 'booking-draft-ready-assignee'],
  ['08-booking-draft-read-only', 'booking-draft-read-only'],
  ['09-booking-confirmed', 'booking-confirmed'],
  ['10-booking-confirmed-taken', 'booking-confirmed-taken'],
  ['11-booking-unavailable', 'booking-unavailable'],
  ['12-booking-loading', 'booking-loading'],
  ['13-deal-detail-purchase-withheld', 'deal-detail-purchase'],
  ['14-deal-detail-commercial-not-recorded', 'deal-detail-commercial-not-recorded'],
  ['15-purchase-queue', 'purchase-queue'],
  ['16-purchase-queue-empty', 'purchase-queue-empty'],
  ['17-purchase-task-open', 'purchase-task-open'],
  ['18-purchase-task-mine', 'purchase-task-mine'],
  ['19-purchase-task-claim-conflict', 'purchase-task-claim-conflict'],
  ['20-booking-health-off', 'booking-health-off'],
  ['21-booking-health-unknown', 'booking-health-unknown'],
];
const mobile: Array<[string, string]> = [
  ['31-mobile-booking-draft-needs-repair', 'booking-draft-needs-repair'],
  ['32-mobile-booking-draft-ready', 'booking-draft-ready'],
  ['33-mobile-booking-confirm-dialog', 'booking-confirm-dialog'],
  ['34-mobile-booking-gate-off-ready', 'booking-gate-off-ready'],
  ['35-mobile-booking-confirmed', 'booking-confirmed'],
  ['36-mobile-purchase-queue', 'purchase-queue'],
  ['37-mobile-purchase-task-open', 'purchase-task-open'],
  ['38-mobile-booking-health-off', 'booking-health-off'],
];

const viewportOnly = (state: string) => state.includes('dialog');

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
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: !viewportOnly(state), animations: 'disabled' });
  });
}

// The sticky save bar mid-scroll on a phone (viewport only, so the bar position is visible).
test('screenshot 39-mobile-booking-form-sticky-save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/preview/booking-draft-needs-repair');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Adults').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/39-mobile-booking-form-sticky-save.png`, animations: 'disabled' });
});
