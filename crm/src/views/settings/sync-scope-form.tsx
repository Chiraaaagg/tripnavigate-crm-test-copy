'use client';

import { EyeOff, History, ListChecks, Lock, RefreshCw } from 'lucide-react';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { ConfirmChange, type ConfirmResult } from '@/components/ui/confirm-change';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import type { BitrixPipeline } from '@/modules/integration/bitrix/directory';
import { SETTINGS_FIELD, type SyncPreviewActionResult, type SyncScopeDraft, type SyncScopeReviewVM } from '@/modules/settings/contracts';
import type { SyncStateModel } from '@/modules/settings/server/queries';
import { syncFieldText, syncReviewLines, type SyncApplyOutcome } from '@/modules/settings/sync-scope';
import { SETTINGS_TEXT, SYNC_SCOPE_TEXT as SYNC_TEXT } from '@/modules/settings/text';

/** Words of this section; `reopen` is new with the one confirm dialog (UX redesign R1). */
const SYNC_SCOPE_TEXT = { ...SYNC_TEXT, reopen: 'Show the count again' } as const;
import { SettingStateBadge } from './setting-state';

/*
 * Which deals come in from Bitrix (Direction A R6, M1; copy DA-259; catalog
 * gap G16; UX redesign R1, one confirm dialog C7). Two phases the database
 * enforces: "Review changes" asks for the exact numbers
 * (integration_preview_sync_settings, a private preview valid 10 minutes),
 * then ONE confirm dialog states the effect and asks for the reason, and its
 * button applies that preview (integration_apply_sync_settings). The reason
 * stays required (owner Q1: sync scope is one of the four STANDING-RULES
 * families). The same fields are posted as before. There is no one-step save:
 * without the new commands the section says so and offers nothing. Every tick
 * and the date stay on screen after any refusal (HandForm, R10); the typed
 * reason stays in the dialog; a stale save opens the dialog again with fresh
 * numbers (lead ruling).
 */

export interface SyncScopeActions {
  preview: (prev: SyncPreviewActionResult | null, formData: FormData) => Promise<SyncPreviewActionResult>;
  apply: (prev: SyncApplyOutcome | null, formData: FormData) => Promise<SyncApplyOutcome>;
}

type Ready = Extract<SyncScopeReviewVM, { state: 'ready' }>;

export function SyncScopeSection({
  configured,
  pipelines,
  directoryError,
  model,
  text,
  installed,
  actions,
  initialReview = null,
  initialReason = '',
}: {
  configured: boolean;
  pipelines: BitrixPipeline[] | null;
  directoryError: string | null;
  /** null = not readable for this person, unreadable or failed (text says which). */
  model: SyncStateModel | null;
  text: string | null;
  /** false = the preview and apply commands are not wired: the not-installed line, no form. */
  installed: boolean;
  actions: SyncScopeActions | null;
  /** Preview gallery only: open on the review step. */
  initialReview?: Ready | null;
  /** Preview gallery only. */
  initialReason?: string;
}) {
  return (
    <Card className="my-5" data-slot="sync-scope">
      <section aria-labelledby="sync-scope-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="sync-scope-heading">{SYNC_SCOPE_TEXT.section}</CardTitle>
            <CardDescription>{SYNC_SCOPE_TEXT.untickWarning}</CardDescription>
          </div>
          {model ? <SettingStateBadge state={model.autoSync} label="Automatic updates from Bitrix" word={`Automatic updates: ${model.autoSync === 'on' ? 'On' : model.autoSync === 'off' ? 'Off' : 'Unknown'}`} /> : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {!installed ? (
            <Notice tone="warning" role="status">
              <p>{SYNC_SCOPE_TEXT.refused.not_installed}</p>
            </Notice>
          ) : !model ? (
            text ? (
              <Notice tone="warning" role="status">
                <p>{text}</p>
              </Notice>
            ) : (
              <p className="m-0 text-copy">{SYNC_SCOPE_TEXT.refused.not_authorized}</p>
            )
          ) : (
            <>
              <div className="flex flex-col gap-1 text-sm text-quiet" data-slot="sync-last-change">
                <p className="m-0 flex items-start gap-1.5">
                  <History aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
                  <span className="min-w-0">
                    {model.lastScopeChangeLine}
                    {model.lastScopeChangeReason ? <span className="block wrap-break-word text-copy">{model.lastScopeChangeReason}</span> : null}
                  </span>
                </p>
                {model.lastSavedLines ? (
                  <p className="m-0 flex items-start gap-1.5">
                    <ListChecks aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
                    <span>{model.lastSavedLines.join(' ')}</span>
                  </p>
                ) : null}
              </div>
              {directoryError ? (
                <Notice tone="danger" role="alert" title="Bitrix pipelines could not be loaded">
                  <p className="wrap-break-word">{directoryError}</p>
                </Notice>
              ) : null}
              {!configured ? (
                <p className="m-0 text-copy">These settings can be changed once the Bitrix connection is set up.</p>
              ) : !model.canManageSync || !actions ? (
                <p className="m-0 flex items-start gap-1.5 text-sm text-quiet">
                  <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
                  <span>Only staff who manage the Bitrix connection can change this.</span>
                </p>
              ) : pipelines ? (
                <SyncScopeForm pipelines={pipelines} model={model} actions={actions} initialReview={initialReview} initialReason={initialReason} />
              ) : null}
            </>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

function SyncScopeForm({
  pipelines,
  model,
  actions,
  initialReview,
  initialReason,
}: {
  pipelines: BitrixPipeline[];
  model: SyncStateModel;
  actions: SyncScopeActions;
  initialReview: Ready | null;
  initialReason: string;
}) {
  const id = useId();
  const current = model.current;
  const [draft, setDraft] = useState<SyncScopeDraft>(
    initialReview?.draft ?? { categoryIds: current.categoryIds, stageIds: current.stageIds, cutoff: current.cutoff ?? '', syncEnabled: current.syncEnabled === true },
  );
  // Echo-A L4 (R2): automatic updates in an Unknown state get no default; the person must choose On or Off.
  const [auto, setAuto] = useState<'on' | 'off' | null>(initialReview ? (initialReview.draft.syncEnabled ? 'on' : 'off') : current.syncEnabled === null ? null : current.syncEnabled ? 'on' : 'off');
  const [autoError, setAutoError] = useState<string | null>(null);
  const [previewResult, previewAction, previewPending] = useActionState(actions.preview, initialReview ? { ok: true as const, review: initialReview, message: SYNC_SCOPE_TEXT.reviewTitle } : null);
  const [review, setReview] = useState<Ready | null>(initialReview);
  // A stale save comes back with fresh numbers: the dialog opens again with them, the typed reason and the refusal.
  const [reopen, setReopen] = useState<{ reason: string; refusal: string | null }>({ reason: initialReason, refusal: null });
  const [seenPreview, setSeenPreview] = useState(previewResult);
  // The page-level reply: a saved change, or a refused count. Refusals of the save itself stay in the dialog.
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const resultBox = useRef<HTMLDivElement>(null);

  // New preview replies (render-time adjustment): a count opens the confirm dialog; a refusal is shown on the page.
  if (previewResult !== seenPreview) {
    setSeenPreview(previewResult);
    if (previewResult?.ok) {
      setReview(previewResult.review);
      setReopen((r) => ({ ...r, refusal: null }));
      setMessage(null);
    } else if (previewResult) {
      setMessage(previewResult);
      setFocusTick((n) => n + 1);
    }
  }

  useEffect(() => {
    if (focusTick > 0) resultBox.current?.focus();
  }, [focusTick]);

  const refusedFields = previewResult && !previewResult.ok ? (previewResult.fields ?? []) : [];
  const fieldError = (field: string) => (refusedFields.includes(field) ? syncFieldText(field) : null);
  const cutoffId = `${id}-cutoff`;

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value));
  // Any edit after a count drops it: the dialog only ever saves what was counted.
  const edit = (next: (d: SyncScopeDraft) => SyncScopeDraft) => {
    setDraft(next);
    setReview(null);
  };

  const startReview = (event: { preventDefault: () => void }) => {
    if (auto === null) {
      event.preventDefault();
      setAutoError(SYNC_SCOPE_TEXT.fieldError.syncEnabled);
      document.getElementById(`${id}-auto-on`)?.focus();
      return;
    }
    setAutoError(null);
  };

  /**
   * The confirm dialog's save: the same fields as before (previewId, reason, the
   * counted ticks, cutoff, syncEnabled), the reason with its spaces collapsed as
   * before. The reason stays required (owner Q1: sync scope is one of the four
   * families); the server refuses an empty one too.
   */
  const apply = async (_prev: ConfirmResult | null, formData: FormData): Promise<ConfirmResult> => {
    const typed = String(formData.get(SETTINGS_FIELD.reason) ?? '');
    const trimmed = typed.replace(/\s+/g, ' ').trim();
    formData.set(SETTINGS_FIELD.reason, trimmed);
    const save = actions.apply;
    const result = await save(null, formData);
    if (result.ok) {
      setMessage(result);
      setReview(null);
      setReopen({ reason: '', refusal: null });
      setFocusTick((n) => n + 1);
      return { ok: true };
    }
    if (result.review) {
      // Numbers changed: a fresh count; the dialog opens again with it.
      setReopen({ reason: typed, refusal: result.message });
      setReview(result.review);
    }
    return { ok: false, message: result.message, fields: result.code === 'invalid_reason' ? [SETTINGS_FIELD.reason] : undefined };
  };

  const lines = review ? syncReviewLines(review, current, pipelines) : null;

  return (
    <div className="flex flex-col gap-4">
      <div ref={resultBox} tabIndex={-1} className="outline-none empty:hidden" data-slot="sync-result">
        {message ? (
          <Notice tone={message.ok ? 'success' : 'danger'} role={message.ok ? 'status' : 'alert'}>
            <p>{message.message}</p>
          </Notice>
        ) : null}
      </div>

      <HandForm action={previewAction} onSubmit={startReview} noValidate aria-label="Change which deals come in from Bitrix" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3" data-slot="sync-pipelines">
          {fieldError('categoryIds') ? <p className="m-0 text-sm font-medium text-status-danger" role="alert">{fieldError('categoryIds')}</p> : null}
          {fieldError('stageIds') ? <p className="m-0 text-sm font-medium text-status-danger" role="alert">{fieldError('stageIds')}</p> : null}
          {pipelines.map((p) => {
            const ticked = draft.categoryIds.includes(p.id);
            return (
              <fieldset key={p.id} className="m-0 flex min-w-0 flex-col gap-2 rounded-control border border-line px-3.5 py-3">
                <legend className="px-1">
                  <Checkbox
                    id={`${id}-p-${p.id}`}
                    name={SETTINGS_FIELD.categoryId}
                    value={p.id}
                    checked={ticked}
                    onChange={(e) => edit((d) => ({ ...d, categoryIds: toggle(d.categoryIds, p.id, e.target.checked) }))}
                    label={`Pipeline: ${p.name}`}
                  />
                </legend>
                <p className="m-0 text-sm text-quiet">New deals are taken from the ticked stages. Deals already in the CRM keep following Bitrix to any stage (won and lost included).</p>
                <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2" aria-label={`Stages of ${p.name}`}>
                  {p.stages.map((st) => (
                    <li key={st.id} className="m-0">
                      <Checkbox
                        id={`${id}-s-${st.id}`}
                        name={SETTINGS_FIELD.stageId}
                        value={st.id}
                        checked={draft.stageIds.includes(st.id)}
                        disabled={!ticked}
                        onChange={(e) => edit((d) => ({ ...d, stageIds: toggle(d.stageIds, st.id, e.target.checked) }))}
                        label={st.kind !== 'open' ? `${st.name} (${st.kind})` : st.name}
                      />
                    </li>
                  ))}
                </ul>
                {!ticked ? <p className="m-0 text-sm text-quiet">Tick the pipeline to choose its stages.</p> : null}
              </fieldset>
            );
          })}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={cutoffId} label={SYNC_SCOPE_TEXT.dateLabel} hint={SYNC_SCOPE_TEXT.dateHint} error={fieldError('cutoff')}>
            <Input
              id={cutoffId}
              name={SETTINGS_FIELD.cutoff}
              type="date"
              value={draft.cutoff}
              onChange={(e) => edit((d) => ({ ...d, cutoff: e.target.value }))}
              invalid={Boolean(fieldError('cutoff'))}
              aria-describedby={fieldDescribedBy(cutoffId, { hint: true, error: fieldError('cutoff') })}
            />
          </Field>
          <ChoiceGroup
            id={`${id}-auto`}
            legend={SYNC_SCOPE_TEXT.autoSync}
            hint={model.autoSync === 'unknown' ? 'The current state could not be read, so nothing is chosen. Choose On or Off.' : undefined}
            error={autoError ?? fieldError('syncEnabled')}
          >
            <Radio
              id={`${id}-auto-on`}
              name={SETTINGS_FIELD.syncEnabled}
              value="on"
              label="On"
              checked={auto === 'on'}
              onChange={() => {
                setAuto('on');
                edit((d) => ({ ...d, syncEnabled: true }));
              }}
            />
            <Radio
              id={`${id}-auto-off`}
              name={SETTINGS_FIELD.syncEnabled}
              value="off"
              label="Off"
              checked={auto === 'off'}
              onChange={() => {
                setAuto('off');
                edit((d) => ({ ...d, syncEnabled: false }));
              }}
            />
          </ChoiceGroup>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={previewPending} disabled={previewPending}>
            {previewPending ? SYNC_SCOPE_TEXT.counting : SYNC_SCOPE_TEXT.reviewButton}
          </Button>
          <span className="text-sm text-quiet">The CRM counts the deals first. Nothing is saved until you confirm with a reason.</span>
        </div>
      </HandForm>

      {review && lines ? (
        // One confirm dialog (C7): opens on each fresh count (key), Cancel focused first; its button reopens it.
        <ConfirmChange
          key={review.previewId}
          initialOpen
          initialReason={reopen.reason}
          initialResult={reopen.refusal ? { ok: false, message: reopen.refusal } : null}
          title={SYNC_SCOPE_TEXT.reviewTitle}
          effect={lines.hides ?? 'Which deals come in changes as listed below.'}
          affected="Everyone: it changes which deals are in the CRM."
          confirmLabel={lines.confirmLabel}
          tone={lines.hides ? 'danger' : 'primary'}
          reason="required"
          reasonName={SETTINGS_FIELD.reason}
          reasonLabel={SETTINGS_TEXT.reasonLabel}
          reasonHint={SETTINGS_TEXT.reasonHint}
          formAction={apply}
          hiddenFields={{ [SETTINGS_FIELD.previewId]: review.previewId, [SETTINGS_FIELD.cutoff]: review.draft.cutoff, [SETTINGS_FIELD.syncEnabled]: review.draft.syncEnabled ? 'on' : 'off' }}
          trigger={{ label: SYNC_SCOPE_TEXT.reopen, variant: 'secondary', size: 'sm' }}
        >
          <div className="flex flex-col gap-3" data-slot="sync-review">
            {lines.changes.length > 0 ? (
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-copy" aria-label="What changes">
                {lines.changes.map((c) => (
                  <li key={c} className="m-0 wrap-break-word">
                    {c}
                  </li>
                ))}
              </ul>
            ) : null}
            <Notice tone={lines.hides ? 'warning' : 'info'} role="none" icon={lines.hides ? EyeOff : RefreshCw}>
              {lines.details.map((d) => (
                <p key={d}>{d}</p>
              ))}
            </Notice>
            <p className="m-0 text-copy">{lines.approval}</p>
            <p className="m-0 text-sm text-quiet">{lines.validFor}</p>
            {/* The counted ticks travel too, only so a stale count can be made again; the database applies the stored preview. */}
            {review.draft.categoryIds.map((c) => (
              <input key={`c-${c}`} type="hidden" name={SETTINGS_FIELD.categoryId} value={c} />
            ))}
            {review.draft.stageIds.map((st) => (
              <input key={`s-${st}`} type="hidden" name={SETTINGS_FIELD.stageId} value={st} />
            ))}
          </div>
        </ConfirmChange>
      ) : null}
    </div>
  );
}
