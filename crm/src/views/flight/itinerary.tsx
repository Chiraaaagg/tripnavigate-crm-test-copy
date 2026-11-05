'use client';

import { Hourglass, Plus, Route, TableProperties } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Submit, type UiResult } from '@/views/accounts/supplier-forms';
import { FF, type FlightWorkActions } from './actions';
import { bySchedule, flightLabel, routeText, sectorLine, shortDate } from './format';
import { ActionForm } from './kit';
import { PAX_LABEL, PAX_ORDER } from './labels';
import { checkSector, EMPTY_SECTOR, SectorFields, type SectorDraft, type SectorErrors, type SectorKey } from './sector-fields';
import { useSelection } from './selection';
import type { DealKind, FlightSector, FlightTraveller, WorkspaceFlight } from './types';

/*
 * "Main itinerary" of one flight (contract 11.1; prototype alternativeCard
 * FV:1487, altHeads FV:1165, altRows FV:1274) with the fixes the contract
 * lists: header names wrap (no sideways scroll at 375 px; the grid stacks
 * into labelled cards on phones), Alternate and "+ Add sector" always ask
 * which travellers move (locked ones say why), the approval rule is shown
 * on the button ("Send to Sales for approval" / "Save and apply"), and the
 * edit row exists only for the Flight assignee, in this component's own
 * state (no draft leaks to another role or page). Focus goes to the first
 * field of the edit row and back to the button that opened it.
 */

type Editing =
  | { kind: 'alternate'; sectorId: string }
  | { kind: 'fill'; sectorId: string }
  | { kind: 'add' }
  | null;

function draftOf(s: FlightSector): SectorDraft {
  return {
    departDate: shortDate(s.departDate),
    flightNo: s.flightNo ?? '',
    from: s.from,
    to: s.to,
    departTime: s.departTime ?? '',
    arriveTime: s.arriveTime ?? '',
    arriveDate: s.arriveDate && s.arriveDate !== s.departDate ? shortDate(s.arriveDate) : '',
    airline: s.airline ?? '',
    cabin: s.cabin ?? 'Economy',
  };
}

export function nameOf(f: WorkspaceFlight, seq: number): string {
  return f.travellers.find((t) => t.seq === seq)?.fullName ?? `Traveller ${seq}`;
}

function typeOf(f: WorkspaceFlight, seq: number): FlightTraveller['type'] | null {
  return f.travellers.find((t) => t.seq === seq)?.type ?? null;
}

/** Why a traveller on this sector cannot move now, or null when they can. */
function lockReason(t: FlightSector['travellers'][number]): string | null {
  if (t.ticket) return 'has a ticket on this flight';
  if (t.held) return t.heldByChangeNo ? `waiting for change ${t.heldByChangeNo}` : 'waiting for a change decision';
  return null;
}

/** Travellers who may get a new itinerary: no ticket, no hold and no change waiting on this flight. */
export function itineraryEligible(f: WorkspaceFlight): FlightTraveller[] {
  return f.travellers.filter((t) => {
    const mine = f.sectors.filter((s) => s.displayState === 'active' || s.displayState === 'pending').flatMap((s) => s.travellers.filter((x) => x.seq === t.seq));
    return !mine.some((x) => x.held || x.ticket) && !f.changes.some((c) => c.status === 'pending' && c.travellers.some((p) => p.seq === t.seq));
  });
}

export const NO_ITINERARY_TEXT = 'Nobody can get a new itinerary now: every traveller has a ticket or a change waiting.';

export function submitLabel(dealKind: DealKind): string {
  return dealKind === 'package' ? 'Send to Sales for approval' : 'Save and apply';
}

const SHOWN: FlightSector['displayState'][] = ['active', 'pending', 'replaced'];

export function ItineraryCard({
  f,
  dealKind,
  canWork,
  blockedReason,
  actions,
  deciderWord,
}: {
  f: WorkspaceFlight;
  dealKind: DealKind;
  /** Flight assignee, task in progress: edit rows, selection and row actions. */
  canWork: boolean;
  /** Shown instead of the row actions (booking changed). */
  blockedReason: string | null;
  actions: FlightWorkActions;
  /** "Sales" or "the Manager": who decides package changes on this Deal. */
  deciderWord: string;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [itinOpen, setItinOpen] = useState(false);
  const returnFocus = useRef<string | null>(null);
  const { selected, toggle } = useSelection();
  const sectors = f.sectors.filter((s) => SHOWN.includes(s.displayState)).sort(bySchedule);
  const types = PAX_ORDER.filter((t) => f.travellers.some((p) => p.type === t));
  const work = canWork && !blockedReason;
  const headingId = `itin-${f.taskId}`;
  const noneEligible = itineraryEligible(f).length === 0;

  const open = (next: Editing, triggerId: string) => {
    returnFocus.current = triggerId;
    setFlash(null);
    setEditing(next);
  };
  const close = useCallback((message?: string) => {
    setEditing(null);
    if (message) setFlash(message);
    const id = returnFocus.current;
    requestAnimationFrame(() => (id ? document.getElementById(id)?.focus() : undefined));
  }, []);

  const changeOf = (s: FlightSector) => (s.changeId ? f.changes.find((c) => c.changeId === s.changeId) : undefined);
  const colCount = 9 + types.length + (work ? 1 : 0);

  return (
    <Card id={headingId}>
      <section aria-labelledby={`${headingId}-title`}>
        <CardHeader className="flex-wrap">
          <div className="min-w-0">
            <CardTitle id={`${headingId}-title`}>Main itinerary · {f.title}</CardTitle>
            <CardDescription>
              {f.travellers.length ? f.travellers.map((t) => t.fullName).join(', ') : 'No traveller named yet'}
            </CardDescription>
          </div>
          {work ? (
            <div className="flex flex-wrap gap-2">
              <Button id={`${headingId}-add`} variant="secondary" size="sm" onClick={() => open({ kind: 'add' }, `${headingId}-add`)} aria-expanded={editing?.kind === 'add'}>
                <Plus aria-hidden="true" />
                Add sector
              </Button>
              <Button
                id={`${headingId}-itin`}
                variant="secondary"
                size="sm"
                aria-disabled={noneEligible ? 'true' : undefined}
                aria-describedby={noneEligible ? `${headingId}-itin-why` : undefined}
                onClick={(e) => {
                  if (noneEligible) {
                    e.preventDefault();
                    return;
                  }
                  setItinOpen(true);
                }}
              >
                <TableProperties aria-hidden="true" />
                New itinerary for one traveller
              </Button>
              {noneEligible ? (
                <p id={`${headingId}-itin-why`} className="m-0 basis-full text-xs text-quiet">
                  {NO_ITINERARY_TEXT}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div role="status" aria-live="polite">
            {flash ? (
              <Notice tone="success">
                <p>{flash}</p>
              </Notice>
            ) : null}
          </div>
          {blockedReason && canWork ? (
            <Notice tone="warning" role="note">
              <p>{blockedReason}</p>
            </Notice>
          ) : null}
          {sectors.length === 0 ? (
            <p className="m-0 text-copy">{f.entryMode === 'screenshot' ? 'No sectors yet. Type them from the screenshot above.' : 'No flights on this booking yet.'}</p>
          ) : (
            <div className="overflow-hidden rounded-control border border-line">
              <table role="table" className="w-full border-collapse text-sm max-md:block" aria-labelledby={`${headingId}-title`}>
                <thead role="rowgroup" className="bg-wash text-left text-xs font-semibold text-quiet max-md:sr-only">
                  <tr role="row">
                    {work ? (
                      <th role="columnheader" scope="col" className="px-2 py-2 align-bottom">
                        Select
                      </th>
                    ) : null}
                    {['Date', 'Flight no.', 'From', 'To', 'Dep time', 'Arr time', 'Class'].map((h) => (
                      <th key={h} role="columnheader" scope="col" className="px-2 py-2 align-bottom break-words">
                        {h}
                      </th>
                    ))}
                    {types.map((t) => (
                      <th key={t} role="columnheader" scope="col" className="px-2 py-2 text-right align-bottom">
                        {PAX_LABEL[t]}
                      </th>
                    ))}
                    <th role="columnheader" scope="col" className="px-2 py-2 align-bottom">
                      Remark
                    </th>
                    <th role="columnheader" scope="col" className="px-2 py-2 align-bottom">
                      Actions<span className="sr-only"> and status</span>
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup" className="max-md:block">
                  {sectors.map((s) => {
                    const ch = changeOf(s);
                    const onIt = s.travellers;
                    const count = (t: FlightTraveller['type']) => onIt.filter((x) => typeOf(f, x.seq) === t).length;
                    const ticketable = s.displayState === 'active' && onIt.some((x) => !x.ticket && !x.held);
                    const line = sectorLine(s);
                    const altId = `${s.sectorId}-alt`;
                    const fillId = `${s.sectorId}-fill`;
                    const isEditing = editing && 'sectorId' in editing && editing.sectorId === s.sectorId;
                    return [
                      <tr
                        key={s.sectorId}
                        role="row"
                        className={cn('border-t border-line align-top max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-1 max-md:px-3 max-md:py-3', s.displayState === 'replaced' && 'text-quiet', s.displayState === 'pending' && 'bg-status-warning-tint')}
                      >
                        {work ? (
                          <td role="cell" className="px-2 py-2 max-md:col-span-2 max-md:p-0">
                            {ticketable ? (
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="size-4 accent-brand-strong"
                                  checked={selected.includes(s.sectorId)}
                                  onChange={(e) => toggle(s.sectorId, e.target.checked)}
                                  aria-label={`Select ${line} for Confirm tickets`}
                                />
                                <span className="md:sr-only">Select for Confirm tickets</span>
                              </label>
                            ) : (
                              <span className="text-xs text-quiet">{s.displayState === 'active' ? 'All ticketed' : '—'}</span>
                            )}
                          </td>
                        ) : null}
                        <Cell label="Date" nowrap>
                          {shortDate(s.departDate)}
                        </Cell>
                        <Cell label="Flight no.">
                          <span className="font-medium text-ink">{flightLabel(s.airline, s.flightNo)}</span>
                        </Cell>
                        <Cell label="From">{s.from}</Cell>
                        <Cell label="To">{s.to}</Cell>
                        <Cell label="Dep time">{s.departTime ?? '—'}</Cell>
                        <Cell label="Arr time">
                          {s.arriveTime ?? '—'}
                          {s.arriveDate && s.arriveDate !== s.departDate ? <span className="block text-xs text-quiet">{shortDate(s.arriveDate)}</span> : null}
                        </Cell>
                        <Cell label="Class">{s.cabin ?? '—'}</Cell>
                        {types.map((t) => (
                          <Cell key={t} label={PAX_LABEL[t]} numeric>
                            {count(t)}
                          </Cell>
                        ))}
                        <Cell label="Remark">{ch?.remark ?? '—'}</Cell>
                        <td role="cell" className="px-2 py-2 max-md:col-span-2 max-md:p-0">
                          <div className="flex flex-col items-start gap-1.5">
                            {s.displayState === 'pending' ? (
                              <StatusBadge tone="warning" icon={Hourglass} wrap>
                                {dealKind === 'package' ? `Waiting for ${deciderWord}` : 'Waiting'}
                                {ch ? ` · change ${ch.changeNo}` : ''}
                              </StatusBadge>
                            ) : s.displayState === 'replaced' ? (
                              <StatusBadge tone="neutral" wrap>
                                Replaced
                              </StatusBadge>
                            ) : null}
                            {work && s.displayState === 'active' ? (
                              <div className="flex flex-wrap gap-1.5">
                                {s.canAlternate ? (
                                  <Button id={altId} size="sm" variant="secondary" aria-expanded={editing?.kind === 'alternate' && isEditing ? true : false} onClick={() => open({ kind: 'alternate', sectorId: s.sectorId }, altId)}>
                                    Alternate<span className="sr-only"> {line}</span>
                                  </Button>
                                ) : null}
                                {s.canFillBlanks ? (
                                  <Button id={fillId} size="sm" variant="ghost" aria-expanded={editing?.kind === 'fill' && isEditing ? true : false} onClick={() => open({ kind: 'fill', sectorId: s.sectorId }, fillId)}>
                                    Fill missing details<span className="sr-only"> of {line}</span>
                                  </Button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>,
                      <tr key={`${s.sectorId}-pax`} role="row" className="max-md:block">
                        <td role="cell" colSpan={colCount} className="px-2 pb-2 text-xs text-quiet max-md:block max-md:px-3">
                          <span className="sr-only">Travellers on {line}: </span>
                          {onIt.length ? onIt.map((x) => `${nameOf(f, x.seq)}${x.ticket ? ' (ticketed)' : x.held ? ` (waiting for change ${x.heldByChangeNo ?? ''})` : ''}`).join(', ') : 'Nobody on this flight now'}
                        </td>
                      </tr>,
                      isEditing ? (
                        <tr key={`${s.sectorId}-edit`} role="row" className="border-t border-line bg-wash max-md:block">
                          <td role="cell" colSpan={colCount} className="px-3 py-3 max-md:block">
                            {editing?.kind === 'alternate' ? (
                              <ChangeEditor f={f} dealKind={dealKind} actions={actions} mode={{ kind: 'alternate', sector: s }} onCancel={() => close()} onDone={(m) => close(m)} />
                            ) : (
                              <FillBlanksEditor sector={s} action={actions.fillBlanks} onCancel={() => close()} onDone={(m) => close(m)} />
                            )}
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
          {editing?.kind === 'add' ? (
            <div className="rounded-control border border-line bg-wash p-3">
              <ChangeEditor f={f} dealKind={dealKind} actions={actions} mode={{ kind: 'add', sectors }} onCancel={() => close()} onDone={(m) => close(m)} />
            </div>
          ) : null}
          {work ? (
            <PassengerItineraryDialog f={f} dealKind={dealKind} action={actions.submitChange} open={itinOpen} onOpenChange={setItinOpen} onDone={(m) => setFlash(m)} triggerId={`${headingId}-itin`} />
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function Cell({ label, children, numeric, nowrap }: { label: string; children: React.ReactNode; numeric?: boolean; nowrap?: boolean }) {
  return (
    <td role="cell" className={cn('px-2 py-2 max-md:p-0', numeric && 'text-right tabular-nums max-md:text-left', nowrap && 'whitespace-nowrap')}>
      <span className="block text-xs font-semibold text-quiet md:hidden" aria-hidden="true">
        {label}
      </span>
      {children}
    </td>
  );
}

/* ---------------- Alternate / Add sector ---------------- */

type EditorMode = { kind: 'alternate'; sector: FlightSector } | { kind: 'add'; sectors: FlightSector[] };

function ChangeEditor({ f, dealKind, actions, mode, onCancel, onDone }: { f: WorkspaceFlight; dealKind: DealKind; actions: FlightWorkActions; mode: EditorMode; onCancel: () => void; onDone: (message: string) => void }) {
  const base = useId();
  const firstRef = useRef<HTMLInputElement | null>(null);
  const focusFirst = useCallback((el: HTMLInputElement | null) => {
    if (el && !firstRef.current) {
      firstRef.current = el;
      el.focus();
    }
  }, []);
  const active = mode.kind === 'add' ? mode.sectors.filter((s) => s.displayState === 'active') : [];
  const [addKind, setAddKind] = useState<'instead' | 'extra'>(active.length ? 'instead' : 'extra');
  const [insteadOf, setInsteadOf] = useState<string>(active[0]?.sectorId ?? '');
  const fromSector = mode.kind === 'alternate' ? mode.sector : addKind === 'instead' ? active.find((s) => s.sectorId === insteadOf) : undefined;
  const [draft, setDraft] = useState<SectorDraft>(mode.kind === 'alternate' ? draftOf(mode.sector) : { ...EMPTY_SECTOR, cabin: fromSector?.cabin ?? 'Economy' });
  const [seqs, setSeqs] = useState<number[]>([]);
  const [remark, setRemark] = useState('');
  const [errors, setErrors] = useState<SectorErrors & { travellers?: string; remark?: string }>({});

  // Who can be chosen: on the from-flight, unheld and without a ticket; for an extra journey, any traveller of this flight.
  const choices: Array<{ seq: number; reason: string | null }> = fromSector
    ? fromSector.travellers.map((t) => ({ seq: t.seq, reason: lockReason(t) }))
    : f.travellers.map((t) => {
        const held = f.sectors.some((s) => s.travellers.some((x) => x.seq === t.seq && x.held));
        return { seq: t.seq, reason: held ? 'waiting for a change decision' : null };
      });
  const kind = mode.kind === 'alternate' ? 'alternative' : addKind === 'instead' ? 'added_instead' : 'added_extra';
  const checked = check();
  function check() {
    return checkSector(draft);
  }
  const payload = JSON.stringify({
    kind,
    fromSectorIds: fromSector ? [fromSector.sectorId] : [],
    travellerSeqs: seqs,
    remark: remark.trim(),
    sectors: checked.value ? [checked.value] : [],
  });
  const title = mode.kind === 'alternate' ? `Alternate ${sectorLine(mode.sector)}` : 'Add a sector';
  return (
    <ActionForm
      action={actions.submitChange}
      fields={{ [FF.taskId]: f.taskId, [FF.payload]: payload }}
      label={title}
      onDone={(s: UiResult) => onDone(s.ok ? s.message : '')}
      onSubmit={(e) => {
        const errs: typeof errors = { ...checked.errors };
        if (seqs.length === 0) errs.travellers = kind === 'added_extra' ? 'Choose at least one traveller for this extra flight.' : 'Choose at least one traveller who moves.';
        const len = remark.trim().length;
        if (len < 3 || len > 300) errs.remark = 'Write a remark of 3 to 300 characters (why the change).';
        setErrors(errs);
        const first = Object.keys(errs)[0];
        if (first) {
          e.preventDefault();
          document.getElementById(first === 'travellers' ? `${base}-trav` : first === 'remark' ? `${base}-remark` : `${base}-${first}`)?.focus();
        }
      }}
    >
      <h3 className="m-0 text-base font-semibold text-ink">{title}</h3>
      {mode.kind === 'add' ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-semibold text-ink">What is this sector?</legend>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
            <label className={cn('flex items-center gap-2', !active.length && 'text-quiet')}>
              <input type="radio" className="size-4 accent-brand-strong" name={`${base}-addkind`} checked={addKind === 'instead'} disabled={!active.length} onChange={() => setAddKind('instead')} />
              Instead of a flight
            </label>
            {addKind === 'instead' && active.length ? (
              <Select aria-label="Instead of which flight" value={insteadOf} onChange={(e) => { setInsteadOf(e.target.value); setSeqs([]); }} className="w-full min-w-0 sm:w-auto sm:max-w-full">
                {active.map((s) => (
                  <option key={s.sectorId} value={s.sectorId}>
                    {sectorLine(s)}
                  </option>
                ))}
              </Select>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="radio" className="size-4 accent-brand-strong" name={`${base}-addkind`} checked={addKind === 'extra'} onChange={() => { setAddKind('extra'); setSeqs([]); }} />
              Extra journey
            </label>
          </div>
        </fieldset>
      ) : null}
      <SectorFields value={draft} onChange={setDraft} errors={errors} idBase={base} firstFieldRef={focusFirst} legend="New flight details" />
      <fieldset id={`${base}-trav`} tabIndex={-1} className="m-0 flex flex-col gap-1.5 border-0 p-0" aria-describedby={errors.travellers ? `${base}-trav-error` : undefined}>
        <legend className="mb-1 text-sm font-semibold text-ink">
          {kind === 'added_extra' ? 'Travellers on this extra flight' : `Travellers who move${fromSector ? ` from ${flightLabel(fromSector.airline, fromSector.flightNo)}` : ''}`}
        </legend>
        {choices.length === 0 ? <p className="m-0 text-sm text-quiet">Nobody can move on this flight now.</p> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {choices.map((c) => (
            <label key={c.seq} className={cn('flex items-start gap-2', c.reason && 'text-quiet')}>
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand-strong"
                checked={seqs.includes(c.seq)}
                disabled={!!c.reason}
                onChange={(e) => setSeqs((s) => (e.target.checked ? [...s, c.seq] : s.filter((x) => x !== c.seq)))}
              />
              <span>
                {nameOf(f, c.seq)}
                {c.reason ? <span className="block text-xs">Cannot move: {c.reason}</span> : null}
              </span>
            </label>
          ))}
        </div>
        {fromSector ? <p className="m-0 text-xs text-quiet">Everyone not ticked stays on the current flight.</p> : null}
        {errors.travellers ? (
          <p id={`${base}-trav-error`} className="m-0 text-sm font-medium text-status-danger">
            {errors.travellers}
          </p>
        ) : null}
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${base}-remark`} className="text-sm font-semibold text-ink">
          Remark
        </label>
        <Textarea id={`${base}-remark`} rows={2} maxLength={300} value={remark} onChange={(e) => setRemark(e.target.value)} invalid={!!errors.remark} aria-describedby={errors.remark ? `${base}-remark-error` : `${base}-remark-hint`} />
        {errors.remark ? (
          <span id={`${base}-remark-error`} className="text-sm font-medium text-status-danger">
            {errors.remark}
          </span>
        ) : (
          <span id={`${base}-remark-hint`} className="text-xs text-quiet">
            Why this change: {dealKind === 'package' ? 'Sales reads it before deciding.' : 'kept in the History.'}
          </span>
        )}
      </div>
      <p className="m-0 text-sm text-quiet">
        {dealKind === 'package' ? 'Nothing changes for the travellers until the Sales owner approves.' : 'Flight-only Deal: you decide, and the change applies at once.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Submit label={submitLabel(dealKind)} pendingLabel="Saving…" />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </ActionForm>
  );
}

/* ---------------- Fill missing details ---------------- */

const FILLABLE: Array<[SectorKey, keyof FlightSector]> = [
  ['airline', 'airline'],
  ['flightNo', 'flightNo'],
  ['departTime', 'departTime'],
  ['arriveTime', 'arriveTime'],
  ['arriveDate', 'arriveDate'],
];

function FillBlanksEditor({ sector, action, onCancel, onDone }: { sector: FlightSector; action: FlightWorkActions['fillBlanks']; onCancel: () => void; onDone: (m: string) => void }) {
  const base = useId();
  const only = FILLABLE.filter(([, k]) => !sector[k]).map(([d]) => d);
  const [draft, setDraft] = useState<SectorDraft>(draftOf(sector));
  const [errors, setErrors] = useState<SectorErrors>({});
  const focusFirst = useCallback((el: HTMLInputElement | null) => el?.focus(), []);
  const checked = checkSector(draft, []);
  const fields: Record<string, string> = {};
  if (checked.value) for (const k of only) if (checked.value[k]) fields[k] = checked.value[k]!;
  return (
    <ActionForm
      action={action}
      fields={{ [FF.sectorId]: sector.sectorId, [FF.expectedRowVersion]: sector.rowVersion, [FF.payload]: JSON.stringify(fields) }}
      label={`Fill missing details of ${sectorLine(sector)}`}
      onDone={(s) => onDone(s.ok ? s.message : '')}
      onSubmit={(e) => {
        const errs = { ...checked.errors };
        if (!Object.keys(errs).length && Object.keys(fields).length === 0) errs[only[0] ?? 'flightNo'] = 'Type at least one missing detail.';
        setErrors(errs);
        const first = Object.keys(errs)[0];
        if (first) {
          e.preventDefault();
          document.getElementById(`${base}-${first}`)?.focus();
        }
      }}
    >
      <h3 className="m-0 text-base font-semibold text-ink">Fill missing details · {routeText(sector.from, sector.to)}</h3>
      <p className="m-0 text-sm text-quiet">Only empty details can be typed here; this needs no approval. To change a filled detail, use Alternate.</p>
      <SectorFields value={draft} onChange={setDraft} errors={errors} idBase={base} only={only} firstFieldRef={focusFirst} legend="Missing flight details" />
      <div className="flex flex-wrap gap-2">
        <Submit label="Save details" pendingLabel="Saving…" />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </ActionForm>
  );
}

/* ---------------- Passenger itinerary ("Add new table") ---------------- */

function PassengerItineraryDialog({
  f,
  dealKind,
  action,
  open,
  onOpenChange,
  onDone,
  triggerId,
}: {
  f: WorkspaceFlight;
  dealKind: DealKind;
  action: FlightWorkActions['submitChange'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
  triggerId: string;
}) {
  const base = useId();
  // Draft kept while this page is open (closing the dialog keeps it; Discard clears it).
  const [seq, setSeq] = useState<number | null>(null);
  const [rows, setRows] = useState<SectorDraft[]>([]);
  const [remark, setRemark] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const eligible = itineraryEligible(f);
  const current = (s: number) => f.sectors.filter((x) => x.displayState === 'active' && x.travellers.some((t) => t.seq === s)).sort(bySchedule);
  const pick = (s: number) => {
    setSeq(s);
    setRows(current(s).map(draftOf));
    setErrors({});
  };
  const checked = rows.map((r) => checkSector(r));
  const payload = JSON.stringify({
    kind: 'passenger_itinerary',
    fromSectorIds: seq ? current(seq).map((s) => s.sectorId) : [],
    travellerSeqs: seq ? [seq] : [],
    remark: remark.trim(),
    sectors: checked.every((c) => c.value) ? checked.map((c) => c.value) : [],
  });
  const discard = () => {
    setSeq(null);
    setRows([]);
    setRemark('');
    setErrors({});
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
      }}
    >
      <DialogContent className="max-w-[min(76rem,calc(100vw-2rem))]" aria-describedby={`${base}-desc`}>
        <DialogHeader>
          <DialogTitle>New itinerary for one traveller</DialogTitle>
          <DialogDescription id={`${base}-desc`}>
            This replaces the flights of one traveller only. The other travellers keep theirs. {dealKind === 'package' ? 'The Sales owner approves it first.' : 'You decide on a flight-only Deal.'}
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={action}
          fields={{ [FF.taskId]: f.taskId, [FF.payload]: payload }}
          label="New itinerary for one traveller"
          className="flex flex-col"
          onDone={(s) => {
            discard();
            onOpenChange(false);
            onDone(s.ok ? s.message : '');
            requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
          }}
          onSubmit={(e) => {
            const errs: Record<string, string> = {};
            if (!seq) errs.traveller = 'Choose the traveller.';
            if (seq && rows.length === 0) errs.rows = 'Add at least one flight.';
            checked.forEach((c, i) => {
              const k = Object.keys(c.errors)[0] as SectorKey | undefined;
              if (k) errs[`${i}-${k}`] = c.errors[k]!;
            });
            const len = remark.trim().length;
            if (len < 3 || len > 300) errs.remark = 'Write a remark of 3 to 300 characters.';
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${base}-traveller`} className="text-sm font-semibold text-ink">
                Traveller
              </label>
              <Select id={`${base}-traveller`} value={seq ?? ''} onChange={(e) => (e.target.value ? pick(Number(e.target.value)) : discard())} invalid={!!errors.traveller} className="max-w-md">
                <option value="">Choose a traveller</option>
                {eligible.map((t) => (
                  <option key={t.seq} value={t.seq}>
                    {t.fullName} ({PAX_LABEL[t.type]})
                  </option>
                ))}
              </Select>
              <span className="text-xs text-quiet">Only travellers with no ticket and no change waiting can get a new itinerary.</span>
              {errors.traveller ? <span className="text-sm font-medium text-status-danger">{errors.traveller}</span> : null}
            </div>
            {seq ? (
              <>
                <details className="rounded-control border border-line px-3 py-2">
                  <summary className="cursor-pointer text-sm font-semibold text-ink">Previous itinerary of {nameOf(f, seq)}</summary>
                  <ul className="m-0 mt-[0.5rem] flex list-none flex-col gap-1 p-0 text-sm">
                    {current(seq).length ? current(seq).map((s) => <li key={s.sectorId}>{sectorLine(s)}</li>) : <li>No flights</li>}
                  </ul>
                </details>
                {rows.map((r, i) => (
                  <div key={i} className="flex flex-col gap-2 rounded-control border border-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-ink">
                        <Route aria-hidden="true" className="size-4" />
                        Flight {i + 1}
                      </h3>
                      <Button size="sm" variant="ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                        Remove<span className="sr-only"> flight {i + 1}</span>
                      </Button>
                    </div>
                    <SectorFields
                      value={r}
                      onChange={(next) => setRows((x) => x.map((y, j) => (j === i ? next : y)))}
                      errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`${i}-`)).map(([k, v]) => [k.slice(String(i).length + 1), v]))}
                      idBase={`${base}-${i}`}
                      legend={`Flight ${i + 1} of the new itinerary`}
                    />
                  </div>
                ))}
                {rows.length === 0 ? <p className="m-0 text-sm text-quiet">No flights in the new itinerary yet.</p> : null}
                {errors.rows ? <p className="m-0 text-sm font-medium text-status-danger">{errors.rows}</p> : null}
                {rows.length < 8 ? (
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => setRows((x) => [...x, { ...EMPTY_SECTOR }])}>
                      <Plus aria-hidden="true" />
                      Add a flight
                    </Button>
                  </div>
                ) : null}
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${base}-remark`} className="text-sm font-semibold text-ink">
                    Remark
                  </label>
                  <Textarea id={`${base}-remark`} rows={2} maxLength={300} value={remark} onChange={(e) => setRemark(e.target.value)} invalid={!!errors.remark} />
                  {errors.remark ? <span className="text-sm font-medium text-status-danger">{errors.remark}</span> : null}
                </div>
              </>
            ) : eligible.length === 0 ? (
              <p className="m-0 text-sm text-quiet">{NO_ITINERARY_TEXT}</p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={discard}>
              Discard
            </Button>
            {eligible.length === 0 ? (
              <Button variant="primary" aria-disabled="true" aria-describedby={`${base}-none`} onClick={(e) => e.preventDefault()}>
                {submitLabel(dealKind)}
                <span id={`${base}-none`} className="sr-only">
                  {NO_ITINERARY_TEXT}
                </span>
              </Button>
            ) : (
              <Submit label={submitLabel(dealKind)} pendingLabel="Saving…" />
            )}
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

