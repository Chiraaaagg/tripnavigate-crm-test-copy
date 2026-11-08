import { describe, expect, it } from 'vitest';
import { applyBasisValue } from '@/modules/itineraries/apply-basis';
import { factsPayload, ItineraryGetSchema, mapItineraryError } from '@/modules/itineraries/commands';
import { DOCX_MIME, EMPTY_ITINERARY_FACTS, ITINERARY_FACT_LIMITS } from '@/modules/itineraries/contracts';
import { differenceLabel, toItineraryEditorView } from '@/modules/itineraries/dto';
import { checkSourceFile, sanitizeSourceFileName, sniffSourceMime, stableHash } from '@/modules/itineraries/files';
import { factsCustomerText, IFIELD, parseAcknowledgeForm, parseItineraryFactsForm } from '@/modules/itineraries/forms';
import { ItineraryFactsSchema } from '@/modules/itineraries/commands';

/**
 * Itinerary TS layer, pure parts: the facts form (parallel rows, no money
 * keys, provenance), source-file checks (incl. the .docx package), the
 * facts payload the database expects, refusal mapping, difference labels
 * (paths only, never values) and the editor flags. Synthetic values.
 */

const DOC = 'c1000000-0000-4000-8000-000000000001';
const DRAFT = 'c2000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

const zip = (withWord: boolean) => {
  const head = [0x50, 0x4b, 0x03, 0x04, 0, 0];
  const body = new TextEncoder().encode(withWord ? '[Content_Types].xml ... word/document.xml ...' : '[Content_Types].xml ... xl/workbook.xml');
  return new Uint8Array([...head, ...body]);
};

describe('facts form', () => {
  const base = { documentId: DOC, draftId: DRAFT, rowVersion: '2' };

  it('reads single values, rows (blank rows skipped, days numbered by position), highlights by line and provenance', () => {
    const parsed = parseItineraryFactsForm(
      form({
        ...base,
        destination: ' Goa ',
        startDate: '2026-12-10',
        endDate: '2026-12-13',
        adults: '2',
        children: '1',
        childAges: '9',
        stayCity: ['Goa', ''],
        stayNights: ['3', ''],
        stayHotelName: ['Sea View', ''],
        dayTitle: ['Arrive', '', 'Beach day'],
        dayStory: ['Check in and rest.', '', ''],
        dayHighlights: ['Sunset walk\nDinner', '', ''],
        transferFrom: ['GOI'],
        transferTo: ['Sea View'],
        activityName: ['Boat ride'],
        activityIncluded: ['yes'],
        inclusion: ['Breakfast', ' '],
        provenance: JSON.stringify({ destination: 'quotation', 'stays[1].hotelName': 'manual' }),
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const f = parsed.value.facts;
    expect(f).toMatchObject({ destination: 'Goa', startDate: '2026-12-10', party: { adults: 2, children: 1, childAges: [9], infants: null }, inclusions: ['Breakfast'] });
    expect(f.stays).toEqual([{ city: 'Goa', nights: 3, checkIn: null, checkOut: null, hotelName: 'Sea View', roomType: null, mealPlan: null, rooms: null }]);
    expect(f.days.map((d) => [d.n, d.title, d.highlights])).toEqual([
      [1, 'Arrive', ['Sunset walk', 'Dinner']],
      [2, 'Beach day', []],
    ]);
    expect(f.activities).toEqual([{ date: null, city: null, name: 'Boat ride', included: true }]);
    expect(f.provenance).toEqual({ destination: 'quotation', 'stays[1].hotelName': 'manual' });
  });

  it('names every bad input; no age bands beyond 0–17; bad provenance refused', () => {
    expect(parseItineraryFactsForm(form({ ...base, startDate: '2026-12-10', endDate: '2026-12-01', childAges: '4, 18', stayCity: ['Goa'], stayNights: ['0'], provenance: '{"x":"guess"}' }))).toEqual({
      ok: false,
      fields: ['endDate', 'childAges', 'stayNights[0]', 'provenance'],
    });
  });

  it('customer text for the safety scan covers names, stories, lists; never flight numbers or provenance', () => {
    const fields = factsCustomerText({
      ...EMPTY_ITINERARY_FACTS,
      destination: 'Goa',
      days: [{ n: 1, date: null, base: null, title: 'Arrive', story: 'Rest', highlights: ['Walk'], meals: null }],
      flights: [{ date: null, from: 'JDH', to: 'GOI', carrier: 'Synthetic Air', number: 'HK1' }],
      inclusions: ['Breakfast'],
      provenance: { destination: 'manual' },
    }).map((t) => t.field);
    expect(fields).toEqual(['destination', 'dayTitle[0]', 'dayStory[0]', 'dayHighlights[0]', 'flightFrom[0]', 'flightTo[0]', 'flightCarrier[0]', 'inclusion[0]']);
  });

  it('acknowledge: keep (note optional) or note (note required); use_basis is not an acknowledgement', () => {
    const d = 'c3000000-0000-4000-8000-000000000001';
    expect(parseAcknowledgeForm(form({ documentId: DOC, differenceId: d, choice: 'keep_itinerary' }))).toMatchObject({ ok: true, value: { choice: 'keep_itinerary', note: null } });
    expect(parseAcknowledgeForm(form({ documentId: DOC, differenceId: d, choice: 'note' }))).toEqual({ ok: false, fields: ['note'] });
    expect(parseAcknowledgeForm(form({ documentId: DOC, differenceId: d, choice: 'use_basis' }))).toEqual({ ok: false, fields: ['choice'] });
  });
});

describe('source files', () => {
  it('a .docx must be a ZIP package with the Word body part; type, bytes and size must agree', () => {
    expect(sniffSourceMime(zip(true))).toBe(DOCX_MIME);
    expect(sniffSourceMime(zip(false))).toBeNull();
    expect(checkSourceFile({ bytes: zip(true), declaredMime: DOCX_MIME, fileName: 'Goa plan (final).docx' })).toMatchObject({ ok: true, mime: DOCX_MIME, fileName: 'Goa plan _final_.docx' });
    expect(checkSourceFile({ bytes: zip(false), declaredMime: DOCX_MIME, fileName: 'x.docx' })).toEqual({ ok: false, reason: 'content_mismatch' });
    expect(checkSourceFile({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), declaredMime: 'application/pdf', fileName: 'a.pdf' })).toMatchObject({ ok: true });
    expect(checkSourceFile({ bytes: zip(true), declaredMime: 'application/zip', fileName: 'a.zip' })).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(checkSourceFile({ bytes: new Uint8Array(0), declaredMime: 'application/pdf', fileName: 'a.pdf' })).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeSourceFileName('', 'application/pdf')).toBe('itinerary.pdf');
  });

  it('the render input hash is stable regardless of key order', () => {
    expect(stableHash({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(stableHash({ a: [{ x: 1, y: 2 }], b: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});

describe('payload, refusals, labels, editor view', () => {
  it('the facts payload leaves out empty values and lists (all keys optional, unknown keys refused by the database)', () => {
    expect(factsPayload({ ...EMPTY_ITINERARY_FACTS, destination: 'Goa', party: { adults: 2, children: null, childAges: [], infants: null }, stays: [{ city: 'Goa', nights: 3, checkIn: null, checkOut: null, hotelName: null, roomType: null, mealPlan: null, rooms: null }] })).toEqual({
      destination: 'Goa',
      party: { adults: 2 },
      stays: [{ city: 'Goa', nights: 3 }],
    });
    expect(factsPayload(EMPTY_ITINERARY_FACTS)).toEqual({});
  });

  it('refusals map by token AND state', () => {
    expect(mapItineraryError({ code: '40001', message: 'basis_changed' })).toBe('basis_changed');
    expect(mapItineraryError({ code: '55000', message: 'differences_open' })).toBe('differences_open');
    expect(mapItineraryError({ code: '55000', message: 'basis_changed' })).toBeNull();
  });

  it('difference labels are words from the path (never values)', () => {
    expect(differenceLabel('stays[1].hotelName')).toBe('Stay 2 · hotel');
    expect(differenceLabel('activities[0]')).toBe('Activity 1');
    expect(differenceLabel('party.adults')).toBe('Travellers · adults');
    expect(differenceLabel('startDate')).toBe('Start date');
  });

  it('editor flags: ready needs a current check with nothing open; final needs ready', () => {
    const record = (over: Record<string, unknown> = {}, draft: Record<string, unknown> = {}) =>
      ItineraryGetSchema.parse({
        documentId: DOC,
        title: 'Goa itinerary',
        subject: { kind: 'quotation', quotationId: 'a1000000-0000-4000-8000-000000000001', dealId: null },
        draft: { draftId: DRAFT, status: 'draft', rowVersion: 3, facts: { destination: 'Goa' }, factsHash: HASH, sourceFileId: null, updatedAt: null, ...draft },
        basis: { kind: 'quotation_version', id: 'a2000000-0000-4000-8000-000000000001', hash: HASH },
        differences: { runId: null, current: false, items: [] },
        sources: [],
        jobs: [{ jobId: 'c4000000-0000-4000-8000-000000000001', kind: 'preview', status: 'queued', attempts: 0, lastErrorCode: null, createdAt: '2026-10-12T08:00:00Z', finishedAt: null }],
        rendered: [],
        ...over,
      });
    const unchecked = toItineraryEditorView(record());
    expect(unchecked).toMatchObject({ canMarkReady: false, canRequestFinal: false, canRequestPreview: true, nextStepText: expect.stringContaining('Check the differences') });
    // I-07 (§14 #2): the queued text never claims the PDF maker is off.
    expect(unchecked.jobs[0]!.statusText).toBe('Waiting for the PDF maker. Nothing is sent to the customer.');
    expect(unchecked.jobs[0]!.statusText).not.toMatch(/not switched on/);
    const open = toItineraryEditorView(record({ differences: { runId: 'c5000000-0000-4000-8000-000000000001', current: true, items: [{ differenceId: 'c3000000-0000-4000-8000-000000000001', path: 'stays[1].hotelName', kind: 'different', acknowledged: false, acknowledgedByName: null, acknowledgedAt: null, note: null }] } }));
    expect(open).toMatchObject({ canMarkReady: false, differences: { openCount: 1, items: [{ label: 'Stay 2 · hotel' }] } });
    const clean = toItineraryEditorView(record({ differences: { runId: 'c5000000-0000-4000-8000-000000000001', current: true, items: [] } }));
    expect(clean).toMatchObject({ canMarkReady: true, canRequestFinal: false });
    const ready = toItineraryEditorView(record({ differences: { runId: 'c5000000-0000-4000-8000-000000000001', current: true, items: [] } }, { status: 'ready' }));
    expect(ready).toMatchObject({ canMarkReady: false, canRequestFinal: true });

    // DEC-50 review: the made-documents list names the company GSTIN mark instead of counting it as a fact.
    const made = (branchCode: string | null, placeholders: number) =>
      toItineraryEditorView(
        record({
          subject: { kind: 'quotation', quotationId: 'a1000000-0000-4000-8000-000000000001', dealId: null, branchCode },
          rendered: [{ renderedId: 'c7000000-0000-4000-8000-000000000001', kind: 'preview', pageCount: 3, sizeBytes: 5000, createdAt: '2026-10-13T08:00:00Z', qa: { placeholders, layoutIssues: [], safetyHits: [] } }],
          jobs: [{ jobId: 'c4000000-0000-4000-8000-000000000001', kind: 'final', status: 'failed', attempts: 1, lastErrorCode: 'placeholders_present', createdAt: '2026-10-13T08:00:00Z', finishedAt: '2026-10-13T08:01:00Z' }],
        }),
      );
    const del = made('DEL', 3);
    expect(del.rendered[0]!.qaNote).toBe('2 missing facts in brackets · company GSTIN not approved');
    expect(del.jobs[0]!.errorText).toMatch(/^The company GSTIN for Delhi is not approved yet\. Ask Accounts/);
    expect(made('DEL', 1).rendered[0]!.qaNote).toBe('company GSTIN not approved');
    expect(made('JDH', 1).rendered[0]!.qaNote).toBe('1 missing fact in brackets');
    expect(made(null, 1).rendered[0]!.qaNote).toBe('company GSTIN not printed (branch not known)');
  });
});

describe('applyBasisValue (use the quotation or booking value)', () => {
  const facts = {
    ...EMPTY_ITINERARY_FACTS,
    destination: 'Goa',
    party: { adults: 2, children: null, childAges: [], infants: null },
    stays: [{ city: 'Goa', nights: 3, checkIn: null, checkOut: null, hotelName: 'Sea View', roomType: null, mealPlan: null, rooms: null }],
    activities: [
      { date: null, city: 'Goa', name: 'Boat ride', included: true },
      { date: null, city: 'Goa', name: 'Spa', included: false },
    ],
    inclusions: ['Breakfast'],
  };

  it('scalar and field paths take the basis value and are marked for provenance', () => {
    expect(applyBasisValue(facts, { path: 'destination', kind: 'different' }, 'North Goa')).toMatchObject({ facts: { destination: 'North Goa' }, provenancePath: 'destination' });
    expect(applyBasisValue(facts, { path: 'party.adults', kind: 'different' }, 3)?.facts.party.adults).toBe(3);
    expect(applyBasisValue(facts, { path: 'stays[0].hotelName', kind: 'different' }, 'Beach Resort')?.facts.stays[0]!.hotelName).toBe('Beach Resort');
  });

  it('a missing row is appended from the basis; an extra row is removed; days renumbered', () => {
    const added = applyBasisValue(facts, { path: 'activities[0]', kind: 'missing' }, { date: '2026-12-11', city: 'Goa', name: 'Fort visit', included: true });
    expect(added).toMatchObject({ provenancePath: 'activities[2]' });
    expect(added!.facts.activities.map((a) => a.name)).toEqual(['Boat ride', 'Spa', 'Fort visit']);
    const removed = applyBasisValue(facts, { path: 'activities[1]', kind: 'extra' }, undefined);
    expect(removed).toMatchObject({ provenancePath: null });
    expect(removed!.facts.activities.map((a) => a.name)).toEqual(['Boat ride']);
    expect(applyBasisValue(facts, { path: 'inclusions[0]', kind: 'missing' }, 'Airport transfers')!.facts.inclusions).toEqual(['Breakfast', 'Airport transfers']);
  });

  it('never guesses: missing value, unknown path, out-of-range index or a value that breaks the facts rules → null', () => {
    expect(applyBasisValue(facts, { path: 'destination', kind: 'different' }, undefined)).toBeNull();
    expect(applyBasisValue(facts, { path: 'priceTotal', kind: 'different' }, '1')).toBeNull();
    expect(applyBasisValue(facts, { path: 'stays[5].hotelName', kind: 'different' }, 'X')).toBeNull();
    expect(applyBasisValue(facts, { path: 'party.adults', kind: 'different' }, 500)).toBeNull();
    expect(applyBasisValue(facts, { path: 'activities[0]', kind: 'missing' }, 'not a row')).toBeNull();
  });
});

describe('document wording facts (cover word, country, category, room basis, introduction, points)', () => {
  const base = { documentId: 'c1000000-0000-4000-8000-000000000001', draftId: 'c2000000-0000-4000-8000-000000000001', rowVersion: '2' };
  const wordingForm = (extra: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...extra })) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
    return f;
  };

  it('reads the wording (introduction keeps line breaks; blank points skipped) and scans every piece of it', () => {
    const parsed = parseItineraryFactsForm(
      wordingForm({
        [IFIELD.coverWord]: ' Kerala ',
        [IFIELD.country]: 'India',
        [IFIELD.category]: 'Family holiday',
        [IFIELD.roomBasis]: 'Twin sharing',
        [IFIELD.introduction]: 'Welcome aboard.\r\nSlow days by the backwaters.',
        [IFIELD.reason]: ['Houseboat night', ''],
        [IFIELD.handledByUs]: ['Airport transfers'],
        [IFIELD.youBring]: ['Passport', 'Comfortable shoes'],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.facts).toMatchObject({
      coverWord: 'Kerala',
      country: 'India',
      category: 'Family holiday',
      roomBasis: 'Twin sharing',
      introduction: 'Welcome aboard.\nSlow days by the backwaters.',
      reasons: ['Houseboat night'],
      handledByUs: ['Airport transfers'],
      youBring: ['Passport', 'Comfortable shoes'],
    });
    expect(factsCustomerText(parsed.value.facts).map((t) => t.field)).toEqual(
      expect.arrayContaining([IFIELD.coverWord, IFIELD.country, IFIELD.category, IFIELD.roomBasis, IFIELD.introduction, `${IFIELD.reason}[0]`, `${IFIELD.handledByUs}[0]`, `${IFIELD.youBring}[1]`]),
    );
  });

  it('names over-long wording inputs; payload and stored facts round-trip; difference labels use the words', () => {
    const bad = parseItineraryFactsForm(
      wordingForm({ [IFIELD.coverWord]: 'x'.repeat(ITINERARY_FACT_LIMITS.coverWord + 1), [IFIELD.youBring]: ['ok', 'y'.repeat(ITINERARY_FACT_LIMITS.point + 1)], [IFIELD.reason]: Array.from({ length: ITINERARY_FACT_LIMITS.reasons + 1 }, (_, i) => `Point ${i}`) }),
    );
    expect(bad).toEqual({ ok: false, fields: [IFIELD.coverWord, IFIELD.reason, `${IFIELD.youBring}[1]`] });
    const facts = { ...EMPTY_ITINERARY_FACTS, coverWord: 'Goa', reasons: ['Beaches'], youBring: [] };
    expect(factsPayload(facts)).toEqual({ coverWord: 'Goa', reasons: ['Beaches'] });
    expect(ItineraryFactsSchema.parse(factsPayload(facts))).toEqual(facts);
    expect(ItineraryFactsSchema.parse({ destination: 'Goa' })).toMatchObject({ coverWord: null, reasons: [], handledByUs: [], youBring: [] });
    expect(differenceLabel('handledByUs[1]')).toBe('We take care of 2');
    expect(differenceLabel('introduction')).toBe('Introduction');
  });
});
