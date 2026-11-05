import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { FlightMoneyCommandError, flightFareApprovalSets, flightMoney, flightPaymentContext, flightSupplierList } from '../money-commands';
import type { FlightFareApprovalSetView, FlightMoneyView, FlightPaymentContextView, FlightSupplierView } from '../money-contracts';
import { toFlightFareApprovalSetView, toFlightMoneyView, toFlightPaymentContextView, toFlightSupplierView } from '../money-dto';

/**
 * Flight money reads, under the staff member's own session. The database
 * builds each read per role (money fence); null means "not available to this
 * person". A refusal (role, scope or environment) returns null / an empty
 * list; an unexplained failure throws (never a fabricated empty state).
 */

type Staff = Pick<StaffContext, 'supabase'>;

function isRefusal(error: unknown): boolean {
  return (
    error instanceof FlightMoneyCommandError &&
    (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'not_configured' || error.code === 'environment_unset')
  );
}

/** The money of one Deal's flight group (contract 9.3), or null. */
export async function loadFlightMoney(staff: Staff, dealId: string): Promise<FlightMoneyView | null> {
  try {
    const record = await flightMoney(asRpcClient(staff.supabase), dealId);
    return record ? toFlightMoneyView(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the flight costs and payments. Please retry.');
  }
}

/** Fare sets of the Deal's pending and approved fare approvals (the popup after a reload), or null. */
export async function loadFlightFareApprovalSets(staff: Staff, dealId: string): Promise<FlightFareApprovalSetView[] | null> {
  try {
    const records = await flightFareApprovalSets(asRpcClient(staff.supabase), dealId);
    return records ? records.map(toFlightFareApprovalSetView) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the fares sent to the Manager. Please retry.');
  }
}

/** The payment drawer of one batch (the Flight person of its cost task), or null. */
export async function loadFlightPaymentContext(staff: Staff, batchId: string): Promise<FlightPaymentContextView | null> {
  try {
    const record = await flightPaymentContext(asRpcClient(staff.supabase), batchId);
    return record ? toFlightPaymentContextView(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load this payment. Please retry.');
  }
}

/** Flight suppliers of the caller's entity (airlines and consolidators). */
export async function loadFlightSuppliers(staff: Staff): Promise<FlightSupplierView[]> {
  try {
    return (await flightSupplierList(asRpcClient(staff.supabase))).map(toFlightSupplierView);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load the flight suppliers. Please retry.');
  }
}
