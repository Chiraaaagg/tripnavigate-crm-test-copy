import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Stage 2 company accounts (bank accounts and UPI IDs) through the design
 * preview gallery: synthetic props, no Supabase, stub actions that save
 * nothing. Not evidence of a real journey; the database half lives in the
 * finance PGlite and real-stack suites.
 */

const states = [
  'finance-destinations',
  'finance-destinations-own',
  'finance-destinations-empty',
  'finance-destinations-add-error',
  'finance-destinations-unavailable',
  'finance-deal-destinations',
  'finance-deal-no-destination',
  'finance-deal-destinations-unavailable',
  'finance-deal-destination-changed',
];

const DISCLAIMER = 'Receipt numbers are internal. They are not tax invoices.';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const OWN_REASON = 'You submitted this version. Another Accounts person must approve or return it.';
const NO_ACCOUNT = 'No approved company account is in use. Another Accounts person must approve one in Company accounts first.';
const NOT_LOADED =
  'Company accounts could not be loaded, so bank transfer and UPI receipts cannot be recorded right now. Reload the page. If this continues, finance may not be set up for company accounts yet.';

async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function open(page: Page, state: string) {
  await page.goto(`/preview/${state}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await page.waitForLoadState('networkidle');
}

async function expandAll(page: Page) {
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll('details'))) d.open = true;
  });
}

async function closeDrawer(page: Page) {
  if ((await page.getByRole('dialog').count()) === 0) return;
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** R4: "Record a receipt" at the top of the deal page opens the existing receipt form in a drawer (a dialog). */
async function recordDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Record a receipt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Record a receipt' });
  await expect(dialog).toBeVisible();
  return dialog;
}

function card(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Company accounts' }).getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });
}

test.describe('Stage 2 previews: accessibility on desktop and 390 px', () => {
  for (const state of states) {
    test(`axe clean with every section open, one h1, disclaimer: ${state}`, async ({ page }) => {
      await open(page, state);
      await expandAll(page);
      expect(await axe(page)).toEqual([]);
      // An open drawer (refusal states) hides the page from assistive technology; close it to read the page.
      await closeDrawer(page);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      await expect(page.getByRole('main').getByText(DISCLAIMER)).toBeVisible();
    });
    test(`390 px, no sideways scroll: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await expandAll(page);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('Company accounts panel', () => {
  test('every state is told apart in words, and approval is not a payment', async ({ page }) => {
    await open(page, 'finance-destinations');
    const main = page.getByRole('main');
    await expect(main).toContainText('Approval confirms the company details as entered. It does not check that the bank account belongs to the company, and it is not a payment.');
    await expect(card(page, 'Main current account')).toContainText('Approved, in use');
    await expect(card(page, 'New collections account')).toContainText('Waiting for approval');
    await expect(card(page, 'New collections account')).toContainText('Not yet. No version has been approved.');
    await expect(card(page, 'Office UPI')).toContainText('Returned for correction');
    await expect(card(page, 'Office UPI')).toContainText('Payee name does not match the company name on the bank letter.');
    await expect(card(page, 'Old branch account')).toContainText('Retired');
    await expect(card(page, 'Old branch account')).toContainText('No. This account is retired.');
    await expect(card(page, 'Retired with a late version')).toContainText('Version 2 submitted after retirement');
    // A pending replacement does not take the current version out of use.
    const replacing = card(page, 'Main current account replacement');
    await expect(replacing).toContainText('Version 1 · Synthetic Bank XXXX4321');
    await expect(replacing).toContainText('Version 2 · Synthetic Bank XXXX2222');
    // The superseded version stays in the history as "Replaced".
    const main1 = card(page, 'Main current account');
    await main1.getByText('Version history (2)').click();
    await expect(main1.getByRole('list', { name: 'Versions of Main current account, newest first' })).toContainText('Replaced');
    await expect(main1.getByRole('list', { name: 'Versions of Main current account, newest first' })).toContainText('Approved, current');
  });

  test('lists are masked; full details come only from the recorded POST and can be hidden', async ({ page }) => {
    await open(page, 'finance-destinations');
    const main = page.getByRole('main');
    await expect(main).toContainText('XXXX6789');
    await expect(main).toContainText('s***@synbank');
    await expect(main).not.toContainText('000123452222');
    const pending = card(page, 'New collections account');
    const urlBefore = page.url();
    const titleBefore = await page.title();
    const show = pending.getByRole('button', { name: 'Show full details of version 1' }).first();
    await expect(show).toHaveAccessibleDescription('Opening the full details is recorded with your name and the time.');
    await show.click();
    const facts = pending.getByRole('definition').filter({ hasText: '000123452222' });
    await expect(facts).toBeVisible();
    await expect(pending).toContainText('SYNB0005678');
    expect(page.url()).toBe(urlBefore);
    expect(await page.title()).toBe(titleBefore);
    expect(page.url()).not.toContain('000123452222');
    await pending.getByRole('button', { name: 'Hide details of version 1' }).first().click();
    await expect(main).not.toContainText('000123452222');
  });

  test('the other Accounts person can approve or return the open version', async ({ page }) => {
    await open(page, 'finance-destinations');
    const pending = card(page, 'New collections account');
    const approve = pending.getByRole('button', { name: 'Approve version 1 of New collections account' });
    await expect(approve).toBeVisible();
    await expect(approve).toHaveAccessibleDescription(/does not check that the bank account belongs to the company, and it is not a payment/);
    const form = pending.getByRole('form', { name: 'Approve version 1 of New collections account' });
    await expect(form.locator('input[name="versionId"]')).toHaveValue('c5000000-0000-4000-8000-000000000013');
    await expect(form.locator('input[name="expectedRowVersion"]')).toHaveValue('3');
    await expect(form.locator('input[name="requestId"]')).toHaveValue(/^[0-9a-f-]{36}$/);
    await pending.getByText('Return version 1 with a reason').click();
    await expect(pending.getByRole('form', { name: 'Return version 1 of New collections account' }).getByLabel('Reason')).toHaveAttribute('minlength', '10');
  });

  test('the maker sees approve and return unavailable with the reason', async ({ page }) => {
    await open(page, 'finance-destinations-own');
    const pending = card(page, 'New collections account');
    for (const name of ['Approve version 1', 'Return version 1']) {
      const button = pending.getByRole('button', { name, exact: true });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAccessibleDescription(OWN_REASON);
    }
    await expect(pending.getByRole('form', { name: /Approve version/ })).toHaveCount(0);
  });

  test('a version submitted after retirement can only be returned', async ({ page }) => {
    await open(page, 'finance-destinations');
    const late = card(page, 'Retired with a late version');
    const approve = late.getByRole('button', { name: 'Approve version 2' });
    await expect(approve).toHaveAttribute('aria-disabled', 'true');
    await expect(approve).toHaveAccessibleDescription('This account is retired, so this version can only be returned.');
    await expect(late.getByText('Return version 2 with a reason')).toBeVisible();
    await expect(late.getByText('Retire this account')).toHaveCount(0);
  });

  test('new details are blocked while a version waits, with the reason', async ({ page }) => {
    await open(page, 'finance-destinations');
    const replacing = card(page, 'Main current account replacement');
    await expect(replacing).toContainText('Version 2 is waiting for approval. New details can be submitted after it is approved or returned.');
    await expect(replacing.getByText('Replace with new details')).toHaveCount(0);
    await expect(card(page, 'Office UPI').getByText('Submit a corrected version')).toBeVisible();
    await expect(card(page, 'Old branch account')).toContainText('Retired accounts cannot be changed. Add a new company account instead.');
  });

  test('replace form posts the destination, its kind and row version, and never prefills the account number', async ({ page }) => {
    await open(page, 'finance-destinations');
    const main1 = card(page, 'Main current account');
    await main1.getByText('Replace with new details').click();
    const form = main1.getByRole('form', { name: 'Submit new details for Main current account' });
    await expect(form.locator('input[name="destinationId"]')).toHaveValue('c4000000-0000-4000-8000-000000000001');
    await expect(form.locator('input[name="destinationKind"]')).toHaveValue('bank');
    await expect(form.locator('input[name="expectedRowVersion"]')).toHaveValue('3');
    await expect(form.getByLabel('Account number')).toHaveValue('');
    await expect(form.getByLabel('Bank name')).toHaveValue('Synthetic Bank');
    await expect(form).toContainText('Receipts keep using version 2 until another Accounts person approves the new one.');
  });

  test('retire needs a reason and says it is immediate', async ({ page }) => {
    await open(page, 'finance-destinations');
    const upi = card(page, 'Counter UPI');
    await upi.getByText('Retire this account').click();
    const form = upi.getByRole('form', { name: 'Retire Counter UPI' });
    await expect(form).toContainText('Takes effect now and cannot be undone.');
    await expect(form.getByLabel('Reason')).toHaveAttribute('minlength', '10');
    await expect(form.locator('input[name="expectedRowVersion"]')).toHaveValue('3');
  });

  test('add form: kind first, then its fields; a refusal keeps typed values', async ({ page }) => {
    await open(page, 'finance-destinations-empty');
    const main = page.getByRole('main');
    await expect(main).toContainText('No company accounts yet');
    // R4 (A8): the add form opens from the header button in the side drawer.
    await expect(page.getByRole('form', { name: 'Add a company account' })).toHaveCount(0);
    await main.getByRole('button', { name: 'Add a company account' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a company account' });
    const form = drawer.getByRole('form', { name: 'Add a company account' });
    await expect(form.getByLabel('Internal name')).toHaveAccessibleDescription(/Do not type account numbers or UPI IDs here/);
    await expect(form.getByLabel('Account number')).toHaveCount(0);
    await form.getByRole('radio', { name: 'UPI ID' }).check();
    await expect(form.getByRole('textbox', { name: 'UPI ID' })).toBeVisible();
    await expect(form.getByLabel('Account number')).toHaveCount(0);
    await form.getByRole('radio', { name: 'Bank account' }).check();
    await form.getByLabel('Internal name').fill('Synthetic collections');
    await form.getByLabel('Account holder name').fill('Synthetic Holidays Pvt Ltd');
    await form.getByLabel('Bank name').fill('Synthetic Bank');
    await form.getByLabel('Account number').fill('000123456789');
    await form.getByLabel('IFSC').fill('SYNB0001234');
    await form.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(form.getByRole('alert')).toContainText('Design preview: nothing is saved.');
    await expect(form.getByLabel('Account number')).toHaveValue('000123456789');
    await expect(form.getByRole('radio', { name: 'Bank account' })).toBeChecked();
    await expect(drawer).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Done:' })).toHaveCount(0);
    expect(page.url()).not.toContain('000123456789');
  });

  test('add form refusal shows field issues next to the fields', async ({ page }) => {
    await open(page, 'finance-destinations-add-error');
    const drawer = page.getByRole('dialog', { name: 'Add a company account' });
    await expect(drawer).toBeVisible();
    const form = drawer.getByRole('form', { name: 'Add a company account' });
    await expect(form.getByRole('alert')).toContainText('Check the highlighted fields.');
    await expect(form.getByRole('group', { name: 'What kind of company account?' })).toContainText('Choose bank account or UPI ID.');
    await expect(form.getByLabel('Internal name')).toHaveAttribute('aria-invalid', 'true');
  });

  test('unavailable finance is honest', async ({ page }) => {
    await open(page, 'finance-destinations-unavailable');
    await expect(page.getByRole('main')).toContainText('Finance is switched off in this environment.');
    await expect(page.getByRole('form')).toHaveCount(0);
  });
});

test.describe('Receipts and company accounts', () => {
  test('bank transfer needs a choice when several accounts exist; UPI with one is selected and says so; cash has none', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = await recordDrawer(page);
    const select = record.getByLabel('Company account the money was paid into');
    await expect(select).toHaveValue('');
    await expect(select.locator('option')).toHaveText([
      'Choose a company bank account',
      'Main current account · Synthetic Bank XXXX6789 · version 2',
      'Main current account replacement · Synthetic Bank XXXX4321 · version 1',
    ]);
    await record.getByRole('radio', { name: /UPI/ }).check();
    await expect(select).toHaveValue('c5000000-0000-4000-8000-000000000051');
    await expect(select).toHaveAccessibleDescription(/Only one approved company UPI ID is in use, so it is selected/);
    await record.getByRole('radio', { name: /Cash/ }).check();
    await expect(record.getByLabel('Company account the money was paid into')).toHaveCount(0);
    await record.getByRole('radio', { name: /Cheque/ }).check();
    await expect(record.getByLabel('Company account the money was paid into')).toHaveCount(0);
  });

  test('a stub refusal keeps the chosen account', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = await recordDrawer(page);
    await record.getByLabel('Company account the money was paid into').selectOption({ label: 'Main current account · Synthetic Bank XXXX6789 · version 2' });
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('Design preview: nothing is saved.');
    await expect(record.getByLabel('Company account the money was paid into')).toHaveValue('c5000000-0000-4000-8000-000000000012');
  });

  test('no approved account: honest empty state, link, and no working record button', async ({ page }) => {
    await open(page, 'finance-deal-no-destination--receipts');
    const record = await recordDrawer(page);
    await expect(record).toContainText(NO_ACCOUNT);
    // Said once, next to the selector; the button repeats it only as its description.
    await expect(record.getByRole('note').filter({ hasText: NO_ACCOUNT })).toHaveCount(1);
    await expect(record.getByRole('link', { name: 'Open Company accounts' })).toHaveAttribute('href', '/app/accounts/destinations');
    const button = record.getByRole('button', { name: 'Record receipt' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(NO_ACCOUNT);
  });

  test('options read refused: says the list could not be loaded, not that none is approved', async ({ page }) => {
    await open(page, 'finance-deal-destinations-unavailable--receipts');
    const record = await recordDrawer(page);
    await expect(record.getByRole('note').filter({ hasText: NOT_LOADED })).toHaveCount(1);
    await expect(record).not.toContainText('No approved company account');
    const button = record.getByRole('button', { name: 'Record receipt' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(NOT_LOADED);
    await record.getByRole('radio', { name: /UPI/ }).check();
    await expect(record).toContainText(NOT_LOADED);
  });

  test('destination_changed: typed values stay, the account must be chosen again (no silent replacement)', async ({ page }) => {
    await open(page, 'finance-deal-destination-changed--receipts');
    const record = await recordDrawer(page);
    await record.getByLabel('Amount received (₹)').fill('750');
    await record.getByLabel('Payer name').fill('Synthetic Payer Q');
    const select = record.getByLabel('Company account the money was paid into');
    await select.selectOption({ label: 'Main current account · Synthetic Bank XXXX6789 · version 2' });
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('Choose the account again.');
    await expect(record.getByLabel('Amount received (₹)')).toHaveValue('750');
    await expect(record.getByLabel('Payer name')).toHaveValue('Synthetic Payer Q');
    await expect(select).toHaveValue('');
    await expect(select).toHaveAccessibleDescription(/was replaced or retired. Choose the approved company bank account again/);
    // UPI has exactly one account; after the refusal it is not pre-selected either.
    await record.getByRole('radio', { name: /UPI/ }).check();
    await record.getByRole('button', { name: 'Record UPI receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('Choose the account again.');
    await expect(record.getByLabel('Company account the money was paid into')).toHaveValue('');
    await expect(record.getByLabel('Company account the money was paid into').locator('option').first()).toHaveText('Choose a company UPI ID');
  });

  test('full details are cleared when hidden, not just hidden', async ({ page }) => {
    await open(page, 'finance-destinations');
    const pending = card(page, 'New collections account');
    await pending.getByRole('button', { name: 'Show full details of version 1' }).first().click();
    await expect(pending.getByText('000123452222')).toBeVisible();
    await pending.getByRole('button', { name: 'Hide details of version 1' }).first().click();
    await expect(page.locator('body')).not.toContainText('000123452222');
    expect(await page.content()).not.toContain('000123452222');
  });

  test('receipt rows show the masked snapshot in their details, "Unmapped" for older receipts, nothing for cash', async ({ page }) => {
    await open(page, 'finance-deal-destinations--receipts');
    // R4: receipts are table rows; each row's facts sit in its folded Details.
    for (const fold of await page.getByRole('main').locator('summary').filter({ hasText: /Details of receipt/ }).all()) await fold.click();
    const table = page.getByRole('table', { name: /Customer receipts/ });
    const row = (no: string) => table.locator('tbody').filter({ has: page.locator('td[data-label="Receipt"]', { hasText: no }) });
    const r1 = row('R-2026-27-000001');
    await expect(r1).toHaveCount(1);
    await expect(r1).toContainText('Paid into');
    await expect(r1).toContainText('Main current account · Bank account · Synthetic Bank XXXX6789 · version 2');
    await expect(row('R-2026-27-000002')).toContainText('Counter UPI · UPI ID · c***@synpay · version 1');
    await expect(row('R-2026-27-000003')).toContainText('Unmapped');
    const r4 = row('R-2026-27-000004');
    await expect(r4).toHaveCount(1);
    await expect(r4).not.toContainText('Paid into');
  });

  test('company accounts stay one click from Accounts: the menu section and its tab strip', async ({ page }) => {
    // R4: the "Also in Accounts" links on To check are gone by design; the Cash and bank section holds Company accounts.
    await open(page, 'finance-queue');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Cash and bank/ })).toHaveAttribute('href', '/app/accounts/cash');
    await open(page, 'finance-cash');
    await expect(page.getByRole('navigation', { name: 'Cash and bank sections' }).getByRole('link', { name: /^Company accounts/ })).toHaveAttribute('href', '/app/accounts/destinations');
  });
});

/*
 * UX redesign R4, helper A4 (A8): Company accounts as a table at the top with
 * one next step per account that jumps to its details, "Add a company
 * account" in the side drawer. Preview gallery only; field names, actions and
 * the two-person rule are unchanged and covered by the db and real suites.
 */
test.describe('R4 Company accounts table', () => {
  test('one row per account: version in use (masked), status in words, next step', async ({ page }) => {
    await open(page, 'finance-destinations');
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText(['Account', 'Used by new receipts', 'Status', 'Next step']);
    await expect(table.getByRole('row')).toHaveCount(8);
    const row = (name: string) => table.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
    await expect(row('Main current account')).toContainText('Version 2 · Synthetic Bank XXXX6789');
    await expect(row('Main current account')).toContainText('Account status: Approved, in use');
    await expect(row('Main current account')).toContainText('Nothing to do');
    await expect(row('New collections account')).toContainText('Not yet approved');
    await expect(row('Old branch account')).toContainText('No, retired');
    await expect(row('Office UPI').getByRole('link', { name: 'Submit a corrected version of Office UPI' })).toBeVisible();
    await expect(row('Retired with a late version').getByRole('link', { name: 'Return version 2 of Retired with a late version' })).toBeVisible();
    await expect(table).not.toContainText('000123452222');
  });

  test('"Approve or return" in the row moves focus to that account’s decision', async ({ page }) => {
    await open(page, 'finance-destinations');
    await page.getByRole('link', { name: 'Approve or return version 1 of New collections account' }).click();
    const target = page.locator('#dest-next-c4000000-0000-4000-8000-000000000003');
    await expect(target).toBeFocused();
    await expect(target.getByRole('button', { name: 'Approve version 1 of New collections account' })).toBeVisible();
  });

  test('"Submit a corrected version" opens the fold and focuses it', async ({ page }) => {
    await open(page, 'finance-destinations');
    await page.getByRole('link', { name: 'Submit a corrected version of Office UPI' }).click();
    const fold = page.locator('#dest-change-c4000000-0000-4000-8000-000000000004');
    await expect(fold).toHaveAttribute('open', '');
    await expect(fold).toBeFocused();
  });

  test('the maker is told who acts next instead of a button', async ({ page }) => {
    await open(page, 'finance-destinations-own');
    const table = page.getByRole('table');
    const row = table.getByRole('row').filter({ has: page.getByRole('link', { name: 'New collections account', exact: true }) });
    await expect(row).toContainText(OWN_REASON);
    await expect(row.getByRole('link', { name: /Approve or return/ })).toHaveCount(0);
  });

  test('"Add a company account" opens the drawer; Escape closes it and focus returns to the button', async ({ page }) => {
    await open(page, 'finance-destinations');
    await expect(page.getByRole('form', { name: 'Add a company account' })).toHaveCount(0);
    const button = page.getByRole('button', { name: 'Add a company account' });
    await button.click();
    const drawer = page.getByRole('dialog', { name: 'Add a company account' });
    const form = drawer.getByRole('form', { name: 'Add a company account' });
    for (const name of ['entityId', 'requestId', 'destinationKind', 'label']) await expect(form.locator(`[name="${name}"]`).first()).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('200% zoom (640 px wide): no sideways page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 430 });
    await open(page, 'finance-destinations');
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
