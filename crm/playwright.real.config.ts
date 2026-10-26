import { defineConfig, devices } from '@playwright/test';
import { nextServerTestEnv } from './tests/helpers/test-env.mjs';

/**
 * Real browser journey (contract T15) against a REAL local Supabase stack
 * (Auth + Data API + Postgres + Mailpit). Used by the CI job
 * "real-browser-journey":
 *
 *   npx playwright test --config=playwright.real.config.ts --project=real-journey
 *
 * Unlike playwright.config.ts it never starts the mock dev server. It serves
 * the PRODUCTION build (`next start`, so the strict nonce CSP applies) on
 * 127.0.0.1:3100 with the environment of the calling shell, which must provide
 * APP_ENV=local, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 * NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3100 and SUPABASE_SECRET_KEY (local
 * stack values from `supabase status`) plus TEST_DATABASE_URL and
 * LOCAL_FIXTURE_PASSWORD for the journey's fixture steps. Run `npm run build` first with the
 * same NEXT_PUBLIC_* values.
 *
 * Tests: tests/e2e/**\/*.real.e2e.ts: journey.real.e2e.ts (T15, Purchase,
 * sign-in, MFA, password recovery, session refresh) and accounts.real.e2e.ts
 * (Phase 5B Milestone A section 8: two Accounts users, real private Storage).
 * B1.1/B1.2: b11-journey.real.e2e.ts (Book now three steps) and
 * b12-quote-to-booking.real.e2e.ts (Lead quotation to submitted booking).
 * Mailpit: MAILPIT_URL (default http://127.0.0.1:54324). Fixture password:
 * LOCAL_FIXTURE_PASSWORD.
 *
 * Isolation (Milestone A section 6): every URL above must be a loopback
 * address (checked here, before any test runs), the server gets its Supabase
 * values explicitly from the calling shell and never reads crm/.env.local.
 */
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

const required = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'LOCAL_FIXTURE_PASSWORD',
  'TEST_DATABASE_URL',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0 && (process.env.REQUIRE_REAL_STACK === '1' || process.env.CI)) {
  throw new Error(`Real browser journey needs: ${missing.join(', ')}`);
}

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.real\.e2e\.ts/,
  outputDir: 'test-results/real-journey',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/playwright-real-journey.json' }],
    ['html', { open: 'never', outputFolder: 'playwright-report/real-journey' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `npx next start --port ${port} --hostname 127.0.0.1`,
    url: `${baseURL}/sign-in`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: nextServerTestEnv({
      APP_ENV: 'local',
      NEXT_PUBLIC_SITE_URL: baseURL,
      NEXT_TELEMETRY_DISABLED: '1',
    }),
  },
  projects: [
    {
      name: 'real-journey',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
  ],
});
