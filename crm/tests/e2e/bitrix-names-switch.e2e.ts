import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * DEC-55 (plan.md §12c): the "Bitrix names" switch card on the Bitrix sync
 * page, through the design-preview gallery (synthetic props, stand-in
 * actions, no database). On / Off / Unknown in words with an icon (Unknown is
 * never Off); change control for the Super Admin only; choose, reason,
 * review, confirm; a refusal keeps the typed reason. The server refusal and
 * audit row are covered by the database and action tests, not here.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STATES = ['names-switch-off-admin', 'names-switch-on-admin', 'names-switch-review', 'names-switch-refused', 'names-switch-read-only', 'names-switch-unknown', 'names-switch-on-connection-off'];
const card = (page: Page) => page.getByRole('region', { name: 'Bitrix names' });

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

test.describe('Bitrix names card: accessibility', () => {
  for (const state of STATES) {
    test(`axe clean at 1440, 375 and 200% zoom, no sideways scroll: ${state}`, async ({ page }) => {
      for (const size of [
        { width: 1440, height: 900 },
        { width: 375, height: 812 },
        { width: 640, height: 400 },
      ]) {
        await page.setViewportSize(size);
        await open(page, state);
        await expect(card(page)).toBeVisible();
        expect(await axe(page), `${state} at ${size.width}`).toEqual([]);
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        expect(scrollWidth, `${state} at ${size.width}`).toBeLessThanOrEqual(clientWidth);
      }
    });
  }
});

test.describe('Bitrix names card: states and change flow', () => {
  test('Off for the Super Admin: word with icon, the read-only line, a change control', async ({ page }) => {
    await open(page, 'names-switch-off-admin');
    const badge = card(page).locator('[data-slot="status-badge"]');
    await expect(badge).toHaveText('Bitrix names: Off');
    await expect(badge.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(card(page)).toContainText('Shows Bitrix stage, status and source names. Read-only; nothing is written to Bitrix.');
    await expect(card(page).getByRole('button', { name: 'Change Bitrix names setting' })).toBeVisible();
  });

  test('change flow: choose, reason (10 to 500 characters), review, confirm; a short reason is refused and kept', async ({ page }) => {
    await open(page, 'names-switch-off-admin');
    await card(page).getByRole('button', { name: 'Change Bitrix names setting' }).click();
    await expect(card(page).getByRole('radio', { name: 'On' })).toBeChecked();
    const reason = card(page).getByRole('textbox', { name: 'Why are you changing it?' });
    await reason.fill('too short');
    await card(page).getByRole('button', { name: 'Review change' }).click();
    await expect(card(page)).toContainText('Type a reason of 10 to 500 characters.');
    await expect(reason).toHaveValue('too short');
    await expect(reason).toHaveAttribute('aria-invalid', 'true');
    await reason.fill('Synthetic: owner approved showing names.');
    await card(page).getByRole('button', { name: 'Review change' }).click();
    await expect(card(page).getByRole('note')).toContainText('Turn Bitrix names on?');
    await expect(card(page).getByRole('note')).toContainText('Nothing is written to Bitrix.');
    // DA-139: the owner's approval comes first; the reason records it.
    await expect(card(page).getByRole('note')).toContainText('Changing this in the live CRM needs the owner’s approval first. Write the approval in the reason.');
    await card(page).getByRole('button', { name: 'Back' }).click();
    await expect(card(page).getByRole('textbox', { name: 'Why are you changing it?' })).toHaveValue('Synthetic: owner approved showing names.');
    await card(page).getByRole('button', { name: 'Review change' }).click();
    await card(page).getByRole('button', { name: 'Turn Bitrix names on' }).click();
    await expect(card(page).getByRole('status')).toContainText('Bitrix names are on.');
    // After the save the steps close: nothing is left to submit twice.
    await expect(card(page).getByRole('button', { name: 'Turn Bitrix names on' })).toHaveCount(0);
    await expect(card(page).getByRole('textbox')).toHaveCount(0);
  });

  test('focus moves to each step heading, to the field on a short reason, and back to the trigger on Cancel', async ({ page }) => {
    await open(page, 'names-switch-off-admin');
    const trigger = card(page).getByRole('button', { name: 'Change Bitrix names setting' });
    await trigger.click();
    await expect(card(page).getByRole('heading', { name: 'Step 1 of 2: choose and give a reason' })).toBeFocused();
    await card(page).getByRole('button', { name: 'Review change' }).click();
    await expect(card(page).getByRole('textbox', { name: 'Why are you changing it?' })).toBeFocused();
    await card(page).getByRole('textbox', { name: 'Why are you changing it?' }).fill('Synthetic: owner approved showing names.');
    await card(page).getByRole('button', { name: 'Review change' }).click();
    await expect(card(page).getByRole('heading', { name: 'Step 2 of 2: check and confirm' })).toBeFocused();
    await card(page).getByRole('button', { name: 'Back' }).click();
    await expect(card(page).getByRole('heading', { name: 'Step 1 of 2: choose and give a reason' })).toBeFocused();
    await card(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(card(page).getByRole('button', { name: 'Change Bitrix names setting' })).toBeFocused();
  });

  test('no double submit: the confirm button is disabled while saving and the result is announced once', async ({ page }) => {
    await open(page, 'names-switch-review');
    const submit = card(page).getByRole('button', { name: 'Turn Bitrix names on' });
    await submit.click();
    // Pending or already done: either way a second click cannot send again.
    await expect(card(page).getByRole('button', { name: /Turn Bitrix names on|Saving…/ })).toHaveCount(0, { timeout: 10_000 });
    await expect(card(page).getByRole('status')).toHaveCount(1);
    await expect(card(page).locator('[data-slot="names-result"]')).toBeFocused();
  });

  test('On while the Bitrix connection is off says codes are shown', async ({ page }) => {
    await open(page, 'names-switch-on-connection-off');
    // "On" only when names are really shown; the switch alone says so in words.
    await expect(card(page).locator('[data-slot="status-badge"]')).toHaveText('Bitrix names: On, but the Bitrix connection is off');
    await expect(card(page).getByRole('note')).toContainText('On, but the Bitrix connection is off: codes are shown.');
  });

  test('a refusal says so and keeps the typed reason', async ({ page }) => {
    await open(page, 'names-switch-refused');
    await expect(card(page).getByRole('alert')).toContainText('Only the Super Admin can change this setting. Nothing was changed.');
    await expect(card(page).getByRole('textbox', { name: 'Why are you changing it?' })).toHaveValue('Synthetic: owner approved showing Bitrix names.');
  });

  test('On with the last change: who, when and why', async ({ page }) => {
    await open(page, 'names-switch-on-admin');
    await expect(card(page).locator('[data-slot="status-badge"]')).toHaveText('Bitrix names: On');
    await expect(card(page)).toContainText('Last changed by Synthetic Admin Jodhpur on');
    await expect(card(page)).toContainText('Reason: Synthetic: owner approved showing Bitrix names.');
  });

  test('integration admin without Super Admin: read only, a change with no person named as such', async ({ page }) => {
    await open(page, 'names-switch-read-only');
    await expect(card(page).getByRole('button')).toHaveCount(0);
    await expect(card(page)).toContainText('Only a Super Admin can change this setting.');
    await expect(card(page)).toContainText('by a system update (no person recorded)');
  });

  test('Unknown is never shown as Off and offers no change', async ({ page }) => {
    await open(page, 'names-switch-unknown');
    const badge = card(page).locator('[data-slot="status-badge"]');
    await expect(badge).toHaveText('Bitrix names: Unknown');
    await expect(badge).not.toContainText('Off');
    await expect(card(page).getByRole('note')).toContainText('shown as Unknown, not as Off');
    await expect(card(page).getByRole('button')).toHaveCount(0);
  });
});
