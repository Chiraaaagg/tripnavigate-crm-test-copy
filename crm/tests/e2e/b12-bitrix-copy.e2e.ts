import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open } from './b11-helpers';

/**
 * B1.2 DEC-43: the copy of ID proofs to the Bitrix Deal, through the design
 * preview states (synthetic props; stand-in actions). Status always in words;
 * "Try again" only where this person may retry, otherwise who can; the
 * Super Admin's automatic-stop list, open first. Not a real journey.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = ['b12-book-copy-status', 'b12-submitted-copy-status', 'b12-admin-copy-alerts', 'b12-admin-copy-alerts-none', 'b12-admin-copy-alerts-unknown'];

accessibilitySuite('B1.2 Bitrix copy: accessibility', STATES);
cspSuite('B1.2 Bitrix copy: production style policy', STATES);

test.describe('B1.2 Bitrix copy of ID proofs', () => {
  for (const state of ['b12-book-copy-status', 'b12-submitted-copy-status']) {
    test(`${state}: each file says where its copy stands; Try again or who can`, async ({ page }) => {
      await open(page, state);
      const a = page.getByRole('list', { name: 'ID proof files of Sample Traveller A' });
      await expect(a).toContainText('Bitrix copy: Copied to Bitrix');
      await expect(a).toContainText('Bitrix copy: Not copied to Bitrix');
      // The full reason stays behind "Why?" (BI-08).
      await expect(a).toContainText('Not copied to the Bitrix deal. Bitrix did not accept the file just now. (tried 5 of 5 times)');
      const b = page.getByRole('list', { name: 'ID proof files of Sample Traveller B' });
      await expect(b).toContainText('The Super Admin checks the deal in Bitrix and tries again.');
      await expect(b).toContainText('Only the Super Admin can try this copy again.');
      await expect(b.getByRole('button', { name: /Try again/ })).toHaveCount(0);
      await a.getByRole('button', { name: /Try again/ }).click();
      await expect(a.getByRole('status').filter({ hasText: 'The copy will be tried again shortly.' })).toBeVisible();
    });
  }

  test('Super Admin: automatic stops, open first, and how switching copy back on closes them', async ({ page }) => {
    await open(page, 'b12-admin-copy-alerts');
    const card = page.getByRole('region', { name: 'Bitrix copy stopped' });
    await expect(card).toContainText('1 open · 1 to check');
    await expect(card).toContainText('Switching copying on again with a reason closes every open stop.');
    const items = card.getByRole('list', { name: 'Automatic stops' }).getByRole('listitem');
    await expect(items.first()).toContainText('Open · Bitrix deal 50417');
    await expect(items.nth(1)).toContainText('Closed · Bitrix deal 50391');
    await expect(items.nth(1)).toContainText('when copying was switched on again');
    const checks = card.getByRole('list', { name: 'Copies to check by hand' });
    await expect(checks).toContainText('Bitrix deal 50402');
    await expect(card).toContainText('the CRM reads the deal first and sends the file only if it is not there');
    await checks.getByRole('button', { name: /Try again/ }).click();
    await expect(checks.getByRole('status').filter({ hasText: 'The copy will be tried again shortly.' })).toBeVisible();
  });

  test('Super Admin: no stops, and an unread list is said, never shown as none', async ({ page }) => {
    await open(page, 'b12-admin-copy-alerts-none');
    await expect(page.getByRole('region', { name: 'Bitrix copy stopped' })).toContainText('No automatic stops.');
    await expect(page.getByRole('region', { name: 'Bitrix copy stopped' })).toContainText('Nothing to check by hand.');
    await open(page, 'b12-admin-copy-alerts-unknown');
    const card = page.getByRole('region', { name: 'Bitrix copy stopped' });
    await expect(card).toContainText('The copy alerts could not be read. Nothing is assumed.');
    await expect(card).not.toContainText('No automatic stops.');
  });
});
