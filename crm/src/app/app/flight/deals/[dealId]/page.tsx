import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { loadDepartmentWorkForm } from '@/modules/fulfilment/server/department';
import { loadTaskIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { loadTaskHistory } from '@/modules/fulfilment/server/task-history';
import {
  acknowledgeFlightChangeAction,
  applyFlightBookingChangeAction,
  claimFlightGroupAction,
  completeFlightGroupAction,
  correctFlightTicketAction,
  fillFlightSectorBlanksAction,
  reassignFlightGroupAction,
  saveFlightScreenshotSectorsAction,
  submitFlightChangeAction,
  withdrawFlightChangeAction,
} from '@/modules/flight/server/actions';
import {
  addFlightSupplierBeneficiaryAction,
  createFlightSupplierAction,
  saveFlightSupplierInvoiceAction,
  updateFlightSupplierAction,
  uploadFlightSupplierFileAction,
  withdrawFlightFareApprovalAction,
} from '@/modules/flight/server/money-actions';
import { loadFlightFareApprovalSets, loadFlightMoney, loadFlightPaymentContext, loadFlightSuppliers } from '@/modules/flight/server/money-queries';
import { loadFlightWorkspace } from '@/modules/flight/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { parseTaskTab, type DepartmentTaskHistoryRecord, type TaskTab } from '@/modules/settings/contracts';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import type { FlightWorkActions } from '@/views/flight/actions';
import type { FlightPaymentContext, FlightWorkspace } from '@/views/flight/types';
import { FlightWorkspaceNotFound, FlightWorkspacePage } from '@/views/flight/workspace';
import {
  flightConfirmTicketsUi,
  flightCreateSupplierUi,
  flightDirectPaymentUi,
  flightFarePreviewUi,
  flightPaymentRequestUi,
  flightRequestFareApprovalUi,
  flightUploadFileUi,
} from '../../flight-ui-actions';

export const metadata: Metadata = { title: 'Flights' };

const act = (a: unknown) => a as DecisionAction;

/** Real server actions for the workspace (the preview gallery passes stubs instead). */
const ACTIONS: FlightWorkActions = {
  claim: act(claimFlightGroupAction),
  reassign: act(reassignFlightGroupAction),
  applyBookingChange: act(applyFlightBookingChangeAction),
  saveScreenshotSectors: act(saveFlightScreenshotSectorsAction),
  fillBlanks: act(fillFlightSectorBlanksAction),
  submitChange: act(submitFlightChangeAction),
  withdrawChange: act(withdrawFlightChangeAction),
  acknowledgeChange: act(acknowledgeFlightChangeAction),
  correctTicket: act(correctFlightTicketAction),
  uploadFile: act(flightUploadFileUi),
  complete: act(completeFlightGroupAction),
  farePreview: act(flightFarePreviewUi),
  requestFareApproval: act(flightRequestFareApprovalUi),
  withdrawFareApproval: act(withdrawFlightFareApprovalAction),
  confirmTickets: act(flightConfirmTicketsUi),
  createSupplier: act(flightCreateSupplierUi),
  saveDirectPayment: act(flightDirectPaymentUi),
  createPaymentRequest: act(flightPaymentRequestUi),
  invoices: { uploadSupplierFile: act(uploadFlightSupplierFileAction), saveInvoice: act(saveFlightSupplierInvoiceAction) },
  suppliers: { createSupplier: act(createFlightSupplierAction), addBeneficiary: act(addFlightSupplierBeneficiaryAction), updateSupplier: act(updateFlightSupplierAction) },
};

const TABS: TaskTab[] = ['details', 'work', 'files', 'history'];

/** The group's task histories as one list, newest first (each read is already filtered for this viewer). */
function mergeHistories(loads: Array<Awaited<ReturnType<typeof loadTaskHistory>>>): DepartmentTaskHistoryRecord | null | 'error' | 'not_installed' {
  const ok = loads.filter((l): l is DepartmentTaskHistoryRecord => !!l && typeof l === 'object');
  if (ok.length === 0) return loads.includes('error') ? 'error' : loads.includes('not_installed') ? 'not_installed' : null;
  return { ...ok[0]!, truncated: ok.some((l) => l.truncated), events: ok.flatMap((l) => l.events).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) };
}

/**
 * Flight workspace (Flight build, contract 9.2 / 11.1): one page per Deal
 * covering all its flight tasks, Details · Work · Files · History (`?tab=`,
 * server allowlist; `?flight=` focuses one flight). flight_workspace opens
 * it to the Flight role and the branch Manager only; flight money comes from
 * flight_money, built per role by the database (Purchase and Visa get none).
 * Only the open tab's extra data is read.
 */
export default async function FlightWorkspaceRoute({
  params,
  searchParams,
}: {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ tab?: string | string[]; flight?: string | string[] }>;
}) {
  const [{ dealId }, { tab, flight }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const dto = await loadFlightWorkspace(staff, dealId);
  if (!dto) return <FlightWorkspaceNotFound />;
  const current = parseTaskTab(tab, TABS);
  const taskIds = dto.flights.map((f) => f.taskId);
  const focus = typeof flight === 'string' && taskIds.includes(flight) ? flight : null;

  // Screens get view models only: screenshot links go to the existing audited download route.
  const ws: FlightWorkspace = {
    ...dto,
    flights: dto.flights.map((f) => ({ ...f, screenshots: f.screenshots.map((s) => ({ ...s, href: `/app/flight/files/${s.fileId}` })) })),
  };

  const needMoney = current === 'work' || current === 'details' || current === 'files';
  const [money, suppliers, idProofs, approvalSets] = await Promise.all([
    needMoney ? loadFlightMoney(staff, dto.dealId).catch(() => 'error' as const) : Promise.resolve(null),
    current === 'work' && dto.canWork ? loadFlightSuppliers(staff).catch(() => []) : Promise.resolve([]),
    current === 'details' && dto.assignee.isYou && taskIds[0] ? loadTaskIdProofs(staff, taskIds[0]).catch(() => 'error' as const) : Promise.resolve(null),
    current === 'work' && dto.canWork ? loadFlightFareApprovalSets(staff, dto.dealId).catch(() => null) : Promise.resolve(null),
  ]);

  // Payment drawers: only for batches the Flight person can pay or request now.
  const paymentContexts: Record<string, FlightPaymentContext> = {};
  if (current === 'work' && money && money !== 'error') {
    const open = money.batches.filter((b) => b.canPayDirect || b.canRequest);
    const contexts = await Promise.all(open.map((b) => loadFlightPaymentContext(staff, b.batchId).catch(() => null)));
    open.forEach((b, i) => {
      const c = contexts[i];
      if (c) paymentContexts[b.batchId] = c;
    });
  }

  const files =
    current === 'files'
      ? await Promise.all(taskIds.map((id) => loadDepartmentWorkForm(staff, id).catch(() => null))).then((forms) => ({
          flight: ws.flights.flatMap((f) =>
            f.screenshots.map((s) => ({
              fileId: s.fileId,
              kind: 'flight_screenshot' as const,
              fileName: s.fileName,
              sizeLabel: s.sizeBytes >= 1024 * 1024 ? `${(s.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(s.sizeBytes / 1024))} KB`,
              uploadedAt: '',
              uploadedByYou: false,
              downloadHref: `/app/flight/files/${s.fileId}`,
              canRemove: false,
            })),
          ),
          // E-tickets are listed on their own card; the other department files of each flight here.
          department: forms.flatMap((w) => (w?.documents ?? []).filter((d) => (d.kind as string) !== 'e_ticket')),
        }))
      : undefined;

  const history = current === 'history' ? toTaskHistoryVM(mergeHistories(await Promise.all(taskIds.map((id) => loadTaskHistory(staff, id)))), 'flight') : undefined;

  return (
    <WorkErrorBoundary title="Flights">
      <FlightWorkspacePage
        ws={ws}
        tabs={{ tabs: TABS, current }}
        actions={ACTIONS}
        money={money}
        suppliers={suppliers}
        paymentContexts={paymentContexts}
        files={files}
        history={history}
        idProofs={idProofs !== null ? <TravellerIdProofsCard state={idProofs} /> : undefined}
        focusTaskId={focus}
        approvalSets={approvalSets ?? []}
        eTicketBase="/app/flight/e-tickets"
      />
    </WorkErrorBoundary>
  );
}
