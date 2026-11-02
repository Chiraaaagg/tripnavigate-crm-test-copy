'use client';

import { CircleAlert, CircleCheck, Plus, Trash2 } from 'lucide-react';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  type BookingActionResult,
  ERROR_TEXT,
  INTAKE_CONFIRM_DIALOG_TEXT,
  ISSUE_TEXT,
  ON_HOLD_SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  SERVICE_TYPES,
  type ServiceItemView,
  type ServiceType,
  type Traveller,
  TRAVELLER_TYPES,
  type TravellerType,
  UNKNOWN_OUTCOME_TEXT,
} from '@/modules/fulfilment/contracts';
import { guard, type UiResult } from './booking-forms';
import { PURCHASE_BUDGET_HINT, PURCHASE_BUDGET_LABEL } from './booking-fields';
import {
  type FactFieldDef,
  FACT_FIELDS,
  FIELD,
  type FieldProblem,
  factProblems,
  factsToSegments,
  factsToValues,
  type FactValues,
  confirmDialogLines,
  MAX_FLIGHT_SEGMENTS,
  ON_HOLD_LABEL,
  ON_HOLD_OPTION_TEXT,
  paiseToRupees,
  problemsFromFields,
  SEGMENT_CODE_HINT,
  SEGMENT_LABELS,
  type SegmentValues,
  TRAVELLER_TYPE_LABEL,
  travellerProblems,
  travellerProblemsFromFields,
  type TravellerRow,
  travellersToRows,
} from './intake-fields';

/*
 * Intake screen forms (B1, Lagoon). Every form is controlled, so what the
 * person typed survives a refusal; the server's answer is shown in words and,
 * for "invalid input", the fields most likely refused are named and marked.
 * Actions are passed in by the route (the frozen server actions) or by the
 * preview gallery (stub actions), so the screen can be reviewed without a
 * database.
 */

/** A server action in the frozen shape `(prev, FormData) => BookingActionResult`. */
export type IntakeAction = (prev: never, formData: FormData) => Promise<BookingActionResult<unknown>>;

export interface IntakeActions {
  /** Opens the draft (package) version when the Deal has none yet (review E4). */
  openDraft: IntakeAction;
  addServiceItem: IntakeAction;
  saveServiceItem: IntakeAction;
  removeServiceItem: IntakeAction;
  saveTravellers: IntakeAction;
  confirmIntake: IntakeAction;
}

/** Preview-gallery-only overrides (initial action results, dialog open). */
export interface IntakePreview {
  openState?: UiResult;
  addState?: UiResult;
  travellersState?: UiResult;
  confirmState?: UiResult;
  confirmOpen?: boolean;
}

/** Error:/Done: announcement in the Lagoon look (text carries the meaning). */
export function ActionNotice({ result, children, className }: { result: UiResult | null; children?: React.ReactNode; className?: string }) {
  if (result && !result.ok) {
    return (
      <div
        role="alert"
        className={cn('flex gap-2.5 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-3 text-base text-copy', className)}
      >
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-danger" />
        <div className="min-w-0 flex-1">
          <p className="m-0">
            <strong className="text-ink">Error: </strong>
            {result.message || (result.code === 'unexpected' ? UNKNOWN_OUTCOME_TEXT : ERROR_TEXT[result.code])}
          </p>
          {result.issues && result.issues.length > 0 ? (
            <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
              {result.issues.map((code) => (
                <li key={code}>{ISSUE_TEXT[code]}</li>
              ))}
            </ul>
          ) : null}
          {children}
        </div>
      </div>
    );
  }
  if (result?.ok) {
    return (
      <div
        role="status"
        className={cn('flex gap-2.5 rounded-control border border-status-success-line bg-status-success-tint px-3.5 py-3 text-base text-copy', className)}
      >
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />
        <p className="m-0">
          <strong className="text-ink">Done: </strong>
          {result.message}
        </p>
      </div>
    );
  }
  return <div role="status" aria-live="polite" className={className} />;
}

/** "Check these fields" list after a refusal, linking to each field. */
function ProblemList({ problems, idFor }: { problems: FieldProblem[]; idFor: (key: string) => string }) {
  if (problems.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="m-0 font-medium text-ink">Check these fields:</p>
      <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
        {problems.map((p) => (
          <li key={p.key}>
            <a href={`#${idFor(p.key)}`} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
              {p.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for very old browsers: still unique enough for a replay key.
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

const ON_HOLD_TEXT = ERROR_TEXT.service_on_hold;

function FactInput({
  def,
  id,
  value,
  invalid,
  problemText,
  onChange,
}: {
  def: FactFieldDef;
  id: string;
  value: string;
  invalid: boolean;
  problemText?: string;
  onChange: (value: string) => void;
}) {
  const describedBy = fieldDescribedBy(id, { hint: def.hint, error: problemText });
  const common = {
    id,
    name: def.key,
    value,
    invalid,
    'aria-describedby': describedBy,
    autoCapitalize: def.autoCapitalize,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  } as const;
  return (
    <Field htmlFor={id} label={def.label} optional={!def.required} hint={def.hint} error={problemText} className={def.wide ? 'sm:col-span-2' : undefined}>
      {def.control === 'textarea' ? (
        <Textarea {...common} maxLength={def.max} rows={3} />
      ) : (
        <Input
          {...common}
          type={def.control === 'number' ? 'number' : def.control === 'date' ? 'date' : def.control === 'time' ? 'time' : 'text'}
          inputMode={def.control === 'number' ? 'numeric' : undefined}
          min={def.control === 'number' ? def.min : undefined}
          max={def.control === 'number' ? def.max : undefined}
          maxLength={def.control === 'text' ? def.max : undefined}
          autoComplete="off"
          enterKeyHint="next"
        />
      )}
    </Field>
  );
}

export interface ServiceItemFormProps {
  dealId: string;
  versionId: string;
  rowVersion: number;
  /** Existing item (edit) or absent (add). */
  item?: ServiceItemView;
  action: IntakeAction;
  initialState?: UiResult | null;
  /** Shown as the form's accessible name. */
  label: string;
}

/**
 * One service: type (add only), its facts and the approved Purchase budget.
 * Hidden fields carry the frozen identifiers; a fresh request id makes a
 * retried "add" safe to replay.
 */
export function ServiceItemForm({ dealId, versionId, rowVersion, item, action, initialState = null, label }: ServiceItemFormProps) {
  const uid = useId();
  const prefix = item ? `svc-${item.itemNo}` : 'svc-new';
  const idFor = (key: string) => `${prefix}-${key}`;
  const [type, setType] = useState<ServiceType | ''>(item?.serviceType ?? '');
  const [values, setValues] = useState<FactValues>(() => ({
    ...factsToValues(item?.facts ?? null, item?.serviceType ?? 'hotel'),
    purchaseBudgetRupees: paiseToRupees(item?.purchaseBudgetPaise),
  }));
  const [segments, setSegments] = useState<SegmentValues[]>(() => factsToSegments(item?.facts ?? null));
  const [requestId, setRequestId] = useState(() => newRequestId());
  const [state, formAction] = useActionState(
    async (prev: UiResult | null, formData: FormData) => {
      const result = await guard(action)(prev, formData);
      if (result.ok && !item) {
        // A new item is listed by the refreshed page; clear the form for the next one.
        setType('');
        setValues({ ...factsToValues(null, 'hotel'), purchaseBudgetRupees: '' });
        setSegments([{ from: '', to: '', date: '' }]);
        setRequestId(newRequestId());
      }
      return result;
    },
    initialState,
  );

  const changeType = (next: string) => {
    if (next === '' || (SERVICE_TYPES as readonly string[]).includes(next)) {
      const t = next as ServiceType | '';
      setType(t);
      setValues((v) => ({ ...factsToValues(null, t || 'hotel'), purchaseBudgetRupees: v.purchaseBudgetRupees ?? '' }));
      if (t === 'flight') setSegments([{ from: '', to: '', date: '' }]);
    } else {
      // Visa, passport, train: refused on the spot; nothing is sent.
      setType('');
      setOnHold(next);
    }
  };
  const [onHold, setOnHold] = useState<string | null>(null);

  const refused = !!state && !state.ok && state.code === 'invalid_input';
  // The action names the refused fields when it can; otherwise the client-side mirror points at the likely ones.
  const named = refused && state && !state.ok && state.fields && type ? problemsFromFields(type, state.fields) : [];
  const problems = named.length > 0 ? named : refused && type ? factProblems(type, values, type === 'flight' ? segments : []) : [];
  const problemFor = (key: string) => problems.find((p) => p.key === key)?.text;
  const invalidKeys = new Set(problems.map((p) => p.key));
  const typeMissing = !!refused && !type;

  const setValue = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const setSegment = (i: number, part: keyof SegmentValues, value: string) =>
    setSegments((s) => s.map((seg, j) => (j === i ? { ...seg, [part]: value } : seg)));

  const budgetId = idFor('purchaseBudgetRupees');
  const budgetProblem = problemFor('purchaseBudgetRupees');
  const typeId = idFor('serviceType');

  return (
    <form action={formAction} noValidate aria-label={label} className="flex flex-col gap-4" data-slot="service-item-form">
      <ActionNotice result={state}>
        {refused ? <ProblemList problems={typeMissing ? [{ key: 'serviceType', label: 'Service type', text: 'Choose the service type.' }, ...problems] : problems} idFor={idFor} /> : null}
        {state && !state.ok && state.code === 'version_changed' ? (
          <p className="m-0 mt-1.5">
            Your typed details are still in the form.{' '}
            <a href={`/app/deals/${dealId}/intake`} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
              Load the latest details
            </a>
          </p>
        ) : null}
      </ActionNotice>
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIELD.versionId} value={versionId} />
      <input type="hidden" name={FIELD.rowVersion} value={rowVersion} />
      {item ? <input type="hidden" name={FIELD.itemId} value={item.itemId} /> : <input type="hidden" name={FIELD.requestId} value={requestId} />}
      {item ? <input type="hidden" name={FIELD.serviceType} value={item.serviceType} /> : null}

      {!item ? (
        <Field htmlFor={typeId} label="What was sold?" hint="Train isn’t handled in the CRM yet (deferred): no CRM task is created for it." error={typeMissing ? 'Choose the service type.' : undefined}>
          <Select
            id={typeId}
            name={FIELD.serviceType}
            value={type}
            invalid={typeMissing}
            aria-describedby={fieldDescribedBy(typeId, { hint: true, error: typeMissing })}
            onChange={(e) => changeType(e.target.value)}
          >
            <option value="">Choose a service type</option>
            {SERVICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {SERVICE_TYPE_LABEL[t]}
              </option>
            ))}
            {ON_HOLD_SERVICE_TYPES.map((t) => (
              <option key={t} value={t} disabled>
                {ON_HOLD_LABEL[t]} · {ON_HOLD_OPTION_TEXT}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {onHold ? (
        <p role="status" className="m-0 text-sm text-status-warning">
          {ON_HOLD_TEXT}
        </p>
      ) : null}

      {type ? (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">{SERVICE_TYPE_LABEL[type]} details</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {type === 'flight' ? (
              <div className="sm:col-span-2">
                <SegmentsEditor
                  prefix={prefix}
                  segments={segments}
                  invalidKeys={invalidKeys}
                  problemFor={problemFor}
                  onChange={setSegment}
                  onAdd={() => setSegments((s) => (s.length >= MAX_FLIGHT_SEGMENTS ? s : [...s, { from: '', to: '', date: '' }]))}
                  onRemove={(i) => setSegments((s) => (s.length <= 1 ? s : s.filter((_, j) => j !== i)))}
                />
              </div>
            ) : null}
            {FACT_FIELDS[type].map((def) => (
              <FactInput
                key={def.key}
                def={def}
                id={idFor(def.key)}
                value={values[def.key] ?? ''}
                invalid={invalidKeys.has(def.key)}
                problemText={problemFor(def.key)}
                onChange={(v) => setValue(def.key, v)}
              />
            ))}
            <Field htmlFor={budgetId} label={PURCHASE_BUDGET_LABEL} optional hint={PURCHASE_BUDGET_HINT} error={budgetProblem}>
              <div className="flex items-stretch">
                <span aria-hidden="true" className="inline-flex items-center rounded-l-control border border-r-0 border-control bg-wash px-3 text-base text-quiet">
                  ₹
                </span>
                <Input
                  id={budgetId}
                  name={FIELD.purchaseBudgetRupees}
                  value={values.purchaseBudgetRupees ?? ''}
                  invalid={invalidKeys.has('purchaseBudgetRupees')}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-describedby={fieldDescribedBy(budgetId, { hint: true, error: budgetProblem })}
                  className="rounded-l-none"
                  onChange={(e) => setValue('purchaseBudgetRupees', e.target.value)}
                />
              </div>
            </Field>
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitStatusButton pendingLabel={item ? 'Saving…' : 'Adding…'} variant={item ? 'secondary' : 'primary'} disabled={!type}>
          {item ? 'Save this service' : 'Add this service'}
        </SubmitStatusButton>
        <span className="text-sm text-quiet" id={`${uid}-hint`}>
          Saving keeps the draft. Nothing is confirmed or booked.
        </span>
      </div>
    </form>
  );
}

function SegmentsEditor({
  prefix,
  segments,
  invalidKeys,
  problemFor,
  onChange,
  onAdd,
  onRemove,
}: {
  prefix: string;
  segments: SegmentValues[];
  invalidKeys: Set<string>;
  problemFor: (key: string) => string | undefined;
  onChange: (i: number, part: keyof SegmentValues, value: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}) {
  return (
    <fieldset className="m-0 min-w-0 rounded-control border border-line p-3">
      <legend className="px-1 text-base font-semibold text-ink">Flight segments</legend>
      <p className="m-0 mb-3 text-sm text-quiet">One row per flight, in travel order. Up to {MAX_FLIGHT_SEGMENTS}.</p>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {segments.map((seg, i) => {
          const key = (part: keyof SegmentValues) => `segment-${i}-${part}`;
          const id = (part: keyof SegmentValues) => `${prefix}-${key(part)}`;
          return (
            <li key={i} className="m-0 grid grid-cols-1 gap-3 rounded-control bg-canvas p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <span className="sr-only">Segment {i + 1}</span>
              {(['from', 'to', 'date'] as const).map((part) => {
                const problem = problemFor(key(part));
                const hint = part === 'date' ? undefined : SEGMENT_CODE_HINT;
                return (
                  <Field key={part} htmlFor={id(part)} label={`${SEGMENT_LABELS[part]} · segment ${i + 1}`} hint={hint} error={problem}>
                    <Input
                      id={id(part)}
                      name={part === 'from' ? FIELD.segmentFrom : part === 'to' ? FIELD.segmentTo : FIELD.segmentDate}
                      type={part === 'date' ? 'date' : 'text'}
                      value={seg[part]}
                      invalid={invalidKeys.has(key(part))}
                      maxLength={part === 'date' ? undefined : 3}
                      autoCapitalize={part === 'date' ? undefined : 'characters'}
                      autoComplete="off"
                      className={part === 'date' ? undefined : 'uppercase'}
                      aria-describedby={fieldDescribedBy(id(part), { hint, error: problem })}
                      onChange={(e) => onChange(i, part, part === 'date' ? e.target.value : e.target.value.toUpperCase())}
                    />
                  </Field>
                );
              })}
              <Button type="button" variant="ghost" size="md" onClick={() => onRemove(i)} disabled={segments.length <= 1} className="min-h-11">
                <Trash2 aria-hidden="true" />
                Remove<span className="sr-only"> segment {i + 1}</span>
              </Button>
            </li>
          );
        })}
      </ol>
      <Button type="button" variant="secondary" size="md" className="mt-3 min-h-11" onClick={onAdd} disabled={segments.length >= MAX_FLIGHT_SEGMENTS}>
        <Plus aria-hidden="true" />
        Add a segment
      </Button>
    </fieldset>
  );
}

/** Submit button that shows the pending label and blocks a second click. */
function SubmitStatusButton({
  children,
  pendingLabel,
  variant = 'primary',
  disabled = false,
  describedBy,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  describedBy?: string;
}) {
  // useFormStatus must sit inside the form; this component is always rendered inside one.
  return <PendingButton pendingLabel={pendingLabel} variant={variant} disabled={disabled} describedBy={describedBy}>{children}</PendingButton>;
}

function PendingButton({
  children,
  pendingLabel,
  variant,
  disabled,
  describedBy,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant: 'primary' | 'secondary' | 'danger';
  disabled: boolean;
  describedBy?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="lg" loading={pending} disabled={disabled} aria-describedby={describedBy} className="min-h-11">
      {pending ? pendingLabel : children}
    </Button>
  );
}

/** Primary action while the Deal has no draft yet: starts the package draft on the intake screen. */
export function StartIntakeDraftForm({ dealId, action, initialState = null }: { dealId: string; action: IntakeAction; initialState?: UiResult | null }) {
  const [state, submit] = useActionState(guard(action), initialState ?? null);
  return (
    <form action={submit} noValidate className="flex flex-col gap-3">
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <div>
        <SubmitStatusButton pendingLabel="Starting…">Start the intake draft</SubmitStatusButton>
      </div>
      <ActionNotice result={state} />
    </form>
  );
}

export function RemoveServiceForm({
  dealId,
  versionId,
  rowVersion,
  item,
  action,
}: {
  dealId: string;
  versionId: string;
  rowVersion: number;
  item: ServiceItemView;
  action: IntakeAction;
}) {
  const [state, formAction] = useActionState(guard(action), null);
  const helpId = `svc-${item.itemNo}-remove-help`;
  return (
    <form action={formAction} noValidate aria-label={`Remove service ${item.itemNo}`} className="flex flex-col gap-2">
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIELD.versionId} value={versionId} />
      <input type="hidden" name={FIELD.rowVersion} value={rowVersion} />
      <input type="hidden" name={FIELD.itemId} value={item.itemId} />
      <p id={helpId} className="m-0 text-sm text-quiet">
        Removes this planned service from the draft. Nothing else changes.
      </p>
      <SubmitStatusButton pendingLabel="Removing…" variant="secondary" describedBy={helpId}>
        <Trash2 aria-hidden="true" />
        Remove service {item.itemNo}
        <span className="sr-only"> ({item.title})</span>
      </SubmitStatusButton>
      {state && !state.ok ? <ActionNotice result={state} /> : null}
    </form>
  );
}

export function TravellersForm({
  dealId,
  rowVersion,
  travellers,
  needed,
  action,
  initialState = null,
}: {
  dealId: string;
  rowVersion: number;
  travellers: Traveller[];
  /** The largest head-count any service needs (0 when unknown). */
  needed: number;
  action: IntakeAction;
  initialState?: UiResult | null;
}) {
  const [rows, setRows] = useState<TravellerRow[]>(() => {
    const initial = travellersToRows(travellers);
    return initial.length > 0 ? initial : [{ fullName: '', type: 'adult' }];
  });
  const [state, formAction] = useActionState(guard(action), initialState);
  const refused = !!state && !state.ok && state.code === 'invalid_input';
  const named = refused && state && !state.ok && state.fields ? travellerProblemsFromFields(state.fields) : [];
  const problems = named.length > 0 ? named : refused ? travellerProblems(rows) : [];
  const idFor = (key: string) => `trav-${key}`;
  const problemFor = (i: number) => problems.find((p) => p.key === `traveller-${i}-name`)?.text;
  const filled = rows.filter((r) => r.fullName.trim() !== '').length;
  const update = (i: number, patch: Partial<TravellerRow>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <form action={formAction} noValidate aria-label="Travellers" className="flex flex-col gap-4" data-slot="travellers-form">
      <ActionNotice result={state}>{refused ? <ProblemList problems={problems} idFor={idFor} /> : null}</ActionNotice>
      <input type="hidden" name={FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIELD.rowVersion} value={rowVersion} />
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((row, i) => {
          const nameId = idFor(`traveller-${i}-name`);
          const typeId = idFor(`traveller-${i}-type`);
          const problem = problemFor(i);
          return (
            <li key={i} className="m-0 grid grid-cols-1 gap-3 rounded-control bg-canvas p-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
              <Field htmlFor={nameId} label={`Full name · traveller ${i + 1}`} error={problem}>
                <Input
                  id={nameId}
                  name={FIELD.travellerName}
                  value={row.fullName}
                  invalid={!!problem}
                  maxLength={120}
                  autoCapitalize="words"
                  autoComplete="off"
                  aria-describedby={fieldDescribedBy(nameId, { error: problem })}
                  onChange={(e) => update(i, { fullName: e.target.value })}
                />
              </Field>
              <Field htmlFor={typeId} label={`Type · traveller ${i + 1}`}>
                <Select id={typeId} name={FIELD.travellerType} value={row.type} onChange={(e) => update(i, { type: e.target.value as TravellerType })}>
                  {TRAVELLER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TRAVELLER_TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setRows((r) => (r.length <= 1 ? [{ fullName: '', type: 'adult' }] : r.filter((_, j) => j !== i)))}>
                <Trash2 aria-hidden="true" />
                Remove<span className="sr-only"> traveller {i + 1}</span>
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" className="min-h-11" onClick={() => setRows((r) => [...r, { fullName: '', type: 'adult' }])}>
          <Plus aria-hidden="true" />
          Add a traveller
        </Button>
        <SubmitStatusButton pendingLabel="Saving…" variant="secondary">
          Save travellers
        </SubmitStatusButton>
        <span className="text-sm text-quiet" role="status">
          {needed > 0 ? `${filled} of ${needed} the services need.` : `${filled} ${filled === 1 ? 'traveller' : 'travellers'} listed.`}
        </span>
      </div>
    </form>
  );
}

/** Session flag set when a confirm is submitted, so focus can move to the heading after the refresh. */
export const INTAKE_CONFIRM_FOCUS_FLAG = 'tn-intake-confirm-submitted';

export function IntakeConfirmForm({
  dealId,
  versionId,
  versionNo,
  contentHash,
  taskCount,
  action,
  initialState = null,
  defaultOpen,
}: {
  dealId: string;
  versionId: string;
  versionNo: number;
  contentHash: string;
  taskCount: number;
  action: IntakeAction;
  initialState?: UiResult | null;
  defaultOpen?: boolean;
}) {
  const [state, formAction] = useActionState(guard(action), initialState);
  const result = state;
  const T = INTAKE_CONFIRM_DIALOG_TEXT;
  useEffect(() => {
    if (!result || result.ok || result.code === 'unexpected') return;
    try {
      sessionStorage.removeItem(INTAKE_CONFIRM_FOCUS_FLAG);
    } catch {
      // Storage blocked: nothing was stored.
    }
  }, [result]);
  return (
    <ConfirmDialog
      triggerLabel="Review and save the accepted version"
      title={T.title}
      cancelLabel={T.cancelLabel}
      defaultOpen={defaultOpen || (result !== null && !result.ok)}
      body={
        <ul>
          {confirmDialogLines(versionNo, taskCount).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      }
      renderActions={(cancel) => (
        <form
          action={formAction}
          noValidate
          onSubmit={() => {
            try {
              sessionStorage.setItem(INTAKE_CONFIRM_FOCUS_FLAG, dealId);
            } catch {
              // Storage blocked: focus simply stays where the browser puts it.
            }
          }}
        >
          <ActionNotice result={result}>
            {result && !result.ok && result.code === 'version_changed' ? (
              <p className="m-0 mt-1.5">
                <a href={`/app/deals/${dealId}/intake`} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                  Load the latest details
                </a>
              </p>
            ) : null}
          </ActionNotice>
          <input type="hidden" name={FIELD.dealId} value={dealId} />
          <input type="hidden" name={FIELD.versionId} value={versionId} />
          <input type="hidden" name={FIELD.contentHash} value={contentHash} />
          <div className="dialog-actions">
            {cancel}
            <PendingButton pendingLabel="Saving…" variant="primary" disabled={false}>
              {T.confirmLabel}
            </PendingButton>
          </div>
        </form>
      )}
    />
  );
}

/**
 * Announces the saved version once, right after this browser confirmed, and
 * moves focus to the heading. The region is mounted empty first, so writing
 * into it is announced (same pattern as the booking panel's announcer).
 */
export function IntakeStatusAnnouncer({ dealId, created, text }: { dealId: string; created: boolean; text: string }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!created) return;
    let submitted = false;
    try {
      submitted = sessionStorage.getItem(INTAKE_CONFIRM_FOCUS_FLAG) === dealId;
      if (submitted) sessionStorage.removeItem(INTAKE_CONFIRM_FOCUS_FLAG);
    } catch {
      submitted = false;
    }
    if (submitted && region.current) {
      region.current.textContent = text;
      region.current.className = 'rounded-control border border-status-success-line bg-status-success-tint px-3.5 py-3 text-base text-copy';
      document.getElementById('intake-heading')?.focus();
    }
  }, [created, dealId, text]);
  return <div ref={region} role="status" aria-live="polite" />;
}
