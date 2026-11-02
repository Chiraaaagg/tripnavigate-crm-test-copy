import { describe, expect, it } from 'vitest';
import { checkMigrationHistory } from '../../scripts/ci/migration-history.mjs';

const base = ['20261001000100_a.sql', '20261002000100_b.sql', '20261003000100_c.sql'];

describe('migration history check (AUDIT-002 repair plan, step 6)', () => {
  it('passes for unique versions and a new migration after the latest base version', () => {
    const result = checkMigrationHistory({
      files: [...base, '20261004000100_d.sql'],
      baseFiles: base,
      changes: [{ status: 'A', path: '20261004000100_d.sql' }],
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('fails on two files with the same version prefix', () => {
    const { errors } = checkMigrationHistory({ files: [...base, '20261003000100_other.sql'] });
    expect(errors).toEqual([expect.stringMatching(/duplicate migration version 20261003000100/)]);
  });

  it('fails when an existing migration is edited or renamed', () => {
    const { errors } = checkMigrationHistory({
      files: base,
      baseFiles: base,
      changes: [
        { status: 'M', path: '20261002000100_b.sql' },
        { status: 'R', path: '20261003000100_c.sql' },
      ],
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/existing migration 20261002000100_b\.sql was modified/);
    expect(errors[1]).toMatch(/existing migration 20261003000100_c\.sql was renamed/);
  });

  it('fails on a new migration that sorts before the latest base version (applied out of order)', () => {
    const { errors } = checkMigrationHistory({
      files: [...base, '20261002000200_late.sql'],
      baseFiles: base,
      changes: [{ status: 'A', path: '20261002000200_late.sql' }],
    });
    expect(errors).toEqual([expect.stringMatching(/20261002000200_late\.sql sorts before 20261003000100/)]);
  });

  it('warns (does not fail) on a deleted migration, which only an approved revert may do', () => {
    const result = checkMigrationHistory({
      files: base.slice(0, 2),
      baseFiles: base,
      changes: [{ status: 'D', path: '20261003000100_c.sql' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/20261003000100_c\.sql was deleted/)]);
  });

  it('accepts an owner-approved renumbering only when the content is unchanged (R100)', () => {
    const approved = [{ from: '20261002000100_b.sql', to: '20261004000100_b.sql' }];
    const ok = checkMigrationHistory({
      files: ['20261001000100_a.sql', '20261003000100_c.sql', '20261004000100_b.sql'],
      baseFiles: base,
      changes: [{ status: 'R100', from: '20261002000100_b.sql', path: '20261004000100_b.sql' }],
      approvedRenames: approved,
    });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([expect.stringMatching(/20261002000100_b\.sql renumbered to 20261004000100_b\.sql \(approved\)/)]);
    const edited = checkMigrationHistory({
      files: ['20261001000100_a.sql', '20261003000100_c.sql', '20261004000100_b.sql'],
      baseFiles: base,
      changes: [{ status: 'R087', from: '20261002000100_b.sql', path: '20261004000100_b.sql' }],
      approvedRenames: approved,
    });
    expect(edited.errors).toEqual([expect.stringMatching(/renamed/)]);
    const unapproved = checkMigrationHistory({
      files: base,
      baseFiles: base,
      changes: [{ status: 'R100', from: '20261003000100_c.sql', path: '20261005000100_c.sql' }],
      approvedRenames: approved,
    });
    expect(unapproved.errors).toEqual([expect.stringMatching(/renamed/)]);
  });

  it('fails on a file name without a numeric version', () => {
    const { errors } = checkMigrationHistory({ files: [...base, 'cleanup.sql'] });
    expect(errors).toEqual([expect.stringMatching(/cleanup\.sql has no numeric version/)]);
  });
});
