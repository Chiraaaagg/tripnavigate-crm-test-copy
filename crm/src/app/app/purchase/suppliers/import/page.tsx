import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { applyImportAction, validateImportAction } from '@/modules/parties/server/import-actions';
import { loadImportPage } from '@/modules/parties/server/import-load';
import type { B11Action } from '@/views/b11/shapes';
import { ImportView } from '@/views/settings/import-view';
import { SupplierImportArea } from '@/views/suppliers/import-area';

export const metadata: Metadata = { title: 'Import suppliers' };

/**
 * Suppliers › Import suppliers (UX redesign R3, S14). The same read, check and
 * apply as Settings › Imports › Suppliers (/app/admin/imports?kind=supplier,
 * which keeps working): loadImportPage under the viewer's session and the
 * same two server actions, which check access again (Accounts without
 * Purchase, or a Super Admin of one company). Only the frame differs: the
 * page stays in the Suppliers area.
 */
export default async function SupplierImportRoute() {
  const staff = await requireStaff();
  const page = await loadImportPage(staff, 'supplier');
  return (
    <SupplierImportArea>
      <ImportView
        kind="supplier"
        kindLinks={[]}
        heading={false}
        canApply={page.allowed}
        summary={null}
        history={page.history}
        actions={{ validate: validateImportAction as unknown as B11Action, apply: applyImportAction as unknown as B11Action }}
      />
    </SupplierImportArea>
  );
}
