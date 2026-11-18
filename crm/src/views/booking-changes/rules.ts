import { maxPaiseForDigits, rupeesToPaise as readRupees } from '@/lib/money';
import { BLOCKED_WORD, blockedWord } from './labels';
import type { ChangeKind, ChangeRequestView, DealChangeRequestsView, ReconfirmationLineView } from './types';

/*
 * Pure helpers for the change screens (no React, unit-tested in
 * tests/unit/acc3u-changes-rules.test.ts). They decide only what the screen
 * says and which buttons explain themselves; the database decides every
 * rule again (contract 10.3, 11).
 */

/** Addendum O2 adds draft (the change version is being filled) to the live statuses. */
export const LIVE_STATUSES = new Set(['draft', 'requested', 'returned', 'approved', 'submitted']);

/** The live request of the Deal (one at a time, contract 10.2), if any. */
export function liveRequest(view: Pick<DealChangeRequestsView, 'requests'>): ChangeRequestView | null {
  return view.requests.find((r) => LIVE_STATUSES.has(r.status)) ?? null;
}

/**
 * Why a new request of this kind cannot be asked for now, in words; null
 * when it can. Order: not allowed to ask → switch off → live request →
 * blockedBy codes from the database → nothing to change or remove.
 */
export function requestBlockedReason(view: DealChangeRequestsView, kind: ChangeKind): string | null {
  if (!view.canRequest) return 'Only the Sales owner or the branch Manager can ask for a change.';
  const serviceOn = view.serviceChangesEnabled ?? view.enabled;
  if (kind === 'change' && !view.enabled) return BLOCKED_WORD.changes_off!;
  if (kind !== 'change' && !serviceOn) return BLOCKED_WORD.service_changes_off!;
  const live = liveRequest(view);
  if (live) return `Change ${live.refNo} is in progress. Finish or withdraw it first.`;
  const source = kind !== 'change' && view.serviceBlockedBy ? view.serviceBlockedBy : view.blockedBy;
  const codes = source.filter((c) => c !== 'changes_off' && c !== 'service_changes_off' && !(kind !== 'change' && c === 'not_committed'));
  if (codes.length > 0) return blockedWord(codes[0]!);
  if (kind === 'change' && view.confirmed.length === 0) return BLOCKED_WORD.nothing_confirmed!;
  if (kind === 'add_service' && view.addableTypes && view.addableTypes.length === 0) return BLOCKED_WORD.nothing_to_add!;
  if (kind === 'remove_service' && view.removable && view.removable.length === 0) return BLOCKED_WORD.nothing_to_remove!;
  return null;
}

/** "1 of 2 suppliers agreed" — the reconfirmation progress line, or null when none is needed. */
export function reconfirmProgress(lines: ReconfirmationLineView[]): string | null {
  const live = lines.filter((l) => l.status !== 'void');
  if (live.length === 0) return null;
  const refused = live.find((l) => l.status === 'refused');
  if (refused) return `${refused.serviceTitle}: the supplier refused. The earlier booking stands.`;
  const done = live.filter((l) => l.status === 'recorded' || l.status === 'applied').length;
  const waitingManager = live.filter((l) => l.status === 'recorded' && l.overBudget).length;
  const base = `${done} of ${live.length} ${live.length === 1 ? 'supplier' : 'suppliers'} agreed`;
  return waitingManager > 0 ? `${base}; ${waitingManager} above budget waiting for the Manager` : base;
}

export type ChangeModeItemState = 'changed' | 'in_request' | 'outside_request';

/** How the change-mode booking form shows one service (contract 10.3 G6, LD28). */
export function changeModeItemState(itemId: string, requestItemIds: readonly string[], changedItemIds: readonly string[]): ChangeModeItemState {
  if (!requestItemIds.includes(itemId)) return 'outside_request';
  return changedItemIds.includes(itemId) ? 'changed' : 'in_request';
}

/** Item numbers of services that changed but are not in the request (would be refused change_outside_request). */
export function outsideRequestItemNos(requestItemIds: readonly string[], changedItemIds: readonly string[], itemNos: Readonly<Record<string, number>>): number[] {
  return changedItemIds
    .filter((id) => !requestItemIds.includes(id))
    .map((id) => itemNos[id])
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
}

/** "Services 1 and 3" / "Service 2" / "No services". */
export function itemNosText(nos: readonly number[]): string {
  if (nos.length === 0) return 'No services';
  const sorted = [...nos].sort((a, b) => a - b).map(String);
  if (sorted.length === 1) return `Service ${sorted[0]}`;
  return `Services ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

/** Display aid only, so no cap of its own in practice (the server form caps at 15 rupee digits). */
const HINT_MAX_PAISE = maxPaiseForDigits(30);

/** Rupee text ("12,500.50", "1200") → whole paise, or null when empty or not a plain amount ("₹ 1200"; src/lib/money.ts). Display aid only. */
export function rupeeTextToPaise(text: string | null | undefined): bigint | null {
  const paise = readRupees(text, { max: HINT_MAX_PAISE });
  return typeof paise === 'string' ? BigInt(paise) : null;
}

/**
 * The live hint under the reconfirmation amounts: whether rate + fee goes
 * above the change version's budget for the service. The database decides
 * `over_budget` again when the row is recorded (G7).
 */
export function overBudgetHint(rateText: string, feeText: string, budgetPaise: string | null): { over: boolean; totalPaise: bigint } | null {
  const rate = rupeeTextToPaise(rateText);
  const fee = feeText.trim() === '' ? 0n : rupeeTextToPaise(feeText);
  if (rate === null || fee === null || rate <= 0n) return null;
  const total = rate + fee;
  if (budgetPaise === null || !/^\d+$/.test(budgetPaise)) return { over: true, totalPaise: total };
  return { over: total > BigInt(budgetPaise), totalPaise: total };
}

/** Whole paise (bigint) → "₹1,23,456.50" for the live hint. */
export function paiseText(p: bigint): string {
  const neg = p < 0n;
  const v = neg ? -p : p;
  const r = (v / 100n).toString();
  const last3 = r.slice(-3);
  const rest = r.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}₹${grouped}.${(v % 100n).toString().padStart(2, '0')}`;
}

/**
 * Why the cost above budget cannot be approved by this viewer (finding 8):
 * from the viewer's roles and the real cause, never a fixed sentence. The
 * Approver is a branch Manager who did not record the supplier's answer and
 * may manage Purchase tasks (contract 10.3 G8); the database decides again.
 */
export function overBudgetBlockedReason(roles: { isManager: boolean; worksTask: boolean; canApprove: boolean }): string | null {
  if (roles.canApprove) return null;
  if (!roles.isManager) return 'The branch Manager approves a cost above budget.';
  if (roles.worksTask) return 'You recorded this answer as the task\u2019s Purchase person. Another Manager approves it.';
  return 'Another branch Manager approves it: the person who recorded the answer, or a Manager without Purchase approval rights, cannot.';
}

/** The next step of a request in plain words (Addendum O2 order), or null for a closed request. */
export function changeNextStep(r: Pick<ChangeRequestView, 'status' | 'kind' | 'removalRoute' | 'charges' | 'changeVersionId' | 'reconfirmations'>, viewer: 'sales' | 'manager' | 'accounts'): string | null {
  const chargesOpen = r.kind === 'remove_service' && r.removalRoute === 'cancellation' && (r.charges ?? []).some((c) => !c.complete);
  switch (r.status) {
    case 'draft':
      if (viewer === 'accounts') return 'the Sales owner fills in the change (with the new total and payment plan) and sends it to the branch Manager.';
      return r.changeVersionId
        ? 'finish the change in the booking (new total and payment plan included), then press "Send change".'
        : 'open the booking in change mode and make the change.';
    case 'requested':
      if (chargesOpen) return 'the department enters the supplier charges, then the branch Manager approves this exact version.';
      return 'the branch Manager checks the old and new booking side by side and approves or returns it.';
    case 'returned':
      return viewer === 'accounts'
        ? 'the Sales owner fixes the change version and sends it again.'
        : 'fix the change version in the booking as the Manager asked, then press "Send change" again — or withdraw it.';
    case 'approved':
    case 'submitted':
      return r.reconfirmations.some((l) => l.status === 'pending' || (l.status === 'recorded' && l.overBudget))
        ? 'Purchase asks each supplier and records their answer. The change is applied when every supplier agreed.'
        : 'the change is applied once every supplier agreed.';
    default:
      return null;
  }
}
