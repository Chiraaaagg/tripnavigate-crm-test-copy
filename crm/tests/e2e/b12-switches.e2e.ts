import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open } from './b11-helpers';

/**
 * B1.2 switches, Batch 4: rows on Settings · Bitrix connection (Super
 * Admin), through the design preview states (synthetic props; stand-in
 * actions). State in words, unknown never shown as off, a reason and a review
 * that says what changes (with the owner's approval line) before the confirm.
 * The online PDF maker is a read-only row on System health (batch4-settings).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = ['b12-admin-switches', 'b12-admin-switches-read-only'];

accessibilitySuite('B1.2 switches: accessibility', STATES);
cspSuite('B1.2 switches: production style policy', STATES);

const rows = (page: import('@playwright/test').Page) => page.locator('#bitrix-switches [data-slot="setting-row"]');

test.describe('B1.2 switches', () => {
  test('rows in words with an icon; the copy row says it is the only setting that writes to Bitrix after review', async ({ page }) => {
    await open(page, 'b12-admin-switches');
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(0)).toContainText('Read trip facts from Bitrix');
    await expect(rows(page).nth(0)).toContainText('current state: On');
    await expect(rows(page).nth(1)).toContainText('current state: Off');
    await expect(rows(page).nth(2)).toContainText('Copy ID proofs to the Bitrix deal');
    // The approval line is once per page (Settings frame) and inside every review, not on every row.
    await expect(page.locator('main')).toContainText('Live changes need the owner’s APPROVE first; write it in the reason.');
  });

  test('switching the copy on: reason required, then a review that says what changes and that open stops close', async ({ page }) => {
    await open(page, 'b12-admin-switches');
    const row = page.locator('[data-slot="setting-row"][data-key="bitrix_id_proof_copy"]');
    await row.getByRole('button', { name: 'Change Copy ID proofs to the Bitrix deal' }).click();
    const form = row.getByRole('form', { name: 'Change Copy ID proofs to the Bitrix deal' });
    await expect(form.getByRole('radio', { name: 'On' })).toBeChecked();
    await form.getByRole('button', { name: 'Review change' }).click();
    await expect(form).toContainText('Not saved: say why, in 10 to 500 characters.');
    await expect(form.getByRole('button', { name: 'Turn Copy ID proofs to the Bitrix deal on' })).toHaveCount(0);
    await form.getByLabel('Why are you changing it?').fill('Owner approved the copy on 13 Oct (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    await expect(form.getByRole('heading', { name: 'Review: turn Copy ID proofs to the Bitrix deal on' })).toBeFocused();
    await expect(form).toContainText('This is the only setting that writes to Bitrix.');
    await expect(form).toContainText('Switching on also closes 2 open automatic stops with your reason.');
    await expect(form).toContainText('Changing this in the live CRM needs the owner’s APPROVE first. Write it in the reason.');
    await form.getByRole('button', { name: 'Turn Copy ID proofs to the Bitrix deal on' }).click();
    await expect(row.getByRole('status')).toContainText('Copy ID proofs to the Bitrix deal is now on. Recorded with your name and reason.');
  });

  test('not a Super Admin, or a state that could not be read: no change control, and unknown is never off', async ({ page }) => {
    await open(page, 'b12-admin-switches-read-only');
    await expect(rows(page).nth(2)).toContainText('current state: Unknown');
    await expect(rows(page).nth(2)).toContainText('The CRM could not read this setting, so it shows as Unknown. Unknown is not Off.');
    await expect(rows(page).nth(2)).not.toContainText('current state: Off');
    await expect(page.locator('#bitrix-switches')).toContainText('Only a Super Admin can change this.');
    await expect(page.locator('#bitrix-switches').getByRole('button')).toHaveCount(0);
    await expect(page.locator('#bitrix-switches').getByRole('radio')).toHaveCount(0);
  });
});
