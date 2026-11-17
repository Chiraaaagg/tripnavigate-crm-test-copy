import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open } from './b11-helpers';

/**
 * B1.2 switches, Batch 4: rows on Settings · Bitrix connection (Super
 * Admin), through the design preview states (synthetic props; stand-in
 * actions). State in words, Not known never shown as off, and one confirm
 * dialog (UX redesign R1, C7) that says what changes (with the owner's
 * approval line); the reason may be left empty (owner D9).
 * The online PDF maker is a read-only row on System health (batch4-settings).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = ['b12-admin-switches', 'b12-admin-switches-read-only'];

accessibilitySuite('B1.2 switches: accessibility', STATES);
cspSuite('B1.2 switches: production style policy', STATES);

const rows = (page: import('@playwright/test').Page) => page.locator('#bitrix-switches [data-slot="setting-row"]');

test.describe('B1.2 switches', () => {
  test('rows in words with an icon; the copy row says it is the only setting that writes to Bitrix', async ({ page }) => {
    await open(page, 'b12-admin-switches');
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(0)).toContainText('Read trip facts from Bitrix');
    await expect(rows(page).nth(0)).toContainText('State: On');
    await expect(rows(page).nth(1)).toContainText('State: Off');
    await expect(rows(page).nth(2)).toContainText('Copy ID proofs to the Bitrix deal');
    // The approval line is once in Settings (R1: on the Overview, no longer repeated by the frame on each area page)
    // and inside every confirm dialog (next test), never on every row.
    await expect(page.locator('main')).not.toContainText('Live changes need the owner’s APPROVE first; write it in the reason.');
    for (const row of await rows(page).all()) await expect(row).not.toContainText('APPROVE first');
    await open(page, 'settings-overview');
    await expect(page.locator('main')).toContainText('Changes here affect every branch. Live changes need the owner’s APPROVE first. Every change is recorded with the person and the time.');
  });

  test('switching the copy on: one confirm dialog that says what changes and that open stops close; the reason may be left empty (D9)', async ({ page }) => {
    await open(page, 'b12-admin-switches');
    const row = page.locator('[data-slot="setting-row"][data-key="bitrix_id_proof_copy"]');
    const change = row.getByRole('button', { name: 'Change Copy ID proofs to the Bitrix deal' });
    await change.click();
    const dialog = page.getByRole('alertdialog', { name: 'Turn Copy ID proofs to the Bitrix deal on?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('This is the only setting that writes to Bitrix.');
    await expect(dialog).toContainText('Switching on also closes 2 open automatic stops with your reason.');
    await expect(dialog).toContainText('Changing this in the live CRM needs the owner’s APPROVE first. Write it in the reason.');
    await expect(dialog.getByLabel('Why are you changing it?')).toHaveAccessibleDescription(/You may leave it empty/);
    // Escape cancels and puts focus back on Change.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(change).toBeFocused();
    await change.click();
    await dialog.getByLabel('Why are you changing it?').fill('Owner approved the copy on 13 Oct (synthetic).');
    await dialog.getByRole('button', { name: 'Turn Copy ID proofs to the Bitrix deal on' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole('status')).toContainText('Copy ID proofs to the Bitrix deal is now on. Recorded with your name and reason.');
  });

  test('not a Super Admin, or a state that could not be read: Change disabled with the reason, and Not known is never Off', async ({ page }) => {
    await open(page, 'b12-admin-switches-read-only');
    await expect(rows(page).nth(2)).toContainText('State: Not known');
    await expect(rows(page).nth(2)).toContainText('The CRM could not read this setting, so it shows as Unknown. Unknown is not Off.');
    await expect(rows(page).nth(2)).not.toContainText('State: Off');
    await expect(page.locator('#bitrix-switches')).toContainText('Only a Super Admin can change this.');
    // Three switches show Change disabled with the reason; the won-only row is read only here (its own card changes it).
    const buttons = page.locator('#bitrix-switches').getByRole('button', { name: 'Change', exact: true });
    await expect(buttons).toHaveCount(3);
    for (const b of await buttons.all()) await expect(b).toBeDisabled();
    await expect(page.locator('#bitrix-switches').getByRole('button', { name: /^Change ./ })).toHaveCount(0);
    await expect(page.locator('#bitrix-switches').getByRole('radio')).toHaveCount(0);
  });
});
