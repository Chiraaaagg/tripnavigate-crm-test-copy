import { ChevronLeft, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MEAL_PLAN_LABEL, RATE_SHEET_COLUMNS, SHEET_REASON_WORD, SHEET_WARNING_WORD } from './labels';
import type { MealPlanCode, RateSheetImportSummary } from './types';

/*
 * Rate sheet import parts (Accounts phase 3 contract §9.4, §15 item 9), used
 * by Settings › Imports › Rate sheets and, since UX redesign R3, by the
 * upload page inside Suppliers › Rate contracts. Two parts: the column
 * help (shown before a file is chosen) and the check result (counts, warnings
 * that never block, and each row with its outcome and the reasons it is left
 * out). Applying makes DRAFT contracts only; an active contract is never
 * touched, and a Manager approves each draft.
 */

/** Plain titles beside the column names the file must use (DM-24). The names themselves are unchanged. */
const COLUMN_TITLE: Record<string, string> = {
  supplierRef: 'Supplier',
  hotelRef: 'Hotel',
  city: 'City',
  validFrom: 'Contract from',
  validTo: 'Contract to',
  seasonFrom: 'Season from',
  seasonTo: 'Season to',
  roomType: 'Room type',
  mealPlan: 'Meal plan',
  rate: 'Rate per night',
  weekendRate: 'Weekend rate',
  extraAdult: 'Extra adult',
  childWithBed: 'Child with bed',
  childWithoutBed: 'Child without bed',
  blackoutDates: 'Blackout dates',
  cancellationTerms: 'Cancellation terms',
};

/** Plain title of a rate-sheet column (the name itself when there is none). */
export function rateSheetColumnTitle(name: string): string {
  return COLUMN_TITLE[name] ?? name;
}

/** Column help for the rate-sheet CSV / Excel file: plain title, the exact column name, what to put in it. */
export function RateSheetColumns() {
  return (
    <section aria-labelledby="rate-sheet-columns" className="flex flex-col gap-2 font-sans text-base text-copy">
      <h3 id="rate-sheet-columns" className="m-0 text-base font-semibold text-ink">
        Columns in the rate sheet
      </h3>
      <p className="m-0 text-sm text-quiet">One row per rate line. The first row of the file holds the column names exactly as written in the middle column. Rows with the same supplier, hotel and contract dates become one draft contract. Formula cells are refused.</p>
      <Table stackOnMobile label="Rate sheet columns" wrapperClassName="rounded-control border border-line">
        <TableCaption className="sr-only">Rate sheet columns and what each needs</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>What it holds</TableHead>
            <TableHead>Column name in the file</TableHead>
            <TableHead>What to put in it</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {RATE_SHEET_COLUMNS.map((c) => (
            <TableRow key={c.name}>
              <TableCell label="What it holds" className="font-medium text-ink">
                {rateSheetColumnTitle(c.name)}
              </TableCell>
              <TableCell label="Column name in the file" className="font-mono text-sm">
                {c.name}
              </TableCell>
              <TableCell label="What to put in it">{c.need}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/**
 * The rate-sheet upload inside the Suppliers area (UX redesign R3, S14 and
 * DM-24): back link to Rate contracts, the page's own heading, no Settings
 * frame or banner. The body is the same check and import (same actions, same
 * access rule) as Settings › Imports › Rate sheets, which keeps working.
 */
export function RateSheetImportArea({ backHref = '/app/purchase/rate-contracts', children }: { backHref?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <div>
        <p className="m-0 mb-3">
          <Link href={backHref} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            Back to rate contracts
          </Link>
        </p>
        <PageHeader
          eyebrow="Suppliers › Rate contracts"
          title="Upload a rate sheet"
          description="Check a supplier’s rate sheet, then import it. Nothing is saved until you import, and every contract starts as a draft for a Manager to approve."
          className="mb-[0]"
        />
      </div>
      {children}
    </div>
  );
}

/** Loading shape of the upload page. */
export function RateSheetImportLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Upload a rate sheet</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-64 w-full rounded-card" />
      </div>
    </div>
  );
}

function mealText(v: string | null): string | null {
  if (!v) return null;
  const code = v.toUpperCase() as MealPlanCode;
  return MEAL_PLAN_LABEL[code] ? `${MEAL_PLAN_LABEL[code]} (${code})` : v;
}

/** The rate-sheet part of the check result. */
export function RateSheetImportDetails({ sheet: x }: { sheet: RateSheetImportSummary }) {
  const counts: Array<[string, number]> = [
    ['Draft contracts to make', x.contracts],
    ['Rate lines', x.lines],
    ['New room types', x.newRoomTypes],
    ['Rows left out', x.invalidRows],
  ];
  const warnings: Array<[string, number]> = [
    [SHEET_WARNING_WORD.new_room_type, x.warnings.newRoomType],
    [SHEET_WARNING_WORD.overlaps_active_contract, x.warnings.overlapsActiveContract],
  ];
  return (
    <section aria-labelledby="rate-sheet-rows" className="flex flex-col gap-3 font-sans text-base text-copy">
      <h3 id="rate-sheet-rows" className="m-0 text-base font-semibold text-ink">
        Rate sheet check
      </h3>
      <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {counts.map(([label, n]) => (
          <div key={label} className="rounded-control border border-line bg-card px-3 py-2">
            <dt className="text-sm text-quiet">{label}</dt>
            <dd className="m-0 text-xl font-semibold text-ink tabular-nums">{n.toLocaleString('en-IN')}</dd>
          </div>
        ))}
      </dl>
      <Notice tone="info" title="Applying makes drafts only">
        <p>Each contract starts as a draft. A Manager who did not apply the file approves it before offers use it. Active contracts are never changed by an import.</p>
      </Notice>
      {warnings.some(([, n]) => n > 0) ? (
        <Notice tone="warning" title="Warnings to check (they do not stop the import)">
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
            {warnings
              .filter(([, n]) => n > 0)
              .map(([label, n]) => (
                <li key={label}>
                  {label}: {n.toLocaleString('en-IN')} {n === 1 ? 'row' : 'rows'}
                </li>
              ))}
          </ul>
        </Notice>
      ) : null}
      <ul className="m-0 flex max-h-[32rem] list-none flex-col overflow-auto rounded-control border border-line p-0" aria-label="Rate sheet rows in the file" tabIndex={0}>
        {x.rows.map((r) => {
          const v = r.values;
          return (
            <li key={r.rowNo} className="m-0 flex flex-col gap-1.5 border-b border-line px-3 py-2.5 text-sm last:border-b-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-quiet tabular-nums">Row {r.rowNo}</span>
                <StatusBadge tone={r.outcome === 'create' ? 'success' : 'danger'} wrap>
                  {r.outcome === 'create' ? 'Ready' : 'Left out'}
                </StatusBadge>
                <span className="font-semibold wrap-anywhere text-ink">{v.hotelRef ?? 'No hotel'}</span>
                <span className="wrap-anywhere text-quiet">{v.supplierRef ?? 'No supplier'}</span>
              </span>
              <span className="wrap-anywhere text-copy">
                {[
                  v.validFrom || v.validTo ? `Contract ${v.validFrom ?? '?'} to ${v.validTo ?? '?'}` : null,
                  v.seasonFrom || v.seasonTo ? `season ${v.seasonFrom ?? '?'} to ${v.seasonTo ?? '?'}` : null,
                  v.roomType,
                  mealText(v.mealPlan),
                  v.rate ? `₹${v.rate} a night` : null,
                  v.weekendRate ? `weekend ₹${v.weekendRate}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {v.blackoutDates ? <span className="wrap-anywhere text-quiet">Blackouts: {v.blackoutDates}</span> : null}
              {r.reasons.length > 0 ? <span className="font-medium text-status-danger">Why left out: {r.reasons.map((c) => SHEET_REASON_WORD[c] ?? c).join('; ')}</span> : null}
              {r.warnings.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {r.warnings.map((code) => (
                    <li key={code} className="flex items-start gap-1.5 text-copy">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                      <span className="min-w-0 wrap-anywhere">
                        <span className="sr-only">Warning: </span>
                        {SHEET_WARNING_WORD[code] ?? code}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {(x.moreRows ?? 0) > 0 ? <p className="m-0 text-sm text-quiet">{x.moreRows!.toLocaleString('en-IN')} more rows not shown. The counts above cover every row.</p> : null}
    </section>
  );
}
