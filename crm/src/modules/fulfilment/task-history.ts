import { z } from 'zod';
import type { RpcClient, RpcError } from './commands';

/**
 * Direction A Batch 4 (DA-16, History rule): the History tab of a Purchase,
 * Flight or Visa & Passport task, from public.department_task_history (Atlas
 * migration 20261125000100).
 *
 * The database decides who reads it (the people who open that task page
 * today) and returns only that task's events, from an allowlist of kinds,
 * with no amount or money detail. Unknown kinds a newer database adds are
 * dropped here (never shown as raw codes). Server code only.
 */

export const TASK_HISTORY_KINDS = [
  'created',
  'taken',
  'released',
  'reassigned',
  'completed',
  'offer_added',
  'offer_withdrawn',
  'cost_recorded',
  'over_budget_approved',
  'supplier_confirmed',
  'file_added',
  'file_removed',
  'sent_to_accounts',
  'accounts_accepted',
  'accounts_returned',
  'applicant_updated',
  'applicant_stage',
  'applicant_withdrawn',
  // Purchase build (20261130000120): supplier e-mails, hotel go-ahead, cancellation charges.
  'rate_request_sent',
  'booking_request_sent',
  'email_sent',
  'email_failed',
  'go_ahead_requested',
  'go_ahead_approved',
  'go_ahead_returned',
  'cancellation_charge_saved',
  // Flight build (20261201000120, contract 9.5): flight tasks only.
  'booking_change_applied',
  'sectors_entered',
  'sector_details_filled',
  'change_submitted',
  'change_approved',
  'change_rejected',
  'change_withdrawn',
  'tickets_confirmed',
  'ticket_corrected',
  'fare_approval_requested',
  'fare_approval_approved',
  'fare_approval_returned',
  'fare_approval_withdrawn',
  'direct_payment_recorded',
  'payment_requested',
  'payment_resubmitted',
  'payment_cancelled',
  'payment_approved',
  'payment_returned',
  'payment_recorded',
  'payment_verified',
] as const;
export type TaskHistoryKind = (typeof TASK_HISTORY_KINDS)[number];

/** Purchase build: History titles of the kinds added by 20261130000120 (go_ahead_returned carries Accounts' reason as its note). */
export const PURCHASE_BUILD_HISTORY_TITLE = {
  rate_request_sent: 'Rate request sent to the supplier',
  booking_request_sent: 'Booking request sent to the supplier',
  email_sent: 'E-mail sent from the CRM',
  email_failed: 'E-mail could not be sent from the CRM',
  go_ahead_requested: 'Accounts go-ahead requested',
  go_ahead_approved: 'Accounts gave the go-ahead',
  go_ahead_returned: 'Accounts returned the go-ahead',
  cancellation_charge_saved: 'Cancellation charges saved',
} as const satisfies Partial<Record<TaskHistoryKind, string>>;

/**
 * Flight build: default History titles of the flight kinds (20261201000120).
 * No amount, PNR or ticket number is ever part of an event; change_rejected,
 * ticket_corrected, fare_approval_returned and payment_returned carry the
 * reason as their note, change events their change number.
 */
export const FLIGHT_TASK_HISTORY_TITLE = {
  booking_change_applied: 'New booking applied',
  sectors_entered: 'Flights entered from the screenshot',
  sector_details_filled: 'Missing flight details filled in',
  change_submitted: 'Flight change sent',
  change_approved: 'Flight change approved',
  change_rejected: 'Flight change rejected',
  change_withdrawn: 'Flight change withdrawn',
  tickets_confirmed: 'Tickets confirmed',
  ticket_corrected: 'Ticket corrected',
  fare_approval_requested: 'Manager asked to approve the fares',
  fare_approval_approved: 'Manager approved the fares',
  fare_approval_returned: 'Manager returned the fares',
  fare_approval_withdrawn: 'Fare approval request withdrawn',
  direct_payment_recorded: 'Direct payment recorded',
  payment_requested: 'Supplier payment requested',
  payment_resubmitted: 'Supplier payment request sent again',
  payment_cancelled: 'Supplier payment request cancelled',
  payment_approved: 'Supplier payment approved',
  payment_returned: 'Supplier payment returned',
  payment_recorded: 'Supplier payment recorded by Accounts',
  payment_verified: 'Supplier payment verified by Accounts',
} as const satisfies Partial<Record<TaskHistoryKind, string>>;

const EventSchema = z.object({
  at: z.string().min(1),
  kind: z.enum(TASK_HISTORY_KINDS),
  /** Named only when the task page already shows that person ("Taken by", the current assignee); else null. */
  byName: z.string().min(1).max(200).nullable().catch(null),
  byYou: z.boolean().catch(false),
  /** reassigned: the new holder, named only when they are the current assignee. */
  toName: z.string().min(1).max(200).nullable().catch(null),
  toYou: z.boolean().catch(false),
  applicantSeq: z.number().int().positive().nullable().catch(null),
  /** applicant_stage: the visa application stage code the screen maps to words. */
  state: z.string().regex(/^[a-z_]{1,40}$/).nullable().catch(null),
  /** accounts_returned and go_ahead_returned: Accounts' reason; applicant_withdrawn: the fixed revision text; flight reasons (see above). */
  note: z.string().max(500).nullable().catch(null),
  /** Flight build: the change number of change_* events; absent (null) elsewhere. */
  changeNo: z.number().int().positive().nullable().optional().catch(null),
});
export type TaskHistoryEvent = z.output<typeof EventSchema>;

const HistorySchema = z.object({
  taskId: z.uuid(),
  department: z.enum(['purchase', 'flight', 'visa']),
  events: z
    .array(z.unknown())
    .max(200)
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = EventSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  truncated: z.boolean(),
});
export type TaskHistory = z.output<typeof HistorySchema>;

const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);

export class TaskHistoryError extends Error {
  override name = 'TaskHistoryError';
  constructor(
    readonly code: 'not_authorized' | 'not_installed' | null,
    readonly sqlState: string | null,
  ) {
    super(`department_task_history failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

/** null = not found or not readable for this person (the page shows "not available"). */
export async function departmentTaskHistory(client: RpcClient, taskId: string): Promise<TaskHistory | null> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc('department_task_history', { p_task_id: taskId });
  } catch {
    throw new TaskHistoryError(null, null);
  }
  if (result.error) {
    const state = result.error.code ?? '';
    const code = state === '42501' ? 'not_authorized' : FUNCTION_MISSING_STATES.has(state) ? 'not_installed' : null;
    throw new TaskHistoryError(code, state || null);
  }
  if (result.data === null) return null;
  const parsed = HistorySchema.safeParse(result.data);
  if (!parsed.success) throw new TaskHistoryError(null, null);
  return parsed.data;
}
