import 'server-only';
import { getVisibleDeal } from '@/modules/deals/server/queries';
import type { StaffContext } from '@/modules/identity/server/session';
import { loadLead } from '@/modules/leads/server/queries';
import { loadQuotation, loadQuotationLinkCandidates, loadQuotationsForDeal, loadQuotationsForLead, loadQuotationsForReferral, QUOTATIONS_NOT_INSTALLED } from '@/modules/quotations/server/queries';
import type { QuoteScreenData } from '@/views/b12/quote-shapes';

/**
 * Everything one quotation page shows: the version (the database decides who
 * may read it: Sales owner or assignee and the branch Manager only; null for
 * everyone else, the same as missing), the version list, the owner's name,
 * the linked Deal's reference and, for an accepted Lead quotation not linked
 * yet, the Deals Bitrix made from the Lead. A failed side read never hides
 * the quotation.
 */
export async function loadQuoteScreen(staff: StaffContext, versionId: string): Promise<QuoteScreenData | null | typeof QUOTATIONS_NOT_INSTALLED> {
  const version = await loadQuotation(staff, versionId);
  if (!version || version === QUOTATIONS_NOT_INSTALLED) return version;
  const s = version.subject;
  // Batch 3 (Echo-B M5): a referral quotation lists its versions through its draft and names the draft's owner.
  const referral = version.referral ?? null;
  const listRead = (
    s.kind === 'lead' && s.leadId
      ? loadQuotationsForLead(staff, s.leadId)
      : s.kind === 'referral' && s.referralDraftId
        ? loadQuotationsForReferral(staff, s.referralDraftId)
        : s.dealId
          ? loadQuotationsForDeal(staff, s.dealId)
          : Promise.resolve(null)
  ).catch(() => null);
  const ownerRead: Promise<string | null> = (
    s.kind === 'lead' && s.leadId
      ? loadLead(staff, s.leadId).then((l) => (l && l !== 'no_permission' ? l.ownerName : null))
      : s.kind === 'referral'
        ? Promise.resolve(referral?.ownerName ?? null)
        : s.dealId
          ? getVisibleDeal(staff, s.dealId).then((d) => d?.ownerName ?? null)
          : Promise.resolve(null)
  ).catch(() => null);
  // Echo L7: the draft's linked deal, named on the booking line (null when the viewer cannot read it).
  const referralDealRead = referral?.activeDealId && referral.activeDealId !== version.linkedDealId ? getVisibleDeal(staff, referral.activeDealId).catch(() => null) : Promise.resolve(null);
  const linkedRead = version.linkedDealId ? getVisibleDeal(staff, version.linkedDealId).catch(() => null) : Promise.resolve(null);
  const needsCandidates = s.kind === 'lead' && version.status === 'accepted' && !version.linkedDealId;
  const candidatesRead = needsCandidates ? loadQuotationLinkCandidates(staff, version.quotationId).catch(() => null) : Promise.resolve(null);
  const [list, ownerName, linked, candidates, referralDeal] = await Promise.all([listRead, ownerRead, linkedRead, candidatesRead, referralDealRead]);
  if (referral) {
    const deal = referral.activeDealId === version.linkedDealId ? linked : referralDeal;
    version.referral = { ...referral, activeDealReference: deal?.reference ?? null };
  }
  const summary = list && list !== QUOTATIONS_NOT_INSTALLED ? list.quotations.find((q) => q.quotationId === version.quotationId) : undefined;
  return {
    version,
    versions: summary?.versions ?? [{ versionId: version.versionId, versionNo: version.versionNo, status: version.status, validUntil: version.validUntil, sentAt: version.sent?.at ?? null, acceptedTierKey: version.accepted?.tierKey ?? null }],
    candidates: needsCandidates ? (candidates ?? []) : null,
    ownerName,
    linkedDeal: linked ? { reference: linked.reference, title: linked.title } : null,
  };
}
