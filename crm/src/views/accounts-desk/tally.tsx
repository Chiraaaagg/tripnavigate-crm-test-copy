import { Download, FileSpreadsheet, TableProperties } from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StateBlock } from '@/components/ui/state-block';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from './desk-kit';
import { recordsHref } from './address';
import { dayText, TALLY_KIND_LABEL, whenText } from './labels';
import { TALLY_METHOD_LABEL, tallyMethodHref, tallyMethodsOn, type TallyMethod } from './r4-address';
import { tallyExportCsvHref } from '@/modules/accounts-desk/contracts';
import { TallyExportForm } from './tally-export-form';
import type { TallyExportHeader, TallyPageView } from './types';

export const TALLY_MAPPING_HREF = '/app/admin/accounts/tally-mapping';

/*
 * Accounts › Tally (contract 7.2, 11.3; Accounts phase 3 screen 15.7),
 * Accounts only. Two methods do the same job: the Tally file (XML import,
 * with "Upload Tally vouchers" to match) and the CSV export (an evidence
 * file, not a Tally import).
 *
 * UX redesign R4 (owner answer D11, audit A6): only the switched-on method
 * shows; when both are on, two pill tabs ("Tally file", "CSV export",
 * ?method=). Files made earlier with a method that is now switched off stay
 * reachable in a closed fold below. Open exceptions are worked in Documents
 * and money (Records), so this page shows their count and a link there.
 */

/** The Phase 1 view without the exceptions list (R4: exceptions are worked in Records). */
export type TallyCsvView = Omit<TallyPageView, 'exceptions' | 'exceptionsNextAfter'>;

export function TallyPage({
  view,
  method,
  fileOn,
  fileSections,
  earlierFiles,
  exportAction,
  exportInitialState,
  sectionTabs,
}: {
  view: TallyCsvView;
  /** The method shown (r4-address.ts tallyMethodFrom); null when both are switched off. */
  method: TallyMethod | null;
  /** accounts_settings.tally_xml_enabled for at least one company. */
  fileOn: boolean;
  /** "Make Tally file", "Files made" and "Upload Tally vouchers" (views/tally-file/sections.tsx), shown on the Tally file method. */
  fileSections?: ReactNode;
  /** While the Tally file method is off: the files made earlier and the voucher upload (views/tally-file/sections.tsx TallyEarlierFiles), in a fold. */
  earlierFiles?: ReactNode;
  exportAction: DecisionAction;
  exportInitialState?: DeskResult | null;
  /** R4 (D5): the Tally tab strip, rendered under the header. */
  sectionTabs?: ReactNode;
}) {
  const on = { file: fileOn, csv: view.exportEnabled };
  const methods = tallyMethodsOn(on);
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title="Tally"
        description="Send checked money records to Tally and keep track of matching. Tally stays the official accounts; the CRM never connects to it."
        actions={
          // Accounts phase 2 (contract 8.1, 11.11): the ledger names each line carries.
          <Link href={TALLY_MAPPING_HREF} className={buttonVariants({ variant: 'secondary' })}>
            <TableProperties aria-hidden="true" />
            Tally ledger mapping
          </Link>
        }
      />
      {sectionTabs}
      <div className="flex flex-col gap-5">
        {methods.length > 1 ? (
          <Tabs variant="pill" label="Tally method" items={methods.map((m) => ({ href: tallyMethodHref(m), label: TALLY_METHOD_LABEL[m], current: m === method }))} />
        ) : null}
        {method === null ? (
          <StateBlock kind="off" title="The Tally file and the CSV export are both switched off" text="A Super Admin switches one of them on in Settings · Accounts. Files made earlier are below." />
        ) : null}
        {method === 'file' ? fileSections : null}
        {method === 'csv' ? (
          <>
            <Card>
              <CardBody>
                <TallyExportForm entities={view.entities} branches={view.branches} action={exportAction} initialState={exportInitialState} />
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
                  <PastExportsTable exports={view.exports} />
                )}
              </section>
            </Card>
          </>
        ) : null}
        {!on.file && earlierFiles ? (
          <Fold summary="Earlier Tally files and voucher upload" meta="Tally file is switched off">
            {earlierFiles}
          </Fold>
        ) : null}
        {!on.csv && view.exports.length > 0 ? (
          <Fold summary="Earlier CSV exports" meta="CSV export is switched off" bodyClassName="px-0 py-0">
            <PastExportsTable exports={view.exports} />
          </Fold>
        ) : null}
        <ExceptionsLine daily={view.daily} />
      </div>
    </div>
  );
}

function PastExportsTable({ exports }: { exports: TallyExportHeader[] }) {
  return (
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
        {exports.map((e) => (
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
  );
}

/** Open exceptions: the count from the daily check and a link to Documents and money, where they are worked. */
function ExceptionsLine({ daily }: { daily: TallyCsvView['daily'] }) {
  const owner = daily?.exceptionOwner;
  const href = recordsHref(daily?.filters?.exceptionsOpen ?? { tallyStatus: 'exception' });
  const count = daily?.exceptionsOpen.count;
  return (
    <section aria-labelledby="exceptions-heading" className="flex flex-col gap-1.5 rounded-card border border-line bg-card px-4.5 py-3">
      <h2 id="exceptions-heading" className="m-0 text-base font-semibold text-ink">
        Open exceptions
        {typeof count === 'number' ? <span className="font-normal text-quiet">{` · ${count}`}</span> : null}
      </h2>
      <p className="m-0 text-copy">
        {typeof count === 'number' && count === 0 ? 'No open exceptions. ' : 'Exceptions are worked in Documents and money. '}
        <Link href={href} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
          {typeof count === 'number' && count === 0 ? 'Open Documents and money' : 'Open the exceptions'}
        </Link>
      </p>
      <p className="m-0 text-sm text-quiet">
        {owner?.set ? (
          <>
            Exception owner: <strong className="text-ink">{owner.isYou ? 'you' : (owner.name ?? 'an Accounts colleague')}</strong>.
          </>
        ) : (
          <>No exception owner set: every Accounts person gets the exception notices.</>
        )}
      </p>
    </section>
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
