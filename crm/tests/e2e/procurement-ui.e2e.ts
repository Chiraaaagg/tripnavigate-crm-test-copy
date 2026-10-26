import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

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
  await page.waitForLoadState('networkidle');
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
    await expect(main).toContainText('Not confirmed yet · hotel not booked');
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
    await expect(main).not.toContainText('Supplier offers');
    await expect(main).not.toContainText('Cost history');
    await expect(main).not.toContainText('SYN-CONF-0001');
    await expect(main).not.toContainText('Synthetic Stays');
  });

  test('missing items are listed and the failed file has a repair path', async ({ page }) => {
    await open(page, 'procurement-in-progress');
    await expect(page.getByRole('heading', { name: 'Before you can record the supplier’s confirmation' })).toBeVisible();
    await expect(page.getByText('Upload the supplier’s confirmation email, saved as a PDF or a screenshot (JPG, PNG or WebP).')).toBeVisible();
    await expect(page.getByText('Upload failed — does not count. Remove it and upload again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove synthetic-confirmation.pdf' })).toBeVisible();
  });

  test('cost history says nothing is payable and keeps every version', async ({ page }) => {
    await open(page, 'procurement-supplier-confirmed');
    const history = page.getByRole('list', { name: 'Cost versions, newest first' });
    await expect(history.getByRole('listitem')).toHaveCount(3);
    await expect(history).toContainText('Committed cost · version 3');
    await expect(history).toContainText('Not requested for payment');
    await expect(page.getByRole('main')).toContainText('No payment, bill or invoice was created.');
  });

  test('over budget and gate-off states explain why confirmation cannot happen', async ({ page }) => {
    await open(page, 'procurement-over-budget');
    await expect(page.getByRole('main')).toContainText('The cost is above the approved Purchase budget.');
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

  test('bank details show only the last 4 digits and say nothing is paid from them', async ({ page }) => {
    await open(page, 'supplier-detail');
    const list = page.getByRole('list', { name: 'Bank detail revisions, newest first' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list).toContainText('account ending 0042');
    await expect(list).toContainText('not approved');
    await expect(page.getByRole('main')).toContainText('approved or not, nothing is paid from them in this CRM.');
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
    await expect(main).toContainText('As the branch manager, approve it below if you agree.');
    await expect(page.getByRole('button', { name: /Approve this cost above budget/ })).toBeVisible();
    await expect(main).toContainText('Approves only this cost version.');
    await expect(page.getByRole('form', { name: 'Reassign task' }).getByLabel('Move to')).toHaveValue(/.+/);
    for (const name of ['Record supplier confirmation', 'Hand the task back', 'Add offer', 'Upload file']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(main).not.toContainText(/selling|margin/i);
  });

  test('an approved over-budget version says who approved it and is ready to confirm', async ({ page }) => {
    await open(page, 'procurement-over-budget-approved');
    await expect(page.getByRole('list', { name: 'Cost versions, newest first' })).toContainText('Approved above budget by Synthetic Manager Delhi');
    await expect(page.getByRole('button', { name: 'Record supplier confirmation' })).toBeVisible();
  });

  test('the assignee can hand the task back; after release the kept work stays and anyone can take it', async ({ page }) => {
    await open(page, 'procurement-ready');
    await expect(page.getByRole('button', { name: 'Hand the task back' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Offers, costs and files stay for the next person.');
    await open(page, 'procurement-released');
    await expect(page.getByRole('button', { name: 'Take this task' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Supplier offers' })).toBeVisible();
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
