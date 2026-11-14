import { describe, expect, it } from 'vitest';
import { dbErrorMessage } from '@/modules/access/server/invite';

describe('dbErrorMessage', () => {
  it('never shows a raw check-constraint message (table, constraint or id names)', () => {
    const raw = 'new row for relation "memberships" violates check constraint "memberships_branch_entity_check"';
    const message = dbErrorMessage({ code: '23514', message: raw });
    expect(message).not.toContain('relation');
    expect(message).not.toContain('constraint');
    expect(message).toBe('The request is not valid for this staff member, branch or role.');
  });

  it('keeps the app-authored messages for invalid input and rate limits', () => {
    expect(dbErrorMessage({ code: '22023', message: 'reason must be at least 10 characters' })).toBe(
      'reason must be at least 10 characters',
    );
    expect(dbErrorMessage({ code: '54000', message: 'too many invitation emails; wait an hour' })).toBe(
      'too many invitation emails; wait an hour',
    );
  });
});
