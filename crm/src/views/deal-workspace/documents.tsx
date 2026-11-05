import { FileText, FolderOpen } from 'lucide-react';
import Link from 'next/link';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import type { DealDocumentRow, DealDocumentsVM } from '@/modules/deals/workspace-contract';
import { DEPARTMENT_EVIDENCE_KIND_LABEL, EVIDENCE_KIND_LABEL } from '@/modules/fulfilment/contracts';
import { formatIst } from '../deal-labels';
import { TabUnavailable } from './tab-error';

/*
 * Documents tab (DE-02, FP-025; money-privacy P11). Lists only the files the
 * viewer may open (the combined read decides), each linking to its existing
 * audited download route; no storage URL, uploader, path or amount. Shown
 * only when the route passes `workspace.documents` (lead decision 3: hidden
 * until the read lands, never partial). An error is never "No documents".
 */

const PURCHASE_FILE_LABEL: Record<string, string> = { quote: 'Supplier quote', supplier_confirmation: 'Supplier confirmation', other: 'Other file' };
const DEPARTMENT_WORD: Record<string, string> = { flight: 'Flight', visa: 'Visa and passport desk', passport: 'Visa and passport desk' };

/** A known label, else the code in plain words (never a raw code with underscores). */
function labelOf(map: Record<string, string>, code: string): string {
  if (map[code]) return map[code]!;
  const text = code.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What the file is, in words (copy §16.10 DA-125). */
export function documentKindText(row: DealDocumentRow): string {
  switch (row.kind) {
    case 'id_proof':
      return `ID proof · traveller ${row.context.travellerSeq}`;
    case 'booking_file': {
      const kind = labelOf(EVIDENCE_KIND_LABEL, row.context.evidenceKind);
      return row.context.versionNo === null ? `Booking file · ${kind}` : `Booking version ${row.context.versionNo} · ${kind}`;
    }
    case 'quotation_acceptance': {
      const what = row.context.evidenceKind === 'acceptance_message' ? 'Customer’s acceptance message' : 'Acceptance file';
      const version = row.context.versionNo === null ? '' : ` version ${row.context.versionNo}`;
      return `${what} · quotation ${row.context.quotationReference}${version}`;
    }
    case 'itinerary_source':
      return 'Itinerary · source file';
    case 'itinerary_pdf':
      return `Itinerary PDF · ${row.context.pdfKind === 'final' ? 'Final' : row.context.pdfKind === 'preview' ? 'Preview' : labelOf({}, row.context.pdfKind)}`;
    case 'purchase_file':
      return `Purchase file · ${labelOf(PURCHASE_FILE_LABEL, row.context.fileKind)}`;
    case 'department_file':
      return `${labelOf(DEPARTMENT_WORD, row.context.department)} file · ${labelOf(DEPARTMENT_EVIDENCE_KIND_LABEL, row.context.fileKind)}`;
  }
}

export function DealDocumentsTab({ documents }: { documents: DealDocumentsVM }) {
  // DA-127: the shared G-14 sentence ("Documents did not load. Nothing was changed. …").
  if (documents.state === 'error') return <TabUnavailable thing="Documents" />;
  return (
    <Card>
      <section aria-labelledby="deal-documents-heading">
        <CardHeader>
          <CardTitle id="deal-documents-heading">Documents</CardTitle>
        </CardHeader>
        {documents.rows.length === 0 ? (
          <EmptyState icon={FolderOpen} title="No documents you can open yet" description="Files you can open on this deal show here after someone adds them." />
        ) : (
          <CardBody>
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Documents you can open">
              {documents.rows.map((row) => (
                <li key={`${row.kind}-${row.id}`} className="m-0 flex flex-wrap items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-strong" />
                  <span className="min-w-0 flex-1">
                    <Link href={row.href} className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep', focusRing)}>
                      {row.fileName}
                    </Link>
                    <span className="block text-sm text-quiet">{documentKindText(row)}</span>
                  </span>
                  <span className="text-sm text-quiet">Added {formatIst(row.uploadedAt)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </section>
    </Card>
  );
}
