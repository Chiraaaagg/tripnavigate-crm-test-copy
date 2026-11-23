'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import {
  asRpcClient,
  BookingCommandError,
  confirmBooking,
  dealTravellersSave,
  readiness,
  serviceItemAdd,
  serviceItemRemove,
  serviceItemSave,
} from '../commands';
import { serviceItemTravellersSave } from '../b11-commands';
import {
  type BookingActionResult,
  type BookingErrorCode,
  type ConfirmBookingResult,
  ERROR_TEXT,
  INTAKE_CONFIRM_EXISTING_TEXT,
  INTAKE_CONFIRM_NO_TASK_TEXT,
  INTAKE_CONFIRM_SUCCESS_TEXT,
  SERVICE_TYPE_LABEL,
  type ServiceItemAddResult,
  type ServiceItemRemoveResult,
  type ServiceItemSaveResult,
  type TravellersSaveResult,
  UNKNOWN_OUTCOME_TEXT,
} from '../contracts';
import { FIELD, parseServiceItemForm, parseTravellersForm, readContentHash, readRowVersion, readUuid } from '../forms';

/**
 * Intake screen commands (contract §7.1). Same shape as actions.ts:
 *   1. requireStaff(): verified aal2 session, active staff.
 *   2. Parse the form; never the actor, entity, branch or ownership.
 *   3. Run the database command under the staff member's OWN session; the
 *      database authorizes, validates the facts again, audits and decides.
 * Results carry frozen ERROR_TEXT wording. A failure the database did not
 * explain is rethrown as UNKNOWN_OUTCOME_TEXT because the command may have
 * committed; it is never reported as "nothing changed".
 *
 * Signatures fit useActionState: (previous result | null, FormData).
 */

type Prev<T> = BookingActionResult<T> | null;

const dealPath = (dealId: string) => `/app/deals/${dealId}`;
const intakePath = (dealId: string) => `/app/deals/${dealId}/intake`;
const PURCHASE_PATH = '/app/purchase';
const FLIGHT_PATH = '/app/flight';

function fail(code: BookingErrorCode | 'session', fields?: string[]): BookingActionResult<never> {
  if (fields && fields.length > 0) return { ok: false, code, message: ERROR_TEXT[code], fields };
  return { ok: false, code, message: ERROR_TEXT[code] };
}

function failFrom(error: unknown): BookingActionResult<never> {
  if (error instanceof BookingCommandError && error.code) return fail(error.code);
  throw new Error(UNKNOWN_OUTCOME_TEXT);
}

function revalidateDeal(dealId: string): void {
  revalidatePath(dealPath(dealId));
  revalidatePath(intakePath(dealId));
  // B1.1: the Book now form shows the same services.
  revalidatePath(`${dealPath(dealId)}/book`);
  revalidatePath('/app/deals/[id]/book', 'layout'); // the overview, the booking form layout (route group) and its steps
}

/**
 * B1.1: after the item command, save who takes part when the form carried
 * participantSeq inputs. The row version is the one the item command
 * returned. A participation refusal after a saved item is reported in words.
 */
async function saveParticipants(
  rpc: ReturnType<typeof asRpcClient>,
  input: { itemId: string; versionId: string; rowVersion: number; seqs: number[] | null },
): Promise<{ ok: true; rowVersion: number; contentHash: string | null } | { ok: false; failure: BookingActionResult<never> }> {
  if (input.seqs === null) return { ok: true, rowVersion: input.rowVersion, contentHash: null };
  try {
    const r = await serviceItemTravellersSave(rpc, { itemId: input.itemId, versionId: input.versionId, expectedRowVersion: input.rowVersion, seqs: input.seqs });
    return { ok: true, rowVersion: r.rowVersion, contentHash: r.contentHash };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code) {
      const base = fail(error.code, error.code === 'invalid_input' ? [FIELD.participantSeq] : undefined);
      if (base.ok) return { ok: false, failure: base };
      return { ok: false, failure: { ...base, message: `The service was saved. Who takes part was not saved: ${base.message}` } };
    }
    throw new Error(UNKNOWN_OUTCOME_TEXT);
  }
}

/** Database hint keys of service facts → form field names (flight preferences have their own input). */
function factHintFields(error: unknown, serviceType: string): string[] | undefined {
  if (!(error instanceof BookingCommandError) || error.code !== 'invalid_input' || error.hintKeys.length === 0) return undefined;
  return error.hintKeys.map((k) => (serviceType === 'flight' && k === 'preferences' ? FIELD.flightPreferences : k.replace(/\[\d+\].*$/, '').replace(/\..*$/, '')));
}

function isCode(error: unknown, code: BookingErrorCode): boolean {
  return error instanceof BookingCommandError && error.code === code;
}

export async function addServiceItemAction(_prev: Prev<ServiceItemAddResult>, formData: FormData): Promise<BookingActionResult<ServiceItemAddResult>> {
  const staff = await requireStaff();
  const parsed = parseServiceItemForm(formData);
  // An add needs the replay key so an exact retry never creates a second item.
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  if (parsed.value.itemId !== null || !parsed.value.requestId) return fail('invalid_input');
  const { dealId, versionId, expectedRowVersion, serviceType, facts, purchaseBudgetPaise, requestId, participantSeqs } = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let result: ServiceItemAddResult;
  try {
    result = await serviceItemAdd(rpc, {
      versionId,
      expectedRowVersion,
      serviceType,
      facts: facts.facts,
      purchaseBudgetPaise,
      requestId,
    });
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateDeal(dealId);
    const fields = factHintFields(error, serviceType);
    return fields ? fail('invalid_input', fields) : failFrom(error);
  }
  const people = await saveParticipants(rpc, { itemId: result.itemId, versionId, rowVersion: result.rowVersion, seqs: participantSeqs });
  revalidateDeal(dealId);
  if (!people.ok) return people.failure;
  return {
    ok: true,
    data: { ...result, rowVersion: people.rowVersion, contentHash: people.contentHash ?? result.contentHash },
    message: `${SERVICE_TYPE_LABEL[serviceType]} added as service ${result.itemNo}. The draft is not confirmed yet.`,
  };
}

export async function saveServiceItemAction(_prev: Prev<ServiceItemSaveResult>, formData: FormData): Promise<BookingActionResult<ServiceItemSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseServiceItemForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  if (parsed.value.itemId === null) return fail('invalid_input');
  const { dealId, versionId, expectedRowVersion, itemId, facts, purchaseBudgetPaise, participantSeqs, serviceType } = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let result: ServiceItemSaveResult;
  try {
    result = await serviceItemSave(rpc, {
      itemId,
      versionId,
      expectedRowVersion,
      facts: facts.facts,
      purchaseBudgetPaise,
    });
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateDeal(dealId);
    const fields = factHintFields(error, serviceType);
    return fields ? fail('invalid_input', fields) : failFrom(error);
  }
  const people = await saveParticipants(rpc, { itemId, versionId, rowVersion: result.rowVersion, seqs: participantSeqs });
  revalidateDeal(dealId);
  if (!people.ok) return people.failure;
  return {
    ok: true,
    data: { rowVersion: people.rowVersion, contentHash: people.contentHash ?? result.contentHash },
    message: 'Service saved. The draft is not confirmed yet.',
  };
}

export async function removeServiceItemAction(
  _prev: Prev<ServiceItemRemoveResult>,
  formData: FormData,
): Promise<BookingActionResult<ServiceItemRemoveResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  const itemId = readUuid(formData, FIELD.itemId);
  const expectedRowVersion = readRowVersion(formData);
  if (!dealId || !versionId || !itemId || expectedRowVersion === null) return fail('invalid_input');
  try {
    const result = await serviceItemRemove(asRpcClient(staff.supabase), { itemId, versionId, expectedRowVersion });
    revalidateDeal(dealId);
    return { ok: true, data: result, message: 'Service removed from the draft.' };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'item_locked')) revalidateDeal(dealId);
    return failFrom(error);
  }
}

export async function saveTravellersAction(_prev: Prev<TravellersSaveResult>, formData: FormData): Promise<BookingActionResult<TravellersSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseTravellersForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { dealId, expectedRowVersion, travellers } = parsed.value;
  try {
    const result = await dealTravellersSave(asRpcClient(staff.supabase), { dealId, expectedRowVersion, travellers });
    revalidateDeal(dealId);
    const n = travellers.length;
    return { ok: true, data: result, message: n === 0 ? 'Traveller list cleared.' : `${n} ${n === 1 ? 'traveller' : 'travellers'} saved.` };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'traveller_identity_locked')) revalidateDeal(dealId);
    return failFrom(error);
  }
}

function fill(template: string, taskCount: number): string {
  return template.replace('{taskCount}', String(taskCount)).replace('{taskNoun}', taskCount === 1 ? 'task' : 'tasks');
}

/**
 * "Save accepted version and create tasks" (= booking_confirm). On not_ready
 * the repair list comes from the side-effect-free readiness read, like
 * confirmBookingAction.
 */
export async function confirmIntakeAction(_prev: Prev<ConfirmBookingResult>, formData: FormData): Promise<BookingActionResult<ConfirmBookingResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  const expectedContentHash = readContentHash(formData);
  if (!dealId || !versionId || !expectedContentHash) return fail('invalid_input');

  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await confirmBooking(rpc, { versionId, expectedContentHash });
    revalidateDeal(dealId);
    revalidatePath(PURCHASE_PATH);
    revalidatePath(FLIGHT_PATH);
    revalidatePath('/app/visa');
    const taskCount = result.taskIds?.length ?? (result.taskId ? 1 : 0);
    // B1.1: a standalone visa or passport while the desk is off creates no task (taskId null).
    const message =
      result.outcome === 'existing'
        ? INTAKE_CONFIRM_EXISTING_TEXT
        : taskCount === 0
          ? INTAKE_CONFIRM_NO_TASK_TEXT
          : fill(INTAKE_CONFIRM_SUCCESS_TEXT, taskCount);
    return { ok: true, data: result, message };
  } catch (error) {
    if (isCode(error, 'not_ready')) {
      const issues = await readiness(rpc, versionId)
        .then((r) => r.issues)
        .catch(() => undefined);
      revalidateDeal(dealId);
      return { ok: false, code: 'not_ready', message: ERROR_TEXT.not_ready, ...(issues ? { issues } : {}) };
    }
    if (isCode(error, 'version_changed')) revalidateDeal(dealId);
    return failFrom(error);
  }
}
