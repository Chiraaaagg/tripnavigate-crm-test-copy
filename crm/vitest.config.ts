import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loopbackTestEnv } from './tests/helpers/test-env.mjs';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  // `server-only` throws outside the React Server Components bundler condition.
  'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
};

// Test runners never use hosted values (Milestone A section 6): every
// project gets an explicit loopback configuration, a hosted URL in the shell
// fails here before any test runs, and Vite does not read .env files (so
// crm/.env.local never reaches a test).
const env = loopbackTestEnv(process.env);

export default defineConfig({
  envDir: false,
  resolve: { alias },
  test: {
    env,
    projects: [
      {
        envDir: false,
        resolve: { alias },
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node', env },
      },
      {
        envDir: false,
        resolve: { alias },
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          environment: 'node',
          env,
          // Against one real Postgres (CI: TEST_DATABASE_URL) files share fixture
          // rows and their locks, so they run one after another. PGlite gives each
          // file its own database and stays parallel.
          fileParallelism: !process.env.TEST_DATABASE_URL,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        envDir: false,
        resolve: { alias },
        test: {
          name: 'supabase',
          include: ['tests/supabase/**/*.test.ts'],
          environment: 'node',
          env,
          // Suites share one stack and mutate fixture users (barriers, recovery
          // cases, deactivation): run files one after another.
          fileParallelism: false,
          // TOTP retries may wait for the next 30 s window.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
