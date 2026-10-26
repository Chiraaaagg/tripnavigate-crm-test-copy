'use client';

import { CircleAlert, CircleCheck, MoreHorizontal, Paperclip, Trash2, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { fieldDescribedBy } from '@/components/ui/field';
import { ID_PROOF_TEXT, type BookTravellerView, type TravellerType } from '@/modules/fulfilment/contracts';
import { TRAVELLER_SEQ_FIELD, TRAVELLER_SEQ_MAX_FIELD } from '@/modules/fulfilment/b11-forms';
import { idProofsDetachedByRename, travellerSeqHighWater } from '../b11/book-fields';
import { useSectionForm } from '../b11/draft-sync';
import { ResultBox, type FieldRef } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { ConfirmDialog } from './confirm-dialog';
import { HiddenDraftInputs, SectionSaveRow, editableOf, useShownRefusal, useSectionSubmit } from './form-helpers';
import { IdProofDialog } from './id-proof-dialog';
import { PassengerDrawer, type PassengerRow } from './passenger-drawer';
import { displayRows, isRealPassenger, overCount, REMOVE_TRAVELLER_FIELD, type DisplayRow, type PartyCountsTyped } from './passenger-display';

export { displayRows, isRealPassenger, overCount, type DisplayRow, type PartyCountsTyped };
import { EmptyInline, SectionCard } from './parts';

/*
 * Step 1 · Passengers. Voice-note batch (24 October 2026, owner items 2 and
 * 3): the rows come from the adult, child and infant counts above as slots
 * of the right type, so nobody presses "Add passenger" again and again. An
 * empty slot is never saved; a slot becomes a passenger once a name is
 * typed. Lowering a count never removes a named or saved passenger: the card
 * says which type is over the count and the person removes one (or changes
 * the counts). Each row has a visible "Attach ID proof" (private upload with
 * the consent tick); a passenger not saved yet is saved first. Everything
 * else about a passenger lives in the Details drawer. The rows are one form
 * posting to saveTravellers (deal_travellers_save, parallel arrays; an empty
 * slot posts an empty row, which the server skips).
 */

export const TYPE_TEXT: Record<TravellerType, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };
const TYPE_PLURAL: Record<TravellerType, [string, string]> = { adult: ['adult', 'adults'], child: ['child', 'children'], infant: ['infant', 'infants'] };

export interface PassengerActions {
  saveTravellers: B11Action;
  saveIdentity: B11Action;
  uploadIdProof: B11Action;
  removeIdProof: B11Action;
  retryIdProofCopy?: B11Action;
}


const plural = (n: number, t: TravellerType) => `${n} ${TYPE_PLURAL[t][n === 1 ? 0 : 1]}`;

function rowsOf(view: BookNowView): PassengerRow[] {
  return [...view.travellers]
    .sort((a, b) => a.seq - b.seq)
    .map((t) => ({ seq: t.seq, name: t.fullName, type: t.type, age: t.ageYears === null ? '' : String(t.ageYears), needs: t.specialNeeds ?? '', requests: [...(t.specialRequests ?? [])] }));
}

export function PassengersCard({
  view,
  reloadHref,
  actions,
  counts,
  onRows,
}: {
  view: BookNowView;
  reloadHref: string;
  actions: PassengerActions;
  /** The adult, child and infant counts typed above (the slots follow them). */
  counts: PartyCountsTyped;
  /** Passenger rows on screen (step 1 checks use what is on screen, Echo B-L6). Empty slots are left out. */
  onRows?: (rows: PassengerRow[]) => void;
}) {
  const editable = editableOf(view);
  const [renameBase, setRenameBase] = useState<Pick<BookNowView, 'travellers'> | null>(null);
  const [detached, setDetached] = useState<Array<{ seq: number; fullName: string }>>([]);
  if (renameBase && renameBase.travellers !== view.travellers) {
    setDetached(idProofsDetachedByRename(renameBase, view));
    setRenameBase(null);
  }
  const f = useSectionForm({
    id: 'passengers',
    section: 'passengers',
    label: 'Passengers',
    order: 20,
    action: actions.saveTravellers,
    initial: { travellers: rowsOf(view), removed: [] as number[] },
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    onSuccess: () => {
      setDetached([]);
      setRenameBase({ travellers: view.travellers });
    },
  });
  const { bindForm, bindResult } = f;
  const submitter = useSectionSubmit(f.post);
  const rows = f.values.travellers;
  useEffect(() => {
    onRows?.(rows.filter(isRealPassenger));
  }, [rows, onRows]);
  const shown = displayRows(rows, counts);
  const countsRef = useRef(counts);
  useEffect(() => {
    countsRef.current = counts;
  });
  const refusal = useShownRefusal(f, (name) => {
    const m = /^traveller(Name|Age|Needs|Requests)\[(\d+)\]$/.exec(name);
    if (!m) return undefined;
    const key = ({ Name: 'name', Age: 'age', Needs: 'needs', Requests: 'requests' } as const)[m[1] as 'Name'];
    const i = Number(m[2]);
    return (v: { travellers: PassengerRow[]; removed: number[] }) => displayRows(v.travellers, counts)[i]?.row?.[key];
  });
  const fields = refusal.fields;
  const refs: FieldRef[] = shown.flatMap((_, i) => [
    { field: `travellerName[${i}]`, id: `passengers-${i + 1}-name`, label: `Passenger ${i + 1}: full name as on the ID.` },
    { field: `travellerAge[${i}]`, id: `passengers-${i + 1}-details`, label: `Passenger ${i + 1}: age 0 to 17 (in Details).` },
    { field: `travellerNeeds[${i}]`, id: `passengers-${i + 1}-details`, label: `Passenger ${i + 1}: special requirements up to 500 characters (in Details).` },
    { field: `travellerRequests[${i}]`, id: `passengers-${i + 1}-details`, label: `Passenger ${i + 1}: choose the requests from the list (in Details).` },
  ]);
  const nameErr = (i: number) => (fields?.includes(`travellerName[${i}]`) ? refs.find((r) => r.field === `travellerName[${i}]`)!.label : null);
  const setRows = (fn: (x: PassengerRow[]) => PassengerRow[]) => f.setValues((s) => ({ ...s, travellers: fn(s.travellers) }));
  const removed = f.values.removed;

  /** Writes a row on screen; an empty slot first becomes a row (with the slots before it, so nothing moves). */
  const writeRow = (d: DisplayRow, patch: Partial<PassengerRow>) =>
    setRows((x) => {
      if (d.stateIndex !== null && x[d.stateIndex]) return x.map((r, j) => (j === d.stateIndex ? { ...r, ...patch } : r));
      const have = displayRows(x, countsRef.current).filter((r) => r.type === d.type && r.row !== null).length;
      const added: PassengerRow[] = [];
      for (let p = have; p <= d.pos; p += 1) added.push({ seq: null, name: '', type: d.type, age: '', needs: '', requests: [], key: `${d.type}-slot-${p}` });
      Object.assign(added[added.length - 1]!, patch);
      return [...x, ...added];
    });

  // Drawer: which row, and a save that runs after the edited row is on screen.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [proofFor, setProofFor] = useState<number | null>(null);
  const [rowNote, setRowNote] = useState<{ key: string; text: string } | null>(null);
  const [proofWanted, setProofWanted] = useState<{ name: string; type: TravellerType; known: number[] } | null>(null);
  const pendingSave = useRef<null | ((ok: boolean) => void)>(null);
  const [saveTick, setSaveTick] = useState(0);
  useEffect(() => {
    if (saveTick === 0 || !pendingSave.current) return;
    const done = pendingSave.current;
    pendingSave.current = null;
    const form = document.getElementById('passengers-form');
    if (!(form instanceof HTMLFormElement)) {
      done(false);
      return;
    }
    void f.post(new FormData(form)).then((r) => done(r.ok));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per drawer save, after the row is committed
  }, [saveTick]);
  const saveNow = () =>
    new Promise<boolean>((resolve) => {
      pendingSave.current = resolve;
      setSaveTick((n) => n + 1);
    });
  const saveFromDrawer = (d: DisplayRow, row: PassengerRow) => {
    writeRow(d, row);
    return saveNow();
  };

  // "Attach ID proof" on a passenger saved just now: open the dialog once the refreshed list has them.
  const [seenTravellers, setSeenTravellers] = useState(view.travellers);
  if (proofWanted && seenTravellers !== view.travellers) {
    setSeenTravellers(view.travellers);
    const match = view.travellers
      .filter((t) => !proofWanted.known.includes(t.seq) && t.fullName.trim() === proofWanted.name && t.type === proofWanted.type)
      .sort((a, b) => b.seq - a.seq)[0];
    if (match) {
      setProofWanted(null);
      setProofFor(match.seq);
    }
  }

  const attachProof = async (d: DisplayRow, i: number) => {
    const row = d.row;
    const name = row?.name.trim() ?? '';
    if (!name) {
      setRowNote({ key: d.key, text: 'Enter the name first, then attach the ID proof.' });
      requestAnimationFrame(() => document.getElementById(`passengers-${i + 1}-name`)?.focus());
      return;
    }
    setRowNote(null);
    if (row && row.seq !== null && !f.dirty) {
      setProofFor(row.seq);
      return;
    }
    const known = view.travellers.map((t) => t.seq);
    const ok = await saveNow();
    if (!ok) {
      setRowNote({ key: d.key, text: 'The passengers were not saved, so the ID proof cannot be attached yet. The reason is shown above.' });
      return;
    }
    if (row && row.seq !== null) setProofFor(row.seq);
    else setProofWanted({ name, type: d.type, known });
  };

  const saved = new Map(view.travellers.map((t) => [t.seq, t]));
  const over = overCount(rows, counts);
  const named = { adult: 0, child: 0, infant: 0 } as Record<TravellerType, number>;
  for (const r of rows) if (isRealPassenger(r)) named[r.type] += 1;
  const proofsVisible = Boolean(view.idProofLimits);
  const proofMissing = proofsVisible
    ? view.travellers.filter((t) => t.type === 'adult' && t.idProofs !== undefined && !(t.idProofs ?? []).some((p) => p.status === 'stored')).map((t) => t.fullName || `Passenger ${t.seq}`)
    : [];
  const FORM = 'passengers-form';
  const openIndex = openKey !== null ? shown.findIndex((d) => d.key === openKey) : -1;
  const openRow = openIndex >= 0 ? shown[openIndex]! : null;
  const removeIndex = removeKey !== null ? shown.findIndex((d) => d.key === removeKey) : -1;
  const removing = removeIndex >= 0 ? shown[removeIndex]! : null;
  const proofTraveller: BookTravellerView | null = proofFor !== null ? (saved.get(proofFor) ?? null) : null;
  const realCount = rows.filter(isRealPassenger).length;
  const noCounts = shown.length === 0;
  return (
    <SectionCard id="passengers" title="Passengers" icon={Users} count={realCount}>
      <form id={FORM} ref={bindForm} onSubmit={submitter.onSubmit} noValidate aria-labelledby="passengers-heading">
        <HiddenDraftInputs view={view} base={f.base} result={f.state} extra={{ [TRAVELLER_SEQ_MAX_FIELD]: travellerSeqHighWater(view) }} />
        {/* Saved passengers removed on purpose (the server refuses a save that silently drops one). */}
        {removed.map((seq) => (
          <input key={seq} type="hidden" name={REMOVE_TRAVELLER_FIELD} value={seq} />
        ))}
        <div ref={bindResult} className="px-5 pt-4 max-sm:px-4 [&:has(>[role=status]:empty)]:hidden">
          <ResultBox result={refusal.shown} fields={refs} reloadHref={reloadHref} successText="Passengers saved." />
        </div>
        {detached.length > 0 ? (
          <div className="px-5 pt-4 max-sm:px-4">
            <Notice tone="warning" role="status">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {detached.map((d) => (
                  <li key={d.seq}>{ID_PROOF_TEXT.detachedOnRename.replace('{name}', d.fullName || `passenger ${d.seq}`)}</li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}
        {over.length > 0 ? (
          <div className="px-5 pt-4 max-sm:px-4">
            <Notice tone="warning" role="status" title="More passengers than the counts">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {over.map((o) => (
                  <li key={o.type}>
                    {plural(o.named, o.type)} named, but the booking has {o.booked}. Remove {o.named - o.booked === 1 ? 'one' : o.named - o.booked}, or change the counts above.
                  </li>
                ))}
              </ul>
              <p>Nobody is removed unless you choose.</p>
            </Notice>
          </div>
        ) : null}
        {noCounts ? (
          <EmptyInline text="Enter how many adults, children and infants travel. A row appears for each one." />
        ) : (
          <ol className="m-0 list-none p-0" aria-label="Passengers">
            {shown.map((d, i) => {
              const r = d.row;
              const nameId = `passengers-${i + 1}-name`;
              const err = nameErr(i);
              const t = r && r.seq !== null ? saved.get(r.seq) : undefined;
              const stored = (t?.idProofs ?? []).filter((p) => p.status === 'stored').length;
              const real = r !== null && isRealPassenger(r);
              const typeOver = over.some((o) => o.type === d.type);
              const who = r?.name.trim() || `passenger ${i + 1}`;
              const canProof = proofsVisible && editable && view.idProofCanEdit && (t === undefined || t.idProofs !== undefined);
              const note = rowNote?.key === d.key ? rowNote.text : null;
              return (
                <li key={d.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-line px-5 py-2.5 last:border-b-0 max-sm:px-3">
                  <span className="w-5 shrink-0 text-sm text-quiet tabular-nums" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="min-w-40 flex-1">
                    <Input
                      id={nameId}
                      name="travellerName"
                      aria-label={`Passenger ${i + 1} name (${TYPE_TEXT[d.type].toLowerCase()})`}
                      placeholder={`${TYPE_TEXT[d.type]} · full name`}
                      maxLength={120}
                      value={r?.name ?? ''}
                      invalid={Boolean(err)}
                      aria-describedby={fieldDescribedBy(nameId, { error: err ?? note })}
                      onChange={(e) => writeRow(d, { name: e.target.value })}
                      disabled={!editable}
                    />
                    {err || note ? (
                      <p id={`${nameId}-error`} role={note && !err ? 'alert' : undefined} className="m-0 mt-[0.25rem] text-sm font-medium text-status-danger">
                        {err ?? note}
                      </p>
                    ) : null}
                    {t && t.idProofs !== undefined ? (
                      <p className="m-0 mt-[0.25rem] inline-flex items-center gap-1 text-sm text-quiet">
                        {stored > 0 ? <CircleCheck aria-hidden="true" className="size-3.5 text-status-success" /> : d.type === 'adult' ? <CircleAlert aria-hidden="true" className="size-3.5 text-status-danger" /> : null}
                        {stored > 0 ? `ID proof: ${stored === 1 ? '1 file' : `${stored} files`}` : d.type === 'adult' ? 'ID proof needed' : 'No ID proof yet'}
                      </p>
                    ) : null}
                  </div>
                  <span className="w-12 shrink-0 text-sm text-quiet">{TYPE_TEXT[d.type]}</span>
                  {/* Parallel arrays: an empty slot posts an empty row (no type), which the server skips. */}
                  <input type="hidden" name="travellerType" value={real ? d.type : ''} />
                  <input type="hidden" name={TRAVELLER_SEQ_FIELD} value={r?.seq ?? ''} />
                  <input type="hidden" name="travellerAge" value={!r || d.type === 'adult' ? '' : r.age} />
                  <input type="hidden" name="travellerNeeds" value={r?.needs ?? ''} />
                  <input type="hidden" name="travellerRequests" value={(r?.requests ?? []).join(',')} />
                  <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
                    {canProof ? (
                      <Button id={`passengers-${i + 1}-idproof-open`} variant="secondary" size="sm" className="min-h-10" aria-label={`Attach ID proof for ${who}`} onClick={() => void attachProof(d, i)}>
                        <Paperclip aria-hidden="true" />
                        Attach ID proof
                      </Button>
                    ) : null}
                    <Button id={`passengers-${i + 1}-details`} variant="ghost" size="sm" className="min-h-10" aria-label={`Details for passenger ${i + 1}`} onClick={() => setOpenKey(d.key)}>
                      <MoreHorizontal aria-hidden="true" />
                      <span className="max-sm:hidden" aria-hidden="true">
                        Details
                      </span>
                    </Button>
                    {editable && real ? (
                      <Button variant="ghost" size="sm" className={typeOver ? 'min-h-10' : 'min-h-10 max-sm:hidden'} aria-label={`Remove ${who}`} onClick={() => setRemoveKey(d.key)}>
                        <Trash2 aria-hidden="true" />
                      </Button>
                    ) : editable ? (
                      <span className="w-9 max-sm:hidden" aria-hidden="true" />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {!noCounts ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-5 py-3 text-sm text-quiet max-sm:px-4">
            <span>
              Named: {plural(named.adult, 'adult')} · {plural(named.child, 'child')} · {plural(named.infant, 'infant')}
            </span>
            {proofMissing.length > 0 ? <span>ID proof still needed: {proofMissing.join(', ')}</span> : null}
          </div>
        ) : null}
        <div className="px-5 pb-4 max-sm:px-4 empty:hidden">
          <SectionSaveRow label="Save passengers" dirty={f.dirty} editable={editable} pending={submitter.pending} />
        </div>
      </form>
      {openRow ? (
        <PassengerDrawer
          key={openRow.key}
          view={view}
          rowNo={openIndex + 1}
          row={openRow.row ?? { seq: null, name: '', type: openRow.type, age: '', needs: '', requests: [] }}
          traveller={openRow.row && openRow.row.seq !== null ? (saved.get(openRow.row.seq) ?? null) : null}
          editable={editable}
          actions={actions}
          reloadHref={reloadHref}
          passengersResult={f.state}
          passengerRefs={refs}
          onSave={(row) => saveFromDrawer(openRow, row)}
          onClose={() => {
            const back = `passengers-${openIndex + 1}-details`;
            setOpenKey(null);
            requestAnimationFrame(() => document.getElementById(back)?.focus());
          }}
          onRemove={
            openRow.row && isRealPassenger(openRow.row)
              ? () => {
                  setRemoveKey(openRow.key);
                  setOpenKey(null);
                }
              : undefined
          }
        />
      ) : null}
      {proofTraveller ? (
        <IdProofDialog
          view={view}
          traveller={proofTraveller}
          rowNo={Math.max(1, shown.findIndex((d) => d.row?.seq === proofTraveller.seq) + 1)}
          actions={actions}
          onClose={() => {
            const at = shown.findIndex((d) => d.row?.seq === proofTraveller.seq);
            setProofFor(null);
            requestAnimationFrame(() => document.getElementById(`passengers-${at + 1}-idproof-open`)?.focus());
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoveKey(null);
        }}
        title={`Remove ${removing?.row?.name.trim() || `passenger ${removeIndex + 1}`} from this booking?`}
        description="The passenger is removed when you save the passengers. Their ID proof files go with them."
        confirmLabel="Remove passenger"
        cancelLabel="Keep passenger"
        onConfirm={() => {
          const at = removing?.stateIndex;
          const seq = removing?.row?.seq ?? null;
          if (at !== null && at !== undefined) f.setValues((s) => ({ travellers: s.travellers.filter((_, j) => j !== at), removed: seq !== null ? [...s.removed, seq] : s.removed }));
          setRemoveKey(null);
        }}
      />
    </SectionCard>
  );
}
