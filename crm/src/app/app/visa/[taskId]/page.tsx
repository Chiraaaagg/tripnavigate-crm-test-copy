import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { saveDepartmentCostAction, submitExpenseRecordAction, uploadDepartmentEvidenceAction } from '@/modules/fulfilment/server/department-actions';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import { loadVisaTask } from '@/modules/fulfilment/server/visa';
import {
  claimVisaTaskAction,
  markVisaDecisionPendingAction,
  recordCustomerInformedAction,
  recordDocumentsReturnedAction,
  recordVisaOutcomeAction,
  recordVisaSubmissionAction,
  setApplicantDocumentAction,
  withdrawVisaApplicationAction,
} from '@/modules/fulfilment/server/visa-actions';
import { requireStaff } from '@/modules/identity/server/session';
import { historyTabFor, parseTaskTab, taskTabsFor } from '@/modules/settings/contracts';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { VisaTaskNotAvailableView, VisaTaskPage } from '@/views/b11/visa-desk';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';

export const metadata: Metadata = { title: 'Visa and passport task' };

/**
 * Visa and passport task (VI-02, DA-16). Same answer for "does not exist" and
 * "not yours", so ids cannot be probed. VisaTaskPage is a client component:
 * only the open tab's Files or History data is passed (T-B4-08).
 */
export default async function VisaTaskRoute({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ taskId }, { tab }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const [task, idProofs, historyLoad] = await Promise.all([
    loadVisaTask(staff, taskId),
    loadTaskIdProofs(staff, taskId).catch(() => 'error' as const),
    loadTaskHistory(staff, taskId),
  ]);
  if (!task) return <VisaTaskNotAvailableView />;
  // Only the desk and the branch Manager read a visa task: Work and Files always exist for them.
  const tabs = taskTabsFor({ work: true, files: true, history: historyTabFor(historyLoad, true) });
  const current = parseTaskTab(tab, tabs);
  // Echo-A L6 / T-B4-08: VisaTaskPage is a client component, so only the open tab's data goes to the browser.
  // Applicants, their documents and the costs belong to Work; Files gets the documents through `files`.
  const pageTask = current === 'work' ? task : { ...task, applicantCount: task.applicantCount ?? task.applicants.length, applicants: [], evidence: [], costs: [] };
  return (
    <WorkErrorBoundary title="Visa and passport task">
      <VisaTaskPage
        task={pageTask}
        tabs={{ tabs, current }}
        idProofs={idProofs ? <TravellerIdProofsCard state={idProofs} /> : undefined}
        files={current === 'files' ? { department: task.evidence, idProofs } : undefined}
        history={current === 'history' ? toTaskHistoryVM(historyLoad, 'visa') : undefined}
        actions={{
          claim: claimVisaTaskAction,
          setDocument: setApplicantDocumentAction,
          recordSubmission: recordVisaSubmissionAction,
          decisionPending: markVisaDecisionPendingAction,
          recordOutcome: recordVisaOutcomeAction,
          withdraw: withdrawVisaApplicationAction,
          documentsReturned: recordDocumentsReturnedAction,
          customerInformed: recordCustomerInformedAction,
          upload: uploadDepartmentEvidenceAction,
          cost: { save: saveDepartmentCostAction, submit: submitExpenseRecordAction, upload: uploadDepartmentEvidenceAction },
        }}
      />
    </WorkErrorBoundary>
  );
}
