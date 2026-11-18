import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { IMPORT_KIND_LABEL, IMPORT_KINDS, type ImportKind } from '@/modules/parties/import-mapping';
import { IMPORT_ACCESS_TEXT, RATE_SHEET_NO_ACCESS_TEXT, rateSheetEntity } from '@/modules/parties/import-access';
import { applyRateSheetAction, checkRateSheetAction } from '@/modules/rate-contracts/server/rate-sheet-actions';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { RateSheetImportView } from '@/views/rate-contracts/rate-sheet-import';
import { applyImportAction, validateImportAction } from '@/modules/parties/server/import-actions';
import { loadImportPage } from '@/modules/parties/server/import-load';
import type { B11Action } from '@/views/b11/shapes';
import { ImportView, RateSheetImportFrame } from '@/views/settings/import-view';

export const metadata: Metadata = { title: 'Imports' };

/**
 * Settings · Imports (voice-note batch, owner item 5): the hotel list (Super
 * Admin) and the customer list (Accounts) from a CSV saved in Excel. "Check
 * file" shows the read-only summary (mapping, counts, duplicates, invalid
 * rows, proposed changes); "Import" is a separate step with a reason. The
 * database decides every step; this page only says who may use it.
 * ?kind= is allowlisted (IMPORT_KINDS: hotel | customer | supplier; Accounts phase 2 contract 5.6).
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  const staff = await requireStaff();
  const raw = (await searchParams).kind;
  const want = Array.isArray(raw) ? raw[0] : raw;
  // Accounts phase 3 (contract 9.4): the rate sheet, for Purchase or a Super Admin of one company.
  const sheetEntity = rateSheetEntity(staff.access);
  const sheetAllowed = sheetEntity.ok || sheetEntity.reason === 'several';
  const links = (current: string) => [
    ...IMPORT_KINDS.map((k) => ({ kind: k, label: IMPORT_KIND_LABEL[k], href: `/app/admin/imports?kind=${k}`, current: k === current })),
    ...(sheetAllowed ? [{ kind: 'rate_sheet', label: 'Rate sheets', href: '/app/admin/imports?kind=rate_sheet', current: current === 'rate_sheet' }] : []),
  ];
  if (want === 'rate_sheet') {
    return (
      <RateSheetImportFrame kindLinks={links('rate_sheet')}>
        <RateSheetImportView
          check={sheetEntity.ok ? (checkRateSheetAction as unknown as DecisionAction) : null}
          apply={sheetEntity.ok ? (applyRateSheetAction as unknown as DecisionAction) : null}
          canImport={sheetEntity.ok}
          noAccessText={sheetEntity.ok ? '' : sheetEntity.reason === 'several' ? IMPORT_ACCESS_TEXT.several : RATE_SHEET_NO_ACCESS_TEXT}
        />
      </RateSheetImportFrame>
    );
  }
  const kind: ImportKind = (IMPORT_KINDS as readonly string[]).includes(want ?? '') ? (want as ImportKind) : 'hotel';
  const page = await loadImportPage(staff, kind);
  return (
    <ImportView
      kind={kind}
      kindLinks={links(kind)}
      canApply={page.allowed}
      summary={null}
      history={page.history}
      branchChoice={page.branchChoice}
      actions={{ validate: validateImportAction as unknown as B11Action, apply: applyImportAction as unknown as B11Action }}
    />
  );
}
