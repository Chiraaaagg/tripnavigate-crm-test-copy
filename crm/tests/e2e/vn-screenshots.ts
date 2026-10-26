import { expect, test, type Page } from '@playwright/test';

/**
 * Voice-note batch screenshots (24 October 2026) to
 * docs/implementation/voice-notes-2026-10-24/screens. Synthetic preview
 * states at desktop (1440) and phone (375) widths. Visual evidence only, not
 * evidence of a real journey (saving and permissions are the real suites).
 */
const dir = '../docs/implementation/voice-notes-2026-10-24/screens';

const VIEWPORTS = [
  { tag: 'desktop', width: 1440, height: 1024 },
  { tag: '375', width: 375, height: 812 },
] as const;

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

const main = (page: Page) => page.locator('main');

type Shot = { name: string; state: string; act?: (page: Page) => Promise<void>; full?: boolean };

const SHOTS: Shot[] = [
  { name: '01-customer-deal-facts', state: 'bookform-vn-deal--travellers' },
  { name: '02-customer-missing-values-over-count', state: 'bookform-vn-gaps--travellers' },
  {
    name: '03-counts-do-not-add-up',
    state: 'bookform-vn-gaps--travellers',
    act: async (page) => {
      await main(page).getByRole('button', { name: 'One adult more' }).click();
      await expect(main(page).locator('#bf-counts-error')).toBeVisible();
    },
  },
  {
    name: '04-correct-dialog',
    state: 'bookform-vn-deal--travellers',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: 'Correct' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: '05-attach-id-proof-dialog',
    state: 'bookform-vn-deal--travellers',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: 'Attach ID proof for Sample Traveller A' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: '06-passenger-details-requests',
    state: 'bookform-vn-deal--travellers',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: 'Details for passenger 1' }).click();
      const drawer = page.getByRole('dialog', { name: 'Passenger details' });
      await settle(page);
      await drawer.getByRole('button', { name: /Choose requests/ }).click();
      await drawer.getByRole('checkbox', { name: 'Jain meals' }).check();
      await drawer.getByRole('checkbox', { name: 'Wheelchair help' }).check();
    },
  },
  {
    name: '07-hotel-editor-search',
    state: 'bookform-vn-deal--stay',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: 'Add stay' }).click();
      const drawer = page.getByRole('dialog', { name: 'Add hotel stay' });
      await settle(page);
      await drawer.getByRole('combobox', { name: 'Hotel' }).fill('Sample P');
      await expect(drawer.getByRole('listbox', { name: 'Matches' }).getByRole('option')).toHaveCount(3);
    },
  },
  {
    name: '08-hotel-editor-guests',
    state: 'bookform-vn-deal--stay',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: /Edit hotel/ }).click();
      const drawer = page.getByRole('dialog', { name: 'Edit hotel stay' });
      await settle(page);
      await drawer.locator('#svc-adults').scrollIntoViewIfNeeded();
    },
  },
  {
    name: '09-car-editor',
    state: 'bookform-vn-deal--stay',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: 'Add car' }).click();
      const drawer = page.getByRole('dialog', { name: 'Add car' });
      await settle(page);
      await drawer.getByLabel('Vehicle', { exact: true }).selectOption('other');
      await drawer.getByRole('button', { name: 'One vehicle more' }).click();
    },
  },
  {
    name: '10-flight-editor-passengers',
    state: 'bookform-vn-deal--stay',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: /Edit flight/ }).click();
      const drawer = page.getByRole('dialog', { name: 'Edit flight' });
      await settle(page);
      await drawer.locator('#svc-who').scrollIntoViewIfNeeded();
      await drawer.locator('#svc-who').click();
    },
  },
  {
    name: '11-new-flight-save-and-attach',
    state: 'bookform-vn-deal--stay',
    full: false,
    act: async (page) => {
      await main(page).getByRole('button', { name: 'Add flight' }).click();
      const drawer = page.getByRole('dialog', { name: 'Add flight' });
      await settle(page);
      await drawer.getByRole('button', { name: 'Save and attach screenshot' }).scrollIntoViewIfNeeded();
    },
  },
  {
    name: '12-bill-to-search',
    state: 'bookform-vn-billto--finish',
    act: async (page) => {
      const search = main(page).getByRole('combobox', { name: 'Find customer' });
      await search.fill('Sample');
      await expect(main(page).getByRole('listbox', { name: 'Matches' }).getByRole('option')).toHaveCount(3);
    },
  },
  { name: '13-bill-to-picked', state: 'bookform-vn-billto-picked--finish' },
  {
    name: '14-add-customer-personal',
    state: 'bookform-vn-billto--finish',
    full: false,
    act: async (page) => {
      await main(page).locator('section#billTo').getByRole('button', { name: 'Add customer' }).click();
      await expect(page.getByRole('dialog', { name: 'Add customer' })).toBeVisible();
    },
  },
  {
    name: '15-add-customer-business',
    state: 'bookform-vn-billto--finish',
    full: false,
    act: async (page) => {
      await main(page).locator('section#billTo').getByRole('button', { name: 'Add customer' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add customer' });
      await dialog.getByRole('button', { name: 'Business' }).click();
      await dialog.getByLabel('GST registration').selectOption('unregistered');
    },
  },
  { name: '16-accounts-customers-to-check', state: 'vn-customers' },
  { name: '17-accounts-customer-check', state: 'vn-customer-check' },
  {
    name: '18-accounts-return-dialog',
    state: 'vn-customer-check',
    full: false,
    act: async (page) => {
      await page.getByRole('button', { name: 'Return with reason' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  { name: '19-import-check-result', state: 'vn-import-hotel-summary' },
  { name: '20-destination-classes', state: 'vn-destinations' },
  {
    name: '21-destination-change-dialog',
    state: 'vn-destinations',
    full: false,
    act: async (page) => {
      await page.getByRole('button', { name: 'Change Kerala' }).click();
      await page.getByRole('dialog').getByLabel('International').check();
    },
  },
  { name: '22-bitrix-trip-details-switch', state: 'vn-trip-details-on' },
  { name: '23-bitrix-trip-details-review', state: 'vn-trip-details-review' },
  { name: '24-bitrix-trip-details-unknown', state: 'vn-trip-details-unknown' },
];

for (const vp of VIEWPORTS) {
  for (const shot of SHOTS) {
    test(`screenshot ${shot.name} ${vp.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/preview/${shot.state}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
      await settle(page);
      if (shot.act) await shot.act(page);
      await settle(page);
      await page.screenshot({ path: `${dir}/${shot.name}-${vp.tag}.png`, fullPage: shot.full !== false, animations: 'disabled' });
    });
  }
}
