import { describe, expect, it } from 'vitest';
import { QuotationGetSchema } from '@/modules/quotations/commands';
import { toQuotationVersionView } from '@/modules/quotations/dto';
import { isQuoteUntouched, quoteHeader, quoteParts, quotePartState, quoteReadiness, quoteStatusWord } from '@/modules/quotations/editor-model';

/**
 * Gate 26c697c (b12-quote-to-booking.real:261): a brand-new version 1 made by
 * quotation_create from a Lead (switch off, no Bitrix values) showed "Draft",
 * "1. Trip Saved" and "1 of 6 parts done". Cause: the creation defaults count
 * as content, notably quotation_versions.valid_until NOT NULL DEFAULT
 * (creation day + 7, IST). This fixture is what quotation_get returns for that
 * version (20261122000100 quotation_get + quotation_version_json +
 * quotation_money_json for a price reader): trip all null, counts 0, content
 * '{}', one `quoted` tier without a label, no items, no contacts row, the
 * stored validity date. Synthetic ids only.
 */

const QUOTE = 'a1000000-0000-4000-8000-000000000001';
const VERSION = 'a2000000-0000-4000-8000-000000000001';
const LEAD = 'a3000000-0000-4000-8000-000000000001';

const freshV1 = (over: Record<string, unknown> = {}) =>
  toQuotationVersionView(
    QuotationGetSchema.parse({
      quotationId: QUOTE,
      reference: 'TQ-1',
      title: 'Goa for the synthetic family',
      rowVersion: 1,
      subject: { kind: 'lead', leadId: LEAD, dealId: null, linkedDealId: null, branchCode: null, reference: 'BXL-708747990', title: 'Synthetic Goa family trip' },
      version: {
        versionId: VERSION,
        versionNo: 1,
        status: 'draft',
        rowVersion: 1,
        contentHash: null,
        validUntil: '2026-10-27',
        basedOnVersionId: null,
        sentAt: null,
        sentChannel: null,
        acceptedAt: null,
        acceptedTier: null,
        declinedAt: null,
        declineReason: null,
        updatedAt: '2026-10-20T09:00:00Z',
      },
      trip: { destination: null, scope: null, start: null, end: null },
      pax: { adults: 0, childrenWithBed: 0, childrenNoBed: 0, infants: 0, remarks: null },
      requirementsNote: null,
      content: {},
      tiers: [{ tierKey: 'quoted', label: null }],
      items: [],
      contacts: null,
      evidence: [],
      issues: ['trip_missing', 'pax_missing', 'no_items', 'contact_missing', 'tier_missing'],
      canEdit: true,
      conversion: null,
      prefill: { available: false, sourceModifiedAt: null, lastVerifiedAt: null, issues: [], notesHidden: false, fields: { bookingNotes: null, travellerTotal: null, tourStart: null, tourEnd: null, customerType: null, contact: null, company: null }, marks: [], unchecked: [] },
      money: {
        lines: [],
        tiers: [
          { tierKey: 'quoted', label: null, quotedTotalPaise: null, showPerPerson: false, lineCount: 0, componentSellPaise: '0', differencePaise: null, costTotalPaise: null, costComplete: true, marginPaise: null, payingTravellers: 0, perPersonPaise: null, planTotalPaise: null, planCount: 0 },
        ],
        instalments: [],
        codes: ['quoted_total_missing', 'lines_missing', 'traveller_count_missing'],
        costRefreshAllowed: false,
      },
      ...over,
    }),
  );

describe('a brand-new version 1 from quotation_create (creation defaults never count as staff input)', () => {
  it('is "Not started": every part not started, the plan optional, 1 of 6 done (the empty optional plan), Trip open', () => {
    const v = freshV1();
    expect(v.validUntil).toBe('2026-10-27');
    expect(isQuoteUntouched(v)).toBe(true);
    expect(quoteStatusWord(v)).toBe('Not started');
    expect(quotePartState(v, 'details')).toBe('not_started');
    expect(quoteParts(v).map((p) => p.state)).toEqual(['not_started', 'not_started', 'not_started', 'not_started', 'not_started', 'optional']);
    expect(quoteParts(v).find((p) => p.open)?.key).toBe('details');
    expect(quoteReadiness(v)).toEqual({ state: 'not_started', savedParts: 1, totalParts: 6 });
  });

  it('the stored validity date is shown honestly in the header (not a rule text), and the Next line starts with the trip', () => {
    const h = quoteHeader({ version: freshV1(), ownerName: 'Synthetic Sales Finance' });
    expect(h.statusWord).toBe('Not started');
    expect(h.validityText).toBe('Valid until 27 Oct 2026');
    expect(h.nextLine).toBe('Next: start with the trip details');
    expect(h.primary).toBe('check_and_mark_ready');
  });

  it('one staff value makes the part (and the version) started: destination, a traveller count, a requirement note', () => {
    expect(quotePartState(freshV1({ trip: { destination: 'Goa', scope: null, start: null, end: null } }), 'details')).toBe('saved');
    expect(quotePartState(freshV1({ pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 0, infants: 0, remarks: null } }), 'details')).toBe('saved');
    expect(isQuoteUntouched(freshV1({ requirementsNote: 'Sea view please' }))).toBe(false);
    expect(quoteStatusWord(freshV1({ trip: { destination: null, scope: 'domestic', start: null, end: null } }))).toBe('Draft');
  });

  it('a changed validity date alone does not make the trip part "saved" (the read cannot tell it from the default)', () => {
    expect(quotePartState(freshV1({ version: { ...freshV1Version(), validUntil: '2026-11-30' } }), 'details')).toBe('not_started');
  });
});

function freshV1Version() {
  return {
    versionId: VERSION,
    versionNo: 1,
    status: 'draft',
    rowVersion: 2,
    contentHash: null,
    validUntil: '2026-10-27',
    basedOnVersionId: null,
    sentAt: null,
    sentChannel: null,
    acceptedAt: null,
    acceptedTier: null,
    declinedAt: null,
    declineReason: null,
    updatedAt: '2026-10-20T09:05:00Z',
  };
}
