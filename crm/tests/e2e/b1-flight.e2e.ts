import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * B1 Flight queue and task, Purchase facts per service type, and the admin
 * workflow switches, through the design preview states (synthetic props).
 *
 * Flight build (contract 4 Nov 2026) updates, each marked "Flight build":
 * the queue is grouped per Deal with the columns of contract 11.1; the
 * primary action is "Take these flights"; flight status words are Waiting /
 * In progress · x of y tickets / All tickets confirmed / Done · ticket issued
 * (D10 supersedes DEC-59, so "Confirmed by supplier" must be gone); traveller
 * names are shown to Flight (D7 retires F-04); the conflict text is the
 * frozen task_conflict message. Assertions that still hold are kept.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FLIGHT_STATES = [
  'flight-queue',
  'flight-queue-empty',
  'flight-queue-loading',
  'flight-task-open',
  'flight-task-mine',
  'flight-task-claim-conflict',
  'flight-task-issued',
  'flight-task-not-found',
];
const PURCHASE_STATES = ['purchase-queue-mixed', 'purchase-task-transfer', 'purchase-task-activity'];
const WORKFLOW_STATES = ['admin-workflow-off', 'admin-workflow-on', 'admin-workflow-refused', 'admin-workflow-changed', 'admin-workflow-no-permission', 'admin-workflow-unavailable'];
const ALL = [...FLIGHT_STATES, ...PURCHASE_STATES, ...WORKFLOW_STATES];

async function axe(page: Page) {
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

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

test.describe('B1 Flight, Purchase facts and workflow: accessibility', () => {
  for (const state of ALL) {
    test(`axe clean at 1440 and 390; one h1; no sideways scroll at 390 and 200% zoom: ${state}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
      await page.setViewportSize({ width: 640, height: 400 });
      await open(page, state);
      await noHorizontalScroll(page);
    });
  }
});

test.describe('B1 Flight queue', () => {
  test('queue: internal-task note, table with status pills, no selling value or proof', async ({ page }) => {
    await open(page, 'flight-queue');
    const main = page.locator('main');
    // Flight build (11.1): the old note ("Issue each ticket outside the CRM, then record the fare on the task.") is retired
    // with the per-task queue; the grouped queue says one row per Deal and the group take.
    await expect(main).toContainText('One row per Deal. Taking a Deal takes all its flights.');
    await expect(main).toContainText('Customer prices and proof files are never shown here.');
    await expect(main).not.toContainText(/Selling/i);
    await expect(main).not.toContainText(/synthetic-acceptance|\.pdf|Download/i);
    await expect(main).not.toContainText('₹1,84,000');
    // Flight build (11.1): one row per Deal; the caption counts flight rows (wording not frozen).
    const table = page.getByRole('table', { name: /flight/i });
    await expect(table.getByRole('columnheader')).toHaveText(['Route', 'Flights', 'Travellers', 'Approved budget', 'Status', 'Taken by', 'Deal']);
    // Flight build: the new grouped-queue fixture (Track C) carries an approved budget of ₹18,000.00 and a "Budget not set" row.
    await expect(table).toContainText('₹18,000.00');
    await expect(table).toContainText('Budget not set');
    // Flight build (D10 supersedes DEC-59): no "Confirmed by supplier" for flights; the old "ticket not recorded" wording is gone.
    await expect(table).not.toContainText('Confirmed by supplier');
    await expect(table).not.toContainText('Ticket issued');
    await expect(table).not.toContainText('ticket not recorded in the CRM');
    await expect(table).toContainText(/In progress · \d+ of \d+ tickets|Waiting|All tickets confirmed|Done · ticket issued/);
    for (const pill of await table.locator('[data-slot="status-badge"]').all()) {
      await expect(pill.locator('svg')).toHaveCount(1);
    }
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Flight tasks' })).toHaveAttribute('aria-current', 'page');
    // Batch 4: Not taken · Mine · All link tabs over the same rows (counts from the rows on the page).
    const filters = page.getByRole('navigation', { name: 'Flight task filters' });
    // Flight build: the new fixture has two Deals not taken; the queue opens on Not taken (as Purchase and the prototype do).
    await expect(filters.getByRole('link', { name: /^Not taken/ })).toContainText('2');
    await expect(filters.getByRole('link', { name: /^Not taken/ })).toHaveAttribute('aria-current', 'page');
  });

  test('empty queue says the right thing', async ({ page }) => {
    await open(page, 'flight-queue-empty');
    await expect(page.locator('main').getByRole('status')).toContainText('Tasks appear after Sales submits a booking with a flight.');
  });

  test('task page: one primary "Take these flights", facts, no booked claim; conflict and issued states', async ({ page }) => {
    await open(page, 'flight-task-open');
    const main = page.locator('main');
    // Flight build (11.1): the group take is "Take these flights".
    const take = main.getByRole('button', { name: 'Take these flights' });
    await expect(take).toHaveCount(1);
    await expect(main.getByRole('button', { name: 'Take this task' })).toHaveCount(0);
    await expect(take).toHaveAccessibleDescription(/does not issue a ticket/);
    const box = await take.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await expect(main).toContainText('Internal task. Tickets are issued outside the CRM.');
    // Flight build: the old "DEL → IXZ" B1 fixture is retired; flight-task-open is now the new workspace (not taken).
    await expect(main).toContainText('JDH → BOM → GOI');
    // Flight build (D7): real traveller names are shown to Flight; the F-04 sentence is retired.
    await expect(main).not.toContainText('Traveller names are not shown to the Flight team in this version.');
    await expect(main).not.toContainText(/Selling/i);
    await open(page, 'flight-task-claim-conflict');
    // Flight build (6.3): the new workspace shows the frozen task_conflict message after the take is refused (the
    // preview action answers task_conflict), instead of rendering the alert up front.
    await page.locator('main').getByRole('button', { name: 'Take these flights' }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Another Flight colleague took these flights first.');
    await open(page, 'flight-task-issued');
    // Flight build (D10): done reads "Done · ticket issued"; DEC-59's supplier-confirmation wording is gone.
    await expect(page.locator('main')).toContainText('Done · ticket issued');
    await expect(page.locator('main')).not.toContainText('Confirmed by supplier');
    await expect(page.locator('main')).not.toContainText('Supplier confirmation recorded');
    await expect(page.locator('main')).toContainText('Nothing waiting.');
    // The old "No payment, bill or invoice was created by the CRM." line no longer holds (D2: flight payments are recorded in the CRM).
    await expect(page.locator('main')).not.toContainText('costs are locked');
    await open(page, 'flight-task-not-found');
    // Flight build (6.3): the workspace's not-found state uses the frozen not_found message.
    await expect(page.locator('main').getByRole('status')).toContainText('This item is no longer available. Reload the page.');
  });

  test('Flight nav link only for Flight viewers', async ({ page }) => {
    await open(page, 'flight-queue');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Flight tasks' })).toHaveCount(1);
    await open(page, 'purchase-queue-mixed');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Flight tasks' })).toHaveCount(0);
  });
});

test.describe('B1 Purchase: service type and facts per type', () => {
  test('queue shows a service column with the type pill and the title; no selling value', async ({ page }) => {
    await open(page, 'purchase-queue-mixed');
    const main = page.locator('main');
    const table = page.getByRole('table', { name: '3 tasks' });
    await expect(table.locator('th').first()).toHaveText('Service');
    await expect(table).toContainText('Transfer or cab');
    await expect(table).toContainText('Activity');
    await expect(table).toContainText('Airport to jetty, both ways');
    await expect(table).toContainText('Not a hotel');
    await expect(main).not.toContainText(/Selling/i);
    await expect(main).not.toContainText('₹1,84,000');
  });

  test('transfer and activity tasks show their own facts block, never hotel fields', async ({ page }) => {
    await open(page, 'purchase-task-transfer');
    const main = page.locator('main');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Airport to jetty, both ways');
    await expect(main).toContainText('Transfer or cab task');
    const facts = page.getByRole('region', { name: 'Transfer or cab details' });
    await expect(facts).toContainText('Route');
    await expect(facts).toContainText('Pick-up time');
    await expect(facts).toContainText('10:30');
    await expect(main).not.toContainText('Check-in');
    await expect(main).not.toContainText(/Selling/i);
    await open(page, 'purchase-task-activity');
    await expect(page.getByRole('region', { name: 'Activity details' })).toContainText('Synthetic scuba trial dive');
    await expect(page.getByRole('region', { name: 'Activity details' })).toContainText('Both are first-time divers.');
    await expect(page.locator('main')).toContainText('Approved budget');
    // A budget never entered (stored as 0) is not an approved ₹0.00.
    await expect(page.getByRole('region', { name: 'Travellers and budget' })).toContainText('Budget not set');
    await expect(page.locator('main')).not.toContainText('₹0.00');
    await open(page, 'purchase-queue-mixed');
    await expect(page.getByRole('table', { name: '3 tasks' })).toContainText('Budget not set');
    await expect(page.getByRole('table', { name: '3 tasks' })).not.toContainText('₹0.00');
  });

  test('the legacy hotel task and queue are unchanged (existing states still pass their words)', async ({ page }) => {
    await open(page, 'purchase-queue');
    await expect(page.getByRole('table', { name: '3 hotel tasks' })).toContainText('₹45,000.00');
    await open(page, 'purchase-task-open');
    await expect(page.getByRole('region', { name: 'Stay' })).toContainText('Check-in');
    await expect(page.locator('main')).toContainText('Internal task — the hotel is not booked yet.');
  });
});

test.describe('B1 admin workflow switches (Batch 4: Settings · Features)', () => {
  test('every switch named, state in words, the approval line once per page, reason required before the review', async ({ page }) => {
    await open(page, 'admin-workflow-off');
    const main = page.locator('main');
    await expect(main).toContainText('Changes here affect every branch. Live changes need the owner’s APPROVE first; write it in the reason.');
    await expect(main).not.toContainText('off by default');
    // DEC-54: no text claims that switching off restores the previous behaviour.
    await expect(main).not.toContainText('restores the previous behaviour');
    const rows = page.locator('#feature-switches [data-slot="setting-row"]');
    await expect(rows).toHaveText([/Book now \(service list\)/, /Count of won deals with no booking \(on Home\)/, /Visa and passport tasks/, /Fill new bookings and quotations from Bitrix/, /Referral drafts/]);
    for (const key of ['service_items_enabled', 'intake_prompt_enabled']) {
      const row = page.locator(`[data-slot="setting-row"][data-key="${key}"]`);
      await expect(row).toContainText('current state: Off');
      await row.getByRole('button', { name: /^Change / }).click();
      const form = row.getByRole('form');
      await expect(form.getByRole('radio', { name: 'On' })).toBeChecked();
      await expect(form.getByLabel('Why are you changing it?')).toHaveAccessibleDescription(/10 to 500 characters/);
      await form.getByRole('button', { name: 'Review change' }).click();
      await expect(form.getByLabel('Why are you changing it?')).toHaveAttribute('aria-invalid', 'true');
      await expect(form.getByRole('button', { name: /^Turn / })).toHaveCount(0);
    }
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Features' })).toHaveAttribute('aria-current', 'page');
  });

  test('a refused change keeps the choice and the typed reason; a saved change is announced', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'admin-workflow-refused');
    const row = page.locator('[data-slot="setting-row"][data-key="service_items_enabled"]');
    await row.getByRole('button', { name: 'Change Book now (service list)' }).click();
    const form = row.getByRole('form');
    await form.getByLabel('Why are you changing it?').fill('Owner approved the pilot (synthetic).');
    await form.getByRole('button', { name: 'Review change' }).click();
    await form.getByRole('button', { name: 'Turn Book now (service list) on' }).click();
    await expect(row.getByRole('alert')).toContainText('Only a Super Admin can change this. Nothing was changed.');
    await expect(form).toContainText('Reason: “Owner approved the pilot (synthetic).”');
    await form.getByRole('button', { name: 'Go back' }).click();
    await expect(form.getByRole('radio', { name: 'On' })).toBeChecked();
    await expect(form.getByLabel('Why are you changing it?')).toHaveValue('Owner approved the pilot (synthetic).');
    await open(page, 'admin-workflow-changed');
    const count = page.locator('[data-slot="setting-row"][data-key="intake_prompt_enabled"]');
    await expect(count).toContainText('current state: On');
    await count.getByRole('button', { name: /^Change / }).click();
    await count.getByLabel('Why are you changing it?').fill('Owner approved hiding the count (synthetic).');
    await count.getByRole('button', { name: 'Review change' }).click();
    await count.getByRole('button', { name: 'Turn Count of won deals with no booking (on Home) off' }).click();
    await expect(count.getByRole('status')).toContainText('is now off. Recorded with your name and reason.');
  });

  test('no permission and unavailable states never look like "off"', async ({ page }) => {
    await open(page, 'admin-workflow-no-permission');
    await expect(page.locator('main').getByRole('status')).toContainText('Only a Super Admin or staff who manage the Bitrix connection can open Features.');
    await expect(page.locator('main').getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await open(page, 'admin-workflow-unavailable');
    await expect(page.locator('main')).toContainText('Nothing is assumed on or off.');
    // Echo-B L1: an unreadable page shows no switch state at all (no On, no Off) and no rows.
    await expect(page.locator('main')).not.toContainText(/current state: (On|Off)/i);
    await expect(page.locator('main [data-slot="setting-row"]')).toHaveCount(0);
  });
});

test.describe('B1 Flight and workflow: production style policy', () => {
  test('every state renders with zero CSP violations and no server-rendered style attributes', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => ALL.some((s) => url.pathname === `/preview/${s}`));
    const { violations } = await trackViolations(context);
    const page = await context.newPage();
    for (const state of ALL) {
      await open(page, state);
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html.match(/<[a-z][^>]*\sstyle="/gi), `${state}: server-rendered style attributes`).toBeNull();
    }
    expect(violations).toEqual([]);
    await context.close();
  });
});
