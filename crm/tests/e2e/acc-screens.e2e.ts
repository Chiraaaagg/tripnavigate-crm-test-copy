import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * Accounts phase contract section 11 (screens) and test plan 12.6 "Mock
 * e2e", Track E: every Accounts-phase preview state of the design gallery
 * (src/app/preview/[state], synthetic props, Track D):
 *   - axe (WCAG 2.2 AA tags) at 1280 px and 375 px; no page-level sideways
 *     scroll at 375 px and at 200% zoom (640 px wide CSS viewport);
 *   - keyboard: Tab reaches a control with a visible focus ring;
 *   - reduced motion: no running finite animation;
 *   - Manager states show no Accounts actions ("View only");
 *   - status words are text (Urgent, Overdue, Provisional ...), never colour alone;
 *   - no unmasked PAN or mobile; the export result never reports rows as matched;
 *   - the frozen Phase 0 texts (flight-only ID proof, return blocked).
 * State names are not frozen by the contract, so they are discovered from
 * the preview sources (every quoted id starting "acc-"); the suite skips with
 * that reason until Track D has added them.
 *
 * Runs against the mock dev server (playwright.config.ts). Track E port:
 * E2E_PORT=3294 (or point PLAYWRIGHT base URL at Track D's running 3293
 * server read-only with E2E_BASE_URL).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);
if (process.env.E2E_BASE_URL) test.use({ baseURL: process.env.E2E_BASE_URL });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PREVIEW_DIR = join(import.meta.dirname, '..', '..', 'src', 'app', 'preview', '[state]');

function discoverStates(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(PREVIEW_DIR)) {
    if (!/\.(tsx?|ts)$/.test(file)) continue;
    const text = readFileSync(join(PREVIEW_DIR, file), 'utf8');
    for (const m of text.matchAll(/['"`](acc-[a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g)) found.add(m[1]!);
  }
  return [...found].sort();
}
const STATES = discoverStates();

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

test.describe('Accounts phase preview states', () => {
  test.skip(STATES.length === 0, 'Track D has not added the acc-* preview states yet');

  for (const state of STATES) {
    test(`${state}: axe 1280/375, no sideways scroll, 200% zoom, keyboard, reduced motion, no leaks`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1280, height: 860 });
      expect(await open(page, state), `${state} renders`).toBe(true);
      expect(await axe(page), `${state} axe 1280`).toEqual([]);
      const text = await pageText(page);
      expect(text, 'no unmasked synthetic PAN').not.toMatch(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
      expect(text, 'no unmasked mobile').not.toMatch(/(?<!X)\b[6-9][0-9]{9}\b/);
      // Export ≠ matched (7.4): the export result never reports records as matched (the help text may explain the rule).
      if (/^acc-tally-result$/.test(state)) expect(text, 'export result never claims matched').not.toMatch(/\d+ (rows? )?matched/i);
      if (/manager/.test(state)) {
        for (const label of ['Mark matched', 'Raise exception', 'Reopen', 'Link to another task', 'Add GST invoice reference']) {
          await expect(page.getByRole('button', { name: label }), `${state}: no "${label}" for a Manager`).toHaveCount(0);
        }
      }
      // Keyboard: the first Tab lands on a control with a visible focus indicator.
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return { tag: el.tagName, outline: s.outlineStyle !== 'none' && s.outlineWidth !== '0px', ring: s.boxShadow !== 'none' };
      });
      if (focus) expect(focus.outline || focus.ring, `${state}: visible focus on ${focus.tag}`).toBe(true);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(100);
      await noHorizontalScroll(page, `${state} 375`);
      expect(await axe(page), `${state} axe 375`).toEqual([]);
      await page.setViewportSize({ width: 640, height: 430 });
      await noHorizontalScroll(page, `${state} 200% zoom`);
    });
  }

  test('frozen words: urgent label, dues statuses, provisional basis, Phase 0 texts', async ({ page }) => {
    const check = async (match: RegExp, words: RegExp) => {
      for (const s of STATES.filter((x) => match.test(x))) {
        expect(await open(page, s)).toBe(true);
        expect(await pageText(page), s).toMatch(words);
      }
    };
    await check(/^acc-bell-(open|accounts-open)$/, /Urgent/);
    await check(/^acc-dues-overdue$/, /Overdue/);
    await check(/provisional/, /Provisional — booking not yet approved by Accounts/);
    await check(/newer-pending/, /waiting for Accounts/);
    await check(/^acc-id-proofs-flight-only$/, /not needed for flight-only bookings/);
    await check(/return-blocked|review-blocked/, /ask the branch Manager to start a cancellation/);
    await check(/^acc-records-filter-none$|^acc-records-empty$/, /\S/);
  });
});
