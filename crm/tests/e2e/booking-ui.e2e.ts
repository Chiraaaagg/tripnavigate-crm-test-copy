import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 3 hotel booking → Purchase task screens, through the design-preview
 * gallery (synthetic props, no Supabase). Not evidence of a real journey:
 * that needs the real-stack suite.
 */

const bookingStates = [
  'booking-none',
  'booking-none-deal-not-active',
  'booking-none-deal-not-active-read-only',
  'booking-none-read-only',
  'booking-draft-needs-repair',
  'booking-draft-ask-owner',
  'booking-draft-ready',
  'booking-draft-ready-assignee',
  'booking-confirm-dialog',
  'booking-confirm-conflict',
  'booking-save-conflict',
  'booking-saved',
  'booking-gate-off',
  'booking-environment-unset',
  'booking-source-stale',
  'booking-upload-failed',
  'booking-upload-rejected',
  'booking-max-files',
  'booking-confirmed',
  'booking-confirmed-taken',
  'booking-confirmed-proof-hidden',
  'booking-unavailable',
  'booking-loading',
];
const purchaseStates = [
  'purchase-queue',
  'purchase-queue-empty',
  'purchase-queue-sales-view',
  'purchase-task-open',
  'purchase-task-mine',
  'purchase-task-claim-conflict',
  'purchase-task-sales-view',
  'purchase-task-not-found',
];
const phase35States = ['booking-draft-read-only', 'booking-gate-off-ready', 'deal-detail-commercial-not-recorded'];
const healthStates = [
  'booking-health-off',
  'booking-health-on',
  'booking-health-environment-unset',
  'booking-health-unknown',
  'booking-health-no-permission',
];
const allStates = [...bookingStates, ...purchaseStates, ...healthStates, ...phase35States];
const draftStates = bookingStates.filter((s) => !s.startsWith('booking-confirmed') && s !== 'booking-loading');

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  // Contrast is measured on the settled page: a fading dialog is not a contrast failure.
  // (Endless decorative loops, such as the loading placeholder, are ignored.)
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

test.describe('booking previews: accessibility on desktop and 390 px mobile', () => {
  for (const state of allStates) {
    test(`axe clean: ${state}`, async ({ page }) => {
      await page.goto(`/preview/${state}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
      await page.waitForLoadState('networkidle');
      expect(await axe(page)).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('200% zoom (1280 px window → 640 CSS px) keeps content without horizontal scroll', () => {
  for (const state of [
    'booking-draft-needs-repair',
    'booking-draft-read-only',
    'booking-draft-ready',
    'booking-confirm-dialog',
    'booking-confirmed',
    'purchase-queue',
    'purchase-task-open',
    'booking-health-off',
  ]) {
    test(`zoom 200%: ${state}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 640, height: 430 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.goto(`/preview/${state}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
      await noHorizontalScroll(page);
      await context.close();
    });
  }
});

test.describe('hotel booking panel wording and structure', () => {
  test('draft states never call the draft confirmed or booked', async ({ page }) => {
    for (const state of draftStates) {
      await page.goto(`/preview/${state}`);
      const panel = page.locator('#hotel-booking');
      if ((await panel.count()) === 0) continue;
      // Remove the frozen negative statements, then nothing may claim a confirmed or booked status.
      const text = (await panel.innerText())
        .replace(/Confirm and create Purchase task/g, '')
        .replace(/Nothing is confirmed\.|Nothing was confirmed\.|It is not confirmed yet\./g, '')
        .replace(/It does not book the hotel[^.]*\./g, '')
        .replace(/not booked yet/g, '')
        .replace(/Booking confirmation is turned off[^.]*\./g, '')
        .replace(/confirming|Review and confirm|then confirm|before confirming|to confirm|can confirm|Before you can confirm/gi, '');
      expect(text, state).not.toMatch(/\bbooked\b/i);
      expect(text, state).not.toMatch(/\bconfirmed\b/i);
      await expect(panel.getByText('Confirmed · Purchase task created')).toHaveCount(0);
    }
  });

  test('status, who acts next, next step and one primary action are at the top', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    const panel = page.getByRole('region', { name: 'Hotel booking', exact: true });
    await expect(panel).toContainText('Draft · ready to confirm');
    await expect(panel.locator('[data-slot="next-line"]')).toContainText('Next: review the details and confirm to create the Purchase task · Sales Sales Manager You');
    await expect(panel.locator('.work-panel-head .button:not(.secondary):visible')).toHaveCount(1);
    await expect(panel.locator('.work-panel-head').getByRole('button', { name: 'Review and confirm' })).toBeVisible();
  });

  test('repair list links to the exact fields and marks them invalid', async ({ page }) => {
    await page.goto('/preview/booking-draft-needs-repair');
    const repair = page.getByRole('region', { name: 'Before you can confirm' });
    await expect(repair.getByRole('listitem')).toHaveCount(6);
    await repair.getByRole('link', { name: 'Add the city.' }).click();
    await expect(page.getByLabel('City')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('City')).toHaveAccessibleDescription(/Add the city\./);
    await expect(repair.getByRole('link', { name: /Upload at least one proof/ })).toHaveAttribute('href', '#booking-proof');
    await expect(page.getByRole('button', { name: 'Review and confirm' })).toHaveCount(0);
  });

  test('proof privacy note, upload hint, failed upload and remove buttons are explicit', async ({ page }) => {
    await page.goto('/preview/booking-draft-needs-repair');
    await expect(
      page.getByText('Proof files are visible only to the Sales owner, assigned Sales and the branch Sales Manager — never to Purchase.'),
    ).toBeVisible();
    await expect(page.getByLabel('File', { exact: true })).toHaveAccessibleDescription(/PDF, JPG, PNG or WebP, up to 4 MB/);
    await expect(page.locator('.file-row')).toContainText('Upload failed');
    await expect(page.getByRole('button', { name: 'Remove synthetic-bill.jpg' })).toBeVisible();
    await page.goto('/preview/booking-upload-failed');
    await expect(page.locator('main').getByRole('alert')).toContainText('The proof was not accepted and does not count. Remove it if it is listed, then upload it again.');
    await page.goto('/preview/booking-max-files');
    await expect(page.getByText('You have uploaded the maximum of 10 files.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload proof' })).toHaveCount(0);
  });

  test('booking total field only when the DTO carries it; otherwise "hidden for your role"', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await expect(page.getByLabel('Booking total agreed with the customer')).toHaveValue('52000.00');
    await expect(page.getByLabel('Booking total agreed with the customer')).toHaveAccessibleDescription(/not the deal selling price/);
    await page.goto('/preview/booking-draft-ready-assignee');
    await expect(page.getByLabel('Booking total agreed with the customer')).toHaveCount(0);
    const hiddenTotal = page.locator('#hotel-booking .field').filter({ hasText: 'Booking total agreed with the customer' });
    await expect(hiddenTotal).toContainText('Hidden for your role');
    await expect(hiddenTotal).not.toContainText('Not recorded yet');
    await expect(page.locator('main')).toContainText('The deal owner or a Sales Manager for this branch can.');
    await expect(page.getByRole('button', { name: 'Review and confirm' })).toHaveCount(0);
  });

  test('typed work is kept and a conflict offers to load the latest details', async ({ page }) => {
    await page.goto('/preview/booking-save-conflict');
    const alert = page.locator('main').getByRole('alert');
    await expect(alert).toContainText('Someone changed these booking details after you opened them. Nothing was confirmed.');
    // Finished sections start folded; open "Stay" to edit it.
    await page.locator('summary', { hasText: 'Stay' }).click();
    await page.getByLabel('Hotel name').fill('Synthetic changed name');
    await expect(page.getByText('You have unsaved changes.').first()).toBeVisible();
    await expect(page.getByText('Save them before confirming')).toBeVisible();
    await alert.getByRole('button', { name: 'Load the latest details' }).click();
    await expect(page.getByLabel('Hotel name')).toHaveValue('Synthetic Lakeside Hotel');
  });

  test('blocked states say what happened, that the draft is saved and who can fix it', async ({ page }) => {
    await page.goto('/preview/booking-gate-off');
    const main = page.locator('main');
    await expect(main).toContainText('Confirmation is blocked.');
    await expect(main).toContainText('Booking confirmation is turned off for real deals until the pilot is approved. Your draft is saved.');
    await expect(page.getByRole('button', { name: 'Review and confirm' })).toHaveCount(0);
    await page.goto('/preview/booking-environment-unset');
    await expect(page.locator('main')).toContainText('This CRM environment is not set up yet. Your draft is saved. Ask an admin.');
    await page.goto('/preview/booking-confirmed');
    await expect(page.locator('main')).toContainText('Changes after confirmation aren’t supported yet');
    await expect(page.getByRole('button', { name: 'Save booking details' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View Purchase task' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Internal task — the hotel is not booked yet.');
    await page.goto('/preview/booking-unavailable');
    await expect(page.locator('main')).toContainText('The hotel booking did not load. Nothing was changed.');
    await expect(page.locator('main')).not.toContainText('No booking details yet');
  });

  test('a lost or rejected deal says why a booking cannot be started instead of offering it (Stage 7)', async ({ page }) => {
    await page.goto('/preview/booking-none');
    await expect(page.getByRole('button', { name: 'Start hotel booking details' })).toBeVisible();
    await page.goto('/preview/booking-none-deal-not-active');
    const panel = page.getByRole('region', { name: 'Hotel booking', exact: true });
    await expect(panel).toContainText('This deal is marked lost or rejected in Bitrix. Bookings can only be started on active deals.');
    await expect(panel.locator('[data-slot="next-line"]')).toHaveText('Next: nothing while the deal is lost or rejected in Bitrix');
    await expect(page.getByRole('button', { name: 'Start hotel booking details' })).toHaveCount(0);
    const step = panel.getByRole('list', { name: /hand-offs/ }).locator('li[aria-current="step"]');
    await expect(step).toContainText('Blocked:');
    await expect(step).toContainText('The deal is lost or rejected in Bitrix.');
    // Readers get the same explanation instead of "the owner adds the hotel details".
    await page.goto('/preview/booking-none-deal-not-active-read-only');
    await expect(panel).toContainText('This deal is marked lost or rejected in Bitrix. Bookings can only be started on active deals.');
    await expect(panel).not.toContainText('adds the hotel details');
  });
});

test.describe('confirm dialog keyboard path', () => {
  test('opens, traps focus, explains consequences, closes on Escape and returns focus', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    const trigger = page.getByRole('button', { name: 'Review and confirm' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Confirm this booking and create a Purchase task?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(/locks version 1.*does not book the hotel/s);
    await expect(dialog.getByRole('button', { name: 'Go back' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Confirm and create Purchase task' })).toBeFocused();
    // Focus stays inside the modal dialog.
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('dialog'));
      const onBody = await page.evaluate(() => document.activeElement === document.body);
      expect(inside || onBody).toBe(true);
    }
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('Go back closes without confirming', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Review and confirm' }).click();
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('main')).toContainText('Draft · ready to confirm');
  });

  test('a changed version is reported inside the open dialog with a way to reload', async ({ page }) => {
    await page.goto('/preview/booking-confirm-conflict');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('Nothing was confirmed');
    await expect(dialog.getByRole('link', { name: 'Load the latest details' })).toBeVisible();
  });
});

test.describe('Purchase screens', () => {
  test('queue states the task is internal and shows no selling price or proof', async ({ page }) => {
    await page.goto('/preview/purchase-queue');
    const main = page.locator('main');
    // The queue can hold supplier-confirmed tasks, so its line states the rule instead of "not booked yet" (DA-273).
    await expect(main).toContainText('Each counts as booked only after you record the supplier’s confirmation.');
    await expect(main).toContainText('Customer prices and proof files are never shown here.');
    await expect(main).not.toContainText(/Selling/i);
    await expect(main).not.toContainText(/synthetic-acceptance|\.pdf|\.png|Download/i);
    await expect(page.getByRole('table', { name: '3 hotel tasks' })).toContainText('₹45,000.00');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Purchase tasks' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.goto('/preview/purchase-queue-empty');
    await expect(page.locator('main')).toContainText('Tasks appear after Sales submits a booking with a hotel, transfer or activity.');
  });

  test('task page: one primary "Take this task", no Selling, no booked claim', async ({ page }) => {
    for (const state of purchaseStates) {
      await page.goto(`/preview/${state}`);
      const main = page.locator('main');
      await expect(main, state).not.toContainText(/Selling/i);
      await expect(main, state).not.toContainText(/supplier[- ]booked|hotel is booked|has been booked/i);
    }
    await page.goto('/preview/purchase-task-open');
    await expect(page.getByRole('button', { name: 'Take this task' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Take this task' })).toHaveAccessibleDescription(/does not book the hotel/);
    await expect(page.locator('main')).toContainText('Internal task — the hotel is not booked yet.');
    await page.goto('/preview/purchase-task-claim-conflict');
    await expect(page.locator('main').getByRole('alert')).toContainText('Another Purchase colleague has already taken this task.');
    await expect(page.getByRole('button', { name: 'Take this task' })).toHaveCount(0);
    await page.goto('/preview/purchase-task-sales-view');
    await expect(page.getByRole('button', { name: 'Take this task' })).toHaveCount(0);
  });

  test('Purchase nav item is hidden from Sales', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Purchase tasks' })).toHaveCount(0);
  });

  test('Purchase deal view still shows no amount and no booking panel', async ({ page }) => {
    await page.goto('/preview/deal-detail-purchase');
    await expect(page.locator('#hotel-booking')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('₹');
  });
});

test.describe('booking health', () => {
  test('gate off is stated in words; unknown never looks healthy', async ({ page }) => {
    await page.goto('/preview/booking-health-off');
    await expect(page.locator('main')).toContainText('Real bookings: off');
    await expect(page.getByRole('region', { name: 'Bookings and Purchase tasks' })).toContainText('Drafts needing details3');
    await page.goto('/preview/booking-health-unknown');
    const main = page.locator('main');
    await expect(main).toContainText('Booking health: Unknown');
    await expect(main).toContainText('Nothing is assumed healthy');
    await expect(main).not.toContainText('Real bookings: on');
    await page.goto('/preview/booking-health-environment-unset');
    await expect(page.locator('main')).toContainText('Not set up: bookings cannot be confirmed');
    await page.goto('/preview/booking-health-on');
    await expect(page.locator('main')).toContainText('Real bookings: on');
    await expect(page.locator('main')).not.toContainText(/\bhealthy\b/i);
  });

  test('System health (Booking health page) nav only for integration managers', async ({ page }) => {
    await page.goto('/preview/booking-health-off');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'System health' })).toHaveAttribute('aria-current', 'page');
    await page.goto('/preview/booking-health-no-permission');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
  });
});

test('protected booking routes redirect to sign-in without a session', async ({ page }) => {
  for (const path of ['/app/purchase', '/app/purchase/f0000000-0000-4000-8000-000000000001', '/app/admin/bookings']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
  }
});

test('reduced motion turns the dialog animation off', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/preview/booking-confirm-dialog');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const duration = await dialog.evaluate((el) => getComputedStyle(el).animationDuration);
  expect(['0s', '0ms']).toContain(duration);
  await context.close();
});

test.describe('review findings (contract §12 A4)', () => {
  test('readers who may not see proof are told it is hidden, never that none was uploaded (re-review M-NEW-1)', async ({ page }) => {
    await page.goto('/preview/booking-confirmed-proof-hidden');
    const panel = page.locator('#hotel-booking');
    await expect(panel).toContainText('Proof files are only visible to the Sales owner, assigned Sales and the branch Sales Manager.');
    await expect(panel).not.toContainText('No proof uploaded yet.');
  });

  test('a definite refusal clears the "just confirmed" mark (re-review follow-up)', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => sessionStorage.setItem('tn-booking-confirm-submitted', 'd0000000-0000-4000-8000-000000000001'));
    await page.goto('/preview/booking-confirm-conflict');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('tn-booking-confirm-submitted'))).toBeNull();
  });

  test('the confirm success text is not shown to later visitors (re-review L-d)', async ({ page }) => {
    await page.goto('/preview/booking-confirmed');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#hotel-booking')).not.toContainText('Booking details confirmed and a Purchase task was created');
  });

  test('after a confirm submitted in this browser, success is announced and focus moves to the panel heading', async ({ page }) => {
    // The preview cannot run the server action, so this sets the flag the confirm form writes on submit.
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => sessionStorage.setItem('tn-booking-confirm-submitted', 'd0000000-0000-4000-8000-000000000001'));
    await page.goto('/preview/booking-confirmed');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Hotel booking', exact: true })).toBeFocused();
    await expect(page.locator('#hotel-booking').getByRole('status').filter({ hasText: 'Booking details confirmed' })).toHaveText(
      'Booking details confirmed and a Purchase task was created. The hotel is not booked yet.',
    );
    expect(await page.evaluate(() => sessionStorage.getItem('tn-booking-confirm-submitted'))).toBeNull();
  });

  test('the confirm form records the submit for focus handling (keyboard)', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    // Stop the real action request: the preview has no session.
    await page.route('**/preview/booking-draft-ready', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.continue(),
    );
    await page.getByRole('button', { name: 'Review and confirm' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Confirm and create Purchase task' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('tn-booking-confirm-submitted')))
      .toBe('d0000000-0000-4000-8000-000000000001');
  });

  test('draft panels have an empty status region (no success text)', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await expect(page.locator('#hotel-booking')).not.toContainText('Purchase task was created');
  });

  test('ask-owner issue is listed as text for viewers without the selling field', async ({ page }) => {
    await page.goto('/preview/booking-draft-ask-owner');
    const repair = page.getByRole('region', { name: 'Before you can confirm' });
    await expect(repair).toContainText('The deal owner still needs to add the booking total agreed with the customer.');
    await expect(repair.getByRole('link')).toHaveCount(0);
    await expect(page.getByLabel('Booking total agreed with the customer')).toHaveCount(0);
  });

  test('Sales/manager queue view does not invite them to take tasks', async ({ page }) => {
    await page.goto('/preview/purchase-queue-sales-view');
    const main = page.locator('main');
    await expect(main).toContainText('Purchase colleagues take these tasks. You can follow progress here.');
    await expect(main).not.toContainText(/take it/i);
    await expect(page.getByRole('button', { name: 'Take this task' })).toHaveCount(0);
  });

  test('unexpected failures do not claim nothing was saved', async ({ page }) => {
    for (const state of ['booking-draft-ready', 'booking-unavailable', 'purchase-task-open']) {
      await page.goto(`/preview/${state}`);
      await expect(page.locator('main')).not.toContainText(/Nothing new was saved/i);
    }
  });
});

test.describe('Phase 3.5: who acts next', () => {
  const cases: Array<[string, string, string]> = [
    ['booking-none', 'Sales', 'Add hotel details and customer proof'],
    ['booking-draft-needs-repair', 'Sales', 'Add hotel details and customer proof'],
    ['booking-draft-ready', 'Sales Manager', 'Confirm and create the Purchase task'],
    ['booking-gate-off-ready', 'Sales Manager', 'Confirm and create the Purchase task'],
    ['booking-confirmed', 'Purchase', 'Take the task and arrange the hotel'],
  ];
  // Batch 4 (DA-272): the Purchase task page shows one "Next:" line under the header instead of the hand-off track.
  for (const [state, next] of [
    ['purchase-task-open', 'Next: take this task'],
    ['purchase-task-mine', 'Next: record the supplier’s confirmation'],
  ] as const) {
    test(`Purchase task: one Next line names the current step: ${state}`, async ({ page }) => {
      await page.goto(`/preview/${state}`);
      await expect(page.locator('main [data-slot="task-next"]')).toHaveCount(1);
      await expect(page.locator('main [data-slot="task-next"]')).toContainText(next);
    });
  }
  for (const [state, role, current] of cases) {
    test(`hand-off track marks the current step: ${state}`, async ({ page }) => {
      await page.goto(`/preview/${state}`);
      const track = page.getByRole('list', { name: /hand-offs/ });
      const step = track.locator('li[aria-current="step"]');
      await expect(step).toHaveCount(1);
      await expect(step).toContainText(current);
      await expect(step).toContainText(role);
      await expect(step.locator('.handoff-state')).toHaveText(/^(Now|Blocked):$/);
    });
  }

  test('the gate-off step is "Blocked" and names the admin as the next actor', async ({ page }) => {
    await page.goto('/preview/booking-gate-off-ready');
    const step = page.locator('li[aria-current="step"]');
    await expect(step).toContainText('Blocked:');
    await expect(step).toContainText('Waiting for an admin');
    const nextStep = page.locator('#hotel-booking [data-slot="next-line"]');
    await expect(nextStep.locator('.role-tag', { hasText: 'Admin' })).toBeVisible();
    await expect(nextStep).toContainText('An admin');
    await expect(page.getByRole('button', { name: 'Review and confirm' })).toHaveCount(0);
  });

  test('who acts next carries a role chip on booking, Purchase and health screens', async ({ page }) => {
    // Hotel booking panel: one Next line (copy G-18) that still names the actor with a role chip.
    for (const [state, role] of [
      ['booking-draft-ready', 'Sales Manager'],
      ['booking-confirmed-taken', 'Purchase'],
    ] as const) {
      await page.goto(`/preview/${state}`);
      await expect(page.locator('#hotel-booking [data-slot="next-line"] .role-tag', { hasText: role }), state).toBeVisible();
    }
    // Batch 4 (G-18, DA-262, DA-272, DA-273): Purchase list, Purchase task and System health say who acts in words.
    // Echo-B L3: the queue names who records the confirmation and shows who took each task.
    await page.goto('/preview/purchase-queue');
    await expect(page.locator('main')).toContainText('Each counts as booked only after you record the supplier’s confirmation.');
    await expect(page.locator('main').getByRole('columnheader', { name: 'Taken by' })).toBeVisible();
    // An open task: Purchase takes it; the header says nobody has taken it yet.
    await page.goto('/preview/purchase-task-open');
    await expect(page.locator('main [data-slot="task-next"]')).toContainText('Next: take this task');
    await expect(page.locator('main')).toContainText('Taken by: Not taken yet');
    await page.goto('/preview/purchase-task-mine');
    await expect(page.locator('main [data-slot="task-next"]')).toContainText('Next: record the supplier’s confirmation');
    await page.goto('/preview/booking-health-off');
    await expect(page.locator('main [data-slot="health-next"]')).toContainText('Next: nothing here. Real bookings are switched on by the CRM team with the owner’s approval.');
    await page.goto('/preview/booking-confirmed-taken');
    await expect(page.locator('#hotel-booking [data-slot="next-line"]')).toContainText('Synthetic Purchase Jodhpur');
  });
});

test.describe('Phase 3.5: deal selling price vs booking total', () => {
  test('the deal value (Money tab) and the booking (Services and tasks tab) use different names, and each says which number it is', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await expect(page.locator('summary', { hasText: 'Money for this booking' })).toContainText('Booking total ₹52000.00');
    await expect(page.locator('#hotel-booking')).not.toContainText(/Deal selling price|Deal value/);
    await page.goto('/preview/booking-draft-ready-money');
    const dealPrice = page.getByRole('region', { name: 'Deal value (test record only)' });
    await expect(dealPrice).toContainText('Test figures. No tax is calculated here.');
    await expect(dealPrice).toContainText('₹1,23,456.00');
  });

  test('an imported Bitrix deal never shows an invented deal value (deal values exist on test records only)', async ({ page }) => {
    await page.goto('/preview/deal-detail-bitrix-money');
    await expect(page.getByRole('region', { name: 'Money' })).toContainText('No money recorded on this deal yet.');
    await expect(page.getByRole('region', { name: /Deal value/ })).toHaveCount(0);
  });
});

test.describe('Phase 3.5: not recorded vs hidden for your role', () => {
  test('deal price: withheld for Purchase (no Money tab at all), not recorded for a permitted viewer', async ({ page }) => {
    await page.goto('/preview/deal-detail-purchase');
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Money' })).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/Not recorded yet|₹/);
    await page.goto('/preview/deal-detail-commercial-not-recorded-money');
    // Not recorded is never shown as hidden: the Money tab says nothing is recorded yet.
    const missing = page.getByRole('region', { name: 'Money' });
    await expect(missing).toContainText('No money recorded on this deal yet.');
    await expect(missing).not.toContainText('Hidden for your role');
  });

  test('read-only booking reader: missing facts are "not recorded", money and proof are "hidden"', async ({ page }) => {
    await page.goto('/preview/booking-draft-read-only');
    const panel = page.locator('#hotel-booking');
    await expect(panel.getByRole('region', { name: 'Stay' })).toContainText('Not recorded yet');
    const money = panel.getByRole('region', { name: 'Money for this booking' });
    await expect(money).toContainText('₹45,000.00');
    await expect(money).toContainText('Hidden for your role');
    const proof = panel.getByRole('region', { name: 'Proof the customer accepted' });
    await expect(proof).toContainText('Hidden for your role');
    await expect(proof).not.toContainText('No proof uploaded yet.');
    // Read-only viewers have no fields, so the repair list is plain text.
    await expect(panel.getByRole('region', { name: 'Before you can confirm' }).getByRole('link')).toHaveCount(0);
  });

  test('a booking total that is not set reads "not recorded", never "hidden"', async ({ page }) => {
    await page.goto('/preview/booking-confirmed');
    await expect(page.getByRole('region', { name: 'Money for this booking' })).toContainText('₹52,000.00');
    await page.goto('/preview/booking-draft-needs-repair');
    await expect(page.getByLabel('Booking total agreed with the customer')).toHaveValue('');
    await expect(page.locator('#hotel-booking')).not.toContainText('Hidden for your role');
  });
});

test.describe('Phase 3.5: long booking form on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('sections show status words; finished sections fold with a recap', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    const stay = page.locator('details.form-section', { has: page.locator('summary', { hasText: 'Stay' }) });
    await expect(stay).not.toHaveAttribute('open');
    await expect(stay.locator('summary')).toContainText('Done');
    await expect(stay.locator('summary')).toContainText('Synthetic Lakeside Hotel, Udaipur · 14 Nov → 17 Nov');
    await page.goto('/preview/booking-draft-needs-repair');
    await page.waitForLoadState('networkidle');
    const needs = page.locator('details.form-section', { has: page.locator('summary', { hasText: 'Rooms and travellers' }) });
    await expect(needs).toHaveAttribute('open');
    await expect(needs.locator('summary')).toContainText('1 to add');
    await expect(page.locator('details.form-section', { has: page.locator('summary', { hasText: 'Notes for Purchase' }) })).toHaveAttribute('open');
  });

  test('keyboard: Enter on a section summary opens it and the fields follow in order', async ({ page }) => {
    await page.goto('/preview/booking-draft-ready');
    await page.waitForLoadState('networkidle');
    const summary = page.locator('summary', { hasText: 'Stay' });
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Hotel name')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Hotel name')).toBeFocused();
  });

  test('a repair link opens a folded section and focuses the field', async ({ page }) => {
    await page.goto('/preview/booking-draft-needs-repair');
    await page.waitForLoadState('networkidle');
    await page.locator('summary', { hasText: 'Stay' }).click(); // fold it first
    await page.getByRole('link', { name: 'Add the city.' }).click();
    await expect(page.getByLabel('City')).toBeFocused();
    await expect(page.getByLabel('City')).toBeVisible();
  });

  test('the save bar stays on screen while scrolling the form, and inputs use phone keyboards', async ({ page }) => {
    await page.goto('/preview/booking-draft-needs-repair');
    await page.waitForLoadState('networkidle');
    const bar = page.locator('.sticky-actions');
    await expect(bar).toHaveCSS('position', 'sticky');
    await page.getByLabel('Rooms', { exact: true }).scrollIntoViewIfNeeded();
    const box = await bar.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(844 + 1);
    await expect(bar.getByRole('button', { name: 'Save booking details' })).toBeInViewport();
    await expect(page.getByLabel('Rooms', { exact: true })).toHaveAttribute('inputmode', 'numeric');
    await expect(page.getByLabel('Approved Purchase budget')).toHaveAttribute('inputmode', 'decimal');
    await expect(page.getByLabel('Hotel name')).toHaveAttribute('autocapitalize', 'words');
  });

  test('typing announces unsaved changes once through a status region', async ({ page }) => {
    await page.goto('/preview/booking-draft-needs-repair');
    await page.waitForLoadState('networkidle');
    const status = page.locator('.sticky-actions [role="status"]');
    await expect(status).toHaveText('Saving keeps this as a draft. Nothing is confirmed.');
    await page.getByLabel('City').fill('Jaipur');
    await expect(status).toHaveText('You have unsaved changes.');
  });
});

test.describe('Phase 3.5: compact staff header and nav on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // App frame (Direction A R0, 19 October 2026): on a phone the menu groups and the
  // account panel (name, roles, My access, sign-out) are in the "Menu" sheet.
  test('header is one compact row; sign-out and every section stay reachable', async ({ page }) => {
    await page.goto('/preview/booking-health-off');
    await page.waitForLoadState('networkidle');
    const header = page.getByRole('banner');
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(110);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const nav = dialog.getByRole('navigation', { name: 'Main' });
    // The current page is marked and visible in the menu.
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toBeInViewport({ ratio: 1 });
    const signOut = dialog.getByRole('button', { name: 'Sign out of this device' });
    await signOut.scrollIntoViewIfNeeded();
    await expect(signOut).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page);
  });

  test('keyboard reaches every nav link and the sign-out options', async ({ page }) => {
    await page.goto('/preview/booking-health-off');
    await page.waitForLoadState('networkidle');
    const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
    await menuButton.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    const nav = dialog.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Home' })).toBeFocused();
    for (const name of ['Deals', 'Settings']) {
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('link', { name })).toBeFocused();
    }
    // Then the account panel: My access, Sign out, and the sign-out options behind a second step.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('link', { name: 'My access' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Sign out of this device' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Sign out everywhere' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Sign out everywhere' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Sign out everywhere' })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(menuButton).toBeFocused();
  });
});

test.describe('Phase 3.5: states', () => {
  test('loading announces politely and shows a calm placeholder', async ({ page }) => {
    // The deal page loading state (src/app/app/deals/[id]/loading.tsx), Lagoon skeleton.
    await page.goto('/preview/booking-loading');
    await expect(page.locator('main').getByRole('status')).toHaveText('Loading deal…');
    await expect(page.locator('main [data-slot="skeleton"]').first()).toHaveAttribute('aria-hidden', 'true');
  });

  test('error, conflict and disabled-gate states use alert or note roles with words', async ({ page }) => {
    await page.goto('/preview/booking-unavailable');
    await expect(page.locator('#hotel-booking, main').getByText('The hotel booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.')).toBeVisible();
    await page.goto('/preview/booking-save-conflict');
    await expect(page.locator('main').getByRole('alert')).toContainText('Nothing was confirmed');
    await page.goto('/preview/booking-gate-off');
    await expect(page.locator('main').getByRole('note').filter({ hasText: 'Confirmation is blocked.' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/turn (it )?on|enable real booking/i);
    await expect(page.locator('main').getByRole('button', { name: /real booking/i })).toHaveCount(0);
  });

  test('booking health never offers a control that could turn real booking on', async ({ page }) => {
    for (const state of ['booking-health-off', 'booking-health-on', 'booking-health-environment-unset']) {
      await page.goto(`/preview/${state}`);
      const main = page.locator('main');
      await expect(main.getByRole('button')).toHaveCount(0);
      await expect(main.getByRole('checkbox')).toHaveCount(0);
      await expect(main.locator('form')).toHaveCount(0);
    }
  });

  test('headings: one h1 per screen and the panel sections are labelled regions', async ({ page }) => {
    for (const state of ['booking-draft-ready', 'booking-confirmed', 'purchase-task-open', 'purchase-queue', 'booking-health-off']) {
      await page.goto(`/preview/${state}`);
      await expect(page.getByRole('heading', { level: 1 }), state).toHaveCount(1);
    }
    await page.goto('/preview/booking-draft-ready');
    await expect(page.getByRole('region', { name: 'Hotel booking', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Before you can confirm' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Proof the customer accepted' })).toBeVisible();
  });
});
