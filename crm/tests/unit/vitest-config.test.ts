import { afterEach, describe, expect, it, vi } from 'vitest';

type Project = { test?: { name?: string; fileParallelism?: boolean } };

async function dbProject(): Promise<Project['test']> {
  vi.resetModules();
  const config = (await import('../../vitest.config')).default as { test?: { projects?: Project[] } };
  return config.test?.projects?.find((p) => p.test?.name === 'db')?.test;
}

// Against one real Postgres (TEST_DATABASE_URL), db files share fixture rows
// and their row locks, so they run one after another (AUDIT-024). Each PGlite
// run has its own in-memory database and stays parallel.
describe('db test project', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs files one at a time against a shared real Postgres', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    expect((await dbProject())?.fileParallelism).toBe(false);
  });

  it('keeps files parallel on PGlite', async () => {
    vi.stubEnv('TEST_DATABASE_URL', '');
    expect((await dbProject())?.fileParallelism).not.toBe(false);
  });
});
