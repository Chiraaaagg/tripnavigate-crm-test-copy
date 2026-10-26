import type { BitrixPipeline } from '@/modules/integration/bitrix/directory';
import { SETTINGS_FIELD, type SyncApplyActionResult, type SyncPreviewInput, type SyncPreviewRecord, type SyncScopeDraft, type SyncScopeReviewVM, type SyncSettingsErrorCode, type SyncStaleHint } from './contracts';
import { SYNC_SCOPE_TEXT } from './text';

/*
 * Batch 4 (M1, DA-259): which deals come in from Bitrix, in two phases that
 * the database enforces: integration_preview_sync_settings (exact counts, one
 * private preview, 10 minutes, one use) then
 * integration_apply_sync_settings(previewId, reason). Pure helpers shared by
 * the server actions and the review view. There is no one-step save.
 */

const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? String(v[k]) : all));

function strings(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === 'string');
}

/** The ticks and date as posted (always returned, so the screen keeps them after any refusal, R10). */
export function readSyncDraft(formData: FormData): SyncScopeDraft {
  const cutoff = formData.get(SETTINGS_FIELD.cutoff);
  return {
    categoryIds: strings(formData, SETTINGS_FIELD.categoryId),
    stageIds: strings(formData, SETTINGS_FIELD.stageId),
    cutoff: typeof cutoff === 'string' ? cutoff.trim() : '',
    syncEnabled: formData.get(SETTINGS_FIELD.syncEnabled) === 'on',
  };
}

/** True only when the form posted an explicit On or Off for automatic updates (Echo-A L4). */
export function isSyncEnabledChosen(formData: FormData): boolean {
  const value = formData.get(SETTINGS_FIELD.syncEnabled);
  return value === 'on' || value === 'off';
}

export type SyncDraftField = 'categoryIds' | 'stageIds' | 'cutoff';

/**
 * Draft -> preview input, or the fields to fix. A stage counts only when its
 * pipeline is ticked (stage ids carry the pipeline: "C<id>:…", pipeline 0
 * otherwise), as the earlier one-step form did.
 */
export function syncPreviewInput(draft: SyncScopeDraft): { ok: true; input: SyncPreviewInput } | { ok: false; fields: SyncDraftField[] } {
  const fields: SyncDraftField[] = [];
  const categoryIds = draft.categoryIds.filter((c) => /^[0-9]{1,18}$/.test(c));
  if (categoryIds.length < 1 || categoryIds.length > 50 || categoryIds.length !== draft.categoryIds.length) fields.push('categoryIds');
  const cats = new Set(categoryIds);
  const stageIds = draft.stageIds.filter((s) => /^[A-Za-z0-9_:.-]{1,50}$/.test(s)).filter((s) => {
    const m = /^C(\d+):/.exec(s);
    return cats.has(m ? m[1]! : '0');
  });
  if (stageIds.length < 1 || stageIds.length > 50) fields.push('stageIds');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.cutoff)) fields.push('cutoff');
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    // Midnight India time on the chosen day (the database normalises it again).
    input: { categoryIds: categoryIds.map(Number), stageIds, cutoffAt: `${draft.cutoff}T00:00:00+05:30`, syncEnabled: draft.syncEnabled },
  };
}

/**
 * The apply reply as the screen receives it. Lead ruling (23 Oct): a stale
 * review (expired, settings changed, numbers changed) goes back to the review
 * step with a fresh preview of the same ticks, so the person sees the new
 * numbers before confirming again. The apply form therefore also posts the
 * reviewed ticks (hidden fields, SETTINGS_FIELD names); the database still
 * applies only the stored values of the preview it is given.
 */
export type SyncApplyOutcome = SyncApplyActionResult & { review?: Extract<SyncScopeReviewVM, { state: 'ready' }> };

/** The 'ready' review from the database preview. */
export function syncReview(draft: SyncScopeDraft, preview: SyncPreviewRecord): Extract<SyncScopeReviewVM, { state: 'ready' }> {
  return {
    state: 'ready',
    draft,
    previewId: preview.previewId,
    expiresAt: preview.expiresAt,
    changed: preview.changed,
    hide: preview.hide,
    bringBack: preview.bringBack,
    recheck: preview.recheck,
    autoSyncChange: preview.autoSyncChange,
  };
}

const IST_DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
function dateText(value: string | null | undefined): string {
  if (!value) return 'not set';
  const t = Date.parse(value.length === 10 ? `${value}T00:00:00+05:30` : value);
  return Number.isNaN(t) ? value : IST_DATE.format(t);
}

/** The review's change lines and count lines (DA-259), with pipeline and stage names where the page knows them. */
export function syncReviewLines(
  review: Extract<SyncScopeReviewVM, { state: 'ready' }>,
  current: { categoryIds: string[]; stageIds: string[]; cutoff: string | null; syncEnabled: boolean | null },
  pipelines: BitrixPipeline[] | null,
): { changes: string[]; hides: string | null; details: string[]; approval: string; validFor: string; confirmLabel: string } {
  const pipelineName = new Map((pipelines ?? []).map((p) => [p.id, p.name]));
  const stageName = new Map((pipelines ?? []).flatMap((p) => p.stages.map((s) => [s.id, `${s.name} (${p.name})`] as const)));
  const names = (ids: string[], map: Map<string, string>) => ids.map((id) => map.get(id) ?? id).join(', ');
  const diff = (now: string[], then: string[]) => ({ added: now.filter((x) => !then.includes(x)), removed: then.filter((x) => !now.includes(x)) });
  const cats = diff(review.draft.categoryIds, current.categoryIds);
  const stages = diff(review.draft.stageIds, current.stageIds);
  const changes: string[] = [];
  if (cats.added.length) changes.push(fill(SYNC_SCOPE_TEXT.pipelinesAdded, { list: names(cats.added, pipelineName) }));
  if (cats.removed.length) changes.push(fill(SYNC_SCOPE_TEXT.pipelinesRemoved, { list: names(cats.removed, pipelineName) }));
  if (stages.added.length) changes.push(fill(SYNC_SCOPE_TEXT.stagesAdded, { list: names(stages.added, stageName) }));
  if (stages.removed.length) changes.push(fill(SYNC_SCOPE_TEXT.stagesRemoved, { list: names(stages.removed, stageName) }));
  if (current.cutoff !== null && current.cutoff !== review.draft.cutoff) {
    changes.push(fill(SYNC_SCOPE_TEXT.dateChange, { old: dateText(current.cutoff), new: dateText(review.draft.cutoff) }));
  }
  if (review.autoSyncChange !== 'none') changes.push(fill(SYNC_SCOPE_TEXT.autoSyncChange, { state: review.autoSyncChange }));

  const details: string[] = [];
  let hides: string | null = null;
  if (!review.changed) {
    details.push(review.autoSyncChange !== 'none' ? SYNC_SCOPE_TEXT.onlyAutoSync : SYNC_SCOPE_TEXT.nothing);
  } else {
    if (review.hide.total > 0) {
      hides = fill(SYNC_SCOPE_TEXT.hides, { n: review.hide.total });
      details.push(fill(SYNC_SCOPE_TEXT.hidesBreakdown, review.hide));
      if (review.hide.withCrmWork > 0) details.push(fill(SYNC_SCOPE_TEXT.withCrmWork, { n: review.hide.withCrmWork }));
    }
    if (review.bringBack > 0) details.push(fill(SYNC_SCOPE_TEXT.bringsBack, { n: review.bringBack }));
    if (review.hide.total === 0 && review.bringBack === 0) details.push(SYNC_SCOPE_TEXT.nothing);
    if (review.recheck > 0) details.push(fill(SYNC_SCOPE_TEXT.recheck, { n: review.recheck }));
  }
  return {
    changes,
    hides,
    details,
    approval: SYNC_SCOPE_TEXT.approval,
    validFor: SYNC_SCOPE_TEXT.validFor,
    confirmLabel: review.hide.total > 0 ? fill(SYNC_SCOPE_TEXT.confirmHide, { n: review.hide.total }) : SYNC_SCOPE_TEXT.confirm,
  };
}

/** Refusal words (DA-259). */
export function syncRefusalText(code: SyncSettingsErrorCode, hint: SyncStaleHint | null): string {
  if (code === 'preview_stale' && hint) return SYNC_SCOPE_TEXT.refused[hint];
  return SYNC_SCOPE_TEXT.refused[code];
}

/** Field error words (DA-259 "validation as today"). */
export function syncFieldText(field: string, entryStagePipeline = false): string | null {
  if (entryStagePipeline) return SYNC_SCOPE_TEXT.fieldError.entryStagePipeline;
  return field in SYNC_SCOPE_TEXT.fieldError ? SYNC_SCOPE_TEXT.fieldError[field as keyof typeof SYNC_SCOPE_TEXT.fieldError] : null;
}

/** Success line. */
export function syncSavedText(hidden: number, broughtBack: number): string {
  return hidden === 0 && broughtBack === 0 ? SYNC_SCOPE_TEXT.savedNothing : fill(SYNC_SCOPE_TEXT.saved, { hidden, broughtBack });
}
