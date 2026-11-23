import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { pageReady } from '../helpers/page-ready';

/**
 * Purchase build screens (Track C, 2 Nov 2026) through the design-preview
 * gallery: every pb- (Purchase) and pm- (Accounts, Manager) state, plus the
 * drawers. Synthetic props, no Supabase: not evidence of a real journey.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function statesFromIndex(page: Page): Promise<string[]> {
  await page.goto('/preview');
  const hrefs = await page.locator('a[href^="/preview/pb-"], a[href^="/preview/pm-"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!.replace('/preview/', '')));
  return [...new Set(hrefs)];
}

async function open(page: Page, state: string) {
  await page.goto(`/preview/${state}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await pageReady(page);
}

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function noSidewaysScroll(page: Page, label = '') {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `sideways scroll ${label}`).toBeLessThanOrEqual(cw);
}

/** Visible controls that stick out of the viewport (clipped at 200 % zoom). */
async function clippedControls(page: Page, scope = 'main'): Promise<string[]> {
  return page.evaluate((root) => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>(`${root} button, ${root} a, ${root} input, ${root} select, ${root} textarea, ${root} summary`)]
      .filter((el) => el.offsetParent !== null)
      // A control inside a sideways-scrolling strip (the link tabs) is reachable by scrolling it, not clipped.
      .filter((el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return false;
        }
        return true;
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > width + 1 || r.left < -1);
      })
      .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent ?? '').trim().slice(0, 40)}`);
  }, scope);
}

/** Wait for the drawer's slide-in to finish before measuring it. */
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

async function zoom200(page: Page) {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
}

test('every pb- and pm- state: axe clean, one h1, no sideways scroll at 1280, 375 and 200 % zoom, no clipped controls', async ({ page }) => {
  test.setTimeout(600_000);
  const states = await statesFromIndex(page);
  expect(states.length).toBeGreaterThan(40);
  for (const state of states) {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, state);
      await noSidewaysScroll(page, `${state} at ${width}`);
      expect(await axe(page), `${state} at ${width}`).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count(), state).toBe(1);
    }
    await open(page, state);
    await zoom200(page);
    await noSidewaysScroll(page, `${state} at 200 %`);
    expect(await clippedControls(page), `${state} at 200 %`).toEqual([]);
  }
});

test('Purchase screens never show a selling price, margin or company funding reason', async ({ page }) => {
  // One test walks every pb- state; the gallery index grew with the Flight build, so 30 s is too tight in CI.
  test.setTimeout(120_000);
  const states = (await statesFromIndex(page)).filter((s) => s.startsWith('pb-'));
  for (const state of states) {
    await open(page, state);
    const text = (await page.getByRole('main').innerText()).toLowerCase();
    for (const word of ['selling', 'margin', 'customer paid', 'funding', 'customer money']) expect(text, `${state}: ${word}`).not.toContain(word);
  }
});

test('booking request drawer: drafted with the Deal ID and the final rate, keyboard reachable, fits at 200 % zoom, Mark as sent records it', async ({ page }) => {
  await open(page, 'pb-task-work-final-rate');
  await zoom200(page);
  const trigger = page.getByRole('button', { name: 'Send booking request' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Send the booking request' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Subject')).toHaveValue('Booking request · SYN-JOD-547 · Synthetic Fort Retreat, Jaisalmer · 6–8 Nov 2026');
  // The amount is exactly the final tile's cost version (₹1,04,000), never the budget (₹1,10,000).
  await expect(drawer.getByLabel('Message')).toHaveValue(/Agreed rate: ₹1,04,000 in total\./);
  await expect(drawer.getByLabel('Message')).not.toHaveValue(/1,10,000/);
  await settled(page);
  await expect(drawer.getByRole('link', { name: 'Open in e-mail app' })).toHaveAttribute('href', /^mailto:reservations@fort-retreat\.example\?subject=/);
  expect(await clippedControls(page, '[role="dialog"]')).toEqual([]);
  expect(await axe(page)).toEqual([]);
  await drawer.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(drawer.getByRole('status').filter({ hasText: 'Done:' })).toContainText('Booking request recorded.');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('a wrong Cc address is refused in the drawer and the typed text stays', async ({ page }) => {
  await open(page, 'pb-task-work-no-rates');
  await page.getByRole('button', { name: 'Ask for rates' }).click();
  const drawer = page.getByRole('dialog', { name: 'Ask the supplier for rates' });
  await drawer.getByLabel('Cc').fill('ops@example.test, not-an-address');
  await drawer.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(drawer.getByLabel('Cc')).toBeFocused();
  await expect(drawer).toContainText('One Cc address is not an e-mail address.');
  await expect(drawer.getByLabel('Cc')).toHaveValue('ops@example.test, not-an-address');
});

test('payment drawer: live route notice, optional note for Accounts, no customer-money or funding signal, fits at 200 % zoom', async ({ page }) => {
  await open(page, 'pb-task-work-go-ahead-given');
  await zoom200(page);
  await page.getByRole('button', { name: 'Request advance payment' }).click();
  const drawer = page.getByRole('dialog', { name: 'Request a supplier payment' });
  await expect(drawer).toBeVisible();
  await settled(page);
  const amount = drawer.getByLabel('Amount (₹)');
  await amount.fill('10000');
  await expect(drawer.getByRole('status').filter({ hasText: 'Accounts approves' })).toBeVisible();
  await amount.fill('30000');
  // ₹30,000 already asked + ₹30,000 = above ₹50,000: the branch Manager approves.
  await expect(drawer.getByRole('status').filter({ hasText: 'Branch Manager approves' })).toBeVisible();
  // Review F1: Purchase never sees whether customer money arrived, and never asks for company funding.
  await expect(drawer.getByLabel('Note for Accounts (optional)')).toBeVisible();
  for (const word of ['Customer money', 'company funding', 'funding']) await expect(drawer).not.toContainText(word);
  expect(await clippedControls(page, '[role="dialog"]')).toEqual([]);
  expect(await axe(page)).toEqual([]);
});

test('unavailable actions stay focusable with one short reason', async ({ page }) => {
  await open(page, 'pb-task-work-waiting-go-ahead');
  const confirm = page.getByRole('button', { name: 'Record supplier confirmation' });
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAccessibleDescription('Waiting for Accounts go-ahead. Accounts approves every hotel commitment.');
  await confirm.focus();
  await expect(confirm).toBeFocused();
});

test('a hotel payment request waits for the booking e-mail: the button says why', async ({ page }) => {
  await open(page, 'pb-task-work-final-rate');
  const pay = page.getByRole('button', { name: 'Request advance payment' });
  await expect(pay).toHaveAttribute('aria-disabled', 'true');
  await expect(pay).toHaveAccessibleDescription('Send the booking request to the supplier first.');
});

const PDF = { name: 'synthetic-proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%synthetic\n') };

test('Accounts records a payment: the proof upload names the payment request, then the payment is recorded', async ({ page }) => {
  await open(page, 'pm-accounts-supplier-payments-to-record');
  await page.getByText('Record the payment').first().click();
  const form = page.getByRole('form', { name: 'Record that this supplier was paid?' }).first();
  await form.getByLabel('Paid on').fill('2026-11-01');
  await form.getByLabel(/Bank reference|Cheque number/).fill('SYNUTR0042');
  await form.getByLabel('Payment proof').setInputFiles(PDF);
  await form.getByRole('button', { name: 'Record payment' }).click();
  // The preview upload refuses a payment proof without its payment request id (as the server does).
  await expect(page.getByRole('status').filter({ hasText: 'Payment recorded.' })).toBeVisible();
  await expect(page.getByText('the upload names no payment request or task')).toHaveCount(0);
});

test('after the supplier confirmed, the assignee can still ask for the balance (the database decides who may ask)', async ({ page }) => {
  await open(page, 'pb-task-work-confirmed-pay');
  await page.getByRole('button', { name: 'Request payment' }).click();
  const drawer = page.getByRole('dialog', { name: 'Request a supplier payment' });
  await expect(drawer.getByLabel('Part')).toContainText('Balance');
  // The confirmed task's other Purchase controls stay locked.
  await expect(page.getByRole('button', { name: 'Use as final rate' })).toHaveCount(0);
});

test('the booking request result stays on the page after the drawer is gone', async ({ page }) => {
  await open(page, 'pb-task-work-final-rate');
  await page.getByRole('button', { name: 'Send booking request' }).click();
  const drawer = page.getByRole('dialog', { name: 'Send the booking request' });
  await drawer.getByRole('button', { name: 'Mark as sent' }).click();
  const flash = page.locator('[data-slot="work-flash"]');
  await expect(flash).toContainText('Booking request recorded.');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(flash).toContainText('Booking request recorded.');
});

// ---------------------------------------------------------------------------
// R3 (C1): queue pattern, Payment requests as a tab, record header and O6.
// ---------------------------------------------------------------------------

test.describe('R3 Purchase queue pattern', () => {
  test('one toolbar row: search, status chips with counts, sort; the tabs keep the search', async ({ page }) => {
    await open(page, 'pb-queue-search');
    const main = page.locator('main');
    const toolbar = main.getByRole('search', { name: 'Search and filter Purchase tasks' });
    await expect(toolbar.getByRole('searchbox', { name: 'Search Purchase tasks' })).toHaveValue('Udaipur');
    await expect(toolbar).toContainText('Showing matches for “Udaipur”.');
    await expect(toolbar.getByLabel('Sort by')).toHaveValue('soonest');
    await expect(main.getByRole('table', { name: /^1 hotel task of 5 on this tab/ })).toContainText('Example Lake Palace, Udaipur');
    const tabs = main.getByRole('navigation', { name: 'Purchase task filters' });
    await expect(tabs.getByRole('link', { name: /^Mine/ })).toHaveAttribute('href', '/app/purchase?show=mine&q=Udaipur');
    await expect(tabs.getByRole('link', { name: 'Payment requests' })).toHaveAttribute('href', '/app/purchase/payments');
    await expect(tabs).toHaveAttribute('data-variant', 'pill');
  });

  test('a chip is a link that keeps the tab, search and sort; the current chip turns it off', async ({ page }) => {
    await open(page, 'pb-queue-chip');
    const chips = page.getByRole('navigation', { name: 'Filter by status' });
    const current = chips.getByRole('link', { name: /^Waiting for go-ahead/ });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('href', '/app/purchase?show=all&sort=deal');
    await expect(page.getByRole('table', { name: /^1 hotel task of 5/ })).toContainText('Synthetic Fort Retreat, Jaisalmer');
  });

  test('nothing matches: says so and offers one way back', async ({ page }) => {
    await open(page, 'pb-queue-nothing-matches');
    const status = page.locator('main').getByRole('status').filter({ hasText: 'Nothing matches' });
    await expect(status).toBeVisible();
    await expect(status.getByRole('link', { name: 'Clear search and filter' })).toHaveAttribute('href', '/app/purchase?show=all');
  });

  test('rows: one status badge plus one plain fact, the Next step words and one row button', async ({ page }) => {
    await open(page, 'pb-queue');
    const table = page.getByRole('table', { name: /tasks/ });
    await expect(table.getByRole('columnheader')).toHaveText(['What', 'Dates', 'Approved budget', 'Status', 'Next step', 'Taken by', 'Deal']);
    const mine = table.getByRole('row').filter({ hasText: 'Synthetic Fort Retreat, Jaisalmer' });
    await expect(mine).toContainText(/6–\u2060?8\sNov\s2026/);
    await expect(mine).toContainText('2 nights · 4 rooms · 8 adults, 1 child');
    await expect(mine).toContainText('Waiting for Accounts go-ahead');
    await expect(mine.getByRole('link', { name: /^Continue/ })).toHaveCount(0);
    const open1 = table.getByRole('row').filter({ hasText: 'Example Lake Palace, Udaipur' });
    await expect(open1.getByRole('link', { name: 'Open to take Example Lake Palace, Udaipur' })).toBeVisible();
    // One status badge per row: the go-ahead and trip facts are words, never a second badge.
    for (const row of await table.getByRole('row').all()) expect(await row.locator('[data-kind]').count()).toBeLessThanOrEqual(1);
  });

  test('the branch Manager follows progress: no Mine tab, no Payment requests tab, no row buttons', async ({ page }) => {
    await open(page, 'pb-queue-manager');
    const main = page.locator('main');
    await expect(main).toContainText('Purchase colleagues take these tasks. You can follow progress here.');
    await expect(main.getByRole('navigation', { name: 'Purchase task filters' }).getByRole('link')).toHaveCount(2);
    await expect(main.getByRole('link', { name: /^(Open to take|Continue)/ })).toHaveCount(0);
  });
});

test.describe('R3 Payment requests tab', () => {
  test('the task tabs with Payment requests open; Open · Returned · Paid · All are chips with the old ?show= values', async ({ page }) => {
    await open(page, 'pb-payments-returned');
    const main = page.locator('main');
    const tabs = main.getByRole('navigation', { name: 'Purchase task filters' });
    await expect(tabs.getByRole('link', { name: 'Payment requests' })).toHaveAttribute('aria-current', 'page');
    const chips = main.getByRole('navigation', { name: 'Filter by state' });
    await expect(chips.getByRole('link', { name: /^Returned/ })).toHaveAttribute('aria-current', 'page');
    await expect(chips.getByRole('link', { name: /^Open/ })).toHaveAttribute('href', '/app/purchase/payments');
    await expect(chips.getByRole('link', { name: /^All/ })).toHaveAttribute('href', '/app/purchase/payments?show=all');
    const table = main.getByRole('table', { name: /request/ });
    await expect(table.getByRole('columnheader')).toHaveText(['Request', 'Due by', 'Amount', 'Status', 'Next step', 'Deal']);
    await expect(table.getByRole('link', { name: /^Change and send again/ })).toHaveAttribute('href', /\?tab=work$/);
    // The ₹50,000 rule is said once, in the header line.
    await expect(main.getByText(/₹50,000/)).toHaveCount(1);
  });

  test('search and sort; nothing matches; a failed read says so and is never "nothing here"', async ({ page }) => {
    await open(page, 'pb-payments-search');
    await expect(page.getByRole('search', { name: 'Search and filter payment requests' })).toContainText('Showing matches for “deposit”.');
    await expect(page.getByRole('search').getByLabel('Sort by')).toHaveValue('newest');
    await open(page, 'pb-payments-nothing-matches');
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Nothing matches' }).getByRole('link', { name: 'Clear search' })).toHaveAttribute('href', '/app/purchase/payments?show=all');
    await open(page, 'pb-payments-error');
    await expect(page.locator('main').getByRole('alert')).toContainText('Payment requests could not be loaded just now');
    await expect(page.locator('main')).not.toContainText('Nothing here');
  });
});

test.describe('R3 Purchase task record header (C4, O6)', () => {
  test('back link and Deal; title; status, go-ahead and Taken by; Next with one primary; the internal line is folded', async ({ page }) => {
    await open(page, 'pb-task-details');
    const header = page.locator('main [data-slot="record-header"]');
    await expect(header.getByRole('link', { name: 'Back to Purchase tasks' })).toHaveAttribute('href', '/app/purchase');
    await expect(header).toContainText('Hotel task · SYN-JOD-547');
    await expect(header.getByRole('heading', { level: 1 })).toHaveText('Synthetic Fort Retreat, Jaisalmer');
    await expect(header).toContainText('Taken by: You');
    await expect(header.locator('[data-slot="next-step"] p')).toContainText('Next: wait for Accounts to give the go-ahead');
    // A waiting step has no button: nothing for this viewer to press.
    await expect(header.locator('[data-slot="next-step"]').getByRole('link')).toHaveCount(0);
    await expect(header.locator('details')).not.toHaveAttribute('open', '');
    await expect(header.locator('details')).toContainText('Internal task');
  });

  test('O6 from Details: the one primary opens Work at the control; the holder lands on Work, so Details keeps ?tab=details (D6)', async ({ page }) => {
    await open(page, 'pb-task-details-next');
    const main = page.locator('main');
    const next = main.locator('[data-slot="next-step"]').getByRole('link');
    await expect(next).toHaveCount(1);
    await expect(next).toHaveAttribute('href', /^\/app\/purchase\/[0-9a-f-]+#purchase-next-[a-z-]+$/);
    const tabs = main.getByRole('navigation', { name: 'Task sections' });
    await expect(tabs.getByRole('link', { name: 'Details' })).toHaveAttribute('href', /\?tab=details$/);
    await expect(tabs.getByRole('link', { name: 'Work' })).toHaveAttribute('href', /\/app\/purchase\/[0-9a-f-]+$/);
    await expect(tabs).toHaveAttribute('data-variant', 'pill');
  });

  test('O6 on Work: the header button jumps to the control and moves focus there', async ({ page }) => {
    // Needs helper F's target ids inside the Work form (purchase-next-<step>).
    await open(page, 'pb-task-work-no-rates');
    const jump = page.locator('main [data-slot="next-step"]').getByRole('link', { name: /^Add a rate/ });
    await expect(jump).toHaveAttribute('href', '#purchase-next-add-rate');
    await jump.click();
    await expect(page.locator('#purchase-next-add-rate')).toBeFocused();
  });

  test('O6 from another tab: arriving on Work at #purchase-next-… moves focus to that control', async ({ page }) => {
    // The header link from Details opens Work with the control's id in the address (FocusHashTarget on the Work tab).
    await page.goto('/preview/pb-task-work-no-rates#purchase-next-add-rate');
    await expect(page.locator('#purchase-next-add-rate')).toBeFocused();
    await expect(page.locator('#purchase-next-add-rate')).toBeInViewport();
  });

  test('every Next line the Work form can show maps to a control or to no button, never to a wrong one', async ({ page }) => {
    for (const [state, target] of [
      ['pb-task-work-no-rates', 'purchase-next-add-rate'],
      ['pb-task-work-final-rate', 'purchase-next-booking-request'],
      ['pb-task-work-go-ahead-given', 'purchase-next-confirmation'],
      ['pb-task-work-go-ahead-returned', 'purchase-next-booking-request'],
      ['pb-task-work-waiting-go-ahead', null],
      ['pb-task-work-over-budget', null],
    ] as const) {
      await open(page, state);
      const link = page.locator('main [data-slot="next-step"]').getByRole('link');
      if (target) await expect(link, state).toHaveAttribute('href', `#${target}`);
      else await expect(link, state).toHaveCount(0);
    }
  });
});

test('one money rule (D4): a payment amount typed as "₹100" is refused, the typed text stays, and the refusal names the amount', async ({ page }) => {
  await open(page, 'pb-task-work-go-ahead-given');
  await page.getByRole('button', { name: 'Request advance payment' }).click();
  const drawer = page.getByRole('dialog', { name: 'Request a supplier payment' });
  await expect(drawer).toBeVisible();
  await settled(page);
  const amount = drawer.getByLabel('Amount (₹)');
  await amount.fill('₹100');
  await drawer.getByRole('button', { name: 'Send payment request' }).click();
  await expect(drawer.getByText('Enter the amount in rupees, for example 25000.')).toBeVisible();
  await expect(amount).toHaveValue('₹100');
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await expect(amount).toBeFocused();
});
