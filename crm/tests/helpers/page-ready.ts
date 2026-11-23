import { expect, type Page } from '@playwright/test';

/**
 * A preview page is ready to measure: its page heading (h1, which every
 * preview state has) is in the page, React has hydrated it, and the web fonts
 * have loaded.
 *
 * Used instead of `waitForLoadState('networkidle')`. Under `next dev` on the
 * CI runner some preview pages never went idle: tests waited 90 s, or 10
 * minutes in pb-screens, at the first states and then timed out (runs
 * 44082291961, 44082298518 and 44092329645, 17 November 2026). Waiting for
 * hydration also means that values set by client code, such as a form's
 * requestId, are read after React has rendered them, not from the server HTML.
 */
export async function pageReady(page: Page): Promise<void> {
  await expect(page.locator('h1').first()).toBeAttached();
  // React marks each element it has hydrated with a `__reactFiber$…` property.
  await page.waitForFunction(() => {
    const heading = document.querySelector('h1');
    return heading !== null && Object.keys(heading).some((key) => key.startsWith('__reactFiber$'));
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}
