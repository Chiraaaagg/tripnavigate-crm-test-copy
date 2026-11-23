import { formReaders, type ParsedForm, readRowVersion, readUuid } from '@/modules/fulfilment/forms';
import {
  DIFFERENCE_CHOICES,
  DIFFERENCE_NOTE_MAX,
  type DifferenceChoice,
  FACT_PROVENANCES,
  type FactProvenance,
  ITINERARY_FACT_LIMITS as L,
  ITINERARY_SUBJECT_KINDS,
  type ItineraryFacts,
  type ItinerarySubjectKind,
  RENDER_KINDS,
  type RenderKind,
} from './contracts';

/*
 * Itinerary form input names (frozen with Luna's screens) and pure parsers.
 * The facts editor posts one form: single values plus parallel arrays per
 * list (index = row order; blank rows skipped). Day highlights are one
 * line each inside a textarea. Provenance comes back as the hidden JSON the
 * screen keeps. Actor, entity, branch and owner are never read from a form.
 */

export const IFIELD = {
  subjectKind: 'subjectKind',
  subjectId: 'subjectId',
  documentId: 'documentId',
  draftId: 'draftId',
  rowVersion: 'rowVersion',
  requestId: 'requestId',
  title: 'title',
  file: 'file',
  fileId: 'fileId',
  sourceFileId: 'sourceFileId',
  differenceId: 'differenceId',
  /** A difference's field path ("use the quotation value"). */
  path: 'path',
  /** That difference's kind: missing | different | extra (with path, it names one difference). */
  differenceKind: 'differenceKind',
  choice: 'choice',
  note: 'note',
  renderKind: 'renderKind',
  // facts: single values
  destination: 'destination',
  startDate: 'startDate',
  endDate: 'endDate',
  adults: 'adults',
  children: 'children',
  /** "4, 9" */
  childAges: 'childAges',
  infants: 'infants',
  /** Hidden JSON { "<path>": "manual" | "quotation" | "booking" }. */
  provenance: 'provenance',
  // stays
  stayCity: 'stayCity',
  stayNights: 'stayNights',
  stayCheckIn: 'stayCheckIn',
  stayCheckOut: 'stayCheckOut',
  stayHotelName: 'stayHotelName',
  stayRoomType: 'stayRoomType',
  stayMealPlan: 'stayMealPlan',
  stayRooms: 'stayRooms',
  // days (day number = row position + 1)
  dayDate: 'dayDate',
  dayBase: 'dayBase',
  dayTitle: 'dayTitle',
  dayStory: 'dayStory',
  /** One highlight per line. */
  dayHighlights: 'dayHighlights',
  dayMeals: 'dayMeals',
  // transfers
  transferDate: 'transferDate',
  transferFrom: 'transferFrom',
  transferTo: 'transferTo',
  transferMode: 'transferMode',
  // activities ('yes' | 'no' | '' for included)
  activityDate: 'activityDate',
  activityCity: 'activityCity',
  activityName: 'activityName',
  activityIncluded: 'activityIncluded',
  // flights
  flightDate: 'flightDate',
  flightFrom: 'flightFrom',
  flightTo: 'flightTo',
  flightCarrier: 'flightCarrier',
  flightNumber: 'flightNumber',
  // lists
  inclusion: 'inclusion',
  exclusion: 'exclusion',
  // document wording
  coverWord: 'coverWord',
  country: 'country',
  category: 'category',
  roomBasis: 'roomBasis',
  /** Multi-line text (line breaks kept). */
  introduction: 'introduction',
  /** Repeated inputs, one point each (like inclusion). */
  reason: 'reason',
  handledByUs: 'handledByUs',
  youBring: 'youBring',
} as const;

const { text, strings, isText, isIsoDate } = formReaders;

function value(formData: FormData, name: string): string {
  return (text(formData, name) ?? '').trim();
}
function line(raw: string | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}
function done<T>(fields: string[], build: () => T): ParsedForm<T> {
  return fields.length > 0 ? { ok: false, fields: [...new Set(fields)] } : { ok: true, value: build() };
}

export interface CreateItineraryForm {
  subjectKind: ItinerarySubjectKind;
  subjectId: string;
  title: string;
  requestId: string;
}
export function parseCreateItineraryForm(formData: FormData): ParsedForm<CreateItineraryForm> {
  const fields: string[] = [];
  const raw = value(formData, IFIELD.subjectKind);
  const subjectKind = (ITINERARY_SUBJECT_KINDS as readonly string[]).includes(raw) ? (raw as ItinerarySubjectKind) : null;
  if (!subjectKind) fields.push(IFIELD.subjectKind);
  const subjectId = readUuid(formData, IFIELD.subjectId);
  if (!subjectId) fields.push(IFIELD.subjectId);
  const title = line(value(formData, IFIELD.title));
  if (!isText(title, 200)) fields.push(IFIELD.title);
  const requestId = readUuid(formData, IFIELD.requestId);
  if (!requestId) fields.push(IFIELD.requestId);
  return done(fields, () => ({ subjectKind: subjectKind!, subjectId: subjectId!, title, requestId: requestId! }));
}

export interface ItineraryFactsForm {
  documentId: string;
  draftId: string;
  expectedRowVersion: number;
  sourceFileId: string | null;
  facts: ItineraryFacts;
}

/**
 * The whole facts draft (full replace, as itinerary_facts_save stores it).
 * Every bad input is named (`stayNights[1]` style, 0-based as posted).
 */
export function parseItineraryFactsForm(formData: FormData): ParsedForm<ItineraryFactsForm> {
  const fields: string[] = [];
  const documentId = readUuid(formData, IFIELD.documentId);
  if (!documentId) fields.push(IFIELD.documentId);
  const draftId = readUuid(formData, IFIELD.draftId);
  if (!draftId) fields.push(IFIELD.draftId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(IFIELD.rowVersion);
  const sourceRaw = value(formData, IFIELD.sourceFileId);
  const sourceFileId = sourceRaw === '' ? null : readUuid(formData, IFIELD.sourceFileId);
  if (sourceRaw !== '' && !sourceFileId) fields.push(IFIELD.sourceFileId);

  const optText = (raw: string | undefined, max: number, name: string): string | null => {
    const v = line(raw);
    if (v === '') return null;
    if (!isText(v, max)) fields.push(name);
    return v;
  };
  const optInt = (raw: string | undefined, min: number, max: number, name: string): number | null => {
    const v = (raw ?? '').trim();
    if (v === '') return null;
    const n = /^\d{1,4}$/.test(v) ? Number(v) : -1;
    if (n < min || n > max) {
      fields.push(name);
      return null;
    }
    return n;
  };
  const optDate = (raw: string | undefined, name: string): string | null => {
    const v = (raw ?? '').trim();
    if (v === '') return null;
    if (!isIsoDate(v)) {
      fields.push(name);
      return null;
    }
    return v;
  };
  const rows = (...names: string[]) => Math.max(...names.map((n) => strings(formData, n).length));
  const col = (name: string) => strings(formData, name);

  const destination = optText(value(formData, IFIELD.destination), L.destination, IFIELD.destination);
  const startDate = optDate(value(formData, IFIELD.startDate), IFIELD.startDate);
  const endDate = optDate(value(formData, IFIELD.endDate), IFIELD.endDate);
  if (startDate && endDate && endDate < startDate) fields.push(IFIELD.endDate);

  const agesRaw = value(formData, IFIELD.childAges);
  const childAges: number[] = [];
  if (agesRaw !== '') {
    for (const part of agesRaw.split(/[,\s]+/).filter(Boolean)) {
      const n = /^\d{1,2}$/.test(part) ? Number(part) : -1;
      if (n < L.party.age.min || n > L.party.age.max) fields.push(IFIELD.childAges);
      else childAges.push(n);
    }
    if (childAges.length > L.party.childAges) fields.push(IFIELD.childAges);
  }
  const party = {
    adults: optInt(value(formData, IFIELD.adults), 0, L.party.max, IFIELD.adults),
    children: optInt(value(formData, IFIELD.children), 0, L.party.max, IFIELD.children),
    childAges,
    infants: optInt(value(formData, IFIELD.infants), 0, L.party.max, IFIELD.infants),
  };

  const stays: ItineraryFacts['stays'] = [];
  {
    const [city, nights, ci, co, hotel, room, meal, rooms] = [IFIELD.stayCity, IFIELD.stayNights, IFIELD.stayCheckIn, IFIELD.stayCheckOut, IFIELD.stayHotelName, IFIELD.stayRoomType, IFIELD.stayMealPlan, IFIELD.stayRooms].map(col);
    for (let i = 0; i < rows(IFIELD.stayCity, IFIELD.stayHotelName, IFIELD.stayNights); i += 1) {
      if ([city, nights, ci, co, hotel, room, meal, rooms].every((c) => (c![i] ?? '').trim() === '')) continue;
      stays.push({
        city: optText(city![i], L.stay.city, `${IFIELD.stayCity}[${i}]`),
        nights: optInt(nights![i], L.stay.nights.min, L.stay.nights.max, `${IFIELD.stayNights}[${i}]`),
        checkIn: optDate(ci![i], `${IFIELD.stayCheckIn}[${i}]`),
        checkOut: optDate(co![i], `${IFIELD.stayCheckOut}[${i}]`),
        hotelName: optText(hotel![i], L.stay.hotelName, `${IFIELD.stayHotelName}[${i}]`),
        roomType: optText(room![i], L.stay.roomType, `${IFIELD.stayRoomType}[${i}]`),
        mealPlan: optText(meal![i], L.stay.mealPlan, `${IFIELD.stayMealPlan}[${i}]`),
        rooms: optInt(rooms![i], L.stay.rooms.min, L.stay.rooms.max, `${IFIELD.stayRooms}[${i}]`),
      });
    }
    if (stays.length > L.stays) fields.push(IFIELD.stayCity);
  }

  const days: ItineraryFacts['days'] = [];
  {
    const [date, base, title, story, highlights, meals] = [IFIELD.dayDate, IFIELD.dayBase, IFIELD.dayTitle, IFIELD.dayStory, IFIELD.dayHighlights, IFIELD.dayMeals].map(col);
    for (let i = 0; i < rows(IFIELD.dayTitle, IFIELD.dayStory, IFIELD.dayDate); i += 1) {
      if ([date, base, title, story, highlights, meals].every((c) => (c![i] ?? '').trim() === '')) continue;
      const storyRaw = (story![i] ?? '').trim();
      if (storyRaw !== '' && !isText(storyRaw, L.day.story)) fields.push(`${IFIELD.dayStory}[${i}]`);
      const hl = (highlights![i] ?? '').split(/\r?\n/).map((h) => line(h)).filter(Boolean);
      if (hl.length > L.day.highlights || hl.some((h) => !isText(h, L.day.highlight))) fields.push(`${IFIELD.dayHighlights}[${i}]`);
      days.push({
        n: days.length + 1,
        date: optDate(date![i], `${IFIELD.dayDate}[${i}]`),
        base: optText(base![i], L.day.base, `${IFIELD.dayBase}[${i}]`),
        title: optText(title![i], L.day.title, `${IFIELD.dayTitle}[${i}]`),
        story: storyRaw === '' ? null : storyRaw,
        highlights: hl,
        meals: optText(meals![i], L.day.meals, `${IFIELD.dayMeals}[${i}]`),
      });
    }
    if (days.length > L.days) fields.push(IFIELD.dayTitle);
  }

  const transfers: ItineraryFacts['transfers'] = [];
  {
    const [date, from, to, mode] = [IFIELD.transferDate, IFIELD.transferFrom, IFIELD.transferTo, IFIELD.transferMode].map(col);
    for (let i = 0; i < rows(IFIELD.transferFrom, IFIELD.transferTo, IFIELD.transferDate); i += 1) {
      if ([date, from, to, mode].every((c) => (c![i] ?? '').trim() === '')) continue;
      transfers.push({
        date: optDate(date![i], `${IFIELD.transferDate}[${i}]`),
        from: optText(from![i], L.transfer.place, `${IFIELD.transferFrom}[${i}]`),
        to: optText(to![i], L.transfer.place, `${IFIELD.transferTo}[${i}]`),
        mode: optText(mode![i], L.transfer.mode, `${IFIELD.transferMode}[${i}]`),
      });
    }
    if (transfers.length > L.transfers) fields.push(IFIELD.transferFrom);
  }

  const activities: ItineraryFacts['activities'] = [];
  {
    const [date, city, name, included] = [IFIELD.activityDate, IFIELD.activityCity, IFIELD.activityName, IFIELD.activityIncluded].map(col);
    for (let i = 0; i < rows(IFIELD.activityName, IFIELD.activityCity, IFIELD.activityDate); i += 1) {
      if ([date, city, name].every((c) => (c![i] ?? '').trim() === '')) continue;
      const inc = (included![i] ?? '').trim();
      if (inc !== '' && inc !== 'yes' && inc !== 'no') fields.push(`${IFIELD.activityIncluded}[${i}]`);
      activities.push({
        date: optDate(date![i], `${IFIELD.activityDate}[${i}]`),
        city: optText(city![i], L.activity.city, `${IFIELD.activityCity}[${i}]`),
        name: optText(name![i], L.activity.name, `${IFIELD.activityName}[${i}]`),
        included: inc === 'yes' ? true : inc === 'no' ? false : null,
      });
    }
    if (activities.length > L.activities) fields.push(IFIELD.activityName);
  }

  const flights: ItineraryFacts['flights'] = [];
  {
    const [date, from, to, carrier, number] = [IFIELD.flightDate, IFIELD.flightFrom, IFIELD.flightTo, IFIELD.flightCarrier, IFIELD.flightNumber].map(col);
    for (let i = 0; i < rows(IFIELD.flightFrom, IFIELD.flightTo, IFIELD.flightDate); i += 1) {
      if ([date, from, to, carrier, number].every((c) => (c![i] ?? '').trim() === '')) continue;
      flights.push({
        date: optDate(date![i], `${IFIELD.flightDate}[${i}]`),
        from: optText(from![i], L.flight.place, `${IFIELD.flightFrom}[${i}]`),
        to: optText(to![i], L.flight.place, `${IFIELD.flightTo}[${i}]`),
        carrier: optText(carrier![i], L.flight.carrier, `${IFIELD.flightCarrier}[${i}]`),
        number: optText(number![i], L.flight.number, `${IFIELD.flightNumber}[${i}]`),
      });
    }
    if (flights.length > L.flights) fields.push(IFIELD.flightFrom);
  }

  const listOf = (name: string): string[] => {
    const out: string[] = [];
    col(name).forEach((raw, i) => {
      const v = line(raw);
      if (v === '') return;
      if (!isText(v, L.listItem)) fields.push(`${name}[${i}]`);
      else out.push(v);
    });
    if (out.length > L.lists) fields.push(name);
    return out;
  };
  const inclusions = listOf(IFIELD.inclusion);
  const exclusions = listOf(IFIELD.exclusion);

  const coverWord = optText(value(formData, IFIELD.coverWord), L.coverWord, IFIELD.coverWord);
  const country = optText(value(formData, IFIELD.country), L.country, IFIELD.country);
  const category = optText(value(formData, IFIELD.category), L.category, IFIELD.category);
  const roomBasis = optText(value(formData, IFIELD.roomBasis), L.roomBasis, IFIELD.roomBasis);
  const introRaw = value(formData, IFIELD.introduction).replace(/\r\n/g, '\n');
  if (introRaw !== '' && !isText(introRaw, L.introduction)) fields.push(IFIELD.introduction);
  const introduction = introRaw === '' ? null : introRaw;
  const pointsOf = (name: string, max: number): string[] => {
    const out: string[] = [];
    col(name).forEach((raw, i) => {
      const v = line(raw);
      if (v === '') return;
      if (!isText(v, L.point)) fields.push(`${name}[${i}]`);
      else out.push(v);
    });
    if (out.length > max) fields.push(name);
    return out;
  };
  const reasons = pointsOf(IFIELD.reason, L.reasons);
  const handledByUs = pointsOf(IFIELD.handledByUs, L.handledByUs);
  const youBring = pointsOf(IFIELD.youBring, L.youBring);

  let provenance: Record<string, FactProvenance> = {};
  const provRaw = value(formData, IFIELD.provenance);
  if (provRaw !== '') {
    try {
      const parsed = JSON.parse(provRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length > L.provenance) throw new Error('size');
      for (const [path, origin] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_.[\]-]{0,119}$/.test(path) || !(FACT_PROVENANCES as readonly unknown[]).includes(origin)) throw new Error('entry');
      }
      provenance = Object.fromEntries(entries) as Record<string, FactProvenance>;
    } catch {
      fields.push(IFIELD.provenance);
    }
  }

  return done(fields, () => ({
    documentId: documentId!,
    draftId: draftId!,
    expectedRowVersion: expectedRowVersion!,
    sourceFileId,
    facts: {
      destination,
      startDate,
      endDate,
      party,
      stays,
      days,
      transfers,
      activities,
      flights,
      inclusions,
      exclusions,
      coverWord,
      country,
      category,
      roomBasis,
      introduction,
      reasons,
      handledByUs,
      youBring,
      provenance,
    },
  }));
}

export interface AcknowledgeForm {
  documentId: string;
  differenceId: string;
  choice: Exclude<DifferenceChoice, 'use_basis'>;
  note: string | null;
}
/** keep_itinerary (note optional) or note (note required). use_basis is not an acknowledgement (the screen edits the fact). */
export function parseAcknowledgeForm(formData: FormData): ParsedForm<AcknowledgeForm> {
  const fields: string[] = [];
  const documentId = readUuid(formData, IFIELD.documentId);
  if (!documentId) fields.push(IFIELD.documentId);
  const differenceId = readUuid(formData, IFIELD.differenceId);
  if (!differenceId) fields.push(IFIELD.differenceId);
  const raw = value(formData, IFIELD.choice);
  const choice = (DIFFERENCE_CHOICES as readonly string[]).includes(raw) && raw !== 'use_basis' ? (raw as AcknowledgeForm['choice']) : null;
  if (!choice) fields.push(IFIELD.choice);
  const noteRaw = value(formData, IFIELD.note);
  if (noteRaw !== '' && !isText(noteRaw, DIFFERENCE_NOTE_MAX)) fields.push(IFIELD.note);
  if (choice === 'note' && noteRaw === '') fields.push(IFIELD.note);
  return done(fields, () => ({ documentId: documentId!, differenceId: differenceId!, choice: choice!, note: noteRaw === '' ? null : noteRaw }));
}

export interface DraftRowForm {
  documentId: string;
  draftId: string;
  expectedRowVersion: number;
}
export function parseDraftRowForm(formData: FormData): ParsedForm<DraftRowForm> {
  const fields: string[] = [];
  const documentId = readUuid(formData, IFIELD.documentId);
  if (!documentId) fields.push(IFIELD.documentId);
  const draftId = readUuid(formData, IFIELD.draftId);
  if (!draftId) fields.push(IFIELD.draftId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(IFIELD.rowVersion);
  return done(fields, () => ({ documentId: documentId!, draftId: draftId!, expectedRowVersion: expectedRowVersion! }));
}

export interface DocumentForm {
  documentId: string;
}
export function parseDocumentForm(formData: FormData): ParsedForm<DocumentForm> {
  const documentId = readUuid(formData, IFIELD.documentId);
  return documentId ? { ok: true, value: { documentId } } : { ok: false, fields: [IFIELD.documentId] };
}

export interface RenderForm {
  documentId: string;
  kind: RenderKind;
}
export function parseRenderForm(formData: FormData): ParsedForm<RenderForm> {
  const fields: string[] = [];
  const documentId = readUuid(formData, IFIELD.documentId);
  if (!documentId) fields.push(IFIELD.documentId);
  const raw = value(formData, IFIELD.renderKind);
  const kind = (RENDER_KINDS as readonly string[]).includes(raw) ? (raw as RenderKind) : null;
  if (!kind) fields.push(IFIELD.renderKind);
  return done(fields, () => ({ documentId: documentId!, kind: kind! }));
}

export interface SourceRemoveForm {
  documentId: string;
  fileId: string;
}
export function parseSourceRemoveForm(formData: FormData): ParsedForm<SourceRemoveForm> {
  const fields: string[] = [];
  const documentId = readUuid(formData, IFIELD.documentId);
  if (!documentId) fields.push(IFIELD.documentId);
  const fileId = readUuid(formData, IFIELD.fileId);
  if (!fileId) fields.push(IFIELD.fileId);
  return done(fields, () => ({ documentId: documentId!, fileId: fileId! }));
}

/** Customer-facing strings of the facts with their form input names (for the save-time safety scan). */
export function factsCustomerText(facts: ItineraryFacts): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const add = (field: string, t: string | null) => {
    if (t) out.push({ field, text: t });
  };
  add(IFIELD.destination, facts.destination);
  facts.stays.forEach((s, i) => {
    add(`${IFIELD.stayCity}[${i}]`, s.city);
    add(`${IFIELD.stayHotelName}[${i}]`, s.hotelName);
    add(`${IFIELD.stayRoomType}[${i}]`, s.roomType);
    add(`${IFIELD.stayMealPlan}[${i}]`, s.mealPlan);
  });
  facts.days.forEach((d, i) => {
    add(`${IFIELD.dayBase}[${i}]`, d.base);
    add(`${IFIELD.dayTitle}[${i}]`, d.title);
    add(`${IFIELD.dayStory}[${i}]`, d.story);
    add(`${IFIELD.dayMeals}[${i}]`, d.meals);
    d.highlights.forEach((h) => add(`${IFIELD.dayHighlights}[${i}]`, h));
  });
  facts.transfers.forEach((t, i) => {
    add(`${IFIELD.transferFrom}[${i}]`, t.from);
    add(`${IFIELD.transferTo}[${i}]`, t.to);
    add(`${IFIELD.transferMode}[${i}]`, t.mode);
  });
  facts.activities.forEach((a, i) => {
    add(`${IFIELD.activityCity}[${i}]`, a.city);
    add(`${IFIELD.activityName}[${i}]`, a.name);
  });
  facts.flights.forEach((f, i) => {
    add(`${IFIELD.flightFrom}[${i}]`, f.from);
    add(`${IFIELD.flightTo}[${i}]`, f.to);
    add(`${IFIELD.flightCarrier}[${i}]`, f.carrier);
  });
  facts.inclusions.forEach((t, i) => add(`${IFIELD.inclusion}[${i}]`, t));
  facts.exclusions.forEach((t, i) => add(`${IFIELD.exclusion}[${i}]`, t));
  add(IFIELD.coverWord, facts.coverWord);
  add(IFIELD.country, facts.country);
  add(IFIELD.category, facts.category);
  add(IFIELD.roomBasis, facts.roomBasis);
  add(IFIELD.introduction, facts.introduction);
  facts.reasons.forEach((t, i) => add(`${IFIELD.reason}[${i}]`, t));
  facts.handledByUs.forEach((t, i) => add(`${IFIELD.handledByUs}[${i}]`, t));
  facts.youBring.forEach((t, i) => add(`${IFIELD.youBring}[${i}]`, t));
  return out;
}

export interface UseBasisForm {
  documentId: string;
  path: string;
  kind: 'missing' | 'different' | 'extra';
}
const DIFFERENCE_KINDS = ['missing', 'different', 'extra'] as const;
/** "Use the quotation or booking value" for one difference (path and kind together). */
export function parseUseBasisForm(formData: FormData): ParsedForm<UseBasisForm> {
  const fields: string[] = [];
  const documentId = readUuid(formData, IFIELD.documentId);
  if (!documentId) fields.push(IFIELD.documentId);
  const path = value(formData, IFIELD.path);
  if (!/^[A-Za-z][A-Za-z0-9_.[\]-]{0,119}$/.test(path)) fields.push(IFIELD.path);
  const kind = value(formData, IFIELD.differenceKind);
  if (!(DIFFERENCE_KINDS as readonly string[]).includes(kind)) fields.push(IFIELD.differenceKind);
  return done(fields, () => ({ documentId: documentId!, path, kind: kind as UseBasisForm['kind'] }));
}
