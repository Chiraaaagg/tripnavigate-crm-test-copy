import { describe, expect, it } from 'vitest';
import { quoteVersion } from '@/app/preview/[state]/b12-quote-fixtures';
import { EMPTY_QUOTATION_CONTENT, QUOTATION_CHECKLIST_CODES, QUOTATION_ISSUE_TEXT, QUOTATION_TEXT, type QuotationVersionView } from '@/modules/quotations/contracts';
import type { PrefillFieldStateRead } from '@/modules/fulfilment/prefill-contract';
import type { PrefillView } from '@/modules/fulfilment/contracts';
import {
  blockingItems,
  isQuoteUntouched,
  notReadySummary,
  pricesSaveSteps,
  QUOTE_ISSUE_TARGETS,
  QUOTE_MARKED_READY_TEXT,
  QUOTE_PRICES_BY_SALES_TEXT,
  quoteCopyLinks,
  quoteHeader,
  quoteParts,
  quotePartState,
  quoteReadiness,
  quoteStatusWord,
  quoteValidityText,
  unsavedCheckSummary,
  untouchedBitrixFields,
  warningLines,
} from '@/modules/quotations/editor-model';

/** Batch 2 quotation editor model (pure). Synthetic fixtures from the preview gallery. */

const prefill = (states: Partial<Record<string, 'from_bitrix' | 'kept' | 'checked' | 'changed'>>): PrefillView => ({
  available: true,
  sourceModifiedAt: null,
  lastVerifiedAt: null,
  issues: [],
  bookingNotes: null,
  notesHidden: false,
  travellerTotal: null,
  customerType: null,
  customerTypeLabel: null,
  unchecked: [],
  fields: Object.entries(states).map(([field, state]) => ({ field: field as never, label: field, bitrixValue: 'x', state: state ?? null, stateText: null, canUse: false, canMarkChecked: false })),
});

/** An editable version 1 draft, empty except what the test adds. */
const blank = (over: Partial<QuotationVersionView> = {}): QuotationVersionView =>
  quoteVersion({
    versionNo: 1,
    status: 'draft',
    contentHash: null,
    trip: { destination: null, scope: null, start: null, end: null },
    pax: { adults: 0, childrenWithBed: 0, childrenNoBed: 0, infants: 0, paxRemarks: null },
    travellerCount: null,
    requirementsNote: null,
    contact: null,
    content: EMPTY_QUOTATION_CONTENT,
    tiers: [{ tierKey: 'quoted', label: null }],
    items: [],
    validUntil: null,
    sent: null,
    issues: ['trip_missing', 'pax_missing', 'no_items', 'contact_missing', 'tier_missing'],
    money: { lines: [], tiers: [], plan: [], issues: ['quoted_total_missing', 'lines_missing', 'traveller_count_missing'], costRefreshAllowed: false },
    canEdit: true,
    canEditMoney: true,
    canMarkReady: true,
    canSend: false,
    canUploadEvidence: false,
    canAccept: false,
    canDecline: false,
    canNewVersion: false,
    canDiscard: true,
    ...over,
  });

describe('"Not started"', () => {
  it('an empty draft is not started; status word and readiness say so; the first part opens', () => {
    const v = blank();
    expect(isQuoteUntouched(v)).toBe(true);
    expect(quoteStatusWord(v)).toBe('Not started');
    expect(quoteReadiness(v)).toEqual({ state: 'not_started', savedParts: 1, totalParts: 6 });
    const parts = quoteParts(v);
    expect(parts.map((p) => p.state)).toEqual(['not_started', 'not_started', 'not_started', 'not_started', 'not_started', 'optional']);
    expect(parts.filter((p) => p.open).map((p) => p.key)).toEqual(['details']);
  });

  it('values only from Bitrix and untouched still count as not started (marks, or Atlas fieldStates when present)', () => {
    const filled = blank({
      trip: { destination: null, scope: null, start: '2026-12-10', end: '2026-12-14' },
      contact: { contactName: 'Synthetic Contact', mobile: '9876500033', email: null, companyName: null, bookingFor: null },
      prefill: prefill({ 'trip.start': 'from_bitrix', 'trip.end': 'from_bitrix', 'contacts.contactName': 'from_bitrix', 'contacts.mobile': 'from_bitrix' }),
    });
    expect(isQuoteUntouched(filled)).toBe(true);
    const kept = { ...filled, prefill: prefill({ 'trip.start': 'from_bitrix', 'trip.end': 'kept', 'contacts.contactName': 'from_bitrix', 'contacts.mobile': 'from_bitrix' }) };
    expect(isQuoteUntouched(kept)).toBe(false);
    expect(quotePartState(kept, 'details')).toBe('saved');
    expect(quotePartState(kept, 'contact')).toBe('not_started');
    const states: PrefillFieldStateRead[] = (['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile'] as const).map((field) => ({ field, state: 'kept', filledBy: 'auto_fill', staffTouched: false, clearedByStaff: false, notice: null }));
    expect(untouchedBitrixFields(kept.prefill, states).size).toBe(4);
    expect(isQuoteUntouched(kept, states)).toBe(true);
    states[0] = { ...states[0]!, staffTouched: true };
    expect(isQuoteUntouched(kept, states)).toBe(false);
  });

  it('a version that is not an editable draft is never "Not started"', () => {
    expect(isQuoteUntouched(blank({ status: 'ready' }))).toBe(false);
    expect(isQuoteUntouched(blank({ canEdit: false }))).toBe(false);
  });
});

describe('parts', () => {
  it('nothing red before the check; after the check, parts with blocking checks or unsaved changes need input', () => {
    const v = blank({ trip: { destination: 'Goa', scope: 'domestic', start: null, end: null } });
    expect(quoteParts(v).some((p) => p.state === 'needs_input')).toBe(false);
    const checked = quoteParts(v, { checked: true, dirty: new Set(['narrative']) });
    expect(checked.filter((p) => p.state === 'needs_input').map((p) => p.key)).toEqual(['details', 'contact', 'services', 'narrative', 'money']);
    expect(checked.find((p) => p.open)?.key).toBe('details');
  });

  it('a dirty part always stays open (never collapses with unsaved changes)', () => {
    const parts = quoteParts(blank(), { dirty: new Set(['money']) });
    expect(parts.find((p) => p.key === 'money')?.open).toBe(true);
  });

  it('a reader without price access: prices and plan are hidden, never empty forms', () => {
    const v = blank({ money: undefined, canEditMoney: false });
    expect(quotePartState(v, 'money')).toBe('prices_hidden');
    expect(quotePartState(v, 'plan')).toBe('prices_hidden');
  });
});

describe('header: one primary per state', () => {
  it('draft → check and mark ready; ready → mark as shared; sent → record answer; accepted → start / continue booking', () => {
    expect(quoteHeader({ version: blank(), ownerName: 'Synthetic Owner' })).toMatchObject({ statusWord: 'Not started', primary: 'check_and_mark_ready', more: ['discard'] });
    expect(quoteHeader({ version: blank({ status: 'ready', canSend: true, canMarkReady: false, contentHash: 'h' }), ownerName: null }).primary).toBe('mark_as_shared');
    expect(quoteHeader({ version: quoteVersion(), ownerName: null })).toMatchObject({ statusWord: 'Shared with customer', primary: 'record_answer', more: ['new_version'] });
    const accepted = quoteVersion({ status: 'accepted', canConvert: true, canNewVersion: true, accepted: { at: '2026-10-13T00:00:00Z', tierKey: 'quoted' } });
    expect(quoteHeader({ version: accepted, ownerName: null }).primary).toBe('start_booking');
    const converted = { ...accepted, conversion: { dealId: 'd', bookingVersionId: 'b', convertedAt: '2026-10-14T00:00:00Z' } };
    expect(quoteHeader({ version: converted, ownerName: null })).toMatchObject({ statusWord: 'Booking started', primary: 'continue_booking', more: [] });
  });

  it('not editable: no primary, a Next line naming who acts', () => {
    const h = quoteHeader({ version: blank({ canEdit: false, canMarkReady: false, canDiscard: false }), ownerName: null });
    expect(h.primary).toBeNull();
    expect(h.nextLine).toBe('Next: Sales or the branch Manager finishes this quotation');
  });

  it('validity: empty date keeps the 7-day rule (never pre-filled)', () => {
    expect(quoteValidityText({ validUntil: null })).toBe('Valid for 7 days after the quotation was made');
    expect(quoteValidityText({ validUntil: '2026-10-22' })).toBe('Valid until 22 Oct 2026');
  });

  it('superseded names the newer version', () => {
    const v = quoteVersion({ status: 'superseded', versionNo: 1 });
    expect(quoteStatusWord(v, [{ versionId: 'x', versionNo: 3, status: 'sent', validUntil: null, sentAt: null, acceptedTierKey: null }])).toBe('Replaced by v3');
  });
});

describe('"Check and mark ready"', () => {
  it('every check code has a part and a field to focus', () => {
    for (const code of QUOTATION_CHECKLIST_CODES) expect(QUOTE_ISSUE_TARGETS[code].fieldId).toMatch(/^[a-z][a-zA-Z0-9-]+$/);
    expect(QUOTE_ISSUE_TARGETS.lines_missing.fieldId).toBe('q-lines-heading');
  });

  it('unsaved parts first, then blocking checks; pax_missing and traveller_count_missing once; no server call needed', () => {
    const s = unsavedCheckSummary(blank(), [{ part: 'narrative', label: 'Day plan and terms' }]);
    expect(s?.items[0]).toMatchObject({ kind: 'unsaved', partId: 'narrative' });
    const messages = s!.items.map((i) => i.message);
    expect(messages.filter((m) => /number of travellers/.test(m))).toHaveLength(1);
    expect(s?.title).toBe(`To finish before sharing (${s!.items.length})`);
    expect(unsavedCheckSummary(blank(), [])).toBeNull();
  });

  it('server not_ready: its codes decide, in part order, links focus the field', () => {
    const s = notReadySummary(['plan_total_mismatch', 'trip_missing', 'traveller_count_missing', 'pax_missing', 'component_mismatch']);
    expect(s?.items.map((i) => i.partId)).toEqual(['details', 'details', 'plan']);
    expect(s?.items[0]?.href).toBe('#q-details-destination');
    expect(notReadySummary([])).toBeNull();
    expect(blockingItems(['margin_negative'])).toEqual([]);
  });

  it('internal warnings only for price readers, tagged internal', () => {
    const reader = blank({ money: { lines: [], tiers: [], plan: [], issues: ['margin_negative', 'cost_incomplete', 'component_mismatch'], costRefreshAllowed: false } });
    expect(warningLines(reader).filter((w) => w.internal).map((w) => w.code)).toEqual(['margin_negative', 'cost_incomplete']);
    const assisting = blank({ money: undefined, issues: ['trip_missing', 'margin_negative'] as never });
    expect(warningLines(assisting)).toEqual([]);
  });
});

describe('prices save and customer copy', () => {
  it('existing commands in order; the upgrade total only when offered', () => {
    expect(pricesSaveSteps(false)).toEqual(['tiers', 'lines', 'total_quoted']);
    expect(pricesSaveSteps(true)).toEqual(['tiers', 'lines', 'total_quoted', 'total_upgrade']);
  });

  it('customer copy is the server-rendered preview address', () => {
    expect(quoteCopyLinks('v1', 'edit')).toEqual({ edit: '/app/quotations/v1', customerCopy: '/app/quotations/v1/preview', current: 'edit' });
  });
});

describe('Batch 2 fix round (Mercury §16.11, Echo M5 and DA-194)', () => {
  const tierMoney = { tierKey: 'quoted' as const, label: 'Sea view', quotedTotalPaise: null, payingTravellers: 2, showPerPerson: false, lineCount: 1, componentSellPaise: '3000000', componentDifferencePaise: null, costTotalPaise: null, costComplete: false, marginPaise: null, perPersonPaise: null, planTotalPaise: null, planCount: 0 };
  const line = { lineNo: 1, optionKey: 'common' as const, itemId: null, itemNo: null, chargeKind: 'main' as const, categoryKey: 'hotels' as const, description: 'Room', unitKind: 'room_night' as const, units: 1, periods: 3, quantity: 3, unitSellPaise: '1000000', unitCostPaise: null, lineSellPaise: '3000000', lineCostPaise: null, remark: null };

  it('Next lines (DA-184): untouched, draft, ready, shared with the date as written, lead without a deal', () => {
    expect(quoteHeader({ version: blank(), ownerName: null }).nextLine).toBe('Next: start with the trip details');
    const started = blank({ trip: { destination: 'Goa', scope: 'domestic', start: null, end: null } });
    expect(quoteHeader({ version: started, ownerName: null }).nextLine).toBe('Next: finish the parts, then press “Check and mark ready”');
    expect(quoteHeader({ version: blank({ status: 'ready', canSend: true, canMarkReady: false, contentHash: 'h' }), ownerName: null }).nextLine).toBe('Next: check the customer copy, share it yourself, then mark it as shared');
    expect(quoteHeader({ version: quoteVersion({ validUntil: '2026-11-12' }), ownerName: null }).nextLine).toBe('Next: wait for the customer’s written answer (valid until 12 Nov 2026)');
    const leadNoDeal = quoteVersion({ status: 'accepted', accepted: { at: '2026-10-13T00:00:00Z', tierKey: 'quoted' }, canConvert: false, canLinkDeal: false, canNewVersion: false });
    expect(quoteHeader({ version: leadNoDeal, ownerName: null }).nextLine).toBe('Next: convert the lead to a deal in Bitrix, then link it here');
  });

  it('a superseded version without the newer one in the list never guesses a number (DA-185)', () => {
    expect(quoteStatusWord(quoteVersion({ status: 'superseded', versionNo: 1 }), [])).toBe('Replaced by a newer version');
  });

  it('readiness counts only parts that are done (Echo M5): blocked, started-but-unsaved or still-blocked parts never count', () => {
    const v = blank({
      trip: { destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' },
      pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 0, infants: 0, paxRemarks: null },
      issues: ['contact_missing', 'no_items', 'tier_missing'],
      tiers: [{ tierKey: 'quoted', label: 'Sea view' }],
      money: { lines: [line], tiers: [tierMoney], plan: [], issues: ['quoted_total_missing'], costRefreshAllowed: false },
    });
    // Trip saved and unblocked (1) + empty optional plan (1); Prices has lines but no total: not done.
    expect(quoteReadiness(v).savedParts).toBe(2);
    expect(quoteReadiness(v, { dirty: new Set(['details']) }).savedParts).toBe(1);
  });

  it('check summary for an editor without price access (DA-194): money lines become one line; the unsaved line says "changes not saved yet"', () => {
    const s = notReadySummary(['trip_missing', 'quoted_total_missing', 'lines_missing', 'plan_total_mismatch'], { priceAccess: false });
    expect(s?.items.map((i) => i.message)).toEqual([`Trip: ${QUOTATION_ISSUE_TEXT.trip_missing.text}`, QUOTE_PRICES_BY_SALES_TEXT]);
    expect(notReadySummary(['quoted_total_missing'])?.items[0]?.href).toBe('#q-total-quoted');
    const u = unsavedCheckSummary(blank({ money: undefined, issues: ['trip_missing'] }), [{ part: 'details', label: 'Trip' }]);
    expect(u?.items[0]?.message).toBe('Trip: changes not saved yet');
    expect(u?.items.some((i) => i.partId === 'money' || i.partId === 'plan')).toBe(false);
  });

  it('wording from the copy pass: success lines and internal warnings', () => {
    expect(QUOTE_MARKED_READY_TEXT).toBe('Marked ready to share.');
    expect(QUOTATION_TEXT.markedSent).toBe('Marked as shared. To change anything, make a new version.');
    expect(QUOTATION_ISSUE_TEXT.cost_incomplete.text).toBe('Some of our costs are empty.');
    expect(QUOTATION_ISSUE_TEXT.margin_negative.text).toBe('Total is below our cost.');
  });
});
