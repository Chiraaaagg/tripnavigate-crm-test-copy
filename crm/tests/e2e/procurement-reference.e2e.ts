import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Milestone A §7 (audit finding 11): the supplier confirmation reference is a
 * controlled input. It keeps the typed value after a refusal or a lost
 * response and is cleared only after a success. Preview stubs only; the
 * command and its exact-retry matching are covered by tests/db.
 */

async function openDialog(page: Page, state: string) {
  await page.goto(`/preview/${state}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Record supplier confirmation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record that the supplier confirmed this hotel?' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('supplier confirmation reference', () => {
  test('a refusal keeps the typed reference and says so; success clears it', async ({ page }) => {
    const dialog = await openDialog(page, 'procurement-confirm-reference');
    const field = dialog.getByLabel('Supplier confirmation reference');
    await field.fill('SYN-CONF-4471');
    await dialog.getByRole('button', { name: 'Record supplier confirmation' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Someone changed this after you opened it.');
    await expect(dialog).toContainText('Your reference is still in the field.');
    await expect(field).toHaveValue('SYN-CONF-4471');

    // A second refusal still keeps it.
    await dialog.getByRole('button', { name: 'Record supplier confirmation' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(field).toHaveValue('SYN-CONF-4471');

    await field.fill('SYN-CONF-4471-OK');
    await dialog.getByRole('button', { name: 'Record supplier confirmation' }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Done:' })).toBeVisible();
    await expect(field).toHaveValue('');
    await expect(dialog).not.toContainText('Your reference is still in the field.');
  });

  test('a lost response keeps the reference so an exact retry sends the same value', async ({ page }) => {
    const dialog = await openDialog(page, 'procurement-confirm-reference-lost');
    const field = dialog.getByLabel('Supplier confirmation reference');
    await field.fill('SYN-CONF-9001');
    await dialog.getByRole('button', { name: 'Record supplier confirmation' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Your typed details are still here.');
    await expect(field).toHaveValue('SYN-CONF-9001');
  });

  test('the reference dialog is axe clean after a refusal, on desktop and 390 px', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const dialog = await openDialog(page, 'procurement-confirm-reference');
      await dialog.getByLabel('Supplier confirmation reference').fill('SYN-CONF-4471');
      await dialog.getByRole('button', { name: 'Record supplier confirmation' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      // Same as the other axe suites: measure after the dialog's entry animation
      // settles, so colour contrast is not read mid-fade.
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
      );
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    }
  });
});
