import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { pageReady } from '../helpers/page-ready';

/**
 * Phase 4 Purchase work and supplier screens, through the design-preview
 * gallery (synthetic props, no Supabase). Not evidence of a real journey:
 * the database half is tests/db/procurement.test.ts and
 * tests/supabase/procurement.real.test.ts.
 */

const states = [
  'procurement-empty',
  'procurement-in-progress',
  'procurement-ready',
  'procurement-over-budget',
  'procurement-over-budget-approved',
  'procurement-manager-view',
  'procurement-released',
  'procurement-confirm-not-ready',
  'procurement-confirm-version-changed',
  'procurement-gate-off',
  'procurement-supplier-confirmed',
  'procurement-colleague-view',
  'procurement-sales-view',
  'suppliers-list',
  'suppliers-empty',
  'supplier-detail',
  'supplier-detail-created',
  'supplier-detail-manager',
  'supplier-detail-verified',
];

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function noHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

async function open(page: Page, state: string) {
  await page.goto(`/preview/${state}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await pageReady(page);
}

test.describe('Phase 4 previews: accessibility on desktop and 390 px mobile', () => {
  for (const state of states) {
    test(`axe clean: ${state}`, async ({ page }) => {
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
    });
    test(`390 px, no sideways scroll: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('Phase 4 wording and boundaries', () => {
  test('a claimed task is never called booked; the work section says the hotel is not booked yet', async ({ page }) => {
    await open(page, 'procurement-in-progress');
    const main = page.getByRole('main');
    await expect(main).toContainText('Not booked yet');
    await expect(main).not.toContainText(/hotel (is )?booked\b(?! yet)/i);
    await expect(main).toContainText('Taking the task did not book the hotel.');
  });

  test('no customer selling price, margin or acceptance proof appears on Purchase screens', async ({ page }) => {
    for (const state of states.filter((s) => s.startsWith('procurement'))) {
      await open(page, state);
      const text = (await page.getByRole('main').innerText()).toLowerCase();
      for (const word of ['selling', 'margin', 'customer accept', 'booking total agreed']) expect(text, `${state}: ${word}`).not.toContain(word);
    }
  });

  test('Sales sees the supplier-confirmed status and none of the Purchase work', async ({ page }) => {
    await open(page, 'procurement-sales-view');
    const main = page.getByRole('main');
    // DA-271 status word (was "Supplier confirmed the hotel").
    await expect(main).toContainText('Confirmed by supplier');
    await expect(main).not.toContainText('Rate negotiation');
    await expect(main).not.toContainText('Purchase files');
    await expect(main).not.toContainText('SYN-CONF-0001');
    await expect(main).not.toContainText('Synthetic Stays');
  });

  test('missing items are listed under the confirmation and the failed file has a repair path', async ({ page }) => {
    await open(page, 'procurement-in-progress');
    const missing = page.getByRole('list', { name: 'Still needed before the confirmation' });
    await expect(missing).toContainText('Upload the supplier’s confirmation email, saved as a PDF or a screenshot (JPG, PNG or WebP).');
    await expect(page.getByText('Upload failed — does not count. Remove it and upload again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove synthetic-confirmation.pdf' })).toBeVisible();
  });

  test('a confirmed task is locked: the final rate is marked confirmed and no rate, e-mail or confirmation can change', async ({ page }) => {
    await open(page, 'procurement-supplier-confirmed');
    const main = page.getByRole('main');
    await expect(page.getByRole('list', { name: 'Rates from suppliers' })).toContainText('Final rate · confirmed');
    await expect(main).toContainText('SYN-CONF-0001');
    await expect(main).toContainText('The confirmation locked the final rate.');
    for (const name of ['Use as final rate', 'Add rate', 'Send booking request', 'Ask for rates', 'Record supplier confirmation']) {
      await expect(page.getByRole('button', { name }), name).toHaveCount(0);
    }
  });

  test('over budget and gate-off states explain why confirmation cannot happen', async ({ page }) => {
    await open(page, 'procurement-over-budget');
    await expect(page.getByRole('main')).toContainText('The branch Manager must approve this final rate before the booking request.');
    // The unavailable action stays visible and focusable, with one short reason.
    const send = page.getByRole('button', { name: 'Send booking request' });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAccessibleDescription('Waiting for the branch Manager to approve this rate above budget.');
    await open(page, 'procurement-gate-off');
    await expect(page.getByRole('note').filter({ hasText: 'Supplier confirmation is turned off for real bookings' })).toBeVisible();
  });

  test('a colleague can read but gets no work controls', async ({ page }) => {
    await open(page, 'procurement-colleague-view');
    await expect(page.getByRole('main')).toContainText('Synthetic Purchase Colleague is working on this. You can read it.');
    await expect(page.getByRole('button', { name: 'Record supplier confirmation' })).toHaveCount(0);
    await expect(page.getByText('Add a supplier offer')).toHaveCount(0);
  });

  test('the confirm dialog is keyboard reachable, starts on cancel and lists what will not happen', async ({ page }) => {
    await open(page, 'procurement-ready');
    const trigger = page.getByRole('button', { name: 'Record supplier confirmation' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Record that the supplier confirmed this hotel?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Go back' })).toBeFocused();
    await expect(dialog).toContainText('It does not pay the supplier, create a bill or invoice, or message the customer.');
    await expect(dialog.getByLabel('Supplier confirmation reference')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a refused confirmation stays open with the reason announced', async ({ page }) => {
    await open(page, 'procurement-confirm-version-changed');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('Someone changed this after you opened it.');
  });

  test('bank details show only the last 4 digits; unapproved latest details hold supplier payments', async ({ page }) => {
    await open(page, 'supplier-detail');
    const list = page.getByRole('list', { name: 'Bank detail revisions, newest first' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list).toContainText('account ending 0042');
    await expect(list).toContainText('not approved');
    await expect(page.getByRole('note').filter({ hasText: 'Payments to this supplier are on hold' })).toContainText('On hold until the Manager approves the supplier’s latest bank details.');
  });

  test('suppliers nav marks only Suppliers as the current page', async ({ page }) => {
    await open(page, 'suppliers-list');
    const current = page.locator('nav a[aria-current="page"]');
    await expect(current.first()).toHaveText('Suppliers');
    for (const label of await current.allInnerTexts()) expect(label).toBe('Suppliers');
  });

  test('200% zoom keeps the work section usable without sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await open(page, 'procurement-in-progress');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await noHorizontalScroll(page);
  });
});

test.describe('Phase 4 at 200% zoom (1280 px window = 640 CSS px) and 390 px', () => {
  for (const state of states) {
    test(`200% zoom, no sideways scroll, no clipped controls: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 900 });
      await open(page, state);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await noHorizontalScroll(page);
      // Every visible button, link and form control stays inside the viewport width.
      const overflowing = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return [...document.querySelectorAll<HTMLElement>('main button, main a, main input, main select, main textarea, main summary')]
          .filter((el) => el.offsetParent !== null)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > width + 1 || r.left < -1);
          })
          .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)}`);
      });
      expect(overflowing).toEqual([]);
    });
  }

  test('390 px: the supplier confirmation dialog fits and its actions are reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'procurement-ready');
    await page.getByRole('button', { name: 'Record supplier confirmation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record that the supplier confirmed this hotel?' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    for (const name of ['Go back', 'Record supplier confirmation']) {
      const button = dialog.getByRole('button', { name });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('Amendment A1: manager decisions, release and reassignment (previews)', () => {
  test('the branch manager reads the work read-only and sees approve and reassign controls only', async ({ page }) => {
    await open(page, 'procurement-manager-view');
    const main = page.getByRole('main');
    await expect(main).toContainText('The branch Manager must approve this final rate before the booking request.');
    await expect(page.getByRole('button', { name: /Approve this cost above budget/ })).toBeVisible();
    await expect(main).toContainText('Approves only this cost version.');
    await expect(page.getByRole('form', { name: 'Reassign task' }).getByLabel('Move to')).toHaveValue(/.+/);
    for (const name of ['Record supplier confirmation', 'Hand the task back', 'Add rate', 'Upload file', 'Send booking request', 'Use as final rate']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(main).not.toContainText(/selling|margin/i);
  });

  test('an approved over-budget version says who approved it and is ready to confirm', async ({ page }) => {
    await open(page, 'procurement-over-budget-approved');
    await expect(page.getByRole('list', { name: 'Rates from suppliers' })).toContainText('Approved above budget by Synthetic Manager Delhi');
    await expect(page.getByRole('button', { name: 'Record supplier confirmation' })).toBeVisible();
  });

  test('the assignee can hand the task back; after release the kept work stays and anyone can take it', async ({ page }) => {
    await open(page, 'procurement-ready');
    await expect(page.getByRole('button', { name: 'Hand the task back' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Offers, costs and files stay for the next person.');
    await open(page, 'procurement-released');
    await expect(page.getByRole('button', { name: 'Take this task' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Rates from suppliers' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hand the task back' })).toHaveCount(0);
  });

  test('a colleague who did not take the task cannot hand it back', async ({ page }) => {
    await open(page, 'procurement-colleague-view');
    await expect(page.getByRole('button', { name: 'Hand the task back' })).toHaveCount(0);
  });

  test('a manager verifies a supplier and approves the latest bank details but cannot edit them', async ({ page }) => {
    await open(page, 'supplier-detail-manager');
    await expect(page.getByRole('button', { name: 'Mark supplier verified' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Bank detail revisions, newest first' });
    await expect(list.getByRole('button', { name: /Approve these bank details/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Save supplier' })).toHaveCount(0);
    await expect(page.getByText('Record new bank details')).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText('desk@example.test');
  });

  test('a verified supplier and approved bank details say who decided; Purchase gets no approve buttons', async ({ page }) => {
    await open(page, 'supplier-detail-verified');
    const main = page.getByRole('main');
    await expect(main).toContainText('Verified by Synthetic Manager Delhi');
    await expect(main).toContainText('A change of details by Purchase marks it not verified again.');
    await expect(page.getByRole('list', { name: 'Bank detail revisions, newest first' })).toContainText('approved by a manager');
    await expect(page.getByRole('button', { name: /Approve|Mark supplier verified/ })).toHaveCount(0);
  });

  test('the upload form names supplier confirmation emails and refuses .eml in its hint', async ({ page }) => {
    await open(page, 'procurement-in-progress');
    await expect(page.getByLabel('What is this file?')).toContainText('Supplier confirmation email');
    await expect(page.getByRole('main')).toContainText('.eml files aren’t accepted');
  });
});

/*
 * UX redesign R3, helper C3 (DM-20 to DM-24): Suppliers and Rate contracts in
 * the queue pattern, the add forms in the side drawer, the supplier "Bank
 * details" tab with the on-hold header link, rate lines as a table from
 * 1280 px, and the rate-sheet upload inside the Suppliers area. Preview
 * gallery only (synthetic props); the server actions, field names and
 * permissions are unchanged and covered by the db and real-journey tests.
 */
const R3_STATES = [
  'acc2-supplier-register',
  'acc2-supplier-register-add-open',
  'acc2-supplier-register-state-chip',
  'acc2-supplier-register-accounts',
  'acc2-supplier-page-bank',
  'acc2-supplier-page-on-hold',
  'acc2-supplier-page-bank-manager',
  'acc2-supplier-page-bank-manager-tab',
  'acc2-supplier-page-no-bank',
  'acc2-supplier-page-no-bank-tab',
  'acc3-rates-list-purchase',
  'acc3-rates-list-add-open',
  'acc3-rates-list-status-chip',
  'acc3-rates-contract-draft',
  'acc3-rates-import-area',
  'acc3-rates-import-area-checked',
  'acc3-rates-import-area-no-access',
];

test.describe('R3 Suppliers area: accessibility at 1280, 390 px and 200% zoom', () => {
  for (const state of R3_STATES) {
    test(`axe clean, one h1, no sideways scroll: ${state}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
      await page.setViewportSize({ width: 640, height: 430 });
      await noHorizontalScroll(page);
    });
  }
});

test.describe('R3 Suppliers register (queue pattern, add in a drawer)', () => {
  test('area tabs, one search form, state chips that are the old filter addresses', async ({ page }) => {
    await open(page, 'acc2-supplier-register');
    const tabs = page.getByRole('navigation', { name: 'Suppliers area' });
    await expect(tabs.getByRole('link', { name: 'Suppliers' })).toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByRole('link', { name: 'Rate contracts' })).toHaveAttribute('href', '/app/purchase/rate-contracts');
    await expect(page.getByRole('search', { name: 'Search and filter suppliers' })).toBeVisible();
    const chips = page.getByRole('navigation', { name: 'Supplier state' });
    await expect(chips.getByRole('link', { name: /^All suppliers/ })).toHaveAttribute('aria-current', 'page');
    await expect(chips.getByRole('link', { name: /^Payments on hold/ })).toHaveAttribute('href', '/app/purchase/suppliers?bankState=on_hold');
    await expect(chips.getByRole('link', { name: /^Not verified/ })).toHaveAttribute('href', '/app/purchase/suppliers?verification=unverified');
    // GSTIN and PAN moved to the supplier page; a supplier without GSTIN keeps a small flag.
    await expect(page.getByRole('columnheader', { name: 'GSTIN and PAN' })).toHaveCount(0);
    // The add form is not on the page until the button opens it.
    await expect(page.getByRole('form', { name: 'Add a supplier' })).toHaveCount(0);
  });

  test('the Manager approvals address marks the "Payments on hold" chip and status is words, not colour', async ({ page }) => {
    await open(page, 'acc2-supplier-register-state-chip');
    await expect(page.getByRole('navigation', { name: 'Supplier state' }).getByRole('link', { name: /^Payments on hold/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('table', { name: 'Suppliers table' })).toContainText('Payments on hold');
  });

  test('"Add a supplier" opens the same form in a drawer; Escape closes it and focus returns to the button', async ({ page }) => {
    await open(page, 'acc2-supplier-register');
    const button = page.getByRole('button', { name: 'Add a supplier' });
    await button.click();
    const drawer = page.getByRole('dialog', { name: 'Add a supplier' });
    await expect(drawer).toBeVisible();
    const form = drawer.getByRole('form', { name: 'Add a supplier' });
    // Same field names as before (Addendum L3).
    for (const name of ['name', 'supplierKind', 'city', 'stateCode', 'gstin', 'pan']) await expect(form.locator(`[name="${name}"]`).first()).toBeAttached();
    await expect(drawer.getByRole('button', { name: 'Add supplier' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('a refused add opens the drawer with the refusal and the field marked', async ({ page }) => {
    await open(page, 'acc2-supplier-register-add-refused');
    const drawer = page.getByRole('dialog', { name: 'Add a supplier' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('A supplier with exactly this name already exists in this company.');
  });

  test('Flight sees no Rate contracts tab (rate contracts are not Flight work)', async ({ page }) => {
    await open(page, 'acc2-supplier-register-flight');
    await expect(page.getByRole('navigation', { name: 'Suppliers area' })).toHaveCount(0);
  });
});

test.describe('R3 supplier page (Bank details tab, on-hold header link)', () => {
  test('tabs are Details, Bank details, Contacts, Hotels sold, History; Contacts and Hotels sold keep their counts', async ({ page }) => {
    await open(page, 'acc2-supplier-page');
    const tabs = page.getByRole('navigation', { name: 'Supplier sections' });
    // R3 integration (lead): the counts come back from the record already loaded; the other tabs carry none.
    await expect(tabs.getByRole('link')).toHaveText([/^Details$/, /^Bank details$/, /^Contacts, ?\d+$/, /^Hotels sold, ?\d+$/, /^History$/]);
    await expect(tabs.getByRole('link', { name: 'Bank details' })).toHaveAttribute('href', /\?tab=bank$/);
    // Bank details are no longer the last block of Details.
    await expect(page.getByRole('list', { name: 'Bank detail revisions, newest first' })).toHaveCount(0);
  });

  test('on hold: the header status links to the Bank details tab, and Purchase is told who acts next', async ({ page }) => {
    await open(page, 'acc2-supplier-page-on-hold');
    const header = page.locator('[data-slot="record-header"]');
    const hold = header.getByRole('link', { name: /Payments on hold: bank details not approved/ });
    await expect(hold).toHaveAttribute('href', /\?tab=bank$/);
    await expect(header.locator('[data-slot="next-step"]')).toContainText('Next: A Manager who did not record them approves the latest bank details.');
    await expect(header.getByRole('link', { name: 'Open bank details' })).toHaveCount(0);
  });

  test('a Manager who may approve gets "Open bank details"; on the tab the approve button is on the revision', async ({ page }) => {
    await open(page, 'acc2-supplier-page-bank-manager');
    await expect(page.locator('[data-slot="record-header"]').getByRole('link', { name: 'Open bank details' })).toHaveAttribute('href', /\?tab=bank$/);
    await open(page, 'acc2-supplier-page-bank-manager-tab');
    await expect(page.getByRole('navigation', { name: 'Supplier sections' }).getByRole('link', { name: 'Bank details' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('list', { name: 'Bank detail revisions, newest first' }).getByRole('button', { name: /Approve these bank details/ })).toHaveCount(1);
    await expect(page.getByRole('note').filter({ hasText: 'Payments to this supplier are on hold' })).toBeVisible();
  });

  test('no bank details: "Record bank details" opens the tab, then jumps to and focuses the record form', async ({ page }) => {
    await open(page, 'acc2-supplier-page-no-bank');
    await expect(page.locator('[data-slot="next-step"]').getByRole('link', { name: 'Record bank details' })).toHaveAttribute('href', /\?tab=bank$/);
    await open(page, 'acc2-supplier-page-no-bank-tab');
    await page.locator('[data-slot="next-step"]').getByRole('link', { name: 'Record bank details' }).click();
    await expect(page.locator('#supplier-bank-record')).toBeFocused();
    await expect(page.locator('details:has(#supplier-bank-record)')).toHaveAttribute('open', '');
  });
});

test.describe('R3 rate contracts (queue pattern, drawer, lines table, upload inside the area)', () => {
  test('area tabs and chips replace the preset tabs and the status select; the old addresses stay', async ({ page }) => {
    await open(page, 'acc3-rates-list-manager');
    await expect(page.getByRole('navigation', { name: 'Suppliers area' }).getByRole('link', { name: 'Rate contracts' })).toHaveAttribute('aria-current', 'page');
    const chips = page.getByRole('navigation', { name: 'Rate contract lists' });
    await expect(chips.getByRole('link', { name: /^To approve/ })).toHaveAttribute('href', '/app/purchase/rate-contracts?preset=to_approve');
    await expect(chips.getByRole('link', { name: /^To approve/ })).toContainText('(1)');
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveCount(0);
  });

  test('a status address marks its chip', async ({ page }) => {
    await open(page, 'acc3-rates-list-status-chip');
    await expect(page.getByRole('link', { name: /^Draft/, exact: false }).and(page.locator('[aria-current="page"]'))).toHaveCount(1);
  });

  test('"Add a contract" opens the same form in a drawer; "Upload a rate sheet" stays inside the area', async ({ page }) => {
    await open(page, 'acc3-rates-list-purchase');
    await expect(page.getByRole('link', { name: 'Upload a rate sheet' })).toHaveAttribute('href', '/app/purchase/rate-contracts/import');
    await page.getByRole('button', { name: 'Add a contract' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a contract' });
    await expect(drawer).toBeVisible();
    for (const name of ['validFrom', 'validTo']) await expect(drawer.locator(`[name="${name}"]`)).toBeAttached();
  });

  test('the empty list links the rate-sheet upload', async ({ page }) => {
    await open(page, 'acc3-rates-list-empty');
    await expect(page.getByRole('main').getByRole('link', { name: 'Upload a rate sheet' })).toHaveCount(2);
  });

  test('contract page: record header, jump links, and rate lines as a table from 1280 px with usual dates', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'acc3-rates-contract-draft');
    await expect(page.locator('[data-slot="record-header"]')).toContainText('Back to rate contracts');
    const jumps = page.getByRole('navigation', { name: 'On this page' });
    await expect(jumps.getByRole('link', { name: 'Rate lines' })).toHaveAttribute('href', '#rate-lines');
    const form = page.getByRole('form', { name: 'Rate lines and blackout dates' });
    await expect(form).not.toContainText(/\b20\d\d-\d\d-\d\d\b/);
    // One row per line: the first line's season and weekend rate sit on one line.
    const from = form.locator('[name="lines[0].seasonFrom"]');
    const weekend = form.locator('[name="lines[0].weekendRateRupees"]');
    const [a, b] = [await from.boundingBox(), await weekend.boundingBox()];
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? 999))).toBeLessThan(8);
    // Each field keeps its own name for screen readers.
    await expect(form.getByLabel('Line 1: Season from')).toBeAttached();
  });

  test('rate-sheet upload inside the area: back link, no Settings frame, plain column titles beside the names', async ({ page }) => {
    await open(page, 'acc3-rates-import-area');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Upload a rate sheet');
    await expect(page.getByRole('link', { name: 'Back to rate contracts' })).toHaveAttribute('href', '/app/purchase/rate-contracts');
    await expect(page.getByRole('main')).not.toContainText('Changes here affect every branch');
    const cols = page.getByRole('table', { name: 'Rate sheet columns' });
    await expect(cols.getByRole('columnheader', { name: 'What it holds' })).toBeVisible();
    await expect(cols).toContainText('Child without bed');
    await expect(cols).toContainText('childWithoutBed');
  });
});
