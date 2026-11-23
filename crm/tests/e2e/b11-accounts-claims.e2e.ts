import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * B1.1 Accounts: advance claims from Sales on the deal page and the claims
 * list, the payment plan and revision on the booking review, and department
 * expense records. Preview gallery; stand-in actions record nothing.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b11-accounts-claim-reported',
  'b11-accounts-claim-record-open',
  'b11-accounts-claim-refused',
  'b11-accounts-claim-own-record',
  'b11-accounts-claim-linked',
  'b11-accounts-claim-cheque-pending',
  'b11-accounts-claim-not-received',
  'b11-accounts-review-plan',
  'b11-accounts-review-revision',
  'b11-accounts-claims-list',
  'b11-accounts-claims-empty',
  'b11-accounts-expenses',
  'b11-accounts-expense-own',
  'b11-accounts-expense-returned',
];

accessibilitySuite('B1.1 Accounts: accessibility', STATES);
cspSuite('B1.1 Accounts: production style policy', STATES);

test.describe('B1.1 Accounts: advance claims on the deal page', () => {
  test('a claim is never money; three ways to handle it', async ({ page }) => {
    await open(page, 'b11-accounts-claim-reported');
    const section = page.getByRole('region', { name: 'Reported payments' });
    await expect(section).toContainText('Reported by Sales. Not money until a receipt is recorded and checked by a second Accounts person.');
    await expect(section).toContainText('Reported by Sales (not money): ₹30,000.00');
    await expect(section).toContainText('Reported by Sales: record or link the receipt');
    await expect(section.getByRole('button', { name: 'Record receipt from this claim' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Link an existing receipt' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Money not found' })).toBeVisible();
    await pillsHaveIconAndWord(page);
  });

  test('recording from a claim prefills the receipt form and asks for a reason only for a difference', async ({ page }) => {
    await open(page, 'b11-accounts-claim-record-open');
    const form = page.getByRole('form', { name: 'Record receipt from this claim' });
    await expect(form.getByLabel('Amount received (₹)')).toHaveValue('30000');
    await expect(form.getByLabel('Payer name')).toHaveValue('Synthetic Customer Pvt Ltd');
    await expect(form.getByLabel(/Reason for any difference from the claim/)).toBeVisible();
    await expect(form.getByRole('button', { name: 'Record receipt from this claim' })).toHaveCount(1);
  });

  test('a refused record keeps typed values and says why', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'b11-accounts-claim-refused');
    const form = page.getByRole('form', { name: 'Record receipt from this claim' });
    await form.getByLabel('Amount received (₹)').fill('29950.00');
    await form.getByLabel(/Reason for any difference from the claim/).fill('Bank charges taken by the payer’s bank.');
    await form.getByRole('button', { name: 'Record receipt from this claim' }).click();
    await expect(form.getByRole('alert')).toContainText('cash above the policy limit');
    await expect(form.getByLabel('Amount received (₹)')).toHaveValue('29950.00');
  });

  test('linking an existing receipt and "money not found" each have their own form', async ({ page }) => {
    await open(page, 'b11-accounts-claim-reported');
    const section = page.getByRole('region', { name: 'Reported payments' });
    await section.getByRole('button', { name: 'Link an existing receipt' }).click();
    const link = page.getByRole('form', { name: 'Link an existing receipt to this claim' });
    await expect(link.getByLabel('Receipt on this deal')).toBeVisible();
    await expect(link.getByRole('button', { name: 'Link this receipt' })).toBeVisible();
    await section.getByRole('button', { name: 'Money not found' }).click();
    const nf = page.getByRole('form', { name: 'Money not found for this claim' });
    await expect(nf.getByLabel('What did you check?')).toHaveAccessibleDescription(/Sales will read this reason/);
  });

  test('maker/checker: own claim or own deal is handled by another Accounts person', async ({ page }) => {
    await open(page, 'b11-accounts-claim-own-record');
    const section = page.getByRole('region', { name: 'Reported payments' });
    await expect(section.getByRole('button', { name: 'Record receipt from this claim' })).toHaveCount(0);
    await expect(section).toContainText('another Accounts person must handle it');
  });

  test('handled claims show their receipt and stop offering actions', async ({ page }) => {
    await open(page, 'b11-accounts-claim-linked');
    const section = page.getByRole('region', { name: 'Reported payments' });
    await expect(section).toContainText('existing receipt linked');
    await expect(section).toContainText('reason: Customer paid ₹50 bank charges on top.');
    await expect(section.getByRole('button')).toHaveCount(0);
    await open(page, 'b11-accounts-claim-cheque-pending');
    await expect(page.getByRole('region', { name: 'Reported payments' })).toContainText('Cheque awaiting bank clearance');
    await open(page, 'b11-accounts-claim-not-received');
    await expect(page.getByRole('region', { name: 'Reported payments' })).toContainText('Money not found');
  });
});

test.describe('B1.1 Accounts: booking review of a package', () => {
  test('payment plan, list price and discount, contact; the plan is not money', async ({ page }) => {
    await open(page, 'b11-accounts-review-plan');
    const main = page.locator('main');
    await expect(main).toContainText('Adds up to the selling total');
    await expect(main).toContainText('Instalments are a plan, not money received.');
    await expect(main).toContainText('List price');
    await expect(main).toContainText('Synthetic Customer A');
    await expect(main).not.toContainText('Synthetic Lakeside Hotel');
  });

  test('a fixed booking shows what changed and the price difference', async ({ page }) => {
    await open(page, 'b11-accounts-review-revision');
    const main = page.locator('main');
    await expect(main).toContainText('Fixed booking · replaces version 2');
    await expect(main).toContainText('selling total up by ₹5,000.00');
    await expect(main).toContainText('Version 2: Returned by Accounts · returned because: Check-out date differs from the acceptance.');
  });
});

test.describe('B1.1 Accounts: lists', () => {
  test('claims list: filters as links, the current one marked, oldest first, links to the deal', async ({ page }) => {
    await open(page, 'b11-accounts-claims-list');
    const tabs = page.getByRole('navigation', { name: 'Claim filters' });
    await expect(tabs.locator('[aria-current="page"]')).toContainText('To process');
    await expect(page.locator('main').getByRole('link', { name: 'SYN-DEL-001' })).toHaveAttribute('href', /\/app\/accounts\/deals\/.+\?tab=money#claim-cl1$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reported payments');
    await open(page, 'b11-accounts-claims-empty');
    await expect(page.locator('main')).toContainText('No claims to process');
  });

  test('expense records: accepting records only; own submissions go to another person', async ({ page }) => {
    await open(page, 'b11-accounts-expenses');
    const main = page.locator('main');
    await expect(main).toContainText('it never approves, makes or schedules a payment');
    await expect(main.getByRole('button', { name: 'Accept expense record' })).toBeVisible();
    await main.getByRole('button', { name: 'Return to the department' }).click();
    await expect(page.getByRole('form', { name: 'Return the expense record' }).getByLabel('Why are you returning it?')).toBeVisible();
    await open(page, 'b11-accounts-expense-own');
    await expect(page.locator('main').getByRole('button', { name: 'Accept expense record' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('another Accounts person must review it');
    await open(page, 'b11-accounts-expense-returned');
    await expect(page.locator('main')).toContainText('The receipt shows a different amount');
  });
});
