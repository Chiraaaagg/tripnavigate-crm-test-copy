import { describe, expect, it } from 'vitest';
import { queueAgeText, releaseEffect, rupeesInputText } from '@/views/customer-documents/acc3-pure';
import { docFilterQuery, isEmptyFilter, parseDocFilter } from '@/views/customer-documents/filter';
import { autoStateWords, crmHistoryLine, holdFix, holdReasonWords, HOLD_REASON_TEXT, madeByLine, RELEASED_BY_CRM_LINE } from '@/views/customer-documents/labels';
import { HOLD_CODES } from '@/views/customer-documents/types';

describe('Bills to check address (contract 6.5)', () => {
  it('parses preset=toCheck (and toCheck=1) as the preset', () => {
    expect(parseDocFilter({ toCheck: '1' }).filter).toEqual({ preset: 'toCheck' });
    expect(parseDocFilter({ preset: 'toCheck' }).filter).toEqual({ preset: 'toCheck' });
    expect(parseDocFilter({ preset: 'other' }).filter).toEqual({});
  });
  it('parses auto=held|ready only', () => {
    expect(parseDocFilter({ auto: 'held' }).filter.autoState).toBe('held');
    expect(parseDocFilter({ auto: 'ready' }).filter.autoState).toBe('ready');
    expect(parseDocFilter({ auto: 'released' }).filter.autoState).toBeUndefined();
  });
  it('round-trips through the query', () => {
    const q = docFilterQuery({ preset: 'toCheck', autoState: 'held', branchId: 'a0000011-0000-4000-8000-000000000011' });
    expect(q).toBe('?preset=toCheck&auto=held&branch=a0000011-0000-4000-8000-000000000011');
    const back = parseDocFilter(Object.fromEntries(new URLSearchParams(q.slice(1))));
    expect(back.filter).toEqual({ preset: 'toCheck', autoState: 'held', branchId: 'a0000011-0000-4000-8000-000000000011' });
  });
  it('keeps Phase 2 addresses unchanged', () => {
    expect(docFilterQuery({ toRelease: true })).toBe('?toRelease=1');
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ preset: 'toCheck' })).toBe(false);
  });
});

describe('automatic bill words', () => {
  it('has words for every hold code of 6.3 and a fallback', () => {
    for (const c of HOLD_CODES) expect(holdReasonWords(c)).toBe(HOLD_REASON_TEXT[c]);
    expect(holdReasonWords('unknown_code')).toMatch(/check did not pass/);
  });
  it('names rules with track B words, unknown rules plainly', () => {
    expect(crmHistoryLine('adv_on_receipt')).toBe('by the CRM, rule: Advance Invoice when a payment is verified');
    expect(crmHistoryLine('x_rule')).toBe('by the CRM, rule: x_rule');
    expect(crmHistoryLine(null)).toBeNull();
    expect(madeByLine({ autoRule: 'cn_on_refund' })).toBe('Made by the CRM, rule: Credit Note when a refund is paid or settled');
    expect(madeByLine({ autoRule: null })).toBeNull();
    expect(RELEASED_BY_CRM_LINE).toMatch(/^by the CRM, rule: released automatically/);
  });
  it('states held and ready drafts in words', () => {
    expect(autoStateWords({ autoState: 'held', holdReasons: ['amount_zero'] })).toBe('Held — check to fix');
    expect(autoStateWords({ autoState: 'held', holdReasons: ['amount_zero', 'refund_open'] })).toBe('Held — 2 checks to fix');
    expect(autoStateWords({ autoState: 'ready' })).toBe('Checks passed');
    expect(autoStateWords({})).toBeNull();
  });
  it('gives repair links only where one exists', () => {
    expect(holdFix('billing_not_verified', { billingHref: '/b' })).toEqual({ href: '/b', label: 'Verify the billing details' });
    expect(holdFix('billing_not_verified')).toBeNull();
    expect(holdFix('newer_version_waiting', { reviewHref: '/r' })?.href).toBe('/r');
    expect(holdFix('company_identity_missing')).toBeNull();
    expect(holdFix('refund_open', { billingHref: '/b' })).toBeNull();
  });
});

describe('settings and daily check helpers', () => {
  it('turns whole paise into rupee input text', () => {
    expect(rupeesInputText('500000')).toBe('5000');
    expect(rupeesInputText('250050')).toBe('2500.50');
    expect(rupeesInputText('7')).toBe('0.07');
    expect(rupeesInputText('-1')).toBeNull();
    expect(rupeesInputText('1.5')).toBeNull();
    expect(rupeesInputText(null)).toBeNull();
  });
  it('says when automatic release has effect', () => {
    expect(releaseEffect({ documents: true, drafts: true, release: true })).toBe('active');
    expect(releaseEffect({ documents: false, drafts: true, release: true })).toBe('no_effect');
    expect(releaseEffect({ documents: true, drafts: false, release: true })).toBe('no_effect');
    expect(releaseEffect({ documents: true, drafts: true, release: false })).toBe('off');
    expect(releaseEffect({ documents: true, drafts: true, release: null })).toBe('unknown');
  });
  it('words the queue age', () => {
    expect(queueAgeText(null)).toBe('none waiting');
    expect(queueAgeText(0)).toBe('none waiting');
    expect(queueAgeText(1)).toBe('1 minute');
    expect(queueAgeText(12)).toBe('12 minutes');
    expect(queueAgeText(125)).toBe('2 h 05 min');
    expect(queueAgeText(1440 + 180)).toBe('1 day 3 h');
    expect(queueAgeText(2880)).toBe('2 days');
  });
});
