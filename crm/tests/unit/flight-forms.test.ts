import { describe, expect, it } from 'vitest';
import * as forms from '@/modules/flight/forms';

/**
 * Flight build, contract section 10 (crm/src/modules/flight/forms.ts, pure,
 * shared with the UI) and 12.3/12.5: the date and time parsers, PNR and
 * ticket number normalisers, next ticket number, the ticket range text,
 * the automatic arrival date and the carrier prefix. Written from the
 * contract's frozen names and examples.
 *
 * Return shapes the contract does not freeze are read leniently: an invalid
 * input may come back as null, undefined or an object without a value
 * (`valueOf` below), never as a valid-looking string.
 */

/** The parsed string, or null for "invalid" (null, undefined, '', false or an { ok: false } object). */
function valueOf(r: unknown): string | null {
  if (r === null || r === undefined || r === '' || r === false) return null;
  if (typeof r === 'string') return r;
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (o.ok === false || o.error) return null;
    for (const k of ['value', 'iso', 'date', 'time', 'text']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return String(r);
}

describe('parseFlightDate', () => {
  it.each([
    ['2 Dec 26', '2026-12-02'],
    ['2 dec 2026', '2026-12-02'],
    ['2/12/26', '2026-12-02'],
    ['2-12-2026', '2026-12-02'],
    ['2026-12-02', '2026-12-02'],
    ['14 Nov 26', '2026-11-14'],
    ['31/12/26', '2026-12-31'],
  ])('%s -> %s', (input, expected) => {
    expect(valueOf(forms.parseFlightDate(input))).toBe(expected);
  });
  it.each(['31/02/26', '30 Feb 2026', '2 Smarch 26', '', 'tomorrow', '2026-13-01', '0/12/26'])('rejects %j (real-date check)', (input) => {
    expect(valueOf(forms.parseFlightDate(input))).toBeNull();
  });
  it('two-digit years are 20yy', () => {
    expect(valueOf(forms.parseFlightDate('1/1/30'))).toBe('2030-01-01');
  });
});

describe('parseFlightTime', () => {
  it.each([
    ['1035', '10:35'],
    ['10:35', '10:35'],
    ['7:05 pm', '19:05'],
    ['07:05 PM', '19:05'],
    ['07:05 pm', '19:05'],
    ['12:00 am', '00:00'],
    ['12:30 pm', '12:30'],
    ['0005', '00:05'],
  ])('%s -> %s', (input, expected) => {
    expect(valueOf(forms.parseFlightTime(input))).toBe(expected);
  });
  it.each(['25:00', '10:61', '13:00 pm', 'noon', '', '123456789'])('rejects %j', (input) => {
    expect(valueOf(forms.parseFlightTime(input))).toBeNull();
  });
  it('prototype bug fixed: "07:05 pm" is 8 characters and must be accepted (maxlength was 7)', () => {
    expect('07:05 pm').toHaveLength(8);
    expect(valueOf(forms.parseFlightTime('07:05 pm'))).toBe('19:05');
  });
});

describe('normalizePnr and normalizeTicketNumber', () => {
  it('PNRs are trimmed and upper-cased', () => {
    expect(forms.normalizePnr(' abc123 ')).toBe('ABC123');
    expect(forms.normalizePnr('Xy7Q2k')).toBe('XY7Q2K');
  });
  it('ticket numbers are trimmed with spaces removed; dashes kept', () => {
    expect(forms.normalizeTicketNumber(' 176 2410 394501 ')).toBe('1762410394501');
    expect(forms.normalizeTicketNumber('176-2410394501')).toBe('176-2410394501');
  });
});

describe('nextTicketNumber', () => {
  it('adds one to the last digit run and keeps padding and the prefix', () => {
    expect(forms.nextTicketNumber('176-2410394501')).toBe('176-2410394502');
    expect(forms.nextTicketNumber('098-0000000009')).toBe('098-0000000010');
    expect(forms.nextTicketNumber('1762410394509')).toBe('1762410394510');
  });
  it('uses BigInt arithmetic (no float rounding on 20 digits)', () => {
    expect(forms.nextTicketNumber('98765432109876543219')).toBe('98765432109876543220');
  });
});

describe('ticketRangeText', () => {
  it('prototype bug fixed: shows the full start and end numbers', () => {
    const fn = forms.ticketRangeText as unknown as (...args: unknown[]) => string;
    const text = fn.length >= 2 ? fn('176-2410394501', '176-2410394508') : fn(['176-2410394501', '176-2410394508']);
    expect(text).toBe('176-2410394501 – 176-2410394508');
  });
});

describe('autoArrivalDate', () => {
  it('same day unless the arrival time is before the departure time (next day)', () => {
    const fn = forms.autoArrivalDate as unknown as (...args: unknown[]) => unknown;
    expect(valueOf(fn('2026-12-10', '10:35', '11:50'))).toBe('2026-12-10');
    expect(valueOf(fn('2026-12-10', '23:10', '01:20'))).toBe('2026-12-11');
    expect(valueOf(fn('2026-12-31', '23:10', '01:20'))).toBe('2027-01-01');
  });
});

describe('carrierFromFlightNo', () => {
  it('the 2-character IATA prefix only when the number starts with letters then digits', () => {
    expect(valueOf(forms.carrierFromFlightNo('AI 470'))).toBe('AI');
    expect(valueOf(forms.carrierFromFlightNo('AI470'))).toBe('AI');
    expect(valueOf(forms.carrierFromFlightNo('ai 470'))).toBe('AI');
  });
  it('never sets the airline from a bare number', () => {
    expect(valueOf(forms.carrierFromFlightNo('470'))).toBeNull();
    expect(valueOf(forms.carrierFromFlightNo(''))).toBeNull();
  });
});
