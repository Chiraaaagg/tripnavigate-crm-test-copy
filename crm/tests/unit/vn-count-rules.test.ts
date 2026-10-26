import { describe, expect, it } from 'vitest';
import { countsProblem, effectiveAdults } from '@/views/booking-form/count-rules';

/*
 * Customer & trip counts on screen (voice-note batch, gate finding of 24
 * October 2026): nothing entered must not block a contact-only save; once a
 * count or the total is entered (or comes from the Deal), they must add up.
 */

const v = (paxTotal: string, adults: string, children: string, infants: string) => ({ paxTotal, adults, children, infants });

describe('count rule on the Customer & trip card', () => {
  it('nothing entered (empty, or the 0 the steppers start at) is not a problem: contact-only save goes through', () => {
    expect(countsProblem(v('', '', '', ''), false)).toBeNull();
    expect(countsProblem(v('', '', '0', '0'), false)).toBeNull();
    expect(countsProblem(v('', '0', '0', '0'), false)).toBeNull();
  });

  it('once a count is entered without a total, the total is asked for', () => {
    expect(countsProblem(v('', '2', '0', '0'), false)).toMatch(/total/i);
    expect(countsProblem(v('', '', '1', '0'), false)).toMatch(/total/i);
  });

  it('an empty adults box is worked out from the total and never refused when it can be', () => {
    expect(effectiveAdults(v('5', '', '2', '1'))).toBe(2);
    expect(countsProblem(v('5', '', '2', '1'), false)).toBeNull();
    expect(countsProblem(v('4', '', '1', '1'), true)).toBeNull();
  });

  it('typed counts must add up to the total (from the Deal or typed)', () => {
    expect(countsProblem(v('5', '3', '3', '0'), false)).toMatch(/add up to 6/);
    expect(countsProblem(v('4', '4', '1', '0'), true)).toMatch(/Correct/);
  });
});
