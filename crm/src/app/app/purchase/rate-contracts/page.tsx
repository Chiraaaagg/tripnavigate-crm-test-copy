import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { saveRateContractAction, setRateContractsEnabledAction } from '@/modules/rate-contracts/server/actions';
import { loadRateContractChoices, loadRateContracts, loadRateContractsState } from '@/modules/rate-contracts/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { parseRateContractQuery } from '@/views/rate-contracts/format';
import { RateContractsListView, RateContractsNoAccess } from '@/views/rate-contracts/list';
import { rateContractViewerOf } from './viewer';

export const metadata: Metadata = { title: 'Rate contracts' };

/**
 * Suppliers › Rate contracts (Accounts phase 3 contract 9.5 R-E1, screen
 * 15.9). rate_contracts_list decides who reads (Purchase, Managers and
 * Accounts of the entity); everyone else gets null. Filters, the preset and
 * the keyset cursor live in the address. Purchase also gets the create form
 * (suppliers that sell hotels and their linked hotels).
 */
export default async function RateContractsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const { filter, after } = parseRateContractQuery(await searchParams);
  const viewer = rateContractViewerOf(staff);
  const [page, toApprove, endingSoon, choices, state] = await Promise.all([
    loadRateContracts(staff, { filter, after }).catch(() => 'error' as const),
    viewer === 'manager' ? loadRateContracts(staff, { filter: { preset: 'to_approve' }, limit: 100 }).catch(() => null) : Promise.resolve(null),
    loadRateContracts(staff, { filter: { preset: 'ending_soon' }, limit: 100 }).catch(() => null),
    viewer === 'purchase' ? loadRateContractChoices(staff).catch(() => null) : Promise.resolve(null),
    loadRateContractsState(staff).catch(() => null),
  ]);
  if (page === null) return <RateContractsNoAccess />;
  const items = page === 'error' ? [] : page.items;
  const supplierName = filter.supplierId ? (items.find((r) => r.supplierId === filter.supplierId)?.supplierName ?? null) : null;
  const hotelName = filter.hotelId ? (items.find((r) => r.hotelId === filter.hotelId)?.hotelName ?? null) : null;
  return (
    <RateContractsListView
      viewer={viewer}
      // rate_contracts_state(); unreadable counts as On (a write while Off is refused rate_contracts_off with its frozen words).
      enabled={state?.enabled ?? true}
      switchAction={state?.canSwitch ? (setRateContractsEnabledAction as unknown as DecisionAction) : null}
      filter={filter}
      page={page}
      counts={{ toApprove: toApprove?.items.length, endingSoon: endingSoon?.items.length }}
      names={{ supplier: supplierName, hotel: hotelName }}
      suppliers={choices?.suppliers ?? []}
      createAction={viewer === 'purchase' ? (saveRateContractAction as unknown as DecisionAction) : null}
      importHref={viewer === 'purchase' ? '/app/purchase/rate-contracts/import' : null}
    />
  );
}
