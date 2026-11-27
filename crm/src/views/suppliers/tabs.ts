import type { NextButton } from '@/components/ui/record-header';
import { parseTab } from '@/lib/parse-tab';
import type { SupplierMaster } from './types';

/*
 * Supplier page tabs (UX redesign R3, DM-21). "Bank details" is its own tab
 * (it used to be the last block of Details). Every address that worked
 * before still opens the same tab: no ?tab= and ?tab=details open Details,
 * ?tab=contacts|hotels|history open those tabs, and any other value falls
 * back to Details. Pure: unit-tested in tests/unit/r3-supplier-tabs.test.ts.
 */

export type SupplierTab = 'details' | 'bank' | 'contacts' | 'hotels' | 'history';

export const SUPPLIER_TABS: readonly SupplierTab[] = ['details', 'bank', 'contacts', 'hotels', 'history'];

/** The tab a `?tab=` value opens (unknown or missing → Details). */
export function supplierTabFrom(raw: unknown): SupplierTab {
  return parseTab(raw, SUPPLIER_TABS, 'details');
}

/** The address of one tab of a supplier page (Details has no `?tab=`). */
export function supplierTabHref(basePath: string, supplierId: string, tab: SupplierTab): string {
  return `${basePath}/${supplierId}${tab === 'details' ? '' : `?tab=${tab}`}`;
}

/** id of the "Record new bank details" control inside the bank section (the header's jump target). */
export const SUPPLIER_BANK_RECORD_ID = 'supplier-bank-record';

/** Where the header's "Next:" line points (design plan 1.3). `mine` = the viewer does it; otherwise it names who does. */
export function supplierNext(
  s: Pick<SupplierMaster, 'verification' | 'bankState' | 'serviceTypes' | 'can'>,
  o: { canEdit: boolean; tab: SupplierTab; bankHref: string },
): { text: string; mine: boolean; button?: NextButton } {
  const editor = s.serviceTypes.includes('flight') ? 'Flight' : 'Purchase';
  if (s.verification === 'unverified') {
    return s.can.verify ? { text: 'Check these details, then verify them.', mine: true } : { text: 'A Manager checks and verifies these details.', mine: false };
  }
  if (s.bankState === 'on_hold') {
    const text = 'A Manager who did not record them approves the latest bank details. Payments wait until then.';
    // can.approveBank: this reader may approve bank details (the bank section still decides each revision, and nobody approves their own).
    if (s.can.approveBank) return { text, mine: true, button: o.tab === 'bank' ? undefined : { label: 'Open bank details', href: o.bankHref } };
    return { text, mine: false };
  }
  if (s.bankState === 'none') {
    if (o.canEdit) {
      return {
        text: 'Record bank details before any payment to this supplier.',
        mine: true,
        button: o.tab === 'bank' ? { label: 'Record bank details', jumpTo: SUPPLIER_BANK_RECORD_ID } : { label: 'Record bank details', href: o.bankHref },
      };
    }
    return { text: `${editor} records bank details before any payment to this supplier.`, mine: false };
  }
  return { text: 'Ready to use for rates and payments.', mine: true };
}
