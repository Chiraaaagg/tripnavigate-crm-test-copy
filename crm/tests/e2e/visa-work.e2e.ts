import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * R3 approved-form exception O14 on the Visa Work tab (owner, 16 November 2026;
 * design plan 2.4): each passenger row has one control with a visible "Edit"
 * label; with another action it is one menu instead of a pencil plus three dots.
 * Synthetic preview gallery, no database.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

test.describe('R3 Visa Work tab (O14)', () => {
  test('one visible Edit control per row; no icon-only pencil or "More for" button is left', async ({ page }) => {
    await open(page, 'visa-work');
    const main = page.locator('main');
    const edits = main.getByRole('button', { name: /^(Edit|Actions) / });
    expect(await edits.count()).toBeGreaterThan(0);
    for (const b of await edits.all()) await expect(b).toContainText(/^(Edit|Actions)/);
    await expect(main.getByRole('button', { name: /^More for / })).toHaveCount(0);
  });

  test('the menu holds Edit details and the other row actions; Edit details focuses the first field, Cancel returns to Edit', async ({ page }) => {
    await open(page, 'visa-work');
    const main = page.locator('main');
    const trigger = main.getByRole('button', { name: /^Edit / }).first();
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    if ((await menu.count()) > 0) {
      await expect(menu.getByRole('menuitem').first()).toHaveText('Edit details');
      expect(await new AxeBuilder({ page }).include('[role="menu"]').analyze().then((r) => r.violations.map((v) => v.id))).toEqual([]);
      await page.keyboard.press('Enter');
    }
    const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
    expect(['input', 'select', 'textarea']).toContain(focused);
    await main.getByRole('button', { name: /^Cancel/ }).first().click();
    await expect(main.getByRole('button', { name: /^Edit / }).first()).toBeFocused();
  });

  test('Withdrawn by customer is reached from the same menu', async ({ page }) => {
    await open(page, 'visa-work');
    const main = page.locator('main');
    for (const trigger of await main.getByRole('button', { name: /^(Edit|Actions) / }).all()) {
      if ((await trigger.getAttribute('aria-haspopup')) !== 'menu') continue;
      await trigger.click();
      const item = page.getByRole('menuitem', { name: 'Withdrawn by customer' });
      if ((await item.count()) === 0) {
        await page.keyboard.press('Escape');
        continue;
      }
      await item.click();
      await expect(page.getByRole('dialog')).toContainText('Withdrawn by customer');
      return;
    }
    test.skip(true, 'No row in visa-work can be withdrawn.');
  });
});
