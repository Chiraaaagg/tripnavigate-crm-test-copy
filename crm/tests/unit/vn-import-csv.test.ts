import { describe, expect, it } from 'vitest';
import { CSV_LIMITS, decodeCsvBytes, looksLikeFormula, parseCsv, safeCellText } from '@/modules/parties/csv';
import { formulaRowsText, importSummaryView, prepareRows, resolveMapping, type ImportValidation } from '@/modules/parties/import-mapping';

/*
 * Voice-note batch: the CSV reader and the import mapping/validation summary
 * (pure). Made-up data only.
 */

const STATES = [
  { code: '08', name: 'Rajasthan' },
  { code: '07', name: 'Delhi' },
  { code: '24', name: 'Gujarat' },
];

function table(text: string) {
  const r = parseCsv(text);
  if (!r.ok) throw new Error(r.error.code);
  return r.table;
}

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    const t = table('﻿Name,City,Notes\r\n"Sunrise, Palace",Jodhpur,"Says ""hello""\r\nsecond line"\r\nLake View,Udaipur,\r\n');
    expect(t.headers).toEqual(['Name', 'City', 'Notes']);
    expect(t.rows).toEqual([
      ['Sunrise, Palace', 'Jodhpur', 'Says "hello"\r\nsecond line'],
      ['Lake View', 'Udaipur', ''],
    ]);
    expect(t.lines).toEqual([2, 4]);
  });
  it('pads short rows (Excel drops trailing empties), skips blank lines and rows of only commas', () => {
    const t = table('a,b,c\n1\n\n,,\n2,3,4\n');
    expect(t.rows).toEqual([
      ['1', '', ''],
      ['2', '3', '4'],
    ]);
    expect(t.ragged).toEqual([2]);
  });
  it('accepts a last row without a line end and LF-only files', () => {
    expect(table('x,y\n1,2').rows).toEqual([['1', '2']]);
  });
  it('refuses broken files with a plain code and the line', () => {
    expect(parseCsv('a,b\n"open,1\n')).toMatchObject({ ok: false, error: { code: 'unclosed_quote' } });
    expect(parseCsv('a,b\nab"c,1\n')).toMatchObject({ ok: false, error: { code: 'stray_quote', line: 2 } });
    expect(parseCsv('a,b\n"x"y,1\n')).toMatchObject({ ok: false, error: { code: 'stray_quote' } });
    expect(parseCsv('a,a\n1,2\n')).toMatchObject({ ok: false, error: { code: 'duplicate_header' } });
    expect(parseCsv('a,,b\n1,2,3\n')).toMatchObject({ ok: false, error: { code: 'blank_header', column: 2 } });
    expect(parseCsv('a,b\n1,2,3\n')).toMatchObject({ ok: false, error: { code: 'too_many_columns', line: 2 } });
    expect(parseCsv('a,b\n1\u0007,2\n')).toMatchObject({ ok: false, error: { code: 'control_character' } });
    expect(parseCsv('   \n')).toMatchObject({ ok: false, error: { code: 'empty' } });
  });
  it('keeps extra trailing commas when they are empty', () => {
    expect(table('a,b\n1,2,,\n').rows).toEqual([['1', '2']]);
  });
  it('enforces the row, column and cell limits', () => {
    const rows = Array.from({ length: 4 }, (_, i) => `r${i},x`).join('\n');
    expect(parseCsv(`a,b\n${rows}`, { maxRows: 3 })).toMatchObject({ ok: false, error: { code: 'too_many_rows' } });
    expect(parseCsv(`${Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',')}\n`)).toMatchObject({ ok: false, error: { code: 'too_many_columns' } });
    expect(parseCsv(`a\n${'x'.repeat(CSV_LIMITS.maxCellChars + 1)}\n`)).toMatchObject({ ok: false, error: { code: 'cell_too_long' } });
    expect(parseCsv(`a\n"${'x'.repeat(CSV_LIMITS.maxCellChars + 1)}"\n`)).toMatchObject({ ok: false, error: { code: 'cell_too_long' } });
  });
});

describe('decodeCsvBytes', () => {
  it('reads UTF-8 and refuses binary, invalid UTF-8, empty and oversize files', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('a\n₹1'))).toEqual({ ok: true, text: 'a\n₹1' });
    expect(decodeCsvBytes(new Uint8Array([0x61, 0x00, 0x62]))).toMatchObject({ ok: false, error: { code: 'not_text' } });
    expect(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x41]))).toMatchObject({ ok: false, error: { code: 'not_text' } });
    expect(decodeCsvBytes(new Uint8Array())).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(decodeCsvBytes(new Uint8Array(CSV_LIMITS.maxBytes + 1))).toMatchObject({ ok: false, error: { code: 'too_large' } });
  });
});

describe('formula-safe display', () => {
  it('neutralises formulas but keeps phone numbers and signed numbers', () => {
    expect(safeCellText('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCellText('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(safeCellText('+cmd|calc')).toBe(`'+cmd|calc`);
    expect(safeCellText('-2+3')).toBe(`'-2+3`);
    expect(safeCellText('+91 98765 43210')).toBe('+91 98765 43210');
    expect(safeCellText('-12.5')).toBe('-12.5');
    expect(safeCellText('Sunrise Palace')).toBe('Sunrise Palace');
    expect(looksLikeFormula('\t=1')).toBe(true);
  });
});

describe('resolveMapping', () => {
  it('maps known names only, lists unknown columns, and never picks an ambiguous name', () => {
    const m = resolveMapping('hotel', ['Hotel Name', 'CITY', 'Star_Rating', 'Owner mood', 'Hotel ID']);
    expect(m.columns).toEqual({ name: 0, city: 1, starCategory: 2, sourceRef: 4 });
    expect(m.unknownHeaders).toEqual(['Owner mood']);
    expect(m.complete).toBe(true);
  });
  it('lets staff choose or leave out a column; refuses two columns for one field and missing required ones', () => {
    const m = resolveMapping('hotel', ['Property', 'Place', 'Hotel'], { Place: 'city', Hotel: 'ignore' });
    expect(m.columns).toEqual({ name: 0, city: 1 });
    expect(m.ignoredHeaders).toEqual(['Hotel']);
    const dup = resolveMapping('hotel', ['Hotel', 'Hotel Name', 'City']);
    expect(dup.duplicateTargets).toEqual(['name']);
    expect(dup.complete).toBe(false);
    expect(resolveMapping('customer', ['Name']).missingRequired).toEqual(['partyType']);
    expect(resolveMapping('hotel', ['Hotel', 'City'], { Nope: 'city' }).invalidChoices).toEqual(['Nope']);
    expect(resolveMapping('hotel', ['Hotel', 'City'], { City: 'shoeSize' }).invalidChoices).toEqual(['City']);
  });
});

describe('prepareRows (customer)', () => {
  const csv = [
    'Customer ID,Type,Name,Phone,Email,Address,City,State,PIN,GST registered,GSTIN,Reason,Mood',
    'C-1,Business,Test   Traders,98765 43210,ACCOUNTS@EXAMPLE.TEST,1 Test Road,Jodhpur,Rajasthan,342 001,yes,08abcde1234f1z5,,happy',
    'C-2,personal,Asha Example,+44 7700 900123,,2 Test Lane,Delhi,7,110001,,,,',
    'C-3,firm,Odd Row,12345,bad-email,3 Road,Jaipur,Narnia,012345,maybe,,,',
    'C-4,business,GST Only,,,,Delhi,Delhi,110002,,07ABCDE1234F1Z5,,',
    'C-5,business,=cmd(),+cmd|x,,,,,,,,,',
  ].join('\n');
  const t = table(csv);
  const m = resolveMapping('customer', t.headers);
  const p = prepareRows('customer', t, m, STATES);
  it('maps to database keys and tidies typed values; never sends unmapped columns', () => {
    expect(p.rows[0]).toEqual({
      sourceRef: 'C-1', partyType: 'business', name: 'Test Traders', phone: '9876543210', email: 'accounts@example.test', addressLine1: '1 Test Road', city: 'Jodhpur',
      stateCode: '08', postalCode: '342001', gstStatus: 'registered', gstin: '08ABCDE1234F1Z5', gstReason: null,
    });
    expect(p.rows[1]).toMatchObject({ partyType: 'personal', phone: '+447700900123', stateCode: '07' });
    expect(p.rows[3]).toMatchObject({ gstStatus: 'registered', stateCode: '07' });
  });
  it('sends unreadable values as typed (the database names them), never drops or invents', () => {
    expect(p.rows[2]).toMatchObject({ partyType: 'firm', phone: '12345', email: 'bad-email', stateCode: 'Narnia', postalCode: '012345', gstStatus: 'maybe' });
  });
  it('finds formula cells (phones with + are fine) and says which rows', () => {
    expect(p.formulaRows).toEqual([5]);
    expect(formulaRowsText(p.formulaRows)).toContain('row 5');
    expect(p.names[4]).toBe(`'=cmd()`);
  });
});

describe('importSummaryView', () => {
  const headers = ['Hotel ID', 'Hotel name', 'City', 'Mood'];
  const m = resolveMapping('hotel', headers);
  const validation: ImportValidation = {
    batchId: 'b1', kind: 'hotel', status: 'validated', rows: 5, valid: 4, invalid: 1, duplicatesInFile: 0, possibleDuplicates: 1,
    proposed: { create: 2, update: 1, unchanged: 0, skippedChecked: 1 },
    invalidRows: [{ rowNo: 2, reasons: ['star_category_invalid', 'mystery_code'] }],
    duplicateRows: [{ rowNo: 4, sourceRef: null, kind: 'same_name' }],
    rowVersion: 1,
  };
  it('maps counts, reasons, duplicates and the proposed list into plain words', () => {
    const s = importSummaryView({ kind: 'hotel', fileName: 'hotels.csv', headers, mapping: m, validation, names: ['Lake View', 'Bad', 'Desert Camp', 'Lake View', 'Fort'], outcomes: [{ rowNo: 1, outcome: 'create' }, { rowNo: 3, outcome: 'update' }, { rowNo: 4, outcome: 'skipped_checked' }] });
    expect(s.counts).toEqual({ rows: 5, valid: 4, invalid: 1, duplicates: 1, creates: 2, updates: 1, unchanged: 0, skippedVerified: 1 });
    expect(s.invalidRows).toEqual([{ rowNo: 2, reasons: ['Star category must be a whole number from 1 to 7.', 'This row cannot be imported.'] }]);
    expect(s.duplicateRows[0]!.text).toMatch(/nothing is merged by name/);
    expect(s.proposed).toEqual([
      { rowNo: 1, action: 'create', name: 'Lake View', changes: [] },
      { rowNo: 3, action: 'update', name: 'Desert Camp', changes: [] },
    ]);
    expect(s.mapping).toEqual([
      { column: 'Hotel ID', field: 'Hotel ID (from your list)' },
      { column: 'Hotel name', field: 'Hotel name' },
      { column: 'City', field: 'City' },
      { column: 'Mood', field: null },
    ]);
    expect(s.applyBlockedReason).toBeNull();
  });
  it('rows read with an assumption are listed in plain words (they still import)', () => {
    const s = importSummaryView({ kind: 'hotel', fileName: 'f.csv', headers, mapping: m, validation: { ...validation, assumedRows: 2, rowNotes: [{ rowNo: 3, notes: ['gst_status_assumed_registered', 'state_code_padded'] }, { rowNo: 4, notes: ['unknown_note'] }] } });
    expect(s.assumedRows).toBe(2);
    expect(s.rowNotes).toEqual([{ rowNo: 3, text: 'GST registered was empty; read as registered because a GSTIN is given. State code had one digit; read with a leading 0.' }]);
  });
  it('blocks apply when nothing would change, after apply, or with a broken mapping', () => {
    expect(importSummaryView({ kind: 'hotel', fileName: 'f.csv', headers, mapping: m, validation: { ...validation, proposed: { create: 0, update: 0, unchanged: 3, skippedChecked: 1 } } }).applyBlockedReason).toMatch(/Nothing to import/);
    expect(importSummaryView({ kind: 'hotel', fileName: 'f.csv', headers, mapping: m, validation: { ...validation, status: 'applied' } }).applyBlockedReason).toMatch(/already imported/);
    const noCity = resolveMapping('hotel', ['Hotel name']);
    const s = importSummaryView({ kind: 'hotel', fileName: '=x.csv', headers: ['Hotel name'], mapping: noCity, validation });
    expect(s.applyBlockedReason).toMatch(/Add a column for: City/);
    expect(s.fileName).toBe(`'=x.csv`);
  });
});

describe('synthetic sample files (tests/fixtures/imports)', () => {
  const read = async (name: string) => {
    const { readFile } = await import('node:fs/promises');
    const bytes = new Uint8Array(await readFile(new URL(`../fixtures/imports/${name}`, import.meta.url)));
    const d = decodeCsvBytes(bytes);
    if (!d.ok) throw new Error(d.error.code);
    return table(d.text);
  };
  it('hotels: multi-line cell kept, unknown column listed, rows mapped in file order', async () => {
    const t = await read('hotels-sample.csv');
    const m = resolveMapping('hotel', t.headers);
    expect(m.complete).toBe(true);
    expect(m.unknownHeaders).toEqual(['Phone']);
    const p = prepareRows('hotel', t, m, STATES);
    expect(p.rows).toHaveLength(8);
    expect(p.rows[2]!.name).toBe('Test "Desert" Camp');
    expect(p.rows[3]!.address).toBe('4 Test Garden Road, Near Test Gate');
    expect(p.formulaRows).toEqual([]);
  });
  it('customers: BOM read, state names become codes, GST answers tidied', async () => {
    const t = await read('customers-sample.csv');
    expect(t.headers[0]).toBe('Customer ID');
    const m = resolveMapping('customer', t.headers);
    expect(m.complete).toBe(true);
    expect(m.unknownHeaders).toEqual([]);
    const p = prepareRows('customer', t, m, STATES);
    expect(p.rows[0]).toMatchObject({ partyType: 'business', stateCode: '08', gstStatus: 'registered', phone: '9876500011' });
    expect(p.rows[2]).toMatchObject({ gstStatus: 'unregistered', stateCode: '24' });
  });
  it('formula and missing-column samples are refused before staging', async () => {
    const f = await read('formula-sample.csv');
    expect(prepareRows('hotel', f, resolveMapping('hotel', f.headers), STATES).formulaRows).toEqual([1]);
    const mc = await read('missing-column-sample.csv');
    expect(resolveMapping('hotel', mc.headers).missingRequired).toEqual(['city']);
  });
});
