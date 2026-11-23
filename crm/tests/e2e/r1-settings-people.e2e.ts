import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, PAGE_CONTROLS, PAGE_FORM, pillsHaveIconAndWord } from './b11-helpers';
import { waitForHydration } from './hydration';

/**
 * R1 Settings frame and People and access (helper S1; design plan 1.4; audit
 * N7, S1, S2, S9 to S11, X1) on the preview gallery: the area list on the
 * left (a select with "Open" on phones), one heading per area, the Overview
 * landing with one state row per area, the Staff list first as a queue with
 * a row menu and the invite drawer, Extra access list first, the read-only
 * Roles and branches list and the Company read-only line. Synthetic props
 * and stand-in actions only: not evidence of a real journey.
 *
 * Owner rule (17 Nov 2026): runs in GitHub Actions only, never on the owner's Mac.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'settings-overview',
  'settings-overview-unknown',
  'settings-overview-staff-only',
  'settings-frame-one-area',
  'settings-staff',
  'settings-staff-invited-only',
  'settings-staff-no-match',
  'settings-staff-invite-open',
  'settings-staff-invite-refused',
  'settings-staff-only-admin',
  'settings-staff-no-permission',
  'settings-staff-roles',
  'settings-access',
  'settings-access-empty',
  'settings-access-grant-open',
  'settings-company',
  'settings-company-no-permission',
];

accessibilitySuite('R1 Settings frame and people: accessibility', STATES);
cspSuite('R1 Settings frame and people: production style policy', STATES);

const OWNER_AREAS = ['Overview', 'People and access', 'Company and branches', 'Money rules', 'Accounts', 'Bitrix connection', 'Features', 'Customer messages', 'Imports', 'System health'];

test.describe('Settings frame: area list, one heading per area', () => {
  test('the area list names every area once and marks the open one; the heading is the area name', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [state, area] of [
      ['settings-overview', 'Overview'],
      ['settings-staff', 'People and access'],
      ['settings-access', 'People and access'],
      ['settings-staff-roles', 'People and access'],
      ['settings-company', 'Company and branches'],
      ['settings-features', 'Features'],
      ['settings-bitrix', 'Bitrix connection'],
      ['settings-health', 'System health'],
    ] as const) {
      await open(page, state);
      const list = page.getByRole('navigation', { name: 'Settings sections' });
      await expect(list.getByRole('link'), state).toHaveText(OWNER_AREAS);
      await expect(list.locator('[aria-current="page"]'), state).toHaveCount(1);
      await expect(list.getByRole('link', { name: area, exact: true }), state).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { level: 1 }), state).toHaveText(area);
      // The menu keeps one Settings item, current on every Settings page.
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }), state).toHaveAttribute('aria-current', 'page');
      // The old tab bar and its repeated tab line are gone.
      await expect(page.locator('[data-slot="settings-tab-line"]'), state).toHaveCount(0);
    }
  });

  test('areas follow the person’s rights; one-area and no-area people get no list', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'settings-staff-only-admin');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveText(['Overview', 'People and access', 'Company and branches']);
    await open(page, 'settings-frame-one-area');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveText(['Imports']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Imports');
    await open(page, 'settings-staff-no-permission');
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.locator('main').getByRole('status')).toContainText('You do not have permission to administer staff.');
  });

  test('keyboard: the area links come in order, focus is visible, Enter follows one', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'settings-overview');
    const links = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link');
    await links.first().focus();
    for (let i = 1; i < OWNER_AREAS.length; i += 1) {
      await page.keyboard.press('Tab');
      await expect(links.nth(i)).toBeFocused();
      const outline = await links.nth(i).evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline, OWNER_AREAS[i]).not.toBe('none');
    }
    await expect(links.nth(OWNER_AREAS.indexOf('Customer messages'))).toHaveAttribute('href', '/app/admin/customer-messages');
    await expect(links.nth(OWNER_AREAS.indexOf('System health'))).toHaveAttribute('href', '/app/admin/bookings');
  });

  test('phones and 200% zoom: a labelled "Settings area" select with Open, never a jump on arrow keys', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'settings-staff');
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden();
    const select = page.getByLabel('Settings area');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('/app/admin/staff');
    await select.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\/preview\/settings-staff$/);
    await select.selectOption({ label: 'Company and branches' });
    await expect(page).toHaveURL(/\/preview\/settings-staff$/);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    // The real address needs a session: the gallery leaves for it (or the sign-in page).
    await page.waitForURL((url) => !url.pathname.startsWith('/preview/'));
    expect(page.url()).toMatch(/\/app\/admin\/company|\/sign-in/);
  });
});

test.describe('Overview landing (N7)', () => {
  test('one row per area with its state in words and a link; Overview itself is not a row', async ({ page }) => {
    await open(page, 'settings-overview');
    const table = page.getByRole('region', { name: 'Settings areas and their state' });
    const rows = table.getByRole('row');
    await expect(rows).toHaveCount(OWNER_AREAS.length); // header row + nine areas
    await expect(table.getByRole('link', { name: 'People and access' })).toHaveAttribute('href', '/app/admin/staff');
    await expect(table.getByRole('row', { name: /People and access/ })).toContainText('Needs attention');
    await expect(table.getByRole('row', { name: /People and access/ })).toContainText('2 invitations not accepted yet');
    await expect(table.getByRole('row', { name: /Company and branches/ })).toContainText('Ahmedabad and Delhi have no GSTIN yet');
    await expect(table.getByRole('row', { name: /Customer messages/ })).toContainText('4 of 18 on · pilot list on (2 Deals)');
    await expect(table.getByRole('row', { name: /System health/ })).toContainText('Real bookings off');
    await expect(table.getByRole('link', { name: 'Overview' })).toHaveCount(0);
    await pillsHaveIconAndWord(page);
    await expect(page.locator('main').getByRole('button')).toHaveCount(0);
    await expect(page.locator('main').locator(PAGE_FORM)).toHaveCount(0);
  });

  test('a failed read is "Not known" on its own row, never Off or 0', async ({ page }) => {
    await open(page, 'settings-overview-unknown');
    const table = page.getByRole('region', { name: 'Settings areas and their state' });
    for (const area of ['People and access', 'Company and branches', 'Money rules', 'Features', 'System health']) {
      const row = table.getByRole('row', { name: new RegExp(area) });
      await expect(row, area).toContainText('Not known');
      await expect(row, area).toContainText('this is not the same as Off');
    }
  });

  test('remembers the last area: "Back to People and access" after visiting it', async ({ page }) => {
    await open(page, 'settings-overview');
    await expect(page.locator('[data-slot="settings-last-area"]')).toHaveCount(0);
    await open(page, 'settings-staff');
    await open(page, 'settings-overview');
    const back = page.getByRole('link', { name: 'Back to People and access' });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute('href', '/app/admin/staff');
  });

  test('blocked browser storage: the Overview still renders, without the link', async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get: () => {
          throw new Error('blocked');
        },
      });
    });
    const page = await context.newPage();
    await open(page, 'settings-staff');
    await open(page, 'settings-overview');
    await expect(page.getByRole('region', { name: 'Settings areas and their state' })).toBeVisible();
    await expect(page.locator('[data-slot="settings-last-area"]')).toHaveCount(0);
    await context.close();
  });
});

test.describe('People and access › Staff (S9, S10)', () => {
  test('list first as a queue: sub-sections, search, status chips with counts, Invite staff as the one primary button', async ({ page }) => {
    await open(page, 'settings-staff');
    const main = page.locator('main');
    const sub = page.getByRole('navigation', { name: 'People and access sections' });
    await expect(sub.getByRole('link')).toHaveText(['Staff', 'Extra access', 'Roles and branches']);
    await expect(sub.getByRole('link', { name: 'Staff' })).toHaveAttribute('aria-current', 'page');
    await expect(sub.getByRole('link', { name: 'Roles and branches' })).toHaveAttribute('href', '/app/admin/staff?tab=roles');
    await expect(main.getByLabel('Search staff')).toBeVisible();
    await expect(main.getByRole('link', { name: /^Invited/ })).toHaveAttribute('href', '/app/admin/staff?status=invited');
    await expect(main.getByRole('heading', { level: 2, name: 'Staff', exact: true })).toBeVisible();
    // The list comes before any form: no invite field on the page until the drawer opens.
    await expect(main.getByLabel('Full name')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Invite staff' })).toBeVisible();
    const list = main.getByRole('list', { name: 'Staff in your entities' });
    await expect(list.locator('[data-slot="staff-row"]')).toHaveCount(5);
    await pillsHaveIconAndWord(page);
    // R1 review: the search filters in the browser; names and e-mails never go into the address.
    await waitForHydration(page);
    const before = page.url();
    await main.getByLabel('Search staff').fill('recovery failed');
    await expect(list.locator('[data-slot="staff-row"]:visible')).toHaveCount(1);
    await expect(main.getByRole('status').filter({ hasText: 'of 5 shown' })).toContainText('1 of 5 shown.');
    await main.getByLabel('Search staff').press('Enter');
    expect(page.url()).toBe(before);
    expect(page.url()).not.toContain('q=');
    await main.getByLabel('Search staff').fill('');
    await expect(list.locator('[data-slot="staff-row"]:visible')).toHaveCount(5);
  });

  test('plain failure words, the code only behind Details', async ({ page }) => {
    await open(page, 'settings-staff');
    const row = page.locator('[data-slot="staff-row"]').filter({ hasText: 'Synthetic Recovery Failed' });
    await expect(row).toContainText('Failed: The mail service refused the message.');
    await expect(row).toContainText('Last error: The sign-in service was not available. Retry in a few minutes.');
    await expect(row.getByText('smtp_rejected')).toBeHidden();
    for (const summary of await row.locator('summary').all()) await summary.click();
    await expect(row.getByText('smtp_rejected')).toBeVisible();
    await expect(row.getByText('provider_unavailable:503')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/delivered/i);
  });

  test('no sideways scroll at 1280, 390 and 200% zoom with a long e-mail address', async ({ page }) => {
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 640, height: 400 }]) {
      await page.setViewportSize(size);
      await open(page, 'settings-staff');
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, `${size.width}px`).toBeLessThanOrEqual(cw);
    }
  });

  test('status chip and search: filtered rows, and an honest empty state with a way back', async ({ page }) => {
    await open(page, 'settings-staff-invited-only');
    await expect(page.getByRole('link', { name: /^Invited/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-slot="staff-row"]')).toHaveCount(1);
    await open(page, 'settings-staff-no-match');
    await expect(page.locator('main')).toContainText('No staff match');
    await expect(page.getByRole('link', { name: 'Show all staff' })).toHaveAttribute('href', '/app/admin/staff');
  });

  test('row menu by keyboard: Enter opens it, arrows move, Escape closes it and focus returns to the button', async ({ page }) => {
    await open(page, 'settings-staff');
    const trigger = page.getByRole('button', { name: 'Actions for Synthetic Sales Delhi A' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Send password reset email', 'Start authenticator recovery', 'Deactivate']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // Your own row and a deactivated person have no menu.
    await expect(page.getByRole('button', { name: 'Actions for Synthetic Owner Jodhpur' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for Synthetic Former Staff' })).toHaveCount(0);
    // An invited person gets "Resend invitation" and no recovery.
    await page.getByRole('button', { name: 'Actions for Synthetic Invited Staff' }).click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Resend invitation', 'Deactivate']);
    await page.keyboard.press('Escape');
  });

  test('menu item opens its drawer with the same form; Escape closes and focus returns to the row button', async ({ page }) => {
    await open(page, 'settings-staff');
    const trigger = page.getByRole('button', { name: 'Actions for Synthetic Sales Delhi A' });
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    const drawer = page.getByRole('dialog', { name: 'Deactivate Synthetic Sales Delhi A?' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('Reason for deactivation')).toHaveAttribute('name', 'reason');
    await expect(drawer.locator('input[type="hidden"][name="userId"]')).toHaveValue('s-sales');
    await expect(drawer.getByRole('button', { name: 'Deactivate staff member' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.getByRole('button', { name: 'Actions for Synthetic Recovery Failed' }).click();
    await page.getByRole('menuitem', { name: 'Retry the authenticator recovery' }).click();
    const recovery = page.getByRole('dialog', { name: 'Authenticator recovery for Synthetic Recovery Failed' });
    await expect(recovery.getByRole('button', { name: /Retry removing the old authenticator/ })).toHaveAccessibleDescription(/does not start a new one/);
    await page.keyboard.press('Escape');
  });

  test('invite drawer by keyboard: opens from "Invite staff", focus inside, same fields, Escape returns focus', async ({ page }) => {
    await open(page, 'settings-staff');
    const button = page.getByRole('button', { name: 'Invite staff' });
    await button.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Invite staff' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAccessibleDescription(/must set up an authenticator before seeing any data/);
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    for (const [label, name] of [['Full name', 'displayName'], ['Work email', 'email'], ['Branch', 'branchId'], ['Role', 'roleCode']] as const) {
      await expect(drawer.getByLabel(label, { exact: true }), label).toHaveAttribute('name', name);
    }
    // Tab stays inside the drawer.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('a refused invitation stays in the drawer as an alert', async ({ page }) => {
    await open(page, 'settings-staff-invite-refused');
    const drawer = page.getByRole('dialog', { name: 'Invite staff' });
    await expect(drawer.getByRole('alert')).toContainText('This email address cannot be invited in this environment.');
    await expect(drawer.getByRole('button', { name: 'Send invitation' })).toBeVisible();
  });

  test('a staff admin who may not grant access sees Staff and Roles and branches only', async ({ page }) => {
    await open(page, 'settings-staff-only-admin');
    await expect(page.getByRole('navigation', { name: 'People and access sections' }).getByRole('link')).toHaveText(['Staff', 'Roles and branches']);
  });
});

test.describe('Roles and branches (D8 deferred: read only)', () => {
  test('every active or invited person with each role and branch; no way to give or remove a role', async ({ page }) => {
    await open(page, 'settings-staff-roles');
    const main = page.locator('main');
    await expect(page.getByRole('navigation', { name: 'People and access sections' }).getByRole('link', { name: 'Roles and branches' })).toHaveAttribute('aria-current', 'page');
    await expect(main).toContainText('Changing roles and branches is coming in a later release.');
    const table = main.getByRole('region', { name: 'Roles and branches of each staff member' });
    await expect(table.getByRole('row', { name: /Synthetic Sales Delhi A/ })).toContainText('Sales, Delhi');
    await expect(table.getByRole('row', { name: /Synthetic Sales Delhi A/ })).toContainText('Manager, Delhi');
    await expect(table).not.toContainText('Synthetic Former Staff');
    await expect(main.getByRole('button')).toHaveCount(0);
    await expect(main.locator(PAGE_CONTROLS)).toHaveCount(0);
    await expect(main.getByText(/Add a role/)).toHaveCount(0);
  });
});

test.describe('People and access › Extra access', () => {
  test('list first; "Give extra access" opens the same form in a drawer; Revoke asks for a reason in a dialog', async ({ page }) => {
    await open(page, 'settings-access');
    const main = page.locator('main');
    await expect(main.getByLabel('Business reason')).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'Extra access now' }).getByRole('row', { name: /Synthetic Manager Delhi/ })).toContainText('Delhi branch');
    await main.getByRole('button', { name: 'Give extra access' }).click();
    const drawer = page.getByRole('dialog', { name: 'Give extra access' });
    for (const [label, name] of [['Staff member', 'userId'], ['Access', 'permission'], ['Legal entity', 'legalEntityId'], ['Branch', 'branchId'], ['Expires on (optional)', 'expiresAt'], ['Business reason', 'reason']] as const) {
      await expect(drawer.getByLabel(label, { exact: true }), label).toHaveAttribute('name', name);
    }
    await page.keyboard.press('Escape');
    await expect(main.getByRole('button', { name: 'Give extra access' })).toBeFocused();

    const revoke = main.getByRole('button', { name: 'Revoke View deals for Synthetic Manager Delhi' });
    await revoke.click();
    const dialog = page.getByRole('dialog', { name: /Revoke View deals for Synthetic Manager Delhi/ });
    await expect(dialog.getByLabel('Reason')).toHaveAttribute('name', 'reason');
    await expect(dialog.locator('input[type="hidden"][name="grantId"]')).toHaveValue('g1');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(revoke).toBeFocused();
  });

  test('nobody has extra access: an honest empty state, the button still offered', async ({ page }) => {
    await open(page, 'settings-access-empty');
    await expect(page.locator('main')).toContainText('No one has extra access now');
    await expect(page.getByRole('button', { name: 'Give extra access' })).toBeVisible();
  });
});

test.describe('Company and branches: read-only line', () => {
  test('one heading (the area), the read-only line, the details; no control', async ({ page }) => {
    await open(page, 'settings-company');
    const main = page.locator('main');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Company and branches');
    await expect(main.locator('[data-slot="read-only"]')).toContainText('You can view these details. The CRM team changes them');
    await expect(main.getByRole('heading', { level: 2, name: 'Company details' })).toBeVisible();
    await expect(main.getByRole('heading', { level: 2, name: 'Branches' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Branches' }).getByRole('row', { name: /Jodhpur/ })).toContainText('Pilot branch');
    await expect(main.getByRole('button')).toHaveCount(0);
    await expect(main.locator(PAGE_CONTROLS)).toHaveCount(0);
  });
});
