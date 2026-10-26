import { expect, test, type Page } from '@playwright/test';

/**
 * Booking form parity screenshots (owner-approved preview of 22 October 2026)
 * to docs/implementation/booking-form-2026-10-22/screenshots. Synthetic
 * preview states, same viewports as the preview's own checks (1440 desktop,
 * 375 and 320 phones). Visual evidence only, not evidence of a real journey.
 */
const dir = '../docs/implementation/booking-form-2026-10-22/screenshots';

const VIEWPORTS = [
  { tag: 'desktop', width: 1440, height: 1024 },
  { tag: '375', width: 375, height: 812 },
  { tag: '320', width: 320, height: 720 },
] as const;

const PAGES: Array<[string, string]> = [
  ['01-customer-empty', 'bookform-empty--travellers'],
  ['02-customer-owner', 'bookform-owner--travellers'],
  ['03-services-owner', 'bookform-owner--stay'],
  ['04-services-gap', 'bookform-gaps--stay'],
  ['05-price-billto-owner', 'bookform-owner--finish'],
  ['06-price-no-access', 'bookform-no-price--finish'],
  ['07-price-legacy', 'bookform-legacy--finish'],
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // Drawers slide in: wait until no finite animation is still running.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

for (const vp of VIEWPORTS) {
  for (const [name, state] of PAGES) {
    test(`screenshot ${name} ${vp.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/preview/${state}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
      await settle(page);
      await page.screenshot({ path: `${dir}/${name}-${vp.tag}.png`, fullPage: true, animations: 'disabled' });
    });
  }

  test(`screenshot 10-hotel-editor ${vp.tag}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/preview/bookform-owner--stay');
    await settle(page);
    await page.getByRole('button', { name: 'Add stay' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add hotel stay' });
    await drawer.getByLabel('City').fill('Jodhpur');
    await drawer.getByLabel('Hotel', { exact: true }).fill('Sample Palace Hotel');
    await drawer.getByLabel('Nights').fill('2');
    await drawer.getByLabel('Rooms quantity').fill('2');
    await drawer.getByLabel('Room / night, rupees').fill('10000');
    await drawer.getByLabel('Extra beds quantity').fill('2');
    await drawer.getByLabel('Extra bed / night, rupees').fill('2000');
    await drawer.getByLabel('No bed quantity').fill('1');
    await drawer.getByLabel('No-bed guest / night, rupees').fill('1000');
    await settle(page);
    await page.screenshot({ path: `${dir}/10-hotel-editor-${vp.tag}.png`, animations: 'disabled' });
  });

  test(`screenshot 11-passenger-drawer ${vp.tag}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/preview/bookform-owner--travellers');
    await settle(page);
    await page.getByRole('button', { name: 'Details for passenger 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Passenger details' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${dir}/11-passenger-drawer-${vp.tag}.png`, animations: 'disabled' });
  });

  test(`screenshot 12-before-submit ${vp.tag}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/preview/bookform-gaps--finish');
    await settle(page);
    await page.locator('details#bf-before-submit > summary').click();
    await page.screenshot({ path: `${dir}/12-before-submit-${vp.tag}.png`, fullPage: true, animations: 'disabled' });
  });

  test(`screenshot 13-flight-editor ${vp.tag}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/preview/bookform-owner--stay');
    await settle(page);
    await page.getByRole('button', { name: 'Edit flight 3' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit flight' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${dir}/13-flight-editor-${vp.tag}.png`, animations: 'disabled' });
  });
}
