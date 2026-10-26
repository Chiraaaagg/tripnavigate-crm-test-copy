import { expect, test } from '@playwright/test';

/**
 * Captures Phase 3 UI states (hotel booking, Purchase tasks, booking health) to
 * docs/implementation/history/phase-3/screenshots. Synthetic preview props only; these
 * are visual evidence, not evidence of a real journey. Earlier phases'
 * directories are never written.
 */
const dir = '../docs/implementation/history/phase-3/screenshots';

const desktop: Array<[string, string]> = [
  ['01-booking-none', 'booking-none'],
  ['02-booking-draft-needs-repair', 'booking-draft-needs-repair'],
  ['03-booking-draft-ready', 'booking-draft-ready'],
  ['04-booking-confirm-dialog', 'booking-confirm-dialog'],
  ['05-booking-confirm-conflict', 'booking-confirm-conflict'],
  ['06-booking-save-conflict', 'booking-save-conflict'],
  ['07-booking-draft-ready-assignee', 'booking-draft-ready-assignee'],
  ['08-booking-gate-off', 'booking-gate-off'],
  ['09-booking-environment-unset', 'booking-environment-unset'],
  ['10-booking-source-stale', 'booking-source-stale'],
  ['11-booking-upload-failed', 'booking-upload-failed'],
  ['12-booking-max-files', 'booking-max-files'],
  ['13-booking-confirmed', 'booking-confirmed'],
  ['14-booking-confirmed-taken', 'booking-confirmed-taken'],
  ['15-booking-unavailable', 'booking-unavailable'],
  ['16-purchase-queue', 'purchase-queue'],
  ['17-purchase-queue-empty', 'purchase-queue-empty'],
  ['18-purchase-task-open', 'purchase-task-open'],
  ['19-purchase-task-mine', 'purchase-task-mine'],
  ['20-purchase-task-claim-conflict', 'purchase-task-claim-conflict'],
  ['21-booking-health-off', 'booking-health-off'],
  ['22-booking-health-on', 'booking-health-on'],
  ['23-booking-health-environment-unset', 'booking-health-environment-unset'],
  ['24-booking-health-unknown', 'booking-health-unknown'],
  ['25-booking-draft-ask-owner', 'booking-draft-ask-owner'],
  ['26-purchase-queue-sales-view', 'purchase-queue-sales-view'],
];
const mobile: Array<[string, string]> = [
  ['31-mobile-booking-draft-needs-repair', 'booking-draft-needs-repair'],
  ['32-mobile-booking-draft-ready', 'booking-draft-ready'],
  ['33-mobile-booking-confirm-dialog', 'booking-confirm-dialog'],
  ['34-mobile-booking-confirmed', 'booking-confirmed'],
  ['35-mobile-purchase-queue', 'purchase-queue'],
  ['36-mobile-purchase-task-open', 'purchase-task-open'],
  ['37-mobile-booking-health-off', 'booking-health-off'],
];

for (const [name, state] of desktop) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.goto(`/preview/${state}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: !state.includes('dialog') && !state.includes('confirm-conflict') });
  });
}

for (const [name, state] of mobile) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/preview/${state}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: !state.includes('dialog') });
  });
}
