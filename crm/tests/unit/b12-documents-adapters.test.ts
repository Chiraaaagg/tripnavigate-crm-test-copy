import { describe, expect, it } from 'vitest';
import { GST_TEXT, NOT_TAX_INVOICE_TEXT, type QuoteDocumentInput } from '@/modules/documents/contracts';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { QUOTATION_PREVIEW_TEXT, quotationDayPlanNotice, quotationToEngineQuote } from '@/modules/documents/quotation-adapter';
import { scanStrings } from '@/modules/documents/safety';
import { itineraryView, quotationView } from './b12-documents-fixtures';

/** B1.2 Phase F groundwork: engine adapters. Synthetic values only. */

function okInput(r: ReturnType<typeof quotationToEngineQuote>): QuoteDocumentInput {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusals)}`);
  return r.input;
}

describe('quotationToEngineQuote', () => {
  it('maps the view: whole rupees, exact per person, GST as applicable, no GST amount, not a tax invoice', () => {
    const r = quotationToEngineQuote(quotationView());
    expect(r.ok).toBe(true);
    const q = okInput(r);
    expect(q.price).toEqual({
      perPerson: 60000,
      paxCount: 4,
      total: 240000,
      totalWords: 'Two Lakh Forty Thousand Rupees',
      gstText: GST_TEXT,
      notTaxInvoice: NOT_TAX_INVOICE_TEXT,
      categories: [
        { k: 'Hotels', note: 'Hotels, 5 nights', amt: 150000 },
        { k: 'Flights', note: 'Return flights', amt: 90000 },
      ],
    });
    expect(JSON.stringify(q)).not.toMatch(/gstAmount/);
    expect(q.trip).toMatchObject({ nights: 5, days: 6, cities: ['Dubai', 'Abu Dhabi'], start: '20 Nov', end: '25 Nov' });
    expect(q.stay.map((s) => s.nights)).toEqual([3, 2]);
    expect(q.tiers).toEqual([{ name: 'As quoted', label: 'Deluxe · double sharing', quoted: true, hotels: ['Synthetic Marina Hotel', '[Hotel name]'], perPerson: 60000, total: 240000 }]);
    expect(q.payment).toEqual([
      { k: 'Deposit', amt: 50000, when: 'On acceptance' },
      { k: 'Balance', amt: 190000, when: '30 days before departure' },
    ]);
    expect(q.covers).toContainEqual({ k: 'Visas', in: false });
    expect(forbiddenKeyPaths(q)).toEqual([]);
    expect(scanStrings(q)).toEqual([]);
  });

  it('lists every placeholder (they block sending) and notes single tier and missing day plan', () => {
    const r = quotationToEngineQuote(quotationView());
    if (!r.ok) throw new Error('refused');
    expect(r.placeholders).toEqual([
      'Hotel name', 'Room type', 'Hotel rating and area',
      'Departure time', 'Arrival time', 'Baggage allowance',
      'Hotel name',
      'Consultant phone',
    ]);
    expect(r.internalNotes).toEqual(['single_tier', 'day_plan_missing']);
  });

  it('refuses an amount with paise, never rounds', () => {
    const v = quotationView();
    v.tiers[0]!.quotedTotalPaise = '24000050';
    const r = quotationToEngineQuote(v);
    expect(r).toEqual({ ok: false, refusals: [{ code: 'amount_has_paise', path: 'tiers[0].quotedTotalPaise' }] });
    const plan = quotationView();
    plan.tiers[0]!.plan[0]!.amountPaise = '5000001';
    expect(quotationToEngineQuote(plan)).toMatchObject({ ok: false, refusals: [{ code: 'amount_has_paise', path: 'tiers.quoted.plan[0].amountPaise' }] });
  });

  it('prints no per-person price when it is not exact; refuses a per-person that does not match', () => {
    const v = quotationView();
    v.tiers[0]!.quotedTotalPaise = '10000000';
    v.tiers[0]!.payingTravellers = 3;
    v.tiers[0]!.perPersonPaise = null;
    v.tiers[0]!.breakdownHasAmounts = false;
    v.tiers[0]!.plan = [];
    const r = quotationToEngineQuote({ ...v, pax: { ...v.pax, childrenNoBed: 0 } });
    if (!r.ok) throw new Error('refused');
    expect(r.input.price.perPerson).toBeNull();
    expect(r.input.price.categories.every((c) => c.amt === null)).toBe(true);
    expect(r.internalNotes).toContain('per_person_not_printed');

    const wrong = quotationView();
    wrong.tiers[0]!.perPersonPaise = '7000000';
    expect(quotationToEngineQuote(wrong)).toMatchObject({ ok: false, refusals: [{ code: 'amount_invalid', path: 'tiers[0].perPersonPaise' }] });
  });

  it('puts the quoted tier first and keeps an upgrade tier', () => {
    const v = quotationView();
    v.tiers = [{ ...v.tiers[0]!, tierKey: 'upgrade', label: 'Luxury', quotedTotalPaise: '30000000', perPersonPaise: '7500000', plan: [] }, v.tiers[0]!];
    const q = okInput(quotationToEngineQuote(v));
    expect(q.tiers.map((t) => [t.name, t.quoted, t.total])).toEqual([['As quoted', true, 240000], ['Upgrade', false, 300000]]);
  });

  it('refuses a missing quoted tier, bad stay dates and nights that disagree with the trip', () => {
    expect(quotationToEngineQuote(quotationView({ tiers: [] }))).toMatchObject({ ok: false, refusals: [{ code: 'tier_missing' }] });
    const v = quotationView();
    v.stays[1]!.checkOut = '2026-11-23';
    expect(quotationToEngineQuote(v)).toMatchObject({ ok: false, refusals: [{ code: 'dates_invalid', path: 'stays[1]' }, { code: 'nights_mismatch' }] });
    expect(quotationToEngineQuote(quotationView({ trip: { title: 'x', destination: null, start: '2026-11-20', end: '2026-11-26' } }))).toMatchObject({
      ok: false, refusals: [{ code: 'nights_mismatch', path: 'stays' }],
    });
  });

  it('the day-by-day plan is optional and may be a summary: a note and a preview notice, never a refusal', () => {
    const one = quotationView({ days: [{ day: 1, city: null, title: 'Arrive', text: 'Check in and rest.' }] });
    const r = quotationToEngineQuote(one);
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.input.days).toEqual([{ n: 1, city: null, t: 'Arrive', d: 'Check in and rest.' }]);
    expect(r.internalNotes).toContain('day_plan_partial');
    expect(r.placeholders).not.toContain('City');
    expect(quotationDayPlanNotice(one, r.input)).toBe('Day plan covers 1 of 6 days. Fine for a summary; the itinerary carries the full plan.');

    const none = quotationToEngineQuote(quotationView());
    if (!none.ok) throw new Error('refused');
    expect(none.input.days).toEqual([]);
    expect(quotationDayPlanNotice(quotationView(), none.input)).toBe(QUOTATION_PREVIEW_TEXT.dayPlanNone);

    const fullView = quotationView({ days: Array.from({ length: 6 }, (_, i) => ({ day: i + 1, city: 'Dubai', title: `Day ${i + 1}`, text: 'Synthetic.' })) });
    const full = quotationToEngineQuote(fullView);
    if (!full.ok) throw new Error('refused');
    expect(quotationDayPlanNotice(fullView, full.input)).toBeNull();
    expect(full.internalNotes).not.toContain('day_plan_partial');

    // A title-only day (null text read as '') prints the text as a placeholder; days past the trip are not counted.
    const odd = quotationView({ days: [{ day: 2, city: null, title: 'Desert', text: '' }, { day: 9, city: null, title: 'Extra', text: 'Synthetic.' }] });
    const o = quotationToEngineQuote(odd);
    if (!o.ok) throw new Error('refused');
    expect(o.placeholders).toContain('Day plan');
    expect(quotationDayPlanNotice(odd, o.input)).toBe('Day plan covers 1 of 6 days. Fine for a summary; the itinerary carries the full plan.');
  });

  it('refuses a view carrying a commercial or internal key', () => {
    const leaky = { ...quotationView(), tiers: [{ ...quotationView().tiers[0]!, marginPaise: '100' }] } as never;
    expect(quotationToEngineQuote(leaky)).toEqual({ ok: false, refusals: [{ code: 'forbidden_field', path: 'tiers[0].marginPaise' }] });
  });

  it('refuses unsafe customer text with the place and the list phrase only', () => {
    const r = quotationToEngineQuote(quotationView({ includes: ['Desert safari', 'Best price on the dhow cruise'], excludes: ['Our net rate excludes tips'] }));
    expect(r).toEqual({
      ok: false,
      refusals: [
        { code: 'unsafe_text', path: 'includes[1]', detail: 'sales_pressure:best price' },
        { code: 'unsafe_text', path: 'excludes[0]', detail: 'internal_rate:net rate' },
      ],
    });
  });

  it('neutralises customer text that starts with "[" so it never prints as a placeholder', () => {
    const r = quotationToEngineQuote(quotationView({ includes: ['[Optional] dhow dinner'] }));
    if (!r.ok) throw new Error('refused');
    expect(r.input.includes).toEqual(['(Optional) dhow dinner']);
    expect(r.placeholders).not.toContain('Optional');
  });
});

describe('itineraryToEngine', () => {
  it('maps confirmed facts without prices (recommended) and lists placeholders', () => {
    const r = itineraryToEngine(itineraryView());
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.input).toMatchObject({
      code: 'IT-7', days: 6, nights: 5, pickup: 'DXB Airport', drop: 'Abu Dhabi hotel', tiers: null,
      bases: [{ name: 'Dubai', nights: 3 }, { name: 'Abu Dhabi', nights: 2 }],
      hotels: [
        { city: 'Dubai', nights: 3, hotel: 'Synthetic Marina Hotel', room: 'Deluxe' },
        { city: 'Abu Dhabi', nights: 2, hotel: 'Synthetic Corniche Hotel', room: 'Deluxe' },
      ],
      moves: [{ day: '20 Nov', title: 'DXB Airport to Dubai hotel' }, { day: '20 Nov', title: 'Flight BOM to DXB' }, { day: '23 Nov', title: 'Dubai hotel to Abu Dhabi hotel' }],
      intro: ['A calm family week by the sea.'],
      weHandle: ['Every transfer'],
      youBring: [],
    });
    expect(r.internalNotes).toEqual(['prices_not_shown', 'day_plan_missing']);
    expect(r.placeholders).toContain('Day story');
    // Optional copy (cover word, country, category, room basis, introduction, reasons, what we
    // handle, what you bring) is never a placeholder; only core facts are.
    expect(r.placeholders).not.toContain('What you bring');
    expect(r.placeholders.every((p) => ['Day title', 'Day story', 'Base city', 'Hotel name', 'Room type', 'Pickup point', 'Drop point', 'Date'].includes(p))).toBe(true);
    expect(forbiddenKeyPaths(r.input)).toEqual([]);
  });

  it('prints prices only when given, in exact whole rupees', () => {
    const tier = { ...quotationView().tiers[0]! };
    const r = itineraryToEngine(itineraryView({ prices: [tier] }));
    if (!r.ok) throw new Error('refused');
    expect(r.input.tiers).toEqual([{ name: 'As quoted', total: 240000, perPerson: 60000 }]);
    expect(itineraryToEngine(itineraryView({ prices: [{ ...tier, quotedTotalPaise: '1' }] }))).toMatchObject({
      ok: false, refusals: [{ code: 'amount_has_paise', path: 'prices[0].quotedTotalPaise' }],
    });
  });

  it('refuses nights that disagree with dates and a wrong-length day plan', () => {
    const v = itineraryView();
    v.facts.stays[0]!.nights = 4;
    expect(itineraryToEngine(v)).toMatchObject({ ok: false, refusals: [{ code: 'nights_mismatch', path: 'facts.stays[0]' }, { code: 'nights_mismatch', path: 'facts.stays' }] });
    const d = itineraryView();
    d.facts.days = [{ n: 1, date: null, base: 'Dubai', title: 'Arrive', story: 'Check in.', highlights: [], meals: null }];
    expect(itineraryToEngine(d)).toMatchObject({ ok: false, refusals: [{ code: 'days_mismatch' }] });
  });

  it('runs the content-safety scan on the itinerary too', () => {
    const v = itineraryView({ narrative: { intro: ['Hurry, last chance for this deal'], reasons: null, weHandle: null, youBring: null } });
    const r = itineraryToEngine(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.detail)).toEqual(['sales_pressure:last chance', 'sales_pressure:hurry']);
  });
});
