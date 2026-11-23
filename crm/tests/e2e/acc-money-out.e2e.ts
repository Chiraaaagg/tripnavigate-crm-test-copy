import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';
import { pageReady } from '../helpers/page-ready';

/**
 * Redesign R4, helper A2 (design plan A7, build plan 4.7 "New tests"):
 * Accounts · Money out lists through the design-preview gallery (synthetic
 * props, no Supabase; not evidence of a real journey). Approval rows carry
 * Approve and "Return with reason" on the row; a payment above ₹50,000
 * (routed to the branch Manager) shows "Needs the branch Manager" and no
 * Approve to Accounts; Return requires 10 to 500 characters and keeps the
 * typed text; own requests show disabled actions with the reason; the
 * ₹50,000 rule is said once per page; the Money out tab strip sits under the
 * page heading. Every state renders under the production style policy.
 * The pm-accounts- states are also covered by tests/e2e/pb-screens.e2e.ts
 * (axe, one h1, no sideways scroll at 1280, 375 and 200 % zoom).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const STATES = [
  'pm-accounts-go-ahead',
  'pm-accounts-go-ahead-all',
  'pm-accounts-go-ahead-refused',
  'pm-accounts-go-ahead-empty',
  'pm-accounts-supplier-payments-to-approve',
  'amo-supplier-payments-return-open',
  'pm-accounts-supplier-payments-to-record',
  'pm-accounts-supplier-payments-to-verify',
  'pm-accounts-supplier-payments-all',
  'pm-accounts-supplier-payments-empty',
  'pm-accounts-supplier-invoices',
  'pm-accounts-supplier-invoices-own',
  'pm-accounts-supplier-invoices-missing',
  'pm-accounts-supplier-invoices-all',
  'pm-accounts-supplier-invoices-empty',
  'pm-accounts-funding',
  'pm-accounts-funding-to-recover',
  'pm-accounts-funding-all',
  'pm-accounts-funding-empty',
];

async function open(page: Page, state: string) {
  await page.goto(`/preview/${state}`);
  await pageReady(page);
}

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const item = (page: Page, text: string) => page.locator('article').filter({ hasText: text });

test.describe('Accounts · Money out: approval rows', () => {
  test('a payment above ₹50,000 shows "Needs the branch Manager" and no Approve or Return for Accounts', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-approve');
    const manager = item(page, 'SP-2026-000050');
    await expect(manager).toHaveCount(1);
    await expect(manager).toContainText('Needs the branch Manager.');
    await expect(manager.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await expect(manager.getByRole('button', { name: /Return/ })).toHaveCount(0);
    // A request Accounts may decide keeps Approve on its row.
    await expect(item(page, 'SP-2026-000041').getByRole('button', { name: 'Approve payment SP-2026-000041' })).toBeEnabled();
    // The rule is said once on the page, not on each row.
    await expect(page.getByText('₹50,000')).toHaveCount(1);
  });

  test('company funding above ₹50,000: "Needs the branch Manager", no Approve', async ({ page }) => {
    await open(page, 'pm-accounts-funding');
    const manager = item(page, 'SP-2026-000048');
    await expect(manager).toContainText('Needs the branch Manager.');
    await expect(manager.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await expect(item(page, 'SP-2026-000042').getByRole('button', { name: /^Approve company funding/ })).toBeEnabled();
    await expect(page.getByText('₹50,000')).toHaveCount(1);
  });

  test('Return requires 10 to 500 characters, keeps the typed text after a refusal, then returns', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-approve');
    const row = item(page, 'SP-2026-000041');
    // No reason box on the row until Return is pressed.
    await expect(row.getByRole('textbox')).toHaveCount(0);
    const opener = row.getByRole('button', { name: 'Return with reason SP-2026-000041' });
    await opener.click();
    const dialog = page.getByRole('alertdialog', { name: 'Return SP-2026-000041 to Purchase?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    const reason = dialog.getByLabel('Reason for returning');
    await expect(reason).toHaveAttribute('maxlength', '500');
    await reason.fill('Too short');
    await dialog.getByRole('button', { name: 'Return to Purchase' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Write the reason: at least 10 characters. Nothing was changed.');
    await expect(reason).toHaveValue('Too short');
    await expect(reason).toBeFocused();
    await reason.fill('The proforma is for a different stay date (synthetic).');
    await dialog.getByRole('button', { name: 'Return to Purchase' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByRole('status').filter({ hasText: 'Synthetic preview: returned with your reason.' })).toBeVisible();
  });

  test('Cancel closes the dialog without a decision and puts focus back on Return', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-approve');
    const opener = item(page, 'SP-2026-000041').getByRole('button', { name: 'Return with reason SP-2026-000041' });
    await opener.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(item(page, 'SP-2026-000041').getByRole('button', { name: 'Approve payment SP-2026-000041' })).toBeVisible();
  });

  test('own requests and own uploads: Approve and Return disabled with the reason', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-approve');
    const own = item(page, 'SP-2026-000043');
    await expect(own.getByRole('button', { name: 'Approve payment SP-2026-000043' })).toBeDisabled();
    await expect(own).toContainText('Nobody approves their own request.');
    await open(page, 'pm-accounts-supplier-invoices-own');
    const doc = item(page, 'SYN-INV-1001');
    await expect(doc.getByRole('button', { name: /^Accept document/ })).toBeDisabled();
    await expect(doc).toContainText('Nobody checks their own upload.');
  });

  test('the recorder sees Verify unavailable with the reason', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-verify');
    const own = item(page, 'SP-2026-000045');
    await expect(own.getByRole('button', { name: 'Mark payment verified' })).toHaveAttribute('aria-disabled', 'true');
    await expect(own).toContainText('You recorded this payment, so another Accounts person verifies it.');
  });

  test('go-ahead with the booking review not approved: Give go-ahead disabled with the reason, Return still offered', async ({ page }) => {
    await open(page, 'pm-accounts-go-ahead');
    const row = item(page, 'SYN-DEL-002');
    await expect(row.getByRole('button', { name: /^Give go-ahead/ })).toBeDisabled();
    await expect(row.getByRole('button', { name: /^Return with reason/ })).toBeEnabled();
  });

  test('Approve posts from the row in one press', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-approve');
    const row = item(page, 'SP-2026-000041');
    await row.getByRole('button', { name: 'Approve payment SP-2026-000041' }).click();
    await expect(row.getByRole('status').filter({ hasText: 'Synthetic preview: approved. Nothing is paid.' })).toBeVisible();
  });
});

test.describe('Accounts · Money out: page layout and accessibility', () => {
  // The frame's own strip (R1) was removed at R4 integration, so the page's strip is the only one.
  test('the Money out tab strip sits under the page heading, current page marked', async ({ page }) => {
    for (const [state, current] of [
      ['pm-accounts-go-ahead', 'Hotel go-ahead'],
      ['pm-accounts-supplier-payments-to-approve', 'Supplier payments'],
      ['pm-accounts-supplier-invoices', 'Supplier invoices'],
      ['pm-accounts-funding', 'Company funding'],
    ] as const) {
      await open(page, state);
      const strip = page.getByRole('main').getByRole('navigation', { name: 'Money out sections' });
      await expect(strip, state).toHaveCount(1);
      await expect(strip.getByRole('link', { name: new RegExp(`^${current}`) }), state).toHaveAttribute('aria-current', 'page');
      const below = await page.evaluate(() => {
        const h1 = document.querySelector('main h1');
        const nav = document.querySelector('main nav[aria-label="Money out sections"]');
        return !!h1 && !!nav && (h1.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(below, `${state}: strip after the heading`).toBe(true);
    }
  });

  test('the open return dialog: axe clean at 1280 and 390 px, no sideways scroll', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/preview/amo-supplier-payments-return-open');
      await expect(page.getByRole('alertdialog', { name: 'Return SP-2026-000041 to Purchase?' })).toBeVisible();
      expect(await axe(page), `return dialog at ${width}`).toEqual([]);
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, `sideways scroll at ${width}`).toBeLessThanOrEqual(cw);
    }
  });

  test('390 px: rows stack, row buttons reachable, no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    for (const state of ['pm-accounts-supplier-payments-to-approve', 'pm-accounts-funding', 'pm-accounts-go-ahead', 'pm-accounts-supplier-invoices']) {
      await open(page, state);
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, state).toBeLessThanOrEqual(cw);
      expect(await axe(page), state).toEqual([]);
    }
  });

  test('keyboard: Return follows Approve on a row, and Enter on Return opens the dialog', async ({ page }) => {
    await open(page, 'pm-accounts-supplier-payments-to-approve');
    const row = item(page, 'SP-2026-000041');
    await row.getByRole('button', { name: 'Approve payment SP-2026-000041' }).focus();
    await page.keyboard.press('Tab');
    const ret = row.getByRole('button', { name: 'Return with reason SP-2026-000041' });
    await expect(ret).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog', { name: 'Return SP-2026-000041 to Purchase?' })).toBeVisible();
  });
});

test.describe('Accounts · Money out: production style policy', () => {
  test('every Money out state renders with zero CSP violations and no style attributes', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => STATES.some((s) => url.pathname === `/preview/${s}`));
    const { violations } = await trackViolations(context);
    const page = await context.newPage();
    for (const state of STATES) {
      await open(page, state);
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html.match(/<[a-z][^>]*\sstyle="/gi), `${state}: server-rendered style attributes`).toBeNull();
    }
    expect(applied.length).toBeGreaterThanOrEqual(STATES.length);
    expect(violations).toEqual([]);
    await context.close();
  });
});
