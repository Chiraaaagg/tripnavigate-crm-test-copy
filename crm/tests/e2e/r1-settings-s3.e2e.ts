import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';
import { waitForHydration } from './hydration';

/**
 * UX redesign R1, helper S3 (build plan 4.4): Settings › Bitrix connection in
 * four sub-tabs, Customer messages as its own area with the nine-by-two grid
 * and no language choice (owner decision D12), the Imports index and System
 * health in the Settings frame. Preview gallery only (synthetic props,
 * stand-in actions): no database, nothing sent. Runs in GitHub Actions only
 * (owner rule, 17 November 2026: no Playwright on the owner's Mac).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const BITRIX_STATES = ['r1-bitrix-status', 'r1-bitrix-status-problems', 'r1-bitrix-deals', 'r1-bitrix-switches', 'r1-bitrix-cleanup', 'r1-bitrix-cleanup-attention', 'r1-bitrix-sync-confirm', 'r1-bitrix-sync-confirm-stale'];
const MESSAGE_STATES = [
  'acc3-messages-settings',
  'acc3-messages-settings-whatsapp-blocked',
  'acc3-messages-settings-texts',
  'acc3-messages-settings-pilot',
  'acc3-messages-settings-pilot-everyone',
  'acc3-messages-settings-setup',
  'acc3-messages-settings-setup-running',
];
const IMPORT_STATES = ['r1-imports-index', 'r1-imports-index-accounts'];
const ALL = [...BITRIX_STATES, ...MESSAGE_STATES, ...IMPORT_STATES, 'settings-health'];

accessibilitySuite('R1 S3 Settings areas: accessibility', ALL);
cspSuite('R1 S3 Settings areas: production style policy', ALL);

const sectionLinks = (page: Page, name: string) => page.getByRole('navigation', { name }).getByRole('link');

test.describe('Bitrix connection: four sub-tabs', () => {
  test('the sub-tabs are links on the same address; the old address is Status; one is current', async ({ page }) => {
    for (const [state, current] of [
      ['r1-bitrix-status', 'Status'],
      ['r1-bitrix-deals', 'Which deals come in'],
      ['r1-bitrix-switches', 'Switches'],
      ['r1-bitrix-cleanup', 'Clean-up'],
    ] as const) {
      await open(page, state);
      const links = sectionLinks(page, 'Bitrix connection sections');
      await expect(links).toHaveText(['Status', 'Which deals come in', 'Switches', 'Clean-up']);
      expect(await links.evaluateAll((all) => all.map((a) => a.getAttribute('href')))).toEqual([
        '/app/admin/integration',
        '/app/admin/integration?tab=deals',
        '/app/admin/integration?tab=switches',
        '/app/admin/integration?tab=cleanup',
      ]);
      await expect(page.getByRole('navigation', { name: 'Bitrix connection sections' }).locator('[aria-current="page"]')).toHaveText(current);
    }
  });

  test('Status: technical checklist behind "Details" (closed when healthy, open when something is wrong); Check Bitrix now', async ({ page }) => {
    await open(page, 'r1-bitrix-status');
    const details = page.locator('[data-slot="bitrix-details"]');
    await expect(details).not.toHaveAttribute('open', /.*/);
    await expect(page.getByRole('list', { name: 'Intake health checks' })).toBeHidden();
    await details.locator('summary').click();
    await expect(page.getByRole('list', { name: 'Intake health checks' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check Bitrix now' })).toBeVisible();
    // Clean-up content is not on Status.
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toHaveCount(0);
    await open(page, 'r1-bitrix-status-problems');
    await expect(page.locator('[data-slot="bitrix-details"]')).toHaveAttribute('open', '');
    await expect(page.locator('[data-slot="bitrix-cleanup-pointer"]')).toContainText('2 items need attention and 2 deals are waiting for an owner.');
    await expect(page.getByRole('link', { name: 'Open Clean-up' })).toHaveAttribute('href', '/app/admin/integration?tab=cleanup');
    await expect(sectionLinks(page, 'Bitrix connection sections').filter({ hasText: 'Clean-up' })).toContainText('4');
  });

  test('"Bring in deals only when won" is shown once: its card on Which deals come in, no row on Switches', async ({ page }) => {
    await open(page, 'r1-bitrix-deals');
    await expect(page.getByRole('heading', { name: 'Bring in deals only when won' })).toHaveCount(1);
    await expect(page.getByRole('form', { name: 'Change which deals come in from Bitrix' })).toBeVisible();
    await open(page, 'r1-bitrix-switches');
    await expect(page.getByText('Bring in deals only when won', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-key="won_only_intake"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Bitrix names' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bitrix switches' })).toBeVisible();
    await pillsHaveIconAndWord(page);
  });

  test('Clean-up: zero counts on one line; counts as a list and rows with Retry when something is open', async ({ page }) => {
    await open(page, 'r1-bitrix-cleanup');
    await expect(page.locator('[data-slot="open-sync-work-line"]')).toHaveText('Nothing open: 0 waiting, 0 processing, 0 to review, 0 failed, 0 stopped.');
    await expect(page.getByRole('heading', { name: 'Deals waiting for an owner' })).toBeVisible();
    await open(page, 'r1-bitrix-cleanup-attention');
    await expect(page.locator('[data-slot="open-sync-work-line"]')).toHaveCount(0);
    await expect(page.locator('.stat-grid')).toContainText('Needs review');
    await expect(page.getByRole('table')).toContainText('2 items need attention');
    await expect(page.getByRole('button', { name: /^Retry/ })).toHaveCount(2);
  });
});

test.describe('Which deals come in: one confirm dialog with the effect and a required reason (C7, owner Q1)', () => {
  const REVIEW = 'Review: which deals come in from Bitrix';
  const REASON = 'Owner APPROVE on 17 Nov: stop the corporate pipeline (synthetic).';

  test('count, then one dialog: effect, who is affected, required reason, Cancel first; then saved', async ({ page }) => {
    await open(page, 'r1-bitrix-deals');
    await waitForHydration(page);
    const edit = page.getByRole('form', { name: 'Change which deals come in from Bitrix' });
    // No reason box on the page any more: it is in the dialog.
    await expect(edit.getByRole('textbox')).toHaveCount(0);
    await edit.getByRole('checkbox', { name: 'Pipeline: Synthetic corporate pipeline' }).uncheck();
    await edit.getByRole('button', { name: 'Review changes' }).click();
    const dialog = page.getByRole('alertdialog', { name: REVIEW });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('Hides 12 deals from everyone now.');
    await expect(dialog).toContainText('Pipelines removed: Synthetic corporate pipeline');
    await expect(dialog).toContainText('Who is affected: Everyone: it changes which deals are in the CRM.');
    await expect(dialog).toContainText('Get the owner’s APPROVE first and write it in the reason.');
    await expect(dialog).toContainText('This review is valid for 10 minutes.');
    // Required: an empty reason is refused here and nothing is sent.
    await dialog.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    await expect(dialog).toContainText('Write the reason: at least 10 characters. Nothing was changed.');
    await expect(dialog.getByRole('textbox', { name: 'Why are you changing it?' })).toBeFocused();
    // Cancel keeps the ticks on the page; the count can be opened again.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit.getByRole('checkbox', { name: 'Pipeline: Synthetic corporate pipeline' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Show the count again' }).click();
    await page.getByRole('alertdialog', { name: REVIEW }).getByRole('textbox', { name: 'Why are you changing it?' }).fill(REASON);
    await page.getByRole('alertdialog', { name: REVIEW }).getByRole('button', { name: 'Save and hide 12 deals' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Saved. 12 deals hidden and 1 brought back. Recorded with your name and reason.' })).toBeVisible();
  });

  test('the dialog posts the same fields as before: previewId, reason, the counted ticks, cutoff, syncEnabled', async ({ page }) => {
    await open(page, 'r1-bitrix-sync-confirm');
    await waitForHydration(page);
    const dialog = page.getByRole('alertdialog', { name: REVIEW });
    await expect(dialog).toBeVisible();
    const names = await dialog.locator('form input[type="hidden"]').evaluateAll((all) => all.map((i) => (i as HTMLInputElement).name).sort());
    expect([...new Set(names)]).toEqual(['categoryId', 'cutoff', 'previewId', 'stageId', 'syncEnabled']);
    await expect(dialog.locator('form textarea[name="reason"]')).toHaveCount(1);
    await expect(dialog.locator('input[name="syncEnabled"]')).toHaveValue('on');
    await expect(dialog.locator('input[name="cutoff"]')).toHaveValue('2026-09-01');
  });

  test('numbers changed after the count: refused in the dialog, fresh numbers, the typed reason kept', async ({ page }) => {
    await open(page, 'r1-bitrix-sync-confirm-stale');
    await waitForHydration(page);
    const dialog = page.getByRole('alertdialog', { name: REVIEW });
    await expect(dialog.getByRole('textbox', { name: 'Why are you changing it?' })).toHaveValue(REASON);
    await dialog.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    const again = page.getByRole('alertdialog', { name: REVIEW });
    await expect(again.getByRole('alert')).toContainText('Not saved: the numbers changed after your review. Check the new numbers below and confirm again.');
    await expect(again).toContainText('Hides 13 deals from everyone now.');
    await expect(again.getByRole('button', { name: 'Save and hide 13 deals' })).toBeVisible();
    await expect(again.getByRole('textbox', { name: 'Why are you changing it?' })).toHaveValue(REASON);
  });
});

test.describe('Customer messages: its own area, nine-by-two grid, English only (D12)', () => {
  test('sub-tabs Switches · Texts · Pilot list · Set-up on the same address', async ({ page }) => {
    await open(page, 'acc3-messages-settings');
    const links = sectionLinks(page, 'Customer messages sections');
    await expect(links).toHaveText(['Switches', 'Texts', /^Pilot list/, 'Set-up']);
    expect(await links.evaluateAll((all) => all.map((a) => a.getAttribute('href')))).toEqual([
      '/app/admin/customer-messages',
      '/app/admin/customer-messages?tab=texts',
      '/app/admin/customer-messages?tab=pilot',
      '/app/admin/customer-messages?tab=setup',
    ]);
    await expect(page.getByRole('heading', { level: 2, name: 'Customer messages' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Every message is in English.');
  });

  test('the grid: nine messages × e-mail and WhatsApp, state in words; a blocked WhatsApp cell says why', async ({ page }) => {
    await open(page, 'acc3-messages-settings-whatsapp-blocked');
    const grid = page.getByRole('region', { name: 'Customer message switches' });
    await expect(grid.locator('tbody tr')).toHaveCount(9);
    await expect(grid.getByRole('columnheader')).toHaveText(['Message', 'E-mail', 'WhatsApp']);
    const cell = grid.locator('[data-cell="e_ticket-whatsapp"]');
    await expect(cell.locator('[data-slot="status-badge"]')).toContainText('Off');
    const blocked = cell.getByRole('button', { name: 'Turn on: E-ticket by WhatsApp' });
    await expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await expect(cell).toContainText('WhatsApp has not approved this text yet. Set its status on the Texts tab.');
    // Hotel voucher: the English text is approved; only the unused second text holds the switch (database rule A7).
    await expect(grid.locator('[data-cell="hotel_voucher-whatsapp"]')).toContainText('The CRM team must remove that check.');
    await expect(grid.locator('[data-cell="e_ticket-email"]').getByRole('button', { name: 'Turn on: E-ticket by E-mail' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('a switch posts the same fields as before (entityId, type, channel, enabled, expectedRowVersion, requestId, reason)', async ({ page }) => {
    await open(page, 'acc3-messages-settings-switch-open');
    await waitForHydration(page);
    const dialog = page.getByRole('dialog', { name: 'Turn on: E-ticket by E-mail' });
    await expect(dialog).toBeVisible();
    const hidden = await dialog.locator('input[type="hidden"]').evaluateAll((all) => Object.fromEntries(all.map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])));
    expect(Object.keys(hidden).sort()).toEqual(['channel', 'enabled', 'entityId', 'expectedRowVersion', 'requestId', 'type']);
    expect(hidden).toMatchObject({ type: 'e_ticket', channel: 'email', enabled: 'true', expectedRowVersion: '1' });
    await expect(dialog.locator('textarea[name="reason"]')).toHaveCount(1);
  });

  test('no language anywhere: Texts shows the English text only; no Hindi column or language words', async ({ page }) => {
    for (const state of MESSAGE_STATES) {
      await open(page, state);
      await expect(page.locator('main'), state).not.toContainText(/Hindi|हिन्दी/);
    }
    await open(page, 'acc3-messages-settings-texts');
    await expect(page.locator('main details')).toHaveCount(9);
    await expect(page.locator('[lang="hi"]')).toHaveCount(0);
    await open(page, 'acc3-messages-settings-template-open');
    await waitForHydration(page);
    const dialog = page.getByRole('dialog', { name: 'WhatsApp status — E-ticket' });
    await expect(dialog.locator('input[name="templateCode"]')).toHaveValue('tn_e_ticket_en_v1');
  });

  test('Pilot list and Set-up are switch rows with the state in words', async ({ page }) => {
    await open(page, 'acc3-messages-settings-pilot');
    await expect(page.locator('#cmsg-pilot-only-state')).toContainText('On');
    await expect(page.getByRole('button', { name: 'Send to every Deal' })).toBeVisible();
    await expect(page.getByText('SYN-JOD-101')).toBeVisible();
    await open(page, 'acc3-messages-settings-setup');
    await expect(page.locator('#cmsg-timer-switch-state')).toContainText('Off');
    await expect(page.getByRole('region', { name: 'Sending set-up' })).toContainText('Not configured');
  });

  test('Book now and the Deal card form: no language box; the form posts language=en', async ({ page }) => {
    for (const state of ['acc3-messages-booknow', 'acc3-messages-booknow-card', 'acc3-messages-booknow-card-refused']) {
      await open(page, state);
      await expect(page.getByRole('radio'), state).toHaveCount(0);
      await expect(page.locator('input[type="hidden"][name="language"]'), state).toHaveValue('en');
      await expect(page.locator('main'), state).not.toContainText(/Hindi/);
    }
  });
});

test.describe('Imports index and System health in the Settings frame', () => {
  test('Imports index: one row per list, the ones this person may import first, each opening the same ?kind= page', async ({ page }) => {
    await open(page, 'r1-imports-index-accounts');
    await expect(page.getByRole('heading', { level: 2, name: 'Imports' })).toBeVisible();
    const rows = page.getByRole('list', { name: 'What you can import' }).getByRole('link');
    expect(await rows.evaluateAll((all) => all.map((a) => a.getAttribute('href')))).toEqual([
      '/app/admin/imports?kind=customer',
      '/app/admin/imports?kind=supplier',
      '/app/admin/imports?kind=hotel',
    ]);
    await expect(rows.nth(2)).toContainText('Only a Super Admin can import the hotel list.');
    await expect(rows.nth(0)).toContainText('You can import this list.');
    await open(page, 'r1-imports-index');
    await expect(page.getByRole('list', { name: 'What you can import' }).getByRole('link')).toHaveCount(4);
  });

  test('System health: the area name is the heading; facts are rows in one card', async ({ page }) => {
    await open(page, 'settings-health');
    await expect(page.getByRole('heading', { level: 2, name: 'System health' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Real bookings: off');
  });
});
