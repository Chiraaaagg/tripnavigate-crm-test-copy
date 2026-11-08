'use client';

import { CircleAlert, CircleCheck, Clock, Check, MoreHorizontal, Paperclip, Trash2, TriangleAlert, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { fieldDescribedBy } from '@/components/ui/field';
import { SaveStatus } from '@/components/ui/save-status';
import { ID_PROOF_TEXT, type BookTravellerView, type TravellerType } from '@/modules/fulfilment/contracts';
import { TRAVELLER_SEQ_FIELD, TRAVELLER_SEQ_MAX_FIELD } from '@/modules/fulfilment/b11-forms';
import { guard } from '../booking-forms';
import { idProofsDetachedByRename, travellerSeqHighWater } from '../b11/book-fields';
import { useSectionForm } from '../b11/draft-sync';
import { normaliseResult, type FieldRef, type UiResult } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { refusalReason, useAutosave, useSaveQueue } from './autosave-queue';
import { ConfirmDialog } from './confirm-dialog';
import { HiddenDraftInputs, editableOf, useShownRefusal } from './form-helpers';
import { useFormToast } from './form-toast';
import { IdProofDialog } from './id-proof-dialog';
import { PassengerDrawer, type PassengerRow } from './passenger-drawer';
import { displayRows, isRealPassenger, overCount, REMOVE_TRAVELLER_FIELD, type DisplayRow, type PartyCountsTyped } from './passenger-display';
import { CountPill, SectionCard } from './parts';

export { displayRows, isRealPassenger, overCount, type DisplayRow, type PartyCountsTyped };

/*
 * Step 1 · Passengers (Book now v2, owner-approved prototype paxCard). One
 * row per counted traveller (adults, then children, then infants), "N of M
 * named" and the save pill in the header. The rows save themselves (owner
 * answer 2): an empty slot is never saved, so a named row is stored as soon as
 * it is typed (an unnamed slot is listed under "Before you submit"). Each row
 * has "Attach ID proof" (private, with the customer's consent) and the
 * Details drawer. The footer names the adults still without ID proof and,
 * when the counts come from Bitrix, offers "Need another traveller?".
 * Lowering a count never removes a named or saved passenger: the card says
 * which type is over the count, and those rows keep a Remove button.
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
  actions,
  counts,
  countsLocked,
  onRows,
  onMorePax,
  copyApplies,
}: {
  view: BookNowView;
  reloadHref?: string;
  actions: PassengerActions;
  /** The adult, child and infant counts of step 1 (the slots follow them). */
  counts: PartyCountsTyped;
  /** The counts come from the Bitrix Deal: offer "Need another traveller?". */
  countsLocked: boolean;
  /** Passenger rows on screen (step 1 checks use what is on screen). Empty slots are left out. */
  onRows?: (rows: PassengerRow[], slots: number, firstBlank: number | null) => void;
  onMorePax: () => void;
  /** The ID-proof copy to the Bitrix Deal applies (BookingFormCore.idProofCopyApplies; lead ruling D5). */
  copyApplies: boolean;
}) {
  const editable = editableOf(view);
  const toast = useFormToast();
  const queue = useSaveQueue();
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
    saveable: false,
    tracksDirty: true,
    onSuccess: () => {
      setDetached([]);
      setRenameBase({ travellers: view.travellers });
    },
  });
  const rows = f.values.travellers;
  const shown = displayRows(rows, counts);
  // The first row without a name, by its position on screen (1-based).
  const blankAt = shown.findIndex((d) => !d.row?.name.trim());
  const firstBlank = blankAt >= 0 ? blankAt + 1 : null;
  useEffect(() => {
    onRows?.(rows.filter(isRealPassenger), shown.length, firstBlank);
  }, [rows, onRows, shown.length, firstBlank]);
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
    { field: `travellerNeeds[${i}]`, id: `passengers-${i + 1}-details`, label: `Passenger ${i + 1}: other requirements up to 500 characters (in Details).` },
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

  const formRef = useRef<HTMLFormElement | null>(null);
  const bindForm = f.bindForm;
  const setForm = useCallback(
    (el: HTMLFormElement | null) => {
      formRef.current = el;
      bindForm(el);
    },
    [bindForm],
  );
  const sendNow = useCallback((): Promise<UiResult> => (formRef.current ? f.post(new FormData(formRef.current)) : Promise.resolve({ ok: false, code: 'unexpected', message: '' } as UiResult)), [f]);
  const over = overCount(rows, counts);
  const save = useAutosave({
    key: 'passengers',
    values: f.values,
    dirty: f.dirty,
    enabled: editable,
    hasStored: view.travellers.length > 0,
    check: () => overCount(f.values.travellers, countsRef.current).map((o) => `${plural(o.named, o.type)} named, but the booking has ${o.booked}. Remove ${o.named - o.booked === 1 ? 'one' : o.named - o.booked}, or change the counts above.`),
    send: sendNow,
    refs,
  });

  // A save started by the drawer or by "Attach ID proof" runs after the edited row is on screen.
  const pendingSave = useRef<null | ((ok: boolean) => void)>(null);
  const [saveTick, setSaveTick] = useState(0);
  useEffect(() => {
    if (saveTick === 0 || !pendingSave.current) return;
    const done = pendingSave.current;
    pendingSave.current = null;
    void queue.run(sendNow).then((r) => done(r.ok));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per requested save, after the row is committed
  }, [saveTick]);
  const saveNow = () =>
    new Promise<boolean>((resolve) => {
      pendingSave.current = resolve;
      setSaveTick((n) => n + 1);
    });

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [proofFor, setProofFor] = useState<number | null>(null);
  const [rowNote, setRowNote] = useState<{ key: string; text: string } | null>(null);
  const [proofWanted, setProofWanted] = useState<{ name: string; type: TravellerType; known: number[] } | null>(null);

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

  const attachProof = async (d: DisplayRow) => {
    const row = d.row;
    const name = row?.name.trim() ?? '';
    if (!name) {
      toast('Enter the name first, then attach the ID proof.');
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
      setRowNote({ key: d.key, text: 'The passengers were not saved, so the ID proof cannot be attached yet. The reason is shown under the card.' });
      return;
    }
    if (row && row.seq !== null) setProofFor(row.seq);
    else setProofWanted({ name, type: d.type, known });
  };

  const saved = new Map(view.travellers.map((t) => [t.seq, t]));
  const proofsVisible = Boolean(view.idProofLimits);
  const named = shown.filter((d) => d.row && d.row.name.trim()).length;
  const needId = shown.filter((d) => d.type === 'adult' && proofsVisible && !((d.row?.seq != null ? saved.get(d.row.seq)?.idProofs : undefined) ?? []).some((p) => p.status === 'stored'));
  const openIndex = openKey !== null ? shown.findIndex((d) => d.key === openKey) : -1;
  const openRow = openIndex >= 0 ? shown[openIndex]! : null;
  const removeIndex = removeKey !== null ? shown.findIndex((d) => d.key === removeKey) : -1;
  const removing = removeIndex >= 0 ? shown[removeIndex]! : null;
  const proofTraveller: BookTravellerView | null = proofFor !== null ? (saved.get(proofFor) ?? null) : null;
  const noCounts = counts.adults === null;
  const reason = save.state === 'fix' ? save.reason : null;
  // Named rows save at once; the pill is honest ("Saved") and a warning names the travellers still unnamed.
  const unnamedCount = shown.filter((d) => !d.row?.name.trim()).length;
  // A type over its count: the rows past the count keep a Remove button (lead ruling).
  const overTypes = new Set(over.map((o) => o.type));
  const posOverCount = (d: DisplayRow) => overTypes.has(d.type) && d.pos >= ((d.type === 'adult' ? counts.adults : d.type === 'child' ? counts.children : counts.infants) ?? 0);

  if (noCounts) {
    return (
      <SectionCard id="passengers" title="Passengers" icon={Users}>
        <p className="m-0 p-5 text-quiet max-sm:p-4">Set how many adults, children and infants travel. A row appears for each one.</p>
      </SectionCard>
    );
  }
  return (
    <SectionCard
      id="passengers"
      title={
        <>
          Passengers <CountPill n={shown.length} noun={['passenger', 'passengers']} />
        </>
      }
      icon={Users}
      action={
        <span className="flex flex-wrap items-center gap-2.5">
          <span id="bf-pax-named" className="text-sm text-quiet" aria-live="polite">
            {named} of {shown.length} named
          </span>
          <SaveStatus id="pill-passengers" state={save.state} reason={save.reason} label="Passengers" />
        </span>
      }
    >
      <form id="passengers-form" ref={setForm} onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="passengers-heading">
        <HiddenDraftInputs view={view} base={f.base} result={f.state} extra={{ [TRAVELLER_SEQ_MAX_FIELD]: travellerSeqHighWater(view) }} />
        {removed.map((seq) => (
          <input key={seq} type="hidden" name={REMOVE_TRAVELLER_FIELD} value={seq} />
        ))}
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
        <ol className="m-0 list-none p-0" aria-label="Passengers">
          {shown.map((d, i) => {
            const r = d.row;
            const nameId = `passengers-${i + 1}-name`;
            const err = nameErr(i);
            const t = r && r.seq !== null ? saved.get(r.seq) : undefined;
            const storedProofs = (t?.idProofs ?? []).filter((p) => p.status === 'stored');
            const real = r !== null && isRealPassenger(r);
            const who = r?.name.trim() || `passenger ${i + 1}`;
            const canProof = proofsVisible && editable && view.idProofCanEdit && (t === undefined || t.idProofs !== undefined);
            const note = rowNote?.key === d.key ? rowNote.text : null;
            const hasName = Boolean(r?.name.trim());
            return (
              <li key={d.key} className="grid grid-cols-[1.5rem_minmax(0,1fr)_4rem_auto] items-center gap-3 border-b border-line px-5 py-3 last:border-b-0 max-sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] max-sm:px-4">
                <span className="text-xs text-quiet tabular-nums" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <Input
                    id={nameId}
                    name="travellerName"
                    aria-label={`Passenger ${i + 1} full name`}
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
                  {proofsVisible ? (
                    <p className="m-0 mt-[0.25rem] flex flex-wrap items-center gap-1 text-xs">
                      {storedProofs.length > 0 ? (
                        <>
                          <CircleCheck aria-hidden="true" className="size-3.25 text-status-success" />
                          <span>ID proof: {storedProofs.length === 1 ? '1 file' : `${storedProofs.length} files`}</span> <CopyState proofs={storedProofs} dealId={view.dealId} retry={actions.retryIdProofCopy} />
                        </>
                      ) : d.type === 'adult' ? (
                        <>
                          <CircleAlert aria-hidden="true" className="size-3.25 text-status-danger" />
                          <span className="text-status-danger">ID proof needed</span>
                        </>
                      ) : (
                        <span className="text-quiet">No ID proof yet</span>
                      )}
                    </p>
                  ) : null}
                </div>
                <span className="text-sm text-quiet max-sm:hidden">{TYPE_TEXT[d.type]}</span>
                <input type="hidden" name="travellerType" value={real ? d.type : ''} />
                <input type="hidden" name={TRAVELLER_SEQ_FIELD} value={r?.seq ?? ''} />
                <input type="hidden" name="travellerAge" value={!r || d.type === 'adult' ? '' : r.age} />
                <input type="hidden" name="travellerNeeds" value={r?.needs ?? ''} />
                <input type="hidden" name="travellerRequests" value={(r?.requests ?? []).join(',')} />
                <div className="flex items-center gap-1">
                  {canProof ? (
                    <Button
                      id={`passengers-${i + 1}-idproof-open`}
                      variant="secondary"
                      size="sm"
                      aria-label={`Attach ID proof for ${who}`}
                      aria-disabled={hasName ? undefined : true}
                      title={hasName ? undefined : 'Enter the name first'}
                      onClick={() => void attachProof(d)}
                    >
                      <Paperclip aria-hidden="true" />
                      Attach ID proof
                    </Button>
                  ) : null}
                  <Button id={`passengers-${i + 1}-details`} variant="ghost" size="sm" aria-label={`Details for passenger ${i + 1}`} onClick={() => setOpenKey(d.key)}>
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                  {editable && real && posOverCount(d) ? (
                    <Button variant="ghost" size="sm" aria-label={`Remove ${who}`} onClick={() => setRemoveKey(d.key)}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap justify-between gap-2.5 border-t border-line px-5 py-3 text-sm text-quiet max-sm:px-4">
          <span>{proofsVisible ? (needId.length > 0 ? `ID proof still needed: ${needId.map((d) => d.row?.name.trim() || 'unnamed adult').join(', ')}` : 'All adults have ID proof.') : null}</span>
          {countsLocked && editable ? (
            <Button variant="link" onClick={onMorePax}>
              Need another traveller?
            </Button>
          ) : null}
        </div>
        {!reason && editable && unnamedCount > 0 && (save.state === 'saved' || save.state === 'idle') && view.travellers.length > 0 ? (
          <p id="warn-passengers" className="m-0 flex items-start gap-1.5 px-5 pb-3 text-sm font-medium text-status-warning max-sm:px-4">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {unnamedCount === 1 ? '1 traveller' : `${unnamedCount} travellers`} not named yet
            </span>
          </p>
        ) : null}
        {reason ? (
          <p id="why-passengers" className="m-0 flex items-start gap-1.5 px-5 pb-3 text-sm font-medium text-status-danger max-sm:px-4">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{reason}</span>
          </p>
        ) : null}
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
          passengersResult={f.state}
          passengerRefs={refs}
          onSave={(row) => {
            writeRow(openRow, row);
            return saveNow();
          }}
          onClose={() => {
            const back = `passengers-${openIndex + 1}-details`;
            setOpenKey(null);
            requestAnimationFrame(() => document.getElementById(back)?.focus());
          }}
        />
      ) : null}
      {proofTraveller ? (
        <IdProofDialog
          view={view}
          traveller={proofTraveller}
          actions={actions}
          copiesToBitrix={copyApplies}
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
        description="The passenger is removed from this booking draft. Their ID proof files go with them."
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

/** Change 10: where the newest proof's copy to the Bitrix Deal stands, in words. */
function CopyState({ proofs, dealId, retry }: { proofs: NonNullable<BookTravellerView['idProofs']>; dealId: string; retry?: B11Action }) {
  const queue = useSaveQueue();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const copy = [...proofs].reverse().find((p) => p.bitrixCopy)?.bitrixCopy;
  if (!copy || copy.status === 'cancelled') return null;
  if (copy.status === 'pending' || copy.status === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-quiet">
        <Clock aria-hidden="true" className="size-3.25" />
        Copying to Bitrix…
      </span>
    );
  }
  if (copy.status === 'sent') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-status-success">
        <Check aria-hidden="true" className="size-3.25" />
        Copied to the Bitrix Deal
      </span>
    );
  }
  const doRetry = async () => {
    if (!retry || busy) return;
    setBusy(true);
    const fd = new FormData();
    fd.set('dealId', dealId);
    fd.set('copyJobId', copy.jobId);
    const r = await queue.run(async () => normaliseResult(await guard(retry as never)(null, fd)) as UiResult);
    setBusy(false);
    setProblem(r.ok ? null : refusalReason(r));
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-medium text-status-danger">
      <CircleAlert aria-hidden="true" className="size-3.25" />
      Copy to Bitrix failed
      {copy.canRetry && retry ? (
        <>
          {' · '}
          <Button variant="link" size="sm" className={cn('text-xs')} loading={busy} onClick={() => void doRetry()}>
            Retry
          </Button>
        </>
      ) : null}
      {problem ? <span role="alert">{problem}</span> : null}
    </span>
  );
}
