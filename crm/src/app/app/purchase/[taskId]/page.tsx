import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { loadDepartmentWorkForm } from '@/modules/fulfilment/server/department';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadPurchaseQueue, loadPurchaseTask } from '@/modules/fulfilment/server/queries';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import { searchHotelsAction } from '@/modules/hotels/server/hotel-actions';
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
import { acknowledgeBookingChangeAction, loadPurchaseBookingChange } from '@/modules/procurement/server/booking-change-actions';
import { BookingChangeBanner } from '@/views/purchase/booking-change-banner';
import { linkSupplierDocumentAction } from '@/modules/accounts-desk/server/actions';
import { historyTabFor, taskTabsFor } from '@/modules/settings/contracts';
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
import { defaultTaskTab, taskTabFor } from '@/views/department/task-default-tab';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import { SupplierDocumentsSection } from '@/views/purchase/supplier-documents';
import { purchaseNextText, PurchaseWorkTab, WorkStack, type PurchaseWorkActions } from '@/views/purchase/work-tab';
import { PurchaseTaskNotFoundView, PurchaseTaskPage } from '@/views/purchase-views';
import { UploadPurchaseFileForm } from '@/views/procurement-forms';

import { approveReconfirmOverBudgetAction, recordReconfirmAction, refuseReconfirmAction } from '@/modules/booking-changes/server/actions';
import { loadTaskReconfirmation } from '@/modules/booking-changes/server/queries';
import { markVoucherReadyAction, uploadCustomerVoucherAction } from '@/modules/customer-messages/server/actions';
import { loadTaskCustomerFiles } from '@/modules/customer-messages/server/queries';
import { lookupRateContractAction } from '@/modules/rate-contracts/server/actions';
import { loadRateContractsState } from '@/modules/rate-contracts/server/queries';
import { taskReconfirmationView } from '@/views/booking-changes/adapt';
import { ReconfirmPanel } from '@/views/booking-changes/reconfirm-panel';
import type { ProofOption } from '@/views/booking-changes/types';
import { CustomerVoucherPanel } from '@/views/customer-messages/task-panels';
import type { TaskCustomerMessageStatus as VoucherStatusView, VoucherFile } from '@/views/customer-messages/types';
import type { RawRateLookupAction } from '@/views/rate-contracts/offer-block';

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
  // Accounts phase 2 (contract 13.4): the rate form's hotel picker searches the hotel list.
  searchHotels: searchHotelsAction,
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
  const [workspace, workForm, idProofs, historyLoad, bookingChange, reconfirmation, customerFiles, rateState] = await Promise.all([
    mayReadWork ? loadPurchaseWorkspace(staff, taskId) : Promise.resolve(null),
    // The shared cost block is read-only for Purchase (costs live in the supplier work).
    loadDepartmentWorkForm(staff, taskId).catch(() => null),
    // B1.2 (DEC-41): the travellers' ID proofs for the task's assignee; null = not for this viewer.
    loadTaskIdProofs(staff, taskId).catch(() => 'error' as const),
    // Batch 4: null = this viewer may not read the task's History (no tab).
    loadTaskHistory(staff, taskId),
    // Accounts phase (contract 8.5, 11.7): "Booking changed" banner; null = unchanged or not for this viewer.
    mayReadWork ? loadPurchaseBookingChange(taskId).catch(() => null) : Promise.resolve(null),
    // Accounts phase 3 (contract 10.5 R-G3, screen 15.10): "Reconfirm with supplier"; null = no live reconfirmation for this viewer.
    mayReadWork ? loadTaskReconfirmation(staff, taskId).catch(() => 'error' as const) : Promise.resolve(null),
    // Accounts phase 3 (contract 5.6 A5, screen 15.3): the customer voucher slot; null = not this viewer's or not a hotel task.
    mayReadWork ? loadTaskCustomerFiles(staff, taskId).catch(() => 'error' as const) : Promise.resolve(null),
    // Accounts phase 3 (contract 9.1): the rate-contract switch for the offer form's contract block.
    mayReadWork ? loadRateContractsState(staff).catch(() => null) : Promise.resolve(null),
  ]);
  const workActions: PurchaseWorkActions = rateState?.enabled
    ? { ...WORK_ACTIONS, rateContract: { enabled: true, rawLookup: lookupRateContractAction as unknown as RawRateLookupAction } }
    : WORK_ACTIONS;
  // Proof for a reconfirmation (review finding 2): only the stored supplier confirmations uploaded for THIS
  // reconfirmation (migration 0690 tags them), never the earlier, pre-change confirmation.
  const openReconfirmationId = reconfirmation && reconfirmation !== 'error' ? reconfirmation.reconfirmation.id : null;
  const proofs: ProofOption[] = (workspace?.evidence ?? [])
    .filter((e) => e.kind === 'supplier_confirmation' && e.status === 'stored' && openReconfirmationId !== null && e.reconfirmationId === openReconfirmationId)
    .map((e) => ({ evidenceId: e.id, fileName: e.fileName, uploadedAt: e.createdAt }));
  // Finding 8: the viewer's roles, so a blocked over-budget approval names the real cause.
  const roles = { isManager: staff.memberships.some((m) => m.roleCode === 'manager'), worksTask: !!workspace?.canWork };
  // Addendum L10: after this person refused, list the reconfirmations of the same change they also handle
  // (voided by the refusal; notice 56 is not sent to the person who acted).
  const voided =
    reconfirmation && reconfirmation !== 'error' && reconfirmation.reconfirmation.status === 'refused' && workspace?.canWork
      ? await voidedSiblings(staff, taskId, task.dealReference, reconfirmation.changeRequest.refNo)
      : [];
  const reconfirmPanel =
    reconfirmation === null ? null : (
      <ReconfirmPanel
        view={reconfirmation === 'error' ? 'error' : taskReconfirmationView(reconfirmation)}
        proofs={proofs}
        viewer={roles.worksTask || !roles.isManager ? 'purchase' : 'manager'}
        roles={roles}
        // Finding 1: the task is confirmed, so the Work tab's upload is closed; the proof is uploaded here.
        proofUpload={workspace?.canWork ? <UploadPurchaseFileForm taskId={taskId} fileCount={workspace.evidence.length} onlyKind="supplier_confirmation" /> : undefined}
        voided={voided}
        actions={{ record: act(recordReconfirmAction), refuse: act(refuseReconfirmAction), approveOverBudget: act(approveReconfirmOverBudgetAction) }}
      />
    );
  const voucherFiles: VoucherFile[] =
    customerFiles && customerFiles !== 'error' && customerFiles.kind === 'customer_voucher'
      ? customerFiles.files.filter((f) => f.status === 'stored').map((f) => ({ evidenceId: f.evidenceId, fileName: f.fileName, storedAt: f.storedAt ?? '', readyAt: f.readyAt, readyByName: null }))
      : [];
  const voucherStatus: VoucherStatusView | 'error' | null =
    customerFiles === 'error'
      ? 'error'
      : customerFiles && customerFiles.kind === 'customer_voucher'
        ? { taskId: customerFiles.taskId, items: customerFiles.files.filter((f) => f.readyAt).map((f) => ({ evidenceId: f.evidenceId, messageType: 'hotel_voucher' as const, email: f.email, whatsapp: f.whatsapp })) }
        : null;
  const voucherPanel =
    customerFiles === null || (customerFiles !== 'error' && customerFiles.kind !== 'customer_voucher') ? null : (
      <CustomerVoucherPanel
        taskId={taskId}
        supplierConfirmed={customerFiles === 'error' ? false : customerFiles.taskConfirmed}
        canWork={customerFiles === 'error' ? false : customerFiles.can.upload || customerFiles.can.markReady}
        files={voucherFiles}
        status={voucherStatus}
        actions={customerFiles === 'error' ? null : { upload: customerFiles.can.upload ? act(uploadCustomerVoucherAction) : undefined, markReady: customerFiles.can.markReady ? act(markVoucherReadyAction) : undefined }}
      />
    );
  // Echo-B L11 / Echo-A L5: a failed or not-installed read never gives a status-only viewer (Sales, Accounts) a tab bar.
  const work = !!workspace || !!workForm;
  const files = !!workspace || (idProofs !== null && idProofs !== 'error');
  const tabs = taskTabsFor({ work, files, history: historyTabFor(historyLoad, work || files) });
  // D6: without ?tab=, the person who holds the task opens on Work; everyone else on Details. Every ?tab= keeps working.
  const holdsTask = !!workspace?.task.assignedToYou;
  const current = taskTabFor(tab, tabs, holdsTask);
  const managerReadOnly = !!workspace && !workspace.canWork && !task.canClaim && staff.memberships.some((m) => m.roleCode === 'manager');
  // Supplier payments, invoices and credit notes: only on the Work and Files tabs, only with the workspace.
  const payments = workspace && (current === 'work' || current === 'files') ? await loadPaymentContext(staff, taskId).catch(() => 'error' as const) : null;
  // E-mail drafts are signed by the person who works the task (the assignee).
  const senderName = workspace?.task.assignedToYou && workspace.task.assigneeName ? workspace.task.assigneeName : 'Purchase team';
  return (
    <WorkErrorBoundary title="Purchase task">
      {bookingChange ? <BookingChangeBanner change={bookingChange} action={bookingChange.canAck ? act(acknowledgeBookingChangeAction) : null} /> : null}
      <PurchaseTaskPage
        task={task}
        tabs={{ tabs, current }}
        // D6: the tab the bare address opens keeps it; Details gets "?tab=details", so the holder can still reach it.
        defaultTab={defaultTaskTab(tabs, holdsTask)}
        managerReadOnly={managerReadOnly}
        goAheadState={workspace?.goAhead.state ?? null}
        nextText={workspace ? purchaseNextText(workspace) : undefined}
        idProofs={idProofs !== null ? <TravellerIdProofsCard state={idProofs} /> : undefined}
        work={
          current === 'work' && (workspace || workForm) ? (
            <WorkStack>
              {reconfirmPanel}
              {workspace ? <PurchaseWorkTab ws={workspace} payments={payments} actions={workActions} senderName={senderName} /> : null}
              {voucherPanel}
              {workForm ? <DepartmentCostCard taskId={task.taskId} department="purchase" costs={workForm.costs} canRecord={false} readOnlyReason={workForm.readOnlyReason} /> : null}
            </WorkStack>
          ) : undefined
        }
        files={current === 'files' ? { purchase: workspace?.evidence, department: workForm?.documents, idProofs } : undefined}
        filesExtra={
          current === 'files' && workspace ? (
            <SupplierDocumentsSection ctx={payments} documentAction={act(uploadSupplierDocumentAction)} uploadAction={act(uploadSupplierMoneyFileAction)} linkAction={act(linkSupplierDocumentAction)} />
          ) : undefined
        }
        history={current === 'history' ? toTaskHistoryVM(historyLoad, 'purchase') : undefined}
      />
    </WorkErrorBoundary>
  );
}

/** Addendum L10: the viewer's other tasks of the Deal whose reconfirmation in the same change was voided. */
async function voidedSiblings(staff: Awaited<ReturnType<typeof requireStaff>>, taskId: string, dealReference: string, refNo: string): Promise<Array<{ taskId: string; serviceTitle: string; href: string }>> {
  const queue = await loadPurchaseQueue(staff).catch(() => null);
  const mine = (queue?.tasks ?? []).filter((t) => t.taskId !== taskId && t.dealReference === dealReference && t.assignedToYou);
  const reads = await Promise.all(mine.map(async (t) => ({ t, r: await loadTaskReconfirmation(staff, t.taskId).catch(() => null) })));
  return reads
    .filter(({ r }) => r && r.changeRequest.refNo === refNo && r.reconfirmation.status === 'void')
    .map(({ t }) => ({ taskId: t.taskId, serviceTitle: t.itemTitle, href: `/app/purchase/${t.taskId}?tab=work#reconfirm` }));
}
