
import { Building2, FilePlus2, Lock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Fold } from '@/components/ui/fold';
import { RecordHeader } from '@/components/ui/record-header';
import { RecordTabs } from '@/components/ui/record-tabs';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import type { LeadBitrixDetailsVM, LeadWorkspaceVM } from '@/modules/deals/workspace-contract';
import { bitrixCodeDetail, formatIst, recordOwnerText } from './deal-labels';
import { TabUnavailable } from './deal-workspace/tab-error';
import { BitrixName, LateRecordNotice, OwnerValue } from './list-parts';
import { LEAD_SEEN_BECAUSE } from './list-seen-because';

/*
 * Phase 6 Bitrix Lead provenance (contract §2.2). Header fields only: no
 * contact, phone, email, comments, amounts or files. Bitrix owns every field;
 * the CRM shows them read-only and writes nothing back. Purchase never reads
 * leads (RLS), and these views carry no commercial value at all.
 * Layout adapted from the 21st.dev "Leads Data Table" (7491: source pill and
 * status pill per row) with its selection, hover actions, amounts, sparklines
 * and motion removed, and the Phase 5 "Data Refresh State" (29369) provenance
 * strip. See docs/implementation/phase-6/design/21st-dev-log.md.
 */

/** Read-only Bitrix provenance of one CRM lead row (`crm_leads`). */
export interface LeadSourceView {
  system: 'bitrix';
  /** Bitrix lead id (source_lead_id). */
  sourceLeadId: string;
  /** Bitrix STATUS_ID, e.g. NEW. */
  statusId: string;
  /** Plain status name when verified from the portal; null shows the raw id. */
  statusLabel?: string | null;
  /** Bitrix SOURCE_ID, equal to the approved list's source code. */
  sourceCode: string;
  /** Verified portal label for sourceCode (e.g. "CRM form"); null shows the raw code. */
  sourceCodeLabel?: string | null;
  /** Bitrix DATE_CREATE. */
  sourceCreatedAt: string;
  lastSyncedAt: string;
  lastVerifiedAt: string;
  /** True when last_verified_at is older than the proposed 24 h threshold. */
  stale: boolean;
}

/** Why this viewer may read the lead (mirrors the crm_leads RLS read rule). */
export type LeadRelation = 'owner' | 'branch_manager' | 'integration_admin';

export interface LeadListItem {
  id: string;
  /** BXL-<lead id>. */
  reference: string;
  /** Bitrix TITLE (at most 200 characters). */
  title: string;
  branchName: string;
  relation: LeadRelation;
  source: LeadSourceView;
}

export interface LeadDetail extends LeadListItem {
  /** Mapped CRM staff display name; null when this viewer cannot read the profile. */
  ownerName: string | null;
}

// Direction A, Batch 1 screens (src/views/list-leads.tsx), exported from here for the routes.
// The Lead record view below replaces the Batch 1 one (UX redesign R2, B2); the list stays in list-leads.tsx.
export { LEAD_SEEN_BECAUSE, LeadNotFoundView, LeadsListScreen, LeadsNoPermissionView, leadDayText } from './list-leads';
export type { LeadListRowVM, LeadsListScreenProps } from './list-leads';

// ---------------------------------------------------------------------------
// Lead record (LE-02; UX redesign R2, design plan 2.4 "Lead page", C4 record header)
// ---------------------------------------------------------------------------

export interface LeadWorkspaceViewProps {
  workspace: LeadWorkspaceVM;
  /** Quotations tab body (today's SubjectQuotationsCard), placed by the route only when the Quotations tab is open. */
  quotationsTab?: ReactNode;
}

function LeadOverviewTab({ overview }: { overview: NonNullable<LeadWorkspaceVM['overview']> }) {
  return (
    <Card>
      <section aria-labelledby="lead-overview-heading">
        <CardHeader className="sr-only">
          <CardTitle id="lead-overview-heading">Overview</CardTitle>
        </CardHeader>
        <CardBody>
          <SummaryList>
            <SummaryRow label="Source">
              <BitrixName name={overview.source} kind="source" />
            </SummaryRow>
            <SummaryRow label="Created in Bitrix">{formatIst(overview.createdInBitrixAt)}</SummaryRow>
            <SummaryRow label="Branch">{overview.branchName}</SummaryRow>
            <SummaryRow label="Owner">
              <OwnerValue owner={overview.owner} />
            </SummaryRow>
          </SummaryList>
        </CardBody>
      </section>
    </Card>
  );
}

function LeadBitrixTab({ bitrix }: { bitrix: LeadBitrixDetailsVM }) {
  return (
    <Card>
      <section aria-labelledby="lead-bitrix-heading">
        <CardHeader>
          <CardTitle id="lead-bitrix-heading">Bitrix details</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <SummaryList>
            <SummaryRow label="Bitrix lead">#{bitrix.sourceLeadId}</SummaryRow>
            <SummaryRow label="Status">
              <BitrixName name={bitrix.status} kind="status" />
              <span className="block text-sm text-quiet">{bitrixCodeDetail(bitrix.status)}</span>
            </SummaryRow>
            <SummaryRow label="Source">
              <BitrixName name={bitrix.source} kind="source" />
              <span className="block text-sm text-quiet">{bitrixCodeDetail(bitrix.source)}</span>
              <span className="block text-sm text-quiet">Source is the label staff set in Bitrix. It does not prove which form the customer used.</span>
            </SummaryRow>
            <SummaryRow label="Created in Bitrix">{formatIst(bitrix.createdInBitrixAt)}</SummaryRow>
            <SummaryRow label="Last checked with Bitrix">{formatIst(bitrix.lastCheckedAt)}</SummaryRow>
            <SummaryRow label="Last change received from Bitrix">{formatIst(bitrix.lastChangeAt)}</SummaryRow>
            <SummaryRow label="Why you see it">You see this lead because {LEAD_SEEN_BECAUSE[bitrix.relation]}.</SummaryRow>
          </SummaryList>
          <p className="m-0 flex gap-2 text-sm text-quiet">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
            <span>Title, status, source and owner come from Bitrix. Change them in Bitrix.</span>
          </p>
        </CardBody>
      </section>
    </Card>
  );
}

/**
 * Lead record: the C4 record header (back · Lead reference / title · Bitrix
 * status · owner / "Next:" with the one primary "New quotation"), pill link
 * tabs (Overview · Quotations · Bitrix details), then only the open tab's
 * body. The branch is folded under Details. No contact fields, amounts or
 * files (the Lead read carries none).
 */
export function LeadWorkspaceView({ workspace, quotationsTab }: LeadWorkspaceViewProps) {
  const { header, tabs, current } = workspace;
  const quotationsTabItem = tabs.find((t) => t.tab === 'quotations');
  // On the Quotations tab the card's own "Create quotation" is the one primary (copy §16.3), so the header link is hidden there.
  const showPrimary = header.canCreateQuotation && quotationsTabItem && current !== 'quotations';
  const nextActor = header.next.actor ?? recordOwnerText(header.owner);
  const owner = recordOwnerText(header.owner);
  const body =
    current === 'quotations' ? (
      quotationsTab ?? <TabUnavailable thing="Quotations" />
    ) : current === 'bitrix' ? (
      workspace.bitrix ? <LeadBitrixTab bitrix={workspace.bitrix} /> : <TabUnavailable thing="Bitrix details" />
    ) : workspace.overview ? (
      <LeadOverviewTab overview={workspace.overview} />
    ) : (
      <TabUnavailable thing="Overview" />
    );
  return (
    <div className="font-sans text-base text-copy">
      <div className="mb-4" data-slot="lead-header">
        <RecordHeader
          className="mb-0"
          back={{ href: '/app/leads', label: 'Back to leads' }}
          recordId={<span className="wrap-anywhere">{header.reference}</span>}
          title={<span className="block wrap-anywhere">{header.title}</span>}
          owner={owner ?? undefined}
          status={
            <>
              <BitrixName name={header.status} kind="status" capitalDetails />
              {owner === null ? <OwnerValue owner={header.owner} /> : null}
            </>
          }
        />
        <div
          className="mt-3 flex flex-col gap-2.5 rounded-control border border-line bg-card px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between"
          data-slot="next-step"
        >
          <p className="m-0 text-base text-copy">
            <span className="font-semibold text-ink">Next:</span> {header.next.text}
            {nextActor ? <span className="text-quiet"> · {nextActor}</span> : null}
          </p>
          {showPrimary ? (
            <Link
              href={quotationsTabItem.href}
              className={cn(buttonVariants({ variant: 'primary' }), 'h-auto min-h-10 shrink-0 py-2 whitespace-normal max-sm:w-full')}
              data-slot="lead-primary"
            >
              <FilePlus2 aria-hidden="true" />
              New quotation
            </Link>
          ) : null}
        </div>
        {header.bitrixLate ? (
          <div className="mt-2.5">
            <LateRecordNotice thing="lead" />
          </div>
        ) : null}
        <Fold summary="Details" className="mt-2.5 shadow-none" bodyClassName="flex flex-col gap-1 text-copy">
          <p className="m-0 inline-flex items-center gap-1.5">
            <Building2 aria-hidden="true" className="size-4 shrink-0 text-faint" />
            Branch: {header.branchName}
          </p>
        </Fold>
      </div>
      {/* C5 pill look; record tabs never carry a count. */}
      <RecordTabs tabs={tabs} label="Lead sections" variant="pill" className="mb-4" />
      {body}
    </div>
  );
}
