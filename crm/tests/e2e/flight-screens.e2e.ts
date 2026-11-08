import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * Flight build (contract 4 Nov 2026), Track D: the flight preview states of
 * the design gallery (crm/src/app/preview/[state], synthetic props, Track C)
 * against the contract's screen rules (11, 12.3):
 *   - axe (WCAG 2.2 AA tags) at 1280 px and 375 px, one h1, no sideways
 *     scroll at 375 px (itinerary header and Confirm tickets popup included)
 *     and at 200% zoom (640 px wide);
 *   - prototype bugs absent: "AI AI 470" (airline code once), "Confirmed by
 *     supplier", the retired F-04 sentence, "costs are locked", amounts in
 *     History, sector numbers in the done dialog, Sales "Open Flight task"
 *     dead link, a short ticket range;
 *   - the Confirm tickets popup is at most min(76rem, 100vw - 2rem) wide.
 *
 * The state names are not frozen by the contract, so they are discovered
 * from the preview sources: every quoted state id containing "flight". The
 * suite skips (with that reason) until Track C has added them.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PREVIEW_DIR = join(import.meta.dirname, '..', '..', 'src', 'app', 'preview', '[state]');
/** Pre-build B1 states, covered (and updated) in b1-flight.e2e.ts. */
const LEGACY = new Set(['flight-queue', 'flight-queue-empty', 'flight-queue-loading', 'flight-task-open', 'flight-task-mine', 'flight-task-claim-conflict',
  'flight-task-issued', 'flight-task-not-found']);

function discoverStates(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(PREVIEW_DIR)) {
    if (!/\.(tsx?|ts)$/.test(file)) continue;
    const text = readFileSync(join(PREVIEW_DIR, file), 'utf8');
    for (const m of text.matchAll(/['"`]([a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g)) {
      const id = m[1]!;
      if (/(^|-)flight(-|$)/.test(id) && id.split('-').length >= 2 && !LEGACY.has(id)) found.add(id);
    }
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

test.describe('Flight build preview states', () => {
  test.skip(STATES.length === 0, 'No Flight build preview states yet (Track C adds them under src/app/preview/[state]).');

  for (const state of STATES) {
    test(`${state}: axe at 1280 and 375, one h1, no sideways scroll at 375 and 200% zoom, prototype bugs absent`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1280, height: 900 });
      // An id that is not a preview state (a constant that happens to contain "flight") answers 404: skip it.
      test.skip(!(await open(page, state)), `${state} is not a preview state`);
      expect(await axe(page), `${state} @1280`).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      const main = page.locator('main');
      const text = (await main.innerText()).replace(/\s+/g, ' ');
      // 12.3: airline code once ("AI 470", never "AI AI 470").
      expect(text, 'airline code printed twice').not.toMatch(/\b([A-Z][A-Z0-9]|[0-9][A-Z]) \1 ?\d{1,4}\b/);
      // D10: DEC-59 wording superseded; D7: F-04 retired; done dialog makes no "costs are locked" claim.
      expect(text).not.toContain('Confirmed by supplier');
      expect(text).not.toContain('Traveller names are not shown to the Flight team');
      expect(text).not.toMatch(/costs are locked/i);
      // Sales has no dead "Open Flight task" link (singular, to one task; Home's "Open Flight tasks" queue links are fine).
      expect(await page.getByRole('link', { name: /^Open Flight task\b(?!s)/i }).count()).toBe(0);
      // No fares in History (fixes FV:800 vs FV:2208).
      if (/history/.test(state)) expect(text, 'amounts in History').not.toMatch(/₹\s?\d/);
      // Ticket ranges show full numbers on both ends.
      for (const m of text.matchAll(/(\d{3}-?\d{6,})\s?–\s?(\S+)/g)) expect(m[2]!.replace(/\D/g, '').length, `range ${m[0]}`).toBeGreaterThanOrEqual(10);
      // Done dialog: no sector numbers ("Sector 1", "S1").
      if (/done|finish/.test(state)) expect(text).not.toMatch(/\bSector \d+\b/);
      // 12.3: time boxes accept 8 characters ("07:05 pm"; the prototype's maxlength was 7). Checked per state here
      // (a separate test looping every state ran past the 30 s default timeout).
      for (const input of await page.locator('input[name*="ime" i], input[aria-label*="time" i]').all()) {
        const max = await input.getAttribute('maxlength');
        if (max !== null) expect(Number(max), `${state} time box maxlength`).toBeGreaterThanOrEqual(8);
      }
      // Popup width: min(76rem, 100vw - 2rem).
      for (const dialog of await page.getByRole('dialog').all()) {
        const box = await dialog.boundingBox();
        if (box) expect(box.width).toBeLessThanOrEqual(Math.min(76 * 16, 1280 - 32) + 1);
      }

      await page.setViewportSize({ width: 375, height: 812 });
      await open(page, state);
      await noHorizontalScroll(page, `${state} @375`);
      expect(await axe(page), `${state} @375`).toEqual([]);
      for (const dialog of await page.getByRole('dialog').all()) {
        const box = await dialog.boundingBox();
        if (box) expect(box.width, `${state} dialog @375`).toBeLessThanOrEqual(375 - 32 + 1);
      }
      // 200% zoom of a 1280 px window = 640 CSS px.
      await page.setViewportSize({ width: 640, height: 450 });
      await open(page, state);
      await noHorizontalScroll(page, `${state} @200%`);
    });
  }

  test('Mark flight done: the dialog starts on Cancel, has the frozen text, no sector numbers, and returns focus', async ({ page }) => {
    // Flight build (11.1 Finish this flight; lead UI review 5 Nov 2026: the confirm dialog opens focused on Cancel).
    test.skip(!STATES.includes('flight-ws-ready'), 'No flight-ws-ready preview state.');
    await open(page, 'flight-ws-ready');
    const trigger = page.locator('main').getByRole('button', { name: 'Mark flight done' });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('Sales and Accounts see that the tickets are issued. Ticket details stay correctable with a reason.');
    await expect(dialog).not.toContainText(/costs are locked/i);
    await expect(dialog).not.toContainText(/\bSector \d+\b/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('Approvals: header names Flight; flight-only suppliers are decided here without a Purchase supplier link', async ({ page }) => {
    // Flight build (lead UI review 5 Nov 2026; Track B 0280: flight-only suppliers are not on the Purchase supplier pages).
    test.skip(!STATES.includes('flight-approvals'), 'No flight-approvals preview state.');
    await open(page, 'flight-approvals');
    const main = page.locator('main');
    await expect(main).toContainText('Purchase, Flight and Accounts requests that need the branch Manager.');
    await expect(main).toContainText('Flight fares above budget');
    await expect(main).toContainText(/Services\s*Flight/);
    expect(await main.locator('a[href*="/app/purchase/suppliers"]').count(), 'no Purchase supplier link for flight-only suppliers').toBe(0);
  });

  test('edit rows exist only for the Flight assignee (no edit row in read-only states)', async ({ page }) => {
    test.setTimeout(120_000);
    const readOnly = STATES.filter((s) => /manager|sales|read-only|readonly|not-taken|other/.test(s));
    test.skip(readOnly.length === 0, 'No read-only flight states found by name.');
    for (const state of readOnly) {
      if (!(await open(page, state))) continue;
      expect(await page.getByRole('button', { name: /^(Alternate|Fill missing details|\+ Add sector|Save sectors)$/ }).count(), state).toBe(0);
    }
  });
});
