'use client';

import { CircleCheck, Download, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Fieldset } from '@/components/ui/fieldset';
import { Input } from '@/components/ui/input';
import {
  DIFFERENCE_CHOICE_LABEL,
  DIFFERENCE_KIND_LABEL,
  DIFFERENCE_NOTE_MAX,
  FACT_PROVENANCE_LABEL,
  ITINERARY_FACT_LIMITS as L,
  ITINERARY_TEXT,
  ITINERARY_WORDING_HINT,
  ITINERARY_WORDING_LABEL as W,
  SOURCE_MAX_BYTES,
  type FactProvenance,
  type ItineraryCreateResult,
  type ItineraryDifferenceView,
  type ItineraryEditorView,
  type ItineraryFacts,
  type RenderKind,
} from '@/modules/itineraries/contracts';
import { IFIELD } from '@/modules/itineraries/forms';
import { dateText } from '../b11/book-fields';
import { AreaField, SelectField, TextField } from '../b11/controls';
import { BaseRowVersion, DraftSyncProvider, useDraftSync, useSectionForm } from '../b11/draft-sync';
import { newRequestId, PendingButton } from '../b11/form-kit';
import { asItinSyncAction, asQuoteAction, ItinResultBox, sourceFileProblem, type ItinAction, type ItinActions } from './itin-kit';
import { itineraryHref } from './itin-shapes';
import { quoteProblem, useQuoteAction, type QuoteFieldRef } from './quote-kit';

/*
 * Itinerary forms (B1.2 Phase F): "Make branded itinerary", the private
 * source files, the facts editor (one full-replace save; "From the quotation"
 * marks on copied facts until staff change them), the differences with the
 * quotation or booking (use its value in one click, keep the itinerary value,
 * or keep it with a note), mark ready and the document requests (honest:
 * the document maker runs separately; a request only waits for it).
 */

const textLink = cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing);


// ---------------------------------------------------------------------------
// Make branded itinerary (quotation page, Deal page)
// ---------------------------------------------------------------------------

export function CreateItineraryForm({ subjectKind, subjectId, defaultTitle, action }: { /** Batch 3: 'referral' = an itinerary straight on a referral draft. */ subjectKind: 'quotation' | 'deal' | 'referral'; subjectId: string; defaultTitle: string; action: ItinAction }) {
  const [requestId] = useState(() => newRequestId());
  const [title, setTitle] = useState(defaultTitle.slice(0, 200));
  const [state, formAction] = useQuoteAction(asQuoteAction(action), {
    goTo: (data) => {
      const d = data as ItineraryCreateResult | null;
      return d ? itineraryHref(d.documentId) : null;
    },
  });
  return (
    <form action={formAction} noValidate className="flex w-full flex-col gap-3" aria-label="Make branded itinerary">
      <ItinResultBox result={state} fields={[{ field: IFIELD.title, id: `itin-create-title-${subjectKind}`, label: 'Itinerary title: 1 to 200 characters' }]} successText={ITINERARY_TEXT.created} />
      <input type="hidden" name={IFIELD.subjectKind} value={subjectKind} />
      <input type="hidden" name={IFIELD.subjectId} value={subjectId} />
      <input type="hidden" name={IFIELD.requestId} value={requestId} />
      <TextField
        id={`itin-create-title-${subjectKind}`}
        name={IFIELD.title}
        label="Itinerary title"
        hint="Printed at the top of the itinerary."
        value={title}
        onChange={setTitle}
        maxLength={200}
        error={quoteProblem(state, IFIELD.title, 'Type a title of 1 to 200 characters.')}
      />
      <div>
        <PendingButton pendingLabel="Starting…" variant="secondary">
          Make branded itinerary
        </PendingButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Private source files
// ---------------------------------------------------------------------------

export function SourceFiles({ editor: e, actions }: { editor: ItineraryEditorView; actions: ItinActions }) {
  return (
    <div className="flex flex-col gap-4">
      {e.sources.length === 0 ? (
        <p className="m-0 text-copy">No file attached. If the customer or a colleague already has an itinerary, attach it here to type the facts from it.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Attached files">
          {e.sources.map((s) => (
            <li key={s.fileId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-2.5">
              <FileText aria-hidden="true" className="size-4 shrink-0 text-brand-strong" />
              <span className="min-w-40 flex-1">
                <span className="block font-medium wrap-anywhere text-ink">{s.fileName}</span>
                <span className="block text-sm text-quiet">
                  {s.sizeLabel} · {s.status === 'stored' ? `attached ${dateText(s.uploadedAt)}` : s.status === 'failed' ? 'not stored: attach it again' : 'upload not finished'}
                  {e.sourceFileId === s.fileId ? ' · the facts were typed from this file' : ''}
                </span>
              </span>
              {s.downloadHref && s.status === 'stored' ? (
                <a href={s.downloadHref} className={cn(textLink, 'inline-flex min-h-11 items-center gap-1')}>
                  <Download aria-hidden="true" className="size-4" />
                  Open<span className="sr-only"> {s.fileName}</span>
                </a>
              ) : null}
              {e.canAddSource ? <RemoveSourceForm documentId={e.documentId} fileId={s.fileId} fileName={s.fileName} action={actions.removeSource} /> : null}
            </li>
          ))}
        </ul>
      )}
      {e.canAddSource ? <SourceUploadForm documentId={e.documentId} action={actions.uploadSource} /> : null}
    </div>
  );
}

function RemoveSourceForm({ documentId, fileId, fileName, action }: { documentId: string; fileId: string; fileName: string; action: ItinAction }) {
  const [state, formAction] = useQuoteAction(asQuoteAction(action));
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <ItinResultBox result={state && !state.ok ? state : null} />
      <input type="hidden" name={IFIELD.documentId} value={documentId} />
      <input type="hidden" name={IFIELD.fileId} value={fileId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="min-h-11"
        onClick={(ev) => {
          if (!window.confirm(`Remove ${fileName}?`)) ev.preventDefault();
        }}
      >
        <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {fileName}</span>
      </Button>
    </form>
  );
}

function SourceUploadForm({ documentId, action }: { documentId: string; action: ItinAction }) {
  const [hasFile, setHasFile] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [state, formAction] = useQuoteAction(asQuoteAction(action), {
    onSuccess: () => {
      setFormKey((k) => k + 1);
      setHasFile(false);
    },
  });
  const hint = `PDF, Word (.docx), JPG, PNG or WebP, up to ${Math.floor(SOURCE_MAX_BYTES / (1024 * 1024))} MB. Private: only the people preparing this trip can open it; it is never sent anywhere.`;
  const error = localError ?? quoteProblem(state, IFIELD.file, 'Choose the file again: PDF, Word, JPG, PNG or WebP up to 4 MB.');
  return (
    <form key={formKey} action={formAction} noValidate className="flex flex-col gap-3" aria-label="Attach the existing itinerary">
      <ItinResultBox result={state} fields={[{ field: IFIELD.file, id: 'itin-source-file', label: 'The file' }]} successText={ITINERARY_TEXT.sourceUploaded} />
      <input type="hidden" name={IFIELD.documentId} value={documentId} />
      <Field htmlFor="itin-source-file" label="Existing itinerary file" hint={hint} error={error ?? undefined} optional>
        <Input
          id="itin-source-file"
          name={IFIELD.file}
          type="file"
          accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/webp"
          invalid={Boolean(error)}
          aria-describedby={fieldDescribedBy('itin-source-file', { hint, error })}
          onChange={(ev) => {
            const file = ev.target.files?.[0] ?? null;
            const problem = file ? sourceFileProblem(file) : null;
            setLocalError(problem);
            setHasFile(Boolean(file) && !problem);
          }}
        />
      </Field>
      <div>
        <PendingButton pendingLabel="Attaching…" variant="secondary" disabled={!hasFile}>
          <Upload aria-hidden="true" /> Attach file
        </PendingButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Facts editor
// ---------------------------------------------------------------------------

interface StayRow {
  city: string;
  nights: string;
  checkIn: string;
  checkOut: string;
  hotelName: string;
  roomType: string;
  mealPlan: string;
  rooms: string;
}
interface DayRow {
  date: string;
  base: string;
  title: string;
  story: string;
  highlights: string;
  meals: string;
}
interface TransferRow {
  date: string;
  from: string;
  to: string;
  mode: string;
}
interface ActivityRow {
  date: string;
  city: string;
  name: string;
  included: string;
}
interface FlightRow {
  date: string;
  from: string;
  to: string;
  carrier: string;
  number: string;
}
interface FactsValues {
  destination: string;
  startDate: string;
  endDate: string;
  adults: string;
  children: string;
  childAges: string;
  infants: string;
  stays: StayRow[];
  days: DayRow[];
  transfers: TransferRow[];
  activities: ActivityRow[];
  flights: FlightRow[];
  inclusions: string;
  exclusions: string;
  coverWord: string;
  country: string;
  category: string;
  roomBasis: string;
  introduction: string;
  reasons: string;
  handledByUs: string;
  youBring: string;
  sourceFileId: string;
  provenance: Record<string, FactProvenance>;
}

const t = (v: string | null | undefined) => v ?? '';
const n = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const EMPTY = {
  stays: { city: '', nights: '', checkIn: '', checkOut: '', hotelName: '', roomType: '', mealPlan: '', rooms: '' } satisfies StayRow,
  days: { date: '', base: '', title: '', story: '', highlights: '', meals: '' } satisfies DayRow,
  transfers: { date: '', from: '', to: '', mode: '' } satisfies TransferRow,
  activities: { date: '', city: '', name: '', included: '' } satisfies ActivityRow,
  flights: { date: '', from: '', to: '', carrier: '', number: '' } satisfies FlightRow,
};

export function factsToValues(f: ItineraryFacts, sourceFileId: string | null): FactsValues {
  return {
    destination: t(f.destination),
    startDate: t(f.startDate),
    endDate: t(f.endDate),
    adults: n(f.party.adults),
    children: n(f.party.children),
    childAges: f.party.childAges.join(', '),
    infants: n(f.party.infants),
    stays: f.stays.map((s) => ({ city: t(s.city), nights: n(s.nights), checkIn: t(s.checkIn), checkOut: t(s.checkOut), hotelName: t(s.hotelName), roomType: t(s.roomType), mealPlan: t(s.mealPlan), rooms: n(s.rooms) })),
    days: f.days.map((d) => ({ date: t(d.date), base: t(d.base), title: t(d.title), story: t(d.story), highlights: d.highlights.join('\n'), meals: t(d.meals) })),
    transfers: f.transfers.map((x) => ({ date: t(x.date), from: t(x.from), to: t(x.to), mode: t(x.mode) })),
    activities: f.activities.map((a) => ({ date: t(a.date), city: t(a.city), name: t(a.name), included: a.included === true ? 'yes' : a.included === false ? 'no' : '' })),
    flights: f.flights.map((x) => ({ date: t(x.date), from: t(x.from), to: t(x.to), carrier: t(x.carrier), number: t(x.number) })),
    inclusions: f.inclusions.join('\n'),
    exclusions: f.exclusions.join('\n'),
    coverWord: t(f.coverWord),
    country: t(f.country),
    category: t(f.category),
    roomBasis: t(f.roomBasis),
    introduction: t(f.introduction),
    reasons: (f.reasons ?? []).join('\n'),
    handledByUs: (f.handledByUs ?? []).join('\n'),
    youBring: (f.youBring ?? []).join('\n'),
    sourceFileId: sourceFileId ?? '',
    provenance: { ...f.provenance },
  };
}

type ListKey = 'stays' | 'days' | 'transfers' | 'activities' | 'flights';

/** Provenance keys follow the rows: removing row i drops its keys and moves later rows up. */
function removeRowProvenance(prov: Record<string, FactProvenance>, list: ListKey, i: number): Record<string, FactProvenance> {
  const out: Record<string, FactProvenance> = {};
  for (const [k, v] of Object.entries(prov)) {
    const m = new RegExp(`^${list}\\[(\\d+)\\](.*)$`).exec(k);
    if (!m) {
      out[k] = v;
      continue;
    }
    const j = Number(m[1]);
    if (j === i) continue;
    out[j > i ? `${list}[${j - 1}]${m[2]}` : k] = v;
  }
  return out;
}

/** A copied fact says where it came from until staff change it ("check it", never colour alone). */
function originHint(prov: Record<string, FactProvenance>, path: string, hint?: string): ReactNode {
  const origin = prov[path];
  if (!origin || origin === 'manual') return hint;
  return (
    <>
      <span className="font-semibold text-status-info">{FACT_PROVENANCE_LABEL[origin]} — check it.</span>
      {hint ? ` ${hint}` : ''}
    </>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function FactsForm({ editor: e, action, reloadHref }: { editor: ItineraryEditorView; action: ItinAction; reloadHref: string }) {
  const initial = factsToValues(e.facts, e.sourceFileId);
  const f = useSectionForm({ id: 'itin-facts', section: 'details', label: 'Itinerary facts', order: 1, action: asItinSyncAction(action), initial, versionBound: true, rowVersion: e.rowVersion });
  const { bindForm, bindResult } = f;
  const x = f.values;
  const editable = e.canEditFacts;
  const prov = x.provenance;
  const touch = (path: string, p: Record<string, FactProvenance>) => (p[path] && p[path] !== 'manual' ? { ...p, [path]: 'manual' as FactProvenance } : p);
  const setTop = (key: Exclude<keyof FactsValues, ListKey | 'provenance'>, path: string, val: string) => f.setValues((v) => ({ ...v, [key]: val, provenance: touch(path, v.provenance) }));
  const setRow = <K extends ListKey>(list: K, i: number, field: string, val: string) =>
    f.setValues((v) => ({
      ...v,
      [list]: (v[list] as unknown as Array<Record<string, string>>).map((r, j) => (j === i ? { ...r, [field]: val } : r)),
      provenance: touch(`${list}[${i}].${field}`, v.provenance),
    }));
  const addRow = (list: ListKey) => f.setValues((v) => ({ ...v, [list]: [...(v[list] as unknown[]), { ...EMPTY[list] }] }));
  const removeRow = (list: ListKey, i: number) => f.setValues((v) => ({ ...v, [list]: (v[list] as unknown[]).filter((_, j) => j !== i), provenance: removeRowProvenance(v.provenance, list, i) }));
  const id = (name: string, i?: number) => (i === undefined ? `itin-${name}` : `itin-${name}-${i + 1}`);
  const rowRefs = (list: ListKey, names: Record<string, string>, count: number, word: string): QuoteFieldRef[] =>
    Array.from({ length: count }, (_, i) => Object.entries(names).map(([field, label]) => ({ field: `${field}[${i}]`, id: id(field, i), label: `${word} ${i + 1}: ${label}` }))).flat();
  const refs: QuoteFieldRef[] = [
    { field: IFIELD.destination, id: id('destination'), label: 'Destination (up to 200 characters)' },
    { field: IFIELD.startDate, id: id('startDate'), label: 'Start date' },
    { field: IFIELD.endDate, id: id('endDate'), label: 'End date: on or after the start' },
    { field: IFIELD.adults, id: id('adults'), label: 'Adults: 0 to 100' },
    { field: IFIELD.children, id: id('children'), label: 'Children: 0 to 100' },
    { field: IFIELD.childAges, id: id('childAges'), label: 'Child ages: 0 to 17, separated by commas' },
    { field: IFIELD.infants, id: id('infants'), label: 'Infants: 0 to 100' },
    ...rowRefs('stays', { stayCity: 'city', stayNights: 'nights (1 to 60)', stayCheckIn: 'check-in', stayCheckOut: 'check-out', stayHotelName: 'hotel', stayRoomType: 'room type', stayMealPlan: 'meal plan', stayRooms: 'rooms (1 to 50)' }, x.stays.length, 'Stay'),
    ...rowRefs('days', { dayDate: 'date', dayBase: 'where', dayTitle: 'title', dayStory: 'what happens (up to 2,000 characters)', dayHighlights: 'highlights (at most 10 lines)', dayMeals: 'meals' }, x.days.length, 'Day'),
    ...rowRefs('transfers', { transferDate: 'date', transferFrom: 'from', transferTo: 'to', transferMode: 'how' }, x.transfers.length, 'Transfer'),
    ...rowRefs('activities', { activityDate: 'date', activityCity: 'city', activityName: 'activity', activityIncluded: 'included' }, x.activities.length, 'Activity'),
    ...rowRefs('flights', { flightDate: 'date', flightFrom: 'from', flightTo: 'to', flightCarrier: 'airline', flightNumber: 'flight number' }, x.flights.length, 'Flight'),
    { field: IFIELD.inclusion, id: id('inclusions'), label: 'Included: at most 60 lines' },
    { field: IFIELD.exclusion, id: id('exclusions'), label: 'Not included: at most 60 lines' },
    { field: IFIELD.coverWord, id: id('coverWord'), label: `${W.coverWord} (up to ${L.coverWord} characters)` },
    { field: IFIELD.country, id: id('country'), label: `${W.country} (up to ${L.country} characters)` },
    { field: IFIELD.category, id: id('category'), label: `${W.category} (up to ${L.category} characters)` },
    { field: IFIELD.roomBasis, id: id('roomBasis'), label: `${W.roomBasis} (up to ${L.roomBasis} characters)` },
    { field: IFIELD.introduction, id: id('introduction'), label: `${W.introduction} (up to ${L.introduction} characters)` },
    { field: IFIELD.reason, id: id('reasons'), label: `${W.reasons}: at most ${L.reasons} points of up to ${L.point} characters` },
    { field: IFIELD.handledByUs, id: id('handledByUs'), label: `${W.handledByUs}: at most ${L.handledByUs} points of up to ${L.point} characters` },
    { field: IFIELD.youBring, id: id('youBring'), label: `${W.youBring}: at most ${L.youBring} points of up to ${L.point} characters` },
  ];
  const err = (name: string) => quoteProblem(f.state, name, refs.find((r) => r.field === name)?.label ?? 'Check this field.');
  const listErr = (name: string, label: string) => {
    const s = f.state as { ok: boolean; code?: string; fields?: string[] } | null;
    if (!s || s.ok || !s.fields?.some((k) => k === name || k.startsWith(`${name}[`))) return null;
    return s.code === 'internal_wording' ? 'Not saved: remove internal words like net rate, margin, cost or supplier.' : label;
  };
  const common = (name: string, path: string, value: string, onChange: (v: string) => void, extra: { hint?: string } = {}) => ({
    id: id(name),
    name,
    value,
    onChange,
    error: err(name),
    disabled: !editable,
    hint: originHint(prov, path, extra.hint),
  });
  const rowField = (list: ListKey, i: number, name: string, field: string, value: string, extra: { hint?: string } = {}) => ({
    id: id(name, i),
    name,
    value,
    onChange: (v: string) => setRow(list, i, field, v),
    error: err(`${name}[${i}]`),
    disabled: !editable,
    hint: originHint(prov, `${list}[${i}].${field}`, extra.hint),
  });
  const removeButton = (list: ListKey, i: number, word: string) =>
    editable ? (
      <Button variant="ghost" size="sm" onClick={() => removeRow(list, i)}>
        <Trash2 aria-hidden="true" /> Remove {word.toLowerCase()} {i + 1}
      </Button>
    ) : null;
  const addButton = (list: ListKey, word: string, max: number) =>
    editable && (x[list] as unknown[]).length < max ? (
      <div>
        <Button variant="secondary" size="sm" onClick={() => addRow(list)}>
          <Plus aria-hidden="true" /> Add {word.toLowerCase()} {(x[list] as unknown[]).length + 1}
        </Button>
      </div>
    ) : null;
  const storedSources = e.sources.filter((s) => s.status === 'stored');
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate aria-label="Itinerary facts" className="flex flex-col gap-5">
      <div ref={bindResult}>
        <ItinResultBox result={f.state} fields={refs} reloadHref={reloadHref} successText={ITINERARY_TEXT.factsSaved} />
      </div>
      <input type="hidden" name={IFIELD.documentId} value={e.documentId} />
      <input type="hidden" name={IFIELD.draftId} value={e.draftId} />
      <BaseRowVersion base={f.base} />
      <input type="hidden" name={IFIELD.provenance} value={JSON.stringify(prov)} />
      {storedSources.length > 0 ? (
        <div className="max-w-md">
          <SelectField
            id={id('sourceFileId')}
            name={IFIELD.sourceFileId}
            label="Typed from"
            optional
            value={x.sourceFileId}
            onChange={(v) => f.setValues((s) => ({ ...s, sourceFileId: v }))}
            disabled={!editable}
            options={[{ value: '', label: 'No file (typed by hand)' }, ...storedSources.map((s) => ({ value: s.fileId, label: s.fileName }))]}
          />
        </div>
      ) : (
        <input type="hidden" name={IFIELD.sourceFileId} value="" />
      )}

      <Fieldset legend="Trip" columns={3}>
        <TextField {...common(IFIELD.destination, 'destination', x.destination, (v) => setTop('destination', 'destination', v))} label="Destination" maxLength={L.destination} className="sm:col-span-2 lg:col-span-1" />
        <TextField {...common(IFIELD.startDate, 'startDate', x.startDate, (v) => setTop('startDate', 'startDate', v))} label="Start date" type="date" />
        <TextField {...common(IFIELD.endDate, 'endDate', x.endDate, (v) => setTop('endDate', 'endDate', v))} label="End date" type="date" min={x.startDate || undefined} />
      </Fieldset>

      <Fieldset legend="Travellers" description="Counts and child ages only; names are never printed on an itinerary." columns={3}>
        <TextField {...common(IFIELD.adults, 'party.adults', x.adults, (v) => setTop('adults', 'party.adults', v))} label="Adults" type="number" min={0} max={100} />
        <TextField {...common(IFIELD.children, 'party.children', x.children, (v) => setTop('children', 'party.children', v))} label="Children" type="number" min={0} max={100} optional />
        <TextField {...common(IFIELD.childAges, 'party.childAges', x.childAges, (v) => setTop('childAges', 'party.childAges', v), { hint: 'For example: 4, 9.' })} label="Child ages" optional />
        <TextField {...common(IFIELD.infants, 'party.infants', x.infants, (v) => setTop('infants', 'party.infants', v))} label="Infants" type="number" min={0} max={100} optional />
      </Fieldset>

      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-base font-semibold text-ink">Stays</h3>
        {x.stays.length === 0 ? <p className="m-0 text-quiet">No stay yet.</p> : null}
        {x.stays.map((s, i) => (
          <Fieldset key={i} legend={`Stay ${i + 1}`} columns={3} actions={removeButton('stays', i, 'Stay')}>
            <TextField {...rowField('stays', i, IFIELD.stayCity, 'city', s.city)} label="City" maxLength={L.stay.city} />
            <TextField {...rowField('stays', i, IFIELD.stayHotelName, 'hotelName', s.hotelName)} label="Hotel" maxLength={L.stay.hotelName} optional />
            <TextField {...rowField('stays', i, IFIELD.stayRoomType, 'roomType', s.roomType)} label="Room type" maxLength={L.stay.roomType} optional />
            <TextField {...rowField('stays', i, IFIELD.stayCheckIn, 'checkIn', s.checkIn)} label="Check-in" type="date" optional />
            <TextField {...rowField('stays', i, IFIELD.stayCheckOut, 'checkOut', s.checkOut)} label="Check-out" type="date" optional />
            <TextField {...rowField('stays', i, IFIELD.stayNights, 'nights', s.nights)} label="Nights" type="number" min={1} max={60} />
            <TextField {...rowField('stays', i, IFIELD.stayMealPlan, 'mealPlan', s.mealPlan)} label="Meal plan" maxLength={L.stay.mealPlan} optional />
            <TextField {...rowField('stays', i, IFIELD.stayRooms, 'rooms', s.rooms)} label="Rooms" type="number" min={1} max={50} optional />
          </Fieldset>
        ))}
        {addButton('stays', 'Stay', L.stays)}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-base font-semibold text-ink">Day by day</h3>
        {x.days.length === 0 ? <p className="m-0 text-quiet">No day yet. Each day becomes one block of the itinerary.</p> : null}
        {x.days.map((d, i) => (
          <Fieldset key={i} legend={`Day ${i + 1}`} columns={3} actions={removeButton('days', i, 'Day')}>
            <TextField {...rowField('days', i, IFIELD.dayTitle, 'title', d.title)} label="Title" maxLength={L.day.title} />
            <TextField {...rowField('days', i, IFIELD.dayBase, 'base', d.base)} label="Where" maxLength={L.day.base} optional />
            <TextField {...rowField('days', i, IFIELD.dayDate, 'date', d.date)} label="Date" type="date" optional />
            <AreaField {...rowField('days', i, IFIELD.dayStory, 'story', d.story)} label="What happens" rows={3} maxLength={L.day.story} optional className="sm:col-span-2 lg:col-span-3" />
            <AreaField {...rowField('days', i, IFIELD.dayHighlights, 'highlights', d.highlights, { hint: 'One per line, at most 10.' })} label="Highlights" rows={3} optional className="sm:col-span-2" />
            <TextField {...rowField('days', i, IFIELD.dayMeals, 'meals', d.meals)} label="Meals" maxLength={L.day.meals} optional />
          </Fieldset>
        ))}
        {addButton('days', 'Day', L.days)}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-base font-semibold text-ink">Transfers</h3>
        {x.transfers.map((r, i) => (
          <Fieldset key={i} legend={`Transfer ${i + 1}`} columns={2} actions={removeButton('transfers', i, 'Transfer')}>
            <TextField {...rowField('transfers', i, IFIELD.transferFrom, 'from', r.from)} label="From" maxLength={L.transfer.place} />
            <TextField {...rowField('transfers', i, IFIELD.transferTo, 'to', r.to)} label="To" maxLength={L.transfer.place} />
            <TextField {...rowField('transfers', i, IFIELD.transferDate, 'date', r.date)} label="Date" type="date" optional />
            <TextField {...rowField('transfers', i, IFIELD.transferMode, 'mode', r.mode, { hint: 'For example: private car.' })} label="How" maxLength={L.transfer.mode} optional />
          </Fieldset>
        ))}
        {addButton('transfers', 'Transfer', L.transfers)}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-base font-semibold text-ink">Activities</h3>
        {x.activities.map((r, i) => (
          <Fieldset key={i} legend={`Activity ${i + 1}`} columns={2} actions={removeButton('activities', i, 'Activity')}>
            <TextField {...rowField('activities', i, IFIELD.activityName, 'name', r.name)} label="Activity" maxLength={L.activity.name} />
            <TextField {...rowField('activities', i, IFIELD.activityCity, 'city', r.city)} label="City" maxLength={L.activity.city} optional />
            <TextField {...rowField('activities', i, IFIELD.activityDate, 'date', r.date)} label="Date" type="date" optional />
            <SelectField
              {...rowField('activities', i, IFIELD.activityIncluded, 'included', r.included)}
              label="In the price?"
              optional
              options={[
                { value: '', label: 'Not said' },
                { value: 'yes', label: 'Included' },
                { value: 'no', label: 'Optional, paid separately' },
              ]}
            />
          </Fieldset>
        ))}
        {addButton('activities', 'Activity', L.activities)}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-base font-semibold text-ink">Flights</h3>
        {x.flights.map((r, i) => (
          <Fieldset key={i} legend={`Flight ${i + 1}`} columns={3} actions={removeButton('flights', i, 'Flight')}>
            <TextField {...rowField('flights', i, IFIELD.flightFrom, 'from', r.from)} label="From" maxLength={L.flight.place} />
            <TextField {...rowField('flights', i, IFIELD.flightTo, 'to', r.to)} label="To" maxLength={L.flight.place} />
            <TextField {...rowField('flights', i, IFIELD.flightDate, 'date', r.date)} label="Date" type="date" optional />
            <TextField {...rowField('flights', i, IFIELD.flightCarrier, 'carrier', r.carrier)} label="Airline" maxLength={L.flight.carrier} optional />
            <TextField {...rowField('flights', i, IFIELD.flightNumber, 'number', r.number)} label="Flight number" maxLength={L.flight.number} optional />
          </Fieldset>
        ))}
        {addButton('flights', 'Flight', L.flights)}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <AreaField id={id('inclusions')} name="inclusionText" label="Included" hint={originHint(prov, 'inclusions', 'One per line.')} optional rows={5} value={x.inclusions} onChange={(v) => setTop('inclusions', 'inclusions', v)} error={listErr(IFIELD.inclusion, 'Included: at most 60 lines of up to 300 characters')} disabled={!editable} />
        <AreaField id={id('exclusions')} name="exclusionText" label="Not included" hint={originHint(prov, 'exclusions', 'One per line.')} optional rows={5} value={x.exclusions} onChange={(v) => setTop('exclusions', 'exclusions', v)} error={listErr(IFIELD.exclusion, 'Not included: at most 60 lines of up to 300 characters')} disabled={!editable} />
      </div>
      <Fieldset legend="Document wording" description="What the customer reads around the facts. Customer text: no supplier names, net rates or internal notes." columns={2}>
        <TextField {...common(IFIELD.coverWord, 'coverWord', x.coverWord, (v) => setTop('coverWord', 'coverWord', v), { hint: ITINERARY_WORDING_HINT.coverWord })} label={W.coverWord} maxLength={L.coverWord} optional />
        <TextField {...common(IFIELD.country, 'country', x.country, (v) => setTop('country', 'country', v))} label={W.country} maxLength={L.country} optional />
        <TextField {...common(IFIELD.category, 'category', x.category, (v) => setTop('category', 'category', v), { hint: 'For example: Family, Honeymoon.' })} label={W.category} maxLength={L.category} optional />
        <TextField {...common(IFIELD.roomBasis, 'roomBasis', x.roomBasis, (v) => setTop('roomBasis', 'roomBasis', v), { hint: 'For example: 2 adults and 1 child sharing.' })} label={W.roomBasis} maxLength={L.roomBasis} optional />
        <AreaField {...common(IFIELD.introduction, 'introduction', x.introduction, (v) => setTop('introduction', 'introduction', v), { hint: ITINERARY_WORDING_HINT.introduction })} label={W.introduction} rows={4} maxLength={L.introduction} optional className="sm:col-span-2" />
        <AreaField id={id('reasons')} name="reasonText" label={W.reasons} hint={originHint(prov, 'reasons', ITINERARY_WORDING_HINT.reasons)} optional rows={4} value={x.reasons} onChange={(v) => setTop('reasons', 'reasons', v)} error={listErr(IFIELD.reason, `${W.reasons}: at most ${L.reasons} points of up to ${L.point} characters`)} disabled={!editable} />
        <AreaField id={id('handledByUs')} name="handledByUsText" label={W.handledByUs} hint={originHint(prov, 'handledByUs', ITINERARY_WORDING_HINT.handledByUs)} optional rows={4} value={x.handledByUs} onChange={(v) => setTop('handledByUs', 'handledByUs', v)} error={listErr(IFIELD.handledByUs, `${W.handledByUs}: at most ${L.handledByUs} points of up to ${L.point} characters`)} disabled={!editable} />
        <AreaField id={id('youBring')} name="youBringText" label={W.youBring} hint={originHint(prov, 'youBring', ITINERARY_WORDING_HINT.youBring)} optional rows={4} value={x.youBring} onChange={(v) => setTop('youBring', 'youBring', v)} error={listErr(IFIELD.youBring, `${W.youBring}: at most ${L.youBring} points of up to ${L.point} characters`)} disabled={!editable} className="sm:col-span-2" />
      </Fieldset>
      {lines(x.reasons).map((l, i) => (
        <input key={`rsn-${i}`} type="hidden" name={IFIELD.reason} value={l} />
      ))}
      {lines(x.handledByUs).map((l, i) => (
        <input key={`hbu-${i}`} type="hidden" name={IFIELD.handledByUs} value={l} />
      ))}
      {lines(x.youBring).map((l, i) => (
        <input key={`yb-${i}`} type="hidden" name={IFIELD.youBring} value={l} />
      ))}
      {lines(x.inclusions).map((l, i) => (
        <input key={`inc-${i}`} type="hidden" name={IFIELD.inclusion} value={l} />
      ))}
      {lines(x.exclusions).map((l, i) => (
        <input key={`exc-${i}`} type="hidden" name={IFIELD.exclusion} value={l} />
      ))}

      {editable ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <PendingButton pendingLabel="Saving…" variant="secondary">
            Save facts
          </PendingButton>
          <span className="text-sm text-quiet" aria-live="polite">
            {f.dirty ? 'Not saved yet' : 'All saved'}
            {e.status === 'ready' ? ' Saving sets the facts back to “being entered”; mark them ready again.' : ''}
          </span>
        </div>
      ) : (
        <p className="m-0 text-sm text-quiet">You can view this but not change it. Sales on this deal or the branch Manager can change it.</p>
      )}
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Differences from the quotation or booking
// ---------------------------------------------------------------------------

export function CheckDifferencesForm({ editor: e, action, primary }: { editor: ItineraryEditorView; action: ItinAction; primary: boolean }) {
  const sync = useDraftSync();
  const [state, formAction] = useQuoteAction(asQuoteAction(action));
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <ItinResultBox result={state} successText={null} />
      <input type="hidden" name={IFIELD.documentId} value={e.documentId} />
      <div className="flex flex-wrap items-center gap-3">
        <PendingButton pendingLabel="Checking…" variant={primary ? 'primary' : 'secondary'} disabled={!e.canCheckDifferences || sync.anyDirty}>
          {e.differences.runId ? 'Check differences again' : 'Check differences'}
        </PendingButton>
        {sync.anyDirty ? <span className="text-sm text-quiet">Save the facts first.</span> : null}
      </div>
    </form>
  );
}

function UseBasisForm({ documentId, difference: d, action, basisWord }: { documentId: string; difference: ItineraryDifferenceView; action: ItinAction; basisWord: string }) {
  const sync = useDraftSync();
  const [state, formAction] = useQuoteAction(asQuoteAction(action));
  const unavailable = state && !state.ok && (state as { code?: string }).code === 'basis_value_unavailable';
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <ItinResultBox result={state} successText={null}>
        {unavailable ? (
          <p className="m-0 mt-1.5">
            <a href="#facts" className={textLink}>
              Change it by hand in the facts
            </a>
          </p>
        ) : null}
      </ItinResultBox>
      <input type="hidden" name={IFIELD.documentId} value={documentId} />
      <input type="hidden" name={IFIELD.path} value={d.path} />
      {/* Terra handoff §5: the kind travels with the path. */}
      <input type="hidden" name={IFIELD.differenceKind} value={d.kind} />
      <PendingButton pendingLabel="Copying…" variant="secondary" disabled={sync.anyDirty} describedBy={`itin-diff-${d.differenceId}-label`}>
        {d.kind === 'extra' ? `Remove it, as in the ${basisWord}` : `Use the ${basisWord} value`}
      </PendingButton>
    </form>
  );
}

function AcknowledgeForms({ documentId, difference: d, action }: { documentId: string; difference: ItineraryDifferenceView; action: ItinAction }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [keepState, keepAction] = useQuoteAction(asQuoteAction(action));
  const [noteState, noteAction] = useQuoteAction(asQuoteAction(action));
  const noteId = `itin-diff-${d.differenceId}-note`;
  return (
    <>
      <form action={keepAction} noValidate className="flex flex-col gap-2">
        <ItinResultBox result={keepState && !keepState.ok ? keepState : null} />
        <input type="hidden" name={IFIELD.documentId} value={documentId} />
        <input type="hidden" name={IFIELD.differenceId} value={d.differenceId} />
        <input type="hidden" name={IFIELD.choice} value="keep_itinerary" />
        <PendingButton pendingLabel="Saving…" variant="ghost" describedBy={`itin-diff-${d.differenceId}-label`}>
          {DIFFERENCE_CHOICE_LABEL.keep_itinerary}
        </PendingButton>
      </form>
      {noting ? (
        <form action={noteAction} noValidate className="flex w-full flex-col gap-2">
          <ItinResultBox result={noteState && !noteState.ok ? noteState : null} fields={[{ field: IFIELD.note, id: noteId, label: 'Note: 1 to 500 characters' }]} />
          <input type="hidden" name={IFIELD.documentId} value={documentId} />
          <input type="hidden" name={IFIELD.differenceId} value={d.differenceId} />
          <input type="hidden" name={IFIELD.choice} value="note" />
          <AreaField id={noteId} name={IFIELD.note} label={`Why the itinerary differs (${d.label})`} hint="Internal — never printed" rows={2} maxLength={DIFFERENCE_NOTE_MAX} value={note} onChange={setNote} error={quoteProblem(noteState, IFIELD.note, 'Write a note of 1 to 500 characters.')} />
          <div className="flex flex-wrap gap-2">
            <PendingButton pendingLabel="Saving…" variant="secondary" disabled={note.trim() === ''}>
              Keep it with this note
            </PendingButton>
            <Button variant="ghost" className="min-h-11" onClick={() => setNoting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="ghost" className="min-h-11" onClick={() => setNoting(true)} aria-describedby={`itin-diff-${d.differenceId}-label`}>
          {DIFFERENCE_CHOICE_LABEL.note}
        </Button>
      )}
    </>
  );
}

export function DifferencesList({ editor: e, actions }: { editor: ItineraryEditorView; actions: ItinActions }) {
  const basisWord = e.basis.kind === 'booking_version' ? 'booking' : 'quotation';
  const open = e.differences.items.filter((d) => !d.acknowledged);
  const settled = e.differences.items.filter((d) => d.acknowledged);
  if (!e.differences.runId) return <p className="m-0 text-copy">Not checked yet. After saving the facts, check them against the {basisWord}.</p>;
  if (e.differences.items.length === 0)
    return (
      <p className="m-0 flex gap-2 text-copy">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />
        {ITINERARY_TEXT.differencesNone}
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {open.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Open differences">
          {open.map((d) => (
            <li key={d.differenceId} className="m-0 flex flex-col gap-2.5 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-3">
              <p id={`itin-diff-${d.differenceId}-label`} className="m-0">
                <span className="font-semibold text-ink">{d.label}</span>
                <span className="block text-sm text-copy">{DIFFERENCE_KIND_LABEL[d.kind]}</span>
              </p>
              {e.canEditFacts ? (
                <div className="flex flex-wrap items-start gap-2">
                  <UseBasisForm documentId={e.documentId} difference={d} action={actions.useBasisValue} basisWord={basisWord} />
                  <AcknowledgeForms documentId={e.documentId} difference={d} action={actions.acknowledge} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 flex gap-2 text-copy">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />
          Every difference is settled.
        </p>
      )}
      {settled.length > 0 ? (
        <details>
          <summary className={cn('inline-flex min-h-11 cursor-pointer items-center rounded-control font-medium text-brand-strong underline underline-offset-4', focusRing)}>Settled differences ({settled.length})</summary>
          <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0">
            {settled.map((d) => (
              <li key={d.differenceId} className="m-0 text-sm text-copy">
                <span className="font-semibold text-ink">{d.label}</span> · kept on purpose{d.acknowledgedByName ? ` by ${d.acknowledgedByName}` : ''}
                {d.acknowledgedAt ? ` on ${dateText(d.acknowledgedAt)}` : ''}
                {d.note ? `: ${d.note}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ready and the document requests
// ---------------------------------------------------------------------------

export function MarkItineraryReadyForm({ editor: e, action, primary }: { editor: ItineraryEditorView; action: ItinAction; primary: boolean }) {
  const sync = useDraftSync();
  const f = useSectionForm({ id: 'itin-ready', section: 'details', label: 'Mark ready', order: 2, action: asItinSyncAction(action), initial: {}, versionBound: true, rowVersion: e.rowVersion, saveable: false, tracksDirty: false });
  const { bindForm, bindResult } = f;
  return (
    <HandForm ref={bindForm} action={f.formAction} noValidate className="flex flex-col gap-2">
      <div ref={bindResult}>
        <ItinResultBox result={f.state} successText={ITINERARY_TEXT.markedReady} />
      </div>
      <input type="hidden" name={IFIELD.documentId} value={e.documentId} />
      <input type="hidden" name={IFIELD.draftId} value={e.draftId} />
      <BaseRowVersion base={f.base} />
      <div className="flex flex-wrap items-center gap-3">
        <PendingButton pendingLabel="Checking…" variant={primary ? 'primary' : 'secondary'} disabled={!e.canMarkReady || sync.anyDirty}>
          Mark facts ready
        </PendingButton>
        {sync.anyDirty ? <span className="text-sm text-quiet">Save the facts first.</span> : null}
      </div>
    </HandForm>
  );
}

export function RequestRenderForm({ editor: e, kind, action, primary }: { editor: ItineraryEditorView; kind: RenderKind; action: ItinAction; primary: boolean }) {
  const [state, formAction] = useQuoteAction(asQuoteAction(action));
  const allowed = kind === 'final' ? e.canRequestFinal : e.canRequestPreview;
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <ItinResultBox result={state} successText="Requested. You can download it here when it is ready." />
      <input type="hidden" name={IFIELD.documentId} value={e.documentId} />
      <input type="hidden" name={IFIELD.renderKind} value={kind} />
      <div>
        <PendingButton pendingLabel="Requesting…" variant={primary ? 'primary' : 'secondary'} disabled={!allowed}>
          {kind === 'final' ? 'Make final PDF' : 'Make preview PDF'}
        </PendingButton>
      </div>
    </form>
  );
}

/** The editor's forms share the draft's row version and the unsaved-changes guard. */
export function ItinerarySync({ editor, children }: { editor: ItineraryEditorView; children: ReactNode }) {
  return <DraftSyncProvider view={{ version: { rowVersion: editor.rowVersion } }}>{children}</DraftSyncProvider>;
}
