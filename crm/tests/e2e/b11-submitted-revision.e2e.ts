import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * B1.1 submitted booking (read only) and the fix of a returned booking
 * (Stage 3 revision for package versions, DEC-31), on the preview gallery.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const SUBMITTED = [
  'b11-submitted-sales',
  'b11-submitted-duplicate',
  'b11-submitted-claim-reported',
  'b11-submitted-claim-verified',
  'b11-submitted-cheque-pending',
  'b11-submitted-cheque-bounced',
  'b11-submitted-claim-not-found',
  'b11-submitted-visa-waiting',
  'b11-submitted-manager',
  'b11-submitted-returned',
  'b11-deal-stage-moved-after-submit',
];
const REVISION = [
  'b11-revision-draft',
  'b11-revision-classify',
  'b11-revision-acceptance-required',
  'b11-revision-classification-refused',
  'b11-revision-no-changes',
  'b11-revision-base-approved',
  'b11-revision-confirm-dialog',
  'b11-revision-confirmed',
];

accessibilitySuite('B1.1 submitted booking and revision: accessibility', [...SUBMITTED, ...REVISION]);
cspSuite('B1.1 submitted booking and revision: production style policy', [...SUBMITTED, ...REVISION]);

test.describe('B1.1 submitted booking', () => {
  test('frozen facts, tasks created once, review status and money in words', async ({ page }) => {
    await open(page, 'b11-submitted-sales');
    const main = page.locator('main');
    await expect(main).toContainText('Booking status: Submitted · accepted version 1');
    await expect(main).toContainText('Accounts review: Waiting for Accounts');
    await expect(main).toContainText('Submitted details are locked.');
    await expect(page.getByRole('region', { name: 'Services and tasks' })).toContainText('Booked only when the supplier or authority confirms.');
    await expect(page.getByRole('region', { name: 'Money' })).toContainText('Final selling total');
    await pillsHaveIconAndWord(page);
    const text = (await main.innerText()).replace(/nothing (?:is|counts as) booked[^.]*\.|not booked yet/gi, '');
    expect(text).not.toMatch(/\bis booked\b/i);
  });

  test('a repeated press says nothing was created twice', async ({ page }) => {
    await open(page, 'b11-submitted-duplicate');
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Already submitted.' })).toContainText('nothing was created twice');
  });

  test('a visa service waits for the desk launch and still counts as outstanding', async ({ page }) => {
    await open(page, 'b11-submitted-visa-waiting');
    await expect(page.getByRole('region', { name: 'Services and tasks' })).toContainText('Waiting for the Visa & Passport desk launch · still outstanding');
  });

  test('reported payments show their derived status, never as money', async ({ page }) => {
    const cases: Array<[string, string]> = [
      ['b11-submitted-claim-reported', 'Reported, not checked yet'],
      ['b11-submitted-claim-verified', 'Checked by Accounts'],
      ['b11-submitted-cheque-pending', 'Cheque waiting for bank clearance (not counted yet)'],
      ['b11-submitted-cheque-bounced', 'Cheque not paid'],
      ['b11-submitted-claim-not-found', 'Accounts did not find this money'],
    ];
    for (const [state, words] of cases) {
      await open(page, state);
      await expect(page.locator('main'), state).toContainText(words);
      await expect(page.locator('main'), state).toContainText('Reported, not checked (not money)');
    }
    await open(page, 'b11-submitted-claim-not-found');
    await expect(page.locator('main')).toContainText('No credit with this reference');
  });

  test('Bitrix moving the Deal after submission changes the header only', async ({ page }) => {
    await open(page, 'b11-deal-stage-moved-after-submit');
    const main = page.locator('main');
    await expect(main).toContainText('Deal Closed');
    await expect(main).toContainText('Booking status: Submitted · accepted version 1');
  });

  test('returned: the reason Accounts shared and one "Fix and send again" action', async ({ page }) => {
    await open(page, 'b11-submitted-returned');
    const card = page.getByRole('region', { name: 'Accounts returned this booking' });
    await expect(card).toContainText('The check-out date in the acceptance is 24 November');
    await expect(card.getByRole('button', { name: 'Fix and send again' })).toHaveCount(1);
    await expect(page.locator('main')).toContainText('Accounts review: Returned by Accounts');
  });
});

test.describe('B1.1 revision (fix a returned booking)', () => {
  test('a fix is a draft of a new version; services cannot be added or removed', async ({ page }) => {
    await open(page, 'b11-revision-draft');
    const main = page.locator('main');
    await expect(main).toContainText('Fixing version 1 · draft');
    await expect(main).toContainText('Services cannot be added or removed while fixing a returned booking.');
    await expect(main.getByRole('button', { name: /Remove service/ })).toHaveCount(0);
    await expect(main.getByRole('group', { name: 'Service type to add' })).toHaveCount(0);
  });

  test('the change type is chosen with the rule beside each choice', async ({ page }) => {
    await open(page, 'b11-revision-classify');
    const section = page.getByRole('region', { name: 'What kind of change is this?' });
    for (const label of ['Spelling or layout only', /Change the customer will notice/, /Internal budget only/]) {
      await expect(section.getByRole('radio', { name: label })).toHaveCount(1);
    }
    await expect(section.getByRole('radio', { name: /Change the customer will notice/ })).toHaveAccessibleDescription(/Upload the customer’s acceptance of the changed booking/);
    await expect(section).toContainText('Changed since version 1: 2 fields.');
  });

  test('a weaker change type than the changes allow is refused in words', async ({ page }) => {
    await open(page, 'b11-revision-classification-refused');
    await expect(page.getByRole('region', { name: 'What kind of change is this?' }).locator('[data-slot="error-summary"]')).toContainText('cannot be marked as a spelling or format fix');
  });

  test('blockers of a fix: fresh acceptance, no changes, base already decided', async ({ page }) => {
    await open(page, 'b11-revision-acceptance-required');
    await expect(page.locator('main')).toContainText('Upload the customer’s acceptance of the changed booking.');
    await open(page, 'b11-revision-no-changes');
    await expect(page.locator('main')).toContainText('Nothing has changed from the returned version.');
    await open(page, 'b11-revision-base-approved');
    await expect(page.locator('main')).toContainText('Accounts has already decided on the returned version.');
  });

  test('saving the fix explains that version 1 stays in history and no new task is made', async ({ page }) => {
    await open(page, 'b11-revision-confirm-dialog');
    const dialog = page.getByRole('dialog', { name: 'Save fixed booking?' });
    await expect(dialog).toContainText('Replaces version 1 (kept in history).');
    await expect(dialog).toContainText('Accounts checks it again.');
    await expect(dialog).toContainText('No new tasks are created.');
    await expect(page.locator('main').getByRole('button', { name: 'Discard this fix' })).toHaveCount(0); // hidden behind the modal
  });

  test('after the fix: the history shows the replaced version and the price difference', async ({ page }) => {
    await open(page, 'b11-revision-confirmed');
    const versions = page.getByRole('region', { name: 'Versions' });
    await expect(versions).toContainText('Version 1 · replaced by a fixed version');
    await expect(versions).toContainText('Version 2 · accepted');
    await expect(versions).toContainText('price difference ₹5,000.00 more');
  });
});
