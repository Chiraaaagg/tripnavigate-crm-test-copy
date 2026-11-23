import { Tabs } from '@/components/ui/tabs';

/*
 * Suppliers area tabs (UX redesign R3, design plan N5 and DM-20): the
 * register and the rate contracts list are two tabs of one area, each its
 * own address (no change to either address). Rate contracts are supplier
 * costs for Purchase, Managers and Accounts only, so the page passes
 * `rateContracts: false` to anyone else (a Flight-only reader). Showing the
 * tab is convenience only: each page and the database still decide access.
 */

export const SUPPLIERS_HREF = '/app/purchase/suppliers';
export const RATE_CONTRACTS_HREF = '/app/purchase/rate-contracts';

export function SupplierAreaTabs({ current, rateContracts = true }: { current: 'suppliers' | 'rate-contracts'; rateContracts?: boolean }) {
  if (!rateContracts && current === 'suppliers') return null;
  return (
    <Tabs
      label="Suppliers area"
      variant="pill"
      items={[
        { href: SUPPLIERS_HREF, label: 'Suppliers', current: current === 'suppliers' },
        ...(rateContracts ? [{ href: RATE_CONTRACTS_HREF, label: 'Rate contracts', current: current === 'rate-contracts' }] : []),
      ]}
    />
  );
}
