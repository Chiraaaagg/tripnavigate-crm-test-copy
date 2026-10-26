'use server';

import { revalidatePath } from 'next/cache';
import { loadVisaTaskPreview } from '@/modules/access/server/settings-state';
import { BookingCommandError, adminSetWorkflowSetting, asRpcClient } from '@/modules/fulfilment/commands';
import { setBitrixIdProofCopy, setBitrixReadSwitches } from '@/modules/fulfilment/b11-commands';
import { requireStaff } from '@/modules/identity/server/session';
import { setBitrixNameRead } from '@/modules/integration/server/name-map';
import { applySyncSettings, isSyncPreviewMissing, previewSyncSettings, SyncSettingsError } from '@/modules/integration/sync-settings-preview';
import { SETTINGS_FIELD, SETTINGS_PATH, SETTINGS_REASON_LIMITS, type SyncPreviewActionResult, type SyncSettingsErrorCode, type SyncStaleHint } from '../contracts';
import { fillSettingsText, visaPreviewModel, visaResultText, type VisaPreviewModel } from '../rows';
import { isB12Key, isWorkflowKey, normaliseReason, parseSwitchForm, type SwitchActionResult, type SwitchErrorCode } from '../switch';
import { isSyncEnabledChosen, readSyncDraft, syncPreviewInput, syncRefusalText, syncReview, syncSavedText, type SyncApplyOutcome } from '../sync-scope';
import { SETTINGS_TEXT, SWITCH_WORDS, SYNC_SCOPE_TEXT } from '../text';

/*
 * Batch 4 Settings actions (R6, M1, M5; DA-256 to DA-259). Every action runs
 * requireStaff() (active staff at aal2) and then the database command under
 * the person's own session; the database decides who may change what, checks
 * the reason and writes the audit row. Nothing here reads the actor or the
 * company from the form. Results carry ids, states, counts and messages only
 * (P12). Live use still needs the owner's APPROVE (the screens say so).
 */

function revalidateSettings(): void {
  revalidatePath(SETTINGS_PATH.features);
  revalidatePath(SETTINGS_PATH.bitrix);
  revalidatePath(SETTINGS_PATH.health);
  revalidatePath('/app');
  revalidatePath('/app/deals');
}

const SWITCH_MESSAGE: Record<SwitchErrorCode, string> = {
  invalid_input: SETTINGS_TEXT.refusedReason,
  review_required: SETTINGS_TEXT.refusedReview,
  not_authorized: SETTINGS_TEXT.refusedNotAuthorized,
  not_configured: SETTINGS_TEXT.refusedNotConfigured,
  not_installed: SETTINGS_TEXT.refusedNotInstalled,
  settings_busy: SETTINGS_TEXT.busy,
  session: SETTINGS_TEXT.signedOut,
  unexpected: SETTINGS_TEXT.unknownOutcome,
};

function switchFail(code: SwitchErrorCode, fields?: Array<'state' | 'reason' | 'confirm' | 'settingKey'>): SwitchActionResult {
  return { ok: false, code, ...(fields && fields.length > 0 ? { fields } : {}), message: SWITCH_MESSAGE[code] };
}

function switchFailFrom(error: unknown): SwitchActionResult {
  if (error instanceof BookingCommandError) {
    if (error.code === 'not_authorized') return switchFail('not_authorized');
    if (error.code === 'settings_busy') return switchFail('settings_busy');
    if (error.code === 'invalid_input') return switchFail('invalid_input', ['reason']);
    if (error.code === 'session') return switchFail('session');
    if (error.sqlState === 'PGRST202' || error.sqlState === '42883') return switchFail('not_installed');
  }
  // The command may have committed: say so honestly (G-05), never "not saved".
  return switchFail('unexpected');
}

/**
 * DA-256: change one switch of Features or Bitrix connection. Fields: settingKey,
 * state ('on' | 'off'), reason (10–500), confirm ('yes', from the review step),
 * reviewedCount (Visa tasks only, for the result line).
 */
export async function changeSettingSwitchAction(_prev: SwitchActionResult | null, formData: FormData): Promise<SwitchActionResult> {
  const staff = await requireStaff();
  const parsed = parseSwitchForm(formData);
  if (!parsed.ok) return switchFail(parsed.code, parsed.fields);
  const { key, on, reason, reviewedCount } = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  const title = SWITCH_WORDS[key].title;
  const state = on ? 'on' : 'off';
  const done = (changed: boolean, extra?: { tasksCreated?: number; message?: string }): SwitchActionResult => {
    revalidateSettings();
    const base = fillSettingsText(changed ? SETTINGS_TEXT.resultChanged : SETTINGS_TEXT.resultUnchanged, { switch: title, state });
    return { ok: true, key, state, changed, ...(extra?.tasksCreated !== undefined ? { tasksCreated: extra.tasksCreated } : {}), message: extra?.message ?? base };
  };
  try {
    if (isWorkflowKey(key)) {
      const result = await adminSetWorkflowSetting(rpc, { key, value: on, reason });
      if (key === 'visa_passport_tasks_enabled' && result.after && result.tasksCreated !== undefined) {
        // DA-258 / lead ruling D5: the actual count, and the review count when it differs.
        const counted = visaResultText(result.tasksCreated, reviewedCount);
        return done(result.changed, { tasksCreated: result.tasksCreated, message: result.changed ? `${counted} Recorded with your name and reason.` : `${fillSettingsText(SETTINGS_TEXT.resultUnchanged, { switch: title, state })} ${counted}` });
      }
      return done(result.changed);
    }
    if (isB12Key(key)) {
      if (key === 'bitrix_id_proof_copy') {
        const r = await setBitrixIdProofCopy(rpc, { on, reason });
        return done(r.changed);
      }
      const r = await setBitrixReadSwitches(rpc, {
        tripFactsRead: key === 'bitrix_trip_facts_read' ? on : null,
        leadIntakeUnowned: key === 'lead_intake_unowned' ? on : null,
        reason,
      });
      return done(r.changed);
    }
    const r = await setBitrixNameRead(rpc, on, reason);
    if (!r.ok) {
      if (r.code === 'reason_required') return switchFail('invalid_input', ['reason']);
      if (r.code === 'failed') return switchFail('unexpected');
      return switchFail(r.code);
    }
    return done(r.result.changed);
  } catch (error) {
    return switchFailFrom(error);
  }
}

/** DA-258: read when "Review change" is pressed for Visa and passport tasks (never at page load). Counts only. */
export async function previewVisaTasksAction(): Promise<VisaPreviewModel> {
  const staff = await requireStaff();
  return visaPreviewModel(await loadVisaTaskPreview(staff));
}

// ---------------------------------------------------------------------------
// Which deals come in from Bitrix: preview, then apply (M1, DA-259)
// ---------------------------------------------------------------------------

function syncFail(code: SyncSettingsErrorCode, hint: SyncStaleHint | null = null, fields?: string[], message?: string) {
  return { ok: false as const, code, hint, message: message ?? syncRefusalText(code, hint), ...(fields && fields.length > 0 ? { fields } : {}) };
}

function syncFailFrom(error: unknown) {
  if (isSyncPreviewMissing(error)) return syncFail('not_installed');
  if (error instanceof SyncSettingsError && error.code) {
    if (error.code === 'preview_stale') {
      const hint = error.detail === 'expired' || error.detail === 'settings_changed' || error.detail === 'counts_changed' ? error.detail : null;
      return syncFail('preview_stale', hint);
    }
    if (error.code === 'invalid_input') {
      const field = typeof error.detail === 'string' ? error.detail : null;
      const message = error.entryStagePipeline ? `${SYNC_SCOPE_TEXT.fieldError.entryStagePipeline} Nothing was changed.` : undefined;
      return syncFail('invalid_input', null, field ? [field] : undefined, message);
    }
    return syncFail(error.code);
  }
  return syncFail('unexpected');
}

/** Phase 1: the exact counts for what the person ticked. Writes only the private preview row; changes no setting. */
export async function previewSyncScopeAction(_prev: SyncPreviewActionResult | null, formData: FormData): Promise<SyncPreviewActionResult> {
  const staff = await requireStaff();
  const draft = readSyncDraft(formData);
  const input = syncPreviewInput(draft);
  // Echo-A L4: automatic updates must be chosen explicitly; a missing answer is never read as Off.
  const autoChosen = isSyncEnabledChosen(formData);
  if (!input.ok || !autoChosen) return syncFail('invalid_input', null, [...(input.ok ? [] : input.fields), ...(autoChosen ? [] : ['syncEnabled'])]);
  try {
    const preview = await previewSyncSettings(asRpcClient(staff.supabase), input.input);
    // The review shows (and the apply form re-posts) what is applied: stages of unticked pipelines are dropped.
    return { ok: true, review: syncReview({ ...draft, stageIds: input.input.stageIds }, preview), message: SYNC_SCOPE_TEXT.reviewTitle };
  } catch (error) {
    return syncFailFrom(error);
  }
}

/**
 * Phase 2: apply the reviewed preview with a reason. The database applies the
 * stored values of that preview only. When the review is stale (lead ruling),
 * a fresh preview of the posted ticks comes back with the refusal, so the
 * screen returns to the review step with the new numbers; nothing was saved.
 */
export async function applySyncScopeAction(_prev: SyncApplyOutcome | null, formData: FormData): Promise<SyncApplyOutcome> {
  const staff = await requireStaff();
  const previewId = formData.get(SETTINGS_FIELD.previewId);
  const reasonRaw = formData.get(SETTINGS_FIELD.reason);
  const reason = typeof reasonRaw === 'string' ? normaliseReason(reasonRaw) : '';
  if (typeof previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(previewId)) return syncFail('preview_required');
  if (reason.length < SETTINGS_REASON_LIMITS.min || reason.length > SETTINGS_REASON_LIMITS.max) return syncFail('invalid_reason', null, ['reason']);
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await applySyncSettings(rpc, { previewId, reason });
    revalidateSettings();
    return { ok: true, data: result, message: syncSavedText(result.hidden.total, result.broughtBack) };
  } catch (error) {
    const refused = syncFailFrom(error);
    if (refused.code !== 'preview_stale') return refused;
    // Back to the review with fresh numbers (read only; one new private preview row).
    const draft = readSyncDraft(formData);
    const input = syncPreviewInput(draft);
    if (!input.ok) return refused;
    try {
      return { ...refused, review: syncReview({ ...draft, stageIds: input.input.stageIds }, await previewSyncSettings(rpc, input.input)) };
    } catch {
      return refused;
    }
  }
}
