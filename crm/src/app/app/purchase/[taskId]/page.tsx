import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { loadDepartmentWorkForm } from '@/modules/fulfilment/server/department';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadPurchaseTask } from '@/modules/fulfilment/server/queries';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import { requireStaff } from '@/modules/identity/server/session';
import { loadPurchaseWorkspace } from '@/modules/procurement/server/queries';
import { historyTabFor, parseTaskTab, taskTabsFor } from '@/modules/settings/contracts';
import { DepartmentCostCard } from '@/views/b11/department-cost';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import { PurchaseWorkSection } from '@/views/procurement-views';
import { PurchaseTaskNotFoundView, PurchaseTaskPage } from '@/views/purchase-views';

export const metadata: Metadata = { title: 'Purchase task' };

/**
 * Purchase task (PU-02, DA-16): Details · Work · Files · History, as links
 * (`?tab=`, server allowlist). Tabs come only from what the database returned
 * for this viewer: Sales or Accounts (status only) get no tab bar and no Work,
 * Files or History data. Only the open tab's extra data is passed to the view.
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
  return (
    <WorkErrorBoundary title="Purchase task">
      <PurchaseTaskPage
        task={task}
        tabs={{ tabs, current }}
        managerReadOnly={managerReadOnly}
        idProofs={idProofs !== null ? <TravellerIdProofsCard state={idProofs} /> : undefined}
        work={
          current === 'work' && (workspace || workForm) ? (
            <>
              {workspace ? <PurchaseWorkSection ws={workspace} /> : null}
              {workForm ? <DepartmentCostCard taskId={task.taskId} department="purchase" costs={workForm.costs} canRecord={false} readOnlyReason={workForm.readOnlyReason} /> : null}
            </>
          ) : undefined
        }
        files={current === 'files' ? { purchase: workspace?.evidence, department: workForm?.documents, idProofs } : undefined}
        history={current === 'history' ? toTaskHistoryVM(historyLoad, 'purchase') : undefined}
      />
    </WorkErrorBoundary>
  );
}
