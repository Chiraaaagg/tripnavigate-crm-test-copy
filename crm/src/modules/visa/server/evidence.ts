'use server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { requireStaff } from '@/modules/identity/server/session';
import { VisaCommandError, visaApplicationSetRow, visaDocumentFileBegin, visaEvidenceBegin, visaEvidenceFinish } from '../commands';
import {
  type VisaActionResult,
  VISA_DONE_TEXT,
  VISA_ERROR_TEXT,
  VISA_EVIDENCE_BUCKET,
  VISA_EVIDENCE_MAX_BYTES,
  VISA_FIELD,
  VISA_UNKNOWN_OUTCOME_TEXT,
} from '../contracts';
import { readPositiveInt, readText, readUuid } from '../forms';
import { fail, failFrom, revalidateVisa } from './results';

/**
 * Visa desk file uploads (contract 6.11 and 10). The database authorizes the
 * actor (the task's Visa assignee), checks the file rules and generates the
 * object path; only then the privileged client stores the bytes (Storage
 * only), and department_evidence_finish records the outcome. Downloads stay
 * on the existing audited department evidence route.
 *
 *   uploadVisaDocumentFileAction  "Upload" on a passenger's document (C11);
 *                                 a stored file then marks the document
 *                                 received (C2) when it was not and the
 *                                 passenger is not applied yet. Two
 *                                 transactions: a refused second step keeps
 *                                 the file and says so.
 *   uploadVisaEvidenceAction      fee receipt, decision proof (visa or
 *                                 refusal document) or other task file;
 *                                 answers the evidence id the popups then
 *                                 post as receiptEvidenceId / outcomeEvidenceId.
 */

type UploadResult = { evidenceId: string; markedReceived: boolean };
type Prev<T> = VisaActionResult<T> | null;

const UPLOAD_KINDS = ['fee_receipt', 'authority_outcome', 'applicant_document', 'other'] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

async function readFile(formData: FormData) {
  const file = formData.get(VISA_FIELD.file);
  if (!(file instanceof Blob) || file.size === 0 || file.size > VISA_EVIDENCE_MAX_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  return check.ok ? { bytes, check } : null;
}

/** Storage write + finish; 'stored' only when the database recorded it stored. */
async function storeAndFinish(rpc: RpcClient, begun: { evidenceId: string; objectPath: string }, bytes: Uint8Array, mime: string): Promise<'stored' | 'failed' | 'unknown'> {
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(VISA_EVIDENCE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  if (!stored) {
    await visaEvidenceFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    return 'failed';
  }
  try {
    const status = (await visaEvidenceFinish(rpc, begun.evidenceId, true)).status;
    return status === 'stored' ? 'stored' : status === 'failed' || status === 'removed' ? 'failed' : 'unknown';
  } catch {
    // The finish may have committed; never claim an outcome we did not see.
    return 'unknown';
  }
}

/**
 * Upload against one document (fields taskId, dealId?, applicationId, documentId,
 * expectedRowVersion, documentStatus, file). When the document was not received,
 * the stored file marks it received with request id = the new file's id
 * (unique per upload, so a retry of the same upload replays exactly).
 */
export async function uploadVisaDocumentFileAction(_prev: Prev<UploadResult>, formData: FormData): Promise<VisaActionResult<UploadResult>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const dealId = readUuid(formData, VISA_FIELD.dealId);
  const applicationId = readUuid(formData, VISA_FIELD.applicationId);
  const documentId = readUuid(formData, VISA_FIELD.documentId);
  const expectedRowVersion = readPositiveInt(formData, VISA_FIELD.expectedRowVersion);
  const wasReceived = (readText(formData, VISA_FIELD.documentStatus) ?? '').trim() === 'received';
  if (!taskId || !applicationId || !documentId || !expectedRowVersion) {
    return fail('invalid_input', [!taskId ? VISA_FIELD.taskId : !applicationId ? VISA_FIELD.applicationId : !documentId ? VISA_FIELD.documentId : VISA_FIELD.expectedRowVersion]);
  }
  const file = await readFile(formData);
  if (!file) return fail('evidence_rejected', [VISA_FIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await visaDocumentFileBegin(rpc, {
      documentId, fileName: file.check.fileName, mime: file.check.mime, sizeBytes: file.check.sizeBytes, sha256: file.check.sha256,
    });
  } catch (error) {
    return failFrom(error);
  }
  const outcome = await storeAndFinish(rpc, begun, file.bytes, file.check.mime);
  revalidateVisa(taskId, dealId);
  if (outcome === 'failed') return fail('upload_failed');
  if (outcome === 'unknown') throw new Error(VISA_UNKNOWN_OUTCOME_TEXT);

  if (wasReceived) return { ok: true, data: { evidenceId: begun.evidenceId, markedReceived: false }, message: VISA_DONE_TEXT.fileStored };
  try {
    await visaApplicationSetRow(rpc, {
      applicationId, expectedRowVersion, fields: { documents: [{ documentId, received: true }] }, requestId: begun.evidenceId,
    });
    revalidateVisa(taskId, dealId);
    return { ok: true, data: { evidenceId: begun.evidenceId, markedReceived: true }, message: VISA_DONE_TEXT.fileStoredReceived };
  } catch (error) {
    // The file is stored either way; say why the tick did not happen (harmless second step).
    const reason = error instanceof VisaCommandError && error.code ? VISA_ERROR_TEXT[error.code] : VISA_UNKNOWN_OUTCOME_TEXT;
    return { ok: true, data: { evidenceId: begun.evidenceId, markedReceived: false }, message: VISA_DONE_TEXT.fileStoredNotMarked.replace('{reason}', reason) };
  }
}

/**
 * Fee receipt (kind fee_receipt), decision proof (authority_outcome) or another
 * task file (fields taskId, dealId?, applicationId?, kind, file). The receipt of
 * a clubbed Applied is uploaded once with no applicationId and backs every line.
 */
export async function uploadVisaEvidenceAction(_prev: Prev<{ evidenceId: string }>, formData: FormData): Promise<VisaActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const dealId = readUuid(formData, VISA_FIELD.dealId);
  const applicationRaw = (readText(formData, VISA_FIELD.applicationId) ?? '').trim();
  const applicationId = applicationRaw === '' ? null : readUuid(formData, VISA_FIELD.applicationId);
  const kindRaw = (readText(formData, VISA_FIELD.kind) ?? '').trim();
  const kind = (UPLOAD_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as UploadKind) : null;
  if (!taskId || !kind || (applicationRaw !== '' && !applicationId)) {
    return fail('invalid_input', [!taskId ? VISA_FIELD.taskId : !kind ? VISA_FIELD.kind : VISA_FIELD.applicationId]);
  }
  const file = await readFile(formData);
  if (!file) return fail('evidence_rejected', [VISA_FIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await visaEvidenceBegin(rpc, {
      taskId, applicationId, kind, fileName: file.check.fileName, mime: file.check.mime, sizeBytes: file.check.sizeBytes, sha256: file.check.sha256,
    });
  } catch (error) {
    return failFrom(error);
  }
  const outcome = await storeAndFinish(rpc, begun, file.bytes, file.check.mime);
  revalidateVisa(taskId, dealId);
  if (outcome === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: VISA_DONE_TEXT.fileStored };
  if (outcome === 'failed') return fail('upload_failed');
  throw new Error(VISA_UNKNOWN_OUTCOME_TEXT);
}
