/*
 * CSV reader for the protected hotel and customer imports (Terra, voice-note
 * batch, 24 October 2026). The owner exports the lists from Excel as CSV, so
 * this reads RFC 4180 CSV as Excel writes it: comma separated, fields in
 * double quotes when they hold a comma, quote or line break, a doubled quote
 * inside a quoted field, CRLF or LF line ends, and an optional UTF-8 byte
 * order mark. No new dependency; pure functions (no server imports) so the
 * same rules can be tested and reused.
 *
 * Safety:
 *   - size, row, column and cell limits are checked while reading, so a huge
 *     or malformed file stops early with a plain reason;
 *   - a cell is never evaluated; `safeCellText` neutralises spreadsheet
 *     formulas (leading = + - @ tab or carriage return) before a value is
 *     shown or written back out, so a later export cannot run a formula;
 *   - control characters other than tab and line breaks are refused.
 * Cell values are never logged by this module.
 */

/** Limits of one import file. The server action body limit is 5 MB, so the file stays well under it. */
export const CSV_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  /** Data rows (the header row is not counted). */
  maxRows: 5000,
  maxColumns: 40,
  maxCellChars: 1000,
  maxHeaderChars: 80,
} as const;

export type CsvErrorCode =
  | 'empty'
  | 'too_large'
  | 'not_text'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'cell_too_long'
  | 'unclosed_quote'
  | 'stray_quote'
  | 'control_character'
  | 'no_header'
  | 'blank_header'
  | 'duplicate_header'
  | 'header_too_long';

/** Plain words for staff (never the cell value). */
export const CSV_ERROR_TEXT: Record<CsvErrorCode, string> = {
  empty: 'This file is empty. Choose the CSV file you saved from Excel.',
  too_large: 'This file is over 2 MB. Split the list into smaller files and import them one at a time.',
  not_text: 'This file is not a CSV text file. In Excel, use File > Save As > CSV UTF-8, then choose that file.',
  too_many_rows: 'This file has more than 5,000 rows. Split the list into smaller files and import them one at a time.',
  too_many_columns: 'This file has more than 40 columns. Remove the columns you do not need and try again.',
  cell_too_long: 'A cell in this file is longer than 1,000 characters. Shorten it and try again.',
  unclosed_quote: 'A quoted cell in this file is never closed. Save the file again from Excel as CSV and try again.',
  stray_quote: 'A cell in this file has a quote mark in the wrong place. Save the file again from Excel as CSV and try again.',
  control_character: 'This file contains hidden control characters. Save it again from Excel as CSV UTF-8 and try again.',
  no_header: 'The first row must hold the column names.',
  blank_header: 'A column in the first row has no name. Name every column or delete the empty one.',
  duplicate_header: 'Two columns in the first row have the same name. Rename one of them.',
  header_too_long: 'A column name in the first row is longer than 80 characters.',
};

export interface CsvError {
  code: CsvErrorCode;
  /** 1-based line of the file where reading stopped (header = line 1); null for whole-file problems. */
  line: number | null;
  /** 1-based column, when known. */
  column: number | null;
}

export interface CsvTable {
  /** Column names as written in the first row (trimmed). */
  headers: string[];
  /** Data rows; each has exactly headers.length cells (short rows padded with ''). */
  rows: string[][];
  /** 1-based file line of each data row's first line (for staff-facing row numbers). */
  lines: number[];
  /** Data rows whose cell count differed from the header (padded or trimmed only when the extra cells were empty). */
  ragged: number[];
}

export type CsvResult = { ok: true; table: CsvTable } | { ok: false; error: CsvError };

const fail = (code: CsvErrorCode, line: number | null = null, column: number | null = null): CsvResult => ({ ok: false, error: { code, line, column } });

// Any C0 control except tab (9), line feed (10) and carriage return (13), plus DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Bytes of an uploaded file to text. Only UTF-8 (with or without BOM) is
 * accepted; invalid UTF-8 or a binary file (NUL bytes) is refused rather
 * than read as garbage.
 */
export function decodeCsvBytes(bytes: Uint8Array): { ok: true; text: string } | { ok: false; error: CsvError } {
  if (bytes.byteLength === 0) return { ok: false, error: { code: 'empty', line: null, column: null } };
  if (bytes.byteLength > CSV_LIMITS.maxBytes) return { ok: false, error: { code: 'too_large', line: null, column: null } };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, error: { code: 'not_text', line: null, column: null } };
  }
  if (text.includes('\u0000')) return { ok: false, error: { code: 'not_text', line: null, column: null } };
  return { ok: true, text };
}

/**
 * Reads CSV text into a header and data rows. Completely blank lines are
 * skipped; a row with fewer cells than the header is padded with '' (Excel
 * drops trailing empty cells); a row with more cells is refused unless the
 * extra cells are empty.
 */
export function parseCsv(input: string, limits: Partial<Record<keyof typeof CSV_LIMITS, number>> = {}): CsvResult {
  const L = { ...CSV_LIMITS, ...limits };
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length > L.maxBytes) return fail('too_large');
  if (text.trim() === '') return fail('empty');

  const records: Array<{ cells: string[]; line: number }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false; // inside a quoted field
  let wasQuoted = false; // the current field started with a quote (and it has closed)
  let wasQuotedRecord = false; // some field of the current record was quoted (so "" alone is not a blank line)
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const n = text.length;

  const endCell = (): CsvError | null => {
    if (cell.length > L.maxCellChars) return { code: 'cell_too_long', line: recordLine, column: cells.length + 1 };
    cells.push(cell);
    cell = '';
    wasQuoted = false;
    if (cells.length > L.maxColumns) return { code: 'too_many_columns', line: recordLine, column: cells.length };
    return null;
  };
  const endRecord = (): CsvError | null => {
    const blank = cells.length === 1 && cells[0] === '' && !wasQuotedRecord;
    if (!blank) {
      records.push({ cells, line: recordLine });
      // Header + maxRows data rows.
      if (records.length > L.maxRows + 1) return { code: 'too_many_rows', line: recordLine, column: null };
    }
    cells = [];
    return null;
  };
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        wasQuoted = true;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      else if (ch === '\r') {
        if (text[i + 1] !== '\n') line += 1;
      } else if (CONTROL.test(ch)) return fail('control_character', line, cells.length + 1);
      cell += ch;
      if (cell.length > L.maxCellChars) return fail('cell_too_long', recordLine, cells.length + 1);
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A quote may only open a field; Excel never writes one mid-field unquoted.
      if (cell !== '' || wasQuoted) return fail('stray_quote', line, cells.length + 1);
      quoted = true;
      wasQuotedRecord = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      const e = endCell();
      if (e) return { ok: false, error: e };
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const e = endCell() ?? endRecord();
      if (e) return { ok: false, error: e };
      wasQuotedRecord = false;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    if (wasQuoted) return fail('stray_quote', line, cells.length + 1);
    if (CONTROL.test(ch)) return fail('control_character', line, cells.length + 1);
    cell += ch;
    if (cell.length > L.maxCellChars) return fail('cell_too_long', recordLine, cells.length + 1);
    i += 1;
  }
  if (quoted) return fail('unclosed_quote', recordLine, cells.length + 1);
  if (cell !== '' || cells.length > 0 || wasQuoted) {
    const e = endCell() ?? endRecord();
    if (e) return { ok: false, error: e };
  }

  const [head, ...data] = records;
  if (!head) return fail('empty');
  const headers = head.cells.map((h) => h.trim());
  // Excel may leave trailing empty header cells: drop them only when every data cell under them is empty too.
  while (headers.length > 0 && headers[headers.length - 1] === '' && data.every((r) => (r.cells[headers.length - 1] ?? '').trim() === '')) headers.pop();
  if (headers.length === 0) return fail('no_header', head.line);
  const seen = new Set<string>();
  for (let c = 0; c < headers.length; c += 1) {
    const h = headers[c]!;
    if (h === '') return fail('blank_header', head.line, c + 1);
    if (h.length > L.maxHeaderChars) return fail('header_too_long', head.line, c + 1);
    const key = h.toLowerCase();
    if (seen.has(key)) return fail('duplicate_header', head.line, c + 1);
    seen.add(key);
  }

  const rows: string[][] = [];
  const lines: number[] = [];
  const ragged: number[] = [];
  for (const r of data) {
    let row = r.cells;
    if (row.every((c) => c.trim() === '')) continue; // a row of only commas
    if (row.length !== headers.length) {
      if (row.length > headers.length) {
        if (row.slice(headers.length).some((c) => c.trim() !== '')) return fail('too_many_columns', r.line, headers.length + 1);
        row = row.slice(0, headers.length);
      } else {
        row = [...row, ...Array.from({ length: headers.length - row.length }, () => '')];
      }
      ragged.push(r.line);
    }
    rows.push(row);
    lines.push(r.line);
  }
  return { ok: true, table: { headers, rows, lines, ragged } };
}

/**
 * Spreadsheet formula injection (CSV injection): a cell that starts with
 * = + - @ tab or carriage return can run as a formula when the list is
 * opened in Excel again. Plain signed numbers and phone numbers ("+91 98765
 * 43210", "-12.5") stay as they are; anything else gets a leading apostrophe,
 * which Excel shows as text. Use it for every value shown back to staff or
 * written into a file.
 */
export function safeCellText(value: string): string {
  if (value === '') return value;
  const first = value[0]!;
  if (first === '=' || first === '@' || first === '\t' || first === '\r') return `'${value}`;
  if ((first === '+' || first === '-') && !/^[+-][\d\s().-]*$/.test(value)) return `'${value}`;
  return value;
}

/** True when the value would be read as a formula by a spreadsheet (see safeCellText). */
export function looksLikeFormula(value: string): boolean {
  return safeCellText(value) !== value;
}
