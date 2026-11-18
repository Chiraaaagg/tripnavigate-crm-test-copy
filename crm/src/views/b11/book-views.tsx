import { ChevronLeft, CircleCheck, Clock, FileQuestion, Hourglass, Lock, PenLine, RotateCcw, Send, TriangleAlert, UserRound } from 'lucide-react';
import { QuotationSourceNote } from './quotation-source';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StepNav } from '@/components/ui/stepper';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Timeline } from '@/components/ui/timeline';
import { BOOK_NOW_TEXT, CHANGED_FIELD_GROUP_LABEL, SERVICE_NEXT_STEP_TEXT } from '@/modules/fulfilment/contracts';
import { ProgressPill, ServiceStatePill, ServiceTypePill, serviceOwnerText } from '../service-labels';
import { ClaimsSummary, ClaimStatusPill } from './book-claims';
import { B11_DEPARTMENT_LABEL, BOOK_STEP_LABEL, BOOK_STEPS, blockingCount, dateText, inr, REVIEW_STATUS_LABEL, stepItems } from './book-fields';
import { SavedAnnouncer } from './form-kit';
import { itemSummary } from './service-fields';
import type { BookNowView, BookStep } from './shapes';

/*
 * Book now frame and read-only screens (B1.1a, Lagoon). Server-safe: the
 * forms inside are client components passed in as children. One h1 (the
 * Deal title), status, owner and next step at the top, the step list beside
 * the step card, honest "not available" and loading states.
 */

function BackToDeal({ href }: { href: string }) {
  return (
    <p className="m-0 mb-3">
      <Link href={href} className={cn('inline-flex min-h-6 items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        Back to the deal
      </Link>
    </p>
  );
}

function StagePill({ stage }: { stage: BookNowView['stage'] }) {
  if (!stage) {
    return (
      <StatusBadge tone="neutral" wrap>
        <span className="sr-only">Bitrix stage: </span>Test record (not from Bitrix)
      </StatusBadge>
    );
  }
  return stage.isTriggerStage ? (
    <StatusBadge tone="success" icon={CircleCheck} wrap>
      <span className="sr-only">Bitrix stage: </span>
      {stage.label ?? stage.stageId} · submission allowed
    </StatusBadge>
  ) : (
    <StatusBadge tone="warning" icon={Hourglass} wrap>
      <span className="sr-only">Bitrix stage: </span>
      {stage.label ?? `Bitrix stage ${stage.stageId}`} · waiting for Won - Payment Received
    </StatusBadge>
  );
}

function versionPill(view: BookNowView): { tone: StatusTone; icon: typeof Clock; text: string } {
  const v = view.version;
  if (!v) return { tone: 'neutral', icon: Clock, text: 'Not started' };
  if (v.status === 'draft' && v.revisesVersionId) return { tone: 'warning', icon: RotateCcw, text: `Fixing version ${v.revisesVersionNo ?? ''} · draft` };
  if (v.status === 'draft') return { tone: 'warning', icon: PenLine, text: `Draft · version ${v.versionNo}` };
  return { tone: 'success', icon: Send, text: `Submitted · accepted version ${v.versionNo}` };
}

function OwnerLine({ ownerText }: { ownerText: string | null | undefined }) {
  if (ownerText === undefined) return null;
  if (ownerText === null) {
    return (
      <StatusBadge tone="warning" icon={Hourglass}>
        Waiting for owner
      </StatusBadge>
    );
  }
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-copy">
      <UserRound aria-hidden="true" className="size-4 shrink-0 text-faint" />
      <span className="min-w-0">
        Owner: <span className="font-semibold text-ink">{ownerText}</span>
      </span>
    </span>
  );
}

/**
 * The one "Next:" line (copy B0-06, G-18): the same words as the Deal header
 * (DA-21a, DA-25, DA-27, DA-29a, DA-113), lower case after "Next:", with the
 * actor after a dot only when it is the viewer.
 */
export function bookNextStep(view: BookNowView): { text: string; actor?: string } {
  const blocking = blockingCount(view.checklist);
  const v = view.version;
  if (view.dealNotActive) return { text: 'nothing while the deal is lost or rejected in Bitrix' };
  if (!v) return view.canEdit ? { text: 'start the booking', actor: 'You' } : { text: 'Sales on this deal or the branch Manager starts the booking' };
  if (v.status !== 'draft') {
    if (view.accountsReview?.status === 'returned') {
      return view.canOpenRevision ? { text: 'fix what Accounts asked for', actor: 'You' } : { text: 'Sales on this deal or the branch Manager fixes what Accounts asked for' };
    }
    if (view.accountsReview?.status === 'approved') return { text: 'the teams arrange the services. Nothing is booked until the supplier confirms.' };
    return { text: 'Accounts checks the booking' };
  }
  if (!view.canEdit) return { text: 'Sales on this deal or the branch Manager finishes the booking' };
  const onlyStage = blocking === 1 && view.checklist.some((i) => i.blocking && i.code === 'stage_not_confirmed');
  if (onlyStage) return { text: 'wait for Won - Payment Received in Bitrix. You can keep preparing.' };
  if (blocking > 0) return { text: `finish ${blocking === 1 ? '1 thing' : `${blocking} things`}`, actor: 'You' };
  return { text: 'review and submit (step 3)', actor: 'You' };
}

export function BookNowHeader({ view, ownerText, dealHref }: { view: BookNowView; ownerText?: string | null; dealHref: string }) {
  const pill = versionPill(view);
  const next = bookNextStep(view);
  const v = view.version;
  return (
    <>
      <BackToDeal href={dealHref} />
      <PageHeader
        eyebrow={<span className="wrap-anywhere">Book now · {view.dealReference}</span>}
        title={
          <span id="book-heading" tabIndex={-1} className="block wrap-anywhere outline-none">
            {view.dealTitle}
          </span>
        }
        status={
          <>
            <StatusBadge tone={pill.tone} icon={pill.icon} wrap>
              <span className="sr-only">Booking status: </span>
              {pill.text}
            </StatusBadge>
            {view.accountsReview && v && v.status !== 'draft' ? (
              <StatusBadge tone={view.accountsReview.status === 'approved' ? 'success' : view.accountsReview.status === 'returned' ? 'danger' : 'info'} wrap>
                <span className="sr-only">Accounts review: </span>
                {REVIEW_STATUS_LABEL[view.accountsReview.status]}
              </StatusBadge>
            ) : null}
            <StagePill stage={view.stage} />
            <OwnerLine ownerText={ownerText} />
          </>
        }
      />
      <Card className="mb-5">
        <CardBody className="flex flex-col gap-3">
          <p className="m-0 text-copy" data-slot="book-next">
            <span className="font-semibold text-ink">Next:</span> {next.text}
            {next.actor ? <span className="text-quiet"> · {next.actor}</span> : null}
          </p>
          {v?.status === 'draft' && v.savedAt ? (
            <p className="m-0 text-sm text-quiet">
              Last saved {dateText(v.savedAt)}
              {v.savedByName ? ` by ${v.savedByName}` : ''}. Nothing has been booked or paid.
            </p>
          ) : null}
          {view.dealNotActive ? (
            // DA-29a: with a booking it stays readable; without one, none can be started (no returned-booking sentence, §14 #10).
            <Notice tone="warning">
              {v ? 'This deal is lost or rejected in Bitrix. You can read the booking; you cannot change it.' : 'This deal is lost or rejected in Bitrix, so a booking cannot be started.'}
            </Notice>
          ) : null}
          {!view.canEdit && v?.status === 'draft' ? (
            <p className="m-0 flex gap-2 text-sm text-quiet">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <span>You can read this booking draft. The deal owner, assigned Sales or the branch Manager can change it.</span>
            </p>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

/** The stepped form frame: step list beside one step card (whose form is passed as children). */
export function BookNowFrame({
  view,
  step,
  hrefs,
  ownerText,
  dealHref,
  children,
}: {
  view: BookNowView;
  step: BookStep;
  hrefs: Record<BookStep, string>;
  ownerText?: string | null;
  dealHref: string;
  children: ReactNode;
}) {
  return (
    <div className="font-sans text-base text-copy">
      <BookNowHeader view={view} ownerText={ownerText} dealHref={dealHref} />
      <div className="grid items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <StepNav label="Booking form steps" steps={stepItems(view, step, hrefs)} />
        <Card className="min-w-0">
          <section aria-labelledby="book-step-heading">
            <CardHeader>
              <p className="m-0 text-sm font-semibold text-quiet">
                Step {BOOK_STEPS.findIndex((s) => s.key === step) + 1} of {BOOK_STEPS.length}
              </p>
              <CardTitle id="book-step-heading" tabIndex={-1} className="outline-none">
                {BOOK_STEP_LABEL[step]}
              </CardTitle>
            </CardHeader>
            <CardBody>
              <SavedAnnouncer headingId="book-step-heading" />
              {children}
            </CardBody>
          </section>
        </Card>
      </div>
    </div>
  );
}

/** No version yet: what Book now does, and the Book now button (passed in). */
export function BookNowLanding({ view, ownerText, dealHref, startForm }: { view: BookNowView; ownerText?: string | null; dealHref: string; startForm: ReactNode | null }) {
  return (
    <div className="font-sans text-base text-copy">
      <BookNowHeader view={view} ownerText={ownerText} dealHref={dealHref} />
      <Card>
        <section aria-labelledby="book-start-heading">
          <CardHeader>
            <CardTitle id="book-start-heading">Start booking</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <p className="m-0">
              Three steps: Customer &amp; passengers · Trip &amp; services · Price &amp; Bill To. Each section saves when you press Save.
            </p>
            <Notice tone="info">
              <p>Nothing is booked or paid when you start.</p>
              {view.stage && !view.stage.isTriggerStage ? <p>{BOOK_NOW_TEXT.submitWaitsForWon}</p> : null}
            </Notice>
            {view.dealNotActive ? (
              <Notice tone="warning">This deal is lost or rejected in Bitrix, so a booking cannot be started.</Notice>
            ) : startForm ? (
              startForm
            ) : (
              <p className="m-0 text-quiet">Sales on this deal or the branch Manager starts the booking.</p>
            )}
          </CardBody>
        </section>
      </Card>
    </div>
  );
}

/** The accepted version, read only: services and tasks, customer, money and versions. */
export function SubmittedBookingView({
  view,
  ownerText,
  dealHref,
  fixForm,
  claimsPanel,
  notice,
  idProofs,
}: {
  view: BookNowView;
  ownerText?: string | null;
  dealHref: string;
  /** "Fix and send again" when Accounts returned it and the viewer may revise. */
  fixForm?: ReactNode;
  /** Reported payments (client panel) for viewers who may report. */
  claimsPanel?: ReactNode;
  /** One-off message, e.g. "Already submitted. Nothing was created twice." */
  notice?: ReactNode;
  /** B1.2: each traveller's ID proof (attach and remove stay allowed after submission). */
  idProofs?: ReactNode;
}) {
  const items = [...view.items].sort((a, b) => a.itemNo - b.itemNo);
  const review = view.accountsReview;
  return (
    <div className="font-sans text-base text-copy">
      <BookNowHeader view={view} ownerText={ownerText} dealHref={dealHref} />
      <div className="flex flex-col gap-5">
        {notice}
        {review?.status === 'returned' ? (
          <Card>
            <section aria-labelledby="book-returned-heading">
              <CardHeader>
                <CardTitle id="book-returned-heading">Accounts returned this booking</CardTitle>
                <StatusBadge tone="danger" icon={TriangleAlert}>
                  Returned
                </StatusBadge>
              </CardHeader>
              <CardBody className="flex flex-col gap-3">
                {review.reason ? (
                  <blockquote className="m-0 rounded-control border-l-4 border-status-danger-line bg-status-danger-tint px-3.5 py-2.5 text-copy">
                    <span className="sr-only">Accounts wrote: </span>
                    {review.reason}
                  </blockquote>
                ) : (
                  <p className="m-0 text-quiet">{review.reasonHidden ? 'Accounts gave a reason that is kept with Accounts. Ask Accounts what to change.' : 'Accounts did not give a reason here. Ask Accounts what to change.'}</p>
                )}
                <p className="m-0">Makes a new version. Departments keep their tasks.</p>
                {fixForm ?? <p className="m-0 text-quiet">Sales on this deal or the branch Manager can fix it.</p>}
              </CardBody>
            </section>
          </Card>
        ) : null}

        <Notice tone="locked">{BOOK_NOW_TEXT.lockedNote}</Notice>
        <QuotationSourceNote source={view.quotationSource} />

        <Card>
          <section aria-labelledby="book-services-heading">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle id="book-services-heading">Services and tasks</CardTitle>
                <CardDescription>Booked only when the supplier or authority confirms.</CardDescription>
              </div>
              <ProgressPill progress={view.progress} />
            </CardHeader>
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {items.map((item) => (
                <li key={item.itemId} className="m-0 flex flex-col gap-2 px-4.5 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2 font-semibold text-ink">
                      <span className="text-sm font-medium text-quiet tabular-nums">Service {item.itemNo}</span>
                      <ServiceTypePill type={item.serviceType} />
                      <span className="wrap-anywhere">{itemSummary(item)}</span>
                    </p>
                    {item.waitingForLaunch ? (
                      <StatusBadge tone="warning" icon={Hourglass} wrap>
                        Waiting for the Visa &amp; Passport desk launch · still outstanding
                      </StatusBadge>
                    ) : (
                      <ServiceStatePill item={item} wrap />
                    )}
                  </div>
                  <p className="m-0 text-sm text-quiet">
                    {B11_DEPARTMENT_LABEL[item.department]} · {item.waitingForLaunch ? 'no task yet' : serviceOwnerText(item)}
                    {view.commercials && item.purchaseBudgetPaise ? ` · budget ${inr(item.purchaseBudgetPaise)}` : ''}
                    {' · '}
                    {SERVICE_NEXT_STEP_TEXT[item.nextStep] ?? ''}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </Card>

        {idProofs ? (
          <Card>
            <section aria-labelledby="book-id-proofs-heading">
              <CardHeader>
                <CardTitle id="book-id-proofs-heading">Traveller ID proofs</CardTitle>
                <CardDescription>Required for every adult. Files can still be attached or replaced after submission; every view is recorded.</CardDescription>
              </CardHeader>
              <CardBody className="flex flex-col gap-3">{idProofs}</CardBody>
            </section>
          </Card>
        ) : null}

        <div className="grid items-start gap-5 xl:grid-cols-2">
          <Card>
            <section aria-labelledby="book-customer-heading">
              <CardHeader>
                <CardTitle id="book-customer-heading">Customer and travellers</CardTitle>
              </CardHeader>
              <CardBody>
                <SummaryList>
                  <SummaryRow label="Booking contact">{view.contacts ? `${view.contacts.contactName} · ${[view.contacts.mobile, view.contacts.email].filter(Boolean).join(' · ')}` : <NotEntered />}</SummaryRow>
                  <SummaryRow label="Billing">
                    {view.billing.billingName ? `${view.billing.billingName}, ${view.billing.city ?? ''}` : <NotEntered />}
                    <span className="block text-sm text-quiet">{view.billing.status === 'verified' ? 'Checked by Accounts' : 'Not checked by Accounts yet'}</span>
                  </SummaryRow>
                  <SummaryRow label="Trip">
                    {view.trip.destination ?? <NotEntered />} {view.trip.start ? `· ${dateText(view.trip.start)} to ${dateText(view.trip.end)}` : ''}
                  </SummaryRow>
                  <SummaryRow label="Travellers">
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {view.travellers.map((t) => (
                        <li key={t.seq}>
                          {t.fullName} <span className="text-sm text-quiet">({t.type}{t.ageYears !== null ? `, ${t.ageYears}` : ''})</span>
                        </li>
                      ))}
                    </ul>
                  </SummaryRow>
                </SummaryList>
              </CardBody>
            </section>
          </Card>
          {view.commercials ? (
            <Card>
              <section aria-labelledby="book-money-heading">
                <CardHeader>
                  <CardTitle id="book-money-heading">Money</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                  <SummaryList>
                    <SummaryRow label="Final selling total" numeric>
                      {inr(view.commercials.sellingTotalPaise) ?? <NotEntered />}
                    </SummaryRow>
                    <SummaryRow label="Payment plan">
                      {view.plan && view.plan.length > 0 ? (
                        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                          {view.plan.map((p) => (
                            <li key={p.seq}>
                              {p.label}: {inr(p.amountPaise)} due {dateText(p.dueDate)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <NotEntered />
                      )}
                    </SummaryRow>
                  </SummaryList>
                  {view.claims ? <ClaimsSummary claims={view.claims} /> : null}
                  {view.claims && view.claims.claims.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Reported payments">
                      {view.claims.claims.map((c) => (
                        <li key={c.claimId} className="m-0 flex flex-wrap items-center justify-between gap-2">
                          <span className="tabular-nums">{inr(c.amountPaise)} · {dateText(c.paidOn)}</span>
                          <ClaimStatusPill status={c.displayStatus} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </CardBody>
              </section>
            </Card>
          ) : null}
        </div>

        {claimsPanel ? (
          <Card>
            <CardBody>{claimsPanel}</CardBody>
          </Card>
        ) : null}

        {view.history && view.history.length > 0 ? (
          <Card>
            <section aria-labelledby="book-versions-heading">
              <CardHeader>
                <CardTitle id="book-versions-heading">Versions</CardTitle>
              </CardHeader>
              <CardBody>
                <Timeline
                  label="Booking versions, oldest first"
                  items={view.history.map((h) => ({
                    id: h.versionId,
                    title: `Version ${h.versionNo} · ${h.status === 'superseded' ? 'replaced by a fixed version' : h.status === 'confirmed' ? 'accepted' : h.status}`,
                    meta: [h.confirmedAt ? `Submitted ${dateText(h.confirmedAt)}` : null, h.reviewStatus ? REVIEW_STATUS_LABEL[h.reviewStatus] : null].filter(Boolean).join(' · '),
                    detail:
                      h.changedFields.length > 0 || h.sellingTotalDeltaPaise ? (
                        <>
                          {h.changedFields.length > 0 ? `Changed: ${[...new Set(h.changedFields.map((f) => CHANGED_FIELD_GROUP_LABEL[f.split('.')[0]!] ?? f))].join(', ')}` : ''}
                          {h.sellingTotalDeltaPaise && h.sellingTotalDeltaPaise !== '0' ? ` · price difference ${inr(h.sellingTotalDeltaPaise.replace('-', ''))}${h.sellingTotalDeltaPaise.startsWith('-') ? ' less' : ' more'}` : ''}
                        </>
                      ) : undefined,
                    state: h.status === 'confirmed' ? 'current' : 'done',
                  }))}
                />
              </CardBody>
            </section>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/** Same answer for "does not exist", "not yours" and "not for your role", so IDs cannot be probed. */
export function BookNowNotAvailableView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Booking not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">{BOOK_NOW_TEXT.notAvailable}</p>
        </div>
      </Card>
      <p className="m-0 mt-4">
        <Link href="/app/deals" className={buttonVariants({ variant: 'secondary' })}>
          <ChevronLeft aria-hidden="true" />
          Back to deals
        </Link>
      </p>
    </div>
  );
}

/** The booking read failed (not "no booking"): say so and offer a retry. */
export function BookNowUnavailableView({ dealHref }: { dealHref: string }) {
  return (
    <div className="font-sans text-base text-copy">
      <BackToDeal href={dealHref} />
      <PageHeader title="Booking did not load" />
      <Notice tone="danger" role="alert">
        <p>The booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
      </Notice>
    </div>
  );
}

export function BookNowLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Book now</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading the booking…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-96 max-w-full" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-6 w-40 rounded-full" />
          <Skeleton className="h-6 w-48 rounded-full" />
        </div>
        <div className="grid items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-control" />
            ))}
          </div>
          <div className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10 w-full rounded-control" />
            <Skeleton className="h-10 w-full rounded-control" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deal page card
// ---------------------------------------------------------------------------

export type DealBookNowState =
  | { kind: 'not_started'; canStart: boolean; waitsForWon: boolean }
  | { kind: 'draft'; savedAt: string | null; savedByName: string | null; needCount: number; revision: boolean }
  | { kind: 'submitted'; reviewStatus: 'pending' | 'returned' | 'approved' | null }
  | { kind: 'lost'; hasBooking: boolean };

/** The "Book now" card at the top of the Deal page's work column. */
export function DealBookNowCard({
  state,
  bookHref,
  startForm,
  actionVariant,
}: {
  state: DealBookNowState;
  bookHref: string;
  startForm?: ReactNode;
  /** Batch 1: 'secondary' on the Deal workspace, where the header holds the page's one primary action (copy §16.3). */
  actionVariant?: 'secondary';
}) {
  let body: ReactNode;
  if (state.kind === 'not_started') {
    body = (
      <>
        <p className="m-0">Starts the booking form. Nothing is booked or paid.</p>
        {state.waitsForWon ? <p className="m-0 text-sm text-quiet">{BOOK_NOW_TEXT.submitWaitsForWon}</p> : null}
        {state.canStart && startForm ? startForm : <p className="m-0 text-quiet">Sales on this deal or the branch Manager starts the booking.</p>}
      </>
    );
  } else if (state.kind === 'draft') {
    body = (
      <>
        <p className="m-0">
          {[
            state.revision ? 'Fix in progress' : 'Booking draft',
            state.needCount > 0 ? `${state.needCount} ${state.needCount === 1 ? 'thing' : 'things'} to finish` : 'ready to submit',
            state.savedAt ? `saved ${dateText(state.savedAt)}${state.savedByName ? ` by ${state.savedByName}` : ''}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div>
          <Link href={bookHref} className={buttonVariants({ variant: actionVariant ?? 'primary', size: 'lg' })}>
            {state.revision ? 'Continue the fix' : 'Continue booking'}
          </Link>
        </div>
      </>
    );
  } else if (state.kind === 'submitted') {
    body = (
      <>
        <p className="m-0">{state.reviewStatus === 'returned' ? 'Returned by Accounts' : state.reviewStatus === 'approved' ? 'Approved by Accounts' : 'Waiting for Accounts'}</p>
        <div>
          <Link href={bookHref} className={buttonVariants({ variant: actionVariant ?? (state.reviewStatus === 'returned' ? 'primary' : 'secondary'), size: 'lg' })}>
            {state.reviewStatus === 'returned' ? 'Fix and send again' : 'View booking'}
          </Link>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Notice tone="warning">{state.hasBooking ? 'This deal is lost or rejected in Bitrix. You can read the booking; you cannot change it.' : 'This deal is lost or rejected in Bitrix, so a booking cannot be started.'}</Notice>
        {state.hasBooking ? (
          <div>
            <Link href={bookHref} className={buttonVariants({ variant: 'secondary' })}>
              View the booking
            </Link>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <Card>
      <section aria-labelledby="deal-booknow-heading">
        <CardHeader>
          <CardTitle id="deal-booknow-heading">Booking</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">{body}</CardBody>
      </section>
    </Card>
  );
}

/** A B1.1 page whose database functions are not installed yet: honest words, never an empty list. */
export function B11NotInstalledView({ title, text }: { title: string; text: string }) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Accounts" title={title} />
      <Notice tone="locked">{text}</Notice>
    </div>
  );
}

/** Preview gallery only: the Deal page's Book now card under the Deal title. */
export function DealBookNowCardPreview({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 font-sans">
      <h1 className="m-0 text-2xl font-display text-ink">{title}</h1>
      {children}
    </div>
  );
}

/** The Deal page's booking read failed: say so; never fall back to the legacy hotel panel. */
export function DealBookingUnavailable() {
  return (
    <Card>
      <section aria-labelledby="deal-booknow-heading">
        <CardHeader>
          <CardTitle id="deal-booknow-heading">Booking</CardTitle>
        </CardHeader>
        <CardBody>
          <Notice tone="danger" role="alert">
            The booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.
          </Notice>
        </CardBody>
      </section>
    </Card>
  );
}
