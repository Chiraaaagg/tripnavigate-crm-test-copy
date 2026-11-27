import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loopbackTestEnv } from '../../tests/helpers/test-env.mjs';

/**
 * Runs ONLY the plain-stack proof file (hosting-migration contract file 12,
 * section 6), from crm/:
 *
 *   npx vitest run --config fallback/plain-stack/vitest.plain.config.ts
 *
 * Same isolation as crm/vitest.config.ts: explicit loopback environment, no
 * .env files. The file lives outside tests/unit, tests/db and tests/supabase,
 * so none of the gate's three projects picks it up.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const alias = {
  '@': fileURLToPath(new URL('../../src', import.meta.url)),
  'server-only': fileURLToPath(new URL('../../tests/helpers/server-only-stub.ts', import.meta.url)),
};
const env = loopbackTestEnv(process.env);

export default defineConfig({
  root,
  envDir: false,
  resolve: { alias },
  test: {
    name: 'plain-proofs',
    include: ['fallback/plain-stack/tests/**/*.plain.test.ts'],
    environment: 'node',
    env,
    fileParallelism: false,
    // P4 waits 63 s for a signed link to expire; P5 runs a 3-minute loop.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
