import { Download, FileSpreadsheet, TableProperties } from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from './desk-kit';
import { dayText, TALLY_KIND_LABEL, whenText } from './labels';
import { RecordsTable, type LoadMoreAction } from './records-table';
import type { DeskRowActions, LoadLinkTargets } from './row-actions';
import { tallyExportCsvHref } from '@/modules/accounts-desk/contracts';
import { TallyExportForm } from './tally-export-form';
import type { TallyPageView } from './types';

export const TALLY_MAPPING_HREF = '/app/admin/accounts/tally-mapping';

/*
 * Accounts › Tally (contract 7.2, 11.3), Accounts only: the export form (an
 * evidence CSV, not a Tally import), past exports with re-download (each
 * download is recorded; a re-download gives the same file), and the open
 * Tally exceptions with the exception owner named first.
 */

export function TallyPage({
  view,
  exportAction,
  rowActions,
  loadMoreExceptions,
  loadLinkTargets,
  exportInitialState,
  fileSections,
}: {
  /** Accounts phase 3 (screen 15.7): "Make Tally file", the XML files and "Upload Tally vouchers", shown first. */
  fileSections?: ReactNode;
  view: TallyPageView;
  exportAction: DecisionAction;
  rowActions: DeskRowActions;
  loadMoreExceptions: LoadMoreAction;
  loadLinkTargets?: LoadLinkTargets;
  exportInitialState?: DeskResult | null;
}) {
  const owner = view.daily?.exceptionOwner;
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title="Tally"
        description="Export records for Tally and keep track of matching. Tally stays the official accounts; the CRM never connects to it."
        actions={
          // Accounts phase 2 (contract 8.1, 11.11): the ledger names each CSV line carries.
          <Link href={TALLY_MAPPING_HREF} className={buttonVariants({ variant: 'secondary' })}>
            <TableProperties aria-hidden="true" />
            Tally ledger mapping
          </Link>
        }
      />
      <div className="flex flex-col gap-5">
        {fileSections}
        <Card>
          <CardBody>
            {view.exportEnabled ? (
              <TallyExportForm entities={view.entities} branches={view.branches} action={exportAction} initialState={exportInitialState} />
            ) : (
              <Notice tone="locked" title="Tally export is not switched on yet.">
                <p>A Super Admin switches it on in Settings · Accounts. Matching and exceptions below still work.</p>
              </Notice>
            )}
          </CardBody>
        </Card>

        <Card>
          <section aria-labelledby="exports-heading">
            <CardHeader>
              <CardTitle id="exports-heading">Past exports</CardTitle>
            </CardHeader>
            {view.exports.length === 0 ? (
              <CardBody>
                <EmptyState icon={FileSpreadsheet} title="No exports yet" description="Each export appears here with its rows, so the same file can be downloaded again." />
              </CardBody>
            ) : (
              <Table label="Past Tally exports" stackOnMobile>
                <TableHeader>
                  <TableRow>
                    <TableHead>Export</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Record types</TableHead>
                    <TableHead numeric>Rows</TableHead>
                    <TableHead>
                      <span className="sr-only">Download</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.exports.map((e) => (
                    <TableRow key={e.exportId}>
                      <TableCell label="Export">
                        <span className="flex flex-col">
                          <span className="font-semibold text-ink">{e.exportNo}</span>
                          <span className="text-sm text-quiet">
                            {whenText(e.createdAt)}
                            {e.createdByName ? ` · ${e.createdByName}` : ''}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell label="Dates">
                        {dayText(e.periodFrom)} to {dayText(e.periodTo)}
                      </TableCell>
                      <TableCell label="Record types">{e.kinds.map((k) => TALLY_KIND_LABEL[k]).join(', ')}</TableCell>
                      <TableCell label="Rows" numeric>
                        {e.rowCount}
                      </TableCell>
                      <TableCell label="Download">
                        <a href={tallyExportCsvHref(e.exportId)} className={buttonVariants({ variant: 'secondary', size: 'sm' })} download>
                          <Download aria-hidden="true" />
                          Download CSV<span className="sr-only"> {e.exportNo}</span>
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </Card>

        <section aria-labelledby="exceptions-heading" className="flex flex-col gap-3">
          <h2 id="exceptions-heading" className="m-0 text-lg font-semibold text-ink">
            Open exceptions
          </h2>
          <p className="m-0 text-copy">
            {owner?.set ? (
              <>
                Exception owner: <strong className="text-ink">{owner.isYou ? 'you' : (owner.name ?? 'an Accounts colleague')}</strong>.
              </>
            ) : (
              <>No exception owner set: every Accounts person gets the exception notices.</>
            )}
          </p>
          {view.exceptions.length === 0 ? (
            <p className="m-0 rounded-card border border-line bg-card px-4.5 py-4 text-copy">No open exceptions.</p>
          ) : (
            <RecordsTable first={{ scope: { mode: 'accounts', readOnly: false }, items: view.exceptions, nextAfter: view.exceptionsNextAfter ?? null, hasMore: !!view.exceptionsNextAfter }} actions={rowActions} loadMore={loadMoreExceptions} moreHref={null} loadLinkTargets={loadLinkTargets} />
          )}
        </section>
      </div>
    </div>
  );
}

export function TallyLoading() {
  return (
    <LoadingRegion label="Loading Tally">
      <h1 className="sr-only">Tally</h1>
      <Skeleton className="mb-2 h-8 w-40" />
      <Skeleton className="mb-5 h-4 w-80" />
      <Skeleton className="mb-5 h-56 w-full" />
      <Skeleton className="h-40 w-full" />
    </LoadingRegion>
  );
}

export function TallyNoAccess() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Tally" />
      <Notice tone="restricted" title="For Accounts only">
        <p>Tally exports and matching are done by Accounts.</p>
      </Notice>
    </div>
  );
}
