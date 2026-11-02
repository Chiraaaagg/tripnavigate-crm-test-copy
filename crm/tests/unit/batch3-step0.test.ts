import { describe, expect, it } from 'vitest';
import { myWorkCounts } from '@/modules/fulfilment/commands';
import { toMyWorkCounts } from '@/modules/fulfilment/dto';
import { itineraryDocumentGet, itineraryDocumentList, mapItineraryError } from '@/modules/itineraries/commands';
import { ITINERARY_ERROR_STATES, ITINERARY_ERROR_TEXT } from '@/modules/itineraries/contracts';
import { mapQuotationError, quotationGet, quotationList } from '@/modules/quotations/commands';
import { QUOTATION_ERROR_STATES, QUOTATION_ERROR_TEXT, QUOTATION_SUBJECT_KINDS } from '@/modules/quotations/contracts';
import { toQuotationVersionView } from '@/modules/quotations/dto';
import { itineraryBackLink, quotationSubjectLink, referralDraftHref, subjectHref } from '@/modules/quotations/subject-links';

/**
 * Direction A Batch 3, Step 0 (lead freeze): widened subject kinds with
 * tolerant reads, the new refusal tokens, one subject-link helper, and the
 * Home counts schema fix. Synthetic ids only; no database.
 */

const Q1 = 'b1000000-0000-4000-8000-000000000001';
const Q2 = 'b1000000-0000-4000-8000-000000000002';
const Q3 = 'b1000000-0000-4000-8000-000000000003';
const V1 = 'b2000000-0000-4000-8000-000000000001';
const DEAL = 'b3000000-0000-4000-8000-000000000001';
const DRAFT = 'b4000000-0000-4000-8000-000000000001';
const DOC = 'b5000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

/** A client whose every rpc answers with `data` (or the given error). */
function client(data: unknown, error: { code?: string; message?: string } | null = null) {
  return { rpc: async () => ({ data, error }) } as never;
}

const listRow = (id: string, subjectKind: unknown, extra: Record<string, unknown> = {}) => ({
  quotationId: id,
  reference: 'TQ-1',
  title: 'Synthetic trip',
  subjectKind,
  leadId: null,
  dealId: subjectKind === 'deal' ? DEAL : null,
  linkedDealId: subjectKind === 'referral' ? DEAL : null,
  acceptedVersionId: null,
  converted: false,
  bookingVersionId: null,
  createdAt: '2026-10-21T08:00:00Z',
  rowVersion: 1,
  versions: [{ versionId: V1, versionNo: 1, status: 'draft', validUntil: '2026-10-28', sentAt: null, acceptedAt: null, acceptedTier: null, contentHash: null }],
  ...extra,
});

function getRecord(subject: Record<string, unknown>) {
  return {
    quotationId: Q1,
    reference: 'TQ-9',
    title: 'Synthetic referral trip',
    rowVersion: 1,
    subject,
    version: {
      versionId: V1,
      versionNo: 1,
      status: 'draft',
      rowVersion: 1,
      contentHash: null,
      validUntil: '2026-10-28',
      basedOnVersionId: null,
      sentAt: null,
      sentChannel: null,
      acceptedAt: null,
      acceptedTier: null,
      declinedAt: null,
      declineReason: null,
      updatedAt: '2026-10-21T08:00:00Z',
    },
    trip: { destination: null, scope: null, start: null, end: null },
    pax: { adults: 0, childrenWithBed: 0, childrenNoBed: 0, infants: 0, remarks: null },
    requirementsNote: null,
    content: {},
    tiers: [{ tierKey: 'quoted', label: null }],
    items: [],
    contacts: null,
    evidence: [],
    issues: [],
    canEdit: true,
    conversion: null,
  };
}

describe('subject kinds include referral drafts', () => {
  it('quotations: lead, deal, referral', () => {
    expect(QUOTATION_SUBJECT_KINDS).toEqual(['lead', 'deal', 'referral']);
  });
});

describe('quotation reads are tolerant of subject kinds this build does not know', () => {
  it('quotation_list keeps referral rows (bound ones too) and drops an unknown kind, never failing the list', async () => {
    const rows = await quotationList(client([listRow(Q1, 'deal'), listRow(Q2, 'referral', { referralDraftId: DRAFT }), listRow(Q3, 'standalone_v9')]), 'deal', DEAL);
    expect(rows?.map((r) => [r.quotationId, r.subjectKind, r.referralDraftId ?? null])).toEqual([
      [Q1, 'deal', null],
      [Q2, 'referral', DRAFT],
    ]);
  });

  it('a malformed row still fails the read (a missing or non-string kind is not "unknown")', async () => {
    await expect(quotationList(client([listRow(Q1, 'deal'), listRow(Q2, 42)]), 'deal', DEAL)).rejects.toThrow();
    const noKind = listRow(Q1, 'deal') as Record<string, unknown>;
    delete noKind.subjectKind;
    await expect(quotationList(client([noKind]), 'deal', DEAL)).rejects.toThrow();
  });

  it('quotation_get with an unknown kind answers "not visible" (null); a referral quotation parses with its draft id', async () => {
    await expect(quotationGet(client(getRecord({ kind: 'standalone_v9', leadId: null, dealId: null, linkedDealId: null, reference: 'X', title: 'x' })), V1)).resolves.toBeNull();
    const record = await quotationGet(
      client(getRecord({ kind: 'referral', leadId: null, dealId: null, referralDraftId: DRAFT, linkedDealId: null, reference: 'TD-301', title: 'Synthetic customer', branchCode: 'JDH' })),
      V1,
    );
    expect(record?.subject).toMatchObject({ kind: 'referral', referralDraftId: DRAFT, reference: 'TD-301' });
    const view = toQuotationVersionView(record!);
    expect(view.subject).toMatchObject({ kind: 'referral', referralDraftId: DRAFT, leadId: null, dealId: null });
  });

  it('an older database without referralDraftId still parses (null in the view)', async () => {
    const record = await quotationGet(client(getRecord({ kind: 'lead', leadId: DEAL, dealId: null, linkedDealId: null, reference: 'L-55', title: 'x' })), V1);
    expect(toQuotationVersionView(record!).subject.referralDraftId).toBeNull();
  });
});

describe('itinerary reads are tolerant of subject kinds this build does not know', () => {
  const itinRow = (subjectKind: unknown) => ({ documentId: DOC, title: 'Synthetic itinerary', subjectKind, draftStatus: 'draft', factsHash: HASH, createdAt: '2026-10-21T08:00:00Z', latestFinal: null });

  it('itinerary_document_list keeps referral rows and drops an unknown kind; a malformed row fails', async () => {
    const rows = await itineraryDocumentList(client([itinRow('deal'), itinRow('referral'), itinRow('standalone_v9')]), 'deal', DEAL);
    expect(rows?.map((r) => r.subjectKind)).toEqual(['deal', 'referral']);
    await expect(itineraryDocumentList(client([itinRow(7)]), 'deal', DEAL)).rejects.toThrow();
  });

  it('itinerary_document_get with an unknown kind answers "not visible" (null) before parsing', async () => {
    await expect(itineraryDocumentGet(client({ documentId: DOC, subject: { kind: 'standalone_v9' } }), DOC)).resolves.toBeNull();
  });
});

describe('Batch 3 refusal tokens map by message and SQLSTATE, with plain words', () => {
  const quotationTokens = ['referral_drafts_disabled', 'draft_closed', 'draft_not_closed', 'draft_already_linked', 'link_locked', 'deal_not_linked_to_draft'] as const;

  it('quotation tokens (atlas-batch3-shapes §1) map only with their state', () => {
    for (const token of quotationTokens) {
      expect(QUOTATION_ERROR_STATES[token]).toBe('55000');
      expect(mapQuotationError({ code: '55000', message: token })).toBe(token);
      expect(mapQuotationError({ code: '22023', message: token })).toBeNull();
      expect(QUOTATION_ERROR_TEXT[token].length).toBeGreaterThan(10);
    }
    expect(mapQuotationError({ code: '55P03', message: 'settings_busy' })).toBe('settings_busy');
  });

  it('itinerary writes on a closed draft and a switched-off create map too', () => {
    for (const token of ['draft_closed', 'referral_drafts_disabled'] as const) {
      expect(ITINERARY_ERROR_STATES[token]).toBe('55000');
      expect(mapItineraryError({ code: '55000', message: token })).toBe(token);
      expect(ITINERARY_ERROR_TEXT[token]).toMatch(/\.$/);
    }
  });

  it('the closed-draft words say how to repair it and that nothing was saved', () => {
    expect(QUOTATION_ERROR_TEXT.draft_closed).toBe('This draft is closed. Reopen it to make changes. Nothing was saved.');
  });
});

describe('subject links never build an "undefined" address', () => {
  it('lead, deal and referral pages; a missing id gives null', () => {
    expect(subjectHref('lead', 'l1')).toBe('/app/leads/l1');
    expect(subjectHref('deal', DEAL)).toBe(`/app/deals/${DEAL}`);
    expect(subjectHref('referral', DRAFT)).toBe(`/app/quotations/drafts/${DRAFT}`);
    expect(referralDraftHref(DRAFT)).toBe(`/app/quotations/drafts/${DRAFT}`);
    for (const id of [null, undefined, '', '  ']) expect(subjectHref('deal', id)).toBeNull();
  });

  it('quotation back links per subject kind, falling back to Home', () => {
    expect(quotationSubjectLink({ kind: 'lead', leadId: 'l1', dealId: null })).toEqual({ href: '/app/leads/l1', label: 'Back to the Lead' });
    expect(quotationSubjectLink({ kind: 'deal', leadId: null, dealId: DEAL })).toEqual({ href: `/app/deals/${DEAL}`, label: 'Back to the Deal' });
    expect(quotationSubjectLink({ kind: 'referral', leadId: null, dealId: null, referralDraftId: DRAFT })).toEqual({ href: `/app/quotations/drafts/${DRAFT}`, label: 'Back to the Referral draft' });
    expect(quotationSubjectLink({ kind: 'referral', leadId: null, dealId: null })).toEqual({ href: '/app', label: 'Back to home' });
    expect(quotationSubjectLink({ kind: 'deal', leadId: null, dealId: null }).href).not.toContain('undefined');
  });

  it('itinerary back links: Deal, else referral draft, else the quotation, else Home', () => {
    const none = { kind: 'none', id: null };
    expect(itineraryBackLink({ subject: { kind: 'deal', dealId: DEAL }, basis: none }).href).toBe(`/app/deals/${DEAL}`);
    expect(itineraryBackLink({ subject: { kind: 'referral', dealId: null, referralDraftId: DRAFT }, basis: none })).toEqual({ href: `/app/quotations/drafts/${DRAFT}`, label: 'Back to the referral draft' });
    expect(itineraryBackLink({ subject: { kind: 'quotation', dealId: null }, basis: { kind: 'quotation_version', id: V1 } }).href).toBe(`/app/quotations/${V1}`);
    expect(itineraryBackLink({ subject: { kind: 'referral', dealId: null }, basis: none })).toEqual({ href: '/app', label: 'Back to home' });
  });
});

describe('Home counts keep draftsToContinue and the FP-081 keys through the real parse (known Batch 1 defect, fixed in Batch 3)', () => {
  const base = { waitingForMe: 9, returnedToMe: 0, missingDetails: 1, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null };

  it('myWorkCounts() no longer strips draftsToContinue; the new keys pass through', async () => {
    const parsed = await myWorkCounts(client({ ...base, draftsToContinue: 2, quotationDraftsToFinish: 3, acceptedQuotesToLink: 1 }));
    expect(toMyWorkCounts(parsed)).toMatchObject({ waitingForMe: 9, draftsToContinue: 2, quotationDraftsToFinish: 3, acceptedQuotesToLink: 1 });
  });

  it('an older database without the keys reads null (not applicable), never 0', async () => {
    const counts = toMyWorkCounts(await myWorkCounts(client(base)));
    expect(counts.draftsToContinue).toBeNull();
    expect(counts.quotationDraftsToFinish).toBeNull();
    expect(counts.acceptedQuotesToLink).toBeNull();
  });
});
