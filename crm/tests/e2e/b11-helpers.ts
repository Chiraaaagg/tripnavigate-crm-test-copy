import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, trackViolations } from '../helpers/production-style-policy';

/**
 * Shared checks for the B1.1 preview-gallery suites (b11-*.e2e.ts): axe at
 * desktop and phone width, one h1, no sideways scroll at 390 px and at the
 * 200 % zoom equivalent, status pills with icon and word, and the production
 * style policy (zero CSP violations, no server-rendered style attributes).
 * Synthetic props and stand-in actions only: not evidence of a real journey.
 */

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

export async function axe(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

export async function noHorizontalScroll(page: Page, state: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, `${state}: sideways scroll`).toBeLessThanOrEqual(clientWidth);
}

/** axe at 1440 and 390, exactly one h1, no sideways scroll at 390 and 640 × 400 (200 % of 1280 × 800). */
export function accessibilitySuite(title: string, states: string[]) {
  test.describe(title, () => {
    for (const state of states) {
      test(`axe clean at 1440 and 390; one h1; no sideways scroll at 390 and 200% zoom: ${state}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, state);
        expect(await axe(page), state).toEqual([]);
        // A modal dialog hides the page (aria-modal), so its own title is the heading then.
        if ((await page.getByRole('dialog').count()) === 0) expect(await page.getByRole('heading', { level: 1 }).count(), `${state}: h1 count`).toBe(1);
        else expect(await page.locator('h1').count(), `${state}: h1 in the page`).toBe(1);
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page, state);
        await noHorizontalScroll(page, state);
        expect(await axe(page), `${state} at 390`).toEqual([]);
        await page.setViewportSize({ width: 640, height: 400 });
        await open(page, state);
        await noHorizontalScroll(page, state);
      });
    }
  });
}

/** Every status pill on the page has an icon and a non-empty word. */
export async function pillsHaveIconAndWord(page: Page) {
  const pills = page.locator('main [data-slot="status-badge"]');
  for (const pill of await pills.all()) {
    await expect(pill.locator('svg')).toHaveCount(1);
    expect((await pill.innerText()).trim().length).toBeGreaterThan(0);
  }
}

/** Every state renders under the production style policy with no violations and no style attributes. */
export function cspSuite(title: string, states: string[]) {
  test.describe(title, () => {
    test('zero CSP violations and no server-rendered style attributes', async ({ browser }: { browser: Browser }) => {
      test.setTimeout(300_000);
      const context = await browser.newContext();
      const applied: string[] = [];
      await enforceProductionStylePolicy(context, applied, (url) => states.some((s) => url.pathname === `/preview/${s}`));
      const { violations } = await trackViolations(context);
      const page = await context.newPage();
      for (const state of states) {
        await open(page, state);
        const html = await (await page.request.get(`/preview/${state}`)).text();
        expect(html.match(/<[a-z][^>]*\sstyle="/gi), `${state}: server-rendered style attributes`).toBeNull();
      }
      expect(applied.length).toBeGreaterThanOrEqual(states.length);
      expect(violations).toEqual([]);
      await context.close();
    });
  });
}

/** Words that must never reach Purchase, Flight or the Visa & Passport desk. */
export const COMMERCIAL_WORDS = [/Selling/i, /List price/i, /Discount/i, /Payment plan/i, /reported payment/i, /Advance claims/i, /GSTIN/i, /Billing/i];
