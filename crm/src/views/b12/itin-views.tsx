import { ChevronLeft, CircleAlert, CircleCheck, Download, FileText, Hourglass, ListChecks, Map as MapIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { AdapterRefusal, ItineraryDocumentView } from '@/modules/documents/contracts';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { BrandedItineraryTemplate } from '@/modules/documents/render/branded-templates';
import { ITINERARY_DRAFT_STATUS_LABEL, ITINERARY_ERROR_TEXT, ITINERARY_TEXT, RENDER_KIND_LABEL, type ItineraryEditorView, type ItineraryJobView, type ItineraryListView } from '@/modules/itineraries/contracts';
import { dateText } from '../b11/book-fields';
import { CheckDifferencesForm, CreateItineraryForm, DifferencesList, FactsForm, ItinerarySync, MarkItineraryReadyForm, RequestRenderForm, SourceFiles } from './itin-forms';
import { itineraryHref, itineraryPreviewHref } from './itin-shapes';
import type { ItinActions } from './itin-kit';
import { QuotePreviewFrame } from './quote-preview-check';

/*
 * Itinerary screens (B1.2 Phase F), server-safe composition: the Itineraries
 * card on the quotation and Deal pages, the itinerary page (status, owner of
 * the next step and one primary action at the top; private source files;
 * facts; differences with the quotation or booking; document requests) and
 * the customer preview in the branded template.
 */

const textLink = cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing);

// ---------------------------------------------------------------------------
// Quotation and Deal pages: the "Branded itineraries" card
// ---------------------------------------------------------------------------

export function ItinerariesCard({ list, defaultTitle, createAction }: { list: ItineraryListView; defaultTitle: string; createAction: ItinActions['create'] }) {
  return (
    <Card>
      <section aria-labelledby={`itineraries-heading-${list.subjectKind}`}>
        <CardHeader>
          <CardTitle id={`itineraries-heading-${list.subjectKind}`}>Branded itineraries</CardTitle>
          <CardDescription className="basis-full">Day-by-day plan for the customer. Nothing is sent from here.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {list.documents.length === 0 ? <p className="m-0 text-copy">No itinerary yet.</p> : null}
          {list.documents.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Itineraries">
              {list.documents.map((d) => (
                <li key={d.documentId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
                  <MapIcon aria-hidden="true" className="size-4 shrink-0 text-brand-strong" />
                  <span className="min-w-40 flex-1">
                    <Link href={itineraryHref(d.documentId)} className={cn(textLink, 'font-semibold')}>
                      {d.title}
                    </Link>
                    <span className="block text-sm text-quiet">
                      Started {dateText(d.createdAt)}
                      {d.latestFinal ? ` · final document made ${dateText(d.latestFinal.createdAt)}` : ' · no final document yet'}
                    </span>
                  </span>
                  <StatusBadge tone={d.draftStatus === 'ready' ? 'success' : 'neutral'} wrap>
                    {ITINERARY_DRAFT_STATUS_LABEL[d.draftStatus]}
                  </StatusBadge>
                  {d.latestFinal ? (
                    <a href={d.latestFinal.downloadHref} className={cn(textLink, 'inline-flex min-h-11 items-center gap-1')}>
                      <Download aria-hidden="true" className="size-4" />
                      Download<span className="sr-only"> the final document of {d.title}</span>
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {list.canCreate ? <CreateItineraryForm subjectKind={list.subjectKind} subjectId={list.subjectId} defaultTitle={defaultTitle} action={createAction} /> : null}
        </CardBody>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The itinerary page
// ---------------------------------------------------------------------------

/** A next-step sentence as the words after "Next:" (lower case first letter, no full stop). */
export function nextLineText(sentence: string): string {
  const t = sentence.trim().replace(/\.$/, '');
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function DifferencesBadge({ e }: { e: ItineraryEditorView }) {
  if (e.basis.kind === 'none') return null;
  if (!e.differences.runId || !e.differences.current)
    return (
      <StatusBadge tone="warning" icon={Hourglass} wrap>
        Differences not checked yet
      </StatusBadge>
    );
  if (e.differences.openCount > 0)
    return (
      <StatusBadge tone="warning" icon={CircleAlert} wrap>
        {e.differences.openCount} open {e.differences.openCount === 1 ? 'difference' : 'differences'}
      </StatusBadge>
    );
  return (
    <StatusBadge tone="success" icon={CircleCheck} wrap>
      Matches the {e.basis.kind === 'booking_version' ? 'booking' : 'quotation'}
    </StatusBadge>
  );
}

function SectionCard({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24">
        <CardHeader>
          <CardTitle id={`${id}-heading`} tabIndex={-1} className="outline-none">
            {title}
          </CardTitle>
          {description ? <CardDescription className="basis-full">{description}</CardDescription> : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">{children}</CardBody>
      </section>
    </Card>
  );
}

/** Words from the job's own state (review E6-1): never a claim about whether the document maker is switched on. */
export function jobStatusText(j: Pick<ItineraryJobView, 'status' | 'errorText'>): string {
  switch (j.status) {
    case 'queued':
      return 'Waiting for the PDF maker. Nothing is sent to the customer.';
    case 'running':
      return 'Being made now.';
    case 'succeeded':
      return 'Made. Download it below.';
    case 'failed':
      return j.errorText ? `Could not be made: ${j.errorText}` : 'Could not be made. Check the facts and request it again.';
    case 'cancelled':
      return 'Cancelled.';
  }
}

type Primary = 'check' | 'settle' | 'ready' | 'final' | null;

function primaryOf(e: ItineraryEditorView): Primary {
  if (!e.canEditFacts) return null;
  if (e.basis.kind !== 'none' && (!e.differences.runId || !e.differences.current) && e.canCheckDifferences) return 'check';
  if (e.differences.openCount > 0) return 'settle';
  if (e.status === 'draft' && e.canMarkReady) return 'ready';
  if (e.status === 'ready' && e.canRequestFinal) return 'final';
  return null;
}

export function ItineraryScreen({ editor: e, actions, backHref, backLabel }: { editor: ItineraryEditorView; actions: ItinActions; backHref: string; backLabel: string }) {
  const primary = primaryOf(e);
  const reloadHref = itineraryHref(e.documentId);
  const basisWord = e.basis.kind === 'booking_version' ? 'booking' : 'quotation';
  return (
    <ItinerarySync editor={e}>
      <div className="font-sans text-base text-copy">
        <p className="m-0 mb-3">
          <Link href={backHref} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            {backLabel}
          </Link>
        </p>
        <PageHeader
          eyebrow={<span>Branded itinerary · {e.basis.label}</span>}
          title={
            <span id="itin-heading" tabIndex={-1} className="block wrap-anywhere outline-none">
              {e.title}
            </span>
          }
          status={
            <>
              <StatusBadge tone={e.status === 'ready' ? 'success' : 'neutral'} icon={ListChecks} wrap>
                <span className="sr-only">Itinerary status: </span>
                {ITINERARY_DRAFT_STATUS_LABEL[e.status]}
              </StatusBadge>
              <DifferencesBadge e={e} />
            </>
          }
        />
        <div className="flex flex-col gap-5">
          <Card>
            <CardBody className="flex flex-col gap-3">
              {/* Copy G-18: one Next line, lower case after "Next:", the actor after a dot. */}
              <p className="m-0 text-copy" data-slot="itin-next">
                <span className="font-semibold text-ink">Next:</span> {nextLineText(e.nextStepText)}
                <span className="text-quiet"> · {e.canEditFacts ? 'You' : 'The people preparing this trip'}</span>
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {primary === 'check' ? <CheckDifferencesForm editor={e} action={actions.checkDifferences} primary /> : null}
                {primary === 'settle' ? (
                  <a href="#differences" className={textLink}>
                    Settle the open differences
                  </a>
                ) : null}
                {primary === 'ready' ? <MarkItineraryReadyForm editor={e} action={actions.markReady} primary /> : null}
                {primary === 'final' ? <RequestRenderForm editor={e} kind="final" action={actions.requestRender} primary /> : null}
                <Link href={itineraryPreviewHref(e.documentId)} className={textLink}>
                  Preview what the customer sees
                </Link>
              </div>
            </CardBody>
          </Card>

          <SectionCard id="sources" title="Existing itinerary (optional, private)" description="Attach it to copy facts from it. It is never sent.">
            <SourceFiles editor={e} actions={actions} />
          </SectionCard>

          <SectionCard id="facts" title="Facts" description={`Trip details. Details copied from the ${basisWord} are marked. No prices or internal notes here.`}>
            <FactsForm editor={e} action={actions.saveFacts} reloadHref={reloadHref} />
          </SectionCard>

          {e.basis.kind !== 'none' ? (
            <SectionCard id="differences" title={`Differences from the ${basisWord}`} description="Settle each one before the itinerary is ready.">
              {primary !== 'check' && e.canCheckDifferences ? <CheckDifferencesForm editor={e} action={actions.checkDifferences} primary={false} /> : null}
              {e.differences.runId && !e.differences.current ? <Notice tone="warning">The facts or the {basisWord} changed since the last check. Check again.</Notice> : null}
              <DifferencesList editor={e} actions={actions} />
            </SectionCard>
          ) : e.subject.kind === 'referral' ? (
            // Batch 3 (DA-80, DA-81, narrowed by contracts F.5b): a referral itinerary has nothing to compare
            // with until a quotation of the draft is accepted; it never shows prices before that.
            <SectionCard id="differences" title="Differences" description="Nothing to compare with yet.">
              {/* contracts F.5b: a referral itinerary compares only with the draft's own accepted quotation. */}
              <p className="m-0 text-copy">Type the trip details yourself. Once a quotation on this draft is accepted, you can compare.</p>
              {e.pricesIncluded ? null : <p className="m-0 text-sm text-quiet">No prices: this itinerary has no accepted quotation.</p>}
            </SectionCard>
          ) : null}

          <SectionCard id="documents" title="Documents" description="PDFs. Nothing is sent to the customer.">
            {e.jobs.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Document requests">
                {e.jobs.map((j) => (
                  <li key={j.jobId} className="m-0 flex flex-wrap items-start gap-3 rounded-control border border-line bg-canvas px-3.5 py-2.5">
                    <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
                    <span className="min-w-40 flex-1">
                      <span className="block font-medium text-ink">
                        {RENDER_KIND_LABEL[j.kind]} · requested {dateText(j.createdAt)}
                      </span>
                      <span className="block text-sm text-copy">{jobStatusText(j)}</span>
                      {j.errorText && j.status !== 'failed' ? <span className="block text-sm text-status-danger">{j.errorText}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-copy">No document requested yet.</p>
            )}
            {e.rendered.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Made documents">
                {e.rendered.map((r) => (
                  <li key={r.renderedId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-2.5">
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-brand-strong" />
                    <span className="min-w-40 flex-1">
                      <span className="block font-medium text-ink">
                        {RENDER_KIND_LABEL[r.kind]} · {dateText(r.createdAt)}
                      </span>
                      <span className="block text-sm text-quiet">
                        {r.pageCount ? `${r.pageCount} pages · ` : ''}
                        {r.sizeLabel}
                        {r.qaNote ? ` · ${r.qaNote}` : ''}
                      </span>
                    </span>
                    <a href={r.downloadHref} className={cn(textLink, 'inline-flex min-h-11 items-center gap-1')}>
                      <Download aria-hidden="true" className="size-4" />
                      Download<span className="sr-only"> {RENDER_KIND_LABEL[r.kind].toLowerCase()}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {e.canRequestPreview ? <RequestRenderForm editor={e} kind="preview" action={actions.requestRender} primary={false} /> : null}
              {primary !== 'final' && e.status === 'ready' ? <RequestRenderForm editor={e} kind="final" action={actions.requestRender} primary={false} /> : null}
            </div>
            {e.pricesIncluded !== undefined ? <p className="m-0 text-sm text-copy">{e.pricesIncluded ? ITINERARY_TEXT.pricesIncluded : ITINERARY_TEXT.pricesNotIncluded}</p> : null}
            {e.status !== 'ready' ? <p className="m-0 text-sm text-quiet">The final document can be requested once the facts are ready.</p> : null}
          </SectionCard>
        </div>
      </div>
    </ItinerarySync>
  );
}

export function ItineraryNotAvailableView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Itinerary" />
      <Notice tone="locked">{ITINERARY_ERROR_TEXT.not_found}</Notice>
    </div>
  );
}

export function ItineraryNotInstalledView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Itinerary" />
      <Notice tone="info">{ITINERARY_TEXT.notInstalled}</Notice>
    </div>
  );
}

export function ItineraryUnavailableView({ backHref }: { backHref: string }) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Itinerary" />
      <Notice tone="danger" role="alert">
        The itinerary did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.{' '}
        <Link href={backHref} className={textLink}>
          Back
        </Link>
      </Notice>
    </div>
  );
}

/** Customer preview: the itinerary view (Nova) through the adapter and its safety scan into the branded template. */
export function ItineraryPreviewPage({ documentId, view }: { documentId: string; view: ItineraryDocumentView }) {
  const backHref = itineraryHref(documentId);
  const r = itineraryToEngine(view);
  if (!r.ok) return <QuotePreviewFrame backHref={backHref} backLabel="Back to the itinerary" check={{ kind: 'refused', refusals: r.refusals as AdapterRefusal[] }} />;
  return (
    <QuotePreviewFrame backHref={backHref} backLabel="Back to the itinerary" check={{ kind: 'ok', placeholders: r.placeholders }}>
      <BrandedItineraryTemplate input={r.input} id="itinerary-document" />
    </QuotePreviewFrame>
  );
}
