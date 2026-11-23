import type { QueueChip } from '@/components/ui/queue-toolbar';
import { STATUS_LOOK } from '@/views/rate-contracts/labels';
import type { RateContractFilter, RateContractStatus } from '@/views/rate-contracts/types';
import type { SupplierRegisterFilter } from './types';

/*
 * Pure address helpers for the Suppliers area queues (UX redesign R3): the
 * suppliers register and the rate contracts list.
 * They only build links from the filter keys the page already reads; they
 * never add a key the server does not parse. Unit-tested in
 * tests/unit/r3-suppliers-queue.test.ts.
 */

/** The register address for a filter (optionally without one key, optionally with the next-page cursor). */
export function filterHref(base: string, filter: SupplierRegisterFilter, drop?: keyof SupplierRegisterFilter, after?: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v && k !== drop) p.set(k, String(v));
  if (after) p.set('after', after);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

type StateKey = 'verification' | 'bankState' | 'status';
const STATE_KEYS: readonly StateKey[] = ['verification', 'bankState', 'status'];
const STATE_CHIPS: ReadonlyArray<{ label: string; set: Partial<Pick<SupplierRegisterFilter, StateKey>> }> = [
  { label: 'All suppliers', set: {} },
  { label: 'Not verified', set: { verification: 'unverified' } },
  { label: 'Payments on hold', set: { bankState: 'on_hold' } },
  { label: 'No bank details', set: { bankState: 'none' } },
  { label: 'Archived', set: { status: 'archived' } },
];

/**
 * The state chips. Each is one address built from the existing filter keys:
 * the chip sets its own key and clears the other two state keys; the search,
 * kind, service, city and hotel stay. A chip is current only when the state
 * keys match it exactly (a combination from "More filters" marks none).
 * Pure: unit-tested in tests/unit/r3-suppliers-queue.test.ts.
 */
export function supplierStateChips(basePath: string, filter: SupplierRegisterFilter): QueueChip[] {
  const rest: SupplierRegisterFilter = { ...filter };
  for (const k of STATE_KEYS) delete rest[k];
  return STATE_CHIPS.map((c) => ({
    href: filterHref(basePath, { ...rest, ...c.set }),
    label: c.label,
    current: STATE_KEYS.every((k) => (filter[k] || undefined) === c.set[k]),
  }));
}

/** Address values a search keeps: every filter but the search words, never the page cursor. Pure. */
export function supplierSearchKeep(filter: SupplierRegisterFilter): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) if (v && k !== 'q') keep[k] = String(v);
  return keep;
}

/* ------------------------------------------------------------ rate contracts */

/** The rate contracts address for a filter, in the format parseRateContractQuery reads (status comma-joined). */
export function rateContractHref(base: string, filter: RateContractFilter, drop?: keyof RateContractFilter, after?: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (k === drop || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  if (after) p.set('after', after);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

const CONTRACT_STATUS_CHIPS: readonly RateContractStatus[] = ['draft', 'pending_approval', 'returned', 'active', 'ended'];

/**
 * Rate contract chips: "All contracts", the presets ("To approve" for
 * Managers, "Ending soon" for everyone, with their counts) and one chip per
 * status. The presets and the status list were a tab row and a status select
 * before; each chip is the same address those made (?preset=, ?status=).
 * The search words, supplier and hotel stay. Pure.
 */
export function rateContractChips(
  basePath: string,
  filter: RateContractFilter,
  o: { manager: boolean; counts?: { toApprove?: number; endingSoon?: number } },
): QueueChip[] {
  const rest: RateContractFilter = { ...filter };
  delete rest.preset;
  delete rest.status;
  const only = filter.status?.length === 1 ? filter.status[0] : undefined;
  const noStatus = !filter.status || filter.status.length === 0;
  const chips: QueueChip[] = [{ href: rateContractHref(basePath, rest), label: 'All contracts', current: !filter.preset && noStatus }];
  if (o.manager) chips.push({ href: rateContractHref(basePath, { ...rest, preset: 'to_approve' }), label: 'To approve', count: o.counts?.toApprove, current: filter.preset === 'to_approve' && noStatus });
  chips.push({ href: rateContractHref(basePath, { ...rest, preset: 'ending_soon' }), label: 'Ending soon', count: o.counts?.endingSoon, current: filter.preset === 'ending_soon' && noStatus });
  for (const st of CONTRACT_STATUS_CHIPS) {
    chips.push({ href: rateContractHref(basePath, { ...rest, status: [st] }), label: STATUS_LOOK[st].word, current: !filter.preset && only === st });
  }
  return chips;
}

/** Address values a rate contract search keeps: everything but the words and the cursor. Pure. */
export function rateContractSearchKeep(filter: RateContractFilter): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === 'q' || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    keep[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return keep;
}
