import { FileSearch, FileText, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn, focusRing } from '@/components/ui/cn';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { docFilterQuery, DOCS_PATH, isEmptyFilter } from './filter';
import { autoStateWords, documentStatusLines, holdReasonWords, KIND_TITLE, PDF_STATE_WORDS, rowTone, STATUS_FILTER_LABEL } from './labels';
import type { DocListPage, DocListRow, DocsFilter, DocsListViewer } from './types';

/*
 * Accounts › Customer documents (contract 6.9 R-B3, screen 11.2): every
 * customer document of the company (Accounts) or of the Manager's branches
 * (read only), newest first, keyset pages. Quick views as chip links ("To
 * release", "Drafts", "Booking changed", "Payment reversed", "PDF failed"),
 * the rest in a plain GET filter form, so the address keeps every filter and
 * nothing needs script. Work happens on the Deal page's Customer documents
 * card; each row links there.
 *
 * Accounts phase 3 (contract 6.5, screen 5): with `autoBills` set, Accounts
 * get the "Bills to check" quick view (held automatic drafts, oldest first,
 * each with its reasons) and an "Automatic drafts" filter. Without the prop
 * the page is exactly the Phase 2 page.
 */

const QUICK: Array<{ id: string; label: string; filter: DocsFilter }> = [
  { id: 'all', label: 'All', filter: {} },
  { id: 'toCheck', label: 'Bills to check', filter: { preset: 'toCheck' } },
  { id: 'toRelease', label: 'To release', filter: { toRelease: true } },
  { id: 'drafts', label: 'Drafts', filter: { status: ['draft'] } },
  { id: 'changed', label: 'Booking changed', filter: { bookingChanged: true } },
  { id: 'reversed', label: 'Payment reversed', filter: { paymentReversed: true } },
  { id: 'pdfFailed', label: 'PDF failed', filter: { pdfState: 'failed' } },
];

export function DocumentsListView({
  viewer,
  filter,
  page,
  branches = [],
  after = null,
  autoBills,
}: {
  viewer: DocsListViewer;
  filter: DocsFilter;
  page: DocListPage | 'error';
  branches?: Array<{ id: string; name: string }>;
  after?: string | null;
  /** Accounts phase 3: automatic bill drafts are on for the company (shows "Bills to check"). Absent = Phase 2 page. */
  autoBills?: boolean;
}) {
  const manager = viewer.kind === 'manager';
  const checking = !manager && filter.preset === 'toCheck';
  const current = docFilterQuery(filter);
  const quick = QUICK.find((q) => docFilterQuery(q.filter) === current)?.id ?? null;
  const advanced = !quick;
  return (
    <div className="flex flex-col gap-5 font-sans">
      <PageHeader
        eyebrow="Accounts"
        title={checking ? 'Bills to check' : 'Customer documents'}
        description={
          manager
            ? `Released documents of ${viewer.branchNames.join(', ') || 'your branches'}. View only: Accounts release, replace and cancel them.`
            : checking
              ? 'Drafts the CRM made but did not release, because a check did not pass. Oldest first. Fix the reason on the Deal; the CRM checks again by itself. Nothing is sent to customers.'
              : `Advance Invoices, Invoices and Credit Notes of ${viewer.entityName}. Work on each one from its Accounts deal page (Documents tab).`
        }
        status={
          manager ? (
            <StatusBadge tone="neutral" wrap>
              View only
            </StatusBadge>
          ) : null
        }
      />
      <nav aria-label="Quick views">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {QUICK.filter((q) => !(manager && (q.id === 'toRelease' || q.id === 'drafts' || q.id === 'toCheck')) && (q.id !== 'toCheck' || !!autoBills || checking)).map((q) => (
            <li key={q.id} className="m-0">
              <Link
                href={`${DOCS_PATH}${docFilterQuery(q.filter)}`}
                aria-current={quick === q.id ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-9 items-center rounded-control border px-3 py-1 text-sm font-medium no-underline',
                  quick === q.id ? 'border-brand-strong bg-brand-strong text-white hover:bg-brand-deep hover:text-white' : 'border-line-strong bg-card text-ink hover:bg-wash hover:text-ink',
                  focusRing,
                )}
              >
                {quick === q.id ? <span className="sr-only">Current view: </span> : null}
                {q.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <details className="rounded-card border border-line bg-card" open={advanced}>
        <summary className="cursor-pointer px-4 py-3 font-semibold text-ink">More filters{advanced ? ' (in use)' : ''}</summary>
        <form method="get" action={DOCS_PATH} className="grid grid-cols-1 gap-4 border-t border-line px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field htmlFor="f-deal" label="Deal reference" optional>
            <Input id="f-deal" name="deal" defaultValue={filter.dealReference ?? ''} maxLength={40} autoComplete="off" spellCheck={false} />
          </Field>
          <Field htmlFor="f-kind" label="Type" optional>
            <Select id="f-kind" name="kind" defaultValue={filter.kind?.[0] ?? ''}>
              <option value="">Any type</option>
              {(Object.keys(KIND_TITLE) as Array<keyof typeof KIND_TITLE>).map((k) => (
                <option key={k} value={k}>
                  {KIND_TITLE[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field htmlFor="f-status" label="Status" optional>
            <Select id="f-status" name="status" defaultValue={filter.status?.[0] ?? ''}>
              <option value="">Any status</option>
              {(Object.keys(STATUS_FILTER_LABEL) as Array<keyof typeof STATUS_FILTER_LABEL>)
                .filter((s) => !manager || (s !== 'draft' && s !== 'discarded'))
                .map((s) => (
                  <option key={s} value={s}>
                    {STATUS_FILTER_LABEL[s]}
                  </option>
                ))}
            </Select>
          </Field>
          {autoBills !== undefined && !manager ? (
            <Field htmlFor="f-auto" label="Automatic drafts" optional>
              <Select id="f-auto" name="auto" defaultValue={filter.autoState ?? ''}>
                <option value="">Any draft</option>
                <option value="held">Held — a check did not pass</option>
                <option value="ready">Checks passed</option>
              </Select>
            </Field>
          ) : null}
          <Field htmlFor="f-tally" label="Tally GST invoice number" optional>
            <Select id="f-tally" name="tally" defaultValue={filter.tallyLinked === undefined ? '' : filter.tallyLinked ? '1' : '0'}>
              <option value="">Linked or not</option>
              <option value="1">Linked</option>
              <option value="0">Not linked</option>
            </Select>
          </Field>
          <Field htmlFor="f-from" label="Released from" optional>
            <Input id="f-from" name="from" type="date" defaultValue={filter.from ?? ''} />
          </Field>
          <Field htmlFor="f-to" label="Released to" optional>
            <Input id="f-to" name="to" type="date" defaultValue={filter.to ?? ''} />
          </Field>
          {branches.length > 1 ? (
            <Field htmlFor="f-branch" label="Branch" optional>
              <Select id="f-branch" name="branch" defaultValue={filter.branchId ?? ''}>
                <option value="">Every branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" variant="secondary">
              Show documents
            </Button>
            {!isEmptyFilter(filter) ? (
              <Link href={DOCS_PATH} className={buttonVariants({ variant: 'ghost' })}>
                Clear all
              </Link>
            ) : null}
          </div>
        </form>
      </details>

      {page === 'error' ? (
        <Notice tone="warning" role="status" title="The documents did not load">
          <p>Nothing was changed. Reload the page. If it keeps happening, tell the CRM team.</p>
        </Notice>
      ) : page.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={isEmptyFilter(filter) ? FileText : FileSearch}
            title={isEmptyFilter(filter) ? 'No customer documents yet' : checking ? 'No bills to check' : 'No documents match'}
            description={
              isEmptyFilter(filter)
                ? manager
                  ? 'Released documents of your branches will show here.'
                  : 'Documents are made on each Deal page once a payment is verified or the booking is approved.'
                : checking
                  ? 'Nothing is held. Every automatic draft passed its checks or has been released.'
                  : filter.toRelease
                    ? 'Nothing is waiting to be released.'
                    : 'Change or clear the filters.'
            }
            action={
              isEmptyFilter(filter) ? undefined : (
                <Link href={DOCS_PATH} className={buttonVariants({ variant: 'secondary' })}>
                  Clear all
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table label={checking ? 'Bills to check' : 'Customer documents'} stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Deal</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Total</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>PDF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((d) => (
                <DocRowView key={d.documentId} d={d} manager={manager} />
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-3">
            {page.hasMore && page.nextAfter ? (
              <Link href={`${DOCS_PATH}${docFilterQuery(filter, page.nextAfter)}`} className={buttonVariants({ variant: 'secondary' })}>
                Next page
              </Link>
            ) : (
              <p className="m-0 text-sm text-quiet">That is all for these filters.</p>
            )}
            {after ? (
              <Link href={`${DOCS_PATH}${docFilterQuery(filter)}`} className="text-sm font-semibold text-brand-strong underline underline-offset-4">
                Back to the newest
              </Link>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function DocRowView({ d, manager }: { d: DocListRow; manager: boolean }) {
  const lines = documentStatusLines(d);
  const title = KIND_TITLE[d.kind];
  const autoWords = d.status === 'draft' ? autoStateWords(d) : null;
  const made = !!d.autoRule;
  return (
    <TableRow>
      <TableCell label="Document">
        <span className="flex flex-col">
          <span className="text-sm text-quiet">{title}</span>
          <Link href={manager ? `/app/deals/${d.dealId}?tab=services#customer-documents` : `/app/accounts/deals/${d.dealId}?tab=documents`} className="font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:underline">
            {d.number ?? `${title} draft`}
            <span className="sr-only"> — open on the Deal page</span>
          </Link>
          {made ? <span className="text-sm text-quiet">Made by the CRM</span> : null}
        </span>
      </TableCell>
      <TableCell label="Deal">
        <span className="flex flex-col">
          <span className="font-medium wrap-anywhere text-ink">{d.dealReference}</span>
          <span className="text-sm text-quiet">{d.branchName}</span>
        </span>
      </TableCell>
      <TableCell label="Status">
        <span className="flex flex-wrap gap-1.5">
          <StatusBadge tone={rowTone(d)} wrap>
            {lines[0]}
          </StatusBadge>
          {lines.slice(1).map((l) => (
            <StatusBadge key={l} tone="warning" icon={TriangleAlert} wrap>
              {l}
            </StatusBadge>
          ))}
          {autoWords ? (
            <StatusBadge tone={d.autoState === 'held' ? 'warning' : 'success'} wrap>
              {autoWords}
            </StatusBadge>
          ) : null}
        </span>
        {d.status === 'draft' && d.autoState === 'held' && d.holdReasons?.length ? (
          <ul className="m-0 mt-1.5 flex list-disc flex-col gap-0.5 pl-5 text-sm text-copy">
            {d.holdReasons.map((code) => (
              <li key={code} className="m-0">
                {holdReasonWords(code)}
              </li>
            ))}
          </ul>
        ) : null}
      </TableCell>
      <TableCell label="Total" numeric>
        <span className="whitespace-nowrap">{inr(d.totalPaise)}</span>
      </TableCell>
      <TableCell label="Issued">
        <span className="whitespace-nowrap">{d.issueDate ? dayText(d.issueDate) : 'Not yet'}</span>
        {d.gstInvoiceNumber ? <span className="block text-sm text-quiet">Tally {d.gstInvoiceNumber}</span> : null}
      </TableCell>
      <TableCell label="PDF">
        {d.status === 'draft' || d.status === 'discarded' ? (
          <span className="text-sm">—</span>
        ) : (
          <span className="flex flex-col items-start gap-1 text-sm">
            {d.screenPdf === 'ready' && d.can.download ? (
              <a href={`/app/deals/${d.dealId}/documents/${d.documentId}/pdf`} className="font-semibold text-brand-strong underline underline-offset-4">
                Download PDF<span className="sr-only"> of {d.number ?? KIND_TITLE[d.kind]}</span>
              </a>
            ) : (
              <span>{d.screenPdf === 'none' || d.screenPdf === 'off' ? 'Not made yet' : d.screenPdf === 'failed' ? (manager ? 'PDF failed — Accounts can make it again on the Deal page' : 'PDF failed — make it again on the Deal page') : PDF_STATE_WORDS[d.screenPdf]}</span>
            )}
            {d.screenPdf !== 'ready' && d.can.printView ? (
              <Link href={`/app/deals/${d.dealId}/documents/${d.documentId}`} className="font-semibold text-brand-strong underline underline-offset-4">
                Print view<span className="sr-only"> of {d.number ?? KIND_TITLE[d.kind]}</span>
              </Link>
            ) : null}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

export function DocumentsListLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Customer documents</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading customer documents…
      </p>
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-7 w-64" />
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-control" />
          ))}
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

export function DocumentsNoAccess() {
  return (
    <div className="font-sans">
      <PageHeader title="Customer documents" />
      <Card>
        <CardBody>
          <p className="m-0">Customer documents are for Accounts and branch Managers. Ask your admin if you need them.</p>
        </CardBody>
      </Card>
    </div>
  );
}
