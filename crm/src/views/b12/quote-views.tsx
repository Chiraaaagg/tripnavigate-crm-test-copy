import { CalendarClock, ChevronDown, ChevronLeft, CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, FileText, Hourglass, Link2, PenLine, Send, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { InternalZone } from './internal-zone';
import type { QuoteCopyLinks, QuoteHeaderVM, QuoteStatusWord } from '@/modules/quotations/editor-contract';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { DECLINE_REASON_LABEL, QUOTATION_ERROR_TEXT, QUOTATION_TEXT, SENT_CHANNEL_LABEL } from '@/modules/quotations/contracts';
import { linesForTier, planForTier } from '@/modules/quotations/money';
import { quotationSubjectLink, SUBJECT_NOUN } from '@/modules/quotations/subject-links';
import { B11_SERVICE_LABEL, dateText } from '../b11/book-fields';
import { itemSummary } from '../b11/service-fields';
import { dueText, inr0, latestVersion, lineFormula, mismatchText, nightsText, paxText, perPersonText, QUOTE_STATE_LABEL, QUOTE_STATE_TONE, QUOTE_TEXT, TIER_LABEL, validityText } from './quote-fields';
import { bookingHref, dealHref, linkStateOf, quotationHref, type QuoteInstalmentView, type QuoteLineView, type QuoteListView, type QuoteScreenData, type QuoteState, type QuoteTierMoney, type QuoteVersionView } from './quote-shapes';

/*
 * Quotation screens (B1.2 Phase E), server-safe; the forms inside are client
 * components passed in by the route or the preview gallery. Lagoon look, one
 * h1 (the quotation title), status, owner and next step at the top, one
 * primary action per screen. Money only when the view carries it (commercial
 * editors); cost and margin are internal; never a GST amount (DEC-34).
 */

export function QuoteStatePill({ state }: { state: QuoteState }) {
  return (
    <StatusBadge tone={QUOTE_STATE_TONE[state]} wrap>
      <span className="sr-only">Quotation status: </span>
      {QUOTE_STATE_LABEL[state]}
    </StatusBadge>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <p className="m-0 mb-3">
      <Link href={href} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        {label}
      </Link>
    </p>
  );
}

const textLink = cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing);

// ---------------------------------------------------------------------------
// Lead and Deal pages: the "Quotations" card with "Create quotation"
// ---------------------------------------------------------------------------

export function QuotationsCard({ list, createForm, blockedReason, hrefOf = quotationHref }: { list: QuoteListView; createForm?: ReactNode; /** Plain words when no quotation can be created here (lost Deal…). */ blockedReason?: string | null; hrefOf?: (versionId: string) => string }) {
  return (
    <Card>
      <section aria-labelledby="quotations-heading">
        <CardHeader>
          <CardTitle id="quotations-heading">Quotations</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {list.quotations.length === 0 ? <p className="m-0 text-copy">No quotations yet.</p> : null}
          {list.quotations.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Quotations of this record">
              {list.quotations.map((q) => {
                const latest = latestVersion(q.versions);
                return (
                  <li key={q.quotationId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-brand-strong" />
                    <span className="min-w-40 flex-1">
                      <Link href={hrefOf(q.currentVersionId)} className={cn(textLink, 'font-semibold')}>
                        {q.reference} · {q.title}
                      </Link>
                      {latest ? (
                        <span className="block text-sm text-quiet">
                          Version {latest.versionNo} · {validityText(latest)}
                          {latest.acceptedTierKey ? ` · ${TIER_LABEL[latest.acceptedTierKey]} accepted` : ''}
                          {q.converted ? ' · booking started' : ''}
                        </span>
                      ) : null}
                    </span>
                    {latest ? <QuoteStatePill state={latest.status} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {list.canCreate && !blockedReason ? (
            <div className="flex flex-wrap items-center gap-3">{createForm}</div>
          ) : blockedReason ? (
            <p className="m-0 flex gap-2 text-sm text-quiet">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
              {blockedReason}
            </p>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quotation screen
// ---------------------------------------------------------------------------

export interface QuoteScreenSlots {
  /** The one primary action for the current state (a client form or a link). */
  primary?: ReactNode;
  /** Draft/ready: the editor (sections). */
  editor?: ReactNode;
  /** Sent: acceptance upload + accept, decline. Accepted: link and start booking. */
  acceptance?: ReactNode;
  /** Secondary actions: new version, discard (header "More" menu). */
  secondary?: ReactNode;
  /** Related work below the versions (the branded itineraries card). */
  related?: ReactNode;
  notice?: ReactNode;
}

const STATUS_WORD_LOOK: Array<{ test: (w: QuoteStatusWord) => boolean; tone: StatusTone; icon: LucideIcon }> = [
  { test: (w) => w === 'Not started', tone: 'neutral', icon: CircleDashed },
  { test: (w) => w === 'Draft', tone: 'warning', icon: PenLine },
  { test: (w) => w === 'Ready to share', tone: 'info', icon: CircleCheck },
  { test: (w) => w === 'Shared with customer', tone: 'info', icon: Send },
  { test: (w) => w === 'Accepted' || w === 'Booking started', tone: 'success', icon: CircleCheck },
  { test: (w) => w === 'Declined', tone: 'danger', icon: CircleX },
  { test: (w) => w === 'Expired', tone: 'danger', icon: Clock },
];

/** DA-41 status word with an icon (never colour alone). */
export function QuoteStatusWordPill({ word }: { word: QuoteStatusWord }) {
  const look = STATUS_WORD_LOOK.find((l) => l.test(word)) ?? { tone: 'neutral' as StatusTone, icon: FileText };
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">Quotation status: </span>
      {word}
    </StatusBadge>
  );
}

/** Edit / Customer copy (QU-02, QU-05): two server-rendered links; the copy is the /preview page (documents adapter), never a client tab. */
export function QuoteCopySwitch({ links }: { links: QuoteCopyLinks }) {
  const item = (href: string, label: string, current: boolean) => (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'inline-flex min-h-11 items-center rounded-control px-3.5 font-medium no-underline',
        current ? 'bg-card text-ink shadow-card' : 'text-copy hover:text-ink',
        focusRing,
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Edit or customer copy" className="flex flex-wrap items-center gap-3">
      <div className="inline-flex gap-1 rounded-card border border-line bg-wash p-1">
        {item(links.edit, 'Edit', links.current === 'edit')}
        {item(links.customerCopy, 'Customer copy', links.current === 'customer_copy')}
      </div>
      <span className="text-sm text-quiet">{links.current === 'customer_copy' ? 'Nothing is sent from here.' : 'The customer copy shows how the quotation will look. Nothing is sent.'}</span>
    </nav>
  );
}

/** Header "More" menu (secondary actions: new version, discard). A native disclosure: works without script; Escape is not needed to leave it. */
function MoreMenu({ children }: { children: ReactNode }) {
  return (
    <details className="group relative">
      <summary className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'min-h-11 list-none [&::-webkit-details-marker]:hidden')}>
        More
        <ChevronDown aria-hidden="true" className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="z-20 mt-1.5 flex min-w-64 flex-col gap-3 rounded-card border border-line bg-card p-3 shadow-overlay sm:absolute sm:right-0 sm:top-full sm:mt-1.5">{children}</div>
    </details>
  );
}

export function QuotationScreen({ data, slots = {}, previewHref, header, copyLinks }: { data: QuoteScreenData; slots?: QuoteScreenSlots; previewHref: string; header: QuoteHeaderVM; copyLinks: QuoteCopyLinks }) {
  const v = data.version;
  const link = linkStateOf(data);
  const back = quotationSubjectLink(v.subject);
  const editing = v.status === 'draft' || v.status === 'ready';
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href={back.href} label={back.label} />
      <PageHeader
        eyebrow={
          <span className="wrap-anywhere">
            Quotation {v.reference} · v{v.versionNo} · {SUBJECT_NOUN[v.subject.kind]} {v.subject.reference}
          </span>
        }
        title={
          <span id="quote-heading" tabIndex={-1} className="block wrap-anywhere outline-none">
            {v.title}
          </span>
        }
        status={
          <>
            <QuoteStatusWordPill word={header.statusWord} />
            {v.linkedDealId ? (
              <StatusBadge tone="success" icon={Link2} wrap>
                Linked to deal {data.linkedDeal?.reference ?? ''}
              </StatusBadge>
            ) : link === 'waiting' ? (
              <StatusBadge tone="warning" icon={Hourglass} wrap>
                Waiting for the Bitrix deal
              </StatusBadge>
            ) : null}
            <span className="inline-flex items-center gap-1.5 text-copy">
              <CalendarClock aria-hidden="true" className="size-4 text-faint" />
              {header.validityText}
            </span>
            {data.ownerName ? (
              <span className="inline-flex items-center gap-1.5 text-copy">
                <UserRound aria-hidden="true" className="size-4 text-faint" />
                Owner: <span className="font-semibold text-ink">{data.ownerName}</span>
              </span>
            ) : null}
            <p className="m-0 basis-full text-base text-copy">{header.nextLine}</p>
          </>
        }
        actions={
          slots.primary || slots.secondary ? (
            <>
              {slots.primary}
              {slots.secondary ? <MoreMenu>{slots.secondary}</MoreMenu> : null}
            </>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-5">
        <QuoteCopySwitch links={copyLinks} />
        {slots.notice}
        {slots.editor}
        {slots.acceptance}
        {!editing ? <VersionSummary version={v} previewHref={previewHref} /> : null}
        <VersionsCard data={data} />
        {slots.related}
      </div>
    </div>
  );
}

/** Read-only summary of a sent, accepted or closed version. */
export function VersionSummary({ version: v, previewHref }: { version: QuoteVersionView; previewHref: string }) {
  return (
    <Card>
      <section aria-labelledby="quote-summary-heading">
        <CardHeader>
          <CardTitle id="quote-summary-heading">What version {v.versionNo} offers</CardTitle>
          <CardDescription>
            A sent version never changes. To change anything, make a new version.{' '}
            <Link href={previewHref} className={textLink}>
              Preview what the customer sees
            </Link>
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <TripSummary v={v} />
          {v.money ? <MoneySummary v={v} /> : <Notice tone="locked">{QUOTE_TEXT.pricesForEditors}</Notice>}
        </CardBody>
      </section>
    </Card>
  );
}

export function TripSummary({ v }: { v: QuoteVersionView }) {
  const accepted = v.accepted ? v.evidence.find((e) => e.kind === 'acceptance_message' && e.status === 'stored') : undefined;
  return (
    <SummaryList>
      <SummaryRow label="Trip">
        {v.trip.destination ? `${v.trip.destination} · ${dateText(v.trip.start) ?? '?'} to ${dateText(v.trip.end) ?? '?'}${nightsText(v.trip.start, v.trip.end) ? ` · ${nightsText(v.trip.start, v.trip.end)}` : ''} · ${v.trip.scope === 'international' ? 'International' : 'Domestic'}` : <NotEntered />}
      </SummaryRow>
      <SummaryRow label="Travellers">{paxText(v.pax)}</SummaryRow>
      <SummaryRow label="Services">
        {v.items.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {[...v.items]
              .sort((a, b) => a.itemNo - b.itemNo)
              .map((i) => (
                <li key={i.itemNo}>
                  Service {i.itemNo}: {B11_SERVICE_LABEL[i.serviceType]} · {itemSummary({ serviceType: i.serviceType, facts: i.service, title: i.title }) || i.title}
                  {i.tierKey ? ` · ${TIER_LABEL[i.tierKey]} only` : ''}
                </li>
              ))}
          </ul>
        ) : (
          <NotEntered />
        )}
      </SummaryRow>
      <SummaryRow label="Validity">{validityText(v)}</SummaryRow>
      {v.sent ? <SummaryRow label="Sent">{`${dateText(v.sent.at)}${v.sent.channel ? ` by ${SENT_CHANNEL_LABEL[v.sent.channel]}` : ''}`}</SummaryRow> : null}
      {v.accepted ? <SummaryRow label="Accepted">{`${dateText(v.accepted.at)} · ${TIER_LABEL[v.accepted.tierKey]}${accepted ? ` · written acceptance ${accepted.fileName}` : ''}`}</SummaryRow> : null}
      {v.declined ? <SummaryRow label="Declined">{`${dateText(v.declined.at)}${v.declined.reason ? ` · ${DECLINE_REASON_LABEL[v.declined.reason]}` : ''}`}</SummaryRow> : null}
    </SummaryList>
  );
}

/** Per option: line prices, typed total, mismatch warning; cost and margin internal. */
export function MoneySummary({ v }: { v: QuoteVersionView }) {
  const m = v.money!;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {m.tiers.map((t) => (
        <TierMoney key={t.tierKey} tier={t} label={t.label} lines={linesForTier(m.lines, t.tierKey)} plan={planForTier(m.plan, t.tierKey)} />
      ))}
    </div>
  );
}

function TierMoney({ tier, label, lines, plan }: { tier: QuoteTierMoney; label: string | null; lines: QuoteLineView[]; plan: QuoteInstalmentView[] }) {
  const warning = mismatchText(tier);
  return (
    <section aria-labelledby={`quote-tier-${tier.tierKey}-heading`} className="flex flex-col gap-3 rounded-card border border-line bg-canvas px-4 py-4">
      <h3 id={`quote-tier-${tier.tierKey}-heading`} className="m-0 text-base font-semibold text-ink">
        {TIER_LABEL[tier.tierKey]}
        {label ? <span className="font-normal text-quiet"> · {label}</span> : null}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" aria-label={`${TIER_LABEL[tier.tierKey]}: price lines`}>
        {lines.map((l) => (
          <li key={l.lineNo} className="m-0">
            <span className="font-medium text-ink">{l.description}</span>
            <span className="block text-quiet">{lineFormula(l)}</span>
          </li>
        ))}
      </ul>
      <SummaryList>
        <SummaryRow label="Lines add up to (for comparison)" numeric>
          {inr0(tier.componentSellPaise)}
        </SummaryRow>
        <SummaryRow label="Quoted total" numeric total>
          {tier.quotedTotalPaise ? inr0(tier.quotedTotalPaise) : <NotEntered />}
        </SummaryRow>
        <SummaryRow label="GST">GST as applicable (no amount)</SummaryRow>
      </SummaryList>
      <InternalZone id={`quote-tier-${tier.tierKey}-internal`}>
        <SummaryList>
          <SummaryRow label="Our cost (internal)" numeric>
            {tier.costTotalPaise ? inr0(tier.costTotalPaise) : 'Some costs not entered'}
          </SummaryRow>
          {tier.marginPaise ? (
            <SummaryRow label="Estimated margin (internal)" numeric>
              {inr0(tier.marginPaise)}
            </SummaryRow>
          ) : null}
        </SummaryList>
        {lines.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm text-copy" aria-label={`${TIER_LABEL[tier.tierKey]}: our cost per line (internal)`}>
            {lines.map((l) => (
              <li key={l.lineNo} className="m-0">
                {l.description}: our cost {l.lineCostPaise === null ? 'not entered' : inr0(l.lineCostPaise)}
              </li>
            ))}
          </ul>
        ) : null}
      </InternalZone>
      {perPersonText(tier) ? <p className="m-0 text-sm text-quiet">Printed as: {perPersonText(tier)}</p> : null}
      {warning ? (
        <p className="m-0 flex gap-2 text-sm text-copy" role="note">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <span>
            <span className="sr-only">Check: </span>
            {warning}
          </span>
        </p>
      ) : null}
      {plan.length > 0 ? (
        <div className="text-sm">
          <p className="m-0 font-semibold text-ink">Payment schedule if the customer confirms</p>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
            {plan.map((p) => (
              <li key={p.seq}>
                {p.label}: {inr0(p.amountPaise)} · {dueText(p)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function VersionsCard({ data }: { data: Pick<QuoteScreenData, 'version' | 'versions'> }) {
  return (
    <Card>
      <section aria-labelledby="quote-versions-heading">
        <CardHeader>
          <CardTitle id="quote-versions-heading">Versions</CardTitle>
          <CardDescription>Each version is valid until its date (7 days after it was made unless changed before sharing). Sharing a version replaces the version shared before it.</CardDescription>
        </CardHeader>
        <CardBody>
          <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Versions of this quotation">
            {[...data.versions]
              .sort((a, b) => b.versionNo - a.versionNo)
              .map((ver) => (
                <li key={ver.versionId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
                  <span className="min-w-40 flex-1">
                    {ver.versionId === data.version.versionId ? (
                      <span className="font-semibold text-ink">
                        Version {ver.versionNo} <span className="text-sm font-normal text-quiet">· shown on this page</span>
                      </span>
                    ) : (
                      <Link href={quotationHref(ver.versionId)} className={cn(textLink, 'font-semibold')}>
                        Version {ver.versionNo}
                      </Link>
                    )}
                    <span className="block text-sm text-quiet">
                      {ver.sentAt ? `Sent ${dateText(ver.sentAt)} · ` : ''}
                      {validityText(ver)}
                      {ver.acceptedTierKey ? ` · ${TIER_LABEL[ver.acceptedTierKey]} accepted` : ''}
                    </span>
                  </span>
                  <QuoteStatePill state={ver.status} />
                </li>
              ))}
          </ol>
        </CardBody>
      </section>
    </Card>
  );
}

/** Accepted Lead quotation: waiting for the Bitrix Deal, the arrived Deal (link form passed in), or linked. */
export function LinkStateNotice({ data, linkForm }: { data: Pick<QuoteScreenData, 'version' | 'candidates' | 'linkedDeal'>; linkForm?: ReactNode }) {
  const state = linkStateOf(data);
  const v = data.version;
  if (state === 'not_needed') return null;
  if (state === 'waiting') {
    return (
      <Notice tone="info" title="Waiting for the Bitrix deal">
        <p>{v.nextStepText ?? QUOTATION_TEXT.waitingForDeal}</p>
        {/* Copy Q-10: one short line; the rest behind "Why?". */}
        <p>The CRM does not change Bitrix.</p>
        <details>
          <summary className="cursor-pointer font-medium text-brand-strong">Why?</summary>
          <p className="mt-1.5">The CRM never converts a lead or changes a Bitrix stage. When Bitrix sends the deal made from this lead, it appears here to link.</p>
        </details>
      </Notice>
    );
  }
  if (state === 'linked' && v.linkedDealId) {
    return (
      <p className="m-0 flex gap-2 text-copy">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />
        <span>
          Linked to deal{' '}
          <Link href={dealHref(v.linkedDealId)} className={textLink}>
            {data.linkedDeal ? `${data.linkedDeal.reference} · ${data.linkedDeal.title}` : 'open it'}
          </Link>
          .
        </span>
      </p>
    );
  }
  return <div className="flex flex-col gap-3">{linkForm}</div>;
}

export function QuoteNotAvailableView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Quotation" />
      <Notice tone="locked">{QUOTATION_ERROR_TEXT.not_found}</Notice>
    </div>
  );
}

export function QuoteNotInstalledView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Quotation" />
      <Notice tone="info">{QUOTATION_TEXT.notInstalled}</Notice>
    </div>
  );
}

export function QuoteUnavailableView({ backHref }: { backHref: string }) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Quotation" />
      <Notice tone="danger" role="alert">
        The quotation did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.{' '}
        <Link href={backHref} className={textLink}>
          Back
        </Link>
      </Notice>
    </div>
  );
}

/** Start booking / continue the booking (accepted versions). */
export function bookingLinkFor(v: QuoteVersionView): string | null {
  return v.conversion ? bookingHref(v.conversion.dealId) : null;
}

export function QuoteLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-h-11')}>
      {children}
    </Link>
  );
}
