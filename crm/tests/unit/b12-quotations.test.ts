import { describe, expect, it } from 'vitest';
import { HOTEL_EXTRA_LABEL } from '@/modules/fulfilment/contracts';
import { parseServiceItemForm } from '@/modules/fulfilment/forms';
import { issuesFromHint, mapQuotationError, MoneySchema, QuotationListSchema } from '@/modules/quotations/commands';
import { QUOTATION_ERROR_STATES, QUOTATION_TEXT } from '@/modules/quotations/contracts';
import { toQuotationListView, toQuotationVersionView } from '@/modules/quotations/dto';
import {
  parseAcceptForm,
  parseCreateQuotationForm,
  parseQuotationContentForm,
  parseQuotationDetailsForm,
  parseQuotationItemForm,
  parseQuotationLinesForm,
  parseQuotationPlanForm,
  parseQuotationTierTotalForm,
  parseQuotationTiersForm,
} from '@/modules/quotations/forms';

/**
 * Quotation TS layer, pure parts: form parsers (no actor/entity read,
 * whole-rupee customer money, counts as typed), refusal mapping (token AND
 * state), reply parsing (fail closed), and DTO shaping (effective state,
 * permission flags, money only when the database sent it, invalid draft
 * items still load). Synthetic ids and values.
 */

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const LEAD = 'c0000000-0000-4000-8000-000000000001';
const Q = 'a1000000-0000-4000-8000-000000000001';
const V = 'a2000000-0000-4000-8000-000000000001';
const V2 = 'a2000000-0000-4000-8000-000000000002';
const ITEM = 'a3000000-0000-4000-8000-000000000001';
const EV = 'a4000000-0000-4000-8000-000000000001';
const REQ = '77777777-7777-4777-8777-777777777777';
const BV = 'b0000000-0000-4000-8000-000000000001';
const HASH = 'e'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

describe('form parsers', () => {
  it('create: subject, title, request id; never actor or entity', () => {
    expect(parseCreateQuotationForm(form({ subjectKind: 'lead', subjectId: LEAD, title: '  Goa  family ', requestId: REQ, userId: 'x', legalEntityId: 'y' }))).toEqual({
      ok: true,
      value: { subjectKind: 'lead', subjectId: LEAD, title: 'Goa family', requestId: REQ },
    });
    expect(parseCreateQuotationForm(form({ subjectKind: 'account', subjectId: 'x', title: '' }))).toEqual({ ok: false, fields: ['subjectKind', 'subjectId', 'title', 'requestId'] });
  });

  it('details: all four trip keys, counts 0–100 as typed (no age bands), validity not in the past', () => {
    const ok = parseQuotationDetailsForm(
      form({ versionId: V, rowVersion: '3', destination: 'Goa', tripScope: 'domestic', tripStart: '2026-12-10', tripEnd: '2026-12-13', adults: '2', childrenWithBed: '1', childrenNoBed: '', infants: '1', validUntil: '2026-10-19' }),
      '2026-10-12',
    );
    expect(ok).toEqual({
      ok: true,
      value: {
        versionId: V,
        expectedRowVersion: 3,
        fields: { destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-13', adults: 2, childrenWithBed: 1, childrenNoBed: 0, infants: 1, paxRemarks: null, requirementsNote: null, validUntil: '2026-10-19' },
      },
    });
    expect(parseQuotationDetailsForm(form({ versionId: V, rowVersion: '3', tripStart: '2026-12-10', tripEnd: '2026-12-01', adults: '101', validUntil: '2026-10-11' }), '2026-10-12')).toEqual({
      ok: false,
      fields: ['tripEnd', 'adults', 'validUntil'],
    });
  });

  it('content: days numbered by position; blank rows skipped; lists trimmed', () => {
    const parsed = parseQuotationContentForm(form({ versionId: V, rowVersion: '1', dayTitle: ['Arrive', '', 'Beach'], dayText: ['Check in', '', ''], include: ['Breakfast', ' '], term: ['Valid for 7 days'] }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        versionId: V,
        expectedRowVersion: 1,
        content: { days: [{ day: 1, title: 'Arrive', text: 'Check in' }, { day: 2, title: 'Beach', text: null }], includes: ['Breakfast'], excludes: [], terms: ['Valid for 7 days'], notes: null },
      },
    });
  });

  it('tiers: quoted always; upgrade only when offered', () => {
    expect(parseQuotationTiersForm(form({ versionId: V, rowVersion: '1', quotedTierLabel: 'Deluxe' }))).toMatchObject({ ok: true, value: { tiers: [{ tierKey: 'quoted', label: 'Deluxe' }] } });
    expect(parseQuotationTiersForm(form({ versionId: V, rowVersion: '1', quotedTierLabel: '', upgradeOffered: 'on', upgradeTierLabel: 'Luxury' }))).toMatchObject({
      ok: true,
      value: { tiers: [{ tierKey: 'quoted', label: null }, { tierKey: 'upgrade', label: 'Luxury' }] },
    });
  });

  it('item: booking fact inputs plus hotel extras (counts only); train refused as an unknown type', () => {
    const hotel = parseQuotationItemForm(
      form({ versionId: V, rowVersion: '2', itemId: '', serviceType: 'hotel', itemTierKey: 'upgrade', hotelName: 'Sea View', city: 'Goa', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: '1', adults: '2', extraBeds: '1', childrenWithoutBed: '0', bedRemarks: 'Extra bed for a 9-year-old' }),
    );
    expect(hotel).toMatchObject({ ok: true, value: { itemId: null, tierKey: 'upgrade', service: { type: 'hotel', facts: { hotelName: 'Sea View', rooms: 1, extraBeds: 1, bedRemarks: 'Extra bed for a 9-year-old' } } } });
    expect(hotel.ok && 'childrenWithoutBed' in hotel.value.service.facts).toBe(false);
    expect(parseQuotationItemForm(form({ versionId: V, rowVersion: '2', serviceType: 'hotel', hotelName: 'X', city: 'Goa', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: '1', adults: '2', extraBeds: '21' }))).toMatchObject({ ok: false, fields: ['extraBeds'] });
    expect(parseQuotationItemForm(form({ versionId: V, rowVersion: '2', serviceType: 'train' }))).toEqual({ ok: false, fields: ['serviceType'] });
  });

  it('lines: whole-rupee selling, paise costs, counts as typed; line_total forces 1 × 1, person one period', () => {
    const parsed = parseQuotationLinesForm(
      form({
        versionId: V,
        rowVersion: '4',
        lineOptionKey: ['quoted', 'common', 'quoted'],
        lineItemId: [ITEM, '', ITEM],
        lineChargeKind: ['main', 'main', 'extra_bed'],
        lineCategoryKey: ['hotels', 'flights', 'hotels'],
        lineDescription: ['Sea View, deluxe room', 'Flights JDH–GOI', 'Extra bed'],
        lineUnitKind: ['room_night', 'line_total', 'night'],
        lineUnits: ['1', '7', '1'],
        linePeriods: ['3', '9', '3'],
        lineUnitSellRupees: ['4,500', '18000', '1200'],
        lineUnitCostRupees: ['3800.50', '', '900'],
        lineRemark: ['', '', 'For the 9-year-old'],
      }),
    );
    expect(parsed.ok && parsed.value.lines).toEqual([
      { lineNo: 1, optionKey: 'quoted', itemId: ITEM, chargeKind: 'main', categoryKey: 'hotels', description: 'Sea View, deluxe room', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '450000', unitCostPaise: '380050', remark: null },
      { lineNo: 2, optionKey: 'common', itemId: null, chargeKind: 'main', categoryKey: 'flights', description: 'Flights JDH–GOI', unitKind: 'line_total', units: 1, periods: 1, unitSellPaise: '1800000', unitCostPaise: null, remark: null },
      { lineNo: 3, optionKey: 'quoted', itemId: ITEM, chargeKind: 'extra_bed', categoryKey: 'hotels', description: 'Extra bed', unitKind: 'night', units: 1, periods: 3, unitSellPaise: '120000', unitCostPaise: '90000', remark: 'For the 9-year-old' },
    ]);
    const bad = parseQuotationLinesForm(form({ versionId: V, rowVersion: '4', lineOptionKey: ['quoted'], lineCategoryKey: ['hotels'], lineDescription: ['Room'], lineUnitKind: ['room_night'], lineUnits: ['0'], linePeriods: ['3'], lineUnitSellRupees: ['4500.50'], lineItemId: ['nope'] }));
    expect(bad).toEqual({ ok: false, fields: ['lineItemId[0]', 'lineUnits[0]', 'lineUnitSellRupees[0]'] });
  });

  it('tier total: whole rupees, never zero; empty clears; plan rows by due rule', () => {
    expect(parseQuotationTierTotalForm(form({ versionId: V, rowVersion: '5', tierKey: 'quoted', quotedTotalRupees: '95,000', showPerPerson: 'on' }))).toEqual({
      ok: true,
      value: { versionId: V, expectedRowVersion: 5, tierKey: 'quoted', quotedTotalPaise: '9500000', showPerPerson: true },
    });
    expect(parseQuotationTierTotalForm(form({ versionId: V, rowVersion: '5', tierKey: 'quoted', quotedTotalRupees: '' }))).toMatchObject({ ok: true, value: { quotedTotalPaise: null } });
    expect(parseQuotationTierTotalForm(form({ versionId: V, rowVersion: '5', tierKey: 'gold', quotedTotalRupees: '0' }))).toEqual({ ok: false, fields: ['tierKey', 'quotedTotalRupees'] });
    const plan = parseQuotationPlanForm(
      form({
        versionId: V,
        rowVersion: '6',
        tierKey: 'quoted',
        instalmentLabel: ['Advance', 'Balance', 'Last'],
        instalmentAmountRupees: ['30000', '45000', '20000'],
        instalmentDueRule: ['on_acceptance', 'days_before_start', 'fixed_date'],
        instalmentDueDays: ['', '30', ''],
        instalmentDueDate: ['', '', '2026-12-01'],
      }),
    );
    expect(plan.ok && plan.value.instalments).toEqual([
      { seq: 1, label: 'Advance', amountPaise: '3000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null },
      { seq: 2, label: 'Balance', amountPaise: '4500000', dueRule: 'days_before_start', dueDays: 30, dueDate: null },
      { seq: 3, label: 'Last', amountPaise: '2000000', dueRule: 'fixed_date', dueDays: null, dueDate: '2026-12-01' },
    ]);
  });

  it('accept: hash, stored evidence id, the accepted option and a request id', () => {
    expect(parseAcceptForm(form({ versionId: V, contentHash: HASH, evidenceId: EV, acceptedTierKey: 'upgrade', requestId: REQ }))).toEqual({
      ok: true,
      value: { versionId: V, contentHash: HASH, evidenceId: EV, tierKey: 'upgrade', requestId: REQ },
    });
    expect(parseAcceptForm(form({ versionId: V }))).toEqual({ ok: false, fields: ['contentHash', 'evidenceId', 'acceptedTierKey', 'requestId'] });
  });
});

describe('hotel extras are one fact: entered at quotation, correctable in the booking', () => {
  const hotel = { serviceType: 'hotel', hotelName: 'Sea View', city: 'Goa', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: '1', adults: '2' };
  it('the Book now hotel form reads the same inputs; 0 or empty leaves the fact out', () => {
    const parsed = parseServiceItemForm(form({ dealId: DEAL, versionId: V, rowVersion: '3', ...hotel, extraBeds: '2', childrenWithoutBed: '0', bedRemarks: '  Extra   bed for a 9-year-old ' }));
    expect(parsed.ok && parsed.value.facts).toEqual({ type: 'hotel', facts: expect.objectContaining({ extraBeds: 2, bedRemarks: 'Extra   bed for a 9-year-old' }) });
    expect(parsed.ok && 'childrenWithoutBed' in parsed.value.facts.facts).toBe(false);
    const cleared = parseServiceItemForm(form({ dealId: DEAL, versionId: V, rowVersion: '3', ...hotel, extraBeds: '', bedRemarks: '' }));
    expect(cleared.ok && Object.keys(cleared.value.facts.facts)).not.toContain('extraBeds');
    expect(parseServiceItemForm(form({ dealId: DEAL, versionId: V, rowVersion: '3', ...hotel, childrenWithoutBed: '21' }))).toMatchObject({ ok: false, fields: ['childrenWithoutBed'] });
    expect(HOTEL_EXTRA_LABEL.extraBeds.label).toBe('Extra beds');
  });
});

describe('refusal mapping and reply parsing', () => {
  it('token AND state must match; session and bare states map conservatively', () => {
    expect(mapQuotationError({ code: '22023', message: 'deal_not_from_lead' })).toBe('deal_not_from_lead');
    expect(mapQuotationError({ code: '55000', message: 'deal_not_from_lead' })).toBeNull();
    expect(mapQuotationError({ code: '55000', message: 'draft_not_empty' })).toBe('draft_not_empty');
    expect(mapQuotationError({ code: 'PGRST301', message: 'JWT expired' })).toBe('session');
    expect(mapQuotationError({ code: '42501', message: 'whatever' })).toBe('not_authorized');
    expect(mapQuotationError({ code: 'XX000', message: 'boom' })).toBeNull();
    expect(Object.keys(QUOTATION_ERROR_STATES)).toContain('valid_until_past');
  });

  it('not_ready hint → known issue codes only', () => {
    expect(issuesFromHint(['trip_missing', 'quoted_total_missing', 'drop_tables'])).toEqual(['trip_missing', 'quoted_total_missing']);
  });

  it('list and money replies fail closed on unexpected shapes', () => {
    expect(QuotationListSchema.safeParse([{ quotationId: 'x' }]).success).toBe(false);
    expect(MoneySchema.safeParse({ lines: [], tiers: null, instalments: [], codes: null }).success).toBe(true);
    expect(MoneySchema.safeParse({ lines: [{ lineNo: 1, unitSellPaise: 1.5 }], tiers: [], instalments: [], codes: [] }).success).toBe(false);
  });
});

describe('DTO', () => {
  const getRecord = (over: Record<string, unknown> = {}, version: Record<string, unknown> = {}) => ({
    quotationId: Q,
    reference: 'TQ-12',
    title: 'Goa family',
    rowVersion: 3,
    subject: { kind: 'lead' as const, leadId: LEAD, dealId: null, linkedDealId: null, reference: 'L-55', title: 'Synthetic Lead', branchCode: 'JDH' },
    version: {
      versionId: V,
      versionNo: 2,
      status: 'sent' as const,
      rowVersion: 7,
      contentHash: HASH,
      validUntil: '2026-10-19',
      basedOnVersionId: null,
      sentAt: '2026-10-12T08:00:00Z',
      sentChannel: 'whatsapp' as const,
      acceptedAt: null,
      acceptedTier: null,
      declinedAt: null,
      declineReason: null,
      ...version,
    },
    trip: { destination: 'Goa', scope: 'domestic' as const, start: '2026-12-10', end: '2026-12-13' },
    pax: { adults: 2, childrenWithBed: 1, childrenNoBed: 0, infants: 1, paxRemarks: null },
    requirementsNote: null,
    content: { days: [], includes: [], excludes: [], terms: [], notes: null },
    tiers: [{ tierKey: 'upgrade' as const, label: 'Luxury' }, { tierKey: 'quoted' as const, label: 'Deluxe' }],
    items: [
      { itemId: ITEM, itemNo: 1, serviceType: 'hotel' as const, tierKey: null, title: null, facts: { hotelName: 'Sea View', city: 'Goa', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 1, adults: 2 }, factsValid: true },
      { itemId: 'a3000000-0000-4000-8000-000000000002', itemNo: 2, serviceType: 'transfer' as const, tierKey: null, title: null, facts: { route: '' }, factsValid: false },
    ],
    contacts: { contactName: 'Synthetic Customer', mobile: '9876543210', email: null, companyName: null },
    evidence: [
      { id: EV, kind: 'acceptance_message' as const, fileName: 'ok.pdf', mime: 'application/pdf' as const, sizeBytes: 2048, status: 'stored' as const, createdAt: '2026-10-12T09:00:00Z', storedAt: '2026-10-12T09:00:01Z', uploadedByYou: true },
    ],
    issues: [],
    canEdit: true,
    conversion: null,
    ...over,
  });

  it('sent version with a stored acceptance file: accept/decline/upload offered; no edit, no money without money', () => {
    // quotation_get's canEdit is false once sent (editable means draft/ready); the reader is still the editor.
    const view = toQuotationVersionView(getRecord({ canEdit: false }));
    expect(view).toMatchObject({ quotationRowVersion: 3, status: 'sent', canEdit: false, canEditMoney: false, canAccept: true, canDecline: true, canUploadEvidence: true, canSend: false, canConvert: false, travellerCount: 4 });
    expect(view).not.toHaveProperty('money');
    expect(view.tiers.map((t) => t.tierKey)).toEqual(['quoted', 'upgrade']);
    expect(view.evidence[0]).toMatchObject({ evidenceId: EV, downloadHref: `/app/quotations/evidence/${EV}`, sizeLabel: '2 KB' });
    expect(view.items[0]).toMatchObject({ factsValid: true, title: expect.stringContaining('Sea View') });
    // An invalid draft item still loads: shown, flagged, never crashes the editor.
    expect(view.items[1]).toMatchObject({ factsValid: false, service: { type: 'transfer' } });
  });

  it('accepted Lead quotation: waits for the Deal (link offered, convert not); linked → convert offered once', () => {
    const accepted = toQuotationVersionView(getRecord({ canEdit: false }, { status: 'accepted', acceptedAt: '2026-10-13T08:00:00Z', acceptedTier: 'quoted' }));
    expect(accepted).toMatchObject({ canLinkDeal: true, canConvert: false, nextStepText: QUOTATION_TEXT.waitingForDeal, accepted: { tierKey: 'quoted' } });
    const linked = toQuotationVersionView(getRecord({ subject: { kind: 'lead', leadId: LEAD, dealId: null, linkedDealId: DEAL, reference: 'L-55', title: 'x', branchCode: 'JDH' } }, { status: 'accepted', acceptedAt: '2026-10-13T08:00:00Z', acceptedTier: 'quoted' }));
    expect(linked).toMatchObject({ canLinkDeal: false, canConvert: true, nextStepText: null });
    const converted = toQuotationVersionView(getRecord({ subject: { kind: 'deal', leadId: null, dealId: DEAL, linkedDealId: null, reference: 'D-1', title: 'x', branchCode: 'JDH' }, conversion: { bookingVersionId: BV, dealId: DEAL, createdAt: '2026-10-13T09:00:00Z' } }, { status: 'accepted', acceptedAt: '2026-10-13T08:00:00Z', acceptedTier: 'quoted' }));
    expect(converted).toMatchObject({ canConvert: false, canNewVersion: false, conversion: { bookingVersionId: BV, dealId: DEAL } });
  });

  it('draft: editable; money copied only when sent; issues limited to known codes', () => {
    const money = MoneySchema.parse({
      lines: [],
      tiers: [{ tierKey: 'quoted', label: 'Deluxe', quotedTotalPaise: '9500000', showPerPerson: true, lineCount: 0, componentSellPaise: '0', differencePaise: '9500000', costTotalPaise: null, costComplete: false, marginPaise: null, payingTravellers: 3, perPersonPaise: null, planTotalPaise: null, planCount: 0 }],
      instalments: [],
      codes: ['component_mismatch', 'mystery'],
      costRefreshAllowed: true,
    });
    const draft = toQuotationVersionView(getRecord({ issues: ['trip_missing', 'unknown_code'], money }, { status: 'draft', contentHash: null }));
    expect(draft).toMatchObject({ canEdit: true, canEditMoney: true, canMarkReady: true, canSend: false, canDiscard: true, issues: ['trip_missing'] });
    expect(draft.money).toMatchObject({ issues: ['component_mismatch'], tiers: [{ componentDifferencePaise: '9500000', payingTravellers: 3 }] });
    const readOnly = toQuotationVersionView(getRecord({ canEdit: false }, { status: 'draft', contentHash: null }));
    expect(readOnly).toMatchObject({ canEdit: false, canMarkReady: false, canDiscard: false });
  });

  it('list: newest version first; the editor opens the working version, else the newest', () => {
    const rows = QuotationListSchema.parse([
      {
        quotationId: Q,
        reference: 'TQ-12',
        title: 'Goa family',
        subjectKind: 'deal',
        leadId: null,
        dealId: DEAL,
        linkedDealId: null,
        acceptedVersionId: null,
        converted: false,
        bookingVersionId: null,
        createdAt: '2026-10-12T07:00:00Z',
        rowVersion: 2,
        versions: [
          { versionId: V, versionNo: 1, status: 'superseded', validUntil: '2026-10-19', sentAt: '2026-10-12T08:00:00Z', acceptedTier: null, contentHash: HASH },
          { versionId: V2, versionNo: 2, status: 'draft', validUntil: '2026-10-19', sentAt: null, acceptedTier: null, contentHash: null },
        ],
      },
    ]);
    const list = toQuotationListView('deal', DEAL, rows);
    expect(list.quotations[0]!.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(list.quotations[0]!.currentVersionId).toBe(V2);
    expect(list.quotations[0]!.rowVersion).toBe(2);
    expect(list.canCreate).toBe(true);
  });
});

describe('DEC-45 contact "booking for"', () => {
  const V = 'a2000000-0000-4000-8000-000000000001';
  const contactForm = (extra: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ versionId: V, rowVersion: '1', contactName: 'Synthetic', mobile: '9876543210', ...extra })) f.set(k, v);
    return f;
  };
  it('optional: empty keeps the saved value (key left out); individual or business sent; anything else refused', async () => {
    const { parseQuotationContactForm, QFIELD } = await import('@/modules/quotations/forms');
    const kept = parseQuotationContactForm(contactForm({}));
    expect(kept.ok && 'bookingFor' in kept.value.fields).toBe(false);
    expect(parseQuotationContactForm(contactForm({ [QFIELD.bookingFor]: 'business' }))).toMatchObject({ ok: true, value: { fields: { bookingFor: 'business' } } });
    expect(parseQuotationContactForm(contactForm({ [QFIELD.bookingFor]: 'company' }))).toEqual({ ok: false, fields: [QFIELD.bookingFor] });
  });
  it('the wrapper sends bookingFor only when given', async () => {
    const { quotationContactsSave } = await import('@/modules/quotations/commands');
    const calls: Array<Record<string, unknown>> = [];
    const client = { rpc: async (_fn: string, args: Record<string, unknown>) => (calls.push(args), { data: { rowVersion: 2 }, error: null }) };
    await quotationContactsSave(client, { versionId: V, expectedRowVersion: 1, fields: { contactName: 'S', mobile: '9876543210', email: null, companyName: null } });
    await quotationContactsSave(client, { versionId: V, expectedRowVersion: 2, fields: { contactName: 'S', mobile: '9876543210', email: null, companyName: null, bookingFor: 'business' } });
    expect(calls.map((c) => c.p_fields)).toEqual([
      { contactName: 'S', mobile: '9876543210', email: null, companyName: null },
      { contactName: 'S', mobile: '9876543210', email: null, companyName: null, bookingFor: 'business' },
    ]);
  });
});
