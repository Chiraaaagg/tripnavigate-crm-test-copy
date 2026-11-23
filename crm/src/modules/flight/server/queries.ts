import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  FlightCommandError,
  dealFlightHistory,
  dealFlightSummary,
  flightHomeCounts,
  flightQueue,
  flightWorkspace,
  isFlightFunctionMissing,
} from '../commands';
import type {
  DealFlightHistoryDTO,
  DealFlightSummaryDTO,
  FlightHomeCountsDTO,
  FlightQueueDTO,
  FlightWorkspaceDTO,
} from '../contracts';

/**
 * Flight workspace reads (contract sections 9.1, 9.2, 9.4) under the staff
 * member's own session. The database decides who reads what and returns
 * null for "not available to this person"; a refusal (role, scope,
 * environment) maps to null / an empty list, an unexplained failure throws a
 * plain retry message (never a fabricated empty state). No read here carries
 * flight money.
 */

type Staff = Pick<StaffContext, 'supabase'>;

function isRefusal(error: unknown): boolean {
  return error instanceof FlightCommandError
    && (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'environment_unset');
}

/** The Flight queue grouped by Deal (Flight people of the entity; the branch Manager read-only). */
export async function loadFlightQueue(staff: Staff): Promise<FlightQueueDTO> {
  try {
    return await flightQueue(asRpcClient(staff.supabase));
  } catch (error) {
    if (isRefusal(error)) return { groups: [] };
    throw new Error('Could not load the Flight queue. Please retry.');
  }
}

/** One Deal's Flight workspace; null = not found, not visible or a malformed id (indistinguishable). */
export async function loadFlightWorkspace(staff: Staff, dealId: string): Promise<FlightWorkspaceDTO | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await flightWorkspace(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load these flights. Please retry.');
  }
}

/** The Deal page flight card (Sales, branch Manager, Accounts); null for Purchase, Flight and Visa. */
export async function loadDealFlightSummary(staff: Staff, dealId: string): Promise<DealFlightSummaryDTO | null | 'error'> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await dealFlightSummary(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error) || isFlightFunctionMissing(error)) return null;
    return 'error';
  }
}

/** The Deal History "Flight" group (Sales owner, branch Manager, Accounts); null when not readable. */
export async function loadDealFlightHistory(staff: Staff, dealId: string): Promise<DealFlightHistoryDTO | null | 'error'> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await dealFlightHistory(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error) || isFlightFunctionMissing(error)) return null;
    return 'error';
  }
}

/** Home rows of the Flight build; null when the read is missing or refused (the Home page leaves them out). */
export async function loadFlightHomeCounts(staff: Staff): Promise<FlightHomeCountsDTO | null> {
  try {
    return await flightHomeCounts(asRpcClient(staff.supabase));
  } catch {
    return null;
  }
}
