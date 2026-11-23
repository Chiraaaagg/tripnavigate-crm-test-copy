import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { IMPORT_ACCESS_TEXT, RATE_SHEET_NO_ACCESS_TEXT, rateSheetEntity } from '@/modules/parties/import-access';
import { applyRateSheetAction, checkRateSheetAction } from '@/modules/rate-contracts/server/rate-sheet-actions';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { RateSheetImportArea } from '@/views/rate-contracts/import-details';
import { RateSheetImportView } from '@/views/rate-contracts/rate-sheet-import';

export const metadata: Metadata = { title: 'Upload a rate sheet' };

/**
 * Suppliers › Rate contracts › Upload a rate sheet (UX redesign R3, S14 and
 * DM-24). The same check and import as Settings › Imports › Rate sheets
 * (/app/admin/imports?kind=rate_sheet, which keeps working): the same two
 * server actions and the same access rule (rateSheetEntity: Purchase or a
 * Super Admin of one company). Only the frame differs: Purchase stays in the
 * Suppliers area. The actions and the database check access again.
 */
export default async function RateSheetUploadRoute() {
  const staff = await requireStaff();
  const sheetEntity = rateSheetEntity(staff.access);
  return (
    <RateSheetImportArea>
      <RateSheetImportView
        check={sheetEntity.ok ? (checkRateSheetAction as unknown as DecisionAction) : null}
        apply={sheetEntity.ok ? (applyRateSheetAction as unknown as DecisionAction) : null}
        canImport={sheetEntity.ok}
        noAccessText={sheetEntity.ok ? '' : sheetEntity.reason === 'several' ? IMPORT_ACCESS_TEXT.several : RATE_SHEET_NO_ACCESS_TEXT}
      />
    </RateSheetImportArea>
  );
}
