import { TriangleAlert } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MEAL_PLAN_LABEL, RATE_SHEET_COLUMNS, SHEET_REASON_WORD, SHEET_WARNING_WORD } from './labels';
import type { MealPlanCode, RateSheetImportSummary } from './types';

/*
 * Settings › Imports › Rate sheet (Accounts phase 3 contract §9.4, §15 item 9).
 * Two parts the import screen slots in for kind `rate_sheet`: the column
 * help (shown before a file is chosen) and the check result (counts, warnings
 * that never block, and each row with its outcome and the reasons it is left
 * out). Applying makes DRAFT contracts only; an active contract is never
 * touched, and a Manager approves each draft.
 */

/** Column help for the rate-sheet CSV / Excel file. */
export function RateSheetColumns() {
  return (
    <section aria-labelledby="rate-sheet-columns" className="flex flex-col gap-2 font-sans text-base text-copy">
      <h3 id="rate-sheet-columns" className="m-0 text-base font-semibold text-ink">
        Columns in the rate sheet
      </h3>
      <p className="m-0 text-sm text-quiet">One row per rate line. Rows with the same supplier, hotel and contract dates become one draft contract. Formula cells are refused.</p>
      <Table stackOnMobile label="Rate sheet columns" wrapperClassName="rounded-control border border-line">
        <TableCaption className="sr-only">Rate sheet columns and what each needs</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Column</TableHead>
            <TableHead>What to put in it</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {RATE_SHEET_COLUMNS.map((c) => (
            <TableRow key={c.name}>
              <TableCell label="Column" className="font-mono text-sm">
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
