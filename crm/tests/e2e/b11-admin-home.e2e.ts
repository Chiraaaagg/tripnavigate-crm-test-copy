import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open } from './b11-helpers';

/**
 * B1.1 Home counts, the Visa & Passport tasks switch and the Won-only Deal
 * intake card (dry run first; the real removal needs the switch on, a dry
 * run and the typed word REMOVE). Preview gallery only: nothing is switched
 * or removed anywhere.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = ['b11-home-visa', 'b11-home-accounts-claims', 'b11-admin-workflow-b11', 'b11-admin-won-only-off', 'b11-admin-won-only-dry-run', 'b11-admin-won-only-unknown'];

accessibilitySuite('B1.1 Home and admin: accessibility', STATES);
cspSuite('B1.1 Home and admin: production style policy', STATES);

test.describe('B1.1 Home counts', () => {
  test('the desk and Accounts see their new counts; the desk has its own menu item and is one click from Home', async ({ page }) => {
    await open(page, 'b11-home-visa');
    const visa = page.getByRole('region', { name: 'What needs you', exact: true });
    await expect(visa).toContainText('Visa and passport tasks not taken yet, or yours in progress');
    await expect(visa.getByRole('link', { name: /^Open Visa and passport tasks/ })).toHaveAttribute('href', '/app/visa');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Visa and passport tasks' })).toBeVisible();
    await open(page, 'b11-home-accounts-claims');
    const work = page.getByRole('region', { name: 'What needs you', exact: true });
    await expect(work).toContainText('Reported payments to check in your companies');
    await expect(work).toContainText('Department costs to review (submitted by someone else)');
    await expect(work).not.toContainText('Visa and passport tasks');
  });
});

test.describe('B1.1 workflow switches and Won-only intake', () => {
  test('the Visa and passport tasks switch is its own row, off, and says what switching on and off does', async ({ page }) => {
    await open(page, 'b11-admin-workflow-b11');
    const row = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await expect(row).toContainText('Visa and passport tasks');
    await expect(row).toContainText('current state: Off');
    await expect(row).toContainText('On: each sold visa or passport service gets one task for the Visa and passport desk. Off: those services are saved and wait; no task is created or deleted.');
  });

  test('Won-only card: off, owner approval first, no removal button', async ({ page }) => {
    await open(page, 'b11-admin-won-only-off');
    const card = page.getByRole('region', { name: 'Bring in deals only when won' });
    await expect(card).toContainText('Current state: Off');
    await expect(card).toContainText('only after the owner replies APPROVE');
    await expect(card.getByRole('button', { name: /^Remove \d+/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Check what would be removed (no deal changes)' })).toHaveAccessibleDescription(/A dry run changes no Deal/);
  });

  test('after a dry run: counts, kept Deals with their CRM work, and a guarded removal', async ({ page }) => {
    await open(page, 'b11-admin-won-only-dry-run');
    const card = page.getByRole('region', { name: 'Bring in deals only when won' });
    await expect(card).toContainText('Current state: On');
    await expect(card).toContainText('Would be hidden (no CRM work)');
    await card.getByText(/Deals kept because of CRM work/).click();
    await expect(card).toContainText('SYN-JOD-102 · stage PREPARATION · booking started, reported payment');
    const remove = card.getByRole('button', { name: 'Remove 24 deals' });
    await expect(remove).toBeDisabled();
    await card.getByLabel('Type REMOVE to confirm').fill('REMOVE');
    await expect(remove).toBeEnabled();
    await expect(card).toContainText('switching Won-only intake off brings back every removed Deal');
  });

  test('an unreadable rule is "unknown", never "off"', async ({ page }) => {
    await open(page, 'b11-admin-won-only-unknown');
    const card = page.getByRole('region', { name: 'Bring in deals only when won' });
    await expect(card).toContainText('Current state: Unknown');
    await expect(card).toContainText('Unknown is not Off.');
    await expect(card).not.toContainText('Current state: Off');
  });
});
