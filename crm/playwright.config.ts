import { defineConfig, devices } from '@playwright/test';
import { nextServerTestEnv } from './tests/helpers/test-env.mjs';

/**
 * Browser checks that need no Supabase stack: unauthenticated routing,
 * accessibility of public screens and the design-review gallery, and
 * screenshots. The Next dev server runs with APP_ENV=local and a local Supabase
 * URL that is NOT running, so nothing can reach a real service.
 */
// E2E_PORT lets parallel worktrees run the gallery suites side by side (default 3100, as in CI).
const port = Number(process.env.E2E_PORT ?? 3100);
// Explicit values only: .env files are not read (crm/.env.local holds hosted
// values) and there is no service-role key (Milestone A section 6).
const env = nextServerTestEnv({
  APP_ENV: 'local',
  LOCAL_USE_PRODUCTION_DATABASE: 'false',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:59999',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_playwright_placeholder_not_a_key',
  NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
  SUPABASE_SECRET_KEY: '',
  ENABLE_UI_PREVIEW: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
});

export default defineConfig({
  testDir: 'tests/e2e',
  // Real-stack journeys (playwright.real.config.ts) and production-build checks
  // (playwright.prod.config.ts) never run against this mock dev server.
  testIgnore: [/.*\.real\.e2e\.ts/, /.*\.prod\.e2e\.ts/],
  outputDir: 'test-results',
  // Owner decision 25 October 2026 (faster full test): four test files run at a
  // time; tests inside one file still run in order. The gallery needs `next dev`
  // (isUiPreviewEnabled requires NODE_ENV=development), so it is not a production build.
  // E2E_WORKERS overrides the count (1 = the old one-at-a-time run).
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 4),
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'test-results/playwright-e2e.json' }]]
    : [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  webServer: {
    command: `npx next dev --port ${port} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${port}/sign-in`,
    timeout: 180_000,
    reuseExistingServer: false,
    env,
  },
  projects: [
    { name: 'e2e', testMatch: /.*\.e2e\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'screenshots',
      testMatch: /screenshots\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
  ],
});
