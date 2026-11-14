import { Link2, Lock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { CostEstimatesForm, DiscardDraftForm, QuoteEditor } from './quote-editor';
import { CheckAndMarkReadyButton, QuoteEditorShell } from './quote-editor-shell';
import { SectionFocus } from '../b11/section-focus';
import { quoteCopyLinks, quoteHeader } from '@/modules/quotations/editor-model';
import { quotationSubjectLink, referralDraftHref } from '@/modules/quotations/subject-links';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { AcceptForm, ConvertForm, CreateQuotationForm, DeclineForm, EvidenceList, EvidenceUploadForm, LinkDealForm, MarkSentForm, NewVersionForm } from './quote-forms';
import type { QuoteActions } from './quote-kit';
import { QuotePreviewFrame } from './quote-preview-check';
import { COMPANY_GSTIN_TEXT, companyGstinGapFor, quotationGstinWarning } from '@/modules/documents/company-identity';
import type { QuotationDocumentView } from '@/modules/documents/contracts';
import { quotationDayPlanNotice, quotationToEngineQuote } from '@/modules/documents/quotation-adapter';
import { BrandedQuotationTemplate } from '@/modules/documents/render/branded-templates';
import { bookingHref, quotationHref, quotationPreviewHref, type QuoteListView, type QuoteScreenData } from './quote-shapes';
import { latestVersion } from './quote-fields';
import { LinkStateNotice, QuoteLinkButton, QuotationScreen, QuotationsCard, type QuoteScreenSlots } from './quote-views';

/*
 * The real quotation pages (B1.2 Phase E), composed from the server-safe
 * views and the client forms. The routes only load and pass data; every
 * class name lives here so routes stay free of styling.
 */


export function QuotationPage({
  data,
  actions,
  today,
  related,
  prefillUi = null,
}: {
  data: QuoteScreenData;
  actions: QuoteActions;
  today: string;
  /** The branded itineraries card (loaded by the route). */
  related?: ReactNode;
  /** Batch 2 (D1): how Bitrix values show in the editor. Absent or panel → today's "From Bitrix" panel. */
  prefillUi?: PrefillUiVM | null;
}) {
  const v = data.version;
  const previewHref = quotationPreviewHref(v.versionId);
  const reloadHref = quotationHref(v.versionId);
  const backHref = quotationSubjectLink(v.subject).href;
  const header = quoteHeader({ version: v, versions: data.versions, candidates: data.candidates, ownerName: data.ownerName, fieldStates: v.prefill?.fieldStates ?? null });
  const copyLinks = quoteCopyLinks(v.versionId, 'edit');
  const slots: QuoteScreenSlots = { related };
  // DEC-50 review (lead decision): a missing company GSTIN warns before sending; it never blocks marking the quotation sent.
  const gstinGap = companyGstinGapFor(v.subject.branchCode);
  const gstinWarning = gstinGap ? (
    <Notice tone="warning" title={COMPANY_GSTIN_TEXT.quotationTitle}>
      <p>{quotationGstinWarning(gstinGap)}</p>
    </Notice>
  ) : null;
  // Batch 3: a referral quotation on a closed draft is read-only until the draft is reopened (DA-75).
  const referral = v.subject.kind === 'referral' ? (v.referral ?? null) : null;
  const closedNotice = referral && referral.status === 'closed' ? <ReferralClosedNotice draftId={referral.referralDraftId} reference={referral.reference} /> : null;
  if (closedNotice) slots.notice = closedNotice;
  switch (v.status) {
    case 'draft':
    case 'ready': {
      if (header.primary === 'check_and_mark_ready') slots.primary = <CheckAndMarkReadyButton />;
      else if (header.primary === 'mark_as_shared') slots.primary = <MarkSentForm version={v} action={actions.markSent} />;
      if (gstinWarning) slots.notice = closedNotice ? (
        <>
          {closedNotice}
          {gstinWarning}
        </>
      ) : gstinWarning;
      slots.editor = <QuoteEditor version={v} actions={actions} reloadHref={reloadHref} today={today} />;
      if (v.canDiscard) slots.secondary = <DiscardDraftForm version={v} action={actions.discard} backHref={backHref} />;
      return (
        <QuoteEditorShell version={v} actions={actions} prefillUi={prefillUi} reloadHref={reloadHref}>
          <QuotationScreen data={data} slots={slots} previewHref={previewHref} header={header} copyLinks={copyLinks} />
        </QuoteEditorShell>
      );
    }
    case 'sent': {
      if (header.primary === 'record_answer') slots.primary = <QuoteLinkButton href="#quote-answer-heading">Record the customer’s answer</QuoteLinkButton>;
      slots.acceptance = (
        <Card>
          <section id="quote-answer" aria-labelledby="quote-answer-heading" className="scroll-mt-24">
            <CardHeader>
              <CardTitle id="quote-answer-heading" tabIndex={-1} className="outline-none">
                Customer’s answer
              </CardTitle>
              <CardDescription className="basis-full">Upload their written yes for this version, then mark it accepted. A phone call or Bitrix stage is not proof.</CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
              <EvidenceList version={v} removeAction={actions.removeEvidence} />
              {v.canUploadEvidence ? <EvidenceUploadForm version={v} action={actions.uploadEvidence} /> : null}
              {v.canAccept || v.canUploadEvidence ? <AcceptForm version={v} action={actions.accept} /> : null}
              {v.canDecline ? (
                <div className="border-t border-line pt-4">
                  <DeclineForm version={v} action={actions.decline} />
                </div>
              ) : null}
            </CardBody>
          </section>
        </Card>
      );
      if (v.canNewVersion) slots.secondary = <NewVersionForm version={v} action={actions.newVersion} />;
      break;
    }
    case 'accepted': {
      if (v.conversion) slots.primary = <QuoteLinkButton href={bookingHref(v.conversion.dealId)}>Continue booking</QuoteLinkButton>;
      else if (v.canConvert) slots.primary = <ConvertForm version={v} action={actions.convert} />;
      // Batch 3 (lead ruling): a referral quotation books in two explicit steps. Step 1 "Link to Bitrix
      // Deal" happens on the draft page (pick, confirm); step 2 is "Start booking from this quotation".
      // Echo-B L5: only for someone who may link the draft (open, nothing tied to a deal yet).
      else if (referral && referral.status === 'open' && !v.linkedDealId && !referral.activeDealId && referral.canLink !== false) {
        slots.primary = (
          <QuoteLinkButton href={`${referralDraftHref(referral.referralDraftId)}?tab=link`}>
            <Link2 aria-hidden="true" className="size-4" />
            Link to Bitrix deal
          </QuoteLinkButton>
        );
      }
      const linkForm = !referral && data.candidates && data.candidates.length > 0 ? <LinkDealForm version={v} candidates={data.candidates} action={actions.linkDeal} /> : null;
      slots.acceptance = (
        <>
          <Card>
            <section aria-labelledby="quote-accepted-heading">
              <CardHeader>
                <CardTitle id="quote-accepted-heading">Acceptance and booking</CardTitle>
              </CardHeader>
              <CardBody className="flex flex-col gap-4">
                <LinkStateNotice data={data} linkForm={linkForm} />
                {referral && !v.conversion ? <ReferralBookingLine referral={referral} linked={Boolean(v.linkedDealId)} /> : null}
                <EvidenceList version={v} />
              </CardBody>
            </section>
          </Card>
          {v.money?.costRefreshAllowed ? <CostEstimatesForm version={v} action={actions.saveCostEstimates} /> : null}
        </>
      );
      // Before conversion a new version can still be sent; sending it replaces this acceptance (the customer accepts again).
      if (v.canNewVersion && !v.conversion) slots.secondary = <NewVersionForm version={v} action={actions.newVersion} />;
      break;
    }
    case 'expired':
    case 'declined': {
      if (v.canNewVersion) slots.primary = <NewVersionForm version={v} action={actions.newVersion} primary />;
      slots.acceptance = v.evidence.length > 0 ? <EvidenceList version={v} /> : undefined;
      break;
    }
    case 'superseded':
    case 'discarded': {
      const latest = latestVersion(data.versions);
      if (latest && latest.versionId !== v.versionId) slots.primary = <QuoteLinkButton href={quotationHref(latest.versionId)}>Open version {latest.versionNo}</QuoteLinkButton>;
      break;
    }
  }
  return (
    <>
      {/* In-page links (Record the customer’s answer, #quote-answer-heading) move focus, not only scroll (Echo L7). */}
      <SectionFocus />
      <QuotationScreen data={data} slots={slots} previewHref={previewHref} header={header} copyLinks={copyLinks} />
    </>
  );
}

/**
 * The customer preview: the customer view (quotation_get + quotation_customer_money,
 * the PDF's input) through the documents adapter (which runs the documents
 * safety scan) into the branded template the PDF uses.
 */
export function QuotationPreviewPage({ versionId, view, moneyVisible }: { versionId: string; view: QuotationDocumentView; moneyVisible: boolean }) {
  const backHref = quotationHref(versionId);
  const copyLinks = quoteCopyLinks(versionId, 'customer_copy');
  if (!moneyVisible) return <QuotePreviewFrame backHref={backHref} copyLinks={copyLinks} check={{ kind: 'no_money' }} />;
  const r = quotationToEngineQuote(view);
  if (!r.ok) return <QuotePreviewFrame backHref={backHref} copyLinks={copyLinks} check={{ kind: 'refused', refusals: r.refusals }} />;
  return (
    <QuotePreviewFrame backHref={backHref} copyLinks={copyLinks} check={{ kind: 'ok', document: 'quotation', placeholders: r.placeholders, notices: [quotationDayPlanNotice(view, r.input), r.placeholders.length > 0 ? 'You can still share it. Fill the missing details first if you can.' : null].filter((n): n is string => Boolean(n)) }}>
      <BrandedQuotationTemplate input={r.input} id="quote-document" />
    </QuotePreviewFrame>
  );
}

const draftLink = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

/** DA-75 on a referral quotation whose draft is closed: read-only, with the way back to Reopen. */
function ReferralClosedNotice({ draftId, reference }: { draftId: string; reference: string }) {
  return (
    <Notice tone="locked" icon={Lock}>
      <p>
        This referral draft is closed. Reopen it to make changes.{' '}
        <Link href={referralDraftHref(draftId)} className={draftLink}>
          Open referral draft {reference}
        </Link>
      </p>
    </Notice>
  );
}

/** Accepted referral quotation, before booking: where step 1 (Link to Bitrix Deal) stands (DA-70). */
function ReferralBookingLine({ referral, linked }: { referral: NonNullable<QuoteScreenData['version']['referral']>; linked: boolean }) {
  if (linked) return null;
  if (referral.activeDealId) {
    // DA-233 (Mercury F7, Echo-B L7): name the deal and say the tie is permanent.
    const deal = referral.activeDealReference ? ` ${referral.activeDealReference}` : '';
    return (
      <p className="m-0 text-copy">
        The draft is linked to the confirmed Bitrix deal{deal}. Starting the booking ties this quotation to that deal for good and starts one booking draft. Nothing is booked or
        paid.
      </p>
    );
  }
  return (
    <Notice tone="info" title="Waiting for the confirmed Bitrix deal">
      <p>
        Booking waits for the confirmed Bitrix deal: link referral draft{' '}
        <Link href={`${referralDraftHref(referral.referralDraftId)}?tab=link`} className={draftLink}>
          {referral.reference}
        </Link>{' '}
        to the deal first. Linking changes nothing in Bitrix.
      </p>
    </Notice>
  );
}

/** The "Quotations" card of a Lead or Deal page. */
export function SubjectQuotationsCard({
  list,
  subjectId,
  defaultTitle,
  createAction,
  blockedReason,
  createVariant = 'primary',
}: {
  list: QuoteListView;
  subjectId: string;
  defaultTitle: string;
  createAction: QuoteActions['create'];
  blockedReason?: string | null;
  /** Batch 1: 'secondary' on the Deal Quotations tab, where the header holds the page's one primary action. */
  createVariant?: 'primary' | 'secondary';
}) {
  return (
    <QuotationsCard
      list={list}
      blockedReason={blockedReason}
      createForm={list.canCreate ? <CreateQuotationForm subjectKind={list.subjectKind} subjectId={subjectId} defaultTitle={defaultTitle} action={createAction} variant={createVariant} /> : null}
    />
  );
}
