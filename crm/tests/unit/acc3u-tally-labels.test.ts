import { describe, expect, it } from 'vitest';
import { applySummary, leftOutHref, matchBatchHref, parseOutcome, partyNameProblem, reasonCounts, tallyXmlHref } from '@/views/tally-file/labels';

/** Track U pure helpers for the Tally file screens (contract 7, 15 screen 7). */

describe('Tally file helpers', () => {
  it('builds the frozen download and list addresses', () => {
    expect(tallyXmlHref('a/b')).toBe('/app/accounts/tally/exports/a%2Fb/xml');
    expect(leftOutHref('e1')).toBe('/app/accounts/tally/exports/e1/left-out');
    expect(leftOutHref('e1', 'k|1')).toBe('/app/accounts/tally/exports/e1/left-out?after=k%7C1');
    expect(matchBatchHref('b1')).toBe('/app/accounts/tally/matches/b1');
    expect(matchBatchHref('b1', 'amount_differs', 'c')).toBe('/app/accounts/tally/matches/b1?outcome=amount_differs&after=c');
  });
  it('orders left-out reasons and drops zeros', () =>
    expect(reasonCounts({ already_in_file: 2, ledger_not_mapped: 1, party_not_mapped: 0 })).toEqual([
      { reason: 'ledger_not_mapped', count: 1 },
      { reason: 'already_in_file', count: 2 },
    ]));
  it('says what applying does', () =>
    expect(applySummary({ matched: 3, amount_differs: 1, not_found: 1, already_matched: 1, duplicate_in_file: 0, no_tag: 1 })).toEqual({ willMatch: 3, willBecomeExceptions: 1, unchanged: 3, total: 7 }));
  it('parses the outcome filter', () => {
    expect(parseOutcome('no_tag')).toBe('no_tag');
    expect(parseOutcome(['matched'])).toBe('matched');
    expect(parseOutcome('drop table')).toBeNull();
    expect(parseOutcome(undefined)).toBeNull();
  });
  it('mirrors the Tally name rule', () => {
    expect(partyNameProblem('Synthetic Co')).toBeNull();
    expect(partyNameProblem('  ')).toMatch(/Type/);
    expect(partyNameProblem('x'.repeat(101))).toMatch(/100/);
    expect(partyNameProblem('a\tb')).toMatch(/tabs/);
  });
});
