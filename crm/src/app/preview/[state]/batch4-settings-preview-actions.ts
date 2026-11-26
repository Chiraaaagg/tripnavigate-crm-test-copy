'use server';

import type { SyncPreviewActionResult } from '@/modules/settings/contracts';
import { fillSettingsText, visaPreviewModel, visaResultText, type VisaPreviewModel } from '@/modules/settings/rows';
import { parseSwitchForm, type SwitchActionResult } from '@/modules/settings/switch';
import { readSyncDraft, syncPreviewInput, syncRefusalText, syncSavedText, type SyncApplyOutcome } from '@/modules/settings/sync-scope';
import { SETTINGS_TEXT, SWITCH_WORDS, SYNC_SCOPE_TEXT } from '@/modules/settings/text';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY (Batch 4 Settings). Stand-in actions: they
 * read nothing, write nothing and answer like the real Settings actions
 * (same parsers, same words), so the preview states show the review step,
 * refusals that keep the typed values, and results through the real form
 * path. The gallery is a 404 outside local preview mode.
 */

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

const REFUSE: Record<string, string> = {
  invalid_input: SETTINGS_TEXT.refusedReason,
  review_required: SETTINGS_TEXT.refusedReview,
};

/** Saves (as the real action would answer) after the same form checks. */
export async function previewSwitchSavedAction(_prev: SwitchActionResult | null, formData: FormData): Promise<SwitchActionResult> {
  const parsed = parseSwitchForm(formData);
  if (!parsed.ok) return settle({ ok: false, code: parsed.code, fields: parsed.fields, message: REFUSE[parsed.code]! });
  const { key, on, reviewedCount } = parsed.value;
  const state = on ? 'on' : 'off';
  if (key === 'visa_passport_tasks_enabled' && on) {
    const created = 3;
    return settle({ ok: true, key, state, changed: true, tasksCreated: created, message: `${visaResultText(created, reviewedCount)} Recorded with your name and reason.` });
  }
  return settle({ ok: true, key, state, changed: true, message: fillSettingsText(SETTINGS_TEXT.resultChanged, { switch: SWITCH_WORDS[key].title, state }) });
}

/** The database refuses: not a Super Admin. */
export async function previewSwitchNotAuthorizedAction(): Promise<SwitchActionResult> {
  return settle({ ok: false, code: 'not_authorized', message: SETTINGS_TEXT.refusedNotAuthorized });
}

export async function previewVisaCountAction(): Promise<VisaPreviewModel> {
  return settle(visaPreviewModel({ switchState: 'off', wouldCreate: 4, skipped: 1, deals: 3 }));
}

export async function previewVisaUncountedAction(): Promise<VisaPreviewModel> {
  return settle(visaPreviewModel('error'));
}

const PREVIEW_ID = '0b4e0000-0000-4000-8000-000000000001';

/** Phase 1 stand-in: fixed numbers for whatever was ticked. */
export async function previewSyncPreviewAction(_prev: SyncPreviewActionResult | null, formData: FormData): Promise<SyncPreviewActionResult> {
  const draft = readSyncDraft(formData);
  const input = syncPreviewInput(draft);
  if (!input.ok) return settle({ ok: false, code: 'invalid_input', hint: null, message: syncRefusalText('invalid_input', null), fields: input.fields });
  return settle({
    ok: true,
    message: SYNC_SCOPE_TEXT.reviewTitle,
    review: {
      state: 'ready',
      draft: { ...draft, stageIds: input.input.stageIds },
      previewId: PREVIEW_ID,
      expiresAt: '2026-10-23T10:10:00.000Z',
      changed: true,
      hide: { total: 12, beforeSyncDate: 0, pipelineNotEligible: 9, stageNotEligible: 3, withCrmWork: 2 },
      bringBack: 1,
      recheck: 4,
      autoSyncChange: 'none',
    },
  });
}

export async function previewSyncNotInstalledAction(): Promise<SyncPreviewActionResult> {
  return settle({ ok: false, code: 'not_installed', hint: null, message: syncRefusalText('not_installed', null) });
}

/** Phase 2 stand-in: saved with the reviewed numbers. */
export async function previewSyncApplyAction(_prev: SyncApplyOutcome | null, formData: FormData): Promise<SyncApplyOutcome> {
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 10) return settle({ ok: false, code: 'invalid_reason', hint: null, message: syncRefusalText('invalid_reason', null), fields: ['reason'] });
  return settle({
    ok: true,
    message: syncSavedText(12, 1),
    data: {
      previewId: PREVIEW_ID,
      removed: 12,
      restored: 1,
      requeued: 0,
      resyncQueued: true,
      cutoffAt: '2026-09-01T00:00:00+05:30',
      leadIntakeMode: null,
      dealIntakeMode: null,
      scopeRequeuedLeads: 0,
      scopeRequeuedDeals: 0,
      hidden: { total: 12, beforeSyncDate: 0, pipelineNotEligible: 9, stageNotEligible: 3, withCrmWork: 2 },
      broughtBack: 1,
    } as never,
  });
}

/** Phase 2 stand-in: the numbers changed after the review (lead ruling: back to the review with fresh numbers). */
export async function previewSyncApplyStaleAction(_prev: SyncApplyOutcome | null, formData: FormData): Promise<SyncApplyOutcome> {
  const draft = readSyncDraft(formData);
  return settle({
    ok: false,
    code: 'preview_stale',
    hint: 'counts_changed',
    message: syncRefusalText('preview_stale', 'counts_changed'),
    review: {
      state: 'ready',
      draft,
      previewId: '0b4e0000-0000-4000-8000-000000000002',
      expiresAt: '2026-10-23T10:20:00.000Z',
      changed: true,
      hide: { total: 13, beforeSyncDate: 0, pipelineNotEligible: 9, stageNotEligible: 4, withCrmWork: 2 },
      bringBack: 1,
      recheck: 4,
      autoSyncChange: 'none',
    },
  });
}
