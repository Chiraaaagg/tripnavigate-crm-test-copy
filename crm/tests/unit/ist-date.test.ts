import { describe, expect, it } from 'vitest';
import { istDate } from '@/lib/dates';

describe('istDate', () => {
  it('returns the Asia/Kolkata calendar day as YYYY-MM-DD', () => {
    expect(istDate('2026-10-05T18:29:59+00:00')).toBe('2026-10-05');
    expect(istDate('2026-10-05T18:30:00+00:00')).toBe('2026-10-06');
    expect(istDate('2026-10-10T23:59:59+05:30')).toBe('2026-10-10');
  });

  it('returns unparseable input unchanged', () => {
    expect(istDate('not a date')).toBe('not a date');
  });
});
