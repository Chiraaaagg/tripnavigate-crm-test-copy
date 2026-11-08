import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * Batch 4 Settings (Direction A R6; copy DA-250 to DA-264; money-privacy-
 * settings §10 R1 to R11) on the preview gallery: one Settings menu item, the
 * tab bar, switch rows with state words, last change and the one change flow
 * (choose and reason, review, confirm) on the shared HandForm, the Visa count
 * read at review time, which deals come in from Bitrix in two phases, and the
 * read-only Company and branches and System health pages. Synthetic props and
 * stand-in actions only: not evidence of a real journey (the database half is
 * Atlas's batch4-settings suite).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'settings-features',
  'settings-features-unknown',
  'settings-features-unreadable',
  'settings-features-not-installed',
  'settings-features-read-only',
  'settings-bitrix',
  'settings-bitrix-integration-only',
  'settings-bitrix-sync-not-installed',
  'settings-bitrix-sync-review',
  'settings-bitrix-sync-unknown',
  'settings-bitrix-sync-read-only',
  'settings-bitrix-sync-auto-unknown',
  'settings-company',
  'settings-company-pilot-unknown',
  'settings-company-error',
  'settings-company-no-permission',
  'settings-health',
  'settings-health-unknown',
];

accessibilitySuite('Batch 4 Settings: accessibility', STATES);
cspSuite('Batch 4 Settings: production style policy', STATES);

// Voice-note batch: Imports (the preview owner holds the import right too).
const TABS = ['People and access', 'Company and branches', 'Money rules', 'Bitrix connection', 'Imports', 'Features', 'System health'];

test.describe('Settings frame (DA-250 to DA-252)', () => {
  test('one Settings menu item, current on every Settings tab; the tab bar names the open tab in words', async ({ page }) => {
    for (const [state, tab] of [
      ['settings-features', 'Features'],
      ['settings-bitrix', 'Bitrix connection'],
      ['settings-company', 'Company and branches'],
      ['settings-health', 'System health'],
    ] as const) {
      await open(page, state);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Settings', exact: true }), state).toHaveAttribute('aria-current', 'page');
      for (const old of ['Staff', 'Access grants', 'Bitrix sync', 'Booking health', 'Workflow switches', 'Finance policy']) {
        await expect(nav.getByRole('link', { name: old, exact: true }), `${state}: ${old}`).toHaveCount(0);
      }
      const tabs = page.getByRole('navigation', { name: 'Settings sections' });
      await expect(tabs.getByRole('link')).toHaveText(TABS);
      await expect(tabs.getByRole('link', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="settings-tab-line"]')).toContainText(`${tab}:`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
      await expect(page.locator('main')).toContainText('Live changes need the owner’s APPROVE first; write it in the reason.');
    }
  });

  test('tabs follow the person’s rights: Bitrix connection manager and staff admin see only theirs', async ({ page }) => {
    await open(page, 'settings-bitrix-integration-only');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveText(['Company and branches', 'Bitrix connection', 'Features', 'System health']);
    await open(page, 'settings-company-pilot-unknown');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveText(['People and access', 'Company and branches']);
    // Sales: no Settings item, no tab bar; the page refuses on its own.
    await open(page, 'settings-company-no-permission');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Only staff with a Settings right can open this page.');
  });

  test('keyboard: the tabs are links in order and Enter follows one', async ({ page }) => {
    await open(page, 'settings-features');
    const tabs = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link');
    await tabs.first().focus();
    for (let i = 1; i < TABS.length; i += 1) {
      await page.keyboard.press('Tab');
      await expect(tabs.nth(i)).toBeFocused();
    }
    await expect(tabs.nth(4)).toHaveAttribute('href', '/app/admin/imports');
    await expect(tabs.nth(TABS.length - 1)).toHaveAttribute('href', '/app/admin/bookings');
  });
});

test.describe('Switch rows (DA-253 to DA-256)', () => {
  test('state in words with an icon, who it affects, and the last change per switch (person, system, none)', async ({ page }) => {
    await open(page, 'settings-features');
    const rows = page.locator('#feature-switches [data-slot="setting-row"]');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText('Book now (service list)');
    await expect(rows.nth(0)).toContainText('current state: On');
    await expect(rows.nth(0)).toContainText('Affects: every branch');
    await expect(rows.nth(0)).toContainText('by Synthetic Owner Jodhpur: switched on.');
    await expect(rows.nth(0)).toContainText('Reason: “Owner APPROVE in chat on 20 Oct (synthetic).”');
    await expect(rows.nth(1)).toContainText('by a system update (no person recorded): switched off.');
    await expect(rows.nth(2)).toContainText('No change recorded since change tracking started.');
    await expect(rows.nth(3)).toContainText('by you: switched off.');
    await pillsHaveIconAndWord(page);
    // Read-only rows: no control, the "not here" line.
    const live = page.locator('#feature-read-only [data-slot="setting-row"]');
    await expect(live).toHaveCount(2);
    await expect(live.first()).toContainText('Changed by the CRM team with the owner’s approval, not here.');
    await expect(page.locator('#feature-read-only').getByRole('button')).toHaveCount(0);
    // D3: the Bitrix switches moved; the page links there.
    await expect(page.getByRole('link', { name: 'Open Bitrix connection' })).toHaveAttribute('href', '/app/admin/integration');
    // Echo-B L9: a Super Admin is not told "only a Super Admin" under their own Change buttons.
    await expect(page.locator('main')).not.toContainText('Only a Super Admin can change them.');
  });

  test('change, review, confirm: reason required, the review names the effect and the approval, then the result', async ({ page }) => {
    await open(page, 'settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="intake_prompt_enabled"]');
    await row.getByRole('button', { name: 'Change Count of won deals with no booking (on Home)' }).click();
    const form = row.getByRole('form', { name: 'Change Count of won deals with no booking (on Home)' });
    await expect(form.getByRole('heading', { name: 'Change Count of won deals with no booking (on Home)' })).toBeFocused();
    await expect(form.getByRole('radio', { name: 'Off' })).toBeChecked();
    await expect(form.getByText('It is on now.')).toBeVisible();
    await form.getByRole('button', { name: 'Review change' }).click();
    await expect(form.getByLabel('Why are you changing it?')).toBeFocused();
    await expect(form).toContainText('Not saved: say why, in 10 to 500 characters.');
    await form.getByLabel('Why are you changing it?').fill('Owner APPROVE on 23 Oct to hide the count (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    await expect(form.getByRole('heading', { name: 'Review: turn Count of won deals with no booking (on Home) off' })).toBeFocused();
    await expect(form).toContainText('The count is hidden. Nothing else changes.');
    await expect(form).toContainText('Changing this in the live CRM needs the owner’s APPROVE first. Write it in the reason.');
    await expect(form).toContainText('Reason: “Owner APPROVE on 23 Oct to hide the count (synthetic).”');
    // Go back keeps the choice and the reason.
    await form.getByRole('button', { name: 'Go back' }).click();
    await expect(form.getByRole('radio', { name: 'Off' })).toBeChecked();
    await expect(form.getByLabel('Why are you changing it?')).toHaveValue('Owner APPROVE on 23 Oct to hide the count (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    await form.getByRole('button', { name: 'Turn Count of won deals with no booking (on Home) off' }).click();
    await expect(row.getByRole('status').filter({ hasText: 'Count of won deals with no booking (on Home) is now off. Recorded with your name and reason.' })).toBeVisible();
  });

  test('a refusal keeps the choice and the reason on screen (HandForm, R10)', async ({ page }) => {
    await open(page, 'settings-features-refused');
    const row = page.locator('[data-slot="setting-row"][data-key="service_items_enabled"]');
    await row.getByRole('button', { name: 'Change Book now (service list)' }).click();
    const form = row.getByRole('form', { name: 'Change Book now (service list)' });
    await form.getByLabel('Why are you changing it?').fill('Owner APPROVE on 23 Oct (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    await form.getByRole('button', { name: 'Turn Book now (service list) off' }).click();
    await expect(row.getByRole('alert')).toContainText('Only a Super Admin can change this. Nothing was changed.');
    await expect(form.getByRole('button', { name: 'Turn Book now (service list) off' })).toBeVisible();
    await expect(form).toContainText('Reason: “Owner APPROVE on 23 Oct (synthetic).”');
  });

  test('Visa and passport tasks: the count is read when Review is pressed; an unreadable count disables the confirm (DA-258)', async ({ page }) => {
    await open(page, 'settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await row.getByRole('button', { name: 'Change Visa and passport tasks' }).click();
    const form = row.getByRole('form', { name: 'Change Visa and passport tasks' });
    await expect(form.getByRole('radio', { name: 'On' })).toBeChecked();
    await form.getByLabel('Why are you changing it?').fill('Owner APPROVE: start the Visa desk (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    const count = form.locator('[data-slot="visa-count"]');
    await expect(count).toContainText('Switching on now creates 4 Visa and passport tasks on 3 deals, one for each sold service that has no task yet.');
    await expect(count).toContainText('1 services on removed or lost deals get no task.');
    await form.getByRole('button', { name: 'Turn Visa and passport tasks on' }).click();
    await expect(row.getByRole('status')).toContainText('Visa and passport tasks are on. 3 tasks were created (4 were counted in the review; services changed in between).');

    await open(page, 'settings-features-visa-uncounted');
    const row2 = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await row2.getByRole('button', { name: 'Change Visa and passport tasks' }).click();
    const form2 = row2.getByRole('form', { name: 'Change Visa and passport tasks' });
    await form2.getByLabel('Why are you changing it?').fill('Owner APPROVE: start the Visa desk (synthetic).');
    await form2.getByRole('button', { name: 'Review change' }).click();
    await expect(form2).toContainText('The CRM could not count the waiting services, so this cannot be switched on now.');
    await expect(form2.getByRole('button', { name: 'Turn Visa and passport tasks on' })).toBeDisabled();
  });

  test('Unknown is never Off and never offers a change (one row, a whole section, not installed)', async ({ page }) => {
    await open(page, 'settings-features-unknown');
    const visa = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await expect(visa).toContainText('current state: Unknown');
    await expect(visa).toContainText('Unknown is not Off. It cannot be changed until the CRM can read it.');
    await expect(visa).toContainText('Last change: could not be read.');
    await expect(visa.getByRole('button')).toHaveCount(0);
    await open(page, 'settings-features-unreadable');
    await expect(page.locator('#feature-switches')).toContainText('every switch here shows as Unknown. Nothing is assumed on or off.');
    await expect(page.locator('#feature-switches [data-slot="setting-row"]').filter({ hasText: 'current state: Off' })).toHaveCount(0);
    await expect(page.locator('#feature-switches').getByRole('button')).toHaveCount(0);
    await open(page, 'settings-features-not-installed');
    await expect(page.locator('#feature-switches')).toContainText('These settings are not installed in this CRM yet. Nothing is assumed on or off.');
    await expect(page.locator('#feature-switches').getByRole('button')).toHaveCount(0);
    await open(page, 'settings-features-read-only');
    await expect(page.locator('#feature-switches').getByRole('button')).toHaveCount(0);
    await expect(page.locator('#feature-switches')).toContainText('Only a Super Admin can change this.');
    await expect(page.locator('main')).toContainText('You can view these switches. Only a Super Admin can change them.');
  });
});

test.describe('Bitrix connection: switches and which deals come in (DA-257, DA-259)', () => {
  test('Bitrix switches as rows; Bitrix names keeps its own card; won-only row points to its card', async ({ page }) => {
    await open(page, 'settings-bitrix');
    const rows = page.locator('#bitrix-switches [data-slot="setting-row"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Read trip facts from Bitrix');
    await expect(rows.nth(2)).toContainText('Copy ID proofs to the Bitrix deal');
    await expect(rows.nth(3)).toContainText('Change it in “Bring in deals only when won” below.');
    await expect(page.getByRole('region', { name: 'Bring in deals only when won' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Bitrix connection' })).toBeVisible();
  });

  test('the leads switch review says it changes which leads are in the CRM for everyone', async ({ page }) => {
    await open(page, 'settings-bitrix');
    const row = page.locator('[data-slot="setting-row"][data-key="lead_intake_unowned"]');
    await row.getByRole('button', { name: 'Change Bring in leads whose Bitrix owner is not a CRM salesperson' }).click();
    const form = row.getByRole('form');
    await form.getByLabel('Why are you changing it?').fill('Owner APPROVE: bring in unowned leads (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    await expect(form).toContainText('This changes which deals or leads are in the CRM for everyone.');
  });

  test('two phases: Review changes counts the deals, then Save and hide {n} deals; nothing is saved before the confirm', async ({ page }) => {
    await open(page, 'settings-bitrix');
    const section = page.getByRole('region', { name: 'Which deals come in from Bitrix' });
    await expect(section).toContainText('Unticking a stage or pipeline hides its deals from everyone in the CRM.');
    await expect(section).toContainText('Automatic updates: On');
    await expect(section).toContainText('by Synthetic Integration Admin.');
    await expect(section).toContainText('Hid 4 and brought back 0 deals.');
    const edit = section.getByRole('form', { name: 'Change which deals come in from Bitrix' });
    await edit.getByRole('checkbox', { name: 'Pipeline: Synthetic corporate pipeline' }).uncheck();
    await expect(edit.getByRole('checkbox', { name: 'New request' })).toBeDisabled();
    await edit.getByRole('button', { name: 'Review changes' }).click();
    await expect(edit.getByLabel('Why are you changing it?')).toBeFocused();
    await edit.getByLabel('Why are you changing it?').fill('Owner APPROVE on 23 Oct: stop the corporate pipeline (synthetic).');
    await edit.getByRole('button', { name: 'Review changes' }).click();
    const review = section.getByRole('form', { name: 'Review: which deals come in from Bitrix' });
    await expect(review.getByRole('heading', { name: 'Review: which deals come in from Bitrix' })).toBeFocused();
    await expect(review).toContainText('Pipelines removed: Synthetic corporate pipeline');
    await expect(review).toContainText('Hides 12 deals from everyone now.');
    await expect(review).toContainText('0 created before the date · 9 in a pipeline no longer ticked · 3 in a stage no longer ticked');
    await expect(review).toContainText('2 of them have CRM work');
    await expect(review).toContainText('Brings back 1 hidden deals.');
    await expect(review).toContainText('this number is not exact.');
    await expect(review).toContainText('Get the owner’s APPROVE first and write it in the reason.');
    await expect(review).toContainText('This review is valid for 10 minutes.');
    // Go back keeps every tick and the reason.
    await review.getByRole('button', { name: 'Go back and change' }).click();
    await expect(edit.getByRole('checkbox', { name: 'Pipeline: Synthetic corporate pipeline' })).not.toBeChecked();
    await expect(edit.getByLabel('Why are you changing it?')).toHaveValue('Owner APPROVE on 23 Oct: stop the corporate pipeline (synthetic).');
    await edit.getByRole('button', { name: 'Review changes' }).click();
    await section.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'Saved. 12 deals hidden and 1 brought back. Recorded with your name and reason.' })).toBeVisible();
  });

  test('numbers changed after the review: refused, and the review comes back with the new numbers', async ({ page }) => {
    await open(page, 'settings-bitrix-sync-stale');
    const section = page.getByRole('region', { name: 'Which deals come in from Bitrix' });
    await section.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    await expect(section.getByRole('alert')).toContainText('Not saved: the numbers changed after your review. Check the new numbers below and confirm again.');
    await expect(section).toContainText('Hides 13 deals from everyone now.');
    await expect(section.getByRole('button', { name: 'Save and hide 13 deals' })).toBeVisible();
  });

  test('not installed, unknown and read-only: never a one-step save, never Off for an unread state', async ({ page }) => {
    await open(page, 'settings-bitrix-sync-not-installed');
    const section = page.getByRole('region', { name: 'Which deals come in from Bitrix' });
    await expect(section).toContainText('Reviewing these changes is not installed in this CRM yet, so they cannot be saved now. Nothing was changed.');
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save sync settings' })).toHaveCount(0);
    await open(page, 'settings-bitrix-sync-unknown');
    await expect(page.getByRole('region', { name: 'Which deals come in from Bitrix' })).toContainText('every switch here shows as Unknown');
    await expect(page.getByRole('region', { name: 'Which deals come in from Bitrix' }).getByRole('checkbox')).toHaveCount(0);
    await open(page, 'settings-bitrix-sync-read-only');
    await expect(page.getByRole('region', { name: 'Which deals come in from Bitrix' })).toContainText('Only staff who manage the Bitrix connection can change this.');
    await open(page, 'settings-bitrix-sync-auto-unknown');
    const auto = page.getByRole('region', { name: 'Which deals come in from Bitrix' });
    await expect(auto).toContainText('Automatic updates: Unknown');
    await expect(auto).not.toContainText('Automatic updates: Off');
    // Echo-A L4: no default when Unknown; Review asks for a choice first.
    const group = auto.getByRole('group', { name: 'Automatic updates from Bitrix (every 30 seconds)' });
    await expect(group.getByRole('radio', { name: 'On' })).not.toBeChecked();
    await expect(group.getByRole('radio', { name: 'Off' })).not.toBeChecked();
    await auto.getByLabel('Why are you changing it?').fill('Owner APPROVE: check the scope (synthetic).');
    await auto.getByRole('button', { name: 'Review changes' }).click();
    await expect(group).toContainText('Choose whether automatic updates are on.');
    await expect(auto.getByRole('form', { name: 'Review: which deals come in from Bitrix' })).toHaveCount(0);
    await group.getByRole('radio', { name: 'Off' }).check();
    await auto.getByRole('button', { name: 'Review changes' }).click();
    await expect(auto.getByRole('form', { name: 'Review: which deals come in from Bitrix' })).toBeVisible();
  });
});

test.describe('Read-only tabs (DA-261, DA-262)', () => {
  test('Company and branches: company details, GSTIN per branch, the Bitrix pilot; no control', async ({ page }) => {
    await open(page, 'settings-company');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 2, name: 'Company and branches' })).toBeVisible();
    await expect(main).toContainText('Holiday Chacha Pvt LTD');
    const table = main.getByRole('region', { name: 'Branches' });
    await expect(table.getByRole('row', { name: /Jodhpur/ })).toContainText('Pilot branch');
    await expect(table.getByRole('row', { name: /Delhi/ })).toContainText('Not given yet. Final PDFs for this branch are blocked until it is added.');
    await expect(main.getByRole('button')).toHaveCount(0);
    await expect(main.locator('form, input, select, textarea')).toHaveCount(0);
    await open(page, 'settings-company-pilot-unknown');
    await expect(page.locator('main')).toContainText('Not known (could not be read)');
    await expect(page.locator('main')).toContainText('Synthetic Udaipur is not in the approved company details yet.');
    await open(page, 'settings-company-error');
    await expect(page.locator('main').getByRole('alert')).toContainText('Company details did not load. Nothing was changed.');
  });

  test('System health: facts in words, never healthy when unknown, no control', async ({ page }) => {
    await open(page, 'settings-health');
    const main = page.locator('main');
    await expect(main).toContainText('Real bookings: off');
    await expect(main).toContainText('Internal notices waiting: 6. Nothing is sent to Bitrix, hotels or customers.');
    await expect(main).toContainText('Email alerts are off: problems show only on this page.');
    await expect(main).toContainText('Changed in the hosting settings with the owner’s approval, not here.');
    await expect(main.getByRole('link', { name: 'Open Bitrix connection' })).toHaveAttribute('href', '/app/admin/integration');
    await expect(main.getByRole('button')).toHaveCount(0);
    await expect(main.locator('form')).toHaveCount(0);
    await pillsHaveIconAndWord(page);
    await open(page, 'settings-health-unknown');
    const u = page.locator('main');
    await expect(u).toContainText('Booking health: Unknown');
    await expect(u).toContainText('Nothing is assumed healthy');
    await expect(u).not.toContainText('Receiving deals');
    await expect(u).toContainText('Online PDF maker');
    await expect(u.locator('[data-slot="status-badge"]', { hasText: 'Off' })).toHaveCount(0);
  });

  test('Money rules: payment modes read only per company; Unknown is not Off', async ({ page }) => {
    await open(page, 'finance-policy');
    const modes = page.getByRole('region', { name: 'Payment modes' });
    await expect(modes).toContainText('Bank transfer');
    await expect(modes).toContainText('Available');
    await expect(modes).toContainText('Not available yet');
    await expect(modes.locator('[data-key="finance_mode"]').filter({ hasText: 'current state: Unknown' })).toHaveCount(1);
    await expect(modes).toContainText('Changed by the CRM team with the owner’s approval, not here.');
    await expect(modes.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Finance policy' })).toBeVisible();
  });
});
