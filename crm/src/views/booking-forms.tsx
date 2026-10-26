'use client';

import { unstable_rethrow } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { HandForm, useSavedKey } from '@/components/hand-form';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SubmitButton } from '@/components/SubmitButton';
import {
  BOOKING_FACT_LIMITS,
  type BookingActionResult,
  type BookingFacts,
  type BookingIssueCode,
  CONFIRM_DIALOG_TEXT,
  CONFIRM_SUCCESS_TEXT,
  ERROR_TEXT,
  EVIDENCE_KIND_LABEL,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  EVIDENCE_MIME_TYPES,
  type EvidenceKind,
  ISSUE_TEXT,
  UNKNOWN_OUTCOME_TEXT,
} from '@/modules/fulfilment/contracts';
import { FIELD, paiseToRupeesInput } from '@/modules/fulfilment/forms';
import {
  BOOKING_TOTAL_HINT,
  BOOKING_TOTAL_LABEL,
  FIELD_ID,
  type FieldKey,
  ISSUE_FIELD,
  PURCHASE_BUDGET_HINT,
  PURCHASE_BUDGET_LABEL,
  SECTION_FIELDS,
  type SectionKey,
  type SectionStatus,
  sectionStatus,
  sectionStatusText,
} from './booking-fields';
import { HiddenForRole } from './value-states';
import {
  confirmBookingAction,
  openBookingDraftAction,
  removeBookingEvidenceAction,
  saveBookingDraftAction,
  uploadBookingEvidenceAction,
} from '@/modules/fulfilment/server/actions';

/** Text for a failure the action could not explain (it threw). Typed work stays in the form. */
export const UNEXPECTED_TEXT = `${UNKNOWN_OUTCOME_TEXT} Your typed details are still here.`;

/** Session flag set when a confirm is submitted, so focus can move to the panel heading after the refresh. */
export const CONFIRM_FOCUS_FLAG = 'tn-booking-confirm-submitted';

/** Every result a booking form can show: the action's own result, or an unexplained failure. */
export type UiResult = BookingActionResult<unknown> | { ok: false; code: 'unexpected'; message: string; issues?: undefined };

/**
 * Wraps a server action so an unexpected throw becomes an honest in-form error
 * instead of replacing the page (which would discard typed work). Framework
 * redirects (for example an ended session) are rethrown untouched.
 */
export function guard<T>(action: (prev: never, formData: FormData) => Promise<BookingActionResult<T>>) {
  return async (_prev: UiResult | null, formData: FormData): Promise<UiResult> => {
    try {
      return (await action(null as never, formData)) as UiResult;
    } catch (error) {
      unstable_rethrow(error);
      return { ok: false, code: 'unexpected', message: UNEXPECTED_TEXT };
    }
  };
}

export const EVIDENCE_MAX_MB = Math.floor(EVIDENCE_MAX_BYTES / (1024 * 1024));

/** Shared Error:/Done: announcement for booking action results (text carries the meaning). */
export function BookingResultMessage({
  result,
  children,
}: {
  result: UiResult | null;
  /** Extra content under an error, such as a "Load the latest details" button. */
  children?: React.ReactNode;
}) {
  if (result && !result.ok) {
    return (
      <div className="message error" role="alert">
        <strong>Error: </strong>
        {result.message || (result.code === 'unexpected' ? UNEXPECTED_TEXT : ERROR_TEXT[result.code])}
        {result.issues && result.issues.length > 0 ? (
          <ul className="mt-1 mb-0">
            {result.issues.map((code) => (
              <li key={code}>{ISSUE_TEXT[code]}</li>
            ))}
          </ul>
        ) : null}
        {children}
      </div>
    );
  }
  if (result?.ok) {
    return (
      <div className="message success" role="status">
        <strong>Done: </strong>
        {result.message}
      </div>
    );
  }
  return <div role="status" aria-live="polite" />;
}

export function OpenBookingDraftForm({
  dealId,
  initialState = null,
}: {
  dealId: string;
  initialState?: UiResult | null;
}) {
  const [state, action] = useActionState(guard(openBookingDraftAction), initialState ?? null);
  return (
    <form action={action} noValidate className="primary-slot">
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <SubmitButton pendingLabel="Starting…">Start hotel booking details</SubmitButton>
      <BookingResultMessage result={state} />
    </form>
  );
}

type Values = Record<FieldKey, string>;

function valuesFrom(facts: BookingFacts | null, sellingTotalPaise: string | null | undefined): Values {
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  return {
    hotelName: s(facts?.hotelName),
    city: s(facts?.city),
    checkIn: s(facts?.checkIn),
    checkOut: s(facts?.checkOut),
    rooms: s(facts?.rooms),
    roomType: s(facts?.roomType),
    mealPlan: s(facts?.mealPlan),
    adults: s(facts?.adults),
    children: s(facts?.children),
    inclusions: s(facts?.inclusions),
    specialRequests: s(facts?.specialRequests),
    purchaseBudgetRupees: paiseToRupeesInput(facts?.purchaseBudgetPaise),
    sellingTotalRupees: paiseToRupeesInput(sellingTotalPaise ?? null),
  };
}

export interface DraftEditorProps {
  dealId: string;
  versionId: string;
  versionNo: number;
  rowVersion: number;
  contentHash: string | null;
  facts: BookingFacts | null;
  /** undefined: the viewer may not see commercial values, so the field is not rendered at all. */
  sellingTotalPaise?: string | null;
  issues: BookingIssueCode[];
  /** Ready, permitted and not gated: the confirm dialog is offered at the top of the panel. */
  confirmAvailable: boolean;
  /** Preview gallery only. */
  initialSaveState?: UiResult | null;
}

/**
 * The draft facts form plus the confirm dialog. Inputs are controlled, so typed
 * work survives every error (React resets uncontrolled forms after an action).
 * The row version the edits are based on is kept until the person explicitly
 * loads the latest details, so a conflicting save can never silently overwrite
 * someone else's change.
 */
export function BookingDraftEditor(props: DraftEditorProps) {
  const { dealId, versionId, issues } = props;
  const showSelling = props.sellingTotalPaise !== undefined;
  const [values, setValues] = useState<Values>(() => valuesFrom(props.facts, props.sellingTotalPaise));
  const [saved, setSaved] = useState<Values>(values);
  const [baseRowVersion, setBaseRowVersion] = useState(props.rowVersion);

  const [saveState, saveAction] = useActionState(
    async (prev: UiResult | null, formData: FormData) => {
      const result = await guard(saveBookingDraftAction)(prev, formData);
      if (result.ok) {
        setBaseRowVersion((result.data as { rowVersion: number }).rowVersion);
        setSaved((current) => {
          const next = { ...current };
          for (const key of Object.keys(current) as FieldKey[]) {
            const v = formData.get(FIELD[key]);
            next[key] = typeof v === 'string' ? v : '';
          }
          return next;
        });
      }
      return result;
    },
    props.initialSaveState ?? null,
  );

  const dirty = (Object.keys(values) as FieldKey[]).some((k) => values[k] !== (saved[k] ?? ''));
  const conflict = saveState && !saveState.ok && saveState.code === 'version_changed';
  const issueFor = (key: FieldKey) =>
    issues.filter((code) => ISSUE_FIELD[code] === key).map((code) => ISSUE_TEXT[code]);

  const loadLatest = () => {
    // The page was revalidated after the conflict, so the props hold the latest saved details.
    const latest = valuesFrom(props.facts, props.sellingTotalPaise);
    setValues(latest);
    setSaved(latest);
    setBaseRowVersion(props.rowVersion);
  };

  // Fields the readiness check flagged, and fields actually rendered (no booking total for viewers who may not see it).
  const issueFields = issues.map((code) => ISSUE_FIELD[code]).filter((k): k is FieldKey => !!k && k !== 'proof');
  const rendered = (Object.keys(values) as FieldKey[]).filter((k) => k !== 'sellingTotalRupees' || showSelling);
  const statusOf = (key: SectionKey) => sectionStatus(key, values, rendered, issueFields);

  // Progressive disclosure: sections that still need something start open; finished ones start
  // closed with a one-line recap. Only the first render decides; the person controls it after that.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(() => {
    const initial = valuesFrom(props.facts, props.sellingTotalPaise);
    const first = (key: SectionKey) => {
      const st = sectionStatus(key, initial, rendered, issueFields);
      if (st.kind === 'optional') return SECTION_FIELDS[key].some((f) => initial[f].trim() !== '');
      return st.kind !== 'done';
    };
    return { stay: first('stay'), rooms: first('rooms'), money: first('money'), notes: first('notes') };
  });

  // A repair-list link (or a #booking-… address) opens the section that holds the field, then focuses it.
  useEffect(() => {
    const reveal = (id: string) => {
      const target = document.getElementById(id);
      const holder = target?.closest('details.form-section');
      if (holder instanceof HTMLDetailsElement && !holder.open) holder.open = true;
      return target;
    };
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href^="#booking-"]');
      if (!link) return;
      const target = reveal(link.getAttribute('href')!.slice(1));
      if (target && target.matches('input, select, textarea')) {
        window.setTimeout(() => (target as HTMLElement).focus(), 0);
      }
    };
    if (window.location.hash.startsWith('#booking-')) reveal(window.location.hash.slice(1));
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const field = (
    key: FieldKey,
    label: string,
    opts: {
      type?: 'text' | 'date' | 'number';
      maxLength?: number;
      min?: number;
      max?: number;
      hint?: string;
      textarea?: boolean;
      prefix?: string;
      inputMode?: 'decimal' | 'numeric' | 'text';
      autoCapitalize?: 'words' | 'sentences' | 'off';
      wide?: boolean;
    } = {},
  ) => {
    const id = FIELD_ID[key];
    const problems = issueFor(key);
    const hintId = opts.hint ? `${id}-hint` : undefined;
    const issueId = problems.length > 0 ? `${id}-issue` : undefined;
    const describedBy = [issueId, hintId].filter(Boolean).join(' ') || undefined;
    const common = {
      id,
      name: FIELD[key],
      value: values[key],
      'aria-invalid': problems.length > 0 ? true : undefined,
      'aria-describedby': describedBy,
      autoCapitalize: opts.autoCapitalize,
    } as const;
    const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }));
    const input = opts.textarea ? (
      <textarea {...common} maxLength={opts.maxLength} onChange={onChange} />
    ) : (
      <input
        {...common}
        type={opts.type ?? 'text'}
        maxLength={opts.maxLength}
        min={opts.min}
        max={opts.max}
        inputMode={opts.inputMode}
        enterKeyHint="next"
        autoComplete="off"
        onChange={onChange}
      />
    );
    return (
      <div className={`field${opts.wide ? ' field-wide' : ''}`}>
        <label htmlFor={id}>{label}</label>
        {issueId ? (
          <span id={issueId} className="field-issue">
            {problems.join(' ')}
          </span>
        ) : null}
        {opts.hint ? (
          <span id={hintId} className="hint">
            {opts.hint}
          </span>
        ) : null}
        {opts.prefix ? (
          <span className="input-prefix">
            <span aria-hidden="true">{opts.prefix}</span>
            {input}
          </span>
        ) : (
          input
        )}
      </div>
    );
  };

  const section = (key: SectionKey, title: string, recap: string, body: React.ReactNode) => {
    const st = statusOf(key);
    return (
      <details
        className={`form-section is-${st.kind}`}
        open={open[key]}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          setOpen((o) => (o[key] === isOpen ? o : { ...o, [key]: isOpen }));
        }}
      >
        <summary>
          <span className="form-section-title">{title}</span>
          <span className="form-section-status">
            <span aria-hidden="true">{SECTION_GLYPH[st.kind]} </span>
            {sectionStatusText(st)}
          </span>
          {recap ? <span className="form-section-recap">{recap}</span> : null}
        </summary>
        <fieldset className="group">
          <legend className="visually-hidden">{title}</legend>
          <div className="form-grid">{body}</div>
        </fieldset>
      </details>
    );
  };

  const L = BOOKING_FACT_LIMITS;
  const v = values;
  const stayRecap = [[v.hotelName, v.city].filter(Boolean).join(', '), v.checkIn && v.checkOut ? `${shortDate(v.checkIn)} → ${shortDate(v.checkOut)}` : '']
    .filter(Boolean)
    .join(' · ');
  const roomsRecap = [
    v.rooms ? `${v.rooms} ${v.rooms === '1' ? 'room' : 'rooms'}` : '',
    v.adults ? `${v.adults} ${v.adults === '1' ? 'adult' : 'adults'}` : '',
    v.children && v.children !== '0' ? `${v.children} ${v.children === '1' ? 'child' : 'children'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const moneyRecap = [
    v.purchaseBudgetRupees ? `Budget ₹${v.purchaseBudgetRupees}` : '',
    showSelling && v.sellingTotalRupees ? `Booking total ₹${v.sellingTotalRupees}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const notesCount = [v.inclusions, v.specialRequests].filter((x) => x.trim() !== '').length;
  const notesRecap = notesCount === 0 ? 'No notes' : `${notesCount} ${notesCount === 1 ? 'note' : 'notes'}`;

  return (
    <>
      <form action={saveAction} noValidate aria-labelledby="booking-details-heading" className="booking-form">
        <h3 id="booking-details-heading">Hotel details</h3>
        <p className="hint">Sections marked “Done” are folded. Open any section to change it.</p>
        <BookingResultMessage result={saveState}>
          {conflict ? (
            <p className="mt-1 mb-0">
              Your typed details are still in the form below.{' '}
              <button type="button" className="button secondary small" onClick={loadLatest}>
                Load the latest details
              </button>
            </p>
          ) : null}
        </BookingResultMessage>
        <input type="hidden" name={FIELD.dealId} value={dealId} />
        <input type="hidden" name={FIELD.versionId} value={versionId} />
        <input type="hidden" name={FIELD.rowVersion} value={baseRowVersion} />
        {section(
          'stay',
          'Stay',
          stayRecap,
          <>
            {field('hotelName', 'Hotel name', { maxLength: L.hotelName, autoCapitalize: 'words' })}
            {field('city', 'City', { maxLength: L.city, autoCapitalize: 'words' })}
            {field('checkIn', 'Check-in date', { type: 'date' })}
            {field('checkOut', 'Check-out date', { type: 'date' })}
          </>,
        )}
        {section(
          'rooms',
          'Rooms and travellers',
          roomsRecap,
          <>
            {field('rooms', 'Rooms', { type: 'number', min: L.rooms.min, max: L.rooms.max, inputMode: 'numeric' })}
            {field('adults', 'Adults', { type: 'number', min: L.adults.min, max: L.adults.max, inputMode: 'numeric' })}
            {field('children', 'Children (optional)', {
              type: 'number',
              min: L.children.min,
              max: L.children.max,
              inputMode: 'numeric',
            })}
            {field('roomType', 'Room type (optional)', { maxLength: L.roomType, autoCapitalize: 'sentences' })}
            {field('mealPlan', 'Meal plan (optional)', {
              maxLength: L.mealPlan,
              hint: 'For example breakfast only.',
              autoCapitalize: 'sentences',
            })}
          </>,
        )}
        {section(
          'money',
          'Money for this booking',
          moneyRecap,
          <>
            {field('purchaseBudgetRupees', PURCHASE_BUDGET_LABEL, {
              prefix: '₹',
              inputMode: 'decimal',
              hint: PURCHASE_BUDGET_HINT,
            })}
            {showSelling ? (
              field('sellingTotalRupees', BOOKING_TOTAL_LABEL, {
                prefix: '₹',
                inputMode: 'decimal',
                hint: BOOKING_TOTAL_HINT,
              })
            ) : (
              <div className="field">
                <span className="field-label">{BOOKING_TOTAL_LABEL}</span>
                <HiddenForRole hint="The deal owner or a Sales Manager adds and sees it." />
              </div>
            )}
          </>,
        )}
        {section(
          'notes',
          'Notes for Purchase (optional)',
          notesRecap,
          <>
            {field('inclusions', 'Inclusions (optional)', { textarea: true, maxLength: L.inclusions, autoCapitalize: 'sentences', wide: true })}
            {field('specialRequests', 'Special requests (optional)', {
              textarea: true,
              maxLength: L.specialRequests,
              autoCapitalize: 'sentences',
              wide: true,
            })}
          </>,
        )}
        <div className="button-row sticky-actions">
          <SubmitButton pendingLabel="Saving…" variant={props.confirmAvailable ? 'secondary' : undefined}>
            Save booking details
          </SubmitButton>
          <span className="hint" role="status">
            {dirty ? 'You have unsaved changes.' : 'Saving keeps this as a draft. Nothing is confirmed.'}
          </span>
        </div>
      </form>
      {props.confirmAvailable && dirty ? (
        <p className="note warn mt-1" role="status">
          You have unsaved changes. Save them before confirming — confirming uses the last saved details.
        </p>
      ) : null}
    </>
  );
}

const SECTION_GLYPH: Record<SectionStatus['kind'], string> = { done: '✓', missing: '!', attention: '!', optional: '○' };

/** Short date for section recaps, e.g. "14 Nov". */
function shortDate(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? iso : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(t);
}


export function ConfirmBookingForm({
  dealId,
  versionId,
  versionNo,
  contentHash,
  initialState = null,
  defaultOpen,
}: {
  dealId: string;
  versionId: string;
  versionNo: number;
  contentHash: string;
  initialState?: UiResult | null;
  defaultOpen?: boolean;
}) {
  const [state, action] = useActionState(guard(confirmBookingAction), initialState ?? null);
  const result = state;
  const T = CONFIRM_DIALOG_TEXT;
  // A definite refusal must not leave the "just confirmed" mark behind (re-review).
  // An unknown outcome ('unexpected') keeps it: the confirm may have committed.
  useEffect(() => {
    if (!result || result.ok || result.code === 'unexpected') return;
    try {
      sessionStorage.removeItem(CONFIRM_FOCUS_FLAG);
    } catch {
      // Storage blocked: nothing was stored.
    }
  }, [result]);
  return (
    <>
      <ConfirmDialog
        triggerLabel="Review and confirm"
        title={T.title}
        cancelLabel={T.cancelLabel}
        defaultOpen={defaultOpen || (result !== null && !result.ok)}
        body={
          <ul>
            {T.body.map((line) => (
              <li key={line}>{line.replace('{versionNo}', String(versionNo))}</li>
            ))}
          </ul>
        }
        renderActions={(cancel) => (
          <form
            action={action}
            noValidate
            onSubmit={() => {
              try {
                sessionStorage.setItem(CONFIRM_FOCUS_FLAG, dealId);
              } catch {
                // Storage blocked: focus simply stays where the browser puts it.
              }
            }}
          >
            <BookingResultMessage result={result}>
              {result && !result.ok && result.code === 'version_changed' ? (
                <p className="mt-1 mb-0">
                  <a href={`/app/deals/${dealId}`}>Load the latest details</a>
                </p>
              ) : null}
            </BookingResultMessage>
            <input type="hidden" name={FIELD.dealId} value={dealId} />
            <input type="hidden" name={FIELD.versionId} value={versionId} />
            <input type="hidden" name={FIELD.contentHash} value={contentHash} />
            <div className="dialog-actions">
              {cancel}
              <SubmitButton pendingLabel="Confirming…">{T.confirmLabel}</SubmitButton>
            </div>
          </form>
        )}
      />
    </>
  );
}

const ACCEPT = EVIDENCE_MIME_TYPES.join(',');

export function UploadEvidenceForm({
  dealId,
  versionId,
  fileCount,
  initialState = null,
}: {
  dealId: string;
  versionId: string;
  fileCount: number;
  initialState?: UiResult | null;
}) {
  const [state, action] = useActionState(guard(uploadBookingEvidenceAction), initialState ?? null);
  const [kind, setKind] = useState<EvidenceKind>('acceptance_message');
  // Submitted by hand (no React reset, so the kind stays as chosen); the file input empties after a save.
  const savedKey = useSavedKey(state);
  if (fileCount >= EVIDENCE_MAX_FILES) {
    return (
      <p className="note info">
        You have uploaded the maximum of {EVIDENCE_MAX_FILES} files. Remove one to add another.
      </p>
    );
  }
  return (
    <HandForm action={action} noValidate aria-label="Upload proof">
      <BookingResultMessage result={state} />
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIELD.versionId} value={versionId} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="booking-proof-kind">What is this proof?</label>
          <select
            id="booking-proof-kind"
            name={FIELD.kind}
            value={kind}
            onChange={(e) => setKind(e.target.value as EvidenceKind)}
          >
            {(Object.keys(EVIDENCE_KIND_LABEL) as EvidenceKind[]).map((k) => (
              <option key={k} value={k}>
                {EVIDENCE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="booking-proof-file">File</label>
          <span id="booking-proof-file-hint" className="hint">
            PDF, JPG, PNG or WebP, up to {EVIDENCE_MAX_MB} MB. Up to {EVIDENCE_MAX_FILES} files.
          </span>
          <input
            key={savedKey}
            id="booking-proof-file"
            name={FIELD.file}
            type="file"
            accept={ACCEPT}
            aria-describedby="booking-proof-file-hint"
            required
          />
        </div>
      </div>
      <SubmitButton pendingLabel="Uploading…" variant="secondary">
        Upload proof
      </SubmitButton>
    </HandForm>
  );
}

export function RemoveEvidenceForm({ dealId, evidenceId, fileName }: { dealId: string; evidenceId: string; fileName: string }) {
  const [state, action] = useActionState(guard(removeBookingEvidenceAction), null);
  return (
    <form action={action} noValidate>
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIELD.evidenceId} value={evidenceId} />
      <SubmitButton pendingLabel="Removing…" variant="secondary">
        Remove<span className="visually-hidden"> {fileName}</span>
      </SubmitButton>
      {state && !state.ok ? <BookingResultMessage result={state} /> : null}
    </form>
  );
}

/**
 * Persistent polite status region for the booking panel. It is mounted in
 * every state, so when the refreshed panel becomes confirmed the success text
 * is announced; if this browser just submitted the confirm, focus moves to
 * the panel heading (the dialog that held focus is gone).
 */
export function BookingStatusAnnouncer({ dealId, confirmed }: { dealId: string; confirmed: boolean }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirmed) return;
    let submitted = false;
    try {
      submitted = sessionStorage.getItem(CONFIRM_FOCUS_FLAG) === dealId;
      if (submitted) sessionStorage.removeItem(CONFIRM_FOCUS_FLAG);
    } catch {
      submitted = false;
    }
    // Only right after this browser confirmed (re-review L-d): later visitors see the
    // panel status instead, because "the hotel is not booked yet" can become stale.
    // The region is mounted empty first, so writing into it is announced.
    if (submitted && region.current) {
      region.current.textContent = CONFIRM_SUCCESS_TEXT;
      region.current.className = 'message success';
      document.getElementById('booking-heading')?.focus();
    }
  }, [confirmed, dealId]);
  return <div ref={region} role="status" aria-live="polite" />;
}
