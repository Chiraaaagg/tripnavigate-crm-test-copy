import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 5 imported Bitrix deals and sync problems, through the design-preview
 * gallery (synthetic props, no Supabase, no Bitrix). Not evidence of a real
 * intake: access itself is enforced server-side (integration.manage is Super
 * Admin only, see tests/unit/access-policy.test.ts; the admin page renders
 * IntegrationNoPermissionView without it).
 */

const states = [
  'intake-deals-sales',
  'intake-deal-sales',
  'intake-deal-sales-raw-stage',
  'intake-deal-sales-stale',
  'intake-deals-purchase',
  'intake-deal-purchase',
  'intake-sync-healthy',
  'intake-sync-problems',
  'intake-sync-auth-failed',
  'intake-sync-worker-down',
  'intake-sync-every-code',
  'intake-sync-sales-denied',
  'intake-sync-purchase-denied',
];

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const RAW_CODES = [
  'not_configured', 'environment_unset', 'not_eligible_category', 'not_eligible_stage', 'before_cutoff', 'unmapped_owner',
  'owner_not_in_pilot_branch', 'invalid_source_data', 'source_deal_not_found', 'stale_ignored', 'reference_conflict',
  'provider_timeout', 'provider_unavailable', 'provider_rate_limited', 'provider_auth_failed', 'provider_bad_response',
  'internal_error', 'dead_letter', 'needs_review',
];

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
  await page.goto(`/preview/${state}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await page.waitForLoadState('networkidle');
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test.describe('Phase 5 previews: accessibility on desktop, 390 px and 200% zoom', () => {
  for (const state of states) {
    test(`axe clean: ${state}`, async ({ page }) => {
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
    });
    test(`390 px, no sideways scroll: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }

  for (const state of ['intake-deals-sales', 'intake-deal-sales-stale', 'intake-sync-problems', 'intake-sync-every-code']) {
    test(`200% zoom keeps ${state} usable without sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 900 });
      await open(page, state);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await noHorizontalScroll(page);
    });
  }
});

test.describe('Imported deals: provenance wording', () => {
  // Direction A Batch 1: stage in its own column (Bitrix name, else "not recognised"),
  // provenance and sync times on demand in row Details and the Overview disclosure.
  test('deal list shows the stage name or the fallback, late rows in words; deal number and sync time in Details', async ({ page }) => {
    await open(page, 'intake-deals-sales');
    const table = page.getByRole('table', { name: '1–3 of 3 deals' });
    await expect(table).toContainText('Quote sent');
    await expect(table).toContainText('Stage not recognised (code in details)');
    await expect(table.locator('[data-slot="status-badge"]', { hasText: 'Not updated from Bitrix for over a day' })).toBeVisible();
    // A mapped stage shows the Bitrix name in its cell; the raw id stays in Details only.
    await expect(table.locator('td[data-label="Stage"]', { hasText: 'Quote sent' }).first()).not.toContainText('C1:PREPARATION');
    await expect(table).toContainText('#900301');
    await expect(table).toContainText('3 Oct 2026');
    // DA-131: the Bitrix-owns line lives once in the Deal's Details, not on the list.
    await expect(page.getByRole('main')).not.toContainText('Stage and salesperson change only in Bitrix.');
  });

  test('fresh deal: stage name, Bitrix facts on demand, Bitrix owns stage and salesperson, no edit control', async ({ page }) => {
    await open(page, 'intake-deal-sales');
    const header = page.locator('[data-slot="page-header"]');
    await expect(header).toContainText('Quote sent');
    const overview = page.getByRole('region', { name: 'Overview' });
    await overview.locator('summary').click();
    await expect(overview).toContainText('Quote sent');
    await expect(overview).toContainText('Last checked with Bitrix');
    await expect(overview).toContainText('Title, stage and salesperson come from Bitrix. Change them there.');
    await expect(overview.getByRole('textbox')).toHaveCount(0);
    await expect(overview.getByRole('combobox')).toHaveCount(0);
    await expect(overview.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText('Not updated from Bitrix');
    // Positive freshness: the last check with Bitrix is shown with its time.
    await expect(overview).toContainText(/Last checked with Bitrix\s*\d{1,2} \w{3} 2026/);
  });

  test('unmapped stage shows the fallback, with the raw id in Details', async ({ page }) => {
    await open(page, 'intake-deal-sales-raw-stage');
    await expect(page.locator('[data-slot="page-header"]')).toContainText('Stage not recognised (code in Details)');
    const overview = page.getByRole('region', { name: 'Overview' });
    await overview.locator('summary').click();
    await expect(overview).toContainText('Bitrix code: C1:UC_SYN42.');
  });

  test('stale deal: warning in words under the title; last check time in Details', async ({ page }) => {
    await open(page, 'intake-deal-sales-stale');
    const note = page.getByRole('main').getByRole('note').filter({ hasText: 'Not updated from Bitrix for over a day' });
    await expect(note).toContainText('Check the stage in Bitrix before you rely on it.');
    const overview = page.getByRole('region', { name: 'Overview' });
    await expect(overview).toContainText('Last checked with Bitrix');
    await expect(overview).toContainText('1 Oct 2026');
  });
});

test.describe('Sales, Purchase and admin visibility', () => {
  test('Sales sees provenance and its selling price on the Money tab; no Bitrix connection in the menu', async ({ page }) => {
    await open(page, 'intake-deal-sales-stale');
    await expect(page.getByRole('region', { name: 'Overview' })).toContainText('Bitrix deal');
    await open(page, 'intake-deal-sales-stale-money');
    await expect(page.getByRole('region', { name: 'Money' })).toContainText('₹98,765.00');
    await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  });

  test('Purchase sees provenance of its assigned deal but no commercials and no sync page', async ({ page }) => {
    for (const state of ['intake-deal-purchase', 'intake-deals-purchase']) {
      await open(page, state);
      const main = page.getByRole('main');
      await expect(main).toContainText('#9003');
      await expect(main).not.toContainText('₹');
      await expect(main).not.toContainText(/estimated margin/i);
      await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    }
    await open(page, 'intake-deal-purchase');
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Money' })).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('note')).toContainText('Not updated from Bitrix for over a day');
  });

  test('non-admins get the no-permission page and none of the sync details', async ({ page }) => {
    for (const state of ['intake-sync-sales-denied', 'intake-sync-purchase-denied']) {
      await open(page, state);
      const main = page.getByRole('main');
      await expect(main).toContainText('Only staff who manage the Bitrix connection, and who hold no Purchase role, can open this page.');
      await expect(page.getByRole('heading', { name: 'What needs fixing' })).toHaveCount(0);
      await expect(main).not.toContainText('synthetic-portal.example.test');
      await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    }
  });

  test('admin sees Bitrix connection in the menu, marked as the current page', async ({ page }) => {
    await open(page, 'intake-sync-healthy');
    await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Bitrix connection' })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('Sync problems: plain sentences, who acts next and the repair', () => {
  test('healthy: nothing needs fixing and nobody needs to act', async ({ page }) => {
    await open(page, 'intake-sync-healthy');
    const panel = page.getByRole('region', { name: 'What needs fixing' });
    await expect(panel).toContainText('No sync problems right now. Nobody needs to act.');
    await expect(page.getByRole('main')).toContainText('Receiving deals');
  });

  test('mixed problems: each is a sentence with who acts next and a repair step', async ({ page }) => {
    await open(page, 'intake-sync-problems');
    const problems = page.getByRole('region', { name: 'What needs fixing' }).getByRole('listitem');
    await expect(problems.first()).toContainText('Bitrix rejected the CRM’s access credential, so no deal can be read.');
    await expect(problems.first()).toContainText('Next: the CRM team needs to fix the Bitrix login.');
    // S-26: the runbook steps stay, behind "Details for the CRM team".
    await expect(problems.first().locator('details')).toContainText('Create a new inbound webhook in Bitrix, put it in the server secret store');
    for (const text of [
      '2 deals stopped after using all retries and will not be tried again on their own.',
      '2 deals need a person to fix something before they can be copied.',
      '1 deal failed and will be retried automatically.',
    ]) {
      await expect(problems.filter({ hasText: text })).toHaveCount(1);
    }
    const count = await problems.count();
    for (let i = 0; i < count; i++) {
      // G-18: one Next line (repair, and who acts when someone must).
      await expect(problems.nth(i).locator('[data-slot="next-line"]')).toHaveCount(1);
      await expect(problems.nth(i).locator('[data-slot="next-line"]')).toContainText('Next:');
    }

    const table = page.getByRole('table', { name: /need attention/ });
    const unmapped = table.getByRole('row').filter({ hasText: '#900401' });
    await expect(unmapped).toContainText('The responsible person in Bitrix is not linked to a CRM staff member.');
    await expect(unmapped).toContainText('Next: link their Bitrix user to their CRM staff record, then press Retry. · an admin');
    const outside = table.getByRole('row').filter({ hasText: '#900402' });
    await expect(outside).toContainText('not an active member of the pilot branch');
    await expect(outside).toContainText('Missed-deal check');
    const failed = table.getByRole('row').filter({ hasText: '#900403' });
    await expect(failed).toContainText('Failed, will retry automatically');
    await expect(failed).toContainText('· nobody yet. The CRM retries on its own.');
    await expect(failed).toContainText('Next automatic try:');
    const dead = table.getByRole('row').filter({ hasText: '#900404' });
    await expect(dead).toContainText('Stopped: retries used up');
    await expect(dead).toContainText('Retries are used up; it will not be tried again on its own.');
    await expect(dead).toContainText('· an admin');
    await expect(dead).toContainText('8 of 8');
  });

  test('worker not running is named with who restarts it', async ({ page }) => {
    await open(page, 'intake-sync-worker-down');
    const panel = page.getByRole('region', { name: 'What needs fixing' });
    await expect(panel).toContainText('Background updates have not run since 3 Oct 2026');
    await expect(panel).toContainText('so new Bitrix deals wait and are not copied.');
    await expect(panel).toContainText('Next: the CRM team restarts background updates');
    await expect(page.getByRole('main')).not.toContainText('Receiving deals');
  });

  test('credential rejected leads the page and the Bitrix alert', async ({ page }) => {
    await open(page, 'intake-sync-auth-failed');
    await expect(page.getByRole('region', { name: 'What needs fixing' }).getByRole('listitem').first()).toContainText(
      'Bitrix rejected the CRM’s access credential',
    );
    await expect(page.getByRole('main').getByRole('alert').first()).toContainText('Error: Bitrix rejected the CRM’s access credential');
    await expect(page.getByRole('main').getByRole('alert').first()).toContainText('until an admin replaces the credential');
    await expect(page.getByRole('main').getByRole('alert').first()).not.toContainText('retried automatically');
    await expect(page.getByRole('main')).toContainText('Bitrix refused the CRM’s login');
    await expect(page.getByRole('main')).not.toContainText('Bitrix not responding');
  });

  test('every reason and error code has one plain sentence; no raw code is shown', async ({ page }) => {
    await open(page, 'intake-sync-every-code');
    const table = page.getByRole('table', { name: /need attention/ });
    for (const text of [
      'not configured or was switched off when this deal arrived',
      'server environment was not set',
      'pipeline this CRM does not take',
      'stage this CRM does not take yet',
      'before the intake start date',
      'not linked to a CRM staff member',
      'not an active member of the pilot branch',
      'deal number that is not a number',
      'does not exist or cannot be read',
      'older version of a deal',
      'already used by another deal',
      'did not answer within 10 seconds',
      'Bitrix was unavailable',
      'rate limit',
      'rejected the CRM’s access credential',
      'reply the CRM could not read',
      'internal error while copying this deal',
    ]) {
      await expect(table).toContainText(text);
    }
    const rows = table.locator('tbody tr');
    const n = await rows.count();
    expect(n).toBe(17);
    for (let i = 0; i < n; i++) await expect(rows.nth(i).locator('[data-slot="next-line"]')).toContainText('Next:');
    const text = await page.getByRole('main').innerText();
    for (const code of RAW_CODES) expect(text, code).not.toContain(code);
  });

  test('keyboard: Retry is reachable by Tab and names the Bitrix deal', async ({ page }) => {
    await open(page, 'intake-sync-problems');
    const retry = page.getByRole('button', { name: 'Retry Bitrix deal #900401' });
    await expect(retry).toBeVisible();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      if (await retry.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(retry).toBeFocused();
    const focusRing = await retry.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(focusRing).not.toBe('none');
  });
});
