'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import { CSV_ERROR_TEXT, CSV_LIMITS, decodeCsvBytes, parseCsv } from '@/modules/parties/csv';
import { IMPORT_ACCESS_TEXT, RATE_SHEET_NO_ACCESS_TEXT, rateSheetEntity } from '@/modules/parties/import-access';
import { importFields, mappingBlockers, prepareRateSheetRows, resolveMapping } from '@/modules/parties/import-mapping';
import { RateCommandError, rateSheetApply, rateSheetGet, rateSheetStage, rateSheetValidate } from '../commands';
import { RATE_ERROR_TEXT, type RateActionResult, type RateErrorCode } from '../contracts';
import type { RateSheetRow } from '../dto';

/**
 * Rate-sheet import (contract 9.4, LD22; kind 'rate_sheet' of the shared
 * import commands). "Check file": requireStaff(); Purchase or Super Admin of
 * one company; the CSV is read here (size, rows, quotes, formulas) and mapped
 * without guessing; the rows are staged and checked by the database under the
 * caller's own session (nothing outside the import tables changes). "Import":
 * a separate step with a reason; the database re-checks everything under a
 * lock and creates DRAFT contracts only (a Manager approves each one).
 * Cell values are never logged.
 */

const FIELD = {
  file: 'file', requestId: 'requestId', batchId: 'batchId', reason: 'reason', column: 'column', columnField: 'columnField',
  batchRowVersion: 'batchRowVersion', proposalHash: 'proposalHash',
} as const;
const SHOWN_ROWS = 200;

export interface RateSheetCheckView {
  batchId: string;
  rowVersion: number;
  proposalHash: string | null;
  fileName: string;
  rowCount: number;
  contracts: number;
  lines: number;
  newRoomTypes: number;
  invalidRows: number;
  warnings: { newRoomType: number; overlapsActiveContract: number };
  /** The first 200 rows with their outcome, reasons, warnings and values. */
  rows: RateSheetRow[];
  moreRows: number;
  /** Columns of the file that are not imported (never guessed). */
  unknownHeaders: string[];
}

type Failure = Extract<RateActionResult<never>, { ok: false }>;
const bad = (field: string, message: string): Failure => ({ ok: false, code: 'invalid_input', message, field });

function failFrom(error: unknown): Failure {
  if (error instanceof RateCommandError && error.code) {
    const code: RateErrorCode | 'session' = error.code;
    return { ok: false, code, message: RATE_ERROR_TEXT[code] };
  }
  return { ok: false, code: 'unexpected', message: RATE_ERROR_TEXT.unexpected };
}

function readChoices(formData: FormData): Record<string, string> | null {
  const cols = formData.getAll(FIELD.column);
  const targets = formData.getAll(FIELD.columnField);
  if (cols.length !== targets.length || cols.length > CSV_LIMITS.maxColumns) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[i];
    const t = targets[i];
    if (typeof c !== 'string' || typeof t !== 'string' || c.length > CSV_LIMITS.maxHeaderChars || t.length > 40) return null;
    if (t.trim() !== '') out[c.trim()] = t.trim();
  }
  return out;
}

function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'rate-sheet.csv';
}

export async function checkRateSheetAction(_prev: RateActionResult<RateSheetCheckView> | null, formData: FormData): Promise<RateActionResult<RateSheetCheckView>> {
  const staff = await requireStaff();
  const requestId = readUuid(formData, FIELD.requestId);
  if (!requestId) return bad(FIELD.requestId, RATE_ERROR_TEXT.invalid_input);
  const entity = rateSheetEntity(staff.access);
  if (!entity.ok) return { ok: false, code: 'not_authorized', message: entity.reason === 'several' ? IMPORT_ACCESS_TEXT.several : RATE_SHEET_NO_ACCESS_TEXT };
  const choices = readChoices(formData);
  if (choices === null) return bad(FIELD.column, 'The column choices could not be read. Choose the columns again.');

  const file = formData.get(FIELD.file);
  if (!(file instanceof Blob) || file.size === 0) return bad(FIELD.file, CSV_ERROR_TEXT.empty);
  if (file.size > CSV_LIMITS.maxBytes) return bad(FIELD.file, CSV_ERROR_TEXT.too_large);
  const fileName = cleanFileName('name' in file && typeof file.name === 'string' ? file.name : '');
  if (!/\.csv$/i.test(fileName)) return bad(FIELD.file, CSV_ERROR_TEXT.not_text);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) return bad(FIELD.file, CSV_ERROR_TEXT[decoded.error.code]);
  const parsed = parseCsv(decoded.text);
  if (!parsed.ok) return bad(FIELD.file, `${CSV_ERROR_TEXT[parsed.error.code]}${parsed.error.line ? ` (line ${parsed.error.line})` : ''} Nothing was imported.`);
  const table = parsed.table;
  if (table.rows.length === 0) return bad(FIELD.file, 'This file has column names but no rows. Nothing was imported.');
  const mapping = resolveMapping('rate_sheet', table.headers, choices);
  const blockers = mappingBlockers('rate_sheet', mapping);
  if (blockers.length > 0) {
    return bad(FIELD.column, `${blockers.join(' ')} Known column names: ${importFields('rate_sheet').map((f) => f.label).join(', ')}. Nothing was imported.`);
  }
  const prepared = prepareRateSheetRows(table, mapping);
  if (prepared.formulaRows.length > 0) {
    return bad(FIELD.file, `Rows ${prepared.formulaRows.slice(0, 10).join(', ')} have a cell that starts like a spreadsheet formula. Remove it and check the file again. Nothing was imported.`);
  }

  const rpc = asRpcClient(staff.supabase);
  try {
    const staged = await rateSheetStage(rpc, {
      legalEntityId: entity.entityId, fileName, sha256: createHash('sha256').update(bytes).digest('hex'), rows: prepared.rows, requestId,
    });
    const v = await rateSheetValidate(rpc, staged.batchId);
    const detail = await rateSheetGet(rpc, { batchId: staged.batchId, limit: SHOWN_ROWS, offset: 0 });
    const rs = v.rateSheet ?? { contracts: 0, lines: 0, newRoomTypes: 0, invalidRows: v.invalid ?? 0, warnings: { newRoomType: 0, overlapsActiveContract: 0 } };
    revalidatePath('/app/admin/imports');
    const data: RateSheetCheckView = {
      batchId: v.batchId, rowVersion: v.rowVersion, proposalHash: v.proposalHash ?? null, fileName: v.fileName, rowCount: v.rows,
      contracts: rs.contracts, lines: rs.lines, newRoomTypes: rs.newRoomTypes, invalidRows: rs.invalidRows, warnings: rs.warnings,
      rows: detail?.rows ?? [], moreRows: Math.max(0, v.rows - SHOWN_ROWS), unknownHeaders: mapping.unknownHeaders,
    };
    return { ok: true, data, message: rs.contracts > 0 ? 'File checked. Nothing is imported until you choose Import.' : 'File checked. No contract can be made from it.' };
  } catch (error) {
    return failFrom(error);
  }
}

export async function applyRateSheetAction(_prev: RateActionResult<{ contracts: number; lines: number; roomTypes: number }> | null, formData: FormData):
  Promise<RateActionResult<{ contracts: number; lines: number; roomTypes: number }>> {
  const staff = await requireStaff();
  const batchId = readUuid(formData, FIELD.batchId);
  const rvRaw = formData.get(FIELD.batchRowVersion);
  const rowVersion = typeof rvRaw === 'string' && /^(0|[1-9][0-9]{0,8})$/.test(rvRaw) ? Number(rvRaw) : null;
  const hashRaw = formData.get(FIELD.proposalHash);
  const proposalHash = typeof hashRaw === 'string' && /^[0-9a-f]{64}$/.test(hashRaw) ? hashRaw : null;
  const reasonRaw = formData.get(FIELD.reason);
  const reason = typeof reasonRaw === 'string' ? reasonRaw.replace(/\s+/g, ' ').trim() : '';
  if (!batchId || rowVersion === null) return bad(FIELD.batchRowVersion, 'This check is no longer on screen. Check the file again, then import it. Nothing was imported.');
  if (reason.length < 10 || reason.length > 500) return bad(FIELD.reason, 'Write why you are importing this file (10 to 500 characters). Nothing was imported.');
  try {
    const r = await rateSheetApply(asRpcClient(staff.supabase), { batchId, expectedRowVersion: rowVersion, reason, proposalHash });
    revalidatePath('/app/admin/imports');
    revalidatePath('/app/purchase/rate-contracts');
    return {
      ok: true,
      data: { contracts: r.created, lines: r.lines ?? 0, roomTypes: r.roomTypes ?? 0 },
      message: `Imported as ${r.created} draft ${r.created === 1 ? 'contract' : 'contracts'} with ${r.lines ?? 0} rate lines${r.invalid > 0 ? `; ${r.invalid} ${r.invalid === 1 ? 'row was' : 'rows were'} left out` : ''}. A Manager must approve each contract before it is used.`,
    };
  } catch (error) {
    return failFrom(error);
  }
}
