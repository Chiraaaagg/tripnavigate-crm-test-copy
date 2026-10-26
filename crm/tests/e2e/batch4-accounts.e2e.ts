import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * Direction A Batch 4, Accounts (R7) through the design preview states
 * (synthetic view models, stand-in actions that save nothing): the "To check"
 * tabs, the Accounts deal page tabs Money · Review · Receipts · Documents,
 * the approve confirmation, billing saved after an approval, and Purchase
 * being refused. Visual and interaction evidence only; the real maker/checker
 * journey is accounts.real.e2e.ts on a local real stack.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const DEAL_TABS = ['money', 'review', 'receipts', 'documents'] as const;

const STATES = [
  'b4-accounts-to-check',
  'b4-accounts-to-check-receipts',
  'b4-accounts-to-check-returned',
  'b4-accounts-to-check-receipts-empty',
  'b4-accounts-purchase-refused',
  'b4-accounts-deal-billing-after-approval',
  'b4-accounts-deal-nothing-waiting',
  'b4-accounts-deal-documents',
  ...DEAL_TABS.map((t) => `finance-deal-detail--${t}`),
  ...DEAL_TABS.map((t) => `b4-accounts-deal-nothing-waiting--${t}`),
  'finance-deal-blocked--review',
  'finance-deal-no-booking--review',
];

accessibilitySuite('Batch 4 Accounts: accessibility at 1440, 390 and 200 % zoom', STATES);
cspSuite('Batch 4 Accounts: production style policy', STATES);

test.describe('To check (DA-274)', () => {
  test('tabs are links, the open one is marked and alone carries its count; Booking reviews is the bare address', async ({ page }) => {
    await open(page, 'b4-accounts-to-check');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('To check');
    await expect(page.getByRole('main')).toContainText('Bookings and payments to check.');
    const tabs = page.getByRole('navigation', { name: 'To check tabs' });
    const reviews = tabs.getByRole('link', { name: /^Booking reviews/ });
    await expect(reviews).toHaveAttribute('aria-current', 'page');
    await expect(reviews).toHaveAttribute('href', '/app/accounts');
    await expect(reviews).toContainText('3');
    const receipts = tabs.getByRole('link', { name: 'Receipts to verify', exact: true });
    await expect(receipts).toHaveAttribute('href', '/app/accounts?filter=awaiting_verification');
    await expect(receipts).not.toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByRole('link', { name: 'All', exact: true })).toHaveAttribute('href', '/app/accounts?filter=all');
    // Nothing the old filter row offered is lost.
    const more = page.getByRole('navigation', { name: 'More filters' });
    await expect(more.getByRole('link', { name: 'Returned to Sales' })).toHaveAttribute('href', '/app/accounts?filter=returned');
    await expect(more.getByRole('link', { name: 'Cheques awaiting clearance' })).toHaveAttribute('href', '/app/accounts?filter=cheques_pending');
    await expect(page.getByRole('table')).toContainText('3 deals · Booking reviews');
    // The rule that the figures are never added up stays one click away.
    await page.getByText('Why are the amounts separate?').click();
    await expect(page.getByRole('main')).toContainText('never added together');
    await pillsHaveIconAndWord(page);
  });

  test('tabs are reachable by keyboard in order', async ({ page }) => {
    await open(page, 'b4-accounts-to-check');
    const tabs = page.getByRole('navigation', { name: 'To check tabs' });
    await tabs.getByRole('link', { name: /^Booking reviews/ }).focus();
    await page.keyboard.press('Tab');
    await expect(tabs.getByRole('link', { name: 'Receipts to verify', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tabs.getByRole('link', { name: 'All', exact: true })).toBeFocused();
  });

  test('a secondary filter is marked when open; empty tabs say why', async ({ page }) => {
    await open(page, 'b4-accounts-to-check-returned');
    await expect(page.getByRole('navigation', { name: 'To check tabs' }).locator('[aria-current="page"]')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'More filters' }).getByRole('link', { name: /^Returned to Sales/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'No bookings returned to Sales' })).toBeVisible();
    await open(page, 'b4-accounts-to-check-receipts-empty');
    await expect(page.getByRole('heading', { name: 'No receipts to verify' })).toBeVisible();
  });
});

test.describe('Accounts deal page tabs (DA-15, DA-275)', () => {
  test('four tab links, the open one marked; only the open tab is on the page', async ({ page }) => {
    await open(page, 'finance-deal-detail--review');
    const tabs = page.getByRole('navigation', { name: 'Accounts deal sections' });
    for (const name of ['Money', 'Review', 'Receipts', 'Documents']) await expect(tabs.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Review', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Booking and review' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Customer billing details' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Record a receipt' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Money for this deal' })).toHaveCount(0);
    await open(page, 'finance-deal-detail--money');
    await expect(page.getByRole('region', { name: 'Money for this deal' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Booking and review' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Customer receipts' })).toHaveCount(0);
  });

  test('without a tab the page opens on the next action, with one Next line and no primary on that tab', async ({ page }) => {
    // The fixture has a receipt waiting for a second Accounts person.
    await open(page, 'finance-deal-detail');
    const tabs = page.getByRole('navigation', { name: 'Accounts deal sections' });
    await expect(tabs.getByRole('link', { name: 'Receipts', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-slot="accounts-deal-next"]')).toHaveText('Next: another Accounts person verifies the receipt');
    await expect(page.locator('[data-slot="accounts-deal-primary"]')).toHaveCount(0);
    // From another tab, the one primary leads to the tab of the next action.
    await open(page, 'finance-deal-detail--money');
    const primary = page.locator('[data-slot="accounts-deal-primary"]').getByRole('link');
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveAttribute('href', '/preview/finance-deal-detail--receipts');
  });

  test('nothing waiting: says so, offers no primary', async ({ page }) => {
    await open(page, 'b4-accounts-deal-nothing-waiting--money');
    await expect(page.locator('[data-slot="accounts-deal-next"]')).toHaveText('Nothing waiting.');
    await expect(page.locator('[data-slot="accounts-deal-primary"]')).toHaveCount(0);
  });

  test('approve asks first: dialog with Cancel focused, Escape returns focus, a refusal stays in the dialog', async ({ page }) => {
    await open(page, 'finance-deal-detail--review');
    const booking = page.getByRole('region', { name: 'Booking and review' });
    await expect(booking.getByRole('form', { name: 'Approve booking review' })).toBeHidden();
    const trigger = booking.getByRole('button', { name: 'Approve booking' });
    await expect(booking).toContainText('Records your check. No money, no document, no change to the booking.');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Approve booking version 2?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('No money is posted and no document is issued.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    const form = dialog.getByRole('form', { name: 'Approve booking review' });
    await expect(form.locator('input[name="expectedRowVersion"]')).toHaveValue('1');
    const before = await form.locator('input[name="requestId"]').inputValue();
    await dialog.getByRole('button', { name: 'Yes, approve booking' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Design preview: nothing is saved.');
    await expect(dialog).toBeVisible();
    // A known refusal writes nothing, so a fresh request id is issued.
    await expect(form.locator('input[name="requestId"]')).not.toHaveValue(before);
  });

  test('billing saved after an approval: the Review tab says the review is waiting again and approve waits for the check', async ({ page }) => {
    await open(page, 'b4-accounts-deal-billing-after-approval');
    await expect(page.getByRole('navigation', { name: 'Accounts deal sections' }).getByRole('link', { name: 'Review', exact: true })).toHaveAttribute('aria-current', 'page');
    const booking = page.getByRole('region', { name: 'Booking and review' });
    await expect(booking.getByRole('status')).toContainText('Review waiting again');
    await expect(booking).toContainText('Waiting for Accounts review');
    const approve = booking.getByRole('button', { name: 'Approve booking' });
    await expect(approve).toHaveAttribute('aria-disabled', 'true');
    await expect(approve).toHaveAccessibleDescription('Verify the customer billing details before approving the review.');
    const billing = page.getByRole('region', { name: 'Customer billing details' });
    await expect(billing.getByRole('button', { name: 'Check billing details' })).toHaveAccessibleDescription('Confirms they match the customer’s documents. Approves no money.');
    await expect(billing).toContainText('saving puts the review back to waiting');
    await expect(page.locator('[data-slot="accounts-deal-next"]')).toHaveText('Next: check the billing details');
  });

  test('Documents tab: ID proofs and private receipt proof files through the audited route only', async ({ page }) => {
    await open(page, 'b4-accounts-deal-documents');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Traveller ID proofs' })).toBeVisible();
    const proofs = page.getByRole('region', { name: 'Receipt proof files' });
    await expect(proofs).toContainText('only Accounts can open them');
    const links = proofs.getByRole('link');
    expect(await links.count()).toBeGreaterThan(0);
    for (const link of await links.all()) await expect(link).toHaveAttribute('href', /^\/app\/accounts\/files\/[0-9a-f-]+$/);
    // Nothing on this tab records, verifies or approves.
    await expect(main.getByRole('button', { name: /Approve|Verify|Record/ })).toHaveCount(0);
  });
});

test.describe('Purchase never reaches Accounts (T-B4-11, T-B4-12)', () => {
  test('a Purchase holder gets the refusal, no Accounts menu and no amount', async ({ page }) => {
    await open(page, 'b4-accounts-purchase-refused');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('group', { name: 'Accounts' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'To check', exact: true })).toHaveCount(0);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'You do not have access to this page' })).toBeVisible();
    await expect(main).toContainText('Purchase never sees selling prices');
    const html = await (await page.request.get('/preview/b4-accounts-purchase-refused')).text();
    for (const word of ['₹', 'Selling total', 'Payment plan', 'Reported payments', 'Available customer funds', 'accounts/files']) {
      expect(html.includes(word), word).toBe(false);
    }
  });
});
