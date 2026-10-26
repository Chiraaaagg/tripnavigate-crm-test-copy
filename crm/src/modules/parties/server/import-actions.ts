'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { GST_STATE_LIST } from '../gst-states';
import { CSV_ERROR_TEXT, CSV_LIMITS, decodeCsvBytes, parseCsv } from '../csv';
import { IMPORT_ACCESS_TEXT, importEntity } from '../import-access';
import { formulaRowsText, IMPORT_KINDS, importFields, importSummaryView, mappingBlockers, prepareRows, resolveMapping, type ImportKind, type ImportSummaryView } from '../import-mapping';
import { readUuidField } from '../party-forms';
import { applyImport, getImport, stageImport, validateImport } from './imports-db';
import { vnFail, vnFailFrom, type VnResult } from './party-results';

/**
 * Protected hotel and customer imports (voice-note batch, owner item 5).
 *
 * "Check file" (validateImportAction): requireStaff(); the caller's role for
 * this list (hotels: Super Admin; customers: Accounts) picks the one company;
 * the CSV is read here (size, rows, quotes, formulas), columns are mapped
 * without guessing, and the rows are staged and compared by the database
 * under the caller's own session. Nothing outside the import tables changes.
 *
 * "Import" (applyImportAction): a separate step with a reason; the database
 * re-checks the role and the rows under a lock and writes one audit row.
 * Imported records are Not checked. In this batch apply is used only on
 * disposable test stacks (owner answer 1: the real files come later).
 *
 * File contents and cell values are never logged.
 */

const FIELD = {
  kind: 'kind',
  file: 'file',
  requestId: 'requestId',
  batchId: 'batchId',
  reason: 'reason',
  column: 'column',
  columnField: 'columnField',
  branchScope: 'branchScope',
  branchId: 'branchId',
  batchRowVersion: 'batchRowVersion',
  proposalHash: 'proposalHash',
} as const;

const BRANCH_TEXT = 'Choose the branch the customers belong to, or Whole company. Nothing was imported.';

/**
 * Echo-A M1: where imported customers go. A branch (only that branch's Sales and Managers find them)
 * or, chosen explicitly, the whole company. Never a silent default; the database checks the branch
 * belongs to the company.
 */
function readBranchChoice(formData: FormData): { branchId: string | null; entityWide: boolean } | null {
  const scope = formData.get(FIELD.branchScope);
  if (scope === 'company') return { branchId: null, entityWide: true };
  if (scope === 'branch') {
    const id = readUuidField(formData, FIELD.branchId);
    return id ? { branchId: id, entityWide: false } : null;
  }
  return null;
}
const REASON = { min: 10, max: 500 } as const;

function revalidateImports(): void {
  revalidatePath('/app/admin/imports');
  revalidatePath('/app/accounts/customers');
}

function readKind(formData: FormData): ImportKind | null {
  const v = formData.get(FIELD.kind);
  return typeof v === 'string' && (IMPORT_KINDS as readonly string[]).includes(v) ? (v as ImportKind) : null;
}

/** A neutral, short display name for the uploaded file (never a path). */
function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'import.csv';
}

/** Staff's explicit column choices: repeated `column` + `columnField` pairs (field key or 'ignore'). */
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

export async function validateImportAction(_prev: VnResult<{ summary: ImportSummaryView }> | null, formData: FormData): Promise<VnResult<{ summary: ImportSummaryView }>> {
  const staff = await requireStaff();
  const kind = readKind(formData);
  const requestId = readUuidField(formData, FIELD.requestId);
  if (!kind || !requestId) return vnFail('invalid_input', [...(kind ? [] : [FIELD.kind]), ...(requestId ? [] : [FIELD.requestId])]);
  const entity = importEntity(staff.access, kind);
  if (!entity.ok) return vnFail('not_authorized', undefined, entity.reason === 'several' ? IMPORT_ACCESS_TEXT.several : IMPORT_ACCESS_TEXT.no_access[kind]);
  const branch = kind === 'customer' ? readBranchChoice(formData) : { branchId: null, entityWide: false };
  if (!branch) return vnFail('invalid_input', [FIELD.branchId], BRANCH_TEXT);
  const choices = readChoices(formData);
  if (choices === null) return vnFail('invalid_input', [FIELD.column], 'The column choices could not be read. Choose the columns again.');

  const file = formData.get(FIELD.file);
  if (!(file instanceof Blob) || file.size === 0) return vnFail('invalid_input', [FIELD.file], CSV_ERROR_TEXT.empty);
  if (file.size > CSV_LIMITS.maxBytes) return vnFail('invalid_input', [FIELD.file], CSV_ERROR_TEXT.too_large);
  const fileName = cleanFileName('name' in file && typeof file.name === 'string' ? file.name : '');
  if (!/\.csv$/i.test(fileName)) return vnFail('invalid_input', [FIELD.file], CSV_ERROR_TEXT.not_text);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) return vnFail('invalid_input', [FIELD.file], CSV_ERROR_TEXT[decoded.error.code]);
  const parsed = parseCsv(decoded.text);
  if (!parsed.ok) {
    const where = parsed.error.line ? ` (line ${parsed.error.line})` : '';
    return vnFail('invalid_input', [FIELD.file], `${CSV_ERROR_TEXT[parsed.error.code]}${where} Nothing was imported.`);
  }
  const table = parsed.table;
  if (table.rows.length === 0) return vnFail('invalid_input', [FIELD.file], 'This file has column names but no rows. Nothing was imported.');
  const mapping = resolveMapping(kind, table.headers, choices);
  const blockers = mappingBlockers(kind, mapping);
  if (blockers.length > 0) return vnFail('invalid_input', [FIELD.column], `${blockers.join(' ')} Known column names: ${importFields(kind).map((f) => f.label).join(', ')}. Nothing was imported.`);
  const prepared = prepareRows(kind, table, mapping, GST_STATE_LIST);
  if (prepared.formulaRows.length > 0) return vnFail('invalid_input', [FIELD.file], formulaRowsText(prepared.formulaRows));

  const rpc = asRpcClient(staff.supabase);
  try {
    const staged = await stageImport(rpc, {
      legalEntityId: entity.entityId,
      kind,
      branchId: branch.branchId,
      entityWide: branch.entityWide,
      fileName,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rows: prepared.rows,
      requestId,
    });
    const validation = await validateImport(rpc, staged.batchId);
    const detail = await getImport(rpc, { batchId: staged.batchId, limit: 200, offset: 0 }).catch(() => null);
    const summary = importSummaryView({ kind, fileName, headers: table.headers, mapping, validation, names: prepared.names, outcomes: detail?.rows ?? [] });
    revalidateImports();
    return { ok: true, data: { summary }, message: summary.applyBlockedReason ? 'File checked. Nothing was imported.' : 'File checked. Nothing is imported until you choose Import.' };
  } catch (error) {
    return vnFailFrom(error, { rows: FIELD.file, fileName: FIELD.file, kind: FIELD.kind });
  }
}

export async function applyImportAction(_prev: VnResult<{ applied: { creates: number; updates: number } }> | null, formData: FormData): Promise<VnResult<{ applied: { creates: number; updates: number } }>> {
  const staff = await requireStaff();
  const batchId = readUuidField(formData, FIELD.batchId);
  const requestId = readUuidField(formData, FIELD.requestId);
  // Echo-A L3: apply exactly the summary the screen showed (its batch version and proposal fingerprint).
  const rvRaw = formData.get(FIELD.batchRowVersion);
  const shownVersion = typeof rvRaw === 'string' && /^(0|[1-9][0-9]{0,8})$/.test(rvRaw) ? Number(rvRaw) : null;
  const hashRaw = formData.get(FIELD.proposalHash);
  const proposalHash = typeof hashRaw === 'string' && /^[0-9a-f]{64}$/.test(hashRaw) ? hashRaw : null;
  if (shownVersion === null) return vnFail('invalid_input', [FIELD.batchRowVersion], 'This check is no longer on screen. Check the file again, then import it. Nothing was imported.');
  const reasonRaw = formData.get(FIELD.reason);
  const reason = typeof reasonRaw === 'string' ? reasonRaw.replace(/\s+/g, ' ').trim() : '';
  const reasonOk = reason.length >= REASON.min && reason.length <= REASON.max;
  if (!batchId || !requestId || !reasonOk) {
    return vnFail('invalid_input', [...(batchId ? [] : [FIELD.batchId]), ...(requestId ? [] : [FIELD.requestId]), ...(reasonOk ? [] : [FIELD.reason])], reasonOk ? undefined : 'Write why you are importing this file (10 to 500 characters). Nothing was imported.');
  }
  const rpc = asRpcClient(staff.supabase);
  try {
    const current = await getImport(rpc, { batchId, limit: 1, offset: 0 });
    if (!current) return vnFail('not_found');
    const entity = importEntity(staff.access, current.batch.kind);
    if (!entity.ok) return vnFail('not_authorized', undefined, entity.reason === 'several' ? IMPORT_ACCESS_TEXT.several : IMPORT_ACCESS_TEXT.no_access[current.batch.kind]);
    // The row version the screen showed (never the current one): a re-check by someone else is refused as stale.
    const r = await applyImport(rpc, { batchId, expectedRowVersion: shownVersion, reason, proposalHash });
    revalidateImports();
    const skipped = r.skippedChecked + r.invalid;
    return {
      ok: true,
      data: { applied: { creates: r.created, updates: r.updated } },
      message: `Imported: ${r.created} new, ${r.updated} updated.${skipped > 0 ? ` ${skipped} ${skipped === 1 ? 'row was' : 'rows were'} left out (invalid or already checked).` : ''} Imported records are Not checked.`,
    };
  } catch (error) {
    return vnFailFrom(error, { reason: FIELD.reason });
  }
}
