'use client';

import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { QuotationSourceNote } from './quotation-source';
import { useEffect, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { buttonVariants } from '@/components/ui/button';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { EVIDENCE_KIND_LABEL, EVIDENCE_MAX_FILES, EVIDENCE_MIME_TYPES, type EvidenceItemView } from '@/modules/fulfilment/contracts';
import { BOOK_NOW_TEXT, BOOK_SECTION_STEP } from '@/modules/fulfilment/contracts';
import {
  B11_DEPARTMENT_LABEL,
  B11_SERVICE_LABEL,
  BOOK_SECTION_LABEL,
  BOOK_STEP_LABEL,
  BOOK_STEPS,
  CHANGE_CLASS_LABEL,
  dateText,
  inr,
  submitDialogLines,
  submitDialogTitle,
} from './book-fields';
import { useDraftSync } from './draft-sync';
import { newRequestId, PendingButton, refusedFields, ResultBox, useB11Action, type UiResult } from './form-kit';
import { itemSummary } from './service-fields';
import type { B11Action, BookChecklistItem, BookNowView, BookStep, ChangeClass } from './shapes';

/*
 * Book now step 3 · review (B1.2): what still blocks submission (each line
 * links to the section that fixes it: a plain #section on this page, or the
 * step address with the section), warnings, a summary, the customer's
 * acceptance of this exact version, and the one primary action "Submit booking
 * and create tasks" behind a confirmation that says what will and will not
 * happen. Submit is refused on the spot while any section of this step has
 * unsaved changes (unsaved typed values would never be submitted anyway).
 * Revision drafts add the change-type choice and "Save the fixed booking".
 */

export interface ReviewActions {
  submit: B11Action;
  uploadEvidence: B11Action;
  removeEvidence: B11Action;
  classifyRevision: B11Action;
  discardRevision: B11Action;
}

export interface ReviewPreview {
  submitState?: UiResult | null;
  dialogOpen?: boolean;
  uploadState?: UiResult | null;
  classifyState?: UiResult | null;
}

const stepNo = (section: BookChecklistItem['section']) => BOOK_STEPS.findIndex((s) => s.key === BOOK_SECTION_STEP[section]) + 1;

/** A plain #section on this page (not guarded), else the step address with the section (guarded). */
const sectionLink = (stepHrefs: Record<BookStep, string>, section: BookChecklistItem['section']) => (BOOK_SECTION_STEP[section] === 'finish' ? `#${section}` : `${stepHrefs[BOOK_SECTION_STEP[section]]}#${section}`);

function ChecklistLines({ items, stepHrefs, tone }: { items: BookChecklistItem[]; stepHrefs: Record<BookStep, string>; tone: 'blocking' | 'warning' }) {
  const Icon = tone === 'blocking' ? CircleX : TriangleAlert;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {items.map((item) => {
        return (
          <li key={`${item.code}-${item.section}-${(item.itemNos ?? []).join('.')}-${(item.travellerSeqs ?? []).join('.')}`} className="m-0 flex gap-2.5">
            <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', tone === 'blocking' ? 'text-status-danger' : 'text-status-warning')} />
            <span className="min-w-0">
              <span className="sr-only">{tone === 'blocking' ? 'Blocking: ' : 'Check: '}</span>
              <a href={sectionLink(stepHrefs, item.section)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                Step {stepNo(item.section)} · {BOOK_SECTION_LABEL[item.section]}
                <span className="sr-only"> ({BOOK_STEP_LABEL[item.step]})</span>
              </a>
              {': '}
              {item.travellerSeqs.length > 0 ? `traveller ${item.travellerSeqs.join(', ')}: ` : ''}
              {item.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewStep({
  view,
  stepHrefs,
  reloadHref,
  actions,
  preview = {},
}: {
  view: BookNowView;
  stepHrefs: Record<BookStep, string>;
  reloadHref: string;
  actions: ReviewActions;
  preview?: ReviewPreview;
}) {
  const version = view.version;
  const revision = Boolean(version?.revisesVersionId);
  const blocking = view.checklist.filter((i) => i.blocking);
  const warnings = view.checklist.filter((i) => !i.blocking);
  const editable = view.canEdit && version?.status === 'draft' && !view.dealNotActive;
  const stageWaiting = blocking.some((i) => i.code === 'stage_not_confirmed');
  const canSubmit = editable && view.canSubmit && blocking.length === 0 && Boolean(version);
  const submitBlockedReason = !version
    ? 'Start the booking draft first.'
    : view.dealNotActive
      ? 'This deal is lost or rejected in Bitrix, so the booking cannot be submitted.'
      : stageWaiting && blocking.length === 1
        ? 'Submission waits for the Bitrix stage “Won - Payment Received”. You can keep preparing.'
        : blocking.length > 0
          ? `${blocking.length} ${blocking.length === 1 ? 'item still blocks' : 'items still block'} submission. Fix them first.`
          : !view.canSubmit
            ? (view.submitBlockedReason ?? 'Only the deal owner or the branch Manager can submit this booking.')
            : null;
  const evidence = view.evidence.filter((e) => e.status !== 'removed');
  const items = [...view.items].sort((a, b) => a.itemNo - b.itemNo);
  return (
    <div className="flex flex-col gap-6">
      <Notice tone="info">
        <p>
          {revision
            ? 'Saving the fixed booking replaces the returned version. Accounts checks it again; departments keep their tasks. Nothing is booked or paid.'
            : 'Submitting freezes this accepted version and creates one task per service, once. It does not book any hotel, flight, cab, activity, visa or passport, and it does not approve spending. Accounts still reviews the booking and verifies money.'}
        </p>
      </Notice>

      <section aria-labelledby="review-blockers-heading" className="flex flex-col gap-3">
        <h4 id="review-blockers-heading" className="m-0 flex flex-wrap items-center gap-2 text-lg font-semibold text-ink">
          Before you can submit <span className="font-normal text-quiet">({blocking.length})</span>
        </h4>
        {blocking.length === 0 ? (
          <p className="m-0 flex items-center gap-2 text-copy">
            <CircleCheck aria-hidden="true" className="size-4 text-status-success" /> Nothing is missing.
          </p>
        ) : (
          <ChecklistLines items={blocking} stepHrefs={stepHrefs} tone="blocking" />
        )}
        {warnings.length > 0 ? (
          <>
            <h4 className="m-0 text-base font-semibold text-ink">
              Worth checking <span className="font-normal text-quiet">({warnings.length})</span>
            </h4>
            <ChecklistLines items={warnings} stepHrefs={stepHrefs} tone="warning" />
          </>
        ) : null}
      </section>

      <section aria-labelledby="review-summary-heading" className="flex flex-col gap-3">
        <h4 id="review-summary-heading" className="m-0 text-lg font-semibold text-ink">
          Summary
        </h4>
        <SummaryList>
          <SummaryRow label="Booking contact">
            {view.contacts ? `${view.contacts.contactName} · ${view.contacts.mobile ?? view.contacts.email ?? ''}` : <NotEntered />}
          </SummaryRow>
          <SummaryRow label="Trip">
            {view.trip.destination ? `${view.trip.destination} · ${dateText(view.trip.start) ?? '?'} to ${dateText(view.trip.end) ?? '?'} · ${view.trip.scope === 'international' ? 'International' : 'Domestic'}` : <NotEntered />}
          </SummaryRow>
          <SummaryRow label="Travellers">{view.travellers.length > 0 ? `${view.travellers.length} (${view.travellers.map((t) => t.fullName).join(', ')})` : <NotEntered />}</SummaryRow>
          <SummaryRow label="Services">
            {items.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {items.map((i) => (
                  <li key={i.itemId}>
                    {B11_SERVICE_LABEL[i.serviceType]} · {itemSummary(i)} → {B11_DEPARTMENT_LABEL[i.department]}
                  </li>
                ))}
              </ul>
            ) : (
              <NotEntered />
            )}
          </SummaryRow>
          {view.commercials ? (
            <SummaryRow label="Final selling total" numeric>
              {inr(view.commercials.sellingTotalPaise) ?? <NotEntered />}
            </SummaryRow>
          ) : null}
          {view.plan ? (
            <SummaryRow label="Payment plan">
              {view.plan.length > 0 ? view.plan.map((p) => `${p.label} ${inr(p.amountPaise)} due ${dateText(p.dueDate)}`).join(' · ') : <NotEntered />}
            </SummaryRow>
          ) : null}
          {view.claims ? (
            <SummaryRow label="Payments reported to Accounts" numeric>
              {view.claims.claims.length > 0 ? `${inr(view.claims.reportedPaise)} (not money until Accounts verifies)` : 'None reported'}
            </SummaryRow>
          ) : null}
        </SummaryList>
      </section>

      {revision && version ? <ChangeClassForm view={view} action={actions.classifyRevision} initialState={preview.classifyState} reloadHref={reloadHref} /> : null}

      <section aria-labelledby="review-proof-heading" className="flex flex-col gap-3">
        <h4 id="review-proof-heading" className="m-0 text-lg font-semibold text-ink">
          Customer acceptance of this exact version
        </h4>
        <p className="m-0 text-quiet">A Bitrix stage is never acceptance proof. If anything above changes after the upload, the proof must match the new details.</p>
        <QuotationSourceNote source={view.quotationSource} stale={view.checklist.some((i) => i.code === 'quote_acceptance_stale')} />
        {!view.evidenceVisible ? (
          <Notice tone="locked">Proof files are only visible to the Sales owner, assigned Sales and the branch Manager.</Notice>
        ) : evidence.length === 0 ? (
          view.quotationSource && !view.checklist.some((i) => i.code === 'quote_acceptance_stale') ? null : <p className="m-0 text-copy">No acceptance uploaded yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Proof files">
            {evidence.map((e) => (
              <ProofRow key={e.id} item={e} dealId={view.dealId} editable={Boolean(editable)} action={actions.removeEvidence} />
            ))}
          </ul>
        )}
        {editable && version && view.evidenceVisible ? <AcceptanceUploadForm dealId={view.dealId} versionId={version.versionId} fileCount={evidence.length} action={actions.uploadEvidence} initialState={preview.uploadState} /> : null}
      </section>

      <section aria-labelledby="review-submit-heading" className="flex flex-col gap-3 border-t border-line pt-4">
        <h4 id="review-submit-heading" className="sr-only">
          Submit
        </h4>
        {submitBlockedReason ? (
          <p id="review-submit-reason" className="m-0 text-copy">
            {submitBlockedReason}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex flex-col gap-2 sm:flex-row">
            {revision && editable && version ? <DiscardRevisionForm view={view} action={actions.discardRevision} /> : null}
            {version ? (
              <SubmitBookingForm
                view={view}
                disabled={!canSubmit}
                describedBy={submitBlockedReason ? 'review-submit-reason' : undefined}
                action={actions.submit}
                initialState={preview.submitState}
                defaultOpen={preview.dialogOpen}
                reloadHref={reloadHref}
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

export function ProofRow({ item, dealId, editable, action }: { item: EvidenceItemView; dealId: string; editable: boolean; action: B11Action }) {
  const problem = item.status === 'failed' || item.status === 'pending_upload';
  const [state, formAction] = useB11Action(action, {});
  return (
    <li className={cn('m-0 flex flex-wrap items-center gap-3 rounded-control border px-3.5 py-3', problem ? 'border-status-danger-line bg-status-danger-tint' : 'border-line bg-canvas')}>
      {problem ? <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-status-danger" /> : <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-success" />}
      <div className="min-w-48 flex-1">
        <p className="m-0 font-medium wrap-anywhere text-ink">{item.fileName}</p>
        <p className={cn('m-0 text-sm', problem ? 'text-status-danger' : 'text-quiet')}>
          {EVIDENCE_KIND_LABEL[item.kind]} · {item.sizeLabel} · {problem ? 'Upload did not finish: not stored. Remove it or upload it again.' : 'Stored'}
          {item.uploadedByYou ? ' · uploaded by you' : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.status === 'stored' ? (
          <a className={buttonVariants({ variant: 'secondary', size: 'sm' })} href={`/app/bookings/evidence/${item.id}`} rel="noopener">
            Download<span className="sr-only"> {item.fileName}</span>
          </a>
        ) : null}
        {editable ? (
          <form action={formAction} noValidate>
            <input type="hidden" name="dealId" value={dealId} />
            <input type="hidden" name="evidenceId" value={item.id} />
            <PendingButton pendingLabel="Removing…" variant="ghost" className="min-h-8">
              Remove<span className="sr-only"> {item.fileName}</span>
            </PendingButton>
          </form>
        ) : null}
      </div>
      {state && !state.ok ? <ResultBox result={state} className="basis-full" /> : null}
    </li>
  );
}

export function AcceptanceUploadForm({ dealId, versionId, fileCount, action, initialState }: { dealId: string; versionId: string; fileCount: number; action: B11Action; initialState?: UiResult | null }) {
  const [state, formAction] = useB11Action(action, { initialState });
  if (fileCount >= EVIDENCE_MAX_FILES) {
    return <Notice tone="info">You have uploaded the maximum of {EVIDENCE_MAX_FILES} files. Remove one to add another.</Notice>;
  }
  return (
    <form action={formAction} noValidate aria-label="Upload the customer’s acceptance" className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-4">
      <ResultBox
        result={state && !state.ok && state.code === 'upload_failed' ? { ...state, message: 'The upload did not finish. The file is not stored and the form is unchanged. Try again.' } : state}
        successText="Acceptance proof stored for this version."
      />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="kind" value="acceptance_message" />
      <Field htmlFor="bk-proof-file" label="Acceptance file" hint="Screenshot or PDF of the customer saying yes. PDF, JPG, PNG or WebP, up to 4 MB.">
        <input
          id="bk-proof-file"
          name="file"
          type="file"
          accept={EVIDENCE_MIME_TYPES.join(',')}
          aria-describedby={fieldDescribedBy('bk-proof-file', { hint: true })}
          className="block w-full rounded-control border border-control bg-card px-3 py-2 font-sans text-base text-ink file:mr-3 file:rounded-control file:border-0 file:bg-wash file:px-3 file:py-1.5 file:font-semibold file:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-strong"
        />
      </Field>
      <div>
        <PendingButton pendingLabel="Uploading…" variant="secondary">
          Upload acceptance
        </PendingButton>
      </div>
    </form>
  );
}

export function SubmitBookingForm({
  view,
  disabled,
  describedBy,
  action,
  initialState,
  defaultOpen = false,
  reloadHref,
  triggerId,
}: {
  view: BookNowView;
  disabled: boolean;
  /** Booking form: id of the button that opens the dialog (the sticky footer presses it). */
  triggerId?: string;
  describedBy?: string;
  action: B11Action;
  initialState?: UiResult | null;
  defaultOpen?: boolean;
  reloadHref: string;
}) {
  const version = view.version!;
  const T = submitDialogTitle(view);
  const lines = submitDialogLines(view);
  const [open, setOpen] = useState(defaultOpen || Boolean(initialState && !initialState.ok));
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action, { initialState, onSuccess: () => setOpen(false) });
  const sync = useDraftSync();
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const [unsavedTick, setUnsavedTick] = useState(0);
  useEffect(() => {
    if (unsavedTick > 0) document.getElementById('review-unsaved')?.focus();
  }, [unsavedTick]);
  const openIfSaved = (next: boolean) => {
    if (next) {
      const dirty = sync.dirtyEntries();
      if (dirty.length > 0) {
        // Refused on the client before any call: unsaved typed values would never be submitted.
        setUnsaved(BOOK_NOW_TEXT.unsavedInSections.replace('{sections}', dirty.map((e) => e.label).join(', ')));
        setUnsavedTick((n) => n + 1);
        return;
      }
    }
    setUnsaved(null);
    setOpen(next);
  };
  return (
    <Dialog open={open} onOpenChange={openIfSaved}>
      {unsaved ? (
        <p id="review-unsaved" role="alert" tabIndex={-1} className="m-0 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-3 text-copy outline-none">
          Not submitted. {unsaved}
        </p>
      ) : null}
      {disabled ? (
        <Button id={triggerId} variant="primary" size="lg" aria-disabled="true" aria-describedby={describedBy} className="min-h-11" onClick={(e) => e.preventDefault()}>
          {T.confirmLabel}
        </Button>
      ) : (
        <DialogTrigger asChild>
          <Button id={triggerId} variant="primary" size="lg" className="min-h-11">
            {T.confirmLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent closeLabel="Close without submitting">
        <form action={formAction} noValidate>
          <DialogHeader>
            <DialogTitle>{T.title}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <ResultBox result={state} reloadHref={reloadHref} />
            {/* Copy BR-11: no lead-in line; the list itself describes the dialog. */}
            <DialogDescription asChild>
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-copy">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </DialogDescription>
            <input type="hidden" name="dealId" value={view.dealId} />
            <input type="hidden" name="versionId" value={version.versionId} />
            <input type="hidden" name="contentHash" value={version.contentHash} />
            <input type="hidden" name="requestId" value={requestId} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
              {T.cancelLabel}
            </Button>
            <PendingButton pendingLabel="Submitting…" variant="primary">
              {T.confirmLabel}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChangeClassForm({ view, action, initialState, reloadHref }: { view: BookNowView; action: B11Action; initialState?: UiResult | null; reloadHref: string }) {
  const version = view.version!;
  const [value, setValue] = useState<ChangeClass | ''>(version.changeClass ?? '');
  const [state, formAction] = useB11Action(action, { initialState });
  const invalid = Boolean(refusedFields(state)?.includes('changeClass'));
  return (
    <section aria-labelledby="bk-class-heading" className="flex flex-col gap-3">
      <h4 id="bk-class-heading" className="m-0 text-lg font-semibold text-ink">
        What kind of change is this?
      </h4>
      {version.changedFields.length > 0 ? (
        <p className="m-0 text-copy">Changed since version {version.revisesVersionNo}: {version.changedFields.length} {version.changedFields.length === 1 ? 'field' : 'fields'}. Each changed field shows “Was:” on its step.</p>
      ) : null}
      <HandForm action={formAction} noValidate className="flex flex-col gap-3">
        <ResultBox result={state} reloadHref={reloadHref} successText="Change type saved. Saving any field again clears it." />
        <input type="hidden" name="dealId" value={view.dealId} />
        <input type="hidden" name="versionId" value={version.versionId} />
        <input type="hidden" name="rowVersion" value={version.rowVersion} />
        <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0" aria-invalid={invalid || undefined}>
          <legend className="sr-only">Change type</legend>
          {(Object.keys(CHANGE_CLASS_LABEL) as ChangeClass[]).filter((k) => !version.allowedClasses || version.allowedClasses.includes(k)).map((k) => (
            <label key={k} htmlFor={`bk-class-${k}`} className="flex cursor-pointer items-start gap-2.5 rounded-control border border-line bg-card px-3.5 py-3 has-[:checked]:border-brand-strong has-[:checked]:bg-brand-tint">
              <input
                id={`bk-class-${k}`}
                type="radio"
                name="changeClass"
                value={k}
                checked={value === k}
                onChange={() => setValue(k)}
                aria-describedby={`bk-class-${k}-rule`}
                className="m-0 mt-0.5 size-4 shrink-0 accent-brand-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong"
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{CHANGE_CLASS_LABEL[k].title}</span>
                <span id={`bk-class-${k}-rule`} className="block text-sm text-copy">
                  {CHANGE_CLASS_LABEL[k].rule}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <PendingButton pendingLabel="Saving…" variant="secondary" disabled={!value}>
            Save the change type
          </PendingButton>
        </div>
      </HandForm>
    </section>
  );
}

export function DiscardRevisionForm({ view, action }: { view: BookNowView; action: B11Action }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useB11Action(action, {});
  const version = view.version!;
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <ResultBox result={state} successText="Your changes were discarded. The returned version stays as it was." />
      <input type="hidden" name="dealId" value={view.dealId} />
      <input type="hidden" name="versionId" value={version.versionId} />
      <input type="hidden" name="rowVersion" value={version.rowVersion} />
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-copy">Discard all changes in this fix?</span>
          <PendingButton pendingLabel="Discarding…" variant="danger">
            Yes, discard my changes
          </PendingButton>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep editing
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="lg" className="min-h-11" onClick={() => setConfirming(true)}>
          Discard this fix
        </Button>
      )}
    </form>
  );
}
