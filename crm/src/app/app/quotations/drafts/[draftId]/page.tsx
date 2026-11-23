import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadItineraryWorkList, loadQuotationWorkList, loadReferralDraft, loadReferralLinkCandidates, loadReferralOwnerCandidates, REFERRAL_LOAD_ERROR, REFERRAL_NOT_INSTALLED } from '@/modules/quotations/server/referral';
import { parseReferralTab, referralDraftVM, referralLinkStepVM, referralResultNotice } from '@/modules/quotations/work-model';
import { ReferralDraftLoadErrorView, ReferralDraftNotAvailableView, ReferralDraftNotInstalledView, ReferralDraftScreen } from '@/views/b12/referral-views';
import { ITINERARY_ACTIONS } from '../../../itineraries/itinerary-actions';
import { QUOTE_ACTIONS } from '../../quote-actions';
import { REFERRAL_ACTIONS } from '../../referral-actions';

export const metadata: Metadata = { title: 'Referral draft' };

type Params = { tab?: string | string[]; kind?: string | string[]; query?: string | string[]; done?: string | string[]; link?: string | string[] };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Referral draft (Batch 3, contracts B; lead ruling address). The database
 * answers only the draft's editors (owner with Sales in the branch, the
 * branch Manager, the linked Deal or Lead editors); everyone else gets the
 * same "not available" page, for a missing draft too. Reads never write
 * (opening the page does not count as activity). Closed drafts stay readable
 * and offer Reopen. The Link to Bitrix tab reads scoped candidates
 * (`?kind=lead|deal&query=`); nothing is preselected.
 */
export default async function ReferralDraftPage({ params, searchParams }: { params: Promise<{ draftId: string }>; searchParams: Promise<Params> }) {
  const [{ draftId }, query] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const record = await loadReferralDraft(staff, draftId);
  if (record === REFERRAL_NOT_INSTALLED) return <ReferralDraftNotInstalledView />;
  if (record === REFERRAL_LOAD_ERROR) return <ReferralDraftLoadErrorView />;
  if (!record) return <ReferralDraftNotAvailableView />;
  const tab = parseReferralTab(query.tab);
  const canLink = !record.links.some((l) => l.active && l.targetKind === 'deal') && record.can.link && record.status === 'open';

  const kind = one(query.kind) === 'lead' ? 'lead' : 'deal';
  const typed = (one(query.query) ?? '').trim().slice(0, 100);
  const search = typed.length >= 2 ? typed : null;
  // Echo L2 / Mercury F6: the draft's own rows from the lists (exact TD-n reference: every quotation and itinerary of
  // the draft, closed drafts included), with their own update time and difference count. A failed read falls back to the draft read.
  const [candidates, owners, quoteRows, itinRows] = await Promise.all([
    tab === 'link' && canLink ? loadReferralLinkCandidates(staff, record.referralDraftId, kind, search) : Promise.resolve(null),
    record.can.reassign ? loadReferralOwnerCandidates(staff, record.referralDraftId) : Promise.resolve(null),
    tab === 'quotations' ? loadQuotationWorkList(staff, { reference: record.reference }) : Promise.resolve(null),
    tab === 'itineraries' ? loadItineraryWorkList(staff, { reference: record.reference }) : Promise.resolve(null),
  ]);
  const rows = {
    quotations: quoteRows && typeof quoteRows === 'object' && quoteRows.applies ? quoteRows.rows : null,
    itineraries: itinRows && typeof itinRows === 'object' && itinRows.applies ? itinRows.rows : null,
  };
  const vm = referralDraftVM(record, tab, rows, referralResultNotice(record, query.done, query.link));
  // Echo M3: a failed candidate read says so on the Link tab (never an empty tab with no reason).
  const linkStep =
    tab === 'link' && canLink
      ? referralLinkStepVM({
          kind,
          branchName: record.branchName,
          query: typed,
          candidates: Array.isArray(candidates) ? candidates : null,
          draftLeadLinked: record.links.some((l) => l.active && l.targetKind === 'lead'),
        })
      : null;
  const ownerCandidates = Array.isArray(owners) ? owners.filter((o) => !o.isCurrentOwner).map((o) => ({ userId: o.userId, displayName: o.displayName })) : null;
  const customer = vm.can.edit && !vm.readOnly
    ? {
        customerName: record.customer.customerName,
        mobile: record.customer.mobile,
        email: record.customer.email,
        companyName: record.customer.companyName,
        sourceKind: record.source.kind,
        sourceNote: record.source.note,
      }
    : null;
  return (
    <ReferralDraftScreen
      vm={vm}
      actions={REFERRAL_ACTIONS}
      linkStep={linkStep}
      ownerCandidates={ownerCandidates}
      customer={customer}
      quoteCreate={QUOTE_ACTIONS.create}
      itinCreate={ITINERARY_ACTIONS.create}
    />
  );
}
