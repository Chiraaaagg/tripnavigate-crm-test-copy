import { ChevronLeft, CircleAlert, CircleCheck, CircleX, Info } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { companyGstinMissingText, quotationGstinWarning, splitCompanyGstinPlaceholders } from '@/modules/documents/company-identity';
import type { AdapterRefusal } from '@/modules/documents/contracts';
import type { QuoteCopyLinks } from '@/modules/quotations/editor-contract';
import { QUOTE_TEXT } from './quote-fields';
import { QuoteCopySwitch } from './quote-views';

/*
 * The customer preview page frame (B1.2 Phase E/F). The document itself is
 * the branded template the PDF uses, fed by the same customer view
 * (quotation_customer_money; review E4-2). The check result comes from the
 * documents safety scan run by the adapter on the server (review E4-3), and
 * is stated in words above the document; a hit is a blocking problem.
 */

export type PreviewCheck =
  | {
      kind: 'ok';
      placeholders: string[];
      /** Staff-only notes in words (never on the document; never blocking), e.g. the day-plan coverage. */
      notices?: string[];
      /** Which document: a quotation states the missing company GSTIN as a warning before sending (DEC-50 review). */
      document?: 'quotation' | 'itinerary';
    }
  | { kind: 'refused'; refusals: AdapterRefusal[] }
  | { kind: 'no_money' };

const REFUSAL_TEXT: Record<AdapterRefusal['code'], string> = {
  tier_missing: 'Type the quoted total first (Prices and totals).',
  nights_mismatch: 'The nights of the stays do not add up to the trip dates.',
  days_mismatch: 'The number of days in the day-by-day plan does not match the trip length.',
  dates_invalid: 'A stay has a missing date, or its check-out is not after its check-in.',
  amount_has_paise: 'A price has paise; customer prices are whole rupees.',
  amount_invalid: 'A price is not valid.',
  forbidden_field: 'An internal field reached the customer view, so nothing is shown. Tell the CRM team.',
  unsafe_text: 'Customer text contains blocked words.',
};

/** Blocked words named by the scan (list phrase only, never the customer's text). */
function blockedPhrases(refusals: AdapterRefusal[]): string[] {
  return [...new Set(refusals.filter((r) => r.code === 'unsafe_text' && r.detail).map((r) => r.detail!.split(':').slice(1).join(':')))];
}

export function QuotePreviewFrame({ backHref, backLabel = 'Back to the quotation', title = 'What the customer sees', check, children, copyLinks }: { backHref: string; backLabel?: string; title?: string; check: PreviewCheck; children?: ReactNode; /** Batch 2: the quotation's Edit / Customer copy switch. */ copyLinks?: QuoteCopyLinks }) {
  const phrases = check.kind === 'refused' ? blockedPhrases(check.refusals) : [];
  // DEC-50 review: a missing company GSTIN is Accounts' data, never a fact staff can fill in.
  const split = check.kind === 'ok' ? splitCompanyGstinPlaceholders(check.placeholders) : { gstinBranches: [], others: [] };
  const gstinText = check.kind === 'ok' && check.document === 'quotation' ? quotationGstinWarning : companyGstinMissingText;
  const other = check.kind === 'refused' ? [...new Set(check.refusals.filter((r) => r.code !== 'unsafe_text').map((r) => REFUSAL_TEXT[r.code]))] : [];
  return (
    <div className="font-sans text-base text-copy">
      <p className="m-0 mb-3">
        <Link href={backHref} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
          <ChevronLeft aria-hidden="true" className="size-4" />
          {backLabel}
        </Link>
      </p>
      <PageHeader title={title} description="This is how the quotation will look. Nothing is sent." />
      {copyLinks ? (
        <div className="mb-4">
          <QuoteCopySwitch links={copyLinks} />
        </div>
      ) : null}
      <div className="mb-4 flex flex-col gap-3" role="status">
        {check.kind === 'no_money' ? (
          <Notice tone="locked">{QUOTE_TEXT.previewNeedsPrices}</Notice>
        ) : check.kind === 'ok' ? (
          <>
            <p className="m-0 flex gap-2 text-copy">
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />
              {QUOTE_TEXT.noInternalWords}
            </p>
            {(check.notices ?? []).map((n) => (
              <p key={n} className="m-0 flex gap-2 text-copy">
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
                <span>
                  <span className="sr-only">Note for staff: </span>
                  {n}
                </span>
              </p>
            ))}
            {split.gstinBranches.map((branch) => (
              <Notice key={branch} tone="warning" role="none">
                <p>{gstinText(branch)}</p>
              </Notice>
            ))}
            {split.others.length > 0 ? (
              <p className="m-0 flex gap-2 text-copy">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
                <span>
                  {split.others.length} {split.others.length === 1 ? 'detail' : 'details'} missing (shown in [brackets]): {[...new Set(split.others)].join(', ')}.
                </span>
              </p>
            ) : null}
          </>
        ) : (
          <Notice tone="danger" title="Not ready for the customer">
            {phrases.length > 0 ? (
              <p className="flex gap-2">
                <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                Blocked words found: {phrases.join(', ')}. Change the text before sharing it.
              </p>
            ) : null}
            {other.length > 0 ? (
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                {other.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        )}
      </div>
      {children}
    </div>
  );
}
