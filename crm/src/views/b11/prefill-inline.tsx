'use client';

import { ChevronDown, Download, Info, PenLine } from 'lucide-react';
import { createContext, useContext, useState, useTransition, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PREFILL_FIELD } from '@/modules/fulfilment/b11-forms';
import { PREFILL_FIELD_LABEL, PREFILL_SKIP_TEXT, PREFILL_TEXT, type PrefillFieldCode, type PrefillTargetKind, type PrefillView } from '@/modules/fulfilment/contracts';
import type { PrefillFillEmptyResult, PrefillMarkerVM, PrefillNoticeVM, PrefillSectionKey, PrefillSectionVM, PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { dateText } from './book-fields';
import { BaseRowVersion, useDraftSync, useSectionForm, type SyncSection } from './draft-sync';
import { PendingButton, ResultBox, type UiResult } from './form-kit';
import { prefillHint } from './prefill-panel';
import type { B11Action } from './shapes';

/*
 * Batch 2 "From Bitrix" inline mode (switch prefill_auto_fill on; lead ruling
 * D1; screen plan BK-02/BK-03, QU-02; catalog gap G6). Values already sit in
 * the real fields (filled when the draft was created, or by "Fill empty
 * fields from Bitrix"). Beside a field label: a small "From Bitrix" button
 * that shows where the value came from (words, never colour alone). Under a
 * field: one line "Bitrix now says … Use it · Keep mine" when Bitrix changed
 * after the fill. Per section: "I checked these Bitrix details". No "Use
 * Bitrix value" buttons in this mode. Billing, GSTIN, consent and the contact
 * confirmation tick never carry a marker and are never filled.
 *
 * Every form posts only the target, version, row version and field codes;
 * values come from the database snapshot, never from the browser. Use it,
 * Keep mine and Fill empty fields wait while a form of the page has unsaved
 * changes, so a typed value is never silently paired with a fill.
 */

export const PREFILL_INLINE_TEXT = {
  checkWithCustomer: 'Check with the customer.',
  bitrixNowSays: 'Bitrix now says',
  useIt: 'Use it',
  keepMine: 'Keep mine',
  sectionCheck: 'I checked these Bitrix details',
  sectionCheckHint: 'Marks the details below that came from Bitrix as checked with the customer.',
  fillEmpty: 'Fill empty fields from Bitrix',
  fillEmptyHint: 'Fills only empty fields that nobody typed in or cleared. It never replaces what you typed.',
  saveFirst: 'Save your changes first',
  detailsSummary: 'About the Bitrix details',
  readAt: 'Read from Bitrix',
  notFilled: 'Not filled from Bitrix',
  otherChanges: 'Bitrix now has a different value for',
  contactCheck: 'Details from Bitrix still need your check with the customer.',
  /** DA-168: shown under the contact tick while the mobile or email still carries a Bitrix marker. */
  contactTickChecks: 'Ticking this also marks the mobile number and email from Bitrix as checked.',
} as const;

export interface PrefillInlineActions {
  use?: B11Action;
  check?: B11Action;
  fillEmpty?: B11Action;
  dismiss?: B11Action;
}

interface PrefillInlineContext {
  ui: PrefillUiVM | null;
  /** The panel-mode read (today's hints), used when `ui` is absent or in panel mode. */
  panel: PrefillView | null | undefined;
  target: PrefillTargetKind;
  versionId: string;
  dealId: string | null;
  rowVersion: number;
  editable: boolean;
  actions: PrefillInlineActions;
  reloadHref?: string;
}

const Ctx = createContext<PrefillInlineContext | null>(null);

export function PrefillInlineProvider({ children, ...value }: PrefillInlineContext & { children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useCtx(): PrefillInlineContext | null {
  return useContext(Ctx);
}

/** The inline sections of the read, when the screen is in inline mode. */
function inlineOf(ctx: PrefillInlineContext | null): Extract<PrefillUiVM, { mode: 'inline' }> | null {
  return ctx?.ui && ctx.ui.mode === 'inline' ? ctx.ui : null;
}

function findField(ui: Extract<PrefillUiVM, { mode: 'inline' }>, fieldId: string): { section: PrefillSectionVM; marker: PrefillMarkerVM | null; notice: PrefillNoticeVM | null } | null {
  for (const section of ui.sections) {
    const marker = section.fields.find((f) => f.fieldId === fieldId) ?? null;
    const notice = section.notices.find((n) => n.fieldId === fieldId) ?? null;
    if (marker || notice) return { section, marker, notice };
  }
  return null;
}

/** Hidden inputs every prefill form posts (no values). */
function TargetInputs({ ctx, base, codes }: { ctx: PrefillInlineContext; base: number; codes: readonly PrefillFieldCode[] }) {
  return (
    <>
      <input type="hidden" name={PREFILL_FIELD.target} value={ctx.target} />
      <input type="hidden" name="versionId" value={ctx.versionId} />
      {ctx.dealId ? <input type="hidden" name="dealId" value={ctx.dealId} /> : null}
      <BaseRowVersion base={base} />
      {codes.map((c) => (
        <input key={c} type="hidden" name={PREFILL_FIELD.field} value={c} />
      ))}
    </>
  );
}

function sectionOfField(target: PrefillTargetKind, code: PrefillFieldCode): SyncSection {
  if (target === 'booking_version') return code.startsWith('trip.') ? 'trip' : 'customer';
  return code.startsWith('contacts.') ? 'contact' : 'details';
}

/**
 * Hint, marker and notice of one field. In panel mode (switch off) it gives
 * today's hint only ("From Bitrix. Check with the customer.").
 */
export function usePrefillField(fieldId: string, code: PrefillFieldCode, baseHint?: ReactNode): { hint: ReactNode; aside?: ReactNode; extra?: ReactNode } {
  const ctx = useCtx();
  const [openDetails, setOpenDetails] = useState(false);
  const ui = inlineOf(ctx);
  if (!ctx || !ui) return { hint: prefillHint(ctx?.panel ?? null, code, baseHint) };
  const found = findField(ui, fieldId);
  if (!found) return { hint: baseHint };
  const { marker, notice } = found;
  const state = marker?.marker ?? null;
  const markHint = state === 'from_bitrix' || state === 'kept' ? PREFILL_INLINE_TEXT.checkWithCustomer : null;
  const hint = markHint ? (
    <>
      <span className="font-semibold text-status-info">
        <span className="sr-only">{marker?.markerText}. </span>
        {markHint}
      </span>
      {baseHint ? <> {baseHint}</> : null}
    </>
  ) : (
    baseHint
  );
  const detailsId = `${fieldId}-bitrix`;
  const aside =
    marker && marker.markerText ? (
      marker.detailsText ? (
        <button
          type="button"
          aria-expanded={openDetails}
          aria-controls={detailsId}
          onClick={() => setOpenDetails((x) => !x)}
          className={cn('m-0 inline-flex min-h-8 items-center gap-1 rounded-chip border-0 bg-transparent px-1.5 text-sm font-medium text-brand-strong shadow-none hover:bg-wash', focusRing)}
        >
          {state === 'changed' ? <PenLine aria-hidden="true" className="size-3.5" /> : <Download aria-hidden="true" className="size-3.5" />}
          {marker.markerText}
          <span className="sr-only"> for {marker.label}: details</span>
          <ChevronDown aria-hidden="true" className={cn('size-3.5 transition-transform motion-reduce:transition-none', openDetails && 'rotate-180')} />
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-quiet">
          <Download aria-hidden="true" className="size-3.5" />
          {marker.markerText}
        </span>
      )
    ) : undefined;
  const extra = (
    <>
      {marker?.detailsText ? (
        <p id={detailsId} hidden={!openDetails} className="m-0 text-sm text-quiet">
          {marker.detailsText}
        </p>
      ) : null}
      {notice && notice.inline ? <PrefillNoticeLine ctx={ctx} notice={notice} label={marker?.label ?? ''} /> : null}
    </>
  );
  return { hint, aside, extra };
}

/** "Bitrix now says 12 Nov 2026. Use it · Keep mine" under one field. */
function PrefillNoticeLine({ ctx, notice, label }: { ctx: PrefillInlineContext; notice: PrefillNoticeVM; label: string }) {
  const sync = useDraftSync();
  const sectionKey = sectionOfField(ctx.target, notice.field);
  const sectionDirty = sync.dirtyEntries().some((e) => e.section === sectionKey);
  const canAct = ctx.editable && !sectionDirty;
  const reasonId = `${notice.fieldId}-bitrix-now-reason`;
  return (
    <div role="group" aria-label={`Bitrix update for ${label}`} className="flex flex-col gap-1.5 rounded-control border border-status-info-line bg-status-info-tint px-3 py-2 text-sm text-copy">
      <p className="m-0 flex gap-1.5">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
        <span className="min-w-0">
          {PREFILL_INLINE_TEXT.bitrixNowSays} <span className="font-semibold wrap-anywhere text-ink">{notice.bitrixValueText}</span>.
        </span>
      </p>
      {ctx.editable && (notice.canUse || notice.canKeep) ? (
        <div className="flex flex-wrap items-center gap-2">
          {notice.canUse && ctx.actions.use ? <NoticeForm ctx={ctx} kind="use" notice={notice} disabled={!canAct} describedBy={sectionDirty ? reasonId : undefined} label={label} /> : null}
          {notice.canKeep && ctx.actions.dismiss ? <NoticeForm ctx={ctx} kind="keep" notice={notice} disabled={!canAct} describedBy={sectionDirty ? reasonId : undefined} label={label} /> : null}
          {sectionDirty ? (
            <span id={reasonId} className="text-quiet">
              {PREFILL_INLINE_TEXT.saveFirst}.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NoticeForm({ ctx, kind, notice, disabled, describedBy, label }: { ctx: PrefillInlineContext; kind: 'use' | 'keep'; notice: PrefillNoticeVM; disabled: boolean; describedBy?: string; label: string }) {
  const action = (kind === 'use' ? ctx.actions.use : ctx.actions.dismiss)!;
  const f = useSectionForm({
    id: `prefill-${kind}-${notice.fieldId}`,
    section: sectionOfField(ctx.target, notice.field),
    label: kind === 'use' ? `Use the Bitrix value for ${label}` : `Keep your value for ${label}`,
    order: 900,
    action,
    initial: {},
    versionBound: true,
    rowVersion: ctx.rowVersion,
    saveable: false,
    tracksDirty: false,
  });
  const { bindResult, formAction, state, base } = f;
  const [pending, startTransition] = useTransition();
  // The line sits inside the field's own form, so it cannot be a nested <form>: the button posts its own FormData.
  const press = () => {
    const fd = new FormData();
    fd.set(PREFILL_FIELD.target, ctx.target);
    fd.set('versionId', ctx.versionId);
    if (ctx.dealId) fd.set('dealId', ctx.dealId);
    fd.set('rowVersion', String(base));
    fd.append(PREFILL_FIELD.field, notice.field);
    if (kind === 'keep') fd.set(PREFILL_FIELD.sourceModifiedAt, notice.sourceModifiedAt);
    startTransition(async () => {
      await formAction(fd);
    });
  };
  return (
    <>
      <Button type="button" variant={kind === 'use' ? 'secondary' : 'ghost'} size="sm" loading={pending} disabled={disabled || pending} aria-describedby={describedBy} onClick={press} className="min-h-9">
        {pending ? (kind === 'use' ? 'Using…' : 'Keeping…') : kind === 'use' ? PREFILL_INLINE_TEXT.useIt : PREFILL_INLINE_TEXT.keepMine}
        <span className="sr-only"> for {label}</span>
      </Button>
      <div ref={bindResult} className={state && !state.ok ? 'basis-full' : 'hidden'}>
        {state && !state.ok ? <ResultBox result={state} reloadHref={ctx.reloadHref} /> : null}
      </div>
    </>
  );
}

/**
 * Per section: "I checked these Bitrix details" (posts the section's
 * from-Bitrix and kept fields; the database never upgrades a changed value)
 * and the details on demand: when Bitrix was read, what was not filled and
 * why, Bitrix changes shown only here.
 */
export function PrefillSectionCheck({ section, idPrefix }: { section: PrefillSectionKey; idPrefix: string }) {
  const ctx = useCtx();
  const ui = inlineOf(ctx);
  if (!ctx || !ui) return null;
  const vm = ui.sections.find((s) => s.section === section);
  if (!vm) return null;
  const detailsOnly = vm.notices.filter((n) => !n.inline);
  const hasDetails = Boolean(vm.details.readAt) || vm.details.issues.length > 0 || vm.details.notFilled.length > 0 || detailsOnly.length > 0;
  if (!vm.canCheck && !hasDetails) return null;
  return (
    <div className="flex flex-col gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
      {vm.canCheck && ctx.editable && ctx.actions.check ? <SectionCheckForm ctx={ctx} vm={vm} idPrefix={idPrefix} /> : null}
      {hasDetails ? (
        <details className="group">
          <summary className={cn('flex min-h-11 cursor-pointer items-center gap-1.5 rounded-control font-medium text-brand-strong', focusRing)}>
            <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            {PREFILL_INLINE_TEXT.detailsSummary}
          </summary>
          <div className="mt-1.5 flex flex-col gap-2 text-sm text-copy">
            {vm.details.readAt ? (
              <p className="m-0">
                {PREFILL_INLINE_TEXT.readAt} {dateText(vm.details.readAt)}.
              </p>
            ) : null}
            {vm.details.issues.map((t) => (
              <p key={t} className="m-0">
                {t}
              </p>
            ))}
            {vm.fields.filter((f) => f.detailsText).length > 0 ? (
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                {vm.fields
                  .filter((f) => f.detailsText)
                  .map((f) => (
                    <li key={f.field}>
                      {f.label}: {f.detailsText}
                    </li>
                  ))}
              </ul>
            ) : null}
            {vm.details.notFilled.length > 0 ? (
              <>
                <p className="m-0 font-semibold text-ink">{PREFILL_INLINE_TEXT.notFilled}</p>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                  {vm.details.notFilled.map((n) => (
                    <li key={n.field}>
                      {n.label}: {n.reasonText}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {detailsOnly.length > 0 ? (
              <>
                <p className="m-0 font-semibold text-ink">{PREFILL_INLINE_TEXT.otherChanges}</p>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                  {detailsOnly.map((n) => (
                    <li key={n.field}>
                      {vm.fields.find((f) => f.field === n.field)?.label ?? n.field}: {n.bitrixValueText}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SectionCheckForm({ ctx, vm, idPrefix }: { ctx: PrefillInlineContext; vm: PrefillSectionVM; idPrefix: string }) {
  const f = useSectionForm({
    id: `${idPrefix}-prefill-check`,
    section: vm.section as SyncSection,
    label: PREFILL_INLINE_TEXT.sectionCheck,
    order: 901,
    action: ctx.actions.check!,
    initial: {},
    versionBound: true,
    rowVersion: ctx.rowVersion,
    saveable: false,
    tracksDirty: false,
  });
  const { bindForm, bindResult, formAction, state, base } = f;
  const hintId = `${idPrefix}-prefill-check-hint`;
  const labels = vm.fields.filter((x) => vm.checkable.includes(x.field)).map((x) => x.label);
  return (
    <form ref={bindForm} action={formAction} noValidate className="flex flex-col gap-2">
      <div ref={bindResult}>
        <ResultBox result={state} reloadHref={ctx.reloadHref} />
      </div>
      <TargetInputs ctx={ctx} base={base} codes={vm.checkable} />
      <div className="flex flex-wrap items-center gap-3">
        <PendingButton pendingLabel="Saving…" variant="secondary" describedBy={hintId}>
          {PREFILL_INLINE_TEXT.sectionCheck}
        </PendingButton>
        <span id={hintId} className="text-sm text-quiet">
          {labels.length > 0 ? `${labels.join(', ')}.` : PREFILL_INLINE_TEXT.sectionCheckHint}
        </span>
      </div>
    </form>
  );
}

/**
 * The answer of "Fill empty fields from Bitrix" when it filled nothing: a fill
 * that skips every field still answers ok with an empty list, so say "Nothing
 * was filled from Bitrix." and why for each field, never an empty
 * "Filled from Bitrix:" line. null = use the server's own message.
 */
function fillResultText(state: UiResult | null): string | null {
  if (!state || !state.ok) return null;
  const data = (state as { data?: unknown }).data as Partial<PrefillFillEmptyResult> | undefined;
  if (!data || !Array.isArray(data.filled) || data.filled.length > 0) return null;
  const reasons = (data.skipped ?? []).map((sk) => PREFILL_TEXT.skipped.replace('{field}', PREFILL_FIELD_LABEL[sk.field] ?? sk.field).replace('{reason}', PREFILL_SKIP_TEXT[sk.reason] ?? ''));
  return [PREFILL_TEXT.appliedNone, ...reasons].join(' ');
}

/**
 * "Fill empty fields from Bitrix" (older drafts without a creation fill).
 * Disabled while any form of the page has unsaved changes.
 */
export function PrefillFillEmpty({ idPrefix }: { idPrefix: string }) {
  const ctx = useCtx();
  const ui = inlineOf(ctx);
  const sync = useDraftSync();
  if (!ctx || !ui || !ui.fillEmpty.offered || !ctx.editable || !ctx.actions.fillEmpty) return null;
  const reason = sync.anyDirty ? PREFILL_INLINE_TEXT.saveFirst : ui.fillEmpty.disabledReason;
  return <FillEmptyForm ctx={ctx} idPrefix={idPrefix} reason={reason} />;
}

function FillEmptyForm({ ctx, idPrefix, reason }: { ctx: PrefillInlineContext; idPrefix: string; reason: string | null }) {
  const f = useSectionForm({
    id: `${idPrefix}-prefill-fill-empty`,
    section: ctx.target === 'booking_version' ? 'customer' : 'details',
    label: PREFILL_INLINE_TEXT.fillEmpty,
    order: 0.5,
    action: ctx.actions.fillEmpty!,
    initial: {},
    versionBound: true,
    rowVersion: ctx.rowVersion,
    saveable: false,
    tracksDirty: false,
  });
  const { bindForm, bindResult, formAction, state, base } = f;
  const hintId = `${idPrefix}-prefill-fill-empty-hint`;
  return (
    <form ref={bindForm} action={formAction} noValidate className="flex flex-col gap-2 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3">
      <div ref={bindResult}>
        <ResultBox result={state} reloadHref={ctx.reloadHref} successText={fillResultText(state) ?? undefined} />
      </div>
      <TargetInputs ctx={ctx} base={base} codes={[]} />
      <div className="flex flex-wrap items-center gap-3">
        <PendingButton pendingLabel="Filling…" variant="secondary" disabled={Boolean(reason)} describedBy={hintId}>
          {PREFILL_INLINE_TEXT.fillEmpty}
        </PendingButton>
        <span id={hintId} className="min-w-0 flex-1 text-sm text-copy">
          {reason ? `${reason}. ` : ''}
          {PREFILL_INLINE_TEXT.fillEmptyHint}
        </span>
      </div>
    </form>
  );
}

/**
 * Reference only (never copied into a booking): Bitrix booking notes (price
 * readers), the Customer Type label and the Bitrix traveller total; or the
 * "not available" line.
 */
export function PrefillReference() {
  const ctx = useCtx();
  const ui = inlineOf(ctx);
  if (!ui) return null;
  if (!ui.available) {
    return ui.unavailableText ? (
      <p className="m-0 flex gap-2 text-sm text-copy">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
        {ui.unavailableText}
      </p>
    ) : null;
  }
  const r = ui.reference;
  const notes = r.notesHidden ? 'Booking Notes from Bitrix are shown only to staff who can see the price.' : r.bookingNotes;
  if (!notes && !r.customerTypeLabel && r.travellerTotal === null) return null;
  return (
    <Notice tone="info" title="From Bitrix, for reference">
      <dl className="m-0 flex flex-col gap-1 text-sm">
        {notes ? (
          <>
            <dt className="font-semibold text-quiet">Bitrix booking notes (for reference, not copied)</dt>
            <dd className="m-0 mb-1.5 whitespace-pre-line text-copy">{notes}</dd>
          </>
        ) : null}
        {r.customerTypeLabel ? (
          <>
            <dt className="font-semibold text-quiet">Customer Type</dt>
            <dd className="m-0 mb-1.5 text-copy">{r.customerTypeLabel}</dd>
          </>
        ) : null}
        {r.travellerTotal !== null ? (
          <>
            <dt className="font-semibold text-quiet">Travellers in Bitrix</dt>
            <dd className="m-0 text-copy">Bitrix says {r.travellerTotal}. Enter adults and children yourself.</dd>
          </>
        ) : null}
      </dl>
    </Notice>
  );
}

/** True when the screen shows Bitrix values inline (switch on); panel mode otherwise. */
export function usePrefillInlineMode(): boolean {
  return Boolean(inlineOf(useCtx()));
}
