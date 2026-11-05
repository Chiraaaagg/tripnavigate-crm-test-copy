import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { bitrixIdProofCopyAlerts, bitrixIdProofCopyStatus, travellerIdProofsForDeal, travellerIdProofsForTask } from '../b11-commands';
import { toDealIdProofsView, toIdProofCopyAlertViews, toIdProofCopyView, toTaskIdProofsView } from '../b11-dto';
import { asRpcClient, BookingCommandError, isFunctionMissing } from '../commands';
import type { DealIdProofsView, IdProofCopyAlertsView, IdProofCopyManualCheckView, IdProofCopyView, TaskIdProofsView } from '../contracts';

/**
 * "Traveller ID proofs" on a Purchase, Flight or Visa & Passport task (B1.2
 * freeze note §2.2, DEC-41): traveller_id_proofs_for_task under the viewer's
 * own session. Answers:
 *   - the task's participants and their stored identity proofs (names and
 *     files only: never money, contacts or typed ID numbers);
 *   - null when the database answers null (the viewer is not the task's
 *     assignee or the Deal's branch Sales Manager, or the task is not
 *     visible), for a malformed id, or when the database has no 0100 yet
 *     (function missing): the screen shows nothing;
 *   - ID_PROOFS_REFUSED when the database refused the session itself
 *     (not_authorized is raised only for an invalid session) or the session
 *     ended: the page must not hide that as "no proofs"; it sends the user
 *     through the normal sign-in / second-factor path.
 * An unexplained failure throws a retry message, never database text. Each
 * download goes through the audited route (idProofDownloadHref).
 */

type Staff = Pick<StaffContext, 'supabase'>;

export const ID_PROOFS_REFUSED = 'refused' as const;

export async function loadTaskIdProofs(staff: Staff, taskId: string): Promise<TaskIdProofsView | null | typeof ID_PROOFS_REFUSED> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    const record = await travellerIdProofsForTask(asRpcClient(staff.supabase), id.data);
    return record ? toTaskIdProofsView(record) : null;
  } catch (error) {
    if (isFunctionMissing(error)) return null;
    if (error instanceof BookingCommandError && (error.code === 'not_authorized' || error.code === 'session')) return ID_PROOFS_REFUSED;
    throw new Error('Could not load the traveller ID proofs. Please retry.');
  }
}

/**
 * The Deal's "Traveller ID proofs" (D2-5): traveller_id_proofs_for_deal under
 * the viewer's own session, for the Accounts deal screen and any other DEC-41
 * viewer (Sales owner/assignee, branch Manager, Accounts, the Deal's task
 * assignees). Every traveller by seq with stored files only. Same answers as
 * loadTaskIdProofs: null (no viewer rule, removed Deal, malformed id, not
 * installed), ID_PROOFS_REFUSED (refused or ended session), or a retry error.
 */
export async function loadDealIdProofs(staff: Staff, dealId: string): Promise<DealIdProofsView | null | typeof ID_PROOFS_REFUSED> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    const record = await travellerIdProofsForDeal(asRpcClient(staff.supabase), id.data);
    return record ? toDealIdProofsView(record) : null;
  } catch (error) {
    if (isFunctionMissing(error)) return null;
    if (error instanceof BookingCommandError && (error.code === 'not_authorized' || error.code === 'session')) return ID_PROOFS_REFUSED;
    throw new Error('Could not load the traveller ID proofs. Please retry.');
  }
}

/**
 * DEC-43: copy status of every ID proof of a Deal, keyed by proof id
 * (booking editors; null for anyone else, for a malformed id, or on a
 * database without the copy). Book now attaches these itself; this loader
 * serves other screens.
 */
export async function loadIdProofCopyStatus(staff: Staff, dealId: string): Promise<Record<string, IdProofCopyView> | null> {
  if (!z.uuid().safeParse(dealId).success) return null;
  try {
    const rows = await bitrixIdProofCopyStatus(asRpcClient(staff.supabase), dealId);
    if (!rows) return null;
    const out: Record<string, IdProofCopyView> = {};
    for (const row of rows) {
      const seen = out[row.idProofId];
      if (!seen || seen.updatedAt <= row.updatedAt) out[row.idProofId] = toIdProofCopyView(row);
    }
    return out;
  } catch (error) {
    if (isFunctionMissing(error)) return null;
    if (error instanceof BookingCommandError && (error.code === 'not_authorized' || error.code === 'not_found')) return null;
    throw new Error('Could not load the Bitrix copy status. Please retry.');
  }
}

/** One read of bitrix_id_proof_copy_alerts (Super Admin); null for everyone else or before 0700. */
async function readCopyAlerts(staff: Staff): Promise<IdProofCopyAlertsView | null> {
  try {
    const rows = await bitrixIdProofCopyAlerts(asRpcClient(staff.supabase));
    return rows ? toIdProofCopyAlertViews(rows) : null;
  } catch (error) {
    if (isFunctionMissing(error)) return null;
    if (error instanceof BookingCommandError && error.code === 'not_authorized') return null;
    throw new Error('Could not load the Bitrix copy alerts. Please retry.');
  }
}

/**
 * DEC-43 Super Admin: automatic stops of the copy (open first) and copies that
 * ended needs_manual_check. null for anyone else or before 0700.
 */
export async function loadIdProofCopyAlerts(staff: Staff): Promise<IdProofCopyAlertsView | null> {
  return readCopyAlerts(staff);
}

/** DEC-43 review E8-2, Super Admin: copies that ended needs_manual_check (newest first). null for anyone else. */
export async function loadIdProofCopyManualChecks(staff: Staff): Promise<IdProofCopyManualCheckView[] | null> {
  return (await readCopyAlerts(staff))?.manualChecks ?? null;
}
