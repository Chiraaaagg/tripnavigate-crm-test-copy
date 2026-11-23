import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from '@/modules/accounts-desk/contracts';
import { CSV_BOM, CSV_EOL, csvCell, csvFileName, csvHeaderLine, csvLine, escapeFormula, maskMobile, maskPan, paiseToRupees, quoteCell } from '@/modules/accounts-desk/csv';

/**
 * Accounts phase contract 7.4 (CSV evidence pack) and 12.5, Track E. The
 * contract freezes maskPan / maskMobile and the behaviour; the other export
 * names are Track B's (csv.ts is "pure: escape, quote, mask, paise, line").
 */

// Accounts phase 2 (contract 2026-11-11, 8.2): seven mapped columns inserted after "Credit ledger hint".
const HEADERS = [
  'Export no', 'Line', 'Record type', 'Voucher type hint', 'Date', 'Reference', 'Deal', 'Bitrix Deal id', 'Branch', 'Party', 'Debit ledger hint',
  'Credit ledger hint', 'Service', 'Tally debit ledger', 'Tally credit ledger', 'Tally voucher type', 'Mapping missing', 'Narration', 'Tally number',
  'Amount (INR)', 'Mode', 'Bank reference', 'PAN', 'Mobile', 'GST included', 'Credit note for', 'Linked tasks',
  'Already exported on', 'Changed since last export', 'CRM record id',
];

describe('masking', () => {
  it('PAN ABCDE1234F -> XXXXX1234X; mobile 6000043210 -> XXXXXX3210', () => {
    expect(maskPan('ABCDE1234F')).toBe('XXXXX1234X');
    expect(maskPan('abcde1234f')).toBe('XXXXX1234X');
    expect(maskMobile('6000043210')).toBe('XXXXXX3210');
    expect(maskMobile('+91 60000 43210')).toBe('XXXXXX3210');
    expect(maskPan(null)).toBeNull();
    expect(maskMobile('')).toBeNull();
  });
});

describe('amounts from paise, exact', () => {
  it.each([['1', '0.01'], ['99', '0.99'], ['100', '1.00'], ['123456', '1234.56'], ['123456789012345', '1234567890123.45'], ['2500000', '25000.00']])(
    '%s paise -> %s', (paise, rupees) => {
      expect(paiseToRupees(paise)).toBe(rupees);
    });
  it('no thousands separators, no floats, rejects fractions', () => {
    expect(paiseToRupees('100000000')).not.toMatch(/,/);
    expect(paiseToRupees('12.5')).toBeNull();
  });
});

describe('formula escaping and RFC 4180 quoting', () => {
  it.each(['=SUM(A1)', '+91', '-5', '@cmd', '\tTAB', '\rCR'])('a cell starting %j gets a leading apostrophe', (v) => {
    expect(escapeFormula(v)).toBe(`'${v}`);
    expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
  });
  it('plain text is unchanged; comma, quote, CR and LF are quoted; inner quotes doubled', () => {
    expect(escapeFormula('Synthetic Payer')).toBe('Synthetic Payer');
    expect(quoteCell('a,b')).toBe('"a,b"');
    expect(quoteCell('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCell('a\nb')).toBe('"a\nb"');
    expect(quoteCell('a\rb')).toBe('"a\rb"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
  });
});

describe('file format', () => {
  it('UTF-8 BOM, CRLF, the 30 columns in contract order (23 Phase 1 + 7 Phase 2), file name tripnavigate-<exportNo>.csv', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(CSV_EOL).toBe('\r\n');
    expect(CSV_COLUMNS.map((c) => c.header)).toEqual(HEADERS);
    expect(csvHeaderLine()).toBe(`${HEADERS.join(',')}\r\n`);
    expect(csvFileName('TE-2026-000012')).toBe('tripnavigate-TE-2026-000012.csv');
    expect(HEADERS.map((x) => x.toLowerCase())).not.toContain('matched');
  });
  it('a line masks PAN and mobile again and escapes formulas; values land in column order', () => {
    const line = csvLine({ exportNo: 'TE-2026-000001', line: '1', party: '=HYPERLINK("x")', pan: 'ABCDE1234F', mobile: '6000043210', amount: '25000.00' });
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).not.toContain('ABCDE1234F');
    expect(line).not.toContain('6000043210');
    expect(line).toContain('XXXXX1234X');
    expect(line).toContain('XXXXXX3210');
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line.split(',').length).toBeGreaterThanOrEqual(23);
    expect(line.startsWith('TE-2026-000001,1,')).toBe(true);
  });
});
