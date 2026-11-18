import { defineConfig, devices } from '@playwright/test';
import { nextServerTestEnv } from './tests/helpers/test-env.mjs';

/**
 * Production Content Security Policy check (T14, project 'prod-csp').
 *
 *   npx playwright test --config=playwright.prod.config.ts --project=prod-csp
 *
 * Serves a PRODUCTION build (`next build && next start`, so the strict nonce
 * policy applies; `next dev` relaxes style-src and script-src) with a
 * providerless local environment: the Supabase URL points at a closed port,
 * so no real service is reachable. Set PROD_CSP_SKIP_BUILD=1 to reuse an
 * existing `.next` build made with the same NEXT_PUBLIC_* values (CI checks
 * job). Port: PROD_CSP_PORT (default 3210).
 *
 * Tests: tests/e2e/*.prod.e2e.ts only. The other configs ignore them.
 */
const port = Number(process.env.PROD_CSP_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${port}`;
const start = `npx next start --port ${port} --hostname 127.0.0.1`;

// Explicit loopback values only; .env files are not read and there is no
// service-role key (Milestone A section 6).
const env = nextServerTestEnv({
  APP_ENV: 'local',
  NEXT_PUBLIC_SUPABASE_URL: process.env.PROD_CSP_SKIP_BUILD
    ? (process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:59999')
    : 'http://127.0.0.1:59999',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.PROD_CSP_SKIP_BUILD
    ? (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_prod_csp_placeholder_not_a_key')
    : 'sb_publishable_prod_csp_placeholder_not_a_key',
  NEXT_PUBLIC_SITE_URL: process.env.PROD_CSP_SKIP_BUILD ? (process.env.NEXT_PUBLIC_SITE_URL ?? baseURL) : baseURL,
  ENABLE_UI_PREVIEW: 'false',
  SUPABASE_SECRET_KEY: '',
  NEXT_TELEMETRY_DISABLED: '1',
  NODE_ENV: 'production',
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.prod\.e2e\.ts/,
  outputDir: 'test-results/prod-csp',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'test-results/playwright-prod-csp.json' }]]
    : [['list']],
  use: { baseURL, trace: 'off' },
  webServer: {
    command: process.env.PROD_CSP_SKIP_BUILD ? start : `npx next build && ${start}`,
    url: `${baseURL}/sign-in`,
    timeout: 300_000,
    reuseExistingServer: false,
    env,
  },
  projects: [{ name: 'prod-csp', use: { ...devices['Desktop Chrome'] } }],
});
