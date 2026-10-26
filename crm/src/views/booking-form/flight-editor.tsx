'use client';

import { CircleAlert, CornerDownRight, Image as ImageIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AirportCombobox } from '@/components/ui/airport-combobox';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SuggestMultiSelect, type SuggestItem } from '@/components/ui/suggest-multiselect';
import {
  FLIGHT_PREFERENCE_SUGGESTIONS,
  REQUEST_ITEMS_MAX,
  REQUEST_TEXT_MAX,
  SERVICE_ITEM_FILE_MAX_BYTES,
  SERVICE_ITEM_FILES_PER_ITEM,
  type FlightEntryMode,
  type FlightEstimate,
} from '@/modules/fulfilment/booking-form-contract';
import { isIsoDate, paiseToRupeesText, requestItemsFromStored, rupeesToPaise } from '@/modules/fulfilment/booking-form-model';
import { guard } from '../booking-forms';
import { SelectField, TextField } from '../b11/controls';
import { newRequestId, normaliseResult, type UiResult } from '../b11/form-kit';
import { refusalReason, useSaveQueue } from './autosave-queue';
import { useFormToast } from './form-toast';
import { appendParticipants, appendRequests, EditorShell, initialWho, useLiveProblem, WhoChips, type EditorEnv } from './service-editor';
import { FARE_LABEL, fareTypes, legsOf, requestFormFields, str, toSuggestItems, type FareKey } from './service-model';

/*
 * Flight drawer (Book now v2, changes 3, 7, 17, 18 and 19). It starts with a
 * switch: "Type the details" or "Attach a screenshot". Typed: airport search
 * for From and To (the code is stored), dates, airline, number, local times
 * and cabin. Screenshot: one to five files of the chosen flight or fare quote
 * and a note for the Flight team; the typed fields hide. Both keep the fare
 * per person (Adult, plus Child and Infant only when step 1 has them; our
 * cost, not the customer price), the preferences with "for everyone / for
 * <name>", and the passengers flying. The files upload in the same step as
 * the save, one request each; if one fails the drawer stays open on the
 * saved flight and names it. A flight saved before this release with more
 * than one leg keeps legs 2 and on as saved (lead ruling D7).
 */

const OPTIONS = FLIGHT_PREFERENCE_SUGGESTIONS.map((s) => ({ value: s, label: s }));
const CABINS = [
  { value: '', label: 'No preference' },
  { value: 'Economy', label: 'Economy' },
  { value: 'Premium economy', label: 'Premium economy' },
  { value: 'Business', label: 'Business' },
  { value: 'First', label: 'First' },
];
const FILE_TYPE = /\.(pdf|jpe?g|png|webp)$/i;
const FARE_FORM: Record<FareKey, string> = { adult: 'fareAdultRupees', child: 'fareChildRupees', infant: 'fareInfantRupees' };

/** "Add next flight" / "Add return flights" start values (absent = a plain new flight). */
export interface FlightEditorStart {
  from?: string;
  date?: string;
  airline?: string;
  cabin?: string;
  who?: string[];
  isReturn?: boolean;
  mode?: FlightEntryMode;
  banner?: string;
}

async function call(action: EditorEnv['fileActions']['upload'], fd: FormData): Promise<UiResult> {
  return normaliseResult(await guard(action as never)(null, fd)) as UiResult;
}

export function FlightEditor({ env, start }: { env: EditorEnv; start: FlightEditorStart | null }) {
  const router = useRouter();
  const queue = useSaveQueue();
  const toast = useFormToast();
  const src = env.item ?? env.copyOf;
  const f = src?.facts ?? null;
  const legs = legsOf(f);
  const first = legs[0];
  const extraLegs = Array.isArray(f?.segments) ? (f!.segments as Array<Record<string, unknown>>).slice(1) : [];
  // Older free text that cannot become preferences stays as it is (read-only, not posted).
  const storedPrefs = requestItemsFromStored({ requestItems: f?.requestItems, text: f?.preferences });
  const est = src?.estimate?.estimate?.kind === 'flight' ? (src.estimate.estimate as FlightEstimate) : null;
  const [v, setV] = useState(() => ({
    mode: (str(f?.entryMode) === 'screenshot' ? 'screenshot' : (start?.mode ?? 'typed')) as FlightEntryMode,
    from: first?.from ?? start?.from ?? '',
    to: first?.to ?? '',
    date: first?.date ?? start?.date ?? (src ? '' : env.trip.start),
    adate: first?.arrivalDate ?? '',
    airline: str((f?.segments as Array<Record<string, unknown>> | undefined)?.[0]?.airline) || (start?.airline ?? ''),
    no: first?.flightNo ?? '',
    dep: first?.departTime ?? '',
    arr: first?.arriveTime ?? '',
    cabin: src ? str(f?.cabin) : (start?.cabin ?? 'Economy'),
    fare: { adult: paiseToRupeesText(est?.fareAdultPaise ?? null), child: paiseToRupeesText(est?.fareChildPaise ?? null), infant: paiseToRupeesText(est?.fareInfantPaise ?? null) } as Record<FareKey, string>,
    prefs: toSuggestItems(storedPrefs ?? []) as SuggestItem[],
    who: start?.who ?? initialWho(env, 'flight'),
    note: str(f?.screenshotNote),
    isReturn: f ? f.isReturn === true : (start?.isReturn ?? false),
  }));
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const [busy, setBusy] = useState(false);
  const [savedItemId, setSavedItemId] = useState<string | null>(env.item?.itemId ?? null);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const stored = (env.item?.files ?? []).filter((x) => !removeIds.includes(x.fileId));
  const fileCount = stored.length + newFiles.length;
  const shot = v.mode === 'screenshot';
  const types = fareTypes(env.party);
  const live = useLiveProblem(() => {
    if (shot) return fileCount === 0 ? 'Attach at least one screenshot, or choose “Type the details”.' : v.who.length === 0 ? 'Choose who flies.' : '';
    if (!v.from) return 'Pick the departure airport from the list.';
    if (!v.to) return 'Pick the arrival airport from the list.';
    if (v.from === v.to) return 'Departure and arrival airports must differ.';
    if (!isIsoDate(v.date)) return 'Add the departure date.';
    if (v.adate && v.adate < v.date) return 'Arrival date cannot be before departure.';
    if (v.who.length === 0) return 'Choose who flies.';
    if (types.some((k) => v.fare[k].trim() !== '' && rupeesToPaise(v.fare[k]) === undefined)) return 'Enter the fare in rupees, with at most two decimal places.';
    return '';
  });

  const chooseFiles = (list: FileList | null) => {
    setFileProblem(null);
    const add: File[] = [];
    for (const x of Array.from(list ?? [])) {
      const bad = x.size > SERVICE_ITEM_FILE_MAX_BYTES ? `${x.name} is over 4 MB. It was not added.` : !FILE_TYPE.test(x.name) ? `${x.name}: use a PDF, JPG, PNG or WebP file.` : stored.length + newFiles.length + add.length >= SERVICE_ITEM_FILES_PER_ITEM ? 'A flight can have at most 5 screenshots. Remove one first.' : '';
      if (bad) setFileProblem(bad);
      else add.push(x);
    }
    setNewFiles((n) => [...n, ...add]);
    setInputKey((k) => k + 1);
  };

  const save = async () => {
    if (!live.gate()) return;
    setBusy(true);
    try {
      const r = await env.save((fd) => {
        if (savedItemId) fd.set('itemId', savedItemId);
        fd.set('entryMode', v.mode);
        fd.set('isReturn', v.isReturn ? '1' : '');
        // Trip type is no longer asked; it is posted only when the flight has one stored.
        if (str(f?.tripType)) fd.set('tripType', str(f?.tripType));
        fd.set('passengers', String(v.who.length));
        if (shot) {
          fd.set('screenshotNote', v.note.trim());
        } else {
          fd.set('cabin', v.cabin);
          fd.append('segmentFrom', v.from);
          fd.append('segmentTo', v.to);
          fd.append('segmentDate', v.date);
          fd.append('segmentFlex', str((f?.segments as Array<Record<string, unknown>> | undefined)?.[0]?.flex));
          fd.append('segmentArrivalDate', v.adate);
          fd.append('segmentAirline', v.airline.trim());
          fd.append('segmentFlightNo', v.no.trim());
          fd.append('segmentDepartTime', v.dep);
          fd.append('segmentArriveTime', v.arr);
          // D7: further legs of an older flight stay as saved.
          for (const g of extraLegs) {
            fd.append('segmentFrom', str(g.from));
            fd.append('segmentTo', str(g.to));
            fd.append('segmentDate', str(g.date));
            fd.append('segmentFlex', str(g.flex));
            fd.append('segmentArrivalDate', str(g.arrivalDate));
            fd.append('segmentAirline', str(g.airline));
            fd.append('segmentFlightNo', str(g.flightNo));
            fd.append('segmentDepartTime', str(g.departTime));
            fd.append('segmentArriveTime', str(g.arriveTime));
          }
        }
        if (env.estimatesVisible) for (const k of types) fd.set(FARE_FORM[k], v.fare[k].trim());
        appendParticipants(fd, v.who);
        if (storedPrefs !== null) {
          fd.set('requestItemsPosted', '1');
          appendRequests(fd, requestFormFields(v.prefs, v.who));
        }
      }, { ...v, files: newFiles.map((x) => x.name), removeIds });
      if (!r.ok) {
        live.setServer(refusalReason(r));
        return;
      }
      const itemId = savedItemId ?? (r as { data?: { itemId?: unknown } }).data?.itemId;
      if (typeof itemId !== 'string') {
        toast('Flight saved.');
        env.onClose();
        return;
      }
      setSavedItemId(itemId);
      if (!env.item) env.bind(itemId);
      // Files in the same step as the save, one request each (the request body limit is near 4.5 MB).
      const failed: string[] = [];
      for (const fileId of removeIds) {
        const file = (env.item?.files ?? []).find((x) => x.fileId === fileId);
        const fd = new FormData();
        fd.set('dealId', env.view.dealId);
        fd.set('fileId', fileId);
        if (file?.rowVersion !== undefined) fd.set('fileRowVersion', String(file.rowVersion));
        const rr = await queue.run(() => call(env.fileActions.remove, fd));
        if (!rr.ok) failed.push(`${file?.fileName ?? 'A screenshot'} was not removed: ${refusalReason(rr)}`);
      }
      const left: File[] = [];
      for (const file of newFiles) {
        const fd = new FormData();
        fd.set('dealId', env.view.dealId);
        fd.set('versionId', env.view.version?.versionId ?? '');
        fd.set('itemId', itemId);
        fd.set('kind', 'flight_screenshot');
        fd.set('requestId', newRequestId());
        fd.set('file', file);
        const rr = await queue.run(() => call(env.fileActions.upload, fd));
        if (!rr.ok) {
          failed.push(`${file.name} was not attached: ${refusalReason(rr)}`);
          left.push(file);
        }
      }
      setRemoveIds([]);
      setNewFiles(left);
      router.refresh();
      if (failed.length > 0) {
        live.setServer(`The flight is saved. ${failed.join(' ')} Try again or remove the file.`);
        return;
      }
      toast('Flight saved.');
      env.onClose();
    } finally {
      setBusy(false);
    }
  };

  const isNew = !env.item;
  return (
    <EditorShell title={isNew ? 'Add flight' : 'Edit flight'} description="Requested flight, not an issued ticket." saveLabel="Save flight" editable={env.editable} busy={busy} problem={live.problem} onSave={save} onClose={env.onClose}>
      {env.copyOf && str(env.copyOf.facts.entryMode) === 'screenshot' ? (
        <div className="flex gap-2.5 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-sm text-copy">
          <ImageIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
          <p className="m-0">Copy of a screenshot flight. Screenshots are not copied: attach them again before you save.</p>
        </div>
      ) : null}
      {start?.banner ? (
        <div className="flex gap-2.5 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-sm text-copy">
          <CornerDownRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
          <p className="m-0">{start.banner}</p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span id="svc-entryMode-label" className="font-semibold text-ink">
          How do you want to add it?
        </span>
        <SegmentedControl<FlightEntryMode>
          id="svc-entryMode"
          labelledBy="svc-entryMode-label"
          options={[
            { value: 'typed', label: 'Type the details' },
            { value: 'screenshot', label: 'Attach a screenshot' },
          ]}
          value={v.mode}
          onChange={(m) => set('mode', m)}
          disabled={!env.editable}
          className="self-start"
        />
      </div>
      {shot ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2.5 rounded-control border border-dashed border-control bg-canvas p-3.5">
            <label htmlFor="svc-screenshot" className="font-semibold text-ink">
              Flight screenshot
            </label>
            <p className="-mt-1.5 m-0 text-sm text-quiet">A screenshot of the chosen flight or fare quote is enough. The Flight team books from it, so you do not type the details.</p>
            {stored.length + newFiles.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Flight screenshots">
                {stored.map((x) => (
                  <li key={x.fileId} className="flex items-center justify-between gap-2.5 rounded-chip border border-line bg-card px-2.5 py-2 text-sm">
                    <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
                      <ImageIcon aria-hidden="true" className="size-4 shrink-0" />
                      <a href={x.downloadHref} className={cn('text-copy underline-offset-4 hover:underline', focusRing)}>
                        {x.fileName}
                      </a>
                    </span>
                    {env.editable && env.filesEditable && x.canRemove ? (
                      <Button variant="link" size="sm" onClick={() => setRemoveIds((ids) => [...ids, x.fileId])}>
                        Remove<span className="sr-only"> {x.fileName}</span>
                      </Button>
                    ) : null}
                  </li>
                ))}
                {newFiles.map((x, i) => (
                  <li key={`${x.name}-${i}`} className="flex items-center justify-between gap-2.5 rounded-chip border border-line bg-card px-2.5 py-2 text-sm">
                    <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
                      <ImageIcon aria-hidden="true" className="size-4 shrink-0" />
                      {x.name}
                      <span className="text-quiet">(attached when you save)</span>
                    </span>
                    <Button variant="link" size="sm" onClick={() => setNewFiles((n) => n.filter((_, j) => j !== i))}>
                      Remove<span className="sr-only"> {x.name}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {env.editable && env.filesEditable ? (
              <input
                key={inputKey}
                id="svc-screenshot"
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                aria-describedby="svc-screenshot-hint"
                onChange={(e) => chooseFiles(e.target.files)}
                className={cn('block w-full text-base text-ink file:mr-3 file:cursor-pointer file:rounded-control file:border file:border-line-strong file:bg-card file:px-3 file:py-1.5 file:font-semibold file:text-ink', focusRing)}
              />
            ) : null}
            <p id="svc-screenshot-hint" className="m-0 text-sm text-quiet">
              PDF, JPG, PNG or WebP, up to 4 MB each, up to 5 files. Opened only by Sales on this deal, the branch Manager and the Flight colleague on this task.
            </p>
            {fileProblem ? (
              <p role="alert" className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {fileProblem}
              </p>
            ) : null}
          </div>
          <Field htmlFor="svc-screenshotNote" label="Note for the Flight team" optional>
            <Input id="svc-screenshotNote" value={v.note} onChange={(e) => set('note', e.target.value)} maxLength={200} placeholder="For example: book the 08:00 IndiGo option" disabled={!env.editable} />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
            <AirportCombobox id="ap-from" label="From" value={v.from} onChange={(x) => set('from', x)} disabled={!env.editable} />
            <AirportCombobox id="ap-to" label="To" value={v.to} onChange={(x) => set('to', x)} disabled={!env.editable} />
          </div>
          <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
            <TextField id="svc-seg-1-date" name="segmentDate" label="Departure date" type="date" value={v.date} onChange={(x) => set('date', x)} disabled={!env.editable} />
            <TextField id="svc-seg-1-arrivalDate" name="segmentArrivalDate" label={<>Arrival date <span className="font-normal text-quiet">(optional, if next day)</span></>} type="date" min={v.date || undefined} value={v.adate} onChange={(x) => set('adate', x)} disabled={!env.editable} />
            <TextField id="svc-seg-1-airline" name="segmentAirline" label="Airline" optional value={v.airline} onChange={(x) => set('airline', x)} maxLength={60} disabled={!env.editable} />
            <TextField id="svc-seg-1-flightNo" name="segmentFlightNo" label="Flight number" optional value={v.no} onChange={(x) => set('no', x)} maxLength={12} disabled={!env.editable} />
            <TextField id="svc-seg-1-departTime" name="segmentDepartTime" label="Departure time (local)" type="time" optional value={v.dep} onChange={(x) => set('dep', x)} disabled={!env.editable} />
            <TextField id="svc-seg-1-arriveTime" name="segmentArriveTime" label="Arrival time (local)" type="time" optional value={v.arr} onChange={(x) => set('arr', x)} disabled={!env.editable} />
            <SelectField id="svc-cabin" name="cabin" label="Cabin" value={v.cabin} onChange={(x) => set('cabin', x)} options={[...CABINS, ...(v.cabin && !CABINS.some((c) => c.value === v.cabin) ? [{ value: v.cabin, label: v.cabin }] : [])]} disabled={!env.editable} />
          </div>
          {extraLegs.length > 0 ? <p className="m-0 text-sm text-quiet">This flight has {extraLegs.length + 1} legs; legs 2–{extraLegs.length + 1} stay as saved.</p> : null}
        </div>
      )}
      {env.estimatesVisible ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-semibold text-ink">
            Fare per person <span className="font-normal text-quiet">(optional)</span>
          </span>
          <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2 sm:grid-cols-3">
            {types.map((k) => (
              <div key={k} className="flex flex-col gap-1.5">
                <label htmlFor={`svc-fare-${k}`} className="font-medium text-ink">
                  {FARE_LABEL[k]}
                </label>
                <MoneyInput id={`svc-fare-${k}`} value={v.fare[k]} onChange={(e) => set('fare', { ...v.fare, [k]: e.target.value })} aria-describedby="svc-fare-hint" disabled={!env.editable} />
              </div>
            ))}
          </div>
          <p id="svc-fare-hint" className="m-0 text-sm text-quiet">
            Our cost estimate, not the customer price. One ticket covering several flights? Leave this blank and type the total under the flights list.
          </p>
        </div>
      ) : null}
      {storedPrefs === null ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-semibold text-ink">Baggage, seat or meal preferences</span>
          <p className="m-0 rounded-control bg-wash px-3 py-2.5 text-sm text-copy">{str(f?.preferences)}</p>
          <p className="m-0 text-sm text-quiet">Saved before as free text, so it stays as it is.</p>
        </div>
      ) : (
      <SuggestMultiSelect
        id="svc-flight-prefs"
        label="Baggage, seat or meal preferences"
        hint="Choose from the list or type your own and press Enter. Change “for everyone” to pick one person."
        options={OPTIONS}
        items={v.prefs}
        onChange={(x) => set('prefs', x)}
        people={env.people.filter((x) => v.who.includes(x.value))}
        maxItems={REQUEST_ITEMS_MAX}
        maxLength={REQUEST_TEXT_MAX}
        disabled={!env.editable}
      />
      )}
      <WhoChips env={env} label="Passengers flying" value={v.who} onChange={(x) => set('who', x)} />
      <p className="m-0 text-sm text-quiet">Flight reads this. PNR and tickets are added later by the Flight team. Do not type the customer price.</p>
    </EditorShell>
  );
}

