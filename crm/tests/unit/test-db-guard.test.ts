import { describe, expect, it } from 'vitest';
import { assertNotOperational } from '../helpers/db';

// Tests write fixtures and relabel the database: only a fresh ('unset' or no
// setting yet) or synthetic ('test') database may be used (AUDIT-014).
const rows = (environment?: string) => async () => (environment === undefined ? [] : [{ environment }]);
const missingTable = async () => {
  throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
};

describe('test database guard', () => {
  it.each(['unset', 'test'])('allows %s', async (env) => {
    await expect(assertNotOperational(rows(env))).resolves.toBeUndefined();
  });

  it('allows a database before migrations (no setting row or no table)', async () => {
    await expect(assertNotOperational(rows())).resolves.toBeUndefined();
    await expect(assertNotOperational(missingTable)).resolves.toBeUndefined();
  });

  it.each(['operational', 'staging', 'something-new'])('refuses a database labelled %s', async (env) => {
    await expect(assertNotOperational(rows(env))).rejects.toThrow(new RegExp(`refusing to run tests.*${env}`));
  });
});
