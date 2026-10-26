import { VISA_APPLICATION_STATE_LABEL, type VisaApplicationState } from '@/modules/fulfilment/contracts';
import type { DepartmentTaskHistoryRecord, TaskHistoryEventVM, TaskHistoryVM } from '@/modules/settings/contracts';

/*
 * History tab of a Purchase, Flight or Visa & Passport task (DA-16, DA-270,
 * screen plan "History rule"). Pure: the route loads the record
 * (loadTaskHistory) and passes it through here. The database already returns
 * only that task's events, from an allowlist of kinds, with no amount, and
 * names only people the task page already shows (money-privacy-settings §10
 * T-B4-05). Everyone else is "Another staff member". No event carries money.
 */

export type TaskHistoryDepartment = 'purchase' | 'flight' | 'visa';

export const TASK_HISTORY_TEXT = {
  empty: 'No history you can see on this task yet.',
  error: 'History did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.',
  notInstalled: 'History is not available in this CRM yet. Nothing is missing from the task itself.',
  truncated: 'Only the latest 200 events are shown.',
  someoneElse: 'Another staff member',
} as const;

const STAGE_EXTRA: Record<string, string> = {
  documents_returned: 'Documents returned to the customer',
  customer_informed: 'Customer informed',
};

function stageText(state: string | null): string {
  if (!state) return 'stage changed';
  return VISA_APPLICATION_STATE_LABEL[state as VisaApplicationState] ?? STAGE_EXTRA[state] ?? 'stage changed';
}

function applicant(seq: number | null): string {
  return seq ? `Applicant ${seq}` : 'An applicant';
}

type Event = DepartmentTaskHistoryRecord['events'][number];

function title(e: Event, department: TaskHistoryDepartment): string {
  switch (e.kind) {
    case 'created':
      return 'Task created from the submitted booking';
    case 'taken':
      return 'Task taken';
    case 'released':
      return 'Task handed back';
    case 'reassigned':
      return e.toYou ? 'Task moved to you' : e.toName ? `Task moved to ${e.toName}` : `Task moved to ${TASK_HISTORY_TEXT.someoneElse.toLowerCase()}`;
    case 'completed':
      return 'Task completed';
    case 'offer_added':
      return 'Supplier offer added';
    case 'offer_withdrawn':
      return 'Supplier offer withdrawn';
    case 'cost_recorded':
      return department === 'purchase' ? 'Cost proposed' : 'Cost recorded';
    case 'over_budget_approved':
      return 'Cost above budget: approved';
    case 'supplier_confirmed':
      // DA-318a: Flight says what the CRM recorded, as Purchase does.
      return department === 'visa' ? 'Confirmed' : 'Confirmed by supplier';
    case 'file_added':
      return 'File added';
    case 'file_removed':
      return 'File removed';
    case 'sent_to_accounts':
      return 'Cost sent to Accounts';
    case 'accounts_accepted':
      return 'Accounts accepted the cost (recorded only; not approved for payment)';
    case 'accounts_returned':
      return 'Accounts returned the cost';
    case 'applicant_updated':
      return `${applicant(e.applicantSeq)}: details updated`;
    case 'applicant_stage':
      return `${applicant(e.applicantSeq)}: ${stageText(e.state)}`;
    case 'applicant_withdrawn':
      return `${applicant(e.applicantSeq)}: application withdrawn`;
  }
}

function byText(e: Event): string | null {
  if (e.kind === 'created') return null;
  if (e.byYou) return 'You';
  return e.byName ?? TASK_HISTORY_TEXT.someoneElse;
}

/**
 * Record → view model. `null` (the viewer may not read this task's history)
 * stays null: the page then has no History tab. A failed read is an error,
 * never "no history".
 */
export function toTaskHistoryVM(
  load: DepartmentTaskHistoryRecord | null | 'not_installed' | 'error',
  department: TaskHistoryDepartment,
): TaskHistoryVM | null {
  if (load === null) return null;
  if (load === 'error') return { state: 'error' };
  if (load === 'not_installed') return { state: 'not_installed' };
  const events: TaskHistoryEventVM[] = load.events.map((e, index) => ({
    id: `${index}-${e.kind}-${e.at}`,
    kind: e.kind,
    at: e.at,
    title: title(e, department),
    byText: byText(e),
    detail: e.note && (e.kind === 'accounts_returned' || e.kind === 'applicant_withdrawn') ? `Reason: ${e.note}` : undefined,
  }));
  return { state: 'ok', events };
}
