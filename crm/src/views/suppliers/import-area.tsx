import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';

/*
 * Suppliers › Import suppliers (UX redesign R3, S14): the supplier CSV import
 * opened from the Suppliers area stays in that area. Only the frame differs
 * from Settings › Imports › Suppliers (/app/admin/imports?kind=supplier,
 * which keeps working): a back link to the register and the page's own
 * heading. The import itself is the same ImportView with the same actions.
 */

export const SUPPLIER_IMPORT_PATH = '/app/purchase/suppliers/import';

export function SupplierImportArea({ backHref = '/app/purchase/suppliers', children }: { backHref?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <div>
        <p className="m-0 mb-3">
          <Link href={backHref} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            Back to suppliers
          </Link>
        </p>
        <PageHeader
          eyebrow="Suppliers"
          title="Import suppliers"
          description="Add or update the stored suppliers from a CSV file. Nothing is saved until you apply."
          className="mb-[0]"
        />
      </div>
      {children}
    </div>
  );
}
