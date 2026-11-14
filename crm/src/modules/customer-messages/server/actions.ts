'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  MessageCommandError,
  boardingPassBegin,
  boardingPassFinish,
  boardingPassSlotLink,
  markVoucherReady,
  pilotDealLookup,
  resendMessage,
  restartWhatsapp,
  setDealMessagePrefs,
  setMessageSwitch,
  setPilotDeal,
  setPilotOnly,
  setTemplateStatus,
  setTimerEnabled,
  voucherBegin,
  voucherFinish,
  type FileInput,
  type PrefsFields,
} from '../commands';
import {
  ADMIN_MESSAGES_PATH,
  CHANNELS,
  MESSAGE_ERROR_TEXT,
  MESSAGE_FIELD as F,
  MESSAGE_TYPES,
  MESSAGE_UNKNOWN_OUTCOME_TEXT,
  BOARDING_PASS_NOT_LINKED_TEXT,
  NOT_FOUND_DEAL_TEXT,
  NOT_READY_HINT_TEXT,
  TEMPLATE_STATUSES,
  type Channel,
  type MessageActionResult,
  type MessageErrorCode,
  type MessageType,
  type TemplateStatus,
} from '../contracts';
import { scheduleCustomerMessageDispatch } from './dispatch';

/**
 * Customer message commands (contract 5.3, 5.6, 5.9), one useActionState
 * action per command in the Phase 2 Addendum L3 shape:
 * (prev, formData) -> {ok, message, data?} | {ok: false, code, message, field?}.
 * Every action: requireStaff(); read the form (never the actor, entity of
 * the actor, branch or status); run the command under the staff member's own
 * session; revalidate. Messages are frozen wording; database messages never
 * reach the browser; nothing here logs a value.
 */

type Prev<T> = MessageActionResult<T> | null;
type Failure = Extract<MessageActionResult<never>, { ok: false }>;

function fail(code: MessageErrorCode | 'session' | 'upload_failed', field?: string, message?: string): Failure {
  return { ok: false, code, message: message ?? MESSAGE_ERROR_TEXT[code], ...(field ? { field } : {}) };
}

function failFrom(error: unknown): Failure {
  if (error instanceof MessageCommandError && error.code) {
    const hint = error.hint ?? '';
    if (error.code === 'not_ready' && NOT_READY_HINT_TEXT[hint]) {
      return fail('not_ready', undefined, `${MESSAGE_ERROR_TEXT.not_ready} ${NOT_READY_HINT_TEXT[hint]}`);
    }
    return fail(error.code, error.code === 'invalid_input' ? hint || undefined : undefined);
  }
  throw new Error(MESSAGE_UNKNOWN_OUTCOME_TEXT);
}

function str(formData: FormData, name: string, max: number): string | null {
  const value = formData.get(name);
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' || v.length > max ? null : v;
}

function bool(formData: FormData, name: string): boolean | undefined {
  const value = formData.get(name);
  if (value === null) return undefined;
  return value === 'true' || value === 'on' || value === '1';
}

function rowVersion(formData: FormData): number | null {
  const raw = str(formData, F.expectedRowVersion, 10);
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function reason(formData: FormData, min: number, max: number): string | null {
  const r = str(formData, F.reason, max);
  return r && r.length >= min ? r : null;
}

function revalidateDeal(dealId: string | null): void {
  if (dealId) revalidatePath(`/app/deals/${dealId}`);
  else revalidatePath('/app/deals/[id]', 'page');
}

/** A1. Fields: dealId, expectedRowVersion, requestId, and any of language, whatsappMobile, whatsappSameAsMobile, emailOverride, whatsappOff, emailOff, offReason. */
export async function setDealMessagePrefsAction(_prev: Prev<{ rowVersion: number }>, formData: FormData): Promise<MessageActionResult<{ rowVersion: number }>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  const expected = rowVersion(formData);
  if (!dealId || !requestId || expected === null) return fail('invalid_input');
  const fields: PrefsFields = {};
  const language = str(formData, F.language, 2);
  if (language !== null) {
    if (language !== 'en' && language !== 'hi') return fail('invalid_input', F.language);
    fields.language = language;
  }
  const same = bool(formData, F.whatsappSameAsMobile);
  if (same !== undefined) fields.whatsappSameAsMobile = same;
  if (formData.has(F.whatsappMobile)) fields.whatsappMobile = str(formData, F.whatsappMobile, 20);
  if (formData.has(F.emailOverride)) fields.emailOverride = str(formData, F.emailOverride, 254);
  const waOff = bool(formData, F.whatsappOff);
  if (waOff !== undefined) fields.whatsappOff = waOff;
  const emOff = bool(formData, F.emailOff);
  if (emOff !== undefined) fields.emailOff = emOff;
  if (formData.has(F.offReason)) fields.offReason = str(formData, F.offReason, 300);
  try {
    const result = await setDealMessagePrefs(asRpcClient(staff.supabase), dealId, expected, fields, requestId);
    revalidateDeal(dealId);
    return { ok: true, message: 'Message settings saved.', data: { rowVersion: result.rowVersion } };
  } catch (error) {
    return failFrom(error);
  }
}

/** A2. Fields: dealId, reason (10..300), requestId. */
export async function restartWhatsappAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!dealId || !requestId) return fail('invalid_input');
  const r = reason(formData, 10, 300);
  if (!r) return fail('invalid_input', F.reason);
  try {
    const result = await restartWhatsapp(asRpcClient(staff.supabase), dealId, r, requestId);
    revalidateDeal(dealId);
    return { ok: true, message: result.outcome === 'existing' ? 'WhatsApp messages are already on for this customer.' : 'WhatsApp messages restarted.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** A6 "Send again". Fields: messageId, dealId (revalidation), requestId. */
export async function resendCustomerMessageAction(_prev: Prev<{ messageId: string }>, formData: FormData): Promise<MessageActionResult<{ messageId: string }>> {
  const staff = await requireStaff();
  const messageId = readUuid(formData, F.messageId);
  const requestId = readUuid(formData, F.requestId);
  if (!messageId || !requestId) return fail('invalid_input');
  try {
    const result = await resendMessage(asRpcClient(staff.supabase), messageId, requestId);
    revalidateDeal(readUuid(formData, F.dealId));
    if (result.status === 'queued') scheduleCustomerMessageDispatch();
    return { ok: true, message: result.status === 'queued' ? 'The message will be sent again.' : 'The message was not sent: check the reason.', data: { messageId: result.messageId } };
  } catch (error) {
    return failFrom(error);
  }
}

/** A5 "Ready for customer". Fields: evidenceId, requestId. */
export async function markVoucherReadyAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const evidenceId = readUuid(formData, F.evidenceId);
  const requestId = readUuid(formData, F.requestId);
  if (!evidenceId || !requestId) return fail('invalid_input');
  try {
    const result = await markVoucherReady(asRpcClient(staff.supabase), evidenceId, requestId);
    revalidatePath('/app/purchase', 'layout');
    scheduleCustomerMessageDispatch();
    return { ok: true, message: result.outcome === 'existing' ? 'This voucher is already marked ready.' : 'Voucher marked ready for the customer.' };
  } catch (error) {
    return failFrom(error);
  }
}

// ------------------------------------------------------------ Super Admin (A7-A10)

const settingsPath = () => revalidatePath(ADMIN_MESSAGES_PATH);

/** A7. Fields: entityId, type, channel, enabled, reason, expectedRowVersion. */
export async function setMessageSwitchAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, F.entityId);
  const type = str(formData, F.type, 40);
  const channel = str(formData, F.channel, 10);
  const enabled = bool(formData, F.enabled);
  const expected = rowVersion(formData);
  if (!entityId || expected === null) return fail('invalid_input');
  if (!type || !(MESSAGE_TYPES as readonly string[]).includes(type)) return fail('invalid_input', F.type);
  if (!channel || !(CHANNELS as readonly string[]).includes(channel)) return fail('invalid_input', F.channel);
  if (enabled === undefined) return fail('invalid_input', F.enabled);
  const r = reason(formData, 10, 500);
  if (!r) return fail('invalid_input', F.reason);
  try {
    await setMessageSwitch(asRpcClient(staff.supabase), entityId, type as MessageType, channel as Channel, enabled, r, expected);
    settingsPath();
    return { ok: true, message: enabled ? 'Switched on.' : 'Switched off.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** A8. Fields: entityId, pilotOnly, reason. */
export async function setPilotOnlyAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, F.entityId);
  const pilotOnly = bool(formData, F.pilotOnly);
  if (!entityId || pilotOnly === undefined) return fail('invalid_input');
  const r = reason(formData, 10, 500);
  if (!r) return fail('invalid_input', F.reason);
  try {
    await setPilotOnly(asRpcClient(staff.supabase), entityId, pilotOnly, r);
    settingsPath();
    return { ok: true, message: pilotOnly ? 'Only pilot Deals get messages.' : 'Every Deal can get messages.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** A9. Fields: entityId, dealId, inPilot, reason. */
export async function setPilotDealAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, F.entityId);
  const dealId = readUuid(formData, F.dealId);
  const inPilot = bool(formData, F.inPilot);
  if (!entityId || inPilot === undefined) return fail('invalid_input');
  if (!dealId) return fail('invalid_input', F.dealId);
  const r = reason(formData, 10, 500);
  if (!r) return fail('invalid_input', F.reason);
  try {
    await setPilotDeal(asRpcClient(staff.supabase), entityId, dealId, inPilot, r);
    settingsPath();
    return { ok: true, message: inPilot ? 'Deal added to the pilot list.' : 'Deal removed from the pilot list.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** A10. Fields: entityId, templateCode, status, reason. */
export async function setTemplateStatusAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, F.entityId);
  const code = str(formData, F.templateCode, 60);
  const status = str(formData, F.status, 20);
  if (!entityId) return fail('invalid_input');
  if (!code || !/^tn_[a-z_]+_(en|hi)_v[0-9]+$/.test(code)) return fail('invalid_input', F.templateCode);
  if (!status || !(TEMPLATE_STATUSES as readonly string[]).includes(status)) return fail('invalid_input', F.status);
  const r = reason(formData, 10, 500);
  if (!r) return fail('invalid_input', F.reason);
  try {
    await setTemplateStatus(asRpcClient(staff.supabase), entityId, code, status as TemplateStatus, r);
    settingsPath();
    return { ok: true, message: 'Template status saved.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** A11 timer switch. Fields: enabled, reason (10..500). Super Admin (the command checks). */
export async function setTimerEnabledAction(_prev: Prev<undefined>, formData: FormData): Promise<MessageActionResult> {
  const staff = await requireStaff();
  const enabled = bool(formData, F.enabled);
  if (enabled === undefined) return fail('invalid_input', F.enabled);
  const r = reason(formData, 10, 500);
  if (!r) return fail('invalid_input', F.reason);
  try {
    await setTimerEnabled(asRpcClient(staff.supabase), enabled, r);
    settingsPath();
    return { ok: true, message: enabled ? 'Timer switched on.' : 'Timer switched off.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** A9 by Deal reference (exact reference of the company, never a customer name). Fields: entityId, dealReference, inPilot, reason. */
export async function setPilotDealByReferenceAction(_prev: Prev<{ dealId: string }>, formData: FormData): Promise<MessageActionResult<{ dealId: string }>> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, F.entityId);
  const reference = str(formData, F.dealReference, 60);
  const inPilot = bool(formData, F.inPilot);
  if (!entityId || inPilot === undefined) return fail('invalid_input');
  if (!reference) return fail('invalid_input', F.dealReference);
  const r = reason(formData, 10, 500);
  if (!r) return fail('invalid_input', F.reason);
  const rpc = asRpcClient(staff.supabase);
  try {
    const deal = await pilotDealLookup(rpc, entityId, reference);
    if (!deal) return fail('not_found', F.dealReference, NOT_FOUND_DEAL_TEXT);
    await setPilotDeal(rpc, entityId, deal.dealId, inPilot, r);
    settingsPath();
    return { ok: true, message: inPilot ? 'Deal added to the pilot list.' : 'Deal removed from the pilot list.', data: { dealId: deal.dealId } };
  } catch (error) {
    return failFrom(error);
  }
}

const EVIDENCE_BUCKET = { voucher: 'purchase-evidence', boarding_pass: 'department-evidence' } as const;

/** One file through begin -> upload (privileged client, after the database authorized) -> finish. */
async function uploadCustomerFile(
  formData: FormData,
  which: 'voucher' | 'boarding_pass',
): Promise<MessageActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, F.taskId);
  const file = formData.get(F.file);
  if (!taskId) return fail('invalid_input', F.taskId);
  if (!(file instanceof Blob) || file.size === 0) return fail('evidence_rejected', F.file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return fail('evidence_rejected', F.file);
  // Boarding pass: optional slot (one flight and one passenger of the task).
  const sectorId = which === 'boarding_pass' ? readUuid(formData, F.sectorId) : null;
  const seqRaw = which === 'boarding_pass' ? str(formData, F.passengerSeq, 3) : null;
  const passengerSeq = seqRaw !== null && /^[1-9]\d{0,2}$/.test(seqRaw) ? Number(seqRaw) : null;
  if ((sectorId === null) !== (passengerSeq === null)) return fail('invalid_input', sectorId === null ? F.sectorId : F.passengerSeq);
  const input: FileInput = { taskId, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256 };
  const rpc: RpcClient = asRpcClient(staff.supabase);
  const finish = which === 'voucher' ? voucherFinish : boardingPassFinish;
  let begun;
  try {
    begun = await (which === 'voucher' ? voucherBegin : boardingPassBegin)(rpc, input);
  } catch (error) {
    return failFrom(error);
  }
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(EVIDENCE_BUCKET[which])
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  if (!stored) {
    await finish(rpc, begun.evidenceId, false).catch(() => undefined);
    return fail('upload_failed', F.file);
  }
  let status: string | null;
  try {
    status = (await finish(rpc, begun.evidenceId, true)).status;
  } catch {
    status = null;
  }
  revalidatePath(which === 'voucher' ? '/app/purchase' : '/app/flight', 'layout');
  if (status === 'stored') {
    // A stored boarding pass queues its message (database trigger); send it soon.
    if (which === 'boarding_pass') scheduleCustomerMessageDispatch();
    if (sectorId !== null && passengerSeq !== null) {
      try {
        await boardingPassSlotLink(rpc, begun.evidenceId, sectorId, passengerSeq);
      } catch {
        // The file is stored and its message queued: never ask for a second upload (the customer would get it twice).
        return { ok: true, message: BOARDING_PASS_NOT_LINKED_TEXT, data: { evidenceId: begun.evidenceId } };
      }
    }
    return { ok: true, message: 'File saved.', data: { evidenceId: begun.evidenceId } };
  }
  if (status === 'failed' || status === 'removed') return fail('upload_failed', F.file);
  throw new Error(MESSAGE_UNKNOWN_OUTCOME_TEXT);
}

/** Purchase task > Customer voucher upload. Fields: taskId, file (PDF, JPG, PNG or WebP up to 4 MB). Then markVoucherReadyAction. */
export async function uploadCustomerVoucherAction(_prev: Prev<{ evidenceId: string }>, formData: FormData): Promise<MessageActionResult<{ evidenceId: string }>> {
  return uploadCustomerFile(formData, 'voucher');
}

/** Flight task > Boarding pass upload (sent to the customer when stored). Fields: taskId, file, and the slot: sectorId + passengerSeq (both or neither). */
export async function uploadBoardingPassAction(_prev: Prev<{ evidenceId: string }>, formData: FormData): Promise<MessageActionResult<{ evidenceId: string }>> {
  return uploadCustomerFile(formData, 'boarding_pass');
}
