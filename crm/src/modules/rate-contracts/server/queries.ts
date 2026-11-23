import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { contractChoices, contractGet, contractsList, contractsState, type RateContractFilter } from '../commands';
import type { RateContractChoices, RateContractDetail, RateContractPage, RateContractsState } from '../dto';

/**
 * Rate contract reads (R-E1, R-E2, choices) under the staff member's own
 * session. Null = the viewer may not read rate contracts (section 14: only
 * Purchase, Managers and Accounts of the entity) or the contract does not
 * exist; an unexplained failure throws (never a fabricated empty state).
 */

type Staff = Pick<StaffContext, 'supabase'>;

export function loadRateContracts(staff: Staff, args: { filter?: RateContractFilter; after?: string | null; limit?: number } = {}): Promise<RateContractPage | null> {
  return contractsList(asRpcClient(staff.supabase), args);
}

export function loadRateContract(staff: Staff, contractId: string): Promise<RateContractDetail | null> {
  return contractGet(asRpcClient(staff.supabase), contractId);
}

export function loadRateContractChoices(staff: Staff): Promise<RateContractChoices | null> {
  return contractChoices(asRpcClient(staff.supabase));
}

/** Switch state: {enabled, canSwitch}; null when the viewer is not a rate contract reader or a Super Admin. */
export function loadRateContractsState(staff: Staff): Promise<RateContractsState | null> {
  return contractsState(asRpcClient(staff.supabase));
}
