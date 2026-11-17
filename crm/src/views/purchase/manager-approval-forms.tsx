'use client';

import { ApproveBeneficiaryForm, ApproveOverBudgetForm, VerifySupplierForm } from '../procurement-forms';

/*
 * Manager decisions on the Approvals page that already exist on the task
 * and supplier pages (Phase 4 amendment A1). Reused unchanged so the wording,
 * request handling and refusals stay identical everywhere.
 */

export function ManagerApproveCostForm({ taskId, versionNo }: { taskId: string; versionNo: number }) {
  return <ApproveOverBudgetForm taskId={taskId} versionNo={versionNo} />;
}

export function ManagerApproveBankForm({ supplierId, revisionNo }: { supplierId: string; revisionNo: number }) {
  return <ApproveBeneficiaryForm supplierId={supplierId} revisionNo={revisionNo} />;
}

export function ManagerVerifySupplierForm({ supplierId, rowVersion }: { supplierId: string; rowVersion: number }) {
  return <VerifySupplierForm supplierId={supplierId} rowVersion={rowVersion} />;
}
