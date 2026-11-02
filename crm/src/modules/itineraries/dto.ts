import { companyGstinGapFor, companyGstinListNote, companyGstinMissingText } from '@/modules/documents/company-identity';
import { formatEvidenceSize } from '@/modules/fulfilment/dto';
import type { ItineraryGetRecord, ItineraryListRecord } from './commands';
import {
  BASIS_KIND_LABEL,
  ITINERARY_WORDING_LABEL,
  ITINERARY_TEXT,
  type ItineraryEditorView,
  type ItineraryListView,
  type ItinerarySubjectKind,
  itineraryRenderedHref,
  itinerarySourceHref,
  RENDER_ERROR_TEXT,
  RENDER_JOB_STATUS_TEXT,
} from './contracts';

/*
 * Itinerary DTO shaping (explicit copies). The editor is only ever shown to
 * editors (the read answers null to everyone else), so flags derive from the
 * draft state, the difference check and its open count.
 */

const WORDS: Record<string, string> = {
  destination: 'Destination',
  startDate: 'Start date',
  endDate: 'End date',
  party: 'Travellers',
  adults: 'adults',
  children: 'children',
  childAges: 'child ages',
  infants: 'infants',
  stays: 'Stay',
  days: 'Day',
  transfers: 'Transfer',
  activities: 'Activity',
  flights: 'Flight',
  inclusions: 'Inclusions',
  exclusions: 'Exclusions',
  city: 'city',
  nights: 'nights',
  checkIn: 'check-in',
  checkOut: 'check-out',
  hotelName: 'hotel',
  roomType: 'room type',
  mealPlan: 'meals',
  rooms: 'rooms',
  date: 'date',
  base: 'base',
  title: 'title',
  story: 'story',
  highlights: 'highlights',
  meals: 'meals',
  from: 'from',
  to: 'to',
  mode: 'how',
  name: 'name',
  included: 'included',
  carrier: 'airline',
  number: 'flight number',
  ...ITINERARY_WORDING_LABEL,
};

/** "stays[1].hotelName" → "Stay 2 · hotel" (difference paths are 0-based); unknown parts are shown as written (never values). */
export function differenceLabel(path: string): string {
  return path
    .split('.')
    .map((part) => {
      const m = /^([A-Za-z]+)(?:\[([^\]]*)\])?$/.exec(part);
      if (!m) return part;
      const word = WORDS[m[1]!] ?? m[1]!;
      if (m[2] === undefined) return word;
      return /^\d+$/.test(m[2]) ? `${word} ${Number(m[2]) + 1}` : `${word} ${m[2].replace(/[-_]/g, ' ')}`;
    })
    .join(' · ');
}

export function toItineraryListView(subjectKind: ItinerarySubjectKind, subjectId: string, rows: ItineraryListRecord): ItineraryListView {
  return {
    subjectKind,
    subjectId,
    canCreate: true,
    documents: rows.map((d) => ({
      documentId: d.documentId,
      title: d.title,
      subjectKind: d.subjectKind,
      draftStatus: d.draftStatus,
      createdAt: d.createdAt,
      latestFinal: d.latestFinal ? { renderedId: d.latestFinal.renderedId, createdAt: d.latestFinal.createdAt, downloadHref: itineraryRenderedHref(d.latestFinal.renderedId) } : null,
    })),
  };
}

/**
 * A made document's placeholder count in words. The QA keeps a count only;
 * when the document's branch has no approved company GSTIN, one of the
 * placeholders is that GSTIN mark (the adapter always prints exactly one),
 * so it is named separately and not counted as a missing fact (DEC-50
 * review). If the GSTIN was approved after the file was made, an older file's
 * mark is counted as a fact.
 */
export function renderedQaNote(placeholders: number, branchCode: string | null): string | null {
  if (placeholders <= 0) return null;
  const gap = companyGstinGapFor(branchCode);
  const facts = gap ? placeholders - 1 : placeholders;
  const parts = [facts > 0 ? `${facts} missing ${facts === 1 ? 'fact' : 'facts'} in brackets` : null, gap ? companyGstinListNote(gap) : null];
  return parts.filter((p): p is string => p !== null).join(' · ');
}

const GSTIN_OTHER_FACTS_TEXT = 'Any other missing facts show in brackets on the preview.';

/**
 * A render job's error in words. DEC-50 review: when the final was refused for
 * missing facts and the document's branch has no approved company GSTIN, say
 * so plainly (Accounts' data, nothing for staff to fill in).
 */
export function renderErrorText(code: string, branchCode: string | null): string {
  const gap = code === 'placeholders_present' ? companyGstinGapFor(branchCode) : null;
  if (gap) return `${companyGstinMissingText(gap)} ${GSTIN_OTHER_FACTS_TEXT}`;
  return RENDER_ERROR_TEXT[code] ?? RENDER_ERROR_TEXT.internal!;
}
export function toItineraryEditorView(r: ItineraryGetRecord): ItineraryEditorView {
  const items = r.differences.items.map((d) => ({
    differenceId: d.differenceId,
    path: d.path,
    kind: d.kind,
    label: differenceLabel(d.path),
    acknowledged: d.acknowledged,
    acknowledgedByName: d.acknowledgedByName,
    acknowledgedAt: d.acknowledgedAt,
    note: d.note,
  }));
  const openCount = items.filter((d) => !d.acknowledged).length;
  const open = r.referral?.status !== 'closed';
  const current = r.differences.current;
  const status = r.draft.status;
  const live = r.sources.length;
  let nextStepText: string;
  if (!r.draft.facts.destination && r.draft.facts.days.length === 0) nextStepText = ITINERARY_TEXT.nextAttachOrFacts;
  else if (!current) nextStepText = ITINERARY_TEXT.nextCheck;
  else if (openCount > 0) nextStepText = ITINERARY_TEXT.nextSettle;
  else if (status === 'draft') nextStepText = ITINERARY_TEXT.nextReady;
  else nextStepText = ITINERARY_TEXT.nextFinal;
  return {
    documentId: r.documentId,
    title: r.title,
    subject: { kind: r.subject.kind, quotationId: r.subject.quotationId, dealId: r.subject.dealId, referralDraftId: r.subject.referralDraftId ?? null },
    draftId: r.draft.draftId,
    status,
    rowVersion: r.draft.rowVersion,
    facts: r.draft.facts,
    factsHash: r.draft.factsHash,
    sourceFileId: r.draft.sourceFileId,
    updatedAt: r.draft.updatedAt,
    basis: { kind: r.basis.kind, id: r.basis.id, hash: r.basis.hash, label: BASIS_KIND_LABEL[r.basis.kind] },
    differences: { runId: r.differences.runId, current, openCount, items },
    sources: r.sources.map((s) => ({
      fileId: s.fileId,
      fileName: s.fileName,
      mime: s.mime,
      sizeLabel: formatEvidenceSize(s.sizeBytes),
      status: s.status,
      uploadedAt: s.createdAt,
      downloadHref: s.status === 'stored' ? itinerarySourceHref(s.fileId) : null,
    })),
    jobs: r.jobs.map((j) => ({
      jobId: j.jobId,
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      statusText: RENDER_JOB_STATUS_TEXT[j.status],
      errorText: j.lastErrorCode ? renderErrorText(j.lastErrorCode, r.subject.branchCode) : null,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    })),
    rendered: r.rendered.map((d) => ({
      renderedId: d.renderedId,
      kind: d.kind,
      pageCount: d.pageCount,
      sizeLabel: formatEvidenceSize(d.sizeBytes),
      createdAt: d.createdAt,
      downloadHref: itineraryRenderedHref(d.renderedId),
      qa: d.qa ? { placeholders: d.qa.placeholders, layoutIssues: [...d.qa.layoutIssues], safetyHits: [...d.qa.safetyHits] } : null,
      qaNote: d.qa ? renderedQaNote(d.qa.placeholders, r.subject.branchCode) : null,
    })),
    pricesIncluded: r.money !== null,
    // Batch 3: a closed referral draft refuses every write (draft_closed), so nothing is offered.
    canEditFacts: open,
    canCheckDifferences: open,
    canMarkReady: open && status === 'draft' && current && openCount === 0,
    canRequestPreview: open,
    canRequestFinal: open && status === 'ready' && current && openCount === 0,
    canAddSource: open && live < 10,
    nextStepText: open ? nextStepText : ITINERARY_TEXT.referralDraftClosed,
    referral: r.referral
      ? {
          referralDraftId: r.referral.referralDraftId,
          reference: r.referral.reference,
          status: r.referral.status,
          closedReason: r.referral.closedReason,
          closedAt: r.referral.closedAt,
          autoClose: { state: r.referral.autoClose.state, dueOn: r.referral.autoClose.dueOn },
          linked: r.referral.linked,
          bound: r.referral.bound,
          activeDealId: r.referral.activeDealId,
          activeLeadId: r.referral.activeLeadId,
          canReopen: r.referral.canReopen,
        }
      : null,
  };
}
