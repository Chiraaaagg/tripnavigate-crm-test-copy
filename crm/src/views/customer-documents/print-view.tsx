import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { documentStatusLines, KIND_TITLE, rowTone } from './labels';
import { PrintButton } from './print-button';
import type { DocDetail } from './types';

/*
 * Staff print view of one released, replaced or cancelled customer document
 * (contract 6.8 "print view", same fence as the download: Accounts, the
 * branch Manager, the Sales owner). Shows the frozen released content through
 * track B's template (passed in, rendered on the server); nothing is
 * re-computed or fabricated. Used while the PDF maker is off or a PDF failed.
 */
export function CustomerDocumentPrintView({ doc, dealHref, document }: { doc: DocDetail; dealHref: string; document: ReactNode }) {
  const lines = documentStatusLines(doc);
  const title = KIND_TITLE[doc.kind];
  return (
    <div className="flex flex-col gap-4 font-sans">
      <p className="m-0 print:hidden">
        <Link href={dealHref} className="inline-flex items-center gap-1 text-sm font-semibold text-brand-strong underline-offset-4 hover:underline">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Back to the Deal
        </Link>
      </p>
      <PageHeader
        className="print:hidden"
        eyebrow={`Print view · ${title}`}
        title={doc.number ?? title}
        status={
          <span className="flex flex-wrap gap-1.5">
            {lines.map((l, i) => (
              <StatusBadge key={l} tone={i === 0 ? rowTone(doc) : 'warning'} wrap>
                {i === 0 ? <span className="sr-only">Status: </span> : null}
                {l}
              </StatusBadge>
            ))}
          </span>
        }
        actions={<PrintButton />}
      />
      <div className="print:hidden">
        <Notice tone="info">
          <p>
            {doc.screenPdf === 'ready'
              ? 'The PDF is ready on the Deal page. This view shows the same released content.'
              : doc.screenPdf === 'failed'
                ? 'The PDF could not be made. This view shows the released content exactly as frozen; print it from here.'
                : 'The PDF is not made yet. This view shows the released content exactly as frozen; print it from here.'}
            {doc.status !== 'released' ? ' This document is no longer current.' : ''}
          </p>
        </Notice>
      </div>
      <h2 className="sr-only">The document as released</h2>
      <div className="overflow-x-auto rounded-card border border-line bg-card p-4 print:border-0 print:p-0" role="region" aria-label={`${title} ${doc.number ?? ''}`.trim()} tabIndex={0}>
        {document}
      </div>
    </div>
  );
}
