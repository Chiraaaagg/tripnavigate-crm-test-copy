import { ArrowLeft, Download, FileCode2, FileSpreadsheet, ListX } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { tallyExportCsvHref } from '@/modules/accounts-desk/contracts';
import { dayText, TALLY_KIND_LABEL, whenText } from '@/views/accounts-desk/labels';
import { ANY_KIND_LABEL, FILE_KIND_LABEL, leftOutHref, TALLY_PATH, tallyXmlHref } from './labels';
import { LeftOutTable } from './make-file';
import type { TallyFileHeader, TallyLeftOutPage } from './types';

/*
 * Accounts › Tally: the list of files made (R-C1 with the Phase 3 keys:
 * format, left-out count, include-again reason) and the left-out list of one
 * file (R-C3, keyset pages). XML files download from the audited route;
 * CSV exports keep their Phase 1 download. Accounts only.
 */

export function TallyFilesList({ files }: { files: TallyFileHeader[] | 'error' }) {
  return (
    <Card>
      <section aria-labelledby="tally-files-h">
        <CardHeader>
          <CardTitle id="tally-files-h">Files made</CardTitle>
        </CardHeader>
        {files === 'error' ? (
          <CardBody>
            <Notice tone="warning" role="status" title="The list of files did not load">
              <p>Nothing was changed. Reload the page.</p>
            </Notice>
          </CardBody>
        ) : files.length === 0 ? (
          <CardBody>
            <EmptyState icon={FileSpreadsheet} title="No files yet" description="Each Tally file and CSV export appears here, so the same file can be downloaded again." />
          </CardBody>
        ) : (
          <Table label="Tally files and CSV exports" stackOnMobile>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Types</TableHead>
                <TableHead numeric>Entries</TableHead>
                <TableHead>
                  <span className="sr-only">Download</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f.exportId}>
                  <TableCell label="File">
                    <span className="flex flex-col items-start gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ink">{f.exportNo}</span>
                        <StatusBadge tone={f.format === 'xml' ? 'brand' : 'neutral'} icon={f.format === 'xml' ? FileCode2 : FileSpreadsheet}>
                          {f.format === 'xml' ? 'Tally file' : 'CSV export'}
                        </StatusBadge>
                      </span>
                      <span className="text-sm text-quiet">
                        {whenText(f.createdAt)}
                        {f.createdByName ? ` · ${f.createdByName}` : ''}
                      </span>
                      {f.format === 'xml' && f.companyName ? <span className="text-sm wrap-anywhere">Tally company: {f.companyName}</span> : null}
                      {f.includeReason ? <span className="text-sm wrap-anywhere">Included again: {f.includeReason}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell label="Dates">
                    {dayText(f.periodFrom)} to {dayText(f.periodTo)}
                  </TableCell>
                  <TableCell label="Types">{f.kinds.map((k) => (FILE_KIND_LABEL as Record<string, string>)[k] ?? (TALLY_KIND_LABEL as Record<string, string>)[k] ?? ANY_KIND_LABEL[k]).join(', ')}</TableCell>
                  <TableCell label="Entries" numeric>
                    <span className="flex flex-col items-end max-sm:items-start">
                      <span>{f.rowCount}</span>
                      {f.format === 'xml' && f.leftOutCount ? <span className="text-sm text-quiet">{f.leftOutCount} left out</span> : null}
                    </span>
                  </TableCell>
                  <TableCell label="Download">
                    <span className="flex flex-wrap gap-2">
                      {f.format === 'xml' ? (
                        <>
                          <a href={tallyXmlHref(f.exportId)} className={buttonVariants({ variant: 'secondary', size: 'sm' })} download>
                            <Download aria-hidden="true" />
                            Download XML<span className="sr-only"> {f.exportNo}</span>
                          </a>
                          {f.leftOutCount ? (
                            <Link href={leftOutHref(f.exportId)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                              <ListX aria-hidden="true" />
                              Left out<span className="sr-only"> of {f.exportNo}</span>
                            </Link>
                          ) : null}
                        </>
                      ) : (
                        <a href={tallyExportCsvHref(f.exportId)} className={buttonVariants({ variant: 'secondary', size: 'sm' })} download>
                          <Download aria-hidden="true" />
                          Download CSV<span className="sr-only"> {f.exportNo}</span>
                        </a>
                      )}
                    </span>
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

export function TallyLeftOutView({ page, after = null }: { page: TallyLeftOutPage | 'error'; after?: string | null }) {
  const back = (
    <Link href={TALLY_PATH} className={buttonVariants({ variant: 'secondary' })}>
      <ArrowLeft aria-hidden="true" />
      Back to Tally
    </Link>
  );
  if (page === 'error')
    return (
      <div className="font-sans">
        <PageHeader eyebrow="Accounts · Tally" title="Left out of the file" actions={back} />
        <Notice tone="warning" role="status" title="The list did not load">
          <p>Nothing was changed. Reload the page.</p>
        </Notice>
      </div>
    );
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <PageHeader eyebrow="Accounts · Tally" title={`Left out of ${page.exportNo}`} description="These records did not go into the file. Fix the reason, then make a new file for the same dates." actions={back} />
      {page.items.length === 0 ? (
        <Card>
          <EmptyState headingLevel={2} icon={ListX} title="Nothing was left out" description="Every record of this file's period went in." />
        </Card>
      ) : (
        <>
          <LeftOutTable rows={page.items} label={`Records left out of ${page.exportNo}`} />
          <div className="flex flex-wrap items-center gap-3">
            {page.hasMore && page.nextAfter ? (
              <Link href={leftOutHref(page.exportId, page.nextAfter)} className={buttonVariants({ variant: 'secondary' })}>
                Next page
              </Link>
            ) : (
              <p className="m-0 text-sm text-quiet">That is all.</p>
            )}
            {after ? (
              <Link href={leftOutHref(page.exportId)} className="text-sm font-semibold text-brand-strong underline underline-offset-4">
                Back to the first page
              </Link>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function TallyFileLoading() {
  return (
    <LoadingRegion label="Loading Tally">
      <h1 className="sr-only">Tally</h1>
      <Skeleton className="mb-2 h-8 w-40" />
      <Skeleton className="mb-5 h-4 w-80 max-w-full" />
      <Skeleton className="mb-5 h-64 w-full" />
      <Skeleton className="mb-5 h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </LoadingRegion>
  );
}
