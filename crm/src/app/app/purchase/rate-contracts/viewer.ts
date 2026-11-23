import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import type { RateContractViewer } from '@/views/rate-contracts/types';

/**
 * Which rate-contract screen a reader gets (contract 14: Purchase enters and
 * uploads, a Manager without Purchase approves and ends, Accounts read).
 * Display only: rate_contracts_list / rate_contract_get decide access and
 * return null for Sales, Flight and Visa.
 */
export function rateContractViewerOf(staff: Pick<StaffContext, 'memberships'>): RateContractViewer {
  const roles = new Set(staff.memberships.map((m) => m.roleCode));
  if (roles.has('purchase')) return 'purchase';
  if (roles.has('manager')) return 'manager';
  return 'accounts';
}
