import { describe, expect, it } from 'vitest';
import { NO_DATE, dateRangeText, dayText, plural, shortDate, todayIst } from '@/lib/format';

/** CQ-12: one date and count formatter ("6 Nov 2026", IST calendar days). */

const NB = '\u00a0';
const WJ = '\u2060';

describe('dayText and shortDate', () => {
  it('writes a plain date as written, never shifted by time zone', () => {
    expect(dayText('2026-11-06')).toBe('6 Nov 2026');
    expect(dayText('2026-01-31')).toBe('31 Jan 2026');
    expect(shortDate('2026-11-06')).toBe('6 Nov');
  });

  it('uses "Sep", not the en-IN "Sept"', () => {
    expect(dayText('2026-09-06')).toBe('6 Sep 2026');
  });

  it('shows a timestamp on its IST calendar day', () => {
    // 20:00 UTC on 5 Nov is 01:30 IST on 6 Nov.
    expect(dayText('2026-11-05T20:00:00Z')).toBe('6 Nov 2026');
    expect(dayText('2026-11-05T18:00:00Z')).toBe('5 Nov 2026');
    expect(dayText(new Date('2026-12-31T19:00:00Z'))).toBe('1 Jan 2027');
    expect(shortDate('2026-11-05T20:00:00+00:00')).toBe('6 Nov');
  });

  it('shows a dash for missing or unreadable input', () => {
    for (const bad of [null, undefined, '', 'not a date', '2026-13-01', '2026-02-30']) {
      expect(dayText(bad)).toBe(NO_DATE);
      expect(shortDate(bad)).toBe(NO_DATE);
    }
    expect(dayText('2028-02-29')).toBe('29 Feb 2028');
  });
});

describe('dateRangeText', () => {
  it('joins one month, two months and two years, with no-break spaces', () => {
    expect(dateRangeText('2026-11-06', '2026-11-09')).toBe(`6–${WJ}9${NB}Nov${NB}2026`);
    expect(dateRangeText('2026-11-28', '2026-12-02')).toBe(`28${NB}Nov${NB}–${WJ}${NB}2${NB}Dec${NB}2026`);
    expect(dateRangeText('2026-12-28', '2027-01-02')).toBe(`28${NB}Dec${NB}2026${NB}–${WJ}${NB}2${NB}Jan${NB}2027`);
  });

  it('leaves no break opportunity: no normal space, and every dash is followed by a word joiner', () => {
    for (const [a, b] of [['2026-11-06', '2026-11-09'], ['2026-11-28', '2026-12-02'], ['2026-12-28', '2027-01-02'], ['2026-11-06', null]] as const) {
      const text = dateRangeText(a, b);
      expect(text).not.toMatch(/ /);
      expect(text).not.toMatch(/–(?!\u2060)/);
      // Everything other than digits and letters is a no-break space, an en dash or a word joiner.
      expect(text.replace(/[0-9A-Za-z]/g, '')).toMatch(/^[\u00a0\u2013\u2060]*$/);
    }
  });

  it('shows one day once, and one known end alone', () => {
    expect(dateRangeText('2026-11-06', '2026-11-06')).toBe(`6${NB}Nov${NB}2026`);
    expect(dateRangeText('2026-11-06', null)).toBe(`6${NB}Nov${NB}2026`);
    expect(dateRangeText(undefined, '2026-11-09')).toBe(`9${NB}Nov${NB}2026`);
    expect(dateRangeText(null, 'bad')).toBe(NO_DATE);
  });
});

describe('todayIst', () => {
  it('gives the IST day as YYYY-MM-DD', () => {
    expect(todayIst(new Date('2026-11-16T19:00:00Z'))).toBe('2026-11-17');
    expect(todayIst(new Date('2026-11-16T18:00:00Z'))).toBe('2026-11-16');
  });
});

describe('plural', () => {
  it('counts with Indian grouping and the right word', () => {
    expect(plural(0, 'receipt')).toBe('0 receipts');
    expect(plural(1, 'receipt')).toBe('1 receipt');
    expect(plural(2, 'receipt')).toBe('2 receipts');
    expect(plural(3, 'entry', 'entries')).toBe('3 entries');
    expect(plural(125000, 'task')).toBe('1,25,000 tasks');
  });
});
