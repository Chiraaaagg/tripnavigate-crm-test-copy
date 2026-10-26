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
] as const;
export type TaskHistoryKind = (typeof TASK_HISTORY_KINDS)[number];

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
  /** accounts_returned: Accounts' reason; applicant_withdrawn: the fixed revision text. */
  note: z.string().max(500).nullable().catch(null),
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
