import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * B1 intake screen (SCR-INTAKE) and the Deal page services card, through the
 * design preview states (synthetic props; the gallery's stand-in actions).
 * Visual and interaction evidence only: the real journey needs the real-stack
 * suite (b1-journey.real.test.ts).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const INTAKE_STATES = [
  'intake-synced-only',
  'intake-partially-filled',
  'intake-ready',
  'intake-confirm-dialog',
  'intake-confirm-conflict',
  'intake-created',
  'intake-stage-not-confirmed',
  'intake-refused',
  'intake-assignee',
  'intake-read-only',
  'intake-deal-not-active',
  'intake-no-bitrix-stage',
  'intake-no-version',
  'intake-disabled',
  'intake-not-visible',
  'intake-loading',
];
const DEAL_STATES = ['deal-services-planned', 'deal-services-active', 'deal-services-legacy-hotel', 'deal-services-purchase', 'deal-services-unavailable'];
const ALL = [...INTAKE_STATES, ...DEAL_STATES];

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

test.describe('B1 intake and services: accessibility', () => {
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

test.describe('B1 intake: structure and wording', () => {
  test('status, stage, owner and next step at the top; one primary action when ready', async ({ page }) => {
    await open(page, 'intake-ready');
    const main = page.locator('main');
    await expect(main).toContainText('Intake status: Draft · ready to save · version 1');
    await expect(main).toContainText('Bitrix stage: Won - Payment Received · tasks can start');
    await expect(main).toContainText('Owner: You');
    await expect(main).toContainText('Who acts next');
    await expect(main).toContainText('That creates 4 internal tasks.');
    await expect(main.getByRole('button', { name: 'Review and save the accepted version' })).toHaveCount(1);
    // Every status pill carries an icon and a word.
    const pills = main.locator('[data-slot="status-badge"]');
    expect(await pills.count()).toBeGreaterThan(3);
    for (const pill of await pills.all()) {
      await expect(pill.locator('svg')).toHaveCount(1);
      expect((await pill.innerText()).trim().length).toBeGreaterThan(0);
    }
    await expect(main.locator('[data-slot="service-type-pill"]')).toHaveCount(4);
  });

  test('the four sections exist and the source badge says the facts were typed in the CRM', async ({ page }) => {
    await open(page, 'intake-ready');
    for (const name of ['What Bitrix sent', 'Travellers', 'Services sold', 'Before tasks can be created', 'Proof the customer accepted']) {
      await expect(page.getByRole('region', { name }), name).toBeVisible();
    }
    await expect(page.getByRole('region', { name: 'What Bitrix sent' })).toContainText('Typed in the CRM');
    await expect(page.getByRole('region', { name: 'Travellers' })).toContainText('The services need 2 travellers.');
    await expect(page.getByRole('region', { name: 'Services sold' })).toContainText('Service 4');
  });

  test('no draft yet: one primary action "Start the intake draft" and the next step says so', async ({ page }) => {
    await open(page, 'intake-no-version');
    const main = page.locator('main');
    await expect(main.getByRole('button', { name: 'Start the intake draft' })).toHaveCount(1);
    await expect(main).toContainText('Start the intake draft, then add the travellers and the sold services.');
    await expect(main.getByRole('button', { name: /Save accepted version/ })).toHaveCount(0);
  });

  test('synced-only: nothing typed yet, two blocking items, no primary action', async ({ page }) => {
    await open(page, 'intake-synced-only');
    const main = page.locator('main');
    await expect(main).toContainText('Not started · no services yet');
    await expect(page.getByRole('region', { name: 'Before tasks can be created' })).toContainText('Blocking: Add at least one service that was sold.');
    await expect(page.getByRole('region', { name: 'Before tasks can be created' })).toContainText('Blocking: Upload the customer’s acceptance message.');
    await expect(main.getByRole('button', { name: 'Review and save the accepted version' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Services sold' })).toContainText('No services yet');
  });

  test('partially filled: blocking vs check items with owner, numbered services', async ({ page }) => {
    await open(page, 'intake-partially-filled');
    const checklist = page.getByRole('region', { name: 'Before tasks can be created' });
    await expect(checklist).toContainText('1 blocking');
    await expect(checklist).toContainText('Blocking: The services need more travellers than you’ve listed.');
    await expect(checklist).toContainText('Check: A service date is more than a day outside the other services’ dates. Check it. (service 2)');
    await expect(checklist).toContainText('Check: Visa, passport or train is mentioned. Those are on hold: no CRM task is created for them.');
    await expect(checklist).toContainText('Sales fixes this');
    await expect(page.locator('main')).toContainText('Draft · needs details');
  });

  test('stage not reached: Bitrix owns the fix and tasks wait', async ({ page }) => {
    await open(page, 'intake-stage-not-confirmed');
    await expect(page.locator('main')).toContainText('Quote sent · waiting for “Won - Payment Received”');
    const checklist = page.getByRole('region', { name: 'Before tasks can be created' });
    await expect(checklist).toContainText('Bitrix hasn’t marked this Deal "Won - Payment Received" yet.');
    await expect(checklist).toContainText('Bitrix (stage)');
  });

  test('created: items are active with task links; nothing is called booked', async ({ page }) => {
    await open(page, 'intake-created');
    const main = page.locator('main');
    await expect(main).toContainText('Accepted version saved · tasks created');
    await expect(main).toContainText('1 of 4 confirmed · 1 in progress · 2 not started');
    await expect(main.getByRole('link', { name: 'Open Purchase task' })).toHaveCount(3);
    await expect(main.getByRole('link', { name: 'Open Flight task' })).toHaveCount(1);
    // Review E11: the "nothing was created twice" sentence belongs to a repeated press, not to the standing note.
    await expect(main).not.toContainText('Nothing was created twice.');
    await expect(main).toContainText('This booking is already confirmed.');
    await expect(main.getByRole('button', { name: 'Review and save the accepted version' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Save travellers' })).toHaveCount(0);
    const text = (await main.innerText()).replace(/not booked yet|nothing is booked|Nothing is booked/gi, '');
    expect(text).not.toMatch(/\bhotel is booked\b|\bflight is booked\b/i);
  });

  test('on-hold service types are listed but disabled, with the on-hold text', async ({ page }) => {
    await open(page, 'intake-ready');
    const add = page.getByRole('form', { name: 'Add a service' });
    const select = add.getByLabel('What was sold?');
    // B1.1: visa and passport are real service types now; only Train stays on hold (deferred).
    await expect(select).toHaveAccessibleDescription(/Train isn’t handled in the CRM yet/);
    const train = select.locator('option', { hasText: 'Train' });
    await expect(train).toHaveCount(1);
    await expect(train).toBeDisabled();
    await expect(train).toContainText('on hold · not handled in the CRM yet');
    await select.selectOption('transfer');
    await expect(add.getByLabel('Route')).toBeVisible();
    await expect(add.getByLabel('Pick-up time')).toHaveAttribute('type', 'time');
    await select.selectOption('flight');
    await expect(add.getByLabel('From (airport code) · segment 1')).toBeVisible();
    await add.getByRole('button', { name: 'Add a segment' }).click();
    await expect(add.getByLabel('To (airport code) · segment 2')).toBeVisible();
  });

  test('assignee may edit but not confirm; reader sees facts only and proof hidden', async ({ page }) => {
    await open(page, 'intake-assignee');
    const main = page.locator('main');
    await expect(main).toContainText('You can’t do this on this deal. The deal owner or a Sales Manager for this branch can.');
    await expect(main.getByRole('button', { name: 'Review and save the accepted version' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Save travellers' })).toHaveCount(1);
    await open(page, 'intake-read-only');
    await expect(page.locator('main').getByRole('button', { name: 'Save travellers' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Proof the customer accepted' })).toContainText('Hidden for your role');
    await expect(page.getByRole('region', { name: 'Proof the customer accepted' })).not.toContainText('No proof uploaded yet.');
    await expect(page.locator('main')).toContainText('You can read this intake.');
  });

  test('lost deal, disabled switch and not-visible states say so honestly', async ({ page }) => {
    await open(page, 'intake-deal-not-active');
    await expect(page.locator('main')).toContainText('This deal is marked lost or rejected in Bitrix.');
    await expect(page.locator('main')).toContainText('Bookings can’t be started on this deal while it is lost or rejected in Bitrix.');
    await expect(page.locator('main').getByRole('definition').first()).toHaveText('No one');
    await open(page, 'intake-disabled');
    await expect(page.locator('main').getByRole('status')).toContainText('Service items are switched off for this CRM. The hotel booking on the Deal page works as before.');
    await open(page, 'intake-not-visible');
    await expect(page.locator('main').getByRole('status')).toContainText('This deal does not exist, or it is not visible to you.');
    await expect(page.locator('main').getByRole('link', { name: 'Back to deals' })).toBeVisible();
  });

  test('loading announces once with one hidden h1', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'intake-loading');
    const main = page.locator('main');
    await expect(main.getByRole('status')).toHaveText('Loading intake…');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Confirmed booking intake');
    expect(await main.locator('[data-slot="skeleton"]').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
});

test.describe('B1 intake: forms keep typed work', () => {
  test('a refused save keeps the typed values and names the fields', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'intake-refused');
    // Initial refusal states already name the fields.
    const travellers = page.getByRole('form', { name: 'Travellers' });
    await expect(travellers.getByRole('alert')).toContainText('Some details aren’t valid.');
    // Type, submit to the gallery's refusing action, and the work stays.
    const name = travellers.getByLabel('Full name · traveller 1');
    await name.fill('Synthetic Changed Name');
    await travellers.getByRole('button', { name: 'Add a traveller' }).click();
    const second = travellers.getByLabel('Full name · traveller 3');
    await second.fill('');
    await travellers.getByRole('button', { name: 'Save travellers' }).click();
    await expect(travellers.getByRole('alert')).toContainText('Error: Some details aren’t valid. Check the highlighted fields.');
    await expect(name).toHaveValue('Synthetic Changed Name');
    await expect(travellers.getByRole('alert')).toContainText('Traveller 3: add the full name.');
    await expect(second).toHaveAttribute('aria-invalid', 'true');
    await expect(second).toHaveAccessibleDescription(/Traveller 3: add the full name\./);

    const add = page.getByRole('form', { name: 'Add a service' });
    await add.getByLabel('What was sold?').selectOption('activity');
    await add.getByLabel('Activity name').fill('Synthetic kayak trip');
    await add.getByLabel('Participants').fill('2');
    await add.getByRole('button', { name: 'Add this service' }).click();
    await expect(add.getByRole('alert')).toContainText('Check these fields:');
    await expect(add.getByRole('alert').getByRole('link', { name: 'Add city.' })).toBeVisible();
    await expect(add.getByRole('alert').getByRole('link', { name: 'Add date.' })).toBeVisible();
    await expect(add.getByLabel('Activity name')).toHaveValue('Synthetic kayak trip');
    await expect(add.getByLabel('City')).toHaveAttribute('aria-invalid', 'true');
    await add.getByRole('alert').getByRole('link', { name: 'Add city.' }).click();
    await expect(add.getByLabel('City')).toBeFocused();
  });

  test('a saved service keeps the draft words: nothing confirmed, nothing booked', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'intake-ready');
    const form = page.getByRole('form', { name: /^Service 2:/ });
    await form.getByLabel('Vehicle type').fill('Tempo traveller');
    await form.getByRole('button', { name: 'Save this service' }).click();
    await expect(form.getByRole('status').filter({ hasText: 'Done:' })).toContainText('The draft is not confirmed and nothing is booked.');
    await expect(form.getByLabel('Vehicle type')).toHaveValue('Tempo traveller');
  });
});

test.describe('B1 intake: keyboard path and confirm dialog', () => {
  test('Tab moves through a traveller row, then the dialog traps focus, explains N tasks, and Escape returns focus', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'intake-ready');
    const name = page.getByLabel('Full name · traveller 1');
    await name.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Type · traveller 1')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Remove traveller 1' })).toBeFocused();

    const trigger = page.getByRole('button', { name: 'Review and save the accepted version' });
    await trigger.focus();
    // Visible focus: the existing ConfirmDialog trigger keeps the legacy outline (at least 2px).
    expect(parseFloat(await trigger.evaluate((el) => getComputedStyle(el).outlineWidth))).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Save the accepted version and create tasks?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(/locks version 1.*creates 4 internal tasks.*does not book anything/s);
    await expect(dialog.getByRole('button', { name: 'Go back' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Save accepted version and create tasks' })).toBeFocused();
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

  test('a changed version is reported inside the open dialog with a way to reload', async ({ page }) => {
    await open(page, 'intake-confirm-conflict');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('Someone changed these booking details after you opened them. Nothing was confirmed.');
    await expect(dialog.getByRole('link', { name: 'Load the latest details' })).toHaveAttribute('href', /\/intake$/);
  });

  test('primary controls are at least 44 px tall', async ({ page }) => {
    await open(page, 'intake-ready');
    for (const name of ['Review and save the accepted version', 'Save travellers', 'Add this service']) {
      const box = await page.getByRole('button', { name }).first().boundingBox();
      expect(box?.height, name).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('B1 Deal page: services card', () => {
  test('planned: rows with type, department, owner, state and next-step link; header progress and Open intake', async ({ page }) => {
    await open(page, 'deal-services-planned');
    const card = page.getByRole('region', { name: 'Services sold' });
    await expect(card.getByRole('listitem')).toHaveCount(4);
    await expect(card).toContainText('Flight team');
    await expect(card).toContainText('Purchase (after confirmation)');
    await expect(card).toContainText('Planned · no task yet');
    await expect(card.getByRole('link', { name: 'Open intake' })).toHaveCount(5);
    // Batch 1: the progress line sits under the title; "Open intake" lives in the card only (D-06), on the Services and tasks tab.
    // The header progress line and the card come from the same read (Echo M2).
    await expect(page.getByRole('main')).toContainText('Services: 0 of 4 confirmed');
    await expect(card).toContainText('4 planned');
    await expect(page.locator('main header').getByRole('link', { name: 'Open intake' })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Open intake' }).last()).toHaveAttribute('href', /\/intake$/);
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Services and tasks' })).toHaveAttribute('aria-current', 'page');
  });

  test('active: task links per department and the frozen progress words', async ({ page }) => {
    await open(page, 'deal-services-active');
    const card = page.getByRole('region', { name: 'Services sold' });
    await expect(card).toContainText('1 of 4 confirmed · 1 in progress · 2 not started');
    await expect(card.getByRole('link', { name: 'Open Purchase task' }).first()).toHaveAttribute('href', /\/app\/purchase\//);
    await expect(card.getByRole('link', { name: 'Open Flight task' })).toHaveAttribute('href', /\/app\/flight\//);
    await expect(card).toContainText('Confirmed by supplier');
    await expect(page.locator('main header').getByRole('link', { name: 'Open intake' })).toHaveCount(0);
  });

  test('legacy hotel deal keeps its hotel panel under the services card', async ({ page }) => {
    await open(page, 'deal-services-legacy-hotel');
    await expect(page.locator('#services-sold')).toBeVisible();
    await expect(page.locator('#hotel-booking')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Services sold' })).toContainText('Booking version 1 · submitted');
  });

  test('Purchase sees its own items only, no travellers, no amount', async ({ page }) => {
    await open(page, 'deal-services-purchase');
    const card = page.getByRole('region', { name: 'Services sold' });
    await expect(card.getByRole('listitem')).toHaveCount(3);
    await expect(card).not.toContainText('Flight team');
    await expect(page.locator('body')).not.toContainText('₹');
    await expect(card).not.toContainText(/Selling|budget/i);
    await expect(page.locator('#hotel-booking')).toHaveCount(0);
  });

  test('a failed services read never looks like an empty list', async ({ page }) => {
    await open(page, 'deal-services-unavailable');
    const card = page.getByRole('region', { name: 'Services sold' });
    await expect(card).toContainText('Could not load the services');
    await expect(card).not.toContainText('No services yet');
    await expect(page.getByRole('main')).not.toContainText('Services: ');
  });
});

test.describe('B1 intake: production style policy', () => {
  test('every B1 intake and deal state renders with zero CSP violations and no style attributes', async ({ browser }) => {
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
    expect(applied.length).toBeGreaterThanOrEqual(ALL.length);
    expect(violations).toEqual([]);
    await context.close();
  });
});

test('protected B1 routes redirect to sign-in without a session', async ({ page }) => {
  for (const path of ['/app/deals/d0000000-0000-4000-8000-000000000001/intake', '/app/flight', '/app/admin/workflow']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
  }
});
