import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import { chooseVisaCancellationAction, setVisaCancellationFeeAction } from '@/modules/cancellations/server/actions';
import { requireStaff } from '@/modules/identity/server/session';
import type { TaskTab } from '@/modules/settings/contracts';
import {
  addVisaDocumentAction,
  applyVisaApplicationsAction,
  claimVisaTaskAction,
  confirmVisaTravellerAction,
  decideVisaApplicationAction,
  markVisaDeliveredAction,
  reapplyVisaApplicationAction,
  removeVisaDocumentAction,
  saveVisaOtherCostAction,
  saveVisaRowAction,
  sendVisaFeeAction,
  setVisaHandoverAction,
  withdrawVisaApplicationAction,
} from '@/modules/visa/server/actions';
import { uploadVisaDocumentFileAction, uploadVisaEvidenceAction } from '@/modules/visa/server/evidence';
import { loadVisaWorkspace } from '@/modules/visa/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { taskTabFor } from '@/views/department/task-default-tab';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import type { VisaWorkActions } from '@/views/visa/actions';
import { VisaTaskNotAvailable, VisaTaskPage } from '@/views/visa/workspace';

export const metadata: Metadata = { title: 'Visa and passport task' };

const act = (a: unknown) => a as DecisionAction;

/** Real server actions (the preview gallery passes stubs instead). */
const ACTIONS: VisaWorkActions = {
  claim: act(claimVisaTaskAction),
  saveRow: act(saveVisaRowAction),
  addDocument: act(addVisaDocumentAction),
  removeDocument: act(removeVisaDocumentAction),
  apply: act(applyVisaApplicationsAction),
  decide: act(decideVisaApplicationAction),
  setHandover: act(setVisaHandoverAction),
  markDelivered: act(markVisaDeliveredAction),
  withdraw: act(withdrawVisaApplicationAction),
  reapply: act(reapplyVisaApplicationAction),
  sendFee: act(sendVisaFeeAction),
  saveOtherCost: act(saveVisaOtherCostAction),
  confirmTraveller: act(confirmVisaTravellerAction),
  uploadDocument: act(uploadVisaDocumentFileAction),
  uploadEvidence: act(uploadVisaEvidenceAction),
  // Accounts phase 2 (contract 7.4 C10, C11): choices and expected fee refunds after an approved trip cancellation.
  chooseCancellation: chooseVisaCancellationAction as unknown as DecisionAction,
  setCancellationFee: setVisaCancellationFeeAction as unknown as DecisionAction,
};

const TABS: TaskTab[] = ['details', 'work', 'files', 'history'];

/**
 * Visa or passport task (Visa build, contract 9.2 / 11.1): Details · Work ·
 * Files · History (?tab=, server allowlist). visa_workspace opens it to the
 * Visa desk and, read-only, to the branch Manager; the same answer for "does
 * not exist" and "not allowed". The page is a client view from the Work tab
 * down, so only the open tab's extra data is read (ID proofs on Details for
 * the assignee, History on History).
 */
export default async function VisaTaskRoute({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ taskId }, { tab }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const ws = await loadVisaWorkspace(staff, taskId);
  if (!ws) return <VisaTaskNotAvailable />;
  // D6: without ?tab=, the person who holds the task opens on Work; everyone else on Details. Every ?tab= keeps working.
  const current = taskTabFor(tab, TABS, ws.assignee.isYou);
  const [idProofs, history] = await Promise.all([
    current === 'details' && ws.assignee.isYou ? loadTaskIdProofs(staff, ws.taskId).catch(() => 'error' as const) : Promise.resolve(null),
    current === 'history' ? loadTaskHistory(staff, ws.taskId).then((h) => toTaskHistoryVM(h, 'visa')) : Promise.resolve(undefined),
  ]);
  return (
    <WorkErrorBoundary title="Visa and passport task">
      <VisaTaskPage ws={ws} tabs={{ tabs: TABS, current }} actions={ACTIONS} history={history} idProofs={idProofs !== null ? <TravellerIdProofsCard state={idProofs} /> : undefined} />
    </WorkErrorBoundary>
  );
}
