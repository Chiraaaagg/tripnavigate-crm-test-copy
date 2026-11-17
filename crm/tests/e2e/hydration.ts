import type { Page } from '@playwright/test';

/**
 * Waits until React has hydrated the page. `networkidle` only says the
 * scripts have arrived; on a slow, busy runner hydration (and anything mounted
 * after it, such as a dialog portal opened by a preview state) can still be
 * running. React marks every hydrated element with a `__reactFiber$…` key, so
 * the check is that `<body>` (and `<main>`, when the page has one) carry it.
 * Changing the DOM before this point makes hydration fail and React rebuild
 * the tree, which drops keyboard focus.
 */
export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const hydrated = (el: Element | null) => !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
    const main = document.querySelector('main');
    return hydrated(document.body) && (!main || hydrated(main));
  });
}
