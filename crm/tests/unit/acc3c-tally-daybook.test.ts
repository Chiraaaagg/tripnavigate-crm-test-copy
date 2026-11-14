import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TallyDayBookError, parseDayBook, tallyAmountToPaise, tnTagOf } from '@/modules/accounts-desk/tally-daybook';
import { buildTallyXml } from '@/modules/accounts-desk/tally-xml';

/**
 * Accounts phase 3, Track C (contract 7.4): the Day Book parser against the
 * lead's synthetic TallyPrime export (supabase/fixtures/phase3), Tally's
 * UTF-16 export and the refusals. The round trip proves a file the CRM makes
 * parses back with its TN tags.
 */

const FIXTURE = join(import.meta.dirname, '..', '..', 'supabase', 'fixtures', 'phase3', 'acc3-syn-tally-daybook.xml');

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (e) {
    return e instanceof TallyDayBookError ? e.code : 'other';
  }
}

describe('synthetic Tally Day Book fixture', () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const book = parseDayBook(bytes);

  it('reads the six vouchers with number, date, type, absolute amount and tag', () => {
    expect(book.vouchers.map((v) => [v.voucherNumber, v.date, v.voucherType, v.amountPaise, v.tnTag])).toEqual([
      ['1', '2026-11-13', 'Receipt', '2000000', 'TN:TE-2026-000001/1'],
      ['2', '2026-11-13', 'Receipt', '1000000', 'TN:TE-2026-000001/2'],
      ['1', '2026-11-13', 'Payment', '910000', 'TN:TE-2026-000001/3'],
      ['3', '2026-11-13', 'Receipt', '50000', 'TN:TE-2026-000099/1'],
      ['4', '2026-11-13', 'Receipt', '2000000', 'TN:TE-2026-000001/1'],
      ['5', '2026-11-13', 'Receipt', '25000', null],
    ]);
  });

  it('the same text as a string gives the same result; a UTF-16 export too', () => {
    const textual = readFileSync(FIXTURE, 'utf8');
    expect(parseDayBook(textual)).toEqual(book);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(textual.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]);
    expect(parseDayBook(new Uint8Array(utf16))).toEqual(book);
  });
});

describe('round trip with the import file', () => {
  it('a file the CRM makes parses back with its tags and amounts', () => {
    const xml = buildTallyXml({ companyName: 'SYN Copy & Co', vouchers: [
      { date: '2026-11-10', voucherType: 'Receipt', narration: 'Deal 9 | SYN-1 | Receipt R-1 | TN:TE-2026-000004/1', reference: 'R-1',
        partyLedger: 'SYN Party', entries: [{ ledger: 'SYN Bank', debitPaise: '123456' }, { ledger: 'SYN Party', creditPaise: '123456' }] },
    ] });
    // Tally adds the voucher number on import; the parser needs it.
    const book = parseDayBook(xml.replace('<VOUCHERTYPENAME>', '<VOUCHERNUMBER>77</VOUCHERNUMBER><VOUCHERTYPENAME>'));
    expect(book.vouchers).toEqual([{ voucherNumber: '77', date: '2026-11-10', voucherType: 'Receipt',
      narration: 'Deal 9 | SYN-1 | Receipt R-1 | TN:TE-2026-000004/1', amountPaise: '123456', tnTag: 'TN:TE-2026-000004/1' }]);
  });
});

describe('refusals and small rules', () => {
  const one = (narration: string, extra = '') => `<ENVELOPE><BODY><VOUCHER VCHTYPE="Receipt"><DATE>20261110</DATE><VOUCHERNUMBER>1</VOUCHERNUMBER>${extra}<NARRATION>${narration}</NARRATION><ALLLEDGERENTRIES.LIST><AMOUNT>-1.5</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></BODY></ENVELOPE>`;
  it('DTD, entities and markup declarations are refused', () => {
    expect(code(() => parseDayBook(`<?xml version="1.0"?><!DOCTYPE E [<!ENTITY x "y">]>${one('a')}`))).toBe('dtd_refused');
    expect(code(() => parseDayBook(one('&x;')))).toBe('entity_refused');
    expect(code(() => parseDayBook(one('A & B')))).toBe('entity_refused');
  });
  it('the five XML entities and character references decode; Tally control references drop', () => {
    const v = parseDayBook(one('A &amp; B &#4;&lt;C&gt; &#x41; TN:TE-2026-000001/12')).vouchers[0]!;
    expect(v.narration).toBe('A & B <C> A TN:TE-2026-000001/12');
    expect(v.voucherType).toBe('Receipt');
    expect(v.amountPaise).toBe('150');
    expect(v.tnTag).toBe('TN:TE-2026-000001/12');
  });
  it('a voucher without a number, with a bad date or amount, or broken markup is refused', () => {
    expect(code(() => parseDayBook(one('x').replace('<VOUCHERNUMBER>1</VOUCHERNUMBER>', '')))).toBe('voucher_number_missing');
    expect(code(() => parseDayBook(one('x').replace('20261110', '20261340')))).toBe('bad_date');
    expect(code(() => parseDayBook(one('x').replace('-1.5', '1.234')))).toBe('bad_amount');
    expect(code(() => parseDayBook(one('x').replace('</NARRATION>', '')))).toBe('malformed');
  });
  it('amount and tag helpers', () => {
    expect(tallyAmountToPaise('-20000.00')).toBe('2000000');
    expect(tallyAmountToPaise('0.05')).toBe('5');
    expect(tallyAmountToPaise('1,234.5')).toBe('123450');
    expect(tallyAmountToPaise('abc')).toBeNull();
    expect(tnTagOf('… | TN:TE-2026-000031/007 tail')).toBe('TN:TE-2026-000031/7');
    expect(tnTagOf('TN:TE-1/1')).toBeNull();
  });
});
