'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  documentLinkTask,
  documentSetCreditLink,
  documentUnlinkTask,
  SupplierMoneyCommandError,
} from '@/modules/supplier-money/commands';
import {
  AccountsDeskCommandError,
  type ExportFields,
  setExceptionOwner,
  setTallyExportEnabled,
  tallyException,
  tallyExportCreate,
  tallyInvoiceAdd,
  tallyInvoiceWithdraw,
  tallyMatch,
  type TallyMappingFields,
  tallyMappingSet,
  tallyReopen,
  type TallyTarget,
} from '../commands';
import {
  ACCOUNTS_DESK_DONE_TEXT,
  ACCOUNTS_DESK_ERROR_TEXT,
  ACCOUNTS_DESK_FIELD as F,
  ACCOUNTS_DESK_PATHS,
  ACCOUNTS_DESK_UNKNOWN_OUTCOME_TEXT,
  type AccountsDeskActionResult,
  type AccountsDeskErrorCode,
  type RecordsFilter,
  type RecordsTotals,
  REOPEN_NEVER_EXPORTED_TEXT,
  TALLY_LEDGER_MAX,
  TALLY_RECORD_KINDS,
  TALLY_VOUCHER_MAX,
  type TallyMappingSetResult,
  tallyNameOk,
  type TallyCommandResult,
  type TallyExportCreated,
  type TallyInvoiceResult,
  type TallyRecordKind,
} from '../contracts';
import { recordsFilterFromParams } from '../filters';
import { loadRecordsTotals } from './queries';

/**
 * Accounts desk commands (one useActionState action per command). Every
 * action: requireStaff(); read the form (never the actor, entity, branch or
 * status); run the database command under the staff member's OWN session;
 * revalidate the Accounts pages and the Deal page. Messages are frozen
 * wording (contracts.ts); database messages never reach the browser and
 * nothing here logs amounts, references, reasons or names.
 */

type Prev<T> = AccountsDeskActionResult<T> | null;
type Failure = Extract<AccountsDeskActionResult<never>, { ok: false }>;

function fail(code: AccountsDeskErrorCode | 'session', values?: Record<string, string>, field?: string, message?: string): Failure {
  return {
    ok: false,
    code,
    message: message ?? ACCOUNTS_DESK_ERROR_TEXT[code],
    ...(field ? { field } : {}),
    ...(values ? { values } : {}),
  };
}

/** Known refusals become frozen text; anything else is rethrown without detail (the command may have committed). */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof AccountsDeskCommandError && error.code) {
    if (error.code === 'wrong_state' && (error.hint === 'notReopenable' || error.hint === 'neverExported')) {
      return fail('wrong_state', values, undefined, REOPEN_NEVER_EXPORTED_TEXT);
    }
    return fail(error.code, values, error.code === 'invalid_input' ? (error.hint ?? undefined) : undefined);
  }
  if (error instanceof SupplierMoneyCommandError && error.code && error.code in ACCOUNTS_DESK_ERROR_TEXT) {
    return fail(error.code as AccountsDeskErrorCode | 'session', values);
  }
  throw new Error(ACCOUNTS_DESK_UNKNOWN_OUTCOME_TEXT);
}

function revalidateDesk(dealId?: string | null): void {
  for (const path of ACCOUNTS_DESK_PATHS) revalidatePath(path);
  if (dealId) {
    revalidatePath(`/app/deals/${dealId}`);
    revalidatePath(`/app/accounts/deals/${dealId}`);
  } else {
    revalidatePath('/app/deals/[id]', 'page');
  }
  revalidatePath('/app/accounts/supplier-invoices');
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
  if (raw === null || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

function readTarget(formData: FormData): TallyTarget | null {
  const kind = str(formData, F.kind, 40);
  const recordId = readUuid(formData, F.recordId);
  const expectedRowVersion = readRowVersion(formData);
  if (!kind || !(TALLY_RECORD_KINDS as readonly string[]).includes(kind) || !recordId || expectedRowVersion === null) return null;
  return { kind: kind as TallyRecordKind, recordId, expectedRowVersion };
}

function readReason(formData: FormData): string | null {
  const reason = str(formData, F.reason, 500);
  return reason && reason.length >= 10 ? reason : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Tally matching (T1-T3)
// ---------------------------------------------------------------------------

/** Fields: kind, recordId, expectedRowVersion, voucherRef, voucherDate, requestId. */
export async function matchTallyRecordAction(_prev: Prev<TallyCommandResult>, formData: FormData): Promise<AccountsDeskActionResult<TallyCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.voucherRef, F.voucherDate]);
  const target = readTarget(formData);
  const requestId = readUuid(formData, F.requestId);
  const voucherRef = str(formData, F.voucherRef, 60);
  const voucherDate = str(formData, F.voucherDate, 10);
  if (!target || !requestId) return fail('invalid_input', values);
  if (!voucherRef) return fail('invalid_input', values, F.voucherRef);
  if (!voucherDate || !DATE.test(voucherDate)) return fail('invalid_input', values, F.voucherDate);
  try {
    const result = await tallyMatch(asRpcClient(staff.supabase), target, { voucherRef, voucherDate }, requestId);
    revalidateDesk();
    return { ok: true, data: result, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.matched };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: kind, recordId, expectedRowVersion, reason, tallyAmountRupees (optional), requestId. */
export async function raiseTallyExceptionAction(_prev: Prev<TallyCommandResult>, formData: FormData): Promise<AccountsDeskActionResult<TallyCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason, F.tallyAmountRupees]);
  const target = readTarget(formData);
  const requestId = readUuid(formData, F.requestId);
  const reason = readReason(formData);
  // Optional: refused only when something was typed and it is not a positive rupee amount.
  const amountRaw = (formData.get(F.tallyAmountRupees)?.toString() ?? '').trim();
  const amount = amountRaw === '' ? null : rupeesToPaise(amountRaw.slice(0, 24));
  if (!target || !requestId) return fail('invalid_input', values);
  if (!reason) return fail('invalid_input', values, F.reason);
  if (amountRaw !== '' && (!amount || amount === '0')) return fail('invalid_input', values, F.tallyAmountRupees);
  try {
    const result = await tallyException(asRpcClient(staff.supabase), target,
      amount ? { reason, tallyAmountPaise: amount } : { reason }, requestId);
    revalidateDesk();
    return { ok: true, data: result, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.exceptionRaised };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: kind, recordId, expectedRowVersion, reason, requestId. */
export async function reopenTallyRecordAction(_prev: Prev<TallyCommandResult>, formData: FormData): Promise<AccountsDeskActionResult<TallyCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const target = readTarget(formData);
  const requestId = readUuid(formData, F.requestId);
  const reason = readReason(formData);
  if (!target || !requestId) return fail('invalid_input', values);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await tallyReopen(asRpcClient(staff.supabase), target, reason, requestId);
    revalidateDesk();
    return { ok: true, data: result, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.reopened };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// GST invoice reference (T4-T5)
// ---------------------------------------------------------------------------

/** Fields: dealId, invoiceRef, invoiceDate, note (optional), requestId. */
export async function addTallyInvoiceAction(_prev: Prev<TallyInvoiceResult>, formData: FormData): Promise<AccountsDeskActionResult<TallyInvoiceResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.invoiceRef, F.invoiceDate, F.note]);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  const invoiceRef = str(formData, F.invoiceRef, 40);
  const invoiceDate = str(formData, F.invoiceDate, 10);
  const note = str(formData, F.note, 300);
  if (!dealId || !requestId) return fail('invalid_input', values);
  if (!invoiceRef || !/^[A-Za-z0-9/ .-]+$/.test(invoiceRef)) return fail('invalid_input', values, F.invoiceRef);
  if (!invoiceDate || !DATE.test(invoiceDate)) return fail('invalid_input', values, F.invoiceDate);
  try {
    const result = await tallyInvoiceAdd(asRpcClient(staff.supabase), dealId, { invoiceRef, invoiceDate, note }, requestId);
    revalidateDesk(dealId);
    return { ok: true, data: result, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.invoiceAdded };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: recordId (the GST reference id), expectedRowVersion, reason, dealId (for revalidation), requestId. */
export async function withdrawTallyInvoiceAction(_prev: Prev<TallyInvoiceResult>, formData: FormData): Promise<AccountsDeskActionResult<TallyInvoiceResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.recordId);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  const reason = readReason(formData);
  if (!id || !requestId || rowVersion === null) return fail('invalid_input', values);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await tallyInvoiceWithdraw(asRpcClient(staff.supabase), id, rowVersion, reason, requestId);
    revalidateDesk(dealId);
    return { ok: true, data: result, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.invoiceWithdrawn };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// Export (T8)
// ---------------------------------------------------------------------------

/** Fields: entityId, from, to, kinds (repeated or comma list), includeExported ('on'|'true'), branchIds (repeated, optional), requestId. */
export async function createTallyExportAction(_prev: Prev<TallyExportCreated>, formData: FormData): Promise<AccountsDeskActionResult<TallyExportCreated>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.from, F.to]);
  const entityId = readUuid(formData, F.entityId);
  const requestId = readUuid(formData, F.requestId);
  const from = str(formData, F.from, 10);
  const to = str(formData, F.to, 10);
  const kinds = [...new Set(formData.getAll(F.kinds).flatMap((v) => (typeof v === 'string' ? v.split(',') : [])).map((v) => v.trim()))]
    .filter((k): k is TallyRecordKind => (TALLY_RECORD_KINDS as readonly string[]).includes(k));
  const include = formData.get(F.includeExported);
  const branchIds = formData.getAll(F.branchIds).filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v));
  if (!entityId || !requestId) return fail('invalid_input', values);
  if (!from || !DATE.test(from)) return fail('invalid_input', values, F.from);
  if (!to || !DATE.test(to)) return fail('invalid_input', values, F.to);
  if (kinds.length === 0) return fail('invalid_input', values, F.kinds);
  const fields: ExportFields = {
    entityId, from, to, kinds, includeExported: include === 'on' || include === 'true',
    ...(branchIds.length ? { branchIds } : {}),
  };
  try {
    const result = await tallyExportCreate(asRpcClient(staff.supabase), fields, requestId);
    revalidateDesk();
    return { ok: true, data: result, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.exportCreated };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// Supplier bill links (S1-S3)
// ---------------------------------------------------------------------------

type LinkData = { linkId: string };

/** Fields: documentId, taskId, requestId. */
export async function linkSupplierDocumentAction(_prev: Prev<LinkData>, formData: FormData): Promise<AccountsDeskActionResult<LinkData>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, F.documentId);
  const taskId = readUuid(formData, F.taskId);
  const requestId = readUuid(formData, F.requestId);
  if (!documentId || !taskId || !requestId) return fail('invalid_input');
  try {
    const result = await documentLinkTask(asRpcClient(staff.supabase), documentId, taskId, requestId);
    revalidateDesk(result.dealId ?? null);
    revalidatePath(`/app/purchase/${taskId}`);
    return { ok: true, data: { linkId: result.linkId }, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.linked };
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: linkId, reason, requestId. */
export async function unlinkSupplierDocumentAction(_prev: Prev<LinkData>, formData: FormData): Promise<AccountsDeskActionResult<LinkData>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const linkId = readUuid(formData, F.linkId);
  const requestId = readUuid(formData, F.requestId);
  const reason = readReason(formData);
  if (!linkId || !requestId) return fail('invalid_input', values);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await documentUnlinkTask(asRpcClient(staff.supabase), linkId, reason, requestId);
    revalidateDesk();
    revalidatePath(`/app/purchase/${result.taskId}`);
    return { ok: true, data: { linkId: result.linkId }, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.unlinked };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: documentId (the credit note), invoiceId, requestId. */
export async function setCreditNoteLinkAction(_prev: Prev<{ documentId: string }>, formData: FormData): Promise<AccountsDeskActionResult<{ documentId: string }>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, F.documentId);
  const invoiceId = readUuid(formData, F.invoiceId);
  const requestId = readUuid(formData, F.requestId);
  if (!documentId || !requestId) return fail('invalid_input');
  if (!invoiceId) return fail('invalid_input', undefined, F.invoiceId);
  try {
    const result = await documentSetCreditLink(asRpcClient(staff.supabase), documentId, invoiceId, requestId);
    revalidateDesk();
    return { ok: true, data: { documentId: result.id }, message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.creditLinked };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Settings (T6-T7, policy manager)
// ---------------------------------------------------------------------------

/** Fields: entityId, userId (empty = clear), reason. */
export async function setExceptionOwnerAction(_prev: Prev<{ changed: boolean }>, formData: FormData): Promise<AccountsDeskActionResult<{ changed: boolean }>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.userId, F.reason]);
  const entityId = readUuid(formData, F.entityId);
  const rawUser = str(formData, F.userId, 36);
  const userId = rawUser ? readUuid(formData, F.userId) : null;
  const reason = readReason(formData);
  if (!entityId) return fail('invalid_input', values);
  if (rawUser && !userId) return fail('invalid_input', values, F.userId);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await setExceptionOwner(asRpcClient(staff.supabase), entityId, userId, reason);
    revalidatePath('/app/accounts/records');
    revalidatePath('/app/admin', 'layout');
    return { ok: true, data: { changed: result.changed }, message: userId ? ACCOUNTS_DESK_DONE_TEXT.ownerSet : ACCOUNTS_DESK_DONE_TEXT.ownerCleared };
  } catch (error) {
    if (error instanceof AccountsDeskCommandError && error.code === 'invalid_input' && error.hint) {
      return fail('invalid_input', values, error.hint);
    }
    return failFrom(error, values);
  }
}

/** Fields: entityId, enabled ('true'|'false'), reason. */
export async function setTallyExportEnabledAction(_prev: Prev<{ changed: boolean }>, formData: FormData): Promise<AccountsDeskActionResult<{ changed: boolean }>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const entityId = readUuid(formData, F.entityId);
  const enabled = str(formData, F.enabled, 5);
  const reason = readReason(formData);
  if (!entityId || (enabled !== 'true' && enabled !== 'false')) return fail('invalid_input', values);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await setTallyExportEnabled(asRpcClient(staff.supabase), entityId, enabled === 'true', reason);
    revalidatePath('/app/accounts/tally');
    revalidatePath('/app/admin', 'layout');
    return { ok: true, data: { changed: result.changed }, message: ACCOUNTS_DESK_DONE_TEXT.exportSwitched };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// Totals on demand ("Show totals", not on page load)
// ---------------------------------------------------------------------------

/** Fields: filter (the page's address query string, e.g. "kinds=receipt&from=2026-11-01"). */
export async function showRecordsTotalsAction(_prev: Prev<RecordsTotals>, formData: FormData): Promise<AccountsDeskActionResult<RecordsTotals>> {
  const staff = await requireStaff();
  const raw = formData.get('filter');
  const filter: RecordsFilter = recordsFilterFromParams(new URLSearchParams(typeof raw === 'string' ? raw.slice(0, 2000) : ''));
  const result = await loadRecordsTotals(staff, filter);
  if (!result.ok) return fail('invalid_input', undefined, result.invalid ?? undefined);
  if (!result.data) return fail('not_authorized');
  return { ok: true, data: result.data, message: '' };
}

// ---------------------------------------------------------------------------
// Tally ledger mapping (Accounts phase 2, 8.1 D2; Addendum L3 form shape)
// ---------------------------------------------------------------------------

/**
 * Fields: mappingId, expectedRowVersion, reason, requestId, and any of debitLedger, creditLedger, voucherType (a
 * present field sets the value; an empty field clears it; an absent field keeps it).
 */
export async function setTallyMappingAction(
  _prev: Prev<TallyMappingSetResult>,
  formData: FormData,
): Promise<AccountsDeskActionResult<TallyMappingSetResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.debitLedger, F.creditLedger, F.voucherType, F.reason]);
  const mappingId = readUuid(formData, F.mappingId);
  const requestId = readUuid(formData, F.requestId);
  const expectedRowVersion = readRowVersion(formData);
  if (!mappingId || !requestId || expectedRowVersion === null) return fail('invalid_input', values);
  const fields: TallyMappingFields = {};
  for (const [key, max] of [[F.debitLedger, TALLY_LEDGER_MAX], [F.creditLedger, TALLY_LEDGER_MAX], [F.voucherType, TALLY_VOUCHER_MAX]] as const) {
    const raw = formData.get(key);
    if (raw === null) continue;
    if (typeof raw !== 'string') return fail('invalid_input', values, key);
    const v = raw.trim();
    if (v !== '' && !tallyNameOk(v, max)) return fail('invalid_input', values, key);
    fields[key] = v === '' ? null : v;
  }
  if (Object.keys(fields).length === 0) return fail('invalid_input', values, F.debitLedger);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await tallyMappingSet(asRpcClient(staff.supabase), mappingId, expectedRowVersion, fields, reason, requestId);
    revalidatePath('/app/accounts/tally');
    revalidatePath('/app/admin', 'layout');
    return {
      ok: true,
      data: result,
      message: result.outcome === 'existing' ? ACCOUNTS_DESK_DONE_TEXT.existing : ACCOUNTS_DESK_DONE_TEXT.mappingSaved,
    };
  } catch (error) {
    return failFrom(error, values);
  }
}
