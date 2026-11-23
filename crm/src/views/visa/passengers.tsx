'use client';

import { CalendarDays, Check, ChevronDown, CircleCheck, CircleX, PencilLine, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formOf, VF, type VisaWorkActions } from './actions';
import { applicantChips, Chips } from './bits';
import { normalisePassport, PASSPORT_PATTERN, whenText } from './format';
import { focusLater, refusedFields, ResultNotice, useCommand, type VisaResult } from './kit';
import { KIND_LABEL, nameOf, notReadyLine, PAX_LABEL, plural } from './labels';
import type { VisaApplicant, VisaDocument, VisaWorkspace } from './types';
import { appTarget, isPassportTask, salesJurisdictionBlank, salesKindBlank, type Popup } from './work-model';

/*
 * Passengers and documents (contract 11.1, HTML passengerTable H:14676,
 * passengerRead H:14643, passengerEdit H:14656). One row per current
 * application, removed ones last. O14 (owner, 16 November 2026): each row
 * has one control with a visible label. "Edit" alone when editing is the only
 * action; otherwise one menu ("Edit", or "Actions" when the row cannot be
 * edited) with Edit details, Add other visa cost and Withdrawn by customer,
 * instead of a pencil plus a three-dot menu. Edit details turns the row into small fields
 * in place (one row at a time): passport number (assignee only), appointment
 * date and time, tick boxes that move documents between the two columns,
 * Upload / Add links, remark, and the visa kind / jurisdiction when Sales
 * left them blank. Save ✓ sends visa_application_set_row once; a refusal
 * keeps every typed value. The wide table scrolls inside its own labelled
 * region on narrow screens.
 */

export interface WorkCtx {
  ws: VisaWorkspace;
  actions: VisaWorkActions;
  /** The assignee may work (task in progress and theirs). */
  working: boolean;
  /** Fee receipts, Send / Fix fee and other costs (also on a completed task for its last assignee: canManageFees). */
  managingFees: boolean;
  open: (p: Popup, returnFocusId?: string) => void;
  /** A popup's command succeeded: close it, show the result line, move focus there. */
  done: (r: VisaResult) => void;
}

interface Draft {
  passport: string;
  date: string;
  time: string;
  remark: string;
  /**
   * Only the ticks the person changed in this edit (document id → received). Everything else is read
   * from the live list, so a document added or received elsewhere meanwhile (Add document, Upload) is
   * never posted back in its old state.
   */
  docs: Record<string, boolean>;
  kind: string;
  jurisdiction: string;
  place: string;
}

function draftOf(a: VisaApplicant): Draft {
  return {
    passport: a.passport?.number ?? '',
    date: a.appointment.date ?? '',
    time: a.appointment.time ?? '',
    remark: a.remark ?? '',
    docs: {},
    kind: a.visaKind.source === 'desk' ? (a.visaKind.value ?? '') : '',
    jurisdiction: a.jurisdiction.source === 'desk' && a.jurisdiction.required !== null ? (a.jurisdiction.required ? 'yes' : 'no') : '',
    place: a.jurisdiction.source === 'desk' ? (a.jurisdiction.place ?? '') : '',
  };
}

const pencilId = (a: VisaApplicant) => `pax-edit-${a.applicationId}`;

function DocList({ docs, icon: Icon, tone, empty }: { docs: VisaDocument[]; icon: typeof CircleCheck; tone: string; empty: string }) {
  if (docs.length === 0) return <span className="text-quiet">{empty}</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {docs.map((d) => (
        <li key={d.documentId} className="m-0 flex items-start gap-1.5">
          <Icon aria-hidden="true" className={cn('mt-0.75 size-4 shrink-0', tone)} />
          <span className="wrap-anywhere">
            {d.label}
            {d.files.length ? <span className="text-quiet"> · {plural(d.files.length, 'file')}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PassportLine({ a, working }: { a: VisaApplicant; working: boolean }) {
  if (a.passport) {
    return <span className="font-mono text-[0.8125rem] tracking-wide text-copy">{a.passport.number ? `Passport ${a.passport.number}` : 'Passport no. not recorded'}</span>;
  }
  return <span className="text-[0.8125rem] text-quiet">{working ? 'Passport no. not recorded' : 'Passport shown to the assigned executive'}</span>;
}

function TravellerChanged({ ctx, a }: { ctx: WorkCtx; a: VisaApplicant }) {
  const cmd = useCommand(ctx.actions.confirmTraveller);
  if (!a.travellerChanged) return null;
  return (
    <div className="mt-[0.25rem] flex flex-col gap-1.5">
      <Notice tone="warning" role="none" className="px-2.5 py-2 text-sm">
        <p>
          The booking changed this traveller: {a.travellerChanged.was ?? 'no name'} → {a.travellerChanged.now ?? 'no name'}. Check the documents before applying.
        </p>
      </Notice>
      {a.can.confirmTraveller ? (
        <div>
          <Button
            size="sm"
            loading={cmd.pending}
            onClick={() => cmd.send((rid) => formOf(appTarget(ctx.ws, a), rid))}
          >
            OK, checked<span className="sr-only"> for {nameOf(a)}</span>
          </Button>
        </div>
      ) : null}
      <ResultNotice state={cmd.state} okTitle="Checked" />
    </div>
  );
}

function ReadRow({ ctx, a, onEdit, editingOther }: { ctx: WorkCtx; a: VisaApplicant; onEdit: () => void; editingOther: boolean }) {
  const got = a.documents.filter((d) => d.status === 'received');
  const missing = a.documents.filter((d) => d.status !== 'received');
  const why = !a.removed && a.state === 'docs_pending' && !a.ready ? notReadyLine(a.notReady) : null;
  const canWithdraw = a.can.withdraw && a.state === 'docs_pending';
  const canOther = ctx.managingFees;
  // O14: a menu as soon as the row has another action besides editing; editing alone is one plain Edit button.
  const canMore = canWithdraw || canOther;
  const editChosen = useRef(false);
  return (
    <TableRow className={cn('align-top', a.removed && 'bg-wash')}>
      <TableCell className="align-top">
        <span className="flex min-w-0 flex-col items-start gap-0.75">
          <span className="font-semibold wrap-anywhere text-ink">{nameOf(a)}</span>
          <PassportLine a={a} working={ctx.working} />
          <span className="text-sm text-quiet">
            {a.type ? PAX_LABEL[a.type] : 'Type not set'}
            {a.ageYears !== null ? ` · ${a.ageYears} years` : ''}
          </span>
          <Chips chips={applicantChips(a)} label={`Status of ${nameOf(a)}`} />
          {why ? <span className="text-sm text-quiet">{why}</span> : null}
          <TravellerChanged ctx={ctx} a={a} />
        </span>
      </TableCell>
      <TableCell className="align-top">
        <span className="flex items-start gap-1.5">
          <CalendarDays aria-hidden="true" className="mt-0.75 size-4 shrink-0 text-faint" />
          <span>{isPassportTask(ctx.ws) || a.visaKind.value !== 'e_visa' ? whenText(a.appointment.date, a.appointment.time) : a.appointment.date ? whenText(a.appointment.date, a.appointment.time) : 'Not needed (E-visa)'}</span>
        </span>
      </TableCell>
      <TableCell className="align-top text-sm">
        <DocList docs={got} icon={CircleCheck} tone="text-status-success" empty={a.documents.length ? 'None yet' : 'No document list set'} />
      </TableCell>
      <TableCell className="align-top text-sm">
        <DocList docs={missing} icon={CircleX} tone="text-status-warning" empty={a.documents.length ? 'None' : a.can.edit ? 'Use Edit to add documents' : 'None'} />
      </TableCell>
      <TableCell className="align-top text-sm">{a.remark ? <span className="wrap-anywhere">{a.remark}</span> : '—'}</TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-center gap-1.5">
          {canMore ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button id={pencilId(a)} variant="secondary" className="min-h-11 gap-1.5 px-3 sm:min-h-0" aria-describedby={a.can.edit && editingOther ? `pax-one-${ctx.ws.taskId}` : undefined}>
                  {a.can.edit ? 'Edit' : 'Actions'}
                  <span className="sr-only"> {nameOf(a)}</span>
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                onCloseAutoFocus={(e) => {
                  // Edit details moves focus into the row's first field; the menu must not pull it back to its button.
                  if (editChosen.current) {
                    e.preventDefault();
                    editChosen.current = false;
                  }
                }}
              >
                {a.can.edit ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      editChosen.current = true;
                      onEdit();
                    }}
                  >
                    <PencilLine aria-hidden="true" />
                    Edit details
                  </DropdownMenuItem>
                ) : null}
                {canOther ? <DropdownMenuItem onSelect={() => ctx.open({ kind: 'otherCost', id: a.applicationId }, pencilId(a))}>Add other visa cost</DropdownMenuItem> : null}
                {canWithdraw ? <DropdownMenuItem onSelect={() => ctx.open({ kind: 'withdraw', id: a.applicationId }, pencilId(a))}>Withdrawn by customer</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : a.can.edit ? (
            <Button id={pencilId(a)} variant="secondary" className="min-h-11 gap-1.5 px-3 sm:min-h-0" aria-describedby={editingOther ? `pax-one-${ctx.ws.taskId}` : undefined} onClick={onEdit}>
              <PencilLine aria-hidden="true" />
              Edit
              <span className="sr-only"> {nameOf(a)}</span>
            </Button>
          ) : (
            <span aria-hidden="true">—</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function EditRow({ ctx, a, draft, setDraft, onClose }: { ctx: WorkCtx; a: VisaApplicant; draft: Draft; setDraft: (d: Draft) => void; onClose: (saved: VisaResult | null) => void }) {
  const cmd = useCommand(ctx.actions.saveRow);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const who = nameOf(a);
  const id = (n: string) => `row-${a.applicationId}-${n}`;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const server = refusedFields(cmd.state);
  const err = (key: string, text: string) => problems[key] ?? (server.has(key) ? text : null);
  const kindEditable = !isPassportTask(ctx.ws) && salesKindBlank(ctx.ws);
  const effectiveKind = kindEditable ? draft.kind || null : a.visaKind.value;
  const jurEditable = !isPassportTask(ctx.ws) && salesJurisdictionBlank(ctx.ws) && effectiveKind === 'sticker';
  const isTicked = (d: VisaDocument) => draft.docs[d.documentId] ?? d.status === 'received';
  const got = a.documents.filter(isTicked);
  const missing = a.documents.filter((d) => !isTicked(d));

  const save = () => {
    const p: Record<string, string> = {};
    const passport = normalisePassport(draft.passport);
    if (a.passport && passport && !PASSPORT_PATTERN.test(passport)) p.passportNumber = 'Use 6 to 15 letters and digits.';
    if (draft.time && !draft.date) p.appointmentTime = 'Set the date first, or clear the time.';
    if (draft.remark.trim().length > 300) p.remark = 'Use at most 300 characters.';
    if (jurEditable && draft.jurisdiction === 'yes' && !draft.place.trim()) p.jurisdictionPlace = 'Add the jurisdiction place.';
    setProblems(p);
    if (Object.keys(p).length) {
      focusLater(id(Object.keys(p)[0] === 'appointmentTime' ? 'time' : Object.keys(p)[0] === 'passportNumber' ? 'passport' : Object.keys(p)[0] === 'remark' ? 'remark' : 'place'));
      return;
    }
    const fields: Record<string, string | readonly string[]> = {};
    const before = draftOf(a);
    if (draft.date !== before.date) fields[VF.appointmentDate] = draft.date;
    if (draft.time !== before.time || (draft.date !== before.date && draft.time)) fields[VF.appointmentTime] = draft.time;
    if (draft.remark.trim() !== (a.remark ?? '')) fields[VF.remark] = draft.remark.trim();
    if (a.passport && passport !== (a.passport.number ?? '')) fields[VF.passportNumber] = passport;
    // Post only the documents whose tick differs from the live list (the server leaves unlisted ones as they are).
    const changed = a.documents.filter((d) => d.documentId in draft.docs && draft.docs[d.documentId] !== (d.status === 'received'));
    if (changed.length) {
      fields[VF.documentIds] = changed.map((d) => d.documentId);
      fields[VF.receivedDocumentIds] = changed.filter((d) => draft.docs[d.documentId]).map((d) => d.documentId);
    }
    if (kindEditable && draft.kind !== before.kind) fields[VF.visaKind] = draft.kind;
    if (jurEditable && (draft.jurisdiction !== before.jurisdiction || draft.place !== before.place)) {
      fields[VF.jurisdiction] = draft.jurisdiction;
      fields[VF.jurisdictionPlace] = draft.jurisdiction === 'yes' ? draft.place.trim() : '';
    }
    if (Object.keys(fields).length === 0) {
      onClose(null);
      return;
    }
    cmd.send(
      (rid) => formOf({ ...appTarget(ctx.ws, a), ...fields }, rid),
      (r: VisaResult) => {
        if (r.ok) onClose(r);
      },
    );
  };

  const tick = (d: VisaDocument) => (
    <li key={d.documentId} className="m-0 flex items-start justify-between gap-2">
      <label className="flex cursor-pointer items-start gap-1.5" htmlFor={id(`doc-${d.documentId}`)}>
        <input
          id={id(`doc-${d.documentId}`)}
          type="checkbox"
          className={cn('m-0 mt-0.75 size-4 shrink-0 accent-brand-strong', focusRing)}
          checked={isTicked(d)}
          onChange={(e) => set({ docs: { ...draft.docs, [d.documentId]: e.currentTarget.checked } })}
        />
        <span className="wrap-anywhere">
          {d.label}
          <span className="sr-only">{isTicked(d) ? ', received' : ', not received'}</span>
        </span>
      </label>
      {d.status !== 'received' && !isTicked(d) ? (
        <button
          type="button"
          id={id(`rm-${d.documentId}`)}
          className={cn('grid size-7 shrink-0 cursor-pointer place-items-center rounded-control border-0 bg-transparent text-quiet hover:bg-wash hover:text-status-danger', focusRing)}
          aria-label={`Remove ${d.label} from ${who}’s list`}
          onClick={() => ctx.open({ kind: 'removeDoc', id: a.applicationId, documentId: d.documentId }, id(`rm-${d.documentId}`))}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
  const small = 'h-8 min-h-0 px-2 py-0.5 text-sm';
  return (
    <>
    {cmd.state && !cmd.state.ok ? (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={6} className="pb-0">
          <ResultNotice state={cmd.state} failTitle={`${who} not saved`} />
        </TableCell>
      </TableRow>
    ) : null}
    <TableRow className="bg-brand-tint/40 align-top hover:bg-brand-tint/40">
      <TableCell className="align-top">
        <span className="flex min-w-0 flex-col items-start gap-1">
          <span className="font-semibold wrap-anywhere text-ink">{who}</span>
          {a.passport ? (
            <>
              <Input
                id={id('passport')}
                className={cn(small, 'font-mono')}
                value={draft.passport}
                maxLength={20}
                autoComplete="off"
                placeholder="Passport number"
                aria-label={`Passport number for ${who}`}
                invalid={!!err('passportNumber', 'Check the passport number.')}
                aria-describedby={err('passportNumber', '') !== null ? id('passport-error') : undefined}
                onChange={(e) => set({ passport: e.currentTarget.value })}
              />
              {err('passportNumber', 'Check the passport number.') ? <FieldError id={id('passport-error')}>{err('passportNumber', 'Check the passport number.')}</FieldError> : null}
            </>
          ) : (
            <PassportLine a={a} working={ctx.working} />
          )}
          <span className="text-sm text-quiet">{a.type ? PAX_LABEL[a.type] : 'Type not set'}</span>
          {kindEditable ? (
            <span className="flex w-full flex-col gap-1">
              <label htmlFor={id('kind')} className="text-sm font-semibold text-ink">
                Visa type
              </label>
              <Select id={id('kind')} className={small} value={draft.kind} aria-describedby={id('kind-hint')} invalid={!!err(VF.visaKind, 'Choose the visa type.')} onChange={(e) => set({ kind: e.currentTarget.value })}>
                <option value="">Not decided yet</option>
                <option value="e_visa">{KIND_LABEL.e_visa}</option>
                <option value="sticker">{KIND_LABEL.sticker}</option>
              </Select>
              <span id={id('kind-hint')} className="text-xs text-quiet">
                Sales did not set this on the booking.
              </span>
            </span>
          ) : null}
          {jurEditable ? (
            <span className="flex w-full flex-col gap-1">
              <label htmlFor={id('jur')} className="text-sm font-semibold text-ink">
                Jurisdiction passport?
              </label>
              <Select id={id('jur')} className={small} value={draft.jurisdiction} invalid={!!err(VF.jurisdiction, 'Choose an answer.')} onChange={(e) => set({ jurisdiction: e.currentTarget.value })}>
                <option value="">Not decided yet</option>
                <option value="no">No, it can be sent from here</option>
                <option value="yes">Yes, it must go to a set place</option>
              </Select>
              {draft.jurisdiction === 'yes' ? (
                <>
                  <label htmlFor={id('place')} className="text-sm font-semibold text-ink">
                    Where the passport must be sent
                  </label>
                  <Input
                    id={id('place')}
                    className={small}
                    value={draft.place}
                    maxLength={120}
                    invalid={!!err(VF.jurisdictionPlace, 'Add the jurisdiction place.')}
                    aria-describedby={err(VF.jurisdictionPlace, 'Add the jurisdiction place.') ? id('place-error') : undefined}
                    onChange={(e) => set({ place: e.currentTarget.value })}
                  />
                  {err(VF.jurisdictionPlace, 'Add the jurisdiction place.') ? <FieldError id={id('place-error')}>{err(VF.jurisdictionPlace, 'Add the jurisdiction place.')}</FieldError> : null}
                </>
              ) : null}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="align-top">
        <span className="flex flex-col gap-1.5">
          <Input
            id={id('date')}
            type="date"
            className={small}
            value={draft.date}
            aria-label={`Appointment date for ${who}`}
            invalid={server.has(VF.appointmentDate)}
            aria-describedby={server.has(VF.appointmentDate) ? id('date-error') : undefined}
            onChange={(e) => set({ date: e.currentTarget.value })}
          />
          {server.has(VF.appointmentDate) ? <FieldError id={id('date-error')}>Check the appointment date.</FieldError> : null}
          <Input
            id={id('time')}
            type="time"
            className={small}
            value={draft.time}
            aria-label={`Appointment time for ${who} (optional)`}
            invalid={!!err('appointmentTime', 'Set the date first, or clear the time.')}
            aria-describedby={err('appointmentTime', '') !== null ? id('time-error') : undefined}
            onChange={(e) => set({ time: e.currentTarget.value })}
          />
          {err('appointmentTime', 'Set the date first, or clear the time.') ? <FieldError id={id('time-error')}>{err('appointmentTime', 'Set the date first, or clear the time.')}</FieldError> : null}
        </span>
      </TableCell>
      <TableCell className="align-top text-sm">
        {got.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={`Received documents of ${who}`}>{got.map(tick)}</ul> : <span className="text-quiet">{a.documents.length ? 'None yet' : 'No document list set'}</span>}
      </TableCell>
      <TableCell className="align-top text-sm">
        {missing.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={`Not received documents of ${who}`}>{missing.map(tick)}</ul> : <span className="text-quiet">{a.documents.length ? 'None' : 'Add the documents'}</span>}
        <span className="mt-1.5 flex gap-3">
          <Button id={id('upload')} variant="link" size="sm" onClick={() => ctx.open({ kind: 'uploadDoc', id: a.applicationId }, id('upload'))}>
            Upload<span className="sr-only"> a document for {who}</span>
          </Button>
          <Button id={id('add')} variant="link" size="sm" onClick={() => ctx.open({ kind: 'addDoc', id: a.applicationId }, id('add'))}>
            Add<span className="sr-only"> a document for {who}</span>
          </Button>
        </span>
      </TableCell>
      <TableCell className="align-top">
        <Input
          id={id('remark')}
          className={small}
          value={draft.remark}
          maxLength={300}
          aria-label={`Remark for ${who}`}
          invalid={!!err('remark', 'Use at most 300 characters.')}
          onChange={(e) => set({ remark: e.currentTarget.value })}
        />
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-center gap-1.5">
          <Button variant="primary" size="icon" className="size-11 sm:size-9" aria-label={`Save ${who}`} loading={cmd.pending} aria-disabled={cmd.pending || undefined} onClick={save}>
            {cmd.pending ? null : <Check aria-hidden="true" />}
          </Button>
          <Button variant="secondary" size="icon" className="size-11 sm:size-9" aria-label={`Cancel editing ${who}`} onClick={() => onClose(null)}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
    </>
  );
}

/** The refusal of the row being edited, shown above the table (rows cannot hold a full-width alert). */
function RowResult({ state }: { state: VisaResult | null }) {
  return <ResultNotice state={state} />;
}

export function PassengersCard({ ctx, rows, initialEditId = null }: { ctx: WorkCtx; rows: VisaApplicant[]; /** Preview gallery only: a row open for editing on first paint. */ initialEditId?: string | null }) {
  const [editing, setEditing] = useState<string | null>(initialEditId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const a = initialEditId ? rows.find((r) => r.applicationId === initialEditId) : undefined;
    return a ? { [a.applicationId]: draftOf(a) } : {};
  });
  const [saved, setSaved] = useState<VisaResult | null>(null);
  // Focus moves after React has committed the row change (a save resolves inside a transition).
  const focusTarget = useRef<string | null>(null);
  const setFocusId = (id: string) => {
    focusTarget.current = id;
  };
  useEffect(() => {
    const id = focusTarget.current;
    const el = id ? document.getElementById(id) : null;
    if (el) {
      el.focus();
      focusTarget.current = null;
    }
  });
  const ready = rows.filter((a) => !a.removed && a.ready).length;
  const startEdit = (a: VisaApplicant) => {
    setSaved(null);
    setEditing(a.applicationId);
    setDrafts((d) => ({ ...d, [a.applicationId]: draftOf(a) }));
    setFocusId(a.passport ? `row-${a.applicationId}-passport` : `row-${a.applicationId}-date`);
  };
  const close = (a: VisaApplicant, result: VisaResult | null) => {
    setEditing(null);
    if (result?.ok) setSaved({ ok: true, message: `${nameOf(a)}: ${result.message}` });
    setFocusId(pencilId(a));
  };
  return (
    <Card>
      <section aria-labelledby={`visa-pax-${ctx.ws.taskId}`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`visa-pax-${ctx.ws.taskId}`}>Passengers and documents</CardTitle>
            <CardDescription>
              {isPassportTask(ctx.ws) ? 'Documents, appointment date and passport number for each applicant.' : 'Documents, appointment date and passport number for each passenger.'}
              {ctx.working ? ' Use Edit to change a row. Ready passengers are copied to Appointment.' : ''}
            </CardDescription>
          </div>
        </CardHeader>
        {saved ? (
          <div className="px-4.5 pb-3">
            <RowResult state={saved} />
          </div>
        ) : null}
        {editing ? (
          <p id={`pax-one-${ctx.ws.taskId}`} className="sr-only">
            Another passenger is being edited. Opening this one closes it without saving.
          </p>
        ) : null}
        {rows.length === 0 ? (
          <div className="px-4.5 pb-4">
            <Notice tone="warning">No passengers came with this task. Ask Sales to check the booking.</Notice>
          </div>
        ) : (
          <Table label="Passengers and documents table, scrolls sideways on small screens" wrapperClassName="rounded-b-card" className="min-w-[56rem] table-fixed">
            <TableCaption className="caption-top border-b border-line py-3 text-left font-medium text-copy">
              {plural(rows.length, 'passenger')} · {ready} ready for Appointment
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[22%]">Passenger</TableHead>
                <TableHead className="w-40">Appointment date</TableHead>
                <TableHead className="w-[19%]">Received documents</TableHead>
                <TableHead className="w-[19%]">Not received documents</TableHead>
                <TableHead>Remark</TableHead>
                <TableHead className="w-32 text-center">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) =>
                editing === a.applicationId && a.can.edit && drafts[a.applicationId] ? (
                  <EditRow key={a.applicationId} ctx={ctx} a={a} draft={drafts[a.applicationId]!} setDraft={(d) => setDrafts((all) => ({ ...all, [a.applicationId]: d }))} onClose={(result) => close(a, result)} />
                ) : (
                  <ReadRow key={a.applicationId} ctx={ctx} a={a} editingOther={editing !== null} onEdit={() => startEdit(a)} />
                ),
              )}
            </TableBody>
          </Table>
        )}
      </section>
    </Card>
  );
}
