import { Landmark, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import type { SupplierImportRowView, SupplierImportSummary } from '../booking-form/vn-types';
import { IMPORT_OUTCOME_WORD, IMPORT_WARNING_WORD, KIND_LABEL, SERVICE_LABEL } from './labels';
import type { SupplierKind } from './types';

/*
 * Settings › Imports › Suppliers: the supplier part of the check result
 * (Accounts phase 2 contract 5.6, 11.10, 13.3). Warnings never block and
 * name the existing supplier (a link, never a merge); match is by the ID
 * column only, never by name. Bank details show holder, bank, IFSC and the
 * last four digits; the account number and PAN are masked by the read.
 * Imported bank details start unverified and payments stay on hold until a
 * Manager who did not apply the import approves them.
 */

function warningLine(code: string, d: SupplierImportRowView['warningDetails'][number] | undefined): ReactNode {
  const word = IMPORT_WARNING_WORD[code] ?? code;
  if (code === 'hotel_not_found') return `${word}: ${d?.hotelSourceRef ?? 'a hotel reference'}`;
  if (code === 'similar_name_city') {
    return d?.supplierId ? (
      <>
        {word}:{' '}
        <a href={`/app/purchase/suppliers/${d.supplierId}`} className="font-medium text-brand-strong underline underline-offset-4">
          {d.supplierName ?? 'an existing supplier'}
        </a>
      </>
    ) : (
      word
    );
  }
  return d?.supplierId ? (
    <>
      {word}{' '}
      <a href={`/app/purchase/suppliers/${d.supplierId}`} className="font-medium text-brand-strong underline underline-offset-4">
        {d.supplierName ?? 'an existing supplier'}
      </a>
    </>
  ) : (
    `${word} an existing supplier`
  );
}

export function SupplierImportDetails({ supplier: x }: { supplier: SupplierImportSummary }) {
  const w = x.warnings;
  const counts: Array<[string, number]> = [
    ['Similar name in the same city', w.similarNameCity],
    ['Same GSTIN', w.sameGstin],
    ['Same PAN', w.samePan],
    ['Bank details may differ', w.sameBank],
    ['Hotel not in the hotel list', w.hotelNotFound],
  ];
  const anyWarning = counts.some(([, n]) => n > 0);
  return (
    <section aria-labelledby="sup-import-rows" className="flex flex-col gap-3">
      <h3 id="sup-import-rows" className="m-0 text-base font-semibold text-ink">
        Supplier rows
      </h3>
      {anyWarning ? (
        <Notice tone="warning" title="Warnings to check (they do not stop the import)">
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
            {counts
              .filter(([, n]) => n > 0)
              .map(([label, n]) => (
                <li key={label}>
                  {label}: {n.toLocaleString('en-IN')} {n === 1 ? 'row' : 'rows'}
                </li>
              ))}
          </ul>
        </Notice>
      ) : (
        <p className="m-0 text-sm text-quiet">No warnings: no similar names, GSTINs, PANs or bank accounts found among existing suppliers.</p>
      )}
      {x.withBankDetails > 0 ? (
        <Notice tone="info" icon={Landmark} title={`${x.withBankDetails.toLocaleString('en-IN')} ${x.withBankDetails === 1 ? 'row has' : 'rows have'} bank details`}>
          <p>They are saved as new, unverified bank details. Payments to those suppliers stay on hold until a Manager who did not apply this import approves them.</p>
        </Notice>
      ) : null}
      <ul className="m-0 flex max-h-[32rem] list-none flex-col overflow-auto rounded-control border border-line p-0" aria-label="Supplier rows in the file" tabIndex={0}>
        {x.rows.map((r) => {
          const look = IMPORT_OUTCOME_WORD[r.outcome] ?? { word: r.outcome, tone: 'neutral' as const };
          const v = r.values;
          return (
            <li key={r.rowNo} className="m-0 flex flex-col gap-1.5 border-b border-line px-3 py-2.5 text-sm last:border-b-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-quiet tabular-nums">Row {r.rowNo}</span>
                <StatusBadge tone={look.tone} wrap>
                  {look.word}
                </StatusBadge>
                <span className="font-semibold wrap-anywhere text-ink">{v.name ?? 'No name'}</span>
                {v.supplierKind ? <span className="text-quiet">{KIND_LABEL[v.supplierKind as SupplierKind] ?? v.supplierKind}</span> : null}
              </span>
              <span className="wrap-anywhere text-copy">
                {[
                  v.sourceRef ? `ID ${v.sourceRef}` : null,
                  v.serviceTypes ? String(v.serviceTypes).split(/[;,]\s*/).filter(Boolean).map((t) => (SERVICE_LABEL as Record<string, string>)[t] ?? t).join(', ') : null,
                  v.city,
                  v.stateCode ? `state ${v.stateCode}` : null,
                  v.gstin ? `GSTIN ${v.gstin}` : null,
                  v.panMasked ? `PAN ${v.panMasked}` : null,
                  v.tallyLedgerName ? `Tally: ${v.tallyLedgerName}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {v.contactName || v.contactPhone || v.contactEmail ? <span className="wrap-anywhere text-quiet">Contact: {[v.contactName, v.contactPhone, v.contactEmail].filter(Boolean).join(' · ')}</span> : null}
              {v.hotelSourceRefs ? <span className="wrap-anywhere text-quiet">Hotels: {v.hotelSourceRefs}</span> : null}
              {v.bank ? (
                <span className="flex items-center gap-1.5 wrap-anywhere text-quiet">
                  <Landmark aria-hidden="true" className="size-3.5 shrink-0" />
                  Bank: {[v.bank.holder, v.bank.bankName, v.bank.ifsc].filter(Boolean).join(' · ')}
                  {v.bank.accountLast4 ? (
                    <span className="whitespace-nowrap tabular-nums">
                      {' '}
                      · <span aria-hidden="true">•••• </span>
                      <span className="sr-only">account ending </span>
                      {v.bank.accountLast4}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {r.reasons.length > 0 ? <span className="font-medium text-status-danger">Why left out: {r.reasons.join('; ')}</span> : null}
              {r.warnings.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {r.warnings.map((code, i) => (
                    <li key={`${code}-${i}`} className="flex items-start gap-1.5 text-copy">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                      <span className="min-w-0 wrap-anywhere">
                        <span className="sr-only">Warning: </span>
                        {warningLine(code, r.warningDetails.filter((d) => d.code === code)[r.warnings.slice(0, i).filter((c) => c === code).length])}
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
