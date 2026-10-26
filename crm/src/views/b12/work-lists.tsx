import { Archive, ChevronLeft, ChevronRight, CircleCheck, CircleDot, FileCheck2, PenLine, Clock, Download, FileText, Info, Map as MapIcon, Plus, RefreshCw, Search, TriangleAlert, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterChips } from '@/components/ui/filter-chips';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type {
  ItineraryListPageVM,
  QuotationListPageVM,
  ReferralDraftStateVM,
  WorkItineraryRowVM,
  WorkListKind,
  WorkListPageVM,
  WorkListPagerVM,
  WorkListScopeVM,
  WorkQuotationRowVM,
  WorkSubjectVM,
} from '@/modules/quotations/work-contract';
import { ListSearch } from '../list-search';
import { QuoteStatusWordPill } from './quote-views';

/*
 * Quotations and Itineraries lists (Direction A QL / IL, Batch 3; FP-040,
 * FP-051). Server components over Terra's view models (work-contract.ts):
 * header with the scope named and ONE primary ("New quotation" / "New
 * itinerary"), a Mine / All you can open switch, filter chips with exact
 * counts for the chosen scope, "Search this page", open by exact reference
 * (finds closed never-linked drafts for their owner and the branch Manager),
 * a compact table and a keyset pager (First page / Next page, no page
 * numbers). Rows carry no money (lead ruling). Patterns: originui dense
 * Table 89 and the Batch 1 chips and search (register §10, §12); the pager
 * keeps the ListPager look with keyset links (21st.dev "cursor pagination"
 * returned numbered pagers only, not adopted).
 */

const textLink = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

const KIND_WORDS: Record<WorkListKind, { title: string; noun: 'quotations' | 'itineraries'; single: string; newLabel: string; icon: LucideIcon }> = {
  quotations: { title: 'Quotations', noun: 'quotations', single: 'quotation', newLabel: 'New quotation', icon: FileText },
  itineraries: { title: 'Itineraries', noun: 'itineraries', single: 'itinerary', newLabel: 'New itinerary', icon: MapIcon },
};

// ---------------------------------------------------------------------------
// Shared parts (also used on the referral draft page)
// ---------------------------------------------------------------------------

const DRAFT_STATE_LOOK: Record<'open' | 'closed' | 'closed_auto', { tone: StatusTone; icon: LucideIcon }> = {
  open: { tone: 'info', icon: CircleDot },
  closed: { tone: 'neutral', icon: Archive },
  closed_auto: { tone: 'neutral', icon: Clock },
};

/** Referral draft status word with an icon (DA-42, DA-74); never colour alone. */
export function DraftStateBadge({ state }: { state: Pick<ReferralDraftStateVM, 'status' | 'closedReason' | 'statusText'> }) {
  const look = DRAFT_STATE_LOOK[state.status === 'open' ? 'open' : state.closedReason === 'no_activity' ? 'closed_auto' : 'closed'];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">Referral draft status: </span>
      {state.statusText}
    </StatusBadge>
  );
}

/** "Lead L-55" / "Deal D-5103" / "Referral draft TD-301 · not linked to Bitrix yet": a link only when the viewer can open it. */
export function WorkSubject({ subject }: { subject: WorkSubjectVM }) {
  return subject.href ? (
    <Link href={subject.href} className={cn(textLink, 'font-medium wrap-anywhere')}>
      {subject.text}
    </Link>
  ) : (
    <span className="wrap-anywhere text-copy">{subject.text}</span>
  );
}

/** Keyset pager: "First page" (when not on it), the range in words, "Next page" (while more rows exist). No page numbers. */
export function WorkListPager({ pager, label, className }: { pager: WorkListPagerVM; label: string; className?: string }) {
  const button = cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'max-sm:h-11 max-sm:px-3.5');
  return (
    <nav aria-label={label} className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-line px-4.5 py-3 font-sans', className)} data-slot="work-pager">
      {pager.firstHref ? (
        <Link href={pager.firstHref} className={button}>
          <ChevronLeft aria-hidden="true" />
          First page
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="text-sm text-quiet tabular-nums">{pager.rangeText}</span>
      {pager.nextHref ? (
        <Link href={pager.nextHref} rel="next" className={button}>
          Next page
          <ChevronRight aria-hidden="true" />
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}

/** Mine / All you can open: two links, so each scope is a real address (counts are exact for the chosen scope). */
function ScopeSwitch({ scope, kind }: { scope: WorkListScopeVM; kind: WorkListKind }) {
  const options = [
    { value: 'mine', label: 'Mine', href: scope.mineHref },
    { value: 'all', label: 'All you can open', href: scope.allHref },
  ] as const;
  return (
    <div role="group" aria-label={`Which ${KIND_WORDS[kind].noun} to show`} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-quiet">Show:</span>
      <span className="inline-flex flex-wrap gap-0.5 rounded-control border border-line bg-wash p-0.5">
        {options.map((option) =>
          option.value === scope.current ? (
            <strong key={option.value} aria-current="true" className="inline-flex min-h-9 items-center rounded-chip bg-card px-2.5 py-1 text-sm font-semibold text-ink shadow-button">
              {option.label}
            </strong>
          ) : (
            <Link
              key={option.value}
              href={option.href}
              className={cn('inline-flex min-h-9 items-center rounded-chip px-2.5 py-1 text-sm font-medium text-brand-strong no-underline hover:bg-card hover:text-brand-deep', focusRing)}
            >
              {option.label}
            </Link>
          ),
        )}
      </span>
    </div>
  );
}

/** Open by exact reference (GET form: works without script; same "no match" line for missing and not yours). */
function OpenByReference({ page }: { page: WorkListPageVM<unknown, string> }) {
  const o = page.openByReference;
  const id = `${page.kind}-reference`;
  const missId = `${id}-miss`;
  const hintId = `${id}-hint`;
  return (
    <form method="get" action={o.action} role="search" aria-label="Open by reference" className="flex w-full max-w-sm flex-col gap-1 font-sans">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        Open by reference
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          name="reference"
          defaultValue={o.value}
          // F21: both lists accept a quotation (TQ-n) or a referral draft (TD-n) reference.
          placeholder="TQ-12 or TD-301"
          autoComplete="off"
          spellCheck={false}
          invalid={Boolean(o.missText)}
          aria-describedby={o.missText ? `${hintId} ${missId}` : hintId}
          className="min-w-0 flex-1"
        />
        <button type="submit" className={cn(buttonVariants({ variant: 'secondary' }), 'min-h-10')}>
          <Search aria-hidden="true" />
          Open
        </button>
      </div>
      <p id={hintId} className="m-0 text-xs text-quiet">
        Exact reference. Finds closed drafts too.
      </p>
      {o.missText ? (
        <p id={missId} role="status" className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{o.missText}</span>
        </p>
      ) : null}
    </form>
  );
}

/** Page states other than ok: never shown as an empty list. */
function WorkListStateNotice({ page }: { page: WorkListPageVM<unknown, string> }) {
  const words = KIND_WORDS[page.kind];
  if (page.state === 'not_applicable') {
    return (
      <Card role="status">
        <EmptyState
          icon={words.icon}
          headingLevel={2}
          title={`No ${words.noun} for your role`}
          description={`${words.title} are made by Sales and branch Managers. Your own work is in the menu.`}
        />
      </Card>
    );
  }
  if (page.state === 'not_installed') {
    return (
      <Notice tone="locked" role="status" title={`${words.title} list not installed`}>
        <p>
          This CRM does not have the {words.single} list yet. Open {words.noun} from their {page.kind === 'quotations' ? 'lead or deal' : 'deal or quotation'}.
        </p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" role="status" icon={RefreshCw} title={`${words.title} did not load`}>
      <p>Nothing was changed. Reload the page to try again.</p>
    </Notice>
  );
}

function WorkListEmpty({ page }: { page: WorkListPageVM<unknown, string> }) {
  const words = KIND_WORDS[page.kind];
  const open = page.filters.chips.find((c) => c.filter === 'open');
  const action = page.pager.firstHref ? (
    <Link href={page.pager.firstHref} className={buttonVariants({ variant: 'secondary' })}>
      Back to first page
    </Link>
  ) : open && !open.current ? (
    <Link href={open.href} className={buttonVariants({ variant: 'secondary' })}>
      Show open {words.noun}
    </Link>
  ) : undefined;
  return (
    <Card role="status">
      <EmptyState icon={words.icon} headingLevel={2} title={page.empty.title} description={page.empty.text} action={action} />
    </Card>
  );
}

/** Header, scope switch, chips, search and the reference box: the same frame for both lists. */
function WorkListFrame({ page, table }: { page: WorkListPageVM<unknown, string>; table: (tableId: string) => ReactNode }) {
  const words = KIND_WORDS[page.kind];
  const tableId = `${page.kind}-table`;
  const ok = page.state === 'ok';
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title={words.title}
        description={page.scopeLine}
        actions={
          page.state === 'not_applicable' ? undefined : (
            <Link href={page.newHref} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
              <Plus aria-hidden="true" />
              {words.newLabel}
            </Link>
          )
        }
      />
      {ok ? (
        <div className="mb-4 flex flex-col gap-4">
          <ScopeSwitch scope={page.scope} kind={page.kind} />
          <FilterChips filters={page.filters} label={`Filter ${words.noun}`} />
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            {page.rows.length > 0 ? <ListSearch tableId={tableId} noun={words.noun} /> : <span aria-hidden="true" />}
            <OpenByReference page={page} />
          </div>
          {page.reference ? (
            <Notice tone="info" role="status" icon={Search}>
              <p>
                Showing the result for {page.reference}.{' '}
                {page.filters.chips.find((c) => c.filter === 'open') ? (
                  <Link href={page.filters.chips.find((c) => c.filter === 'open')!.href} className={textLink}>
                    Back to the list
                  </Link>
                ) : null}
              </p>
            </Notice>
          ) : null}
        </div>
      ) : null}
      {!ok ? (
        <WorkListStateNotice page={page} />
      ) : page.rows.length === 0 ? (
        <>
          <WorkListEmpty page={page} />
          {page.pager.firstHref || page.pager.nextHref ? <WorkListPager pager={page.pager} label={`${words.title} pages`} className="mt-3 rounded-card border border-line bg-card" /> : null}
        </>
      ) : (
        <Card>
          {table(tableId)}
          <WorkListPager pager={page.pager} label={`${words.title} pages`} />
        </Card>
      )}
      {ok && page.hiddenClosedLine ? (
        <p className="m-0 mt-3 flex items-start gap-2 text-sm text-copy" data-slot="hidden-closed">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
          <span>{page.hiddenClosedLine}</span>
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function RowAction({ action, rowTitle }: { action: WorkQuotationRowVM['action']; rowTitle: string }) {
  if (!action) return null;
  return (
    <Link href={action.href} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'max-sm:h-11 max-sm:px-3.5')}>
      {action.label}
      <span className="sr-only">: {rowTitle}</span>
    </Link>
  );
}

/** One quotation per row: title link, TQ-n · version · owner, status word, subject, valid until, updated, one action. No money. */
export function WorkQuotationTable({ rows, id, caption }: { rows: WorkQuotationRowVM[]; id: string; caption: string }) {
  return (
    <Table stackOnMobile label="Quotations table" wrapperClassName="rounded-card" id={id}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Quotation</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Lead, deal or referral</TableHead>
          <TableHead>Valid until</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead>
            <span className="sr-only">Next step</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const facts = [r.customerName, r.destination, r.tripStartText].filter(Boolean).join(' · ');
          return (
            <TableRow
              key={r.quotationId}
              className="align-top"
              data-search={`${r.reference} ${r.title} ${r.customerName ?? ''} ${r.subject.text}`.toLowerCase()}
            >
              <TableCell label="Quotation" className="align-top">
                <Link href={r.href} className={cn(textLink, 'wrap-anywhere')}>
                  {r.title}
                </Link>
                <span className="mt-0.5 block text-sm text-quiet">
                  {r.reference} · version {r.versionNo}
                  {/* DA-209: the owner is labelled, so it is not read as the customer or the creator. */}
                  {r.ownerIsYou ? ' · Owner: you' : r.ownerName ? ` · Owner: ${r.ownerName}` : ''}
                </span>
                {facts ? <span className="mt-0.5 block text-sm wrap-anywhere text-copy">{facts}</span> : null}
              </TableCell>
              <TableCell label="Status" className="align-top">
                <span className="flex flex-col items-start gap-1.5">
                  <QuoteStatusWordPill word={r.statusWord} />
                  {r.draft && r.draft.status === 'closed' ? <DraftStateBadge state={r.draft} /> : null}
                </span>
              </TableCell>
              <TableCell label="Lead, deal or referral" className="align-top">
                <WorkSubject subject={r.subject} />
              </TableCell>
              <TableCell label="Valid until" className="align-top text-sm whitespace-nowrap">
                {r.validUntilText ?? <span className="text-quiet">Set when shared</span>}
              </TableCell>
              <TableCell label="Updated" className="align-top text-sm text-copy">
                {/* Echo N5: a fallback row has the time on the quotation itself. */}
                {r.updatedText || <span className="text-quiet">See the quotation</span>}
              </TableCell>
              <TableCell label="" className="align-top sm:text-right">
                <RowAction action={r.action} rowTitle={`${r.reference} ${r.title}`} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** DA-43 itinerary status word with an icon (never colour alone); unknown words keep a neutral look. */
function ItineraryStatusBadge({ text }: { text: string }) {
  const look: { tone: StatusTone; icon: LucideIcon } = /final pdf made|pdf ready/i.test(text)
    ? { tone: 'success', icon: FileCheck2 }
    : /^ready/i.test(text)
      ? { tone: 'info', icon: CircleCheck }
      : /difference/i.test(text)
        ? { tone: 'warning', icon: TriangleAlert }
        : /^draft/i.test(text)
          ? { tone: 'warning', icon: PenLine }
          : { tone: 'neutral', icon: FileText };
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">Itinerary status: </span>
      {text}
    </StatusBadge>
  );
}

/** One itinerary per row: title link with its basis, status, subject, open differences, updated, final PDF. No money. */
export function WorkItineraryTable({ rows, id, caption }: { rows: WorkItineraryRowVM[]; id: string; caption: string }) {
  return (
    <Table stackOnMobile label="Itineraries table" wrapperClassName="rounded-card" id={id}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Itinerary</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Made for</TableHead>
          <TableHead>Open differences</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead>
            <span className="sr-only">Final PDF</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.documentId} className="align-top" data-search={`${r.title} ${r.subject.text} ${r.basisText}`.toLowerCase()}>
            <TableCell label="Itinerary" className="align-top">
              <Link href={r.href} className={cn(textLink, 'wrap-anywhere')}>
                {r.title}
              </Link>
              <span className="mt-0.5 block text-sm text-quiet">
                {r.basisText}
                {r.ownerName ? ` · Owner: ${r.ownerName === 'You' ? 'you' : r.ownerName}` : ''}
              </span>
            </TableCell>
            <TableCell label="Status" className="align-top">
              <span className="flex flex-col items-start gap-1.5">
                <ItineraryStatusBadge text={r.statusText} />
                {r.draft && r.draft.status === 'closed' ? <DraftStateBadge state={r.draft} /> : null}
              </span>
            </TableCell>
            <TableCell label="Made for" className="align-top">
              <WorkSubject subject={r.subject} />
            </TableCell>
            <TableCell label="Open differences" className="align-top text-sm">
              {/* DA-210: the draft page may not know the count (null): never claim "None" without a check. */}
              {r.differencesKnown === false ? (
                <span className="text-quiet">See the itinerary</span>
              ) : r.openDifferences > 0 ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                  <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-status-warning" />
                  {r.openDifferences} to settle
                </span>
              ) : (
                <span className="text-quiet">None</span>
              )}
            </TableCell>
            <TableCell label="Updated" className="align-top text-sm text-copy">
              {r.updatedText || <span className="text-quiet">See the itinerary</span>}
            </TableCell>
            <TableCell label="" className="align-top sm:text-right">
              {r.finalDownloadHref ? (
                // Existing download route (404 on refusal); a plain link so the browser downloads it.
                <a href={r.finalDownloadHref} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'max-sm:h-11 max-sm:px-3.5')}>
                  <Download aria-hidden="true" />
                  Final PDF
                  <span className="sr-only">: {r.title}</span>
                </a>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** Quotations list (QL, FP-040). */
export function QuotationsListScreen({ page }: { page: QuotationListPageVM }) {
  return <WorkListFrame page={page} table={(id) => <WorkQuotationTable rows={page.rows} id={id} caption={page.pager.rangeText} />} />;
}

/** Itineraries list (IL, FP-051). */
export function ItinerariesListScreen({ page }: { page: ItineraryListPageVM }) {
  return <WorkListFrame page={page} table={(id) => <WorkItineraryTable rows={page.rows} id={id} caption={page.pager.rangeText} />} />;
}

/** Loading state for either list: one level-1 heading, a polite "Loading…" and grey shapes of the real layout. */
export function WorkListLoading({ kind }: { kind: WorkListKind }) {
  const words = KIND_WORDS[kind];
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">{words.title}</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading {words.noun}…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-40 max-w-full" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-9 w-full max-w-2xl" />
        <div className="rounded-card border border-line bg-card shadow-card">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-6 border-b border-line px-4.5 py-4 last:border-b-0 max-sm:flex-col max-sm:items-start max-sm:gap-2">
              <Skeleton className="h-4 w-56 max-w-full flex-1 max-sm:flex-none" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32 max-sm:hidden" />
              <Skeleton className="h-4 w-20 max-sm:hidden" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
