/**
 * Where a quotation's or itinerary's subject lives, and how to name it
 * (Direction A Batch 3, lead ruling "one subjectHref() helper"). One function
 * so no screen builds `/app/deals/undefined`: a missing id gives null and the
 * caller falls back to a page that always exists.
 *
 * Addresses: Leads and Deals keep theirs; a referral draft (TD-n, a customer
 * not in Bitrix yet) opens at /app/quotations/drafts/[draftId] (lead ruling,
 * 21 October 2026).
 */

export type SubjectLinkKind = 'lead' | 'deal' | 'referral';

export const REFERRAL_DRAFTS_PATH = '/app/quotations/drafts';

/** The page that always exists, used when a subject id is missing. */
export const SUBJECT_FALLBACK_HREF = '/app';

export function referralDraftHref(draftId: string): string {
  return `${REFERRAL_DRAFTS_PATH}/${draftId}`;
}

/** The subject's own page, or null when the id is missing (never an "undefined" address). */
export function subjectHref(kind: SubjectLinkKind, id: string | null | undefined): string | null {
  if (typeof id !== 'string' || id.trim() === '') return null;
  const safe = encodeURIComponent(id);
  switch (kind) {
    case 'lead':
      return `/app/leads/${safe}`;
    case 'deal':
      return `/app/deals/${safe}`;
    case 'referral':
      return referralDraftHref(safe);
  }
}

/** Plain noun for the subject ("Back to the Lead", "Lead L-55"). */
export const SUBJECT_NOUN: Record<SubjectLinkKind, string> = {
  lead: 'Lead',
  deal: 'Deal',
  referral: 'Referral draft',
};

/** A quotation subject (QuotationSubjectView shape) → its page and back-link words. */
export function quotationSubjectLink(subject: {
  kind: SubjectLinkKind;
  leadId: string | null;
  dealId: string | null;
  referralDraftId?: string | null;
}): { href: string; label: string } {
  const id = subject.kind === 'lead' ? subject.leadId : subject.kind === 'deal' ? subject.dealId : subject.referralDraftId;
  const href = subjectHref(subject.kind, id);
  return href ? { href, label: `Back to the ${SUBJECT_NOUN[subject.kind]}` } : { href: SUBJECT_FALLBACK_HREF, label: 'Back to home' };
}

/**
 * An itinerary's back link: its Deal, else its referral draft, else the
 * quotation it was made from, else Home.
 */
export function itineraryBackLink(input: {
  subject: { kind: 'quotation' | 'deal' | 'referral'; dealId: string | null; referralDraftId?: string | null };
  basis: { kind: string; id: string | null };
}): { href: string; label: string } {
  const { subject, basis } = input;
  if (subject.kind === 'deal') {
    const href = subjectHref('deal', subject.dealId);
    if (href) return { href, label: 'Back to the Deal' };
  }
  if (subject.kind === 'referral') {
    const href = subjectHref('referral', subject.referralDraftId);
    if (href) return { href, label: 'Back to the referral draft' };
  }
  if (basis.kind === 'quotation_version' && basis.id) return { href: `/app/quotations/${encodeURIComponent(basis.id)}`, label: 'Back to the quotation' };
  return { href: SUBJECT_FALLBACK_HREF, label: 'Back to home' };
}
