import { describe, expect, it, vi } from 'vitest';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { ItineraryDocumentGetSchema, toItineraryDocumentView } from '@/modules/documents/itinerary-view';
import { quotationToEngineQuote } from '@/modules/documents/quotation-adapter';
import { QuotationGetSchema, toQuotationDocumentView } from '@/modules/documents/quotation-view';
import { BrandedItineraryTemplate, BrandedQuotationTemplate } from '@/modules/documents/render/branded-templates';
import { renderDocumentHtml } from '@/modules/documents/render/html';
import { adaptRenderJobInput } from '@/modules/documents/render/job-input';
import { PlainItineraryTemplate, PlainQuotationTemplate } from '@/modules/documents/render/plain-templates';
import { htmlToText } from '@/modules/documents/safety';
import { stableHash } from '@/modules/itineraries/files';
import { itineraryRenderInputForWorker, type ItineraryRenderInput } from '@/modules/itineraries/server/render-worker';
import { itineraryView, quotationView } from './b12-documents-fixtures';

/**
 * DEC-50: the approved company identity on customer documents. The branch
 * code comes from the read answers (Atlas 0800); Jodhpur prints in full,
 * Delhi and Ahmedabad (GSTIN not given yet) and an unknown branch print a
 * placeholder that blocks a final document. Approved company values only;
 * every other value is synthetic.
 */

/** The identity placeholders only (the unit fixtures leave other core facts open on purpose). */
const gstinOnly = (labels: string[]) => labels.filter((l) => l.startsWith('GSTIN'));

const JDH_LINE = 'Holiday Chacha Pvt Ltd · Regd. office: 59A, Babu Rajendra Marg, Masuria Colony, Baldev Nagar, Jodhpur, Rajasthan 342003 · PAN AAFCH9191M · GSTIN 08AAFCH9191M1ZV (Rajasthan)';

describe('adapters fill the identity from the view branch code', () => {
  it('quotation, Jodhpur: complete identity, no placeholder', () => {
    const r = quotationToEngineQuote(quotationView({ branchCode: 'JDH' }));
    if (!r.ok) throw new Error('refused');
    expect(r.input.identity).toEqual({
      legalName: 'Holiday Chacha Pvt Ltd',
      registeredAddress: '59A, Babu Rajendra Marg, Masuria Colony, Baldev Nagar, Jodhpur, Rajasthan 342003',
      pan: 'AAFCH9191M',
      gstin: '08AAFCH9191M1ZV',
      gstinState: 'Rajasthan',
    });
    expect(r.placeholders).not.toContain('GSTIN for Jodhpur');
    expect(r.placeholders.some((p) => p.startsWith('GSTIN'))).toBe(false);
  });

  it('quotation, Delhi: GSTIN placeholder, counted last', () => {
    const r = quotationToEngineQuote(quotationView({ branchCode: 'DEL' }));
    if (!r.ok) throw new Error('refused');
    expect(r.input.identity.gstin).toBe('[GSTIN for Delhi]');
    expect(r.input.identity.gstinState).toBe('Delhi');
    expect(r.placeholders.at(-1)).toBe('GSTIN for Delhi');
  });

  it('itinerary: Jodhpur has no placeholder at all; Ahmedabad and an unknown branch are blocked by one', () => {
    const jdh = itineraryToEngine(itineraryView({ branchCode: 'JDH' }));
    if (!jdh.ok) throw new Error('refused');
    expect(jdh.input.identity.gstin).toBe('08AAFCH9191M1ZV');
    expect(gstinOnly(jdh.placeholders)).toEqual([]);

    const amd = itineraryToEngine(itineraryView({ branchCode: 'AMD' }));
    if (!amd.ok) throw new Error('refused');
    expect(amd.input.identity.gstin).toBe('[GSTIN for Ahmedabad]');
    expect(gstinOnly(amd.placeholders)).toEqual(['GSTIN for Ahmedabad']);
    expect(amd.placeholders.at(-1)).toBe('GSTIN for Ahmedabad');

    const unknown = itineraryToEngine(itineraryView({ branchCode: null }));
    if (!unknown.ok) throw new Error('refused');
    expect(unknown.input.identity).toMatchObject({ gstin: '[GSTIN for branch]', gstinState: null });
    expect(gstinOnly(unknown.placeholders)).toEqual(['GSTIN for branch']);
  });
});

describe('templates print the statutory line', () => {
  it('branded quotation, Jodhpur: the full line, no placeholder on the page; fixed GST wording unchanged', () => {
    const r = quotationToEngineQuote(quotationView({ branchCode: 'JDH' }));
    if (!r.ok) throw new Error('refused');
    const doc = renderDocumentHtml(BrandedQuotationTemplate, { input: r.input }, { title: 't' });
    const text = htmlToText(doc.html);
    expect(text).toContain(JDH_LINE);
    expect(text).toContain('Quotation — not a tax invoice');
    expect(text).toContain('GST as applicable');
    expect(text).not.toContain('Holiday Chacha Pvt Ltd · TripNavigate');
    expect(doc.html).toContain('class="doc-legal"');
    expect([...doc.placeholders].sort()).toEqual([...r.placeholders].sort());
    expect(gstinOnly(doc.placeholders)).toEqual([]);
    expect(doc.safetyHits).toEqual([]);
  });

  it('branded itinerary, Delhi: the GSTIN is a visible fill the page check counts (final blocked)', () => {
    const r = itineraryToEngine(itineraryView({ branchCode: 'DEL' }));
    if (!r.ok) throw new Error('refused');
    const doc = renderDocumentHtml(BrandedItineraryTemplate, { input: r.input }, { title: 't' });
    expect(gstinOnly(doc.placeholders)).toEqual(['GSTIN for Delhi']);
    expect([...doc.placeholders].sort()).toEqual([...r.placeholders].sort());
    expect(doc.html).toContain('GSTIN <span class="fill">GSTIN for Delhi</span> (Delhi)');
    expect(htmlToText(doc.html)).toContain('PAN AAFCH9191M');
    expect(doc.safetyHits).toEqual([]);
  });

  it('plain templates carry the same line', () => {
    const q = quotationToEngineQuote(quotationView({ branchCode: 'JDH' }));
    const i = itineraryToEngine(itineraryView({ branchCode: 'AMD' }));
    if (!q.ok || !i.ok) throw new Error('refused');
    expect(htmlToText(renderDocumentHtml(PlainQuotationTemplate, { input: q.input }, { title: 't' }).html)).toContain(JDH_LINE);
    const plain = renderDocumentHtml(PlainItineraryTemplate, { input: i.input }, { title: 't' });
    expect(gstinOnly(plain.placeholders)).toEqual(['GSTIN for Ahmedabad']);
    expect(htmlToText(plain.html)).toContain('GSTIN GSTIN for Ahmedabad (Gujarat)');
  });
});

describe('read answers carry the branch code (Atlas 0800)', () => {
  const quotationGet = (subject: unknown) => ({
    reference: 'TQ-12', title: 'Synthetic trip',
    ...(subject === undefined ? {} : { subject }),
    version: { versionNo: 1, status: 'draft', validUntil: null, sentAt: null, acceptedTier: null },
    trip: { destination: 'UAE', start: null, end: null },
    pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 0, infants: 0 },
    content: null, tiers: [], items: [], contacts: null,
  });
  const ctx = { preparedBy: { name: 'Synthetic Consultant', role: 'Travel consultant', phone: null }, today: '2026-10-13' };

  it('quotation_get subject.branchCode reaches the view; absent or null reads as null', () => {
    const view = (subject: unknown) => toQuotationDocumentView(QuotationGetSchema.parse(quotationGet(subject)), null, ctx).branchCode;
    expect(view({ kind: 'lead', leadId: 'l1', dealId: null, branchCode: 'DEL' })).toBe('DEL');
    expect(view({ kind: 'lead', leadId: 'l1', dealId: null, branchCode: null })).toBeNull();
    expect(view({ kind: 'lead', leadId: 'l1', dealId: null })).toBeNull();
    expect(view(undefined)).toBeNull();
  });

  it('itinerary_render_input branchCode is parsed for the worker (absent reads as null)', async () => {
    const HASH = 'a'.repeat(64);
    const reply = (extra: object) => ({
      rpc: vi.fn().mockResolvedValue({
        data: { jobId: JOB, status: 'running', documentId: DOCUMENT, kind: 'final', templateVersion: 'itinerary-2', inputHash: HASH, factsHash: HASH, factsChanged: false, facts: {}, title: 'Synthetic', basis: { kind: 'none', id: null, hash: HASH }, money: null, ...extra },
        error: null,
      }),
    });
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, reply({ branchCode: 'JDH' }))).resolves.toMatchObject({ status: 'running', branchCode: 'JDH' });
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, reply({}))).resolves.toMatchObject({ status: 'running', branchCode: null });
  });
});

const JOB = '44444444-4444-4444-8444-444444444444';
const DOCUMENT = '55555555-5555-4555-8555-555555555555';
const TODAY = '2026-10-13';
const FACTS = {
  destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-22',
  party: { adults: 2, children: 0, childAges: null, infants: 0 },
  stays: [{ city: 'Dubai', nights: 2, checkIn: '2026-11-20', checkOut: '2026-11-22', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 1 }],
  days: [1, 2, 3].map((n) => ({ n, date: null, base: 'Dubai', title: `Day ${n}`, story: 'A calm synthetic day.', highlights: [], meals: null })),
  transfers: [{ date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' }],
  activities: [], flights: [], inclusions: ['Daily breakfast'], exclusions: ['Visa fees'], provenance: {},
};

describe('staff request and render worker print the same identity (same input hash)', () => {
  const staffHash = (branchCode: string | null) => {
    const get = ItineraryDocumentGetSchema.parse({
      documentId: DOCUMENT, title: 'Synthetic itinerary',
      subject: { kind: 'quotation', quotationId: '77777777-7777-4777-8777-777777777777', dealId: null, branchCode },
      draft: { draftId: '88888888-8888-4888-8888-888888888888', status: 'ready', rowVersion: 3, facts: FACTS, factsHash: 'f'.repeat(64), sourceFileId: null },
      basis: { kind: 'none', id: null, hash: '0'.repeat(64) }, differences: null, money: null,
    });
    const r = itineraryToEngine(toItineraryDocumentView(get, { today: TODAY }));
    if (!r.ok) throw new Error('refused');
    return { hash: stableHash(r.input), placeholders: r.placeholders };
  };
  const workerHash = (branchCode: string | null) => {
    const running: Extract<ItineraryRenderInput, { status: 'running' }> = {
      status: 'running', jobId: JOB, documentId: DOCUMENT, kind: 'final', templateVersion: 'itinerary-2', inputHash: '0'.repeat(64),
      factsHash: 'f'.repeat(64), factsChanged: false, basisChanged: false, facts: FACTS as never, title: 'Synthetic itinerary',
      basis: { kind: 'none', id: null, hash: '0'.repeat(64) }, money: null, branchCode,
    };
    const r = adaptRenderJobInput(JOB, running, TODAY);
    if (!r.ok) throw new Error('refused');
    return { hash: stableHash(r.input), placeholders: r.placeholders };
  };

  it('Jodhpur: equal hashes and no placeholder; Delhi: equal hashes with the GSTIN placeholder', () => {
    expect(workerHash('JDH')).toEqual(staffHash('JDH'));
    expect(staffHash('JDH').placeholders).toEqual([]);
    expect(workerHash('DEL')).toEqual(staffHash('DEL'));
    expect(staffHash('DEL').placeholders).toEqual(['GSTIN for Delhi']);
  });

  it('a different branch gives a different input (a final requested for another branch fails input_invalid)', () => {
    expect(workerHash('DEL').hash).not.toBe(staffHash('JDH').hash);
  });
});
