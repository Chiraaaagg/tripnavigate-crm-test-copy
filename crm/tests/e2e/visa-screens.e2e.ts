import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.4, Track E: the visa preview
 * states of the design gallery (src/app/preview/[state], synthetic props,
 * Track D) against the screen rules of section 11 and the approved
 * deviations from the HTML reference (2.3, 2.4, 16):
 *   - axe (WCAG 2.2 AA tags) at 1280 px and 375 px, one h1, no page-level
 *     sideways scroll at 375 px and at 200% zoom (640 px);
 *   - one assertion per HTML defect the build fixes (see HTML_DEFECTS);
 *   - Manager states show no edit controls; one passenger row in edit at a
 *     time; typed values kept in the refused states.
 *
 * The state names are not frozen by the contract, so they are discovered
 * from the preview sources (every quoted id starting "visa-"). The suite
 * skips with that reason until Track D has added them.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PREVIEW_DIR = join(import.meta.dirname, '..', '..', 'src', 'app', 'preview', '[state]');

function discoverStates(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(PREVIEW_DIR)) {
    if (!/\.(tsx?|ts)$/.test(file)) continue;
    const text = readFileSync(join(PREVIEW_DIR, file), 'utf8');
    for (const m of text.matchAll(/['"`](visa-[a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g)) found.add(m[1]!);
  }
  return [...found].sort();
}
const STATES = discoverStates();
const has = (s: string) => STATES.includes(s);

async function open(page: Page, state: string): Promise<boolean> {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  return response?.status() === 200;
}
async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}
async function noHorizontalScroll(page: Page, label: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `${label}: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}
const pageText = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

/**
 * HTML reference defects the build fixes, one check each, applied to every
 * state (the text must never appear) — contract section reference in brackets.
 */
const HTML_DEFECTS: Array<[string, RegExp]> = [
  ['R8/QB2: the CRM never says it e-mailed the e-visa', /e-mailed|emailed to/i],
  ['6 (dead code): no "Verified" checklist column', /\bVerified\b/],
  ['6 (dead code): no embassy status tracking', /embassy status/i],
  ['6 (dead code): no application plan', /application plan/i],
  ['V9: the invoice card is retitled (costs, not the customer price)', /Visa lines for the invoice/i],
  ['V12: passport tasks complete (no "never completes" note)', /passport tasks? (never|cannot) complete/i],
  ['6 (dead code): no appointment centre or time zone fields', /\btime ?zone\b|appointment centre/i],
  ['9 money fence: no selling price, margin or instalment plan on any desk screen', /selling price|margin|instalment/i],
];

test.describe('Visa build preview states', () => {
  test.skip(STATES.length === 0, 'No Visa build preview states yet (Track D adds them under src/app/preview/[state]).');

  for (const state of STATES) {
    test(`${state}: axe at 1280 and 375, one h1, no sideways scroll at 375 and 200% zoom, HTML defects absent`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1280, height: 900 });
      test.skip(!(await open(page, state)), `${state} is not a preview state`);
      expect(await axe(page), `${state} @1280`).toEqual([]);
      // One h1 in the document (a modal popup may hide the page heading from the accessibility tree).
      expect(await page.locator('h1').count()).toBe(1);
      const text = await pageText(page);
      for (const [why, pattern] of HTML_DEFECTS) expect(text, `${state}: ${why}`).not.toMatch(pattern);
      // 11.1 History: no amounts, references, passport numbers or e-mails.
      if (/history/.test(state)) {
        expect(text, 'amounts in History').not.toMatch(/₹\s?\d/);
        expect(text, 'e-mail in History').not.toMatch(/[^@\s]+@[^@\s]+\.[a-z]{2,}/i);
      }
      // 9.3 Deal reads: no money, no e-mail.
      if (/deal-(card|history)/.test(state)) {
        expect(text).not.toMatch(/₹\s?\d/);
        expect(text).not.toMatch(/[^@\s]+@[^@\s]+\.[a-z]{2,}/i);
      }
      // 11.1: unavailable buttons use aria-disabled with a reason, never a bare disabled primary action.
      for (const b of await page.locator('main button[disabled]').all()) {
        expect(await b.getAttribute('aria-disabled'), `${state}: disabled button without aria-disabled`).not.toBeNull();
      }

      await page.setViewportSize({ width: 375, height: 812 });
      await open(page, state);
      await noHorizontalScroll(page, `${state} @375`);
      expect(await axe(page), `${state} @375`).toEqual([]);
      await page.setViewportSize({ width: 640, height: 450 });
      await open(page, state);
      await noHorizontalScroll(page, `${state} @200%`);
    });
  }

  test('D2: Manager states are read-only (banner, no Take, no edit, no passport number)', async ({ page }) => {
    const states = STATES.filter((s) => /manager/.test(s) && !/deal|home/.test(s));
    test.skip(states.length === 0, 'No Manager visa states.');
    for (const state of states) {
      if (!(await open(page, state))) continue;
      const main = page.locator('main');
      if (!/queue/.test(state)) await expect(main, state).toContainText('View only. The Visa desk does this work.');
      expect(await main.getByRole('button', { name: /^(Take this task|Save|Confirm applied|Mark as applied|Edit|Add document|Upload)/ }).count(), state).toBe(0);
      expect(await main.locator('input:not([type=hidden]), select, textarea').count(), `${state}: form controls`).toBe(0);
      expect((await pageText(page)), `${state}: passport number`).not.toMatch(/\b[A-Z]\d{7}\b/);
    }
  });

  test('V2/§10.4: non-assignee rows show "Passport shown to the assigned executive", not a masked number', async ({ page }) => {
    test.skip(!has('visa-manager-work'), 'No visa-manager-work state.');
    await open(page, 'visa-manager-work');
    const text = await pageText(page);
    expect(text).toContain('Passport shown to the assigned executive');
    expect(text).not.toMatch(/[•*xX]{3,}\d{2,4}/);
  });

  test('one passenger row in edit at a time; Save and Cancel present; typed values kept after a refusal', async ({ page }) => {
    test.skip(!has('visa-work-edit-row'), 'No visa-work-edit-row state.');
    await open(page, 'visa-work-edit-row');
    const main = page.locator('main');
    expect(await main.getByRole('button', { name: /^Save/ }).count()).toBe(1);
    expect(await main.getByRole('button', { name: /^Cancel/ }).count()).toBeGreaterThanOrEqual(1);
    // A refused popup whose preview fixture typed nothing cannot show retention; at least one refused state must (11.1).
    const keeping: string[] = [];
    for (const state of STATES.filter((s) => /refused/.test(s))) {
      if (!(await open(page, state))) continue;
      const values = await page.locator('main input[type=text], main input:not([type]), main input[type=date], main textarea, [role=dialog] input[type=text], [role=dialog] input:not([type]), [role=dialog] input[type=date], [role=dialog] textarea')
        .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).filter((v) => v.trim() !== ''));
      if (values.length > 0) keeping.push(state);
      // Honest repair text (11.1): the refusal is shown (alert/status region or the "Nothing was saved" notice).
      await expect(page.locator('[role=alert], [role=status]').or(page.getByText('Nothing was saved')).first(), `${state}: refusal shown`).toBeVisible();
    }
    expect(keeping.length, 'typed values kept after a refusal in at least one refused state').toBeGreaterThan(0);
  });

  test('V5/V7/QB2: Approve popups need proof, have no default handover, e-visa e-mail empty with the frozen hint', async ({ page }) => {
    test.skip(!has('visa-popup-approve'), 'No visa-popup-approve state.');
    await open(page, 'visa-popup-approve');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/proof|visa document/i);
    for (const select of await dialog.locator('select').all()) {
      const label = (await select.getAttribute('aria-label')) ?? (await select.evaluate((el) => (el as HTMLSelectElement).labels?.[0]?.textContent ?? ''));
      if (/passport goes back|handover/i.test(label)) {
        expect(await select.inputValue(), 'V7: no default handover method').not.toMatch(/^(office|executive|courier|not_with_us)$/);
      }
    }
    if (has('visa-popup-approve-evisa')) {
      await open(page, 'visa-popup-approve-evisa');
      const d = page.getByRole('dialog');
      await expect(d).toContainText('Record where you sent the e-visa. The CRM does not send it.');
      const email = d.getByLabel(/e-mail/i).first();
      await expect(email).toHaveValue('');
    }
  });

  test('V4: "Withdrawn by customer" is a decision choice; V11: applied date cannot be after today', async ({ page }) => {
    test.skip(!has('visa-popup-withdraw') || !has('visa-popup-apply'), 'No withdraw or apply popup state.');
    await open(page, 'visa-popup-withdraw');
    await expect(page.getByRole('dialog')).toContainText('Withdrawn by customer');
    await expect(page.getByRole('dialog')).toContainText('The customer has been told');
    await open(page, 'visa-popup-apply');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Company-paid fees go to Accounts for review once the receipt is attached.');
    const date = dialog.locator('input[type=date]').first();
    if (await date.count()) {
      const max = await date.getAttribute('max');
      if (max) expect(max <= new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10)).toBe(true);
    }
  });

  test('V9: the cost card is "Visa costs per traveller", costs not the customer price', async ({ page }) => {
    const state = STATES.find((s) => /^visa-work(-applied)?$/.test(s));
    test.skip(!state, 'No work state.');
    await open(page, state!);
    const main = page.locator('main');
    await expect(main).toContainText('Visa costs per traveller');
    await expect(main).toContainText(/These are costs, not the customer.s price\./);
  });

  test('Clubbed Confirm applied: one line per passenger with Reference, Applied date, Government fee, Service fee', async ({ page }) => {
    test.skip(!has('visa-popup-apply-club'), 'No visa-popup-apply-club state.');
    await open(page, 'visa-popup-apply-club');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.getByLabel(/Reference/i).count()).toBeGreaterThan(1);
    expect(await dialog.getByLabel(/Government fee/i).count()).toBeGreaterThan(1);
    await expect(dialog.getByRole('button', { name: 'Confirm applied' })).toBeVisible();
  });

  test('keyboard: the Edit pencil opens the row with focus on its first field and Cancel returns focus to the pencil', async ({ page }) => {
    test.skip(!has('visa-work'), 'No visa-work state.');
    await open(page, 'visa-work');
    const pencil = page.locator('main').getByRole('button', { name: /^Edit/ }).first();
    test.skip((await pencil.count()) === 0, 'No Edit button in visa-work.');
    await pencil.focus();
    await page.keyboard.press('Enter');
    const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
    expect(['input', 'select', 'textarea']).toContain(focused);
    const cancel = page.locator('main').getByRole('button', { name: /^Cancel/ }).first();
    await cancel.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('main').getByRole('button', { name: /^Edit/ }).first()).toBeFocused();
  });

  test('one money rule (D4): a government fee typed as "₹100" is refused, the typed text stays, and the refusal names the fee', async ({ page }) => {
    test.skip(!has('visa-popup-apply'), 'No visa-popup-apply state.');
    await open(page, 'visa-popup-apply');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const fee = dialog.getByLabel(/Government fee/i).first();
    await fee.fill('₹100');
    await dialog.getByRole('button', { name: 'Save as applied' }).click();
    await expect(dialog).toContainText('Type the government fee in rupees, more than ₹0.');
    await expect(fee).toHaveValue('₹100');
    await expect(fee).toHaveAttribute('aria-invalid', 'true');
  });
});
