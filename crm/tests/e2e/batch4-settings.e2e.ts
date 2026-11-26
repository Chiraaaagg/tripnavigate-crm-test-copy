import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, PAGE_CONTROLS, PAGE_FORM, pillsHaveIconAndWord } from './b11-helpers';
import { waitForHydration } from './hydration';

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

// R1 area list (S1): Overview first, then the areas in order. Voice-note batch: Imports (the preview owner holds the
// import right too). Accounts phase 1 (contract 7.1 T6/T7): "Accounts" follows "Money rules" for the same people.
// Customer messages is its own area since R1 (D12), for a Super Admin.
const AREAS = ['Overview', 'People and access', 'Company and branches', 'Money rules', 'Accounts', 'Bitrix connection', 'Features', 'Customer messages', 'Imports', 'System health'];
const OLD_FRAME_LINE = 'Live changes need the owner’s APPROVE first; write it in the reason.';

test.describe('Settings frame (DA-250 to DA-252; R1 area list)', () => {
  test('one Settings menu item, current on every Settings area; the area list marks the open area and the heading names it', async ({ page }) => {
    for (const [state, area] of [
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
      const areas = page.getByRole('navigation', { name: 'Settings sections' });
      await expect(areas.getByRole('link')).toHaveText(AREAS);
      await expect(areas.getByRole('link', { name: area, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(areas.locator('[aria-current="page"]')).toHaveCount(1);
      // The open area is named in words once: the page's one h1 is the area name (the old tab line is gone).
      await expect(page.locator('[data-slot="settings-tab-line"]')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(area);
      // The approval line is no longer repeated on every area page (R1): it is on the Overview and in every change dialog.
      await expect(page.locator('main')).not.toContainText(OLD_FRAME_LINE);
    }
    await open(page, 'settings-overview');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
    await expect(page.locator('main')).toContainText('Changes here affect every branch. Live changes need the owner’s APPROVE first. Every change is recorded with the person and the time.');
  });

  test('areas follow the person’s rights: Bitrix connection manager and staff admin see only theirs', async ({ page }) => {
    await open(page, 'settings-bitrix-integration-only');
    // Not a Super Admin: no Customer messages area (its page answers only a Super Admin).
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveText(['Overview', 'Company and branches', 'Bitrix connection', 'Features', 'System health']);
    await open(page, 'settings-company-pilot-unknown');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveText(['Overview', 'People and access', 'Company and branches']);
    // Sales: no Settings item, no area list; the page refuses on its own.
    await open(page, 'settings-company-no-permission');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Only staff with a Settings right can open this page.');
  });

  test('keyboard: the areas are links in order and Enter follows one', async ({ page }) => {
    await open(page, 'settings-features');
    const areas = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link');
    await areas.first().focus();
    for (let i = 1; i < AREAS.length; i += 1) {
      await page.keyboard.press('Tab');
      await expect(areas.nth(i)).toBeFocused();
    }
    await expect(areas.first()).toHaveAttribute('href', '/app/admin');
    await expect(areas.nth(AREAS.indexOf('Accounts'))).toHaveAttribute('href', '/app/admin/accounts');
    await expect(areas.nth(AREAS.indexOf('Imports'))).toHaveAttribute('href', '/app/admin/imports');
    await expect(areas.nth(AREAS.indexOf('Customer messages'))).toHaveAttribute('href', '/app/admin/customer-messages');
    await expect(areas.nth(AREAS.length - 1)).toHaveAttribute('href', '/app/admin/bookings');
    // Enter follows the focused link (the real address needs a session: the gallery leaves for it or the sign-in page).
    await areas.nth(AREAS.indexOf('Accounts')).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => !url.pathname.startsWith('/preview/'));
    expect(page.url()).toMatch(/\/app\/admin\/accounts|\/sign-in/);
  });
});

// UX redesign R1 (S2): switch rows (C6), the one confirm dialog (C7) and the optional reason (D9).
const R1_STATES = [
  'acc2-settings-features',
  'acc2-settings-features-dialog',
  'acc2-settings-features-refused',
  'acc2-settings-features-not-authorized',
  'acc2-settings-features-visa-dialog',
  'acc2-settings-features-visa-uncounted',
  'acc2-settings-features-notices-dialog',
  'acc2-settings-features-notices-off',
  'acc2-settings-features-notices-unknown',
  'acc2-settings-accounts',
  'acc2-settings-accounts-dialog',
  'acc2-settings-accounts-refused',
  'acc2-settings-accounts-owner-dialog',
  'acc2-settings-accounts-write-off-dialog',
  'acc2-settings-accounts-read-only',
  'acc2-settings-tally-mapping-tabs',
];
cspSuite('R1 switch pages: production style policy', R1_STATES);

/** The fields each old switch form posted, recorded on 17 November 2026 from the forms before R1 (submit event, FormData keys). */
const OLD_FIELDS = {
  features: ['confirm', 'reason', 'settingKey', 'state'],
  visaOn: ['confirm', 'reason', 'reviewedCount', 'settingKey', 'state'],
  notices: ['enabled', 'reason'],
  tallyExport: ['enabled', 'entityId', 'reason'],
  owner: ['entityId', 'reason', 'userId'],
  documents: ['enabled', 'entityId', 'reason'],
  refunds: ['enabled', 'entityId', 'reason'],
  autoBills: ['drafts', 'entityId', 'reason', 'release'],
  writeOff: ['enabled', 'entityId', 'limitRupees', 'reason'],
  tallyXml: ['companyName', 'enabled', 'entityId', 'reason'],
} as const;

/** Records the fields of every submitted form (capture phase, before the page's own handler). */
async function recordPosts(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      'submit',
      (e) => {
        const fd = new FormData(e.target as HTMLFormElement, (e as SubmitEvent).submitter ?? undefined);
        const w = window as unknown as { __posts?: Array<Record<string, string>> };
        w.__posts = [...(w.__posts ?? []), Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))];
      },
      true,
    );
  });
}
const lastPost = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const posts = (window as unknown as { __posts?: Array<Record<string, string>> }).__posts ?? [];
  return posts[posts.length - 1] ?? null;
});
const keysOf = (post: Record<string, string> | null) => Object.keys(post ?? {}).sort();

test.describe('Switch rows (DA-253 to DA-256, R1 C6)', () => {
  test('state in words with an icon, the last change per switch (person, system, none), and Change on the right', async ({ page }) => {
    await open(page, 'settings-features');
    const rows = page.locator('#feature-switches [data-slot="setting-row"]');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText('Book now (service list)');
    await expect(rows.nth(0)).toContainText('State: On');
    await expect(rows.nth(0)).toContainText('Last change: Synthetic Owner Jodhpur');
    // Who it affects and the full line with its reason sit behind "More".
    await expect(rows.nth(0)).toContainText('Affects: every branch');
    await expect(rows.nth(0)).toContainText('by Synthetic Owner Jodhpur: switched on.');
    await expect(rows.nth(0)).toContainText('Reason: “Owner APPROVE in chat on 20 Oct (synthetic).”');
    await rows.nth(0).locator('summary').click();
    await expect(rows.nth(0).getByText('Reason: “Owner APPROVE in chat on 20 Oct (synthetic).”')).toBeVisible();
    await expect(rows.nth(1)).toContainText('by a system update (no person recorded): switched off.');
    await expect(rows.nth(2)).toContainText('No change recorded since change tracking started.');
    await expect(rows.nth(3)).toContainText('by you: switched off.');
    await pillsHaveIconAndWord(page);
    // It is not a toggle: no switch or checkbox role, one "Change" per row.
    await expect(page.locator('#feature-switches').getByRole('switch')).toHaveCount(0);
    await expect(page.locator('#feature-switches').getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('#feature-switches').getByRole('button', { name: /^Change ./ })).toHaveCount(5);
    // Big switches: read only, no Change at all, the "not here" line.
    const live = page.locator('#feature-read-only [data-slot="setting-row"]');
    await expect(live).toHaveCount(2);
    await expect(live.first()).toContainText('Changed by the CRM team with the owner’s approval, not here.');
    await expect(page.locator('#feature-read-only').getByRole('button', { name: /^Change/ })).toHaveCount(0);
    // D3: the Bitrix switches moved; the page links there.
    await expect(page.getByRole('link', { name: 'Open Bitrix connection' })).toHaveAttribute('href', '/app/admin/integration');
    // Echo-B L9: a Super Admin is not told "only a Super Admin" under their own Change buttons.
    await expect(page.locator('main')).not.toContainText('Only a Super Admin can change them.');
  });

  test('Change opens one confirm dialog: Cancel first, the effect, who is affected, an optional reason; Escape returns focus', async ({ page }) => {
    await open(page, 'acc2-settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="intake_prompt_enabled"]');
    const change = row.getByRole('button', { name: 'Change Count of won deals with no booking (on Home)' });
    await change.click();
    const dialog = page.getByRole('alertdialog', { name: 'Turn Count of won deals with no booking (on Home) off?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('The count is hidden. Nothing else changes.');
    await expect(dialog).toContainText('Who is affected: Every branch.');
    await expect(dialog).toContainText('Changing this in the live CRM needs the owner’s APPROVE first. Write it in the reason.');
    await expect(dialog.getByLabel('Why are you changing it?')).toHaveAccessibleDescription(/Leave it empty, or write 10 to 500 characters/);
    await expect(dialog.getByRole('button', { name: 'Turn Count of won deals with no booking (on Home) off' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(change).toBeFocused();
  });

  test('D9: confirm with the reason left empty saves; the result says no reason was given', async ({ page }) => {
    await open(page, 'acc2-settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="intake_prompt_enabled"]');
    await row.getByRole('button', { name: 'Change Count of won deals with no booking (on Home)' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Turn Count of won deals with no booking (on Home) off' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole('status')).toContainText('Count of won deals with no booking (on Home) is now off. Recorded with your name and the time (no reason given).');
  });

  test('a refusal keeps the dialog open with the typed reason (reason too short, and not authorized)', async ({ page }) => {
    await open(page, 'acc2-settings-features-refused');
    const dialog = page.getByRole('alertdialog', { name: 'Turn Referral drafts on?' });
    await expect(dialog.getByRole('alert')).toContainText('Not saved: say why, in 10 to 500 characters.');
    await expect(dialog.getByLabel('Why are you changing it?')).toHaveValue('Pilot');
    await expect(dialog.getByLabel('Why are you changing it?')).toHaveAttribute('aria-invalid', 'true');
    await open(page, 'acc2-settings-features-not-authorized');
    const d2 = page.getByRole('alertdialog');
    await expect(d2.getByRole('alert')).toContainText('Only a Super Admin can change this. Nothing was changed.');
    await expect(d2.getByLabel('Why are you changing it?')).toHaveValue('Owner APPROVE in chat (synthetic).');
    // A live refusal from the server (stand-in: not a Super Admin) also keeps the dialog and the reason.
    await open(page, 'settings-features-refused');
    const row = page.locator('[data-slot="setting-row"][data-key="service_items_enabled"]');
    await row.getByRole('button', { name: 'Change Book now (service list)' }).click();
    const d3 = page.getByRole('alertdialog');
    await d3.getByLabel('Why are you changing it?').fill('Owner APPROVE on 23 Oct (synthetic).');
    await d3.getByRole('button', { name: 'Turn Book now (service list) off' }).click();
    await expect(d3.getByRole('alert')).toContainText('Only a Super Admin can change this. Nothing was changed.');
    await expect(d3.getByLabel('Why are you changing it?')).toHaveValue('Owner APPROVE on 23 Oct (synthetic).');
  });

  test('Visa and passport tasks: the count is read when the dialog opens; an unreadable count disables the confirm (DA-258)', async ({ page }) => {
    await open(page, 'settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await row.getByRole('button', { name: 'Change Visa and passport tasks' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Turn Visa and passport tasks on?' });
    const count = dialog.locator('[data-slot="visa-count"]');
    await expect(count).toContainText('Switching on now creates 4 Visa and passport tasks on 3 deals, one for each sold service that has no task yet.');
    await expect(count).toContainText('1 services on removed or lost deals get no task.');
    await dialog.getByLabel('Why are you changing it?').fill('Owner APPROVE: start the Visa desk (synthetic).');
    await dialog.getByRole('button', { name: 'Turn Visa and passport tasks on' }).click();
    await expect(row.getByRole('status')).toContainText('Visa and passport tasks are on. 3 tasks were created (4 were counted in the review; services changed in between).');

    await open(page, 'settings-features-visa-uncounted');
    const row2 = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await row2.getByRole('button', { name: 'Change Visa and passport tasks' }).click();
    const d2 = page.getByRole('alertdialog');
    await expect(d2).toContainText('The CRM could not count the waiting services, so this cannot be switched on now.');
    await expect(d2.getByRole('button', { name: 'Turn Visa and passport tasks on' })).toBeDisabled();
  });

  test('Not known is never Off and never offers a change (one row, a whole section, not installed, read only)', async ({ page }) => {
    await open(page, 'settings-features-unknown');
    const visa = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await expect(visa).toContainText('State: Not known');
    await expect(visa).toContainText('Unknown is not Off. It cannot be changed until the CRM can read it.');
    await expect(visa).toContainText('Last change: could not be read.');
    await expect(visa.getByRole('button', { name: 'Change', exact: true })).toBeDisabled();
    await expect(visa.getByRole('button', { name: /^Change ./ })).toHaveCount(0);
    await open(page, 'settings-features-unreadable');
    await expect(page.locator('#feature-switches')).toContainText('every switch here shows as Unknown. Nothing is assumed on or off.');
    await expect(page.locator('#feature-switches [data-slot="setting-row"]').filter({ hasText: 'State: Off' })).toHaveCount(0);
    await expect(page.locator('#feature-switches').getByRole('button', { name: /^Change ./ })).toHaveCount(0);
    await open(page, 'settings-features-not-installed');
    await expect(page.locator('#feature-switches')).toContainText('These settings are not installed in this CRM yet. Nothing is assumed on or off.');
    await expect(page.locator('#feature-switches').getByRole('button', { name: /^Change ./ })).toHaveCount(0);
    await open(page, 'settings-features-read-only');
    await expect(page.locator('#feature-switches').getByRole('button', { name: /^Change ./ })).toHaveCount(0);
    await expect(page.locator('#feature-switches')).toContainText('Only a Super Admin can change this.');
    await expect(page.locator('main')).toContainText('You can view these switches. Only a Super Admin can change them.');
  });

  test('D12: the staff notices switch is a row on Features (Super Admin), with its own dialog and an optional reason', async ({ page }) => {
    await open(page, 'acc2-settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="staff_notices"]');
    await expect(page.locator('#feature-switches [data-slot="setting-row"]')).toHaveCount(6);
    await expect(row).toContainText('Staff notices (the bell)');
    await expect(row).toContainText('State: On');
    await row.getByRole('button', { name: 'Change Staff notices (the bell)' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Turn Staff notices (the bell) off?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Turn Staff notices (the bell) off' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole('status')).toContainText('Staff notices are switched off.');
    await open(page, 'acc2-settings-features-notices-unknown');
    const unknown = page.locator('[data-slot="setting-row"][data-key="staff_notices"]');
    await expect(unknown).toContainText('State: Not known');
    await expect(unknown.getByRole('button', { name: 'Change', exact: true })).toBeDisabled();
    // Big switches card and the closing line.
    await open(page, 'acc2-settings-features');
    await expect(page.getByRole('region', { name: 'Big switches' })).toBeVisible();
    await expect(page.locator('[data-slot="features-elsewhere"]').getByRole('link', { name: 'Open Money rules' })).toHaveAttribute('href', '/app/admin/finance-policy');
  });
});

test.describe('Each switch posts the same fields as before (R1)', () => {
  test('Features and the Visa switch', async ({ page }) => {
    await recordPosts(page);
    await open(page, 'acc2-settings-features');
    const row = page.locator('[data-slot="setting-row"][data-key="intake_prompt_enabled"]');
    await row.getByRole('button', { name: 'Change Count of won deals with no booking (on Home)' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^Turn / }).click();
    await expect(row.getByRole('status')).not.toBeEmpty();
    const post = await lastPost(page);
    expect(keysOf(post)).toEqual([...OLD_FIELDS.features]);
    expect(post).toMatchObject({ settingKey: 'intake_prompt_enabled', state: 'off', confirm: 'yes', reason: '' });

    const visa = page.locator('[data-slot="setting-row"][data-key="visa_passport_tasks_enabled"]');
    await visa.getByRole('button', { name: 'Change Visa and passport tasks' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.locator('[data-slot="visa-count"]')).toContainText('Switching on now creates 4');
    // Real department work (lead ruling on Q1): the reason is required here; an empty one is stopped in the dialog.
    await dialog.getByRole('button', { name: 'Turn Visa and passport tasks on' }).click();
    await expect(dialog.getByLabel('Why are you changing it?')).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByLabel('Why are you changing it?').fill('Owner APPROVE: start the Visa desk (synthetic).');
    await dialog.getByRole('button', { name: 'Turn Visa and passport tasks on' }).click();
    await expect(visa.getByRole('status')).not.toBeEmpty();
    expect(keysOf(await lastPost(page))).toEqual([...OLD_FIELDS.visaOn]);

    const notices = page.locator('[data-slot="setting-row"][data-key="staff_notices"]');
    await notices.getByRole('button', { name: 'Change Staff notices (the bell)' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^Turn / }).click();
    await expect(notices.getByRole('status')).not.toBeEmpty();
    expect(keysOf(await lastPost(page))).toEqual([...OLD_FIELDS.notices]);
  });

  test('Settings › Accounts: the eight rows', async ({ page }) => {
    await recordPosts(page);
    await open(page, 'acc2-settings-accounts');
    // [row, button name (includes the company), fields, reason required (finance-mode switch, lead ruling on Q1)]
    const co = 'Holiday Chacha Pvt LTD';
    const cases: Array<[string, string, readonly string[], boolean]> = [
      ['tally_export', `Change Tally export for ${co}`, OLD_FIELDS.tallyExport, true],
      ['exception_owner', `Change Tally exception owner for ${co}`, OLD_FIELDS.owner, false],
      ['customer_documents', `Change Customer documents for ${co}`, OLD_FIELDS.documents, true],
      ['refunds', `Change Refunds for ${co}`, OLD_FIELDS.refunds, true],
      ['auto_drafts', `Change Automatic drafts for ${co}`, OLD_FIELDS.autoBills, true],
      ['auto_release', `Change Automatic release for ${co}`, OLD_FIELDS.autoBills, true],
      ['write_off', `Change Write-offs of small balances for ${co}`, OLD_FIELDS.writeOff, true],
      ['tally_xml', `Change Tally import file for ${co}`, OLD_FIELDS.tallyXml, true],
    ];
    await expect(page.locator('[data-slot="setting-row"]')).toHaveCount(cases.length);
    for (const [key, button, fields, required] of cases) {
      const row = page.locator(`[data-slot="setting-row"][data-key="${key}"]`);
      await row.getByRole('button', { name: button }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      const reason = dialog.getByLabel('Why are you changing it?');
      if (required) {
        await expect(reason, key).toHaveAccessibleDescription(/10 to 500 characters/);
        // An empty reason is stopped in the dialog: it stays open, the box is marked, nothing is saved.
        await dialog.locator('button[type="submit"]').click();
        await expect(reason, key).toHaveAttribute('aria-invalid', 'true');
        await expect(dialog, key).toBeVisible();
        // The row sits behind the open modal (aria-hidden), so its status line is found in the markup.
        await expect(row.locator('[role="status"]'), key).toBeEmpty();
        await reason.fill('Owner approved on 17 Nov (synthetic).');
      } else {
        await expect(reason, key).toHaveAccessibleDescription(/Leave it empty, or write 10 to 500 characters/);
      }
      await dialog.locator('button[type="submit"]').click();
      await expect(dialog, key).toHaveCount(0);
      await expect(row.getByRole('status'), key).toContainText(required ? 'saved with your reason' : 'No reason given');
      expect(keysOf(await lastPost(page)), key).toEqual([...fields]);
    }
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

  test('the leads switch dialog says it changes which leads are in the CRM for everyone; its reason stays required (Bitrix scope)', async ({ page }) => {
    await open(page, 'settings-bitrix');
    await waitForHydration(page);
    const row = page.locator('[data-slot="setting-row"][data-key="lead_intake_unowned"]');
    await row.getByRole('button', { name: 'Change Bring in leads whose Bitrix owner is not a CRM salesperson' }).click();
    // R1 (C7): one confirm dialog in place of the in-row review form.
    const dialog = page.getByRole('alertdialog', { name: /^Turn Bring in leads whose Bitrix owner is not a CRM salesperson (on|off)\?$/ });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('This changes which deals or leads are in the CRM for everyone.');
    const reason = dialog.getByLabel('Why are you changing it?');
    await expect(reason).toHaveAccessibleDescription(/10 to 500 characters/);
    await dialog.locator('button[type="submit"]').click();
    await expect(reason).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog).toBeVisible();
    // The row sits behind the open modal (aria-hidden), so its status line is found in the markup.
    await expect(row.locator('[role="status"]')).toBeEmpty();
  });

  test('two phases: Review changes counts the deals, then one confirm dialog saves and hides {n} deals; nothing is saved before the confirm', async ({ page }) => {
    await open(page, 'settings-bitrix');
    await waitForHydration(page);
    const section = page.getByRole('region', { name: 'Which deals come in from Bitrix' });
    await expect(section).toContainText('Unticking a stage or pipeline hides its deals from everyone in the CRM.');
    await expect(section).toContainText('Automatic updates: On');
    await expect(section).toContainText('by Synthetic Integration Admin.');
    await expect(section).toContainText('Hid 4 and brought back 0 deals.');
    const edit = section.getByRole('form', { name: 'Change which deals come in from Bitrix' });
    await edit.getByRole('checkbox', { name: 'Pipeline: Synthetic corporate pipeline' }).uncheck();
    await expect(edit.getByRole('checkbox', { name: 'New request' })).toBeDisabled();
    // R1 (S3, C7): the reason is asked in the confirm dialog, no longer on the page.
    await expect(edit.getByLabel('Why are you changing it?')).toHaveCount(0);
    await edit.getByRole('button', { name: 'Review changes' }).click();
    const review = page.getByRole('alertdialog', { name: 'Review: which deals come in from Bitrix' });
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(review).toContainText('Pipelines removed: Synthetic corporate pipeline');
    await expect(review).toContainText('Hides 12 deals from everyone now.');
    await expect(review).toContainText('0 created before the date · 9 in a pipeline no longer ticked · 3 in a stage no longer ticked');
    await expect(review).toContainText('2 of them have CRM work');
    await expect(review).toContainText('Brings back 1 hidden deals.');
    await expect(review).toContainText('this number is not exact.');
    await expect(review).toContainText('Get the owner’s APPROVE first and write it in the reason.');
    await expect(review).toContainText('This review is valid for 10 minutes.');
    // Nothing is saved before the confirm: without a reason the dialog stays open and nothing is sent.
    await review.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    await expect(review.getByLabel('Why are you changing it?')).toHaveAttribute('aria-invalid', 'true');
    await expect(review).toBeVisible();
    await expect(section.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(0);
    // Cancel (was "Go back and change") keeps every tick on the page; the count opens again.
    await review.getByRole('button', { name: 'Cancel' }).click();
    await expect(review).toHaveCount(0);
    await expect(edit.getByRole('checkbox', { name: 'Pipeline: Synthetic corporate pipeline' })).not.toBeChecked();
    await section.getByRole('button', { name: 'Show the count again' }).click();
    const again = page.getByRole('alertdialog', { name: 'Review: which deals come in from Bitrix' });
    await again.getByLabel('Why are you changing it?').fill('Owner APPROVE on 23 Oct: stop the corporate pipeline (synthetic).');
    await again.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(section.getByRole('status').filter({ hasText: 'Saved. 12 deals hidden and 1 brought back. Recorded with your name and reason.' })).toBeVisible();
  });

  test('numbers changed after the review: refused, and the review comes back with the new numbers', async ({ page }) => {
    await open(page, 'settings-bitrix-sync-stale');
    await waitForHydration(page);
    // The state opens on the confirm dialog with the typed reason (R1: the review is the dialog).
    const dialog = page.getByRole('alertdialog', { name: 'Review: which deals come in from Bitrix' });
    await expect(dialog.getByLabel('Why are you changing it?')).toHaveValue('Owner APPROVE on 23 Oct: stop the corporate pipeline (synthetic).');
    await dialog.getByRole('button', { name: 'Save and hide 12 deals' }).click();
    const again = page.getByRole('alertdialog', { name: 'Review: which deals come in from Bitrix' });
    await expect(again.getByRole('alert')).toContainText('Not saved: the numbers changed after your review. Check the new numbers below and confirm again.');
    await expect(again).toContainText('Hides 13 deals from everyone now.');
    await expect(again.getByRole('button', { name: 'Save and hide 13 deals' })).toBeVisible();
    await expect(again.getByLabel('Why are you changing it?')).toHaveValue('Owner APPROVE on 23 Oct: stop the corporate pipeline (synthetic).');
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
    const group = auto.getByRole('group', { name: 'Automatic updates from Bitrix' });
    await expect(group.getByRole('radio', { name: 'On' })).not.toBeChecked();
    await expect(group.getByRole('radio', { name: 'Off' })).not.toBeChecked();
    await waitForHydration(page);
    // R1: no reason box on the page (it is in the confirm dialog); Review asks for the choice first and counts nothing.
    await expect(auto.getByLabel('Why are you changing it?')).toHaveCount(0);
    await auto.getByRole('button', { name: 'Review changes' }).click();
    await expect(group).toContainText('Choose whether automatic updates are on.');
    await expect(page.getByRole('alertdialog', { name: 'Review: which deals come in from Bitrix' })).toHaveCount(0);
    await group.getByRole('radio', { name: 'Off' }).check();
    await auto.getByRole('button', { name: 'Review changes' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Review: which deals come in from Bitrix' })).toBeVisible();
  });
});

test.describe('Read-only areas (DA-261, DA-262)', () => {
  test('Company and branches: company details, GSTIN per branch, the Bitrix pilot; no control', async ({ page }) => {
    await open(page, 'settings-company');
    const main = page.locator('main');
    // R1 (S1): the area name is the page's one h1 (no second page heading).
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Company and branches');
    await expect(main).toContainText('Holiday Chacha Pvt LTD');
    const table = main.getByRole('region', { name: 'Branches' });
    await expect(table.getByRole('row', { name: /Jodhpur/ })).toContainText('Pilot branch');
    await expect(table.getByRole('row', { name: /Delhi/ })).toContainText('Not given yet. Final PDFs for this branch are blocked until it is added.');
    await expect(main.getByRole('button')).toHaveCount(0);
    await expect(main.locator(PAGE_CONTROLS)).toHaveCount(0);
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
    await expect(main.locator(PAGE_FORM)).toHaveCount(0);
    await pillsHaveIconAndWord(page);
    await open(page, 'settings-health-unknown');
    const u = page.locator('main');
    await expect(u).toContainText('Booking health: Unknown');
    await expect(u).toContainText('Nothing is assumed healthy');
    await expect(u).not.toContainText('Receiving deals');
    await expect(u).toContainText('Online PDF maker');
    await expect(u.locator('[data-slot="status-badge"]', { hasText: 'Off' })).toHaveCount(0);
  });

  test('Money rules: payment modes read only per company; Not known is not Off; no Change', async ({ page }) => {
    await open(page, 'finance-policy');
    const modes = page.getByRole('region', { name: 'Payment modes' });
    await expect(modes).toContainText('Bank transfer');
    await expect(modes).toContainText('Available');
    await expect(modes).toContainText('Not available yet');
    await expect(modes.locator('[data-key="finance_mode"]').filter({ hasText: 'State: Not known' })).toHaveCount(1);
    await expect(modes).toContainText('Changed by the CRM team with the owner’s approval, not here.');
    await expect(modes.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Money rules' })).toBeVisible();
  });
});
