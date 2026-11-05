import { describe, expect, it } from 'vitest';
import * as money from '@/modules/flight/money-forms';

/**
 * Flight build, contract D3 and section 10 (crm/src/modules/flight/
 * money-forms.ts): rupees text -> paise with fareNum (strip ",", spaces and
 * "₹"; whole paise only; negatives invalid), and the live per-person /
 * amount arithmetic that mirrors the database formula:
 *   total per person = basic + K + YQ + YR + other + markup - discount
 *   supplier per person = basic + K + YQ + YR + other; amount = per person × count.
 * Return types are read leniently (number, bigint or decimal string; invalid
 * = null / undefined / NaN).
 */

const paise = (r: unknown): string | null => {
  if (r === null || r === undefined || r === '' || (typeof r === 'number' && !Number.isFinite(r))) return null;
  if (typeof r === 'object' && r && 'ok' in (r as object) && (r as { ok: boolean }).ok === false) return null;
  if (typeof r === 'object' && r && 'value' in (r as object)) return paise((r as { value: unknown }).value);
  return String(r);
};

describe('fareNum', () => {
  it.each([
    ['5,000', '500000'],
    ['₹5,000.50', '500050'],
    [' 1 234.5 ', '123450'],
    ['0', '0'],
    ['12,34,567.89', '123456789'],
  ])('%j -> %s paise', (input, expected) => {
    expect(paise(money.fareNum(input))).toBe(expected);
  });
  it.each(['-1', '-0.01', '1.005', 'abc', '₹', '1e3'])('rejects %j', (input) => {
    expect(paise(money.fareNum(input))).toBeNull();
  });
});

describe('the fare formula (mirror of flight_batch_fares)', () => {
  it('some exported helper computes supplier and total per person and the amounts like the database', () => {
    const fns = Object.entries(money).filter(([n, v]) => typeof v === 'function' && n !== 'fareNum') as Array<[string, (...a: unknown[]) => unknown]>;
    const row = { paxType: 'adult', basicPaise: '500000', kPaise: '50000', yqPaise: '30000', yrPaise: '10000', otherPaise: '10000',
      markupPaise: '50000', discountPaise: '20000', paxCount: 3 };
    const seen: string[] = [];
    for (const [, fn] of fns) {
      for (const args of [[row], [[row]], [row, 'flight_only'], [[row], 'flight_only']]) {
        try {
          seen.push(JSON.stringify(fn(...args), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        } catch {
          // Not this shape.
        }
      }
    }
    const text = seen.join('\n');
    // Supplier per person 600,000; total per person 630,000; supplier amount 1,800,000; customer amount 1,890,000.
    for (const v of ['600000', '630000', '1800000', '1890000']) expect(text, `exports: ${fns.map(([n]) => n).join(', ')}`).toContain(v);
  });
});
