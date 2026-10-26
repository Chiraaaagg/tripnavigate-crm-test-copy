import { FileCheck2, TriangleAlert } from 'lucide-react';
import { cn, focusRing } from '@/components/ui/cn';
import { BOOK_NOW_TEXT, type BookingQuotationSource } from '@/modules/fulfilment/contracts';
import { dateText } from './book-fields';

/*
 * B1.2: a booking version started from an accepted quotation carries that
 * acceptance (no copy of the file). Shown on the review section and on the
 * submitted booking, with the link to the customer's written acceptance.
 */
export function QuotationSourceNote({ source, stale = false }: { source: BookingQuotationSource | null | undefined; /** quote_acceptance_stale: the booking changed after the acceptance (review E4-7). */ stale?: boolean }) {
  if (!source) return null;
  const text = BOOK_NOW_TEXT.acceptanceFromQuotation
    .replace('{reference}', source.reference)
    .replace('{versionNo}', String(source.versionNo))
    .replace('{date}', dateText(source.acceptedAt) ?? '');
  return (
    <div className={stale ? 'flex flex-col gap-1.5 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-3 text-copy' : 'flex flex-col gap-1.5 rounded-control border border-status-success-line bg-status-success-tint px-3.5 py-3 text-copy'} role="note">
      <p className="m-0">
        <FileCheck2 aria-hidden="true" className="mr-1 inline size-4 align-[-3px] text-status-success" />
        {text}
        {source.acceptanceHref ? (
          <>
            {' '}
            <a href={source.acceptanceHref} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
              {BOOK_NOW_TEXT.acceptanceFromQuotationFile}
            </a>
          </>
        ) : null}
      </p>
      {stale ? (
        <p className="m-0 font-semibold text-ink">
          <TriangleAlert aria-hidden="true" className="mr-1 inline size-4 align-[-3px] text-status-warning" />
          This booking differs from the quotation the customer accepted. Upload their new written OK.
        </p>
      ) : null}
    </div>
  );
}
