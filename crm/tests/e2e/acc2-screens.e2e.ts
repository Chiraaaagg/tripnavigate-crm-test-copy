import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * Accounts Phase 2 contract section 11 (screens) and test plan 12.3 "Mock
 * e2e", Track F, against Track E's preview states (src/app/preview/[state],
 * synthetic props). Run on the Track F port:
 *   E2E_PORT=3294 npx playwright test tests/e2e/acc2-screens.e2e.ts
 * (or E2E_BASE_URL=http://127.0.0.1:3293 to read Track E's running server).
 *
 * Every acc2-* state: axe (WCAG 2.2 AA) at 1280 and 375 px, no page-level
 * sideways scroll at 375 px and 200% zoom (640 px CSS width), keyboard focus
 * visible, reduced motion respected, no unmasked PAN or mobile, no supplier /
 * cost / margin words on customer-document states, no "not a tax invoice"
 * line (Q1), Manager and Sales states without Accounts actions, frozen status
 * words as text. Pop-up permission flow with a stubbed Notification (8.4).
 * State names are not frozen by the contract, so they are discovered from the
 * preview sources (every quoted id starting "acc2-").
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);
if (process.env.E2E_BASE_URL) test.use({ baseURL: process.env.E2E_BASE_URL });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PREVIEW_DIR = join(import.meta.dirname, '..', '..', 'src', 'app', 'preview', '[state]');

function discoverStates(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(PREVIEW_DIR)) {
    if (!/^acc2-.*\.(tsx?|ts)$/.test(file)) continue;
    const text = readFileSync(join(PREVIEW_DIR, file), 'utf8');
    for (const m of text.matchAll(/['"`](acc2-[a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g)) found.add(m[1]!);
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
const ACCOUNTS_ACTIONS = [/^Release/, /^Pay out/, /^Discard/, /^Cancel document/, /^Replace/, /^Link GST invoice/, /^Record supplier refund/];

test.describe('Accounts Phase 2 preview states', () => {
  test.skip(STATES.length === 0, 'Track E has not added the acc2-* preview states yet');

  for (const state of STATES) {
    test(`${state}: axe 1280/375, no sideways scroll, 200% zoom, keyboard, reduced motion, no leaks`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1280, height: 860 });
      expect(await open(page, state), `${state} renders`).toBe(true);
      expect(await axe(page), `${state} axe 1280`).toEqual([]);
      const text = await pageText(page);
      // The company PAN (and GSTIN) is printed on customer documents by design (DEC-50, 6.4): the real one and the
      // documents fixture's synthetic company (AAACH0000A). Any other PAN must be masked; the database's mask
      // (authz.acct_mask_pan, XXXXX1234X) has the PAN's own shape, so it is removed before the check.
      // Phase 2 contract R-A2: the supplier page shows the supplier's full PAN to Accounts and Managers only
      // (fixture SUP_MASTER_MANAGER, ABCDE9876F); every other state shows it masked.
      const ownPan = /^acc2-supplier-page.*-(manager|accounts)(-|$)/.test(state) ? /\bABCDE9876F\b/g : /(?!)/g;
      expect(text.replace(/AAFCH9191M|AAACH0000A|\bXXXXX[0-9]{4}X\b/g, '').replace(ownPan, ''), 'no unmasked PAN').not.toMatch(/\b[A-Z]{5}[0-9]{4}[A-Z]\b(?![0-9A-Z])/);
      expect(text, 'no unmasked mobile').not.toMatch(/(?<![X0-9])[6-9][0-9]{9}\b/);
      if (/^acc2-docs/.test(state)) {
        expect(text, 'Q1: no "not a tax invoice" line').not.toMatch(/not a tax invoice/i);
        expect(text, 'documents carry no supplier, cost or margin').not.toMatch(/\bmargin\b|supplier cost|our cost|net rate/i);
      }
      if (/-(manager|sales)(-|$)/.test(state) && /^acc2-(docs|refund)/.test(state)) {
        for (const name of ACCOUNTS_ACTIONS) {
          await expect(page.getByRole('button', { name }), `${state}: no Accounts action ${name}`).toHaveCount(0);
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
      // Load the state again at phone width (as flight-screens does): a refusal state moves focus on first paint, and the
      // scroll position kept from 1280 px would leave a random link half under the sticky top bar after the resize.
      expect(await open(page, state), `${state} renders at 375`).toBe(true);
      await noHorizontalScroll(page, `${state} 375 (loaded)`);
      expect(await axe(page), `${state} axe 375`).toEqual([]);
      await page.setViewportSize({ width: 640, height: 430 });
      await noHorizontalScroll(page, `${state} 200% zoom`);
    });
  }

  test('frozen words are text, never colour alone (section 11)', async ({ page }) => {
    const check = async (match: RegExp, words: RegExp) => {
      for (const s of STATES.filter((x) => match.test(x))) {
        expect(await open(page, s)).toBe(true);
        expect(await pageText(page), s).toMatch(words);
      }
    };
    await check(/^acc2-docs-deal-billing-missing$/, /Billing details missing/);
    await check(/^acc2-docs-deal-flags$/, /Replaced by|Booking changed since release|Payment reversed/);
    await check(/^acc2-docs-deal-stale$/, /Refresh/);
    await check(/^acc2-docs-deal-off$/, /not switched on/i);
    await check(/^acc2-refund-deal-off$/, /not switched on/i);
    await check(/^acc2-cancel-flight-approved$/, /Tickets cancelled/);
    await check(/^acc2-settings-bell-popups-on$/, /Pop-ups on/);
    await check(/^acc2-settings-bell-popups-blocked$/, /Blocked by this browser/);
    await check(/^acc2-settings-bell-popups-unsupported$/, /Not supported on this device/);
    await check(/^acc2-refund-approvals$/, /Approve ₹[0-9,]+(\.[0-9]{2})? refund/);
    await check(/^acc2-supplier-page$|^acc2-supplier-register$/, /Agent or booking channel|Direct/);
  });

  test('refusal keeps typed input (refused states show the message and keep the fields filled)', async ({ page }) => {
    for (const s of STATES.filter((x) => /refused$/.test(x))) {
      expect(await open(page, s)).toBe(true);
      const filled = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), textarea')]
        .filter((el) => (el as HTMLInputElement).value.trim() !== '').length);
      const alert = await page.getByRole('alert').count() + await page.locator('[aria-live]').count();
      expect(alert, `${s}: a refusal message`).toBeGreaterThan(0);
      if (await page.locator('input:not([type=hidden]), textarea').count()) expect(filled, `${s}: typed input kept`).toBeGreaterThan(0);
    }
  });

  test('pop-up permission (8.4): asked once on the first click while on; never when denied; no service worker', async ({ page }) => {
    const bell = STATES.find((s) => s === 'acc2-settings-bell-default') ?? STATES.find((s) => s.startsWith('acc2-settings-bell'));
    test.skip(!bell, 'no bell settings preview state yet');
    for (const permission of ['default', 'denied'] as const) {
      await page.addInitScript((perm) => {
        const w = window as unknown as { __asks: number; Notification: unknown };
        w.__asks = 0;
        class FakeNotification {
          static permission = perm;
          static async requestPermission() { w.__asks += 1; return perm; }
          constructor() { /* pop-up suppressed in tests */ }
          close() {}
        }
        w.Notification = FakeNotification;
      }, permission);
      expect(await open(page, bell!)).toBe(true);
      await page.evaluate(() => { try { localStorage.removeItem('tn-notice-popup-asked'); } catch { /* storage off */ } });
      await page.mouse.click(5, 5);
      await page.keyboard.press('Shift');
      await page.mouse.click(10, 10);
      const asks = await page.evaluate(() => (window as unknown as { __asks: number }).__asks);
      if (permission === 'denied') expect(asks, 'denied is never re-asked').toBe(0);
      else expect(asks, 'asked at most once per browser').toBeLessThanOrEqual(1);
      const regs = await page.evaluate(async () => ('serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0));
      expect(regs, 'no service worker (8.4)').toBe(0);
    }
  });
});
