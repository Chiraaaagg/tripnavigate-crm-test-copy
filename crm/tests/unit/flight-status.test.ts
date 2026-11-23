import { describe, expect, it } from 'vitest';
import * as status from '@/modules/flight/status';

/**
 * Flight build, contract section 7 (status mapping, frozen words) and
 * section 10 (crm/src/modules/flight/status.ts: words, chips and progress
 * from DB codes; display only). The function names are not frozen, so the
 * test calls every exported function with the shapes a DB status may take
 * ({code, confirmed, required}, or positional) and checks that the frozen
 * words come out for each state. Also: no flight status reads "Confirmed by
 * supplier" (DEC-59 superseded).
 */

const fns = Object.entries(status).filter(([, v]) => typeof v === 'function') as Array<[string, (...a: unknown[]) => unknown]>;

function texts(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => texts(v, out, depth + 1));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => texts(v, out, depth + 1));
  return out;
}
/** Every string any exported function returns for this status, across the plausible call shapes. */
function wordsFor(code: string, confirmed: number, required: number): string[] {
  const s = { code, confirmed, required, text: undefined };
  const shapes: unknown[][] = [[s], [{ status: s }], [code, confirmed, required], [{ code, x: confirmed, y: required }]];
  const out: string[] = [];
  for (const [, fn] of fns) {
    for (const args of shapes) {
      try {
        texts(fn(...args), out);
      } catch {
        // Not this shape.
      }
    }
  }
  return out;
}

describe('flight status words', () => {
  it('status.ts exports at least one function', () => {
    expect(fns.length).toBeGreaterThan(0);
  });
  it.each([
    ['waiting', 0, 8, 'Waiting'],
    ['in_progress', 3, 8, 'In progress · 3 of 8 tickets'],
    ['in_progress', 0, 1, 'In progress · 0 of 1 tickets'],
    ['all_confirmed', 8, 8, 'All tickets confirmed'],
    ['done', 8, 8, 'Done · ticket issued'],
  ])('%s %i of %i -> "%s"', (code, x, y, expected) => {
    const words = wordsFor(code, x, y);
    expect(words, `exports: ${fns.map(([n]) => n).join(', ')}`).toContain(expected);
    expect(words.some((w) => /Confirmed by supplier/i.test(w))).toBe(false);
  });
});
