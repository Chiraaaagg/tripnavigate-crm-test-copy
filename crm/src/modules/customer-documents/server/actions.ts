'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import { runOnlineCustomerRenderJob } from '@/modules/documents/server/render-online';
import {
  DocumentCommandError,
  cancel,
  discard,
  draftCreate,
  linkTally,
  refresh,
  release,
  renderRetry,
  replace,
  setAutoBills,
  setDocumentsEnabled,
  type DraftSource,
} from '../commands';
import {
  DOCUMENT_DONE_TEXT,
  DOCUMENT_ERROR_TEXT,
  DOCUMENT_FIELD as F,
  DOCUMENT_KINDS,
  DOCUMENT_PATHS,
  DOCUMENT_UNKNOWN_OUTCOME_TEXT,
  NOT_READY_REASON_TEXT,
  NUMBER_CONFLICT_TEXT,
  WRONG_STATE_REASON_TEXT,
  type AutoBillsSwitchResult,
  type DocumentActionResult,
  type DocumentCommandResult,
  type DocumentErrorCode,
  type DocumentKind,
  type DocumentsSwitchResult,
  type RenderRetryResult,
} from '../contracts';

/**
 * Customer document commands (contract 6.7), one useActionState action per
 * command, in the Addendum L3 shape: (prev, formData) -> {ok, message, data?}
 * | {ok: false, code, message, field?}. Every action: requireStaff(); read the
 * form (camelCase contract names; never the actor, entity, branch or status);
 * run the database command under the staff member's OWN session; revalidate
 * the Accounts documents pages and the Deal page. Messages are frozen wording
 * (contracts.ts); database messages never reach the browser and nothing here
 * logs amounts, references, reasons or names.
 *
 * Release schedules one run of the online PDF maker with after() (contract
 * 6.8; it does nothing while PDF_RENDER_ONLINE is not "on").
 */

type Prev<T> = DocumentActionResult<T> | null;
type Failure = Extract<DocumentActionResult<never>, { ok: false }>;

function fail(code: DocumentErrorCode | 'session', values?: Record<string, string>, field?: string, message?: string): Failure {
  return { ok: false, code, message: message ?? DOCUMENT_ERROR_TEXT[code], ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

/** Known refusals become frozen text (with the reason line of not_ready / wrong_state); anything else is rethrown without detail. */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof DocumentCommandError && error.code) {
    const hint = error.hint ?? '';
    if (error.code === 'not_ready' && NOT_READY_REASON_TEXT[hint]) {
      return fail('not_ready', values, undefined, `${DOCUMENT_ERROR_TEXT.not_ready} ${NOT_READY_REASON_TEXT[hint]}`);
    }
    if (error.code === 'wrong_state' && WRONG_STATE_REASON_TEXT[hint]) return fail('wrong_state', values, undefined, WRONG_STATE_REASON_TEXT[hint]);
    const other = /^otherDealReference=([A-Za-z0-9._/-]{1,60})$/.exec(hint)?.[1];
    if (error.code === 'number_conflict' && other) return fail('number_conflict', values, undefined, NUMBER_CONFLICT_TEXT.replace('{reference}', other));
    return fail(error.code, values, error.code === 'invalid_input' ? hint || undefined : undefined);
  }
  throw new Error(DOCUMENT_UNKNOWN_OUTCOME_TEXT);
}

function revalidateDocuments(dealId?: string | null): void {
  for (const path of DOCUMENT_PATHS) revalidatePath(path);
  if (dealId) revalidatePath(`/app/deals/${dealId}`);
  else revalidatePath('/app/deals/[id]', 'page');
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

function readReason(formData: FormData): string | null {
  const reason = str(formData, F.reason, 500);
  return reason && reason.length >= 10 ? reason : null;
}

const done = <T extends { outcome: string }>(data: T, message: string): DocumentActionResult<T> =>
  ({ ok: true, data, message: data.outcome === 'existing' ? DOCUMENT_DONE_TEXT.existing : message });

/** Fields: dealId, kind, receiptId | refundRequestId | replacesDocumentId (by kind; none for a first Invoice), requestId. */
export async function createDocumentDraftAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  const kind = str(formData, F.kind, 20);
  if (!dealId || !requestId) return fail('invalid_input');
  if (!kind || !(DOCUMENT_KINDS as readonly string[]).includes(kind)) return fail('invalid_input', undefined, F.kind);
  const receiptId = readUuid(formData, F.receiptId);
  const refundRequestId = readUuid(formData, F.refundRequestId);
  const replacesDocumentId = readUuid(formData, F.replacesDocumentId);
  let source: DraftSource;
  if (replacesDocumentId) source = { replacesDocumentId };
  else if (kind === 'advance_invoice') {
    if (!receiptId) return fail('invalid_input', undefined, F.receiptId);
    source = { receiptId };
  } else if (kind === 'credit_note') {
    if (!refundRequestId) return fail('invalid_input', undefined, F.refundRequestId);
    source = { refundRequestId };
  } else source = {};
  try {
    const result = await draftCreate(asRpcClient(staff.supabase), dealId, kind as DocumentKind, source, requestId);
    revalidateDocuments(dealId);
    return done(result, DOCUMENT_DONE_TEXT.drafted);
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: documentId, expectedRowVersion, dealId (revalidation), requestId. */
export async function refreshDocumentAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, F.documentId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  if (!documentId || !requestId || rowVersion === null) return fail('invalid_input');
  try {
    const result = await refresh(asRpcClient(staff.supabase), documentId, rowVersion, requestId);
    revalidateDocuments(result.dealId);
    return done(result, DOCUMENT_DONE_TEXT.refreshed);
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: documentId, expectedRowVersion, expectedContentSha256 (the hash of the preview shown), requestId. */
export async function releaseDocumentAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, F.documentId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  const sha = str(formData, F.expectedContentSha256, 64);
  if (!documentId || !requestId || rowVersion === null) return fail('invalid_input');
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return fail('invalid_input', undefined, F.expectedContentSha256);
  try {
    const result = await release(asRpcClient(staff.supabase), documentId, rowVersion, sha, requestId);
    revalidateDocuments(result.dealId);
    // One online PDF run after the response (no-op while the maker is off).
    after(async () => {
      await runOnlineCustomerRenderJob().catch(() => undefined);
    });
    return done(result, DOCUMENT_DONE_TEXT.released.replace('{number}', result.number ?? ''));
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: documentId, expectedRowVersion, reason, requestId. */
export async function discardDocumentAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  return reasonCommand(formData, discard, DOCUMENT_DONE_TEXT.discarded);
}

/** Fields: documentId, expectedRowVersion, reason, requestId. */
export async function cancelDocumentAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  return reasonCommand(formData, cancel, DOCUMENT_DONE_TEXT.cancelled);
}

/** Fields: documentId, expectedRowVersion, reason, requestId. Result data = the new replacement draft. */
export async function replaceDocumentAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  return reasonCommand(formData, replace, DOCUMENT_DONE_TEXT.replaceStarted);
}

async function reasonCommand(
  formData: FormData,
  run: typeof discard,
  message: string,
): Promise<DocumentActionResult<DocumentCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const documentId = readUuid(formData, F.documentId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  const reason = readReason(formData);
  if (!documentId || !requestId || rowVersion === null) return fail('invalid_input', values);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await run(asRpcClient(staff.supabase), documentId, rowVersion, reason, requestId);
    revalidateDocuments(result.dealId);
    return done(result, message.replace('{number}', result.number ?? ''));
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: documentId, tallyInvoiceId (empty = remove from a draft), expectedRowVersion, requestId. */
export async function linkTallyInvoiceAction(_prev: Prev<DocumentCommandResult>, formData: FormData): Promise<DocumentActionResult<DocumentCommandResult>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, F.documentId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  const rawTally = str(formData, F.tallyInvoiceId, 60);
  const tallyInvoiceId = rawTally === null ? null : readUuid(formData, F.tallyInvoiceId);
  if (!documentId || !requestId || rowVersion === null) return fail('invalid_input');
  if (rawTally !== null && !tallyInvoiceId) return fail('invalid_input', undefined, F.tallyInvoiceId);
  try {
    const result = await linkTally(asRpcClient(staff.supabase), documentId, tallyInvoiceId, rowVersion, requestId);
    revalidateDocuments(result.dealId);
    return done(result, tallyInvoiceId ? DOCUMENT_DONE_TEXT.tallyLinked : DOCUMENT_DONE_TEXT.tallyCleared);
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: documentId, dealId (revalidation), requestId. */
export async function retryDocumentPdfAction(_prev: Prev<RenderRetryResult>, formData: FormData): Promise<DocumentActionResult<RenderRetryResult>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, F.documentId);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!documentId || !requestId) return fail('invalid_input');
  try {
    const result = await renderRetry(asRpcClient(staff.supabase), documentId, requestId);
    revalidateDocuments(dealId);
    after(async () => {
      await runOnlineCustomerRenderJob().catch(() => undefined);
    });
    return done(result, DOCUMENT_DONE_TEXT.renderRetried);
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: entityId, enabled ('true' | 'false'), reason. Policy manager (Super Admin without Accounts). */
export async function setCustomerDocumentsEnabledAction(_prev: Prev<DocumentsSwitchResult>, formData: FormData): Promise<DocumentActionResult<DocumentsSwitchResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const entityId = readUuid(formData, F.entityId);
  const enabledRaw = str(formData, F.enabled, 5);
  const reason = readReason(formData);
  if (!entityId) return fail('invalid_input', values);
  if (enabledRaw !== 'true' && enabledRaw !== 'false') return fail('invalid_input', values, F.enabled);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await setDocumentsEnabled(asRpcClient(staff.supabase), entityId, enabledRaw === 'true', reason);
    revalidatePath('/app/admin/accounts');
    revalidateDocuments(null);
    return { ok: true, data: result, message: result.changed ? DOCUMENT_DONE_TEXT.switched : DOCUMENT_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error, values);
  }
}

/**
 * Accounts phase 3, B1 (Settings > Accounts): automatic bill drafts and
 * automatic release. Fields: entityId, drafts ('true' | 'false'), release
 * ('true' | 'false'), reason. Finance policy managers only (the database refuses
 * everyone else).
 */
export async function setAutoBillsAction(_prev: Prev<AutoBillsSwitchResult>, formData: FormData): Promise<DocumentActionResult<AutoBillsSwitchResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const entityId = readUuid(formData, F.entityId);
  const drafts = str(formData, F.drafts, 5);
  const releaseOn = str(formData, F.release, 5);
  if (!entityId || (drafts !== 'true' && drafts !== 'false') || (releaseOn !== 'true' && releaseOn !== 'false')) return fail('invalid_input', values);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, F.reason);
  try {
    const result = await setAutoBills(asRpcClient(staff.supabase), entityId, drafts === 'true', releaseOn === 'true', reason);
    revalidatePath('/app/admin/accounts');
    revalidateDocuments();
    return { ok: true, data: result, message: result.changed ? DOCUMENT_DONE_TEXT.switched : DOCUMENT_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error, values);
  }
}
