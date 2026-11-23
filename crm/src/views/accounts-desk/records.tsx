import { Eye, FilterX, Inbox, Search, SearchX, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/field';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isEmptyFilter, MISSING_ORIGINALS_FILTER, recordsHref, referenceHint, RECORDS_PATH } from './address';
import { dayText, DEPARTMENT_LABEL, inr, KIND_FILTER_LABEL, KIND_LABEL, REVIEW_LABEL, STAGE_LABEL, TALLY_LABEL } from './labels';
import { RecordsTable, type LoadMoreAction } from './records-table';
import type { DeskRowActions, LinkTaskOption, LoadLinkTargets } from './row-actions';
import { RECORD_KINDS, TALLY_STATUSES, type DailyCheck, type DeskViewer, type RecordsFilter, type RecordsPage, type RecordsTotals } from './types';
import { Acc3DailyCheckItems } from './acc3-daily-check';
import type { DeskResult } from './desk-kit';
import { dailyCheckWaiting } from './r4-address';

/*
 * Accounts › Documents and money (contract 11.1). One read over every money
 * record and document of the company (Accounts) or of the Manager's branches
 * (view only). The search and filters are plain GET forms, so the address
 * keeps them, the back button works and nothing needs script. Totals are
 * read only when asked ("Show totals"). Look: the CRM table and filter
 * chips; 21st.dev "Flexi Filter Table" and "ReUI Filters" ideas only
 * (DESIGN-NOTES.md).
 *
 * UX redesign R4 (audit A5): the daily check is a fold that closes to one
 * line when nothing waits (open otherwise); each count is a link that
 * applies its filter; each row's status is one line (record-cells.tsx).
 */

export interface RecordsWorkspaceProps {
  viewer: DeskViewer;
  filter: RecordsFilter;
  page: RecordsPage | 'error';
  /** The database refused a filter (invalid_input): the field it named, or null. */
  invalidField?: string | null;
  /** undefined = not asked; null = not for this viewer. */
  totals?: RecordsTotals | 'error' | null;
  /** Accounts only (null for the Manager); 'error' = the read failed. */
  daily: DailyCheck | 'error' | null;
  suppliers: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  actions: DeskRowActions | null;
  loadMore: LoadMoreAction;
  /** Rendered after "Show more" without script: the cursor the page was opened with. */
  after?: string | null;
  linkOptions?: Record<string, LinkTaskOption[]>;
  loadLinkTargets?: LoadLinkTargets;
  previewOpen?: { rowId: string; dialog: 'match' | 'exception' | 'reopen' | 'link'; state?: DeskResult | null };
  /** R4 (D5): the Records tab strip, rendered under the header. */
  sectionTabs?: ReactNode;
}

function scopeLine(viewer: DeskViewer): string {
  return viewer.kind === 'accounts' ? `${viewer.entityName} · all branches` : `${viewer.branchNames.join(', ')} · view only`;
}

export function RecordsWorkspace(p: RecordsWorkspaceProps) {
  const { viewer, filter, page } = p;
  const readOnly = viewer.kind === 'manager';
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title="Documents and money"
        description={scopeLine(viewer)}
        status={
          readOnly ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-quiet">
              <Eye aria-hidden="true" className="size-4" />
              View only: you can see every record of your branch. Accounts make the changes.
            </span>
          ) : undefined
        }
      />
      {p.sectionTabs}
      {p.daily !== null ? <DailyCheckCard daily={p.daily} /> : null}
      <SearchBox filter={filter} />
      <FilterBar filter={filter} suppliers={p.suppliers} branches={p.branches} showBranch={p.branches.length > 1} />
      <ActiveChips filter={filter} suppliers={p.suppliers} branches={p.branches} />
      <section aria-labelledby="records-heading" className="mt-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="records-heading" className="m-0 text-lg font-semibold text-ink">
            {filter.q ? `Results for “${filter.q}”` : 'Records'}
            {page !== 'error' ? (
              <span className="text-sm font-normal text-quiet">
                {' · '}
                {page.items.length}
                {page.hasMore ? '+' : ''} {page.items.length === 1 && !page.hasMore ? 'record' : 'records'}
              </span>
            ) : null}
          </h2>
          {p.totals === undefined && page !== 'error' && page.items.length > 0 ? (
            <Link href={recordsHref(filter, { totals: '1' })} className={buttonVariants({ variant: 'secondary', size: 'sm' })} scroll={false}>
              Show totals
            </Link>
          ) : null}
        </div>
        {p.totals !== undefined && p.totals !== null ? <TotalsCard totals={p.totals} filter={filter} /> : null}
        {page === 'error' && p.invalidField !== undefined ? (
          <Notice tone="warning" role="alert" title="One of the filters is not valid">
            <p>Check the {p.invalidField ? `“${p.invalidField}” filter` : 'filters'} above, or clear them all. Your other choices are kept.</p>
          </Notice>
        ) : page === 'error' ? (
          <Notice tone="warning" role="alert" title="The records could not be loaded">
            <p>Nothing was changed. Reload the page to try again.</p>
          </Notice>
        ) : page.items.length === 0 ? (
          <NoRecords filter={filter} />
        ) : (
          <>
            {p.after ? (
              <p className="m-0 text-sm text-quiet">
                Showing older records.{' '}
                <Link href={recordsHref(filter)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                  Back to the newest
                </Link>
              </p>
            ) : null}
            <RecordsTable
              first={page}
              actions={readOnly ? null : p.actions}
              loadMore={p.loadMore}
              moreHref={page.hasMore && page.nextAfter ? recordsHref(filter, { after: page.nextAfter }) : null}
              linkOptions={p.linkOptions}
              loadLinkTargets={p.loadLinkTargets}
              previewOpen={p.previewOpen}
              branches={p.branches}
            />
          </>
        )}
      </section>
    </div>
  );
}

function NoRecords({ filter }: { filter: RecordsFilter }) {
  if (filter.q) {
    return (
      <EmptyState
        icon={SearchX}
        title={`Nothing has the reference “${filter.q}”`}
        description="Search finds exact references only: receipt (R-…), supplier payment (SP-…), deal (BX-…), invoice number, PNR, ticket number, visa or GST invoice reference. Check the spelling, or clear the search."
        action={
          <Link href={RECORDS_PATH} className={buttonVariants({ variant: 'secondary' })}>
            Clear the search
          </Link>
        }
      />
    );
  }
  if (!isEmptyFilter(filter)) {
    return (
      <EmptyState
        icon={FilterX}
        title="No records match these filters"
        description="Remove a filter above, or clear them all."
        action={
          <Link href={RECORDS_PATH} className={buttonVariants({ variant: 'secondary' })}>
            Clear all filters
          </Link>
        }
      />
    );
  }
  return <EmptyState icon={Inbox} title="No money records yet" description="Receipts, supplier payments, bills and the rest appear here as soon as they are recorded." />;
}

/* ---------- Daily check (contract 8.2) ---------- */

function DailyCheckCard({ daily }: { daily: DailyCheck | 'error' }) {
  const waiting = daily === 'error' ? null : dailyCheckWaiting(daily);
  const meta = waiting === null ? 'Could not be loaded' : waiting === 0 ? 'Nothing waiting' : `${waiting} to look at`;
  return (
    <section aria-label="Daily check" className="mb-5">
      <Fold id="daily-check" summary="Daily check" meta={meta} open={waiting !== 0}>
        <div className="flex flex-col gap-3">
          {daily === 'error' ? (
            <p className="m-0 text-copy">The daily check could not be loaded. The list below is not affected.</p>
          ) : (
            <>
              <p className="m-0 text-copy">
                <span className="font-medium text-quiet">Exception owner: </span>
                {daily.exceptionOwner.set ? (
                  <>
                    <strong className="text-ink">{daily.exceptionOwner.isYou ? 'You' : (daily.exceptionOwner.name ?? 'An Accounts colleague')}</strong>
                    {daily.exceptionOwner.isYou ? ' — you get the Tally exception notices and run this check.' : ' gets the Tally exception notices and runs this check.'}
                  </>
                ) : (
                  <>
                    <strong className="text-ink">No exception owner set.</strong> Every Accounts person gets the Tally exception notices. A Super Admin sets the owner in Settings · Accounts.
                  </>
                )}
              </p>
              <p className="m-0 text-sm text-quiet">Each count opens the matching records.</p>
              <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3" aria-label="Daily check counts">
                <CheckItem n={daily.exceptionsOpen.count} text="Tally exceptions open" href={recordsHref(daily.filters?.exceptionsOpen ?? { tallyStatus: 'exception' })} extra={daily.exceptionsOpen.oldestAt ? `oldest ${dayText(daily.exceptionsOpen.oldestAt)}` : undefined} />
                <CheckItem n={daily.changedAfterExport} text="Changed after export" href={recordsHref(daily.filters?.changedAfterExport ?? { changedSinceExport: true })} />
                <CheckItem n={daily.originalsMissing} text="Originals missing" href={recordsHref(daily.filters?.originalsMissing ?? MISSING_ORIGINALS_FILTER)} />
                <CheckItem n={daily.receiptsAwaitingVerificationOverOneWorkingDay} text="Receipts waiting over one working day to be verified" href={recordsHref(daily.filters?.receiptsAwaitingVerificationOverOneWorkingDay ?? { overdueCheck: 'receipts_unverified' })} />
                <CheckItem n={daily.paymentsApprovedNotRecordedOverOneWorkingDay} text="Supplier payments approved but not recorded for over one working day" href={recordsHref(daily.filters?.paymentsApprovedNotRecordedOverOneWorkingDay ?? { overdueCheck: 'payments_unrecorded' })} />
                {/* Accounts phase 2 (contract 13): shown when the database sends them. */}
                {daily.documentsToRelease !== undefined ? <CheckItem n={daily.documentsToRelease} text="Customer documents to release" href="/app/accounts/documents?toRelease=1" /> : null}
                {daily.pdfFailed !== undefined ? <CheckItem n={daily.pdfFailed} text="Document PDFs that failed" href="/app/accounts/documents?pdf=failed" /> : null}
                {daily.refundPayoutsDueOverOneWorkingDay !== undefined ? <CheckItem n={daily.refundPayoutsDueOverOneWorkingDay} text="Approved refunds not paid out for over one working day" href="/app/accounts/refunds#rf-payouts" /> : null}
                {daily.supplierRefundsDue !== undefined ? <CheckItem n={daily.supplierRefundsDue} text="Cancellations with supplier refunds still expected" href="/app/accounts/refunds#rf-supplier" /> : null}
                {/* Accounts phase 3 (contract 6.5): held bills, failed messages, unmatched Tally file entries, write-offs, queue age. */}
                <Acc3DailyCheckItems extra={daily} />
                <li className="m-0 rounded-control border border-line bg-canvas px-3 py-2">
                  <p className="m-0 text-sm text-copy">Urgent notices not opened for over one working day</p>
                  {daily.urgentNoticesUnopenedOverOneWorkingDay.length === 0 ? (
                    <p className="m-0 text-lg font-semibold text-ink tabular-nums">0</p>
                  ) : (
                    <ul className="m-0 list-none p-0 text-sm">
                      {daily.urgentNoticesUnopenedOverOneWorkingDay.map((b) => (
                        <li key={b.branchName} className="m-0">
                          <strong className="tabular-nums">{b.count}</strong> in {b.branchName}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              </ul>
            </>
          )}
        </div>
      </Fold>
    </section>
  );
}

function CheckItem({ n, text, href, extra }: { n: number; text: string; href: string; extra?: string }) {
  return (
    <li className="m-0">
      <Link href={href} className={cn('flex h-full flex-col rounded-control border border-line bg-canvas px-3 py-2 no-underline hover:bg-wash', focusRing)}>
        <span className="text-sm text-copy">{text}</span>
        <span className="text-lg font-semibold text-ink tabular-nums">
          {n}
          {extra ? <span className="ml-1.5 text-sm font-normal text-quiet">({extra})</span> : null}
        </span>
      </Link>
    </li>
  );
}

/* ---------- Search and filters (GET forms: the address keeps them) ---------- */

function KeepFilters({ filter, omit }: { filter: RecordsFilter; omit: Array<keyof RecordsFilter> }) {
  const query = recordsHref(Object.fromEntries(Object.entries(filter).filter(([k]) => !omit.includes(k as keyof RecordsFilter))) as RecordsFilter).split('?')[1];
  if (!query) return null;
  return (
    <>
      {[...new URLSearchParams(query).entries()].map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

function SearchBox({ filter }: { filter: RecordsFilter }) {
  const hint = filter.q ? referenceHint(filter.q) : null;
  return (
    <search className="mb-4 block">
      <form action={RECORDS_PATH} method="get" role="search" aria-label="Find by reference" className="flex flex-col gap-1.5">
        {/* Search ignores the other filters except the branch (contract 8.1); the branch is kept. */}
        {filter.branchId ? <input type="hidden" name="branch" value={filter.branchId} /> : null}
        <Label htmlFor="records-q">Find by reference (R-, SP-, BX-, invoice number, PNR, ticket number, visa reference)</Label>
        <div className="flex flex-wrap gap-2">
          <Input id="records-q" name="q" type="search" defaultValue={filter.q ?? ''} maxLength={60} autoComplete="off" className="min-w-0 flex-1 basis-64" aria-describedby="records-q-hint" />
          <button type="submit" className={buttonVariants({ variant: 'primary' })}>
            <Search aria-hidden="true" />
            Find
          </button>
        </div>
        <p id="records-q-hint" className="m-0 text-sm text-quiet">
          {hint ? `${hint}. ` : ''}Exact references only, not names. A search ignores the filters below.
        </p>
      </form>
    </search>
  );
}

function FilterBar({ filter, suppliers, branches, showBranch }: { filter: RecordsFilter; suppliers: Array<{ id: string; name: string }>; branches: Array<{ id: string; name: string }>; showBranch: boolean }) {
  const kinds = new Set(filter.kinds ?? []);
  const { q: _q, ...rest } = filter;
  void _q;
  const anyOpen = !isEmptyFilter(rest);
  return (
    <details className="group rounded-card border border-line bg-card" open={anyOpen}>
      <summary className={cn('flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-card px-4.5 py-2.5 font-medium text-ink hover:bg-wash [&::-webkit-details-marker]:hidden', focusRing)}>
        <SlidersHorizontal aria-hidden="true" className="size-4 text-quiet" />
        Filters
        <span className="text-sm font-normal text-quiet">dates, record types, department, supplier, status, Tally, originals, amount{showBranch ? ', branch' : ''}</span>
      </summary>
      <form action={RECORDS_PATH} method="get" className="flex flex-col gap-4 border-t border-line px-4.5 py-4" aria-label="Filters">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FilterField id="f-from" label="From">
            <Input id="f-from" name="from" type="date" defaultValue={filter.from ?? ''} />
          </FilterField>
          <FilterField id="f-to" label="To">
            <Input id="f-to" name="to" type="date" defaultValue={filter.to ?? ''} />
          </FilterField>
          <FilterField id="f-dept" label="Department">
            <Select id="f-dept" name="department" defaultValue={filter.department ?? ''}>
              <option value="">Any</option>
              {(Object.keys(DEPARTMENT_LABEL) as Array<keyof typeof DEPARTMENT_LABEL>).map((d) => (
                <option key={d} value={d}>
                  {DEPARTMENT_LABEL[d]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id="f-supplier" label="Supplier">
            <Select id="f-supplier" name="supplier" defaultValue={filter.supplierId ?? ''}>
              <option value="">Any</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id="f-stage" label="Stage">
            <Select id="f-stage" name="stage" defaultValue={filter.stage ?? ''}>
              <option value="">Any</option>
              {(Object.keys(STAGE_LABEL) as Array<keyof typeof STAGE_LABEL>).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id="f-review" label="Review">
            <Select id="f-review" name="review" defaultValue={filter.reviewStatus ?? ''}>
              <option value="">Any</option>
              {(Object.keys(REVIEW_LABEL) as Array<keyof typeof REVIEW_LABEL>).map((s) => (
                <option key={s} value={s}>
                  {REVIEW_LABEL[s]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id="f-tally" label="Tally status">
            <Select id="f-tally" name="tally" defaultValue={filter.tallyStatus ?? ''}>
              <option value="">Any</option>
              {TALLY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TALLY_LABEL[s]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id="f-originals" label="Originals">
            <Select id="f-originals" name="originals" defaultValue={filter.originals ?? ''}>
              <option value="">Don’t filter</option>
              <option value="missing">Missing</option>
              <option value="expected">Expected</option>
              <option value="any">Missing or expected</option>
            </Select>
          </FilterField>
          <FilterField id="f-min" label="Amount from (₹)">
            <Input id="f-min" name="min" inputMode="numeric" pattern="[0-9]*" defaultValue={filter.amountMin ? (BigInt(filter.amountMin) / 100n).toString() : ''} />
          </FilterField>
          <FilterField id="f-max" label="Amount up to (₹)">
            <Input id="f-max" name="max" inputMode="numeric" pattern="[0-9]*" defaultValue={filter.amountMax ? (BigInt(filter.amountMax) / 100n).toString() : ''} />
          </FilterField>
          {showBranch ? (
            <FilterField id="f-branch" label="Branch">
              <Select id="f-branch" name="branch" defaultValue={filter.branchId ?? ''}>
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </FilterField>
          ) : null}
          <FilterField id="f-deal" label="Deal reference">
            <Input id="f-deal" name="deal" defaultValue={filter.dealReference ?? ''} maxLength={40} autoComplete="off" />
          </FilterField>
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1.5 text-sm font-semibold text-ink">Record types</legend>
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0">
            {RECORD_KINDS.map((k) => (
              <li key={k} className="m-0">
                <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
                  <input type="checkbox" name="kinds" value={k} defaultChecked={kinds.has(k)} className="size-4 accent-brand-strong" />
                  {KIND_FILTER_LABEL[k]}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
          <input type="checkbox" name="changed" value="yes" defaultChecked={!!filter.changedSinceExport} className="size-4 accent-brand-strong" />
          Only records changed since their last export
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonVariants({ variant: 'secondary' })}>
            Apply filters
          </button>
          <Link href={recordsHref(MISSING_ORIGINALS_FILTER)} className={buttonVariants({ variant: 'ghost' })}>
            Missing originals
          </Link>
        </div>
      </form>
    </details>
  );
}

function FilterField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** Active filters as chips; each chip removes its filter (a link), plus "Clear all". */
function ActiveChips({ filter, suppliers, branches }: { filter: RecordsFilter; suppliers: Array<{ id: string; name: string }>; branches: Array<{ id: string; name: string }> }) {
  const chips: Array<{ key: string; text: string; href: string }> = [];
  const without = (patch: Partial<RecordsFilter>) => recordsHref({ ...filter, ...patch });
  if (filter.q) chips.push({ key: 'q', text: `Reference: ${filter.q}`, href: without({ q: undefined }) });
  if (filter.from) chips.push({ key: 'from', text: `From ${dayText(filter.from)}`, href: without({ from: undefined }) });
  if (filter.to) chips.push({ key: 'to', text: `To ${dayText(filter.to)}`, href: without({ to: undefined }) });
  for (const k of filter.kinds ?? []) chips.push({ key: `kind-${k}`, text: KIND_LABEL[k], href: without({ kinds: (filter.kinds ?? []).filter((x) => x !== k) }) });
  if (filter.department) chips.push({ key: 'dept', text: DEPARTMENT_LABEL[filter.department], href: without({ department: undefined }) });
  if (filter.supplierId) chips.push({ key: 'sup', text: `Supplier: ${suppliers.find((s) => s.id === filter.supplierId)?.name ?? 'chosen supplier'}`, href: without({ supplierId: undefined }) });
  if (filter.stage) chips.push({ key: 'stage', text: `Stage: ${STAGE_LABEL[filter.stage]}`, href: without({ stage: undefined }) });
  if (filter.reviewStatus) chips.push({ key: 'review', text: `Review: ${REVIEW_LABEL[filter.reviewStatus]}`, href: without({ reviewStatus: undefined }) });
  if (filter.tallyStatus) chips.push({ key: 'tally', text: `Tally: ${TALLY_LABEL[filter.tallyStatus]}`, href: without({ tallyStatus: undefined }) });
  if (filter.changedSinceExport) chips.push({ key: 'changed', text: 'Changed since export', href: without({ changedSinceExport: undefined }) });
  if (filter.originals) chips.push({ key: 'orig', text: filter.originals === 'any' ? 'Originals missing or expected' : `Originals ${filter.originals}`, href: without({ originals: undefined }) });
  if (filter.amountMin) chips.push({ key: 'min', text: `From ${inr(filter.amountMin)}`, href: without({ amountMin: undefined }) });
  if (filter.amountMax) chips.push({ key: 'max', text: `Up to ${inr(filter.amountMax)}`, href: without({ amountMax: undefined }) });
  if (filter.branchId) chips.push({ key: 'branch', text: `Branch: ${branches.find((b) => b.id === filter.branchId)?.name ?? 'chosen branch'}`, href: without({ branchId: undefined }) });
  if (filter.dealReference) chips.push({ key: 'deal', text: `Deal ${filter.dealReference}`, href: without({ dealReference: undefined }) });
  if (chips.length === 0) return null;
  return (
    <nav aria-label="Active filters" className="mt-3">
      <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
        {chips.map((c) => (
          <li key={c.key} className="m-0">
            <Link href={c.href} className={cn('inline-flex min-h-9 items-center gap-1.5 rounded-control border border-brand-line bg-brand-tint px-3 py-1 text-sm font-medium text-brand-strong no-underline hover:bg-brand-tint-2', focusRing)}>
              {c.text}
              <X aria-hidden="true" className="size-3.5" />
              <span className="sr-only">: remove this filter</span>
            </Link>
          </li>
        ))}
        <li className="m-0">
          <Link href={RECORDS_PATH} className={cn('inline-flex min-h-9 items-center rounded-chip px-2 text-sm font-semibold text-brand-strong underline underline-offset-4', focusRing)}>
            Clear all
          </Link>
        </li>
      </ul>
    </nav>
  );
}

function TotalsCard({ totals, filter }: { totals: RecordsTotals | 'error'; filter: RecordsFilter }) {
  if (totals === 'error') {
    return (
      <Notice tone="warning" role="status">
        <p>The totals could not be worked out just now. The list is not affected.</p>
      </Notice>
    );
  }
  return (
    <Card>
      <section aria-labelledby="totals-heading">
        <CardHeader>
          <CardTitle id="totals-heading" level={3}>
            Totals for these filters: {totals.count} {totals.count === 1 ? 'record' : 'records'}
          </CardTitle>
          <Link href={recordsHref(filter)} className={cn('rounded-chip text-sm font-medium text-brand-strong underline underline-offset-4', focusRing)} scroll={false}>
            Hide totals
          </Link>
        </CardHeader>
        <Table label="Totals by record type" stackOnMobile>
          <TableHeader>
            <TableRow>
              <TableHead>Record type</TableHead>
              <TableHead numeric>Records</TableHead>
              <TableHead numeric>Money in</TableHead>
              <TableHead numeric>Money out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {totals.byKind.map((k) => (
              <TableRow key={k.kind}>
                <TableCell label="Record type">{KIND_FILTER_LABEL[k.kind]}</TableCell>
                <TableCell label="Records" numeric>
                  {k.count}
                </TableCell>
                <TableCell label="Money in" numeric>
                  {inr(k.inPaise)}
                </TableCell>
                <TableCell label="Money out" numeric>
                  {inr(k.outPaise)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="m-0 px-4.5 py-3 text-sm text-quiet">Reported payments are not money and are never counted in money in. Bills and credit notes are not money out.</p>
      </section>
    </Card>
  );
}

export function RecordsLoading() {
  return (
    <LoadingRegion label="Loading documents and money">
      <h1 className="sr-only">Documents and money</h1>
      <Skeleton className="mb-2 h-8 w-64" />
      <Skeleton className="mb-5 h-4 w-48" />
      <Skeleton className="mb-4 h-24 w-full" />
      <Skeleton className="mb-4 h-11 w-full" />
      <Skeleton className="h-64 w-full" />
    </LoadingRegion>
  );
}

/** The Manager or anyone else without access (the read returned null). */
export function RecordsNoAccess() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Documents and money" />
      <Notice tone="restricted" title="Not available for your role">
        <p>Documents and money is for Accounts and for branch Managers (view only). Purchase, Flight and Visa work shows on their own task pages.</p>
      </Notice>
    </div>
  );
}

export { KeepFilters };
