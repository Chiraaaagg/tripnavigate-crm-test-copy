import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { saveDepartmentCostAction, submitExpenseRecordAction, uploadDepartmentEvidenceAction } from '@/modules/fulfilment/server/department-actions';
import { loadDepartmentWorkForm } from '@/modules/fulfilment/server/department';
import { loadFlightTask } from '@/modules/fulfilment/server/flight';
import { claimFlightTaskAction } from '@/modules/fulfilment/server/flight-actions';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import { requireStaff } from '@/modules/identity/server/session';
import { historyTabFor, parseTaskTab, taskTabsFor } from '@/modules/settings/contracts';
import { DepartmentCostCard } from '@/views/b11/department-cost';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import { FlightTaskNotFoundView, FlightTaskPage } from '@/views/flight-views';

export const metadata: Metadata = { title: 'Flight task' };

/**
 * Flight task (FL-02, DA-16): Details · Work · Files · History (`?tab=`, server
 * allowlist). The database opens the task to the Flight role only; tabs come
 * from what it returned for this viewer, and only the open tab's extra data is
 * passed to the view.
 */
export default async function FlightTaskRoute({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ taskId }, { tab }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const [task, workForm, idProofs, historyLoad] = await Promise.all([
    loadFlightTask(staff, taskId),
    loadDepartmentWorkForm(staff, taskId).catch(() => null),
    loadTaskIdProofs(staff, taskId).catch(() => 'error' as const),
    loadTaskHistory(staff, taskId),
  ]);
  if (!task) return <FlightTaskNotFoundView />;
  const work = !!workForm;
  const files = !!workForm || !!task.files?.length || (idProofs !== null && idProofs !== 'error');
  const tabs = taskTabsFor({ work, files, history: historyTabFor(historyLoad, work || files) });
  const current = parseTaskTab(tab, tabs);
  return (
    <WorkErrorBoundary title="Flight task">
      <FlightTaskPage
        task={task}
        claimAction={claimFlightTaskAction}
        tabs={{ tabs, current }}
        idProofs={idProofs !== null ? <TravellerIdProofsCard state={idProofs} /> : undefined}
        workForm={
          current === 'work' && workForm ? (
            <DepartmentCostCard
              taskId={task.taskId}
              department="flight"
              costs={workForm.costs}
              evidence={workForm.documents}
              canRecord={workForm.canRecordCost}
              readOnlyReason={workForm.readOnlyReason}
              actions={{ save: saveDepartmentCostAction, submit: submitExpenseRecordAction, upload: uploadDepartmentEvidenceAction }}
            />
          ) : undefined
        }
        files={current === 'files' ? { flight: task.files, department: workForm?.documents, idProofs } : undefined}
        history={current === 'history' ? toTaskHistoryVM(historyLoad, 'flight') : undefined}
      />
    </WorkErrorBoundary>
  );
}
