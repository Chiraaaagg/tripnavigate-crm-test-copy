'use client';

import { ArrowLeft, EyeOff, History, ListChecks, Lock, RefreshCw } from 'lucide-react';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import type { BitrixPipeline } from '@/modules/integration/bitrix/directory';
import { SETTINGS_FIELD, SETTINGS_REASON_LIMITS, type SyncPreviewActionResult, type SyncScopeDraft, type SyncScopeReviewVM } from '@/modules/settings/contracts';
import type { SyncStateModel } from '@/modules/settings/server/queries';
import { syncFieldText, syncReviewLines, type SyncApplyOutcome } from '@/modules/settings/sync-scope';
import { SETTINGS_TEXT, SYNC_SCOPE_TEXT } from '@/modules/settings/text';
import { SettingStateBadge } from './setting-state';

/*
 * Which deals come in from Bitrix (Direction A R6, M1; copy DA-259; catalog
 * gap G16). Two phases the database enforces: "Review changes" asks for the
 * exact numbers (integration_preview_sync_settings, a private preview valid
 * 10 minutes), then the confirm button applies that preview with the reason
 * (integration_apply_sync_settings). There is no one-step save: without the
 * new commands the section says so and offers nothing. Every tick, the date
 * and the reason stay on screen after any refusal (HandForm, R10); a stale
 * review comes back with fresh numbers to check again (lead ruling).
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
  const [reason, setReason] = useState(initialReason);
  // Echo-A L4 (R2): automatic updates in an Unknown state get no default; the person must choose On or Off.
  const [auto, setAuto] = useState<'on' | 'off' | null>(initialReview ? (initialReview.draft.syncEnabled ? 'on' : 'off') : current.syncEnabled === null ? null : current.syncEnabled ? 'on' : 'off');
  const [autoError, setAutoError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [previewResult, previewAction, previewPending] = useActionState(actions.preview, initialReview ? { ok: true as const, review: initialReview, message: SYNC_SCOPE_TEXT.reviewTitle } : null);
  const [applyResult, applyAction, applyPending] = useActionState(actions.apply, null);
  const [review, setReview] = useState<Ready | null>(initialReview);
  const [seenPreview, setSeenPreview] = useState(previewResult);
  const [seenApply, setSeenApply] = useState(applyResult);
  // The reply to show: the newest one, except a preview that only opened the review.
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [focus, setFocus] = useState<{ target: 'review' | 'edit' | 'reason' | 'result'; n: number } | null>(null);
  const moveFocus = (target: 'review' | 'edit' | 'reason' | 'result') => setFocus((f) => ({ target, n: (f?.n ?? 0) + 1 }));
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const resultBox = useRef<HTMLDivElement>(null);

  // New replies (render-time adjustment). A preview opens the review; an apply that saved
  // closes it; a stale apply comes back with a fresh review (new numbers) to confirm again.
  if (previewResult !== seenPreview) {
    setSeenPreview(previewResult);
    if (previewResult?.ok) {
      setReview(previewResult.review);
      setMessage(null);
      moveFocus('review');
    } else if (previewResult) {
      setMessage(previewResult);
      moveFocus('result');
    }
  }
  if (applyResult !== seenApply) {
    setSeenApply(applyResult);
    if (applyResult) setMessage(applyResult);
    if (applyResult?.ok) {
      setReview(null);
      setReason('');
      moveFocus('result');
    } else if (applyResult) {
      if (applyResult.review) setReview(applyResult.review);
      else if (applyResult.code === 'invalid_reason') setReview(null);
      moveFocus(applyResult.code === 'invalid_reason' ? 'reason' : 'result');
    }
  }

  useEffect(() => {
    if (!focus) return;
    const el = { review: reviewHeading, edit: editHeading, reason: reasonField, result: resultBox }[focus.target].current;
    el?.focus();
  }, [focus]);

  const trimmed = reason.replace(/\s+/g, ' ').trim();
  const refusedFields = previewResult && !previewResult.ok ? (previewResult.fields ?? []) : [];
  const fieldError = (field: string) => (refusedFields.includes(field) ? syncFieldText(field) : null);
  const reasonProblem = reasonError ?? (applyResult && !applyResult.ok && applyResult.code === 'invalid_reason' ? SYNC_SCOPE_TEXT.refused.invalid_reason : null);
  const reasonId = `${id}-reason`;
  const cutoffId = `${id}-cutoff`;

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value));

  const startReview = (event: { preventDefault: () => void }) => {
    if (auto === null) {
      event.preventDefault();
      setAutoError(SYNC_SCOPE_TEXT.fieldError.syncEnabled);
      document.getElementById(`${id}-auto-on`)?.focus();
      return;
    }
    setAutoError(null);
    if (trimmed.length < SETTINGS_REASON_LIMITS.min || trimmed.length > SETTINGS_REASON_LIMITS.max) {
      event.preventDefault();
      setReasonError(SYNC_SCOPE_TEXT.refused.invalid_reason);
      moveFocus('reason');
      return;
    }
    setReasonError(null);
  };

  const lines = review ? syncReviewLines(review, current, pipelines) : null;
  const stepHeading = 'm-0 text-base font-semibold text-ink outline-none';

  return (
    <div className="flex flex-col gap-4">
      <div ref={resultBox} tabIndex={-1} className="outline-none empty:hidden" data-slot="sync-result">
        {message ? (
          <Notice tone={message.ok ? 'success' : 'danger'} role={message.ok ? 'status' : 'alert'}>
            <p>{message.message}</p>
          </Notice>
        ) : null}
      </div>

      {review && lines ? (
        <HandForm action={applyAction} noValidate aria-label={SYNC_SCOPE_TEXT.reviewTitle} className="flex flex-col gap-3 rounded-control border border-line-strong bg-canvas px-3.5 py-3.5">
          <h3 ref={reviewHeading} tabIndex={-1} className={stepHeading}>
            {SYNC_SCOPE_TEXT.reviewTitle}
          </h3>
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
            {lines.hides ? <p className="font-semibold text-ink">{lines.hides}</p> : null}
            {lines.details.map((d) => (
              <p key={d}>{d}</p>
            ))}
          </Notice>
          <p className="m-0 text-copy">{lines.approval}</p>
          <p className="m-0 wrap-break-word text-copy">Reason: “{trimmed}”</p>
          <p className="m-0 text-sm text-quiet">{lines.validFor}</p>
          <input type="hidden" name={SETTINGS_FIELD.previewId} value={review.previewId} />
          <input type="hidden" name={SETTINGS_FIELD.reason} value={trimmed} />
          {/* The reviewed ticks travel too, only so a stale review can be counted again; the database applies the stored preview. */}
          {review.draft.categoryIds.map((c) => (
            <input key={`c-${c}`} type="hidden" name={SETTINGS_FIELD.categoryId} value={c} />
          ))}
          {review.draft.stageIds.map((s) => (
            <input key={`s-${s}`} type="hidden" name={SETTINGS_FIELD.stageId} value={s} />
          ))}
          <input type="hidden" name={SETTINGS_FIELD.cutoff} value={review.draft.cutoff} />
          <input type="hidden" name={SETTINGS_FIELD.syncEnabled} value={review.draft.syncEnabled ? 'on' : 'off'} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={applyPending} disabled={applyPending} className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal">
              {applyPending ? SETTINGS_TEXT.pending : lines.confirmLabel}
            </Button>
            <Button
              variant="ghost"
              disabled={applyPending}
              onClick={() => {
                setReview(null);
                moveFocus('edit');
              }}
            >
              <ArrowLeft aria-hidden="true" />
              {SYNC_SCOPE_TEXT.back}
            </Button>
          </div>
        </HandForm>
      ) : (
        <HandForm action={previewAction} onSubmit={startReview} noValidate aria-label="Change which deals come in from Bitrix" className="flex flex-col gap-4">
          <h3 ref={editHeading} tabIndex={-1} className="sr-only">
            Change which deals come in from Bitrix
          </h3>
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
                      onChange={(e) => setDraft((d) => ({ ...d, categoryIds: toggle(d.categoryIds, p.id, e.target.checked) }))}
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
                          onChange={(e) => setDraft((d) => ({ ...d, stageIds: toggle(d.stageIds, st.id, e.target.checked) }))}
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
                onChange={(e) => setDraft((d) => ({ ...d, cutoff: e.target.value }))}
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
                  setDraft((d) => ({ ...d, syncEnabled: true }));
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
                  setDraft((d) => ({ ...d, syncEnabled: false }));
                }}
              />
            </ChoiceGroup>
          </div>
          <Field htmlFor={reasonId} label={SETTINGS_TEXT.reasonLabel} hint={SETTINGS_TEXT.reasonHint} error={reasonProblem}>
            <Textarea
              ref={reasonField}
              id={reasonId}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={SETTINGS_REASON_LIMITS.max}
              invalid={Boolean(reasonProblem)}
              aria-describedby={fieldDescribedBy(reasonId, { hint: true, error: reasonProblem })}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" loading={previewPending} disabled={previewPending}>
              {previewPending ? SYNC_SCOPE_TEXT.counting : SYNC_SCOPE_TEXT.reviewButton}
            </Button>
            <span className="text-sm text-quiet">Nothing is saved until you confirm on the next step.</span>
          </div>
        </HandForm>
      )}
    </div>
  );
}
