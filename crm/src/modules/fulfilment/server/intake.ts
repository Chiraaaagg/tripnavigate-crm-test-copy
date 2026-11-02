import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  asRpcClient,
  BookingCommandError,
  bookingPanel,
  DEAL_SERVICE_SUMMARY_MAX_IDS,
  dealServices,
  dealServiceSummary,
  intakeChecklist,
  isFunctionMissing,
  workflowSettingsGet,
} from '../commands';
import type { DealServiceSummaryView, DealServicesView, IntakeView, WorkflowSettingsView } from '../contracts';
import { toDealServiceSummary, toDealServicesView, toIntakeView, toWorkflowSettingsView } from '../dto';

/**
 * B1 reads for the intake screen, the Deal page services card and the Deals
 * list progress column. Everything runs under the staff member's own session;
 * the database decides visibility. "Not visible" and "does not exist" both
 * return null/empty; a failure the database did not explain throws.
 *
 * Rollout (contract §13): this app may run against a database that does not
 * have the B1 functions yet. PostgREST answers PGRST202 ("function not found")
 * for them; the loaders treat that like the switch being off (settings off,
 * no summaries) rather than an error, so the Deal page and Deals list keep
 * working exactly as before the migration.
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

const REFUSED = new Set(['not_authorized', 'not_found']);
function isRefusal(error: unknown): boolean {
  return error instanceof BookingCommandError && error.code !== null && REFUSED.has(error.code);
}

/** PGRST202 / 42883: the function does not exist yet (older database). */
function isMissingFunction(error: unknown): boolean {
  return isFunctionMissing(error);
}

const SETTINGS_OFF: WorkflowSettingsView = {
  intakePromptEnabled: false,
  serviceItemsEnabled: false,
  visaPassportTasksEnabled: false,
  updatedAt: null,
};

/**
 * The B1 switches. Both are off when the database has no workflow_settings
 * function yet or refuses the read; an unexplained failure throws.
 */
export async function loadWorkflowSettings(staff: Pick<StaffContext, 'supabase'>): Promise<WorkflowSettingsView> {
  try {
    return toWorkflowSettingsView(await workflowSettingsGet(asRpcClient(staff.supabase)));
  } catch (error) {
    if (isRefusal(error) || isMissingFunction(error)) return SETTINGS_OFF;
    throw new Error('Could not load the workflow switches. Please retry.');
  }
}

/**
 * The Workflow switches page: the switches exactly as the database returns
 * them, with no fallback to off. Any failure throws (the page then says the
 * state is unknown), and a switch the database does not return stays
 * undefined so the page shows it as Unknown, never as Off.
 */
export async function loadWorkflowSwitchStates(staff: Pick<StaffContext, 'supabase'>): Promise<WorkflowSettingsView> {
  try {
    return await workflowSettingsGet(asRpcClient(staff.supabase));
  } catch {
    throw new Error('Could not load the workflow switches. Please retry.');
  }
}

interface DealHeaderRow {
  id: string;
  legal_entity_id: string;
  branch_id: string;
  owner_user_id: string | null;
  reference: string;
  title: string;
  source_system: string | null;
  source_stage_id: string | null;
}

/** Deal header and scope facts under the viewer's session (RLS); null when not visible. Shared with the Book now loader. */
export async function dealHeader(staff: Staff, dealId: string) {
  const [deal, assignments] = await Promise.all([
    staff.supabase
      .from('deals')
      .select('id, legal_entity_id, branch_id, owner_user_id, reference, title, source_system, source_stage_id')
      .eq('id', dealId)
      .maybeSingle(),
    staff.supabase.from('deal_assignments').select('user_id').eq('deal_id', dealId).is('ended_at', null),
  ]);
  if (deal.error || assignments.error) throw new Error('Could not load the intake screen. Please retry.');
  const row = deal.data as DealHeaderRow | null;
  if (!row) return null;
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    ownerUserId: row.owner_user_id,
    activeAssigneeIds: ((assignments.data ?? []) as Array<{ user_id: string }>).map((a) => a.user_id),
    reference: row.reference,
    title: row.title,
    sourceSystem: row.source_system,
    sourceStageId: row.source_stage_id,
  };
}

/**
 * SCR-INTAKE. null = malformed id, Deal not visible, or the viewer may not
 * read the booking (Purchase, Flight). The route redirects to the Deal page
 * when `serviceItemsEnabled` is false (freeze note §6); this loader still
 * returns the view so the route can decide with one read.
 */
export async function loadIntake(staff: Staff, dealId: string): Promise<IntakeView | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  const deal = await dealHeader(staff, id.data);
  if (!deal) return null;
  const rpc = asRpcClient(staff.supabase);
  try {
    const [settings, panel, services, checklist] = await Promise.all([
      loadWorkflowSettings(staff),
      bookingPanel(rpc, id.data),
      dealServices(rpc, id.data),
      intakeChecklist(rpc, id.data),
    ]);
    if (!panel || !services) return null;
    return toIntakeView({ viewer: staff.access, deal, settings, panel, services, checklist });
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the intake screen. Please retry.');
  }
}

/** Deal page "Services sold" card. null = not visible, malformed id, or a database without B1 yet. */
export async function loadDealServices(staff: Pick<StaffContext, 'supabase'>, dealId: string): Promise<DealServicesView | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    const record = await dealServices(asRpcClient(staff.supabase), id.data);
    return record ? toDealServicesView(record) : null;
  } catch (error) {
    if (isRefusal(error) || isMissingFunction(error)) return null;
    throw new Error('Could not load the services of this deal. Please retry.');
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Deals list projection: one summary per visible Deal, read in chunks of 50
 * (the database limit). Invisible Deals are simply absent. An older database
 * (no function yet) or a refusal gives an empty map; the Deals list then shows
 * its notice row. An unexplained failure throws.
 */
export async function loadDealServiceSummaries(
  staff: Pick<StaffContext, 'supabase'>,
  dealIds: string[],
): Promise<Map<string, DealServiceSummaryView>> {
  const ids = [...new Set(dealIds.filter((id) => z.uuid().safeParse(id).success))];
  const result = new Map<string, DealServiceSummaryView>();
  if (ids.length === 0) return result;
  const rpc = asRpcClient(staff.supabase);
  try {
    const pages = await Promise.all(chunk(ids, DEAL_SERVICE_SUMMARY_MAX_IDS).map((page) => dealServiceSummary(rpc, page)));
    for (const page of pages) {
      for (const record of page) result.set(record.dealId, toDealServiceSummary(record));
    }
    return result;
  } catch (error) {
    if (isRefusal(error) || isMissingFunction(error)) return new Map();
    throw new Error('Could not load the progress of your deals. Please retry.');
  }
}
