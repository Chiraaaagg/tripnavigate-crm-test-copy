import { CSV_COLUMNS, type CsvLineValues } from './contracts';

/**
 * CSV evidence pack (contract 7.4), pure. Not a Tally import format.
 * - PAN ABCDE1234F -> XXXXX1234X; mobile 6000043210 -> XXXXXX3210 (the
 *   database stores lines already masked with the same rule; the route masks
 *   again so an unmasked value can never leave).
 * - A cell whose first character is =, +, -, @, tab or carriage return gets a
 *   leading apostrophe (formula injection).
 * - RFC 4180 quoting, UTF-8 with BOM, CRLF line ends.
 * - Amounts: whole paise -> "1234.50", exact, unsigned, no separators.
 */

export const CSV_BOM = '﻿';
export const CSV_EOL = '\r\n';

export function maskPan(pan: string | null | undefined): string | null {
  if (!pan) return null;
  const p = pan.trim().toUpperCase();
  if (p.length !== 10) return null;
  return `XXXXX${p.slice(5, 9)}X`;
}

export function maskMobile(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `XXXXXX${digits.slice(-4)}`;
}

/** "123456" paise -> "1234.56"; null for anything that is not whole paise. */
export function paiseToRupees(paise: string | null | undefined): string | null {
  if (paise == null || !/^-?\d{1,18}$/.test(paise)) return null;
  const digits = paise.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Formula escaping: prefix a dangerous first character with an apostrophe. */
export function escapeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote a cell holding a comma, quote, CR or LF; double inner quotes. */
export function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvCell(value: string | null | undefined): string {
  if (value == null) return '';
  return quoteCell(escapeFormula(String(value)));
}

export function csvHeaderLine(): string {
  return CSV_COLUMNS.map((c) => csvCell(c.header)).join(',') + CSV_EOL;
}

/** One line from stored values; PAN and mobile are masked again (defence in depth). */
export function csvLine(values: Partial<CsvLineValues>): string {
  const safe: Partial<CsvLineValues> = { ...values, pan: remask(values.pan, maskPan), mobile: remask(values.mobile, maskMobile) };
  return CSV_COLUMNS.map((c) => csvCell(safe[c.key] ?? null)).join(',') + CSV_EOL;
}

function remask(value: string | null | undefined, mask: (v: string) => string | null): string | null {
  if (!value) return null;
  return /^X+[0-9A-Z]*$/.test(value) && value.startsWith('XXXXX') ? value : mask(value);
}

export function csvFileName(exportNo: string): string {
  return `tripnavigate-${exportNo.replace(/[^A-Za-z0-9-]/g, '')}.csv`;
}

/**
 * Narration column (Accounts phase 2, 8.2), the same rule as authz.tally_line_values: "Deal <Bitrix Deal ID or CRM
 * reference> | <CRM reference> | <record type> <reference>"; a row without a Deal gives "<record type> <reference>".
 * References only, never names.
 */
export function narration(v: { deal?: string | null; bitrixDealId?: string | null; recordType?: string | null; reference?: string | null }): string {
  const tail = `${v.recordType ?? ''}${v.reference ? ` ${v.reference}` : ''}`;
  if (!v.deal) return tail;
  return `Deal ${v.bitrixDealId ?? v.deal} | ${v.deal} | ${tail}`;
}
