import type { ChangeKind, ChangeStatus } from './contracts';

/**
 * Pure mirrors of the change-request rules (contract 4, 10.2, 10.3, 11.3,
 * LD28). The database decides; screens use these to refuse early with the
 * same token and to mark the change-mode form. No I/O.
 */

/** A live request (contract 4): one per Deal. */
export const LIVE_CHANGE_STATUSES: readonly ChangeStatus[] = Object.freeze(['draft', 'requested', 'returned', 'approved', 'submitted']);

/** Addendum O2: the Sales owner edits the request and its change version while drafted or returned. */
export function isEditableChange(status: ChangeStatus): boolean {
  return status === 'draft' || status === 'returned';
}

export function isLiveChange(status: ChangeStatus): boolean {
  return LIVE_CHANGE_STATUSES.includes(status);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Item ids named at request time: change 1..20, add_service none (items are
 * recorded when they are added), remove_service exactly one; distinct uuids.
 */
export function itemIdsProblem(kind: ChangeKind, itemIds: readonly string[]): 'invalid_input' | null {
  if (!itemIds.every((id) => UUID.test(id)) || new Set(itemIds).size !== itemIds.length) return 'invalid_input';
  const n = itemIds.length;
  if (kind === 'change') return n >= 1 && n <= 20 ? null : 'invalid_input';
  if (kind === 'add_service') return n === 0 ? null : 'invalid_input';
  return n === 1 ? null : 'invalid_input';
}

/** LD28: the changed services that are not part of the approved request (change_outside_request). */
export function itemsOutsideRequest(changedItemIds: readonly string[], requestItemIds: readonly string[]): string[] {
  const allowed = new Set(requestItemIds);
  return changedItemIds.filter((id) => !allowed.has(id));
}

/** The set the screen sends to booking_change_submit: sorted and distinct. */
export function changedItemSet(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

/**
 * Change mode of the booking form: only services named in the request are
 * editable - for a change the named services, for add_service the services
 * added in this change version (recorded in the request as they are added);
 * nothing for remove_service (the service is simply absent).
 */
export function itemEditableInChange(itemId: string, requestItemIds: readonly string[], kind: ChangeKind): boolean {
  return kind !== 'remove_service' && requestItemIds.includes(itemId);
}

/**
 * 11.3 / LD32 mirror of authz.cr_customer_charge: the customer charge of a
 * removal - required (0 allowed) for the cancellation route, absent or 0 for
 * the simple route; whole paise as a decimal string, at most 12 digits.
 */
export function customerChargeProblem(route: 'simple' | 'cancellation', paise: string | null | undefined): 'invalid_input' | null {
  if (paise === null || paise === undefined || paise === '') return route === 'cancellation' ? 'invalid_input' : null;
  if (!/^(0|[1-9][0-9]{0,11})$/.test(paise)) return 'invalid_input';
  return route === 'simple' && paise !== '0' ? 'invalid_input' : null;
}

/** 11.1 / LD31: a task closed by a service removal is not open work. */
export function isOpenWork(task: { closedState?: string | null }): boolean {
  return task.closedState === null || task.closedState === undefined;
}

export interface RemovalFacts {
  supplierConfirmed: boolean;
  ticketBatch: boolean;
  visaSubmitted: boolean;
  supplierPayment: boolean;
  companyPaidFee: boolean;
}

/** 11.3: simple only when nothing is booked or paid for the service; otherwise through cancellation charges. */
export function removalRoute(f: RemovalFacts): 'simple' | 'cancellation' {
  return f.supplierConfirmed || f.ticketBatch || f.visaSubmitted || f.supplierPayment || f.companyPaidFee ? 'cancellation' : 'simple';
}

/** Keys never shown to department readers (mirror of authz.purchase_money_key). */
const MONEY_KEY = /(paise|price|cost|estimate|budget|amount|discount|selling|margin|total|fare|dues|receipt)/i;

export function isMoneyKey(key: string): boolean {
  return MONEY_KEY.test(key) || key === 'participants';
}

/** Department-safe facts: money keys removed (defence in depth; the database already removes them). */
export function safeFacts(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) if (!isMoneyKey(k)) out[k] = v;
  return out;
}

/** Over budget as G7 decides it: rate + fee above the item's budget, or no budget at all. */
export function reconfirmOverBudget(newRatePaise: string, supplierFeePaise: string, budgetPaise: string | null): boolean {
  if (budgetPaise === null) return true;
  return BigInt(newRatePaise) + BigInt(supplierFeePaise) > BigInt(budgetPaise);
}
