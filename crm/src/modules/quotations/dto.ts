import { ServiceFactsSchema } from '@/modules/fulfilment/commands';
import { SERVICE_TYPE_LABEL, type ServiceFacts } from '@/modules/fulfilment/contracts';
import { formatEvidenceSize, itemTitle } from '@/modules/fulfilment/dto';
import { toPrefillView } from '@/modules/fulfilment/b11-dto';
import type { LinkCandidatesRecord, MoneyRecord, QuotationGetRecord, QuotationListRecord } from './commands';
import {
  QUOTATION_CHECKLIST_CODES,
  QUOTATION_MONEY_BLOCKERS,
  QUOTATION_MONEY_WARNINGS,
  QUOTATION_TEXT,
  type QuotationChecklistCode,
  type QuotationEvidenceView,
  type QuotationItemView,
  type QuotationLinkCandidate,
  type QuotationListView,
  type QuotationMoneyIssue,
  type QuotationMoneyView,
  type QuotationStatus,
  type QuotationSubjectKind,
  type QuotationSummary,
  type QuotationVersionView,
  quotationEvidenceHref,
} from './contracts';

/*
 * Quotation DTO shaping (explicit copies, never spreads of records). Money
 * members are copied only when the database sent them (Mercury returns them
 * to commercial readers only); nothing here computes money. Permission flags
 * are derived from the database's canEdit and the effective state; every
 * command checks again.
 */

const MONEY_CODES = new Set<string>([...QUOTATION_MONEY_BLOCKERS, ...QUOTATION_MONEY_WARNINGS]);
const CHECKLIST_CODES = new Set<string>(QUOTATION_CHECKLIST_CODES);
const EDITABLE: readonly QuotationStatus[] = ['draft', 'ready'];

function knownChecklist(codes: readonly string[]): QuotationChecklistCode[] {
  return [...new Set(codes)].filter((c): c is QuotationChecklistCode => CHECKLIST_CODES.has(c));
}

function knownMoney(codes: readonly string[]): QuotationMoneyIssue[] {
  return [...new Set(codes)].filter((c): c is QuotationMoneyIssue => MONEY_CODES.has(c));
}

export function toQuotationListView(subjectKind: QuotationSubjectKind, subjectId: string, rows: QuotationListRecord): QuotationListView {
  const quotations: QuotationSummary[] = rows.map((q) => {
    const versions = [...q.versions]
      .sort((a, b) => b.versionNo - a.versionNo)
      .map((v) => ({
        versionId: v.versionId,
        versionNo: v.versionNo,
        status: v.status,
        validUntil: v.validUntil,
        sentAt: v.sentAt,
        acceptedTierKey: v.acceptedTier,
      }));
    const working = versions.find((v) => EDITABLE.includes(v.status));
    return {
      quotationId: q.quotationId,
      reference: q.reference,
      title: q.title,
      subjectKind: q.subjectKind,
      leadId: q.leadId,
      dealId: q.dealId,
      referralDraftId: q.referralDraftId ?? null,
      linkedDealId: q.linkedDealId,
      acceptedVersionId: q.acceptedVersionId,
      converted: q.converted,
      bookingVersionId: q.bookingVersionId,
      createdAt: q.createdAt,
      rowVersion: q.rowVersion,
      versions,
      currentVersionId: (working ?? versions[0])?.versionId ?? '',
    };
  });
  return { subjectKind, subjectId, quotations: quotations.filter((q) => q.currentVersionId !== ''), canCreate: true };
}

export function toMoneyView(m: MoneyRecord): QuotationMoneyView {
  return {
    lines: m.lines.map((l) => ({
      lineNo: l.lineNo,
      optionKey: l.optionKey,
      itemId: l.itemId,
      itemNo: l.itemNo,
      chargeKind: l.chargeKind,
      categoryKey: l.categoryKey,
      description: l.description,
      unitKind: l.unitKind,
      units: l.units,
      periods: l.periods,
      quantity: l.quantity,
      unitSellPaise: l.unitSellPaise,
      unitCostPaise: l.unitCostPaise,
      lineSellPaise: l.lineSellPaise,
      lineCostPaise: l.lineCostPaise,
      remark: l.remark,
    })),
    tiers: m.tiers.map((t) => ({
      tierKey: t.tierKey,
      label: t.label,
      quotedTotalPaise: t.quotedTotalPaise,
      payingTravellers: t.payingTravellers,
      showPerPerson: t.showPerPerson,
      lineCount: t.lineCount,
      componentSellPaise: t.componentSellPaise,
      componentDifferencePaise: t.differencePaise,
      costTotalPaise: t.costTotalPaise,
      costComplete: t.costComplete,
      marginPaise: t.marginPaise,
      perPersonPaise: t.perPersonPaise,
      planTotalPaise: t.planTotalPaise,
      planCount: t.planCount,
    })),
    plan: m.instalments.map((p) => ({ tierKey: p.tierKey, seq: p.seq, label: p.label, amountPaise: p.amountPaise, dueRule: p.dueRule, dueDays: p.dueDays, dueDate: p.dueDate })),
    issues: knownMoney(m.codes),
    costRefreshAllowed: m.costRefreshAllowed,
  };
}

function toItem(i: QuotationGetRecord['items'][number]): QuotationItemView {
  const parsed = ServiceFactsSchema.safeParse({ type: i.serviceType, facts: i.facts });
  // An invalid draft item still loads (the editor shows what to fix); its facts are the stored values as they are.
  const service: ServiceFacts = parsed.success ? parsed.data : ({ type: i.serviceType, facts: { ...i.facts } } as unknown as ServiceFacts);
  return {
    itemId: i.itemId,
    itemNo: i.itemNo,
    serviceType: i.serviceType,
    tierKey: i.tierKey,
    service,
    factsValid: parsed.success && i.factsValid,
    title: i.title ?? (parsed.success ? itemTitle(parsed.data) : SERVICE_TYPE_LABEL[i.serviceType]),
  };
}

function toEvidence(e: QuotationGetRecord['evidence'][number]): QuotationEvidenceView {
  return {
    evidenceId: e.id,
    kind: e.kind,
    fileName: e.fileName,
    mime: e.mime,
    sizeLabel: formatEvidenceSize(e.sizeBytes),
    status: e.status,
    uploadedByYou: e.uploadedByYou,
    uploadedAt: e.createdAt,
    storedAt: e.storedAt,
    downloadHref: e.status === 'stored' ? quotationEvidenceHref(e.id) : null,
  };
}

export function toQuotationVersionView(r: QuotationGetRecord): QuotationVersionView {
  const v = r.version;
  const status = v.status;
  // quotation_get answers only its editors (null otherwise); its canEdit means "this version is still editable".
  // Batch 3: a closed referral draft refuses every write (draft_closed), so nothing is offered.
  const referral = r.referral ?? null;
  const draftClosed = referral?.status === 'closed';
  const editor = !draftClosed;
  const editable = r.canEdit && EDITABLE.includes(status);
  const converted = r.conversion !== null;
  const evidence = r.evidence.map(toEvidence);
  const hasAcceptanceFile = evidence.some((e) => e.kind === 'acceptance_message' && e.status === 'stored');
  const isLead = r.subject.kind === 'lead';
  const isReferral = r.subject.kind === 'referral';
  const linkedDealId = r.subject.linkedDealId;
  const items = r.items.map(toItem).sort((a, b) => a.itemNo - b.itemNo);
  const pax = r.pax;
  const total = pax.adults + pax.childrenWithBed + pax.childrenNoBed + pax.infants;
  const money = r.money ? toMoneyView(r.money) : undefined;
  const accepted = status === 'accepted';
  let nextStepText: string | null = null;
  if (accepted && isLead && !linkedDealId && !converted) nextStepText = QUOTATION_TEXT.waitingForDeal;
  // Mercury F31 (DA-232): the waiting sentence shows once, in the page's notice; the header "Next:" line says the step.
  if (draftClosed) nextStepText = QUOTATION_TEXT.referralDraftClosed;
  // Batch 3: a referral quotation books only into the draft's active Deal link (bound first, then converted).
  const referralBookable = isReferral && (linkedDealId !== null || (referral?.activeDealId ?? null) !== null);

  return {
    quotationId: r.quotationId,
    reference: r.reference,
    title: r.title,
    subject: { kind: r.subject.kind, leadId: r.subject.leadId, dealId: r.subject.dealId, referralDraftId: r.subject.referralDraftId ?? null, reference: r.subject.reference, title: r.subject.title, branchCode: r.subject.branchCode },
    linkedDealId,
    quotationRowVersion: r.rowVersion,
    versionId: v.versionId,
    versionNo: v.versionNo,
    status,
    rowVersion: v.rowVersion,
    contentHash: v.contentHash,
    basedOnVersionId: v.basedOnVersionId,
    trip: { destination: r.trip.destination, scope: r.trip.scope, start: r.trip.start, end: r.trip.end },
    pax: { adults: pax.adults, childrenWithBed: pax.childrenWithBed, childrenNoBed: pax.childrenNoBed, infants: pax.infants, paxRemarks: pax.paxRemarks },
    travellerCount: total > 0 ? total : null,
    requirementsNote: r.requirementsNote,
    contact: r.contacts ? { ...r.contacts } : null,
    content: {
      days: r.content.days.map((d) => ({ day: d.day, title: d.title, text: d.text })),
      includes: [...r.content.includes],
      excludes: [...r.content.excludes],
      terms: [...r.content.terms],
      notes: r.content.notes,
    },
    tiers: r.tiers.map((t) => ({ tierKey: t.tierKey, label: t.label })).sort((a, b) => (a.tierKey === b.tierKey ? 0 : a.tierKey === 'quoted' ? -1 : 1)),
    items,
    validUntil: v.validUntil,
    sent: v.sentAt ? { at: v.sentAt, channel: v.sentChannel } : null,
    accepted: v.acceptedAt && v.acceptedTier ? { at: v.acceptedAt, tierKey: v.acceptedTier } : null,
    declined: v.declinedAt ? { at: v.declinedAt, reason: v.declineReason } : null,
    issues: EDITABLE.includes(status) ? knownChecklist(r.issues) : [],
    evidence,
    ...(money ? { money } : {}),
    conversion: r.conversion ? { dealId: r.conversion.dealId, bookingVersionId: r.conversion.bookingVersionId, convertedAt: r.conversion.createdAt } : null,
    ...(r.prefill ? { prefill: toPrefillView(r.prefill, { target: 'quotation', canEdit: editable && !converted, unchecked: r.prefill.unchecked }) } : {}),
    canEdit: editable && !draftClosed,
    canEditMoney: editable && money !== undefined,
    canMarkReady: editable && status === 'draft',
    canSend: editable && status === 'ready' && v.contentHash !== null && !converted,
    canUploadEvidence: editor && status === 'sent',
    canAccept: editor && status === 'sent' && hasAcceptanceFile && v.contentHash !== null,
    canDecline: editor && status === 'sent',
    canNewVersion: editor && !converted && status !== 'discarded' && !EDITABLE.includes(status),
    canDiscard: editable,
    canLinkDeal: editor && accepted && isLead && !linkedDealId && !converted,
    // Lead: after the link; referral: after the draft's Deal link (Start booking binds, then converts); Deal: always.
    canConvert: editor && accepted && !converted && v.contentHash !== null && (isLead ? linkedDealId !== null : isReferral ? referralBookable : true),
    nextStepText,
    referral: referral
      ? {
          referralDraftId: referral.referralDraftId,
          reference: referral.reference,
          status: referral.status,
          closedReason: referral.closedReason,
          closedAt: referral.closedAt,
          autoClose: { state: referral.autoClose.state, dueOn: referral.autoClose.dueOn },
          linked: referral.linked,
          bound: referral.bound,
          activeDealId: referral.activeDealId,
          activeLeadId: referral.activeLeadId,
          canReopen: referral.canReopen,
          // Echo L5: the draft's editors may link it while it is open and nothing of it is tied to a deal.
          canLink: referral.status === 'open' && !referral.bound,
          activeDealReference: null,
          ownerName: referral.ownerIsYou ? 'You' : (referral.ownerName ?? null),
          ownerIsYou: referral.ownerIsYou ?? false,
        }
      : null,
  };
}

export function toLinkCandidates(rows: LinkCandidatesRecord): QuotationLinkCandidate[] {
  return rows.map((c) => ({
    dealId: c.dealId,
    reference: c.reference,
    title: c.title,
    branchName: c.branchName,
    sameBranch: c.sameBranch,
    active: c.active,
    linkable: c.linkable,
  }));
}
