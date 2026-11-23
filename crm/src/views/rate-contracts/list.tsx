import { CalendarClock, FileSpreadsheet, SearchX, X } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { QueueToolbar } from '@/components/ui/queue-toolbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { AddDrawer } from '@/views/suppliers/add-drawer';
import { SupplierAreaTabs } from '@/views/suppliers/area-tabs';
import { rateContractChips, rateContractHref, rateContractSearchKeep } from '@/views/suppliers/queue';
import { NewContractForm } from './forms';
import { RateContractsSwitch } from './switch';
import { daysLeftText, endingSoon, rangeText } from './format';
import { STATUS_LOOK } from './labels';
import type { ContractSupplierChoice, RateContractFilter, RateContractPage, RateContractRow, RateContractStatus, RateContractViewer } from './types';

/*
 * Suppliers › Rate contracts (Accounts phase 3 contract §9.5 R-E1, §15 item 9;
 * UX redesign R3, DM-22 and DM-23). The second tab of the Suppliers area.
 * Queue pattern: one toolbar row with the search (on Enter) and chips for
 * the presets (Managers: "To approve"; everyone: "Ending soon", with counts)
 * and the statuses. Every chip and the search are the same addresses as
 * before (?q=, ?preset=, ?status=, ?supplierId=, ?hotelId=, ?after=), so the
 * back button and old links work. From 640 px the table keeps its columns
 * and scrolls inside its own labelled region; under 640 px each row is a
 * labelled card. Purchase adds a contract from the button (the same form in
 * the side drawer) or uploads a rate sheet; Managers approve on the contract
 * page; Accounts read. Rate contracts are supplier costs: Purchase, Managers
 * and Accounts only.
 */

const TEXT: Record<RateContractViewer, { eyebrow: string; description: string }> = {
  purchase: { eyebrow: 'Purchase › Suppliers', description: 'Agreed room rates per hotel and supplier. A Manager approves each contract before offers use it.' },
  manager: { eyebrow: 'Suppliers', description: 'Approve the rate contracts Purchase entered, and end a contract that no longer applies.' },
  accounts: { eyebrow: 'Suppliers', description: 'Read the agreed room rates per hotel and supplier.' },
};

function chipText(k: keyof RateContractFilter, v: unknown, names: { supplier?: string | null; hotel?: string | null }): string {
  switch (k) {
    case 'q':
      return `Search: ${String(v)}`;
    case 'status':
      return (v as RateContractStatus[]).map((s) => STATUS_LOOK[s].word).join(' or ');
    case 'supplierId':
      return `Supplier: ${names.supplier ?? 'the chosen supplier'}`;
    case 'hotelId':
      return `Hotel: ${names.hotel ?? 'the chosen hotel'}`;
    case 'endingWithinDays':
      return `Ending within ${String(v)} days`;
    case 'preset':
      return v === 'to_approve' ? 'To approve' : 'Ending soon';
  }
}

export function ContractStatusBadge({ status, daysLeft }: { status: RateContractStatus; daysLeft?: number }) {
  const look = STATUS_LOOK[status];
  const left = daysLeft === undefined ? null : daysLeftText(daysLeft, status);
  return (
    <span className="flex flex-wrap gap-1.5">
      <StatusBadge tone={look.tone} wrap>
        <span className="sr-only">Status: </span>
        {look.word}
      </StatusBadge>
      {left ? (
        <StatusBadge tone={daysLeft !== undefined && endingSoon(daysLeft, status) ? 'warning' : 'neutral'} icon={CalendarClock} wrap>
          {left}
        </StatusBadge>
      ) : null}
    </span>
  );
}

export function RateContractsListView({
  viewer,
  enabled,
  filter,
  page,
  basePath = '/app/purchase/rate-contracts',
  counts,
  names = {},
  suppliers = [],
  createAction,
  createInitialState,
  createOpen,
  importHref,
  switchAction,
}: {
  /** Super Admin only (rate_contracts_state().canSwitch): the E1 switch action. */
  switchAction?: DecisionAction | null;
  viewer: RateContractViewer;
  /** `procurement_settings.rate_contracts_enabled`. Off: read only with one line why. */
  enabled: boolean;
  filter: RateContractFilter;
  page: RateContractPage | 'error';
  basePath?: string;
  /** Counts for the preset chips (from the same read). */
  counts?: { toApprove?: number; endingSoon?: number };
  /** Names of the filtered supplier / hotel, for the chips. */
  names?: { supplier?: string | null; hotel?: string | null };
  /** Purchase: suppliers that sell hotels with their linked hotels (the create form). */
  suppliers?: ContractSupplierChoice[];
  createAction?: DecisionAction | null;
  createInitialState?: DeskResult | null;
  /** Preview gallery: start with the add drawer open (default: open when a create result is given). */
  createOpen?: boolean;
  /** The rate-sheet upload page for Purchase (inside this area since UX redesign R3). */
  importHref?: string | null;
}) {
  const t = TEXT[viewer];
  const canAdd = viewer === 'purchase' && enabled && !!createAction && suppliers.length > 0;
  const canUpload = viewer === 'purchase' && enabled && !!importHref;
  const active = (Object.entries(filter) as Array<[keyof RateContractFilter, unknown]>).filter(
    // The preset, the words and a single status show in the toolbar (current chip, "Showing matches for"); the rest are listed to remove.
    ([k, v]) => k !== 'preset' && k !== 'q' && !(k === 'status' && Array.isArray(v) && v.length === 1) && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  );
  const filtered = Object.values(filter).some((v) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
  const uploadLink = canUpload ? (
    <Link href={importHref!} className={buttonVariants({ variant: 'secondary' })}>
      <FileSpreadsheet aria-hidden="true" />
      Upload a rate sheet
    </Link>
  ) : null;
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <PageHeader
        eyebrow={t.eyebrow}
        title="Rate contracts"
        description={t.description}
        className="mb-[0]"
        actions={
          canAdd || uploadLink ? (
            <>
              {canAdd ? (
                <AddDrawer
                  buttonLabel="Add a contract"
                  title="Add a contract"
                  description="Choose the supplier and the hotel, and the dates the rates apply. You add the rate lines on the next page."
                  initialOpen={createOpen ?? !!createInitialState}
                >
                  <NewContractForm action={createAction!} suppliers={suppliers} initialState={createInitialState} />
                </AddDrawer>
              ) : null}
              {uploadLink}
            </>
          ) : undefined
        }
      />

      <SupplierAreaTabs current="rate-contracts" />

      {switchAction ? <RateContractsSwitch enabled={enabled} action={switchAction} /> : null}
      {!enabled ? (
        <Notice tone="locked" role="status" title="Rate contracts are not switched on yet">
          <p>{viewer === 'purchase' ? 'You can read contracts but not add or change them. A Super Admin switches this on after the owner approves it.' : 'Nothing can be added, approved or ended until a Super Admin switches this on.'}</p>
        </Notice>
      ) : null}

      <div className="flex flex-col gap-3">
        <QueueToolbar
          action={basePath}
          label="Search and filter rate contracts"
          chipsLabel="Rate contract lists"
          search={{ name: 'q', value: filter.q ?? '', placeholder: 'Contract number, hotel or supplier', label: 'Search rate contracts by contract number, or the start of the hotel or supplier name' }}
          chips={rateContractChips(basePath, filter, { manager: viewer === 'manager', counts })}
          keep={rateContractSearchKeep(filter)}
          className="mb-[0]"
        />
        {active.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0" aria-label="Active filters">
            {active.map(([k, v]) => (
              <li key={k}>
                <Link href={rateContractHref(basePath, filter, k)} className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-wash px-3 text-sm text-ink no-underline hover:border-brand-strong', focusRing)}>
                  {chipText(k, v, names)}
                  <X aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">(remove this filter)</span>
                </Link>
              </li>
            ))}
            <li>
              <Link href={rateContractHref(basePath, { preset: filter.preset, q: filter.q })} className={cn('rounded-chip text-sm font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                Clear all
              </Link>
            </li>
          </ul>
        ) : null}
      </div>

      <Card>
        {page === 'error' ? (
          <CardBody>
            <Notice tone="warning" role="status" title="The rate contracts could not be loaded">
              <p>Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
            </Notice>
          </CardBody>
        ) : page.items.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              headingLevel={2}
              title={filter.preset === 'to_approve' ? 'Nothing waiting for your approval' : filter.preset === 'ending_soon' ? 'No contract ends in the next 30 days' : 'No contract matches'}
              description={filter.preset ? 'Contracts show up here when they need you.' : 'Check the spelling, or remove a filter.'}
              action={
                <Link href={basePath} className={buttonVariants({ variant: 'secondary' })}>
                  Show all contracts
                </Link>
              }
            />
          ) : (
            <EmptyState
              icon={FileSpreadsheet}
              headingLevel={2}
              title="No rate contracts yet"
              description={canAdd ? 'Use “Add a contract” at the top, or upload a supplier’s rate sheet to make draft contracts.' : 'Purchase adds contracts here; a Manager approves each one.'}
              action={uploadLink ?? undefined}
            />
          )
        ) : (
          <ContractTable rows={page.items} basePath={basePath} />
        )}
        {page !== 'error' && page.hasMore && page.nextAfter ? (
          <CardBody className="border-t border-line">
            <Link href={rateContractHref(basePath, filter, undefined, page.nextAfter)} className={buttonVariants({ variant: 'secondary' })}>
              Show more contracts
            </Link>
          </CardBody>
        ) : null}
      </Card>
    </div>
  );
}

function ContractTable({ rows, basePath }: { rows: RateContractRow[]; basePath: string }) {
  return (
    <Table stackOnMobile label="Rate contracts table" wrapperClassName="rounded-card" className="sm:min-w-[52rem]">
      <TableCaption className="caption-top border-b border-line py-3 text-left font-medium text-copy max-sm:block">
        {rows.length} {rows.length === 1 ? 'contract' : 'contracts'} shown
      </TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Hotel</TableHead>
          <TableHead>Supplier</TableHead>
          <TableHead>Dates</TableHead>
          <TableHead numeric>Rate lines</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.contractId} className="align-top">
            <TableCell label="Hotel" className="align-top">
              <span className="block text-xs font-medium text-quiet tabular-nums">
                {r.contractNo} · version {r.versionNo}
              </span>
              <Link href={`${basePath}/${r.contractId}`} className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing)}>
                {r.hotelName}
              </Link>
              <span className="block text-sm text-quiet">{r.city ?? 'City not recorded'}</span>
            </TableCell>
            <TableCell label="Supplier" className="align-top wrap-anywhere">
              {r.supplierName}
              {r.isMine ? <span className="block text-sm text-quiet">Entered by you</span> : r.enteredByName ? <span className="block text-sm text-quiet">Entered by {r.enteredByName}</span> : null}
            </TableCell>
            <TableCell label="Dates" className="align-top">
              {rangeText(r.validFrom, r.validTo)}
            </TableCell>
            <TableCell label="Rate lines" numeric className="align-top">
              {r.lineCount}
            </TableCell>
            <TableCell label="Status" className="align-top">
              <ContractStatusBadge status={r.status} daysLeft={r.daysLeft} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RateContractsLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Rate contracts</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading rate contracts…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
          <Skeleton className="h-10 w-full" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The read returned null: Sales, Flight, Visa or another company (same words whatever the reason). */
export function RateContractsNoAccess() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Rate contracts" />
      <Notice tone="locked" role="status" title="Not available to you">
        <p>Rate contracts are supplier costs. They are for Purchase, branch Managers and Accounts. Ask your admin if you need them.</p>
      </Notice>
    </div>
  );
}
