import { expect, test } from '@playwright/test';

/**
 * Captures Phase 2 UI states (Bitrix provenance and sync administration) to
 * docs/implementation/history/phase-2/screenshots. Earlier phases' evidence directories
 * are never written. Synthetic preview props only.
 */
const dir = '../docs/implementation/history/phase-2/screenshots';

const shots: Array<[string, string]> = [
  ['01-deals-bitrix-source', '/preview/deals-bitrix-source'],
  ['02-deal-detail-bitrix', '/preview/deal-detail-bitrix'],
  ['03-deal-detail-bitrix-stale', '/preview/deal-detail-bitrix-stale'],
  ['04-deal-detail-synthetic', '/preview/deal-detail-sales'],
  ['05-integration-not-configured', '/preview/integration-not-configured'],
  ['06-integration-switched-off', '/preview/integration-switched-off'],
  ['07-integration-healthy', '/preview/integration-healthy'],
  ['08-integration-attention', '/preview/integration-attention'],
  ['09-integration-provider-unavailable', '/preview/integration-provider-unavailable'],
  ['10-integration-stale', '/preview/integration-stale'],
  ['11-integration-reason-codes', '/preview/integration-reason-codes'],
  ['12-integration-action-results', '/preview/integration-action-results'],
  ['13-integration-no-permission', '/preview/integration-no-permission'],
  ['14-integration-worker-never-run', '/preview/integration-worker-never-run'],
  ['15-integration-worker-not-recent', '/preview/integration-worker-not-recent'],
  ['16-integration-backlog', '/preview/integration-backlog'],
  ['17-integration-worker-secret-missing', '/preview/integration-worker-secret-missing'],
  ['18-integration-multiple-configs', '/preview/integration-multiple-configs'],
  ['19-integration-reconcile-cooldown', '/preview/integration-reconcile-cooldown'],
];

for (const [name, path] of shots) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  });
}

for (const [name, path] of [
  ['20-mobile-deals-bitrix-source', '/preview/deals-bitrix-source'],
  ['21-mobile-integration-not-configured', '/preview/integration-not-configured'],
  ['22-mobile-integration-attention', '/preview/integration-attention'],
] as const) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Wide tables scroll inside their own container; the page itself must not scroll sideways.
    if (path.includes('integration')) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  });
}
