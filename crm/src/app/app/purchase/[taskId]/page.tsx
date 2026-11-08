import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { loadDepartmentWorkForm } from '@/modules/fulfilment/server/department';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadPurchaseTask } from '@/modules/fulfilment/server/queries';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import { requireStaff } from '@/modules/identity/server/session';
import {
  addQuoteAction,
  proposeCostAction,
  recordRateRequestAction,
  sendBookingRequestAction,
  sendCancellationChargesAction,
  setCancellationChargeAction,
} from '@/modules/procurement/server/actions';
import { loadPurchaseWorkspace } from '@/modules/procurement/server/queries';
import { historyTabFor, parseTaskTab, taskTabsFor } from '@/modules/settings/contracts';
import {
  cancelPaymentRequestAction,
  createPaymentRequestAction,
  resubmitPaymentRequestAction,
  uploadSupplierDocumentAction,
  uploadSupplierMoneyFileAction,
} from '@/modules/supplier-money/server/actions';
import { loadPaymentContext } from '@/modules/supplier-money/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DepartmentCostCard } from '@/views/b11/department-cost';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import { SupplierDocumentsSection } from '@/views/purchase/supplier-documents';
import { purchaseNextText, PurchaseWorkTab, WorkStack, type PurchaseWorkActions } from '@/views/purchase/work-tab';
import { PurchaseTaskNotFoundView, PurchaseTaskPage } from '@/views/purchase-views';

export const metadata: Metadata = { title: 'Purchase task' };

const act = (a: unknown) => a as DecisionAction;

/** Real server actions for the Work and Files tabs (the preview gallery passes stubs instead). */
const WORK_ACTIONS: PurchaseWorkActions = {
  addRate: act(addQuoteAction),
  useFinalRate: act(proposeCostAction),
  rateRequest: act(recordRateRequestAction),
  bookingRequest: act(sendBookingRequestAction),
  cancellationCharge: act(setCancellationChargeAction),
  sendCharges: act(sendCancellationChargesAction),
  createPayment: act(createPaymentRequestAction),
  resubmitPayment: act(resubmitPaymentRequestAction),
  cancelPayment: act(cancelPaymentRequestAction),
  uploadSupplierFile: act(uploadSupplierMoneyFileAction),
};

/**
 * Purchase task (PU-02, DA-16; Purchase build 2 Nov 2026): Details · Work ·
 * Files · History, as links (`?tab=`, server allowlist). Tabs come only from
 * what the database returned for this viewer: Sales or Accounts (status only)
 * get no tab bar and no Work, Files or History data. Only the open tab's
 * extra data is read. Supplier payments, invoices and credit notes come from
 * the supplier-money read (purchase_payment_context), which never carries
 * customer money amounts or funding reasons.
 */
export default async function PurchaseTaskRoute({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ taskId }, { tab }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const task = await loadPurchaseTask(staff, taskId);
  if (!task) return <PurchaseTaskNotFoundView />;
  // The workspace read returns null unless the viewer holds the Purchase role
  // in the task's entity or manages the deal's branch (read-only, amendment
  // A1). Sales sees status only (P4-D6).
  const mayReadWork = staff.memberships.some((m) => m.roleCode === 'purchase' || m.roleCode === 'manager');
  const [workspace, workForm, idProofs, historyLoad] = await Promise.all([
    mayReadWork ? loadPurchaseWorkspace(staff, taskId) : Promise.resolve(null),
    // The shared cost block is read-only for Purchase (costs live in the supplier work).
    loadDepartmentWorkForm(staff, taskId).catch(() => null),
    // B1.2 (DEC-41): the travellers' ID proofs for the task's assignee; null = not for this viewer.
    loadTaskIdProofs(staff, taskId).catch(() => 'error' as const),
    // Batch 4: null = this viewer may not read the task's History (no tab).
    loadTaskHistory(staff, taskId),
  ]);
  // Echo-B L11 / Echo-A L5: a failed or not-installed read never gives a status-only viewer (Sales, Accounts) a tab bar.
  const work = !!workspace || !!workForm;
  const files = !!workspace || (idProofs !== null && idProofs !== 'error');
  const tabs = taskTabsFor({ work, files, history: historyTabFor(historyLoad, work || files) });
  const current = parseTaskTab(tab, tabs);
  const managerReadOnly = !!workspace && !workspace.canWork && !task.canClaim && staff.memberships.some((m) => m.roleCode === 'manager');
  // Supplier payments, invoices and credit notes: only on the Work and Files tabs, only with the workspace.
  const payments = workspace && (current === 'work' || current === 'files') ? await loadPaymentContext(staff, taskId).catch(() => 'error' as const) : null;
  // E-mail drafts are signed by the person who works the task (the assignee).
  const senderName = workspace?.task.assignedToYou && workspace.task.assigneeName ? workspace.task.assigneeName : 'Purchase team';
  return (
    <WorkErrorBoundary title="Purchase task">
      <PurchaseTaskPage
        task={task}
        tabs={{ tabs, current }}
        managerReadOnly={managerReadOnly}
        goAheadState={workspace?.goAhead.state ?? null}
        nextText={workspace ? purchaseNextText(workspace) : undefined}
        idProofs={idProofs !== null ? <TravellerIdProofsCard state={idProofs} /> : undefined}
        work={
          current === 'work' && (workspace || workForm) ? (
            <WorkStack>
              {workspace ? <PurchaseWorkTab ws={workspace} payments={payments} actions={WORK_ACTIONS} senderName={senderName} /> : null}
              {workForm ? <DepartmentCostCard taskId={task.taskId} department="purchase" costs={workForm.costs} canRecord={false} readOnlyReason={workForm.readOnlyReason} /> : null}
            </WorkStack>
          ) : undefined
        }
        files={current === 'files' ? { purchase: workspace?.evidence, department: workForm?.documents, idProofs } : undefined}
        filesExtra={
          current === 'files' && workspace ? (
            <SupplierDocumentsSection ctx={payments} documentAction={act(uploadSupplierDocumentAction)} uploadAction={act(uploadSupplierMoneyFileAction)} />
          ) : undefined
        }
        history={current === 'history' ? toTaskHistoryVM(historyLoad, 'purchase') : undefined}
      />
    </WorkErrorBoundary>
  );
}
