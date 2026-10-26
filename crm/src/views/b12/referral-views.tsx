import { CalendarClock, CircleCheck, FileText, History as HistoryIcon, Inbox, Link2, Lock, Map as MapIcon, RefreshCw, Search, ShieldCheck, TriangleAlert, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { RecordTabs } from '@/components/ui/record-tabs';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Timeline } from '@/components/ui/timeline';
import { REFERRAL_DRAFTS_PATH } from '@/modules/quotations/subject-links';
import type { NewWorkVM, ReferralDraftVM, ReferralLinkStepVM, ReferralLinkVM, SubjectReferralDraftsVM } from '@/modules/quotations/work-contract';
import { CreateItineraryForm } from './itin-forms';
import type { ItinAction } from './itin-kit';
import { CreateQuotationForm } from './quote-forms';
import type { QuoteAction } from './quote-kit';
import { BackLink } from './quote-views';
import { ChangeOwnerForm, CloseDraftForm, DraftResultLine, DraftResultNotice, ReferralCreateForm, ReferralCustomerForm, ReferralLinkForm, ReferralUnlinkForm, ReopenDraftForm, type ReferralActions, type ReferralCustomerFormVM } from './referral-forms';
import { defaultReferralTitle } from './referral-text';
import { DraftStateBadge, WorkItineraryTable, WorkQuotationTable } from './work-lists';

/*
 * Referral drafts (Direction A Batch 3; copy-catalogue §16.5, DA-13 tabs).
 * Server components over Terra's view models (work-contract.ts):
 * - NewWorkScreen: "New quotation" / "New itinerary" choice (QN, IN). For a
 *   lead or deal there is no picker in Batch 3 (lead ruling): links to the
 *   Leads and Deals lists. The referral choice shows only when the switch is
 *   On; Off says DA-78; Unknown says the CRM could not check (never Off).
 * - ReferralDraftScreen: P-HEADER (status word with icon, reference line,
 *   owner, branch, Next line, automatic-close line, ONE primary), link tabs
 *   (Overview · Quotations · Itineraries · Link to Bitrix · History), and a
 *   read-only closed state with Reopen (DA-74, DA-75).
 * - SubjectReferralDraftsSection: "Referral drafts for this deal" (DA-71).
 * Catalog gaps G9 (header), G11 (link step) and G12 (create form): register §3, §12.
 */

const textLink = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

/** Adds query parameters to a same-site href (keeps the existing ones). */
function withParams(href: string, params: Record<string, string>): string {
  const url = new URL(href, 'http://crm.invalid');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}`;
}

// ---------------------------------------------------------------------------
// New quotation / New itinerary (QN, IN)
// ---------------------------------------------------------------------------

const NEW_WORDS = {
  quotations: { title: 'New quotation', back: { href: '/app/quotations', label: 'Back to Quotations' }, fromHeading: 'For a lead or deal', icon: FileText },
  itineraries: { title: 'New itinerary', back: { href: '/app/itineraries', label: 'Back to Itineraries' }, fromHeading: 'For a quotation or deal', icon: MapIcon },
} as const;

export function NewWorkScreen({ vm, createAction }: { vm: NewWorkVM; createAction: QuoteAction }) {
  const words = NEW_WORDS[vm.kind];
  const r = vm.referral;
  if (vm.allowed === false) {
    // Echo-B L4, DA-207: someone without the Quotations menu item who types the address.
    const noun = vm.kind === 'quotations' ? 'quotations' : 'itineraries';
    return (
      <div className="font-sans text-base text-copy">
        <PageHeader title={words.title} />
        <Card role="status">
          <EmptyState
            icon={words.icon}
            headingLevel={2}
            title={`No ${noun} for your role`}
            description={`${noun === 'quotations' ? 'Quotations' : 'Itineraries'} are made by Sales and branch Managers. Your own work is in the menu.`}
          />
        </Card>
      </div>
    );
  }
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href={words.back.href} label={words.back.label} />
      <PageHeader title={words.title} description="Choose who it is for." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
        <Card>
          <section aria-labelledby="new-from-bitrix-heading">
            <CardHeader>
              <CardTitle id="new-from-bitrix-heading">{words.fromHeading}</CardTitle>
              <CardDescription className="basis-full">{vm.fromBitrix.text}</CardDescription>
            </CardHeader>
            <CardBody className="flex flex-wrap gap-2">
              {vm.fromBitrix.leadsHref ? (
                <Link href={vm.fromBitrix.leadsHref} className={buttonVariants({ variant: 'secondary' })}>
                  <Inbox aria-hidden="true" />
                  Open Leads
                </Link>
              ) : null}
              <Link href={vm.fromBitrix.dealsHref} className={buttonVariants({ variant: 'secondary' })}>
                <Users aria-hidden="true" />
                Open Deals
              </Link>
            </CardBody>
          </section>
        </Card>
        <Card>
          <section aria-labelledby="new-referral-heading">
            <CardHeader>
              <CardTitle id="new-referral-heading">Referral (no Bitrix record yet)</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {r.state === 'on' ? (
                <ReferralCreateForm kind={vm.kind} referral={r} action={createAction} />
              ) : r.state === 'off' ? (
                <Notice tone="locked" role="status" title="Switched off">
                  <p>{r.line}</p>
                </Notice>
              ) : (
                <Notice tone="warning" role="status" icon={TriangleAlert} title="Could not check">
                  <p>{r.line}</p>
                </Notice>
              )}
            </CardBody>
          </section>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Referral draft page
// ---------------------------------------------------------------------------

export interface ReferralDraftScreenProps {
  vm: ReferralDraftVM;
  actions: ReferralActions;
  /** Link to Bitrix tab only (built from ?kind=&query=); null when the viewer cannot link. */
  linkStep?: ReferralLinkStepVM | null;
  /** referral_owner_candidates (branch Manager only). */
  ownerCandidates?: Array<{ userId: string; displayName: string }> | null;
  /** Current customer details for "Edit customer details" (can.edit). */
  customer?: ReferralCustomerFormVM | null;
  /** QUOTE_ACTIONS.create (subject kind 'referral'). */
  quoteCreate?: QuoteAction;
  /** ITINERARY_ACTIONS.create (subject kind 'referral'). */
  itinCreate?: ItinAction;
}

function linkTabHref(vm: ReferralDraftVM): string {
  return vm.tabs.find((t) => t.tab === 'link')?.href ?? withParams(`${REFERRAL_DRAFTS_PATH}/${vm.referralDraftId}`, { tab: 'link' });
}

function DraftPrimary({ vm, actions }: { vm: ReferralDraftVM; actions: ReferralActions }) {
  const p = vm.header.primary;
  if (p === 'reopen' && vm.can.reopen) {
    return <ReopenDraftForm draftId={vm.referralDraftId} rowVersion={vm.rowVersion} noteRequired={vm.header.state.closedReason === 'duplicate'} action={actions.reopen} />;
  }
  if (p === 'link' && vm.tab !== 'link') {
    // On the Link to Bitrix tab the link form's own button is the page's one primary.
    return (
      <Link href={linkTabHref(vm)} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
        <Link2 aria-hidden="true" />
        Link to Bitrix
      </Link>
    );
  }
  if (p === 'start_booking') {
    if (vm.header.startBooking) {
      return (
        <Link href={vm.header.startBooking.href} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
          {vm.header.startBooking.label}
        </Link>
      );
    }
    const accepted = vm.quotations.find((q) => q.statusWord === 'Accepted');
    if (accepted) {
      return (
        // Echo-B M4: the button opens the accepted quotation (where "Start booking from this quotation" is), so it says so.
        <Link href={accepted.href} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
          Open {accepted.reference} to start booking
        </Link>
      );
    }
  }
  return null;
}

function OverviewTab({ vm, actions, customer, ownerCandidates }: Pick<ReferralDraftScreenProps, 'vm' | 'actions' | 'customer' | 'ownerCandidates'>) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <SummaryList aria-label="Draft details">
            {vm.overview.map((row) => (
              <SummaryRow key={row.label} label={row.label}>
                {row.value ?? <NotEntered>Not given</NotEntered>}
              </SummaryRow>
            ))}
          </SummaryList>
          <p className="m-0 flex items-start gap-2 text-sm text-copy">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-strong" />
            <span>{vm.header.privacyLine}</span>
          </p>
        </CardBody>
      </Card>
      {!vm.readOnly && vm.can.edit && customer && actions.save ? <ReferralCustomerForm draftId={vm.referralDraftId} rowVersion={vm.rowVersion} customer={customer} action={actions.save} /> : null}
      {!vm.readOnly && (vm.can.close || (vm.can.reassign && ownerCandidates && ownerCandidates.length > 0)) ? (
        <div className="flex flex-wrap gap-2" data-slot="draft-more">
          {vm.can.close ? <CloseDraftForm draftId={vm.referralDraftId} rowVersion={vm.rowVersion} action={actions.close} /> : null}
          {vm.can.reassign && ownerCandidates && ownerCandidates.length > 0 ? (
            <ChangeOwnerForm draftId={vm.referralDraftId} rowVersion={vm.rowVersion} branchName={vm.header.branchName} candidates={ownerCandidates} action={actions.reassign} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkTab({
  title,
  icon,
  empty,
  table,
  createForm,
}: {
  title: string;
  icon: LucideIcon;
  empty: string;
  table: ReactNode | null;
  createForm: ReactNode | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {table ? (
        <Card>{table}</Card>
      ) : (
        <Card role="status">
          <EmptyState icon={icon} headingLevel={2} title={`No ${title.toLowerCase()} yet`} description={empty} />
        </Card>
      )}
      {createForm ? (
        <Card>
          <CardBody>{createForm}</CardBody>
        </Card>
      ) : null}
    </div>
  );
}

// A closed draft's wrong link can still be removed (owner or branch Manager, no reopen; Atlas, 21 Oct):
// the server's canRemove decides, never the closed state. link_locked after bind or convert stays.
function LinkRow({ link, draftId, rowVersion, actions }: { link: ReferralLinkVM; draftId: string; rowVersion: number; actions: ReferralActions }) {
  const noun = link.targetKind === 'deal' ? 'Deal' : 'Lead';
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0" data-slot="referral-link">
      <p className="m-0 flex items-start gap-2 text-copy">
        {link.active ? (
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />
        ) : (
          <HistoryIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
        )}
        <span className="min-w-0 wrap-anywhere">
          <span className="sr-only">{link.active ? 'Active link: ' : 'Ended link: '}</span>
          {noun}{' '}
          {link.href ? (
            <Link href={link.href} className={textLink}>
              {link.reference}
            </Link>
          ) : (
            <strong className="font-semibold text-ink">{link.reference}</strong>
          )}
          {link.title ? ` · ${link.title}` : ''}
          <span className="block text-sm text-quiet">{link.endedText ?? link.linkedText}</span>
        </span>
      </p>
      {link.active && link.canRemove ? <ReferralUnlinkForm link={link} draftId={draftId} rowVersion={rowVersion} action={actions.unlink} /> : null}
    </li>
  );
}

function LinkStepFrame({ vm, step, actions }: { vm: ReferralDraftVM; step: ReferralLinkStepVM; actions: ReferralActions }) {
  const base = linkTabHref(vm);
  const kinds = [
    { kind: 'deal', label: 'Deal' },
    { kind: 'lead', label: 'Lead' },
  ] as const;
  const alreadyLinked = vm.links.find((l) => l.active && l.targetKind === step.kind);
  const noun = step.kind === 'deal' ? 'deal' : 'lead';
  return (
    <section aria-labelledby="referral-link-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="referral-link-heading" className="m-0 text-lg font-semibold text-ink">
          Link to Bitrix
        </h2>
        <p className="m-0 text-copy">Pick the lead or deal for this customer. The CRM never links by name, mobile or email on its own.</p>
      </div>
      <div role="group" aria-label="Link to a lead or a deal" className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-quiet">Link to a:</span>
        <span className="inline-flex gap-0.5 rounded-control border border-line bg-wash p-0.5">
          {kinds.map((k) =>
            k.kind === step.kind ? (
              <strong key={k.kind} aria-current="true" className="inline-flex min-h-9 items-center rounded-chip bg-card px-2.5 py-1 text-sm font-semibold text-ink shadow-button">
                {k.label}
              </strong>
            ) : (
              <Link
                key={k.kind}
                href={withParams(base, { kind: k.kind })}
                className={cn('inline-flex min-h-9 items-center rounded-chip px-2.5 py-1 text-sm font-medium text-brand-strong no-underline hover:bg-card hover:text-brand-deep', focusRing)}
              >
                {k.label}
              </Link>
            ),
          )}
        </span>
      </div>
      {alreadyLinked ? (
        <Notice tone="info" role="status">
          {alreadyLinked.canRemove ? (
            <p>
              This draft is already linked to {noun} {alreadyLinked.reference}. Remove the wrong link first to link another.
            </p>
          ) : (
            // Echo-B L1, DA-231: a link that can no longer be removed never invites removing it.
            <p>
              This draft is linked to {noun} {alreadyLinked.reference}. The link cannot be removed: a quotation from this draft is already tied to that {noun} for
              booking.
            </p>
          )}
        </Notice>
      ) : (
        <>
          {/* GET form: the candidate list is re-read on the server; nothing is linked by searching. */}
          <form method="get" action={new URL(base, 'http://crm.invalid').pathname} role="search" aria-label={`Find a ${step.kind}`} className="flex max-w-lg flex-col gap-1">
            <input type="hidden" name="tab" value="link" />
            <input type="hidden" name="kind" value={step.kind} />
            <label htmlFor="referral-link-query" className="text-sm font-semibold text-ink">
              Find a {step.kind} by reference or title
            </label>
            <div className="flex gap-2">
              <Input id="referral-link-query" name="query" defaultValue={step.query} minLength={2} maxLength={100} autoComplete="off" className="min-w-0 flex-1" />
              <button type="submit" className={cn(buttonVariants({ variant: 'secondary' }), 'min-h-10')}>
                <Search aria-hidden="true" />
                Find
              </button>
            </div>
          </form>
          {step.loadError ? (
            <Notice tone="warning" role="status" icon={RefreshCw}>
              <p>{step.loadError}</p>
            </Notice>
          ) : step.candidates.length > 0 ? (
            <ReferralLinkForm draftId={vm.referralDraftId} rowVersion={vm.rowVersion} step={step} action={actions.link} />
          ) : (
            <p className="m-0 text-copy" role="status">
              {step.emptyText}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function LinkTab({ vm, actions, linkStep }: Pick<ReferralDraftScreenProps, 'vm' | 'actions' | 'linkStep'>) {
  const active = vm.links.filter((l) => l.active);
  // Echo N2: the route reads no candidates once the draft has an active deal link, so the state of that
  // link is told from vm.links here (never from the link step): removable, or locked with the reason (DA-231).
  const dealLink = active.find((l) => l.targetKind === 'deal');
  const ended = vm.links.filter((l) => !l.active);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <section aria-labelledby="referral-links-heading">
          <CardHeader>
            <CardTitle id="referral-links-heading">Links</CardTitle>
            <CardDescription className="basis-full">Linking changes nothing in Bitrix. Booking waits for the confirmed Bitrix deal.</CardDescription>
          </CardHeader>
          <CardBody>
            {active.length > 0 ? (
              <ul className="m-0 list-none p-0">
                {active.map((l) => (
                  <LinkRow key={l.linkId} link={l} draftId={vm.referralDraftId} rowVersion={vm.rowVersion} actions={actions} />
                ))}
              </ul>
            ) : (
              <p className="m-0 text-copy">Not linked to Bitrix yet.</p>
            )}
            {ended.length > 0 ? (
              <details className="mt-3">
                <summary className={cn('cursor-pointer rounded-chip text-sm font-medium text-brand-strong', focusRing)}>Earlier links ({ended.length})</summary>
                <ul className="m-0 mt-2.5 list-none p-0">
                  {ended.map((l) => (
                    <LinkRow key={l.linkId} link={l} draftId={vm.referralDraftId} rowVersion={vm.rowVersion} actions={actions} />
                  ))}
                </ul>
              </details>
            ) : null}
          </CardBody>
        </section>
      </Card>
      {dealLink && !dealLink.canRemove ? (
        <Notice tone="locked" icon={Lock} role="note">
          <p>
            This draft is linked to deal {dealLink.reference}. The link cannot be removed: a quotation from this draft is already tied to that deal for booking.
          </p>
        </Notice>
      ) : dealLink && !vm.readOnly ? (
        <Notice tone="info" role="note">
          <p>This draft is already linked to deal {dealLink.reference}. Remove the wrong link first to link another.</p>
        </Notice>
      ) : null}
      {vm.readOnly || !vm.can.link || dealLink || !linkStep ? null : (
        <Card>
          <CardBody>
            <LinkStepFrame vm={vm} step={linkStep} actions={actions} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function HistoryTab({ vm }: { vm: ReferralDraftVM }) {
  if (vm.history.length === 0) {
    return (
      <Card role="status">
        <EmptyState icon={HistoryIcon} headingLevel={2} title="No history yet" description="Changes to this draft appear here." />
      </Card>
    );
  }
  return (
    <Card>
      <CardBody>
        <Timeline label="Draft history" items={vm.history.map((h, i) => ({ id: String(i), title: h.text, meta: h.at }))} />
      </CardBody>
    </Card>
  );
}

/** The referral draft page (/app/quotations/drafts/[draftId]). */
export function ReferralDraftScreen({ vm, actions, linkStep = null, ownerCandidates = null, customer = null, quoteCreate, itinCreate }: ReferralDraftScreenProps) {
  const h = vm.header;
  // DA-213: the add forms prefill the same default an empty create title prints.
  const defaultTitle = vm.defaultTitle ?? defaultReferralTitle(customer?.customerName ?? h.title.replace(/ · referral draft$/, ''));
  const primary = <DraftPrimary vm={vm} actions={actions} />;
  let body: ReactNode;
  switch (vm.tab) {
    case 'overview':
      body = <OverviewTab vm={vm} actions={actions} customer={customer} ownerCandidates={ownerCandidates} />;
      break;
    case 'quotations':
      body = (
        <WorkTab
          title="Quotations"
          icon={FileText}
          empty="Quotations made for this customer appear here."
          table={vm.quotations.length > 0 ? <WorkQuotationTable rows={vm.quotations} id="draft-quotations-table" caption={`Quotations of ${vm.reference}`} /> : null}
          createForm={
            !vm.readOnly && vm.can.addQuotation && quoteCreate ? (
              <CreateQuotationForm subjectKind="referral" subjectId={vm.referralDraftId} defaultTitle={defaultTitle} action={quoteCreate} variant="secondary" />
            ) : null
          }
        />
      );
      break;
    case 'itineraries':
      body = (
        <WorkTab
          title="Itineraries"
          icon={MapIcon}
          empty="Itineraries made for this customer appear here."
          table={vm.itineraries.length > 0 ? <WorkItineraryTable rows={vm.itineraries} id="draft-itineraries-table" caption={`Itineraries of ${vm.reference}`} /> : null}
          createForm={
            !vm.readOnly && vm.can.addItinerary && itinCreate ? (
              <CreateItineraryForm subjectKind="referral" subjectId={vm.referralDraftId} defaultTitle={defaultTitle} action={itinCreate} />
            ) : null
          }
        />
      );
      break;
    case 'link':
      body = <LinkTab vm={vm} actions={actions} linkStep={linkStep} />;
      break;
    case 'history':
      body = <HistoryTab vm={vm} />;
      break;
  }
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href="/app/quotations" label="Back to Quotations" />
      <PageHeader
        eyebrow={<span className="wrap-anywhere">{vm.reference}</span>}
        title={<span className="block wrap-anywhere">{h.title}</span>}
        status={
          <>
            <DraftStateBadge state={h.state} />
            <span className="min-w-0 wrap-anywhere text-copy">{h.refLine}</span>
            {h.ownerName ? (
              <span className="text-copy">
                <span className="text-quiet">Owner:</span> {h.ownerName}
              </span>
            ) : null}
            <span className="text-copy">
              <span className="text-quiet">Branch:</span> {h.branchName}
            </span>
          </>
        }
        actions={<div data-slot="draft-primary">{primary}</div>}
        className="mb-3"
      />
      <div className="mb-4 flex flex-col gap-2.5">
        <p className="m-0 text-copy" data-slot="draft-next">
          <span className="font-semibold text-ink">Next:</span> {h.nextLine.replace(/^Next:\s*/, '')}
        </p>
        {h.state.autoCloseLine ? (
          <p className="m-0 flex items-start gap-2 text-sm text-copy" data-slot="draft-auto-close">
            <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
            <span>{h.state.autoCloseLine}</span>
          </p>
        ) : null}
        {vm.readOnly ? (
          <Notice tone="locked" icon={Lock} role="note">
            <p>This draft is closed. Reopen it to make changes. Nothing was deleted.</p>
          </Notice>
        ) : null}
        {vm.switchState === 'off' && !vm.readOnly ? <p className="m-0 text-sm text-quiet">Referral drafts are switched off for new customers. This draft keeps working.</p> : null}
      </div>
      {/* Link / remove-link answers arrive with the redirected page (resultNotice); close, reopen and change-owner
          answers stay here across the server's revalidation of this page (not across a browser reload). Echo-B M1. */}
      {vm.resultNotice ? <DraftResultNotice text={vm.resultNotice} /> : null}
      <DraftResultLine key={vm.tab} />
      <RecordTabs tabs={vm.tabs} label="Referral draft sections" className="mb-4" />
      {body}
    </div>
  );
}

/** Same page for a draft that does not exist and one the viewer may not open (no id probing). */
export function ReferralDraftNotAvailableView() {
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href="/app/quotations" label="Back to Quotations" />
      <PageHeader title="Referral draft" />
      <Notice tone="locked">
        <p>This referral draft is not available. It may not exist, or it is not shared with you.</p>
      </Notice>
    </div>
  );
}

/** The draft read failed (never shown as "not available" or as an empty draft). */
export function ReferralDraftLoadErrorView() {
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href="/app/quotations" label="Back to Quotations" />
      <PageHeader title="Referral draft" />
      <Notice tone="warning" role="status" icon={RefreshCw} title="This referral draft did not load">
        <p>Nothing was changed. Reload the page to try again.</p>
      </Notice>
    </div>
  );
}

export function ReferralDraftNotInstalledView() {
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href="/app/quotations" label="Back to Quotations" />
      <PageHeader title="Referral draft" />
      <Notice tone="locked" role="status">
        <p>Referral drafts are not installed in this CRM yet.</p>
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deal page section (DA-71)
// ---------------------------------------------------------------------------

/** "Referral drafts for this deal" on the Deal Quotations tab. Rows only for drafts the viewer can open. */
export function SubjectReferralDraftsSection({ vm }: { vm: SubjectReferralDraftsVM }) {
  return (
    <Card>
      <section aria-labelledby="subject-referral-drafts-heading">
        <CardHeader>
          <CardTitle id="subject-referral-drafts-heading">{vm.heading}</CardTitle>
          {vm.note ? (
            <CardDescription className="flex basis-full items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
              <span>{vm.note}</span>
            </CardDescription>
          ) : null}
        </CardHeader>
        {vm.rows.length === 0 ? (
          <CardBody>
            <p className="m-0 text-copy">No referral draft is linked to this deal.</p>
          </CardBody>
        ) : (
          <Table stackOnMobile label="Referral drafts table" wrapperClassName="rounded-b-card">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Draft</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Quotations</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vm.rows.map((r) => (
                <TableRow key={r.referralDraftId} className="align-top">
                  <TableCell label="Draft" className="align-top">
                    <Link href={r.href} className={cn(textLink, 'wrap-anywhere')}>
                      {r.reference} · {r.customerName}
                    </Link>
                  </TableCell>
                  <TableCell label="Status" className="align-top">
                    <DraftStateBadge state={r.state} />
                  </TableCell>
                  <TableCell label="Owner" className="align-top text-sm">
                    {r.ownerName ?? <span className="text-quiet">Another staff member</span>}
                  </TableCell>
                  <TableCell label="Quotations" className="align-top text-sm">
                    {r.quotationCount === 0 ? 'None yet' : `${r.quotationCount}${r.hasAccepted ? ', one accepted' : ''}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </Card>
  );
}
