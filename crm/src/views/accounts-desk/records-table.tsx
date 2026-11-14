'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Notice } from '@/components/ui/notice';
import { DeskResultLine, type DeskResult } from './desk-kit';
import { AmountCell, DateCell, FilesCell, ReferenceCell, StatusCell, TallyCell, WhoCell } from './record-cells';
import { RowActions, type DeskRowActions, type LinkTaskOption, type LoadLinkTargets } from './row-actions';
import type { RecordRow, RecordsPage } from './types';

/*
 * The workspace table (contract 11.1): Date · Type · Reference and Deal ·
 * Department and supplier · Amount · Status and review · Tally · Files and
 * originals · Actions (Accounts only). Under 640 px rows become labelled
 * cards; otherwise the table scrolls inside its own labelled, focusable
 * region, never the page. "Show more" appends the next keyset page in place
 * (the address keeps the filters; without script the link opens that page).
 */

export type LoadMoreAction = (after: string) => Promise<RecordsPage | { error: string }>;

export function RecordsTable({
  first,
  actions,
  loadMore,
  moreHref,
  linkOptions,
  loadLinkTargets,
  previewOpen,
}: {
  first: RecordsPage;
  /** null = view only (branch Manager). */
  actions: DeskRowActions | null;
  loadMore: LoadMoreAction;
  /** No-script fallback for "Show more": the same list after the cursor. */
  moreHref: string | null;
  linkOptions?: Record<string, LinkTaskOption[]>;
  loadLinkTargets?: LoadLinkTargets;
  /** Preview gallery only: open one row's dialog with an answer on screen. */
  previewOpen?: { rowId: string; dialog: 'match' | 'exception' | 'reopen' | 'link'; state?: DeskResult | null };
}) {
  const [rows, setRows] = useState<RecordRow[]>(first.items);
  const [cursor, setCursor] = useState<string | null>(first.hasMore ? first.nextAfter : null);
  // After a command the server re-renders the page with a fresh first page: show it (appended rows are dropped).
  const [seenFirst, setSeenFirst] = useState(first);
  if (first !== seenFirst) {
    setSeenFirst(first);
    setRows(first.items);
    setCursor(first.hasMore ? first.nextAfter : null);
  }
  const [moreError, setMoreError] = useState<string | null>(null);
  const [result, setResult] = useState<DeskResult | null>(null);
  const [pending, start] = useTransition();
  const resultRef = useRef<HTMLDivElement>(null);
  const firstNewRow = useRef<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const showActions = actions !== null;

  const more = () => {
    if (!cursor || pending) return;
    start(async () => {
      try {
        const page = await loadMore(cursor);
        if ('error' in page) {
          setMoreError(page.error);
          return;
        }
        setMoreError(null);
        firstNewRow.current = rows.length;
        // Keyset pages never overlap; a row already shown (inserted meanwhile) is not repeated.
        const seen = new Set(rows.map((r) => r.rowId));
        const fresh = page.items.filter((x) => !seen.has(x.rowId));
        if (fresh.length === 0) {
          firstNewRow.current = null;
          requestAnimationFrame(() => countRef.current?.focus());
        }
        setRows((r) => [...r, ...fresh]);
        setCursor(page.hasMore ? page.nextAfter : null);
      } catch {
        setMoreError('The next rows could not be loaded. Try again.');
      }
    });
  };

  // After "Show more" renders: focus the first new row's link, else the count line (nothing new arrived).
  useEffect(() => {
    const idx = firstNewRow.current;
    if (idx === null) return;
    firstNewRow.current = null;
    const link = tableRef.current?.querySelectorAll<HTMLElement>('tbody tr')[idx]?.querySelector<HTMLElement>('a');
    if (link) link.focus();
    else countRef.current?.focus();
  }, [rows.length]);

  const onResult = (r: DeskResult & { ok: true }) => {
    setResult(r);
    requestAnimationFrame(() => resultRef.current?.focus());
  };

  return (
    <div className="flex flex-col gap-3">
      <div ref={resultRef} tabIndex={-1} className="outline-none">
        <DeskResultLine state={result} />
      </div>
      <div ref={tableRef}>
        <Table label="Documents and money records" stackOnMobile className="sm:min-w-[52rem]" wrapperClassName="rounded-card border border-line bg-card">
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Record and deal</TableHead>
              <TableHead>Department and supplier</TableHead>
              <TableHead numeric>Amount</TableHead>
              <TableHead>Status and Tally</TableHead>
              <TableHead>Files and originals</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.rowId}>
                <TableCell label="Date" className="align-top">
                  <DateCell row={row} />
                </TableCell>
                <TableCell label="Record" className="align-top sm:min-w-44">
                  <div className="flex flex-col items-start gap-2">
                    <ReferenceCell row={row} />
                    {/* Actions sit next to the reference so they never scroll out of view (review item 7). */}
                    {showActions ? (
                      <RowActions
                        row={row}
                        actions={actions}
                        linkOptions={linkOptions?.[row.rowId]}
                        loadLinkTargets={loadLinkTargets}
                        onResult={onResult}
                        initialOpen={previewOpen?.rowId === row.rowId ? previewOpen.dialog : null}
                        initialState={previewOpen?.rowId === row.rowId ? (previewOpen.state ?? null) : null}
                      />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell label="Department" className="align-top sm:min-w-32">
                  <WhoCell row={row} />
                </TableCell>
                <TableCell label="Amount" numeric className="align-top">
                  <AmountCell row={row} />
                </TableCell>
                <TableCell label="Status" className="align-top">
                  <div className="flex flex-col items-start gap-2">
                    <StatusCell row={row} />
                    <TallyCell row={row} showVoucher={showActions} />
                  </div>
                </TableCell>
                <TableCell label="Files" className="align-top sm:min-w-44">
                  <FilesCell row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p ref={countRef} tabIndex={-1} className="m-0 text-sm text-quiet outline-none" aria-live="polite">
        Showing {rows.length} {rows.length === 1 ? 'record' : 'records'}
        {cursor ? ', newest first. More are older.' : ', newest first. That is all of them.'}
      </p>
      {moreError ? (
        <Notice tone="warning" role="alert">
          <p>{moreError}</p>
        </Notice>
      ) : null}
      {cursor ? (
        <div>
          {moreHref ? (
            <noscript>
              <a href={moreHref} className={buttonVariants({ variant: 'secondary' })}>
                Show more
              </a>
            </noscript>
          ) : null}
          <Button
            variant="secondary"
            onClick={more}
            aria-disabled={pending || undefined}
          >
            {pending ? 'Loading more…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
