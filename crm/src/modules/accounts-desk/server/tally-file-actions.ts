'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import { AccountsDeskCommandError } from '../commands';
import {
  ACCOUNTS_DESK_ERROR_TEXT,
  ACCOUNTS_DESK_UNKNOWN_OUTCOME_TEXT,
  type AccountsDeskErrorCode,
  TALLY_FILE_DONE_TEXT,
  TALLY_FILE_ERROR_TEXT,
  TALLY_FILE_KINDS,
  TF_FIELD as F,
  type TallyFileCreated,
  type TallyFileErrorCode,
  type TallyFilePreview,
  type TallyMatchApplied,
  type TallyMatchBatch,
  type TallyPartyName,
  type TallyXmlSettingResult,
  tallyNameOk,
} from '../contracts';
import { DAYBOOK_MAX_BYTES, parseDayBook, TallyDayBookError } from '../tally-daybook';
import {
  partyTallyNameSet,
  setTallyXml,
  type TallyFileArgs,
  tallyFileCreate,
  tallyFilePreview,
  tallyMatchApply,
  tallyMatchCancel,
  tallyMatchStage,
  type TallyMatchUploadRow,
} from '../tally-file';

/**
 * Tally import file and matching upload actions (Accounts phase 3, contract 7; Phase 2 Addendum L3 form shape:
 * (prev, formData) => {ok: true, message, data?} | {ok: false, code, message, field?}). Every action: requireStaff();
 * read the form (never the actor, the entity's rights or a status); run the database command under the staff
 * member's OWN session (Accounts only; C2 policy managers). Messages are frozen wording; database messages never
 * reach the browser; nothing here logs references, amounts, names or file contents. The CRM never contacts Tally.
 */

export type TallyFileActionResult<T> =
  | { ok: true; data?: T; message: string }
  | { ok: false; code: TallyFileErrorCode | 'session'; message: string; field?: string; values?: Record<string, string> };

type Prev<T> = TallyFileActionResult<T> | null;
type Failure = Extract<TallyFileActionResult<never>, { ok: false }>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TALLY_PATH = '/app/accounts/tally';

function text(code: TallyFileErrorCode | 'session'): string {
  if (code === 'nothing_to_export' || code === 'already_recorded' || code === 'file_refused' || code === 'tally_xml_off') {
    return TALLY_FILE_ERROR_TEXT[code];
  }
  return ACCOUNTS_DESK_ERROR_TEXT[code as AccountsDeskErrorCode | 'session'];
}

function fail(code: TallyFileErrorCode | 'session', values?: Record<string, string>, field?: string, message?: string): Failure {
  return { ok: false, code, message: message ?? text(code), ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

/** Known refusals become frozen text; anything else is rethrown without detail (the command may have committed). */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof AccountsDeskCommandError && error.code) {
    if (error.code === 'invalid_input' && error.hint === 'includeReason') {
      return fail('invalid_input', values, F.includeReason, TALLY_FILE_ERROR_TEXT.include_reason);
    }
    return fail(error.code, values, error.code === 'invalid_input' ? (error.hint ?? undefined) : undefined);
  }
  throw new Error(ACCOUNTS_DESK_UNKNOWN_OUTCOME_TEXT);
}

function str(formData: FormData, name: string, max: number): string | null {
  const value = formData.get(name);
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' || v.length > max ? null : v;
}

function typed(formData: FormData, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = formData.get(n);
    if (typeof v === 'string') out[n] = v.slice(0, 600);
  }
  return out;
}

function readRowVersion(formData: FormData): number | null {
  const raw = str(formData, F.expectedRowVersion, 10);
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/** entityId, from, to, kinds (repeated or comma list; none = every kind), branchIds (repeated, optional). */
function readArgs(formData: FormData, values: Record<string, string>): TallyFileArgs | Failure {
  const entityId = readUuid(formData, F.entityId);
  const from = str(formData, F.from, 10);
  const to = str(formData, F.to, 10);
  const raw = formData.getAll(F.kinds).flatMap((v) => (typeof v === 'string' ? v.split(',') : [])).map((v) => v.trim()).filter(Boolean);
  const kinds = [...new Set(raw)];
  const branchIds = formData.getAll(F.branchIds).filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v));
  if (!entityId) return fail('invalid_input', values);
  if (!from || !DATE.test(from)) return fail('invalid_input', values, F.from);
  if (!to || !DATE.test(to)) return fail('invalid_input', values, F.to);
  if (kinds.some((k) => !(TALLY_FILE_KINDS as readonly string[]).includes(k))) return fail('invalid_input', values, F.kinds);
  return { entityId, from, to, kinds: kinds.length ? kinds : null, branchIds: branchIds.length ? branchIds : null };
}

// ---------------------------------------------------------------------------
// Making the file (R-C2, C3)
// ---------------------------------------------------------------------------

/** "Show what goes in" (R-C2). Fields: entityId, from, to, kinds, branchIds. Not audited. */
export async function previewTallyFileAction(_prev: Prev<TallyFilePreview>, formData: FormData): Promise<TallyFileActionResult<TallyFilePreview>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.from, F.to]);
  const args = readArgs(formData, values);
  if ('ok' in args) return args;
  try {
    const data = await tallyFilePreview(asRpcClient(staff.supabase), args);
    if (!data) return fail('not_authorized', values);
    return { ok: true, data, message: 'Checked.' };
  } catch (error) {
    return failFrom(error, values);
  }
}

/**
 * "Make Tally file" (C3). Fields: entityId, from, to, kinds, branchIds, includeAgain ('on'|'true'), includeReason
 * (10..500, required with includeAgain), requestId. On nothing_to_export the result carries the preview (the
 * left-out list with the reasons) in `values`-free `data`.
 */
export async function createTallyFileAction(
  _prev: Prev<TallyFileCreated | TallyFilePreview>,
  formData: FormData,
): Promise<TallyFileActionResult<TallyFileCreated | TallyFilePreview>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.from, F.to, F.includeReason]);
  const args = readArgs(formData, values);
  if ('ok' in args) return args;
  const requestId = readUuid(formData, F.requestId);
  if (!requestId) return fail('invalid_input', values);
  const includeRaw = formData.get(F.includeAgain);
  const includeAgain = includeRaw === 'on' || includeRaw === 'true';
  const reason = str(formData, F.includeReason, 500);
  if (includeAgain && (!reason || reason.length < 10)) {
    return fail('invalid_input', values, F.includeReason, TALLY_FILE_ERROR_TEXT.include_reason);
  }
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await tallyFileCreate(rpc, { ...args, includeAgain, includeReason: includeAgain ? reason : null }, requestId);
    revalidatePath(TALLY_PATH);
    revalidatePath('/app/accounts/records');
    return { ok: true, data: result, message: result.outcome === 'existing' ? TALLY_FILE_DONE_TEXT.existing : TALLY_FILE_DONE_TEXT.fileCreated };
  } catch (error) {
    if (error instanceof AccountsDeskCommandError && error.code === 'nothing_to_export') {
      // The left-out list is still shown (contract 7.3): the same selection, read again.
      let preview: TallyFilePreview | null = null;
      try {
        preview = await tallyFilePreview(rpc, args);
      } catch {
        preview = null;
      }
      return { ...fail('nothing_to_export', values), ...(preview ? { data: preview } : {}) } as Failure;
    }
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// Matching upload (C4-C6)
// ---------------------------------------------------------------------------

function safeFileName(name: string): string {
   
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'daybook.xml').slice(0, 200);
}

/** "Upload Tally vouchers" (C4). Fields: entityId, file (the Day Book XML), requestId. The file is parsed here and never stored. */
export async function stageTallyMatchAction(_prev: Prev<TallyMatchBatch>, formData: FormData): Promise<TallyFileActionResult<TallyMatchBatch>> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, F.entityId);
  const requestId = readUuid(formData, F.requestId);
  const file = formData.get(F.file);
  if (!entityId || !requestId) return fail('invalid_input');
  if (!(file instanceof File) || file.size === 0) return fail('invalid_input', undefined, F.file);
  if (file.size > DAYBOOK_MAX_BYTES) return fail('file_refused', undefined, F.file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let rows: TallyMatchUploadRow[];
  try {
    const book = parseDayBook(bytes);
    if (book.vouchers.length === 0) return fail('file_refused', undefined, F.file);
    rows = book.vouchers.map((v) => ({
      tnTag: v.tnTag,
      voucherRef: v.voucherNumber,
      voucherDate: v.date,
      voucherType: v.voucherType && v.voucherType.length <= 60 ? v.voucherType : null,
      amountPaise: v.amountPaise,
    }));
    if (rows.some((r) => r.voucherRef.length > 60 || /[\u0000-\u001f\u007f]/.test(r.voucherRef) || r.amountPaise.length > 15)) {
      return fail('file_refused', undefined, F.file);
    }
  } catch (error) {
    if (error instanceof TallyDayBookError) return fail('file_refused', undefined, F.file);
    throw error;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    const batch = await tallyMatchStage(asRpcClient(staff.supabase), entityId, safeFileName(file.name), sha256, rows, requestId);
    const { outcome, ...data } = batch;
    revalidatePath(TALLY_PATH);
    return { ok: true, data, message: outcome === 'existing' ? TALLY_FILE_DONE_TEXT.existing : TALLY_FILE_DONE_TEXT.staged };
  } catch (error) {
    return failFrom(error);
  }
}

/** "Apply" (C5). Fields: batchId, expectedProposalHash, requestId. */
export async function applyTallyMatchAction(_prev: Prev<TallyMatchApplied>, formData: FormData): Promise<TallyFileActionResult<TallyMatchApplied>> {
  const staff = await requireStaff();
  const batchId = readUuid(formData, F.batchId);
  const requestId = readUuid(formData, F.requestId);
  const hash = str(formData, F.proposalHash, 64);
  if (!batchId || !requestId || !hash || !/^[0-9a-f]{64}$/.test(hash)) return fail('invalid_input');
  try {
    const result = await tallyMatchApply(asRpcClient(staff.supabase), batchId, hash, requestId);
    revalidatePath(TALLY_PATH);
    revalidatePath('/app/accounts/records');
    return {
      ok: true,
      data: result,
      message: result.outcome === 'existing' ? TALLY_FILE_DONE_TEXT.existing
        : `${TALLY_FILE_DONE_TEXT.applied} ${result.matched} matched, ${result.exceptions} sent to the exception owner.`,
    };
  } catch (error) {
    return failFrom(error);
  }
}

/** "Cancel" (C6). Fields: batchId, requestId. */
export async function cancelTallyMatchAction(_prev: Prev<{ batchId: string }>, formData: FormData): Promise<TallyFileActionResult<{ batchId: string }>> {
  const staff = await requireStaff();
  const batchId = readUuid(formData, F.batchId);
  const requestId = readUuid(formData, F.requestId);
  if (!batchId || !requestId) return fail('invalid_input');
  try {
    const result = await tallyMatchCancel(asRpcClient(staff.supabase), batchId, requestId);
    revalidatePath(TALLY_PATH);
    return { ok: true, data: { batchId: result.batchId }, message: TALLY_FILE_DONE_TEXT.cancelled };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Party name (C1) and switch (C2)
// ---------------------------------------------------------------------------

/** Tally party name of a customer party (C1). Fields: partyId, expectedRowVersion, name (blank clears), requestId. */
export async function setPartyTallyNameAction(_prev: Prev<TallyPartyName>, formData: FormData): Promise<TallyFileActionResult<TallyPartyName>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.name]);
  const partyId = readUuid(formData, F.partyId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  const raw = formData.get(F.name);
  const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (!partyId || !requestId || rowVersion === null) return fail('invalid_input', values);
  if (name !== null && !tallyNameOk(name, 100)) return fail('invalid_input', values, F.name);
  try {
    const { outcome, ...data } = await partyTallyNameSet(asRpcClient(staff.supabase), partyId, rowVersion, name, requestId);
    revalidatePath(TALLY_PATH);
    return { ok: true, data, message: outcome === 'existing' ? TALLY_FILE_DONE_TEXT.existing : TALLY_FILE_DONE_TEXT.partyNamed };
  } catch (error) {
    return failFrom(error, values);
  }
}

/**
 * Settings › Accounts: the Tally file switch and company name (C2, finance policy managers).
 * Fields: entityId, enabled ('true'|'false'), companyName (blank keeps the saved name), reason (10..500).
 */
export async function setTallyXmlAction(_prev: Prev<TallyXmlSettingResult>, formData: FormData): Promise<TallyFileActionResult<TallyXmlSettingResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.companyName, F.reason]);
  const entityId = readUuid(formData, F.entityId);
  const enabled = str(formData, F.enabled, 5);
  const companyName = str(formData, F.companyName, 100);
  const reason = str(formData, F.reason, 500);
  if (!entityId || (enabled !== 'true' && enabled !== 'false')) return fail('invalid_input', values);
   
  if (companyName !== null && /[\u0000-\u001f\u007f]/.test(companyName)) return fail('invalid_input', values, F.companyName);
  if (!reason || reason.length < 10) return fail('invalid_input', values, F.reason);
  try {
    const result = await setTallyXml(asRpcClient(staff.supabase), entityId, enabled === 'true', companyName, reason);
    revalidatePath(TALLY_PATH);
    revalidatePath('/app/admin', 'layout');
    return { ok: true, data: result, message: TALLY_FILE_DONE_TEXT.xmlSwitched };
  } catch (error) {
    if (error instanceof AccountsDeskCommandError && error.code === 'invalid_input' && error.hint === 'companyName') {
      return fail('invalid_input', values, F.companyName, 'Type the Tally company name exactly as it appears in TallyPrime (1 to 100 characters).');
    }
    return failFrom(error, values);
  }
}
