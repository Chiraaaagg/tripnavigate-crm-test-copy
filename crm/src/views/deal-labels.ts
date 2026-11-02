import type { DealListItem, ViewerRelation } from '@/modules/deals/dto';
import type { DealSourceView } from '@/modules/integration/contracts';
import type { BitrixNameVM, ListFreshnessVM, RecordOwnerVM } from '@/modules/deals/workspace-contract';

/*
 * Plain-text labels shared by the Deals list (deals-list-view.tsx), the deal
 * page (deal-page-view.tsx) and the access and admin views (staff-views.tsx). A leaf module: it imports
 * no view, so the Deals list and its loading state do not pull in the whole
 * staff-views graph, and there is no import cycle between the two views.
 */

export const RELATION_LABEL: Record<ViewerRelation, string> = {
  owner: 'You own this deal',
  assigned: 'Assigned to you',
  scope: 'Visible through your role or an access grant',
  waiting: 'Waiting for an owner (administrators only)',
};

/** "Quote sent" when the intake configuration names the stage, otherwise "Bitrix stage C1:NEW". */
export function stageText(source: DealSourceView): string {
  const label = source.stageLabel?.trim();
  return label ? label : `Bitrix stage ${source.stageId}`;
}

const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export function formatIst(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : `${DATE_TIME.format(time)} IST`;
}

export const STALE_SYNC_TEXT = 'Sync overdue: not updated from Bitrix for over 24 hours';
export const BITRIX_OWNS_TEXT =
  'Bitrix owns this deal’s title, stage and salesperson. Change them in Bitrix; the CRM copies them at the next sync and cannot edit them here.';

/**
 * Who owns the deal, in words, for the viewer: "You", the owner's name when
 * the viewer may see it, or "Another staff member". null means the deal is
 * waiting for an owner (shown as a status, not a name). Same rule as the
 * Deals list's owner column.
 */
export function dealOwnerText(deal: Pick<DealListItem, 'relation' | 'ownerName'>): string | null {
  if (deal.relation === 'waiting') return null;
  if (deal.relation === 'owner') return 'You';
  return deal.ownerName ?? 'Another staff member';
}

// ---------------------------------------------------------------------------
// Direction A Batch 1 (copy-catalogue §16): Bitrix names, owners, freshness.
// Plain text only, so lists, record headers and tests share one wording.
// ---------------------------------------------------------------------------

/** Which Bitrix code a BitrixNameVM carries (DA-90 to DA-93 wording differs only in this word). */
export type BitrixCodeKind = 'stage' | 'status' | 'source';

const CODE_WORD: Record<BitrixCodeKind, string> = { stage: 'Stage', status: 'Status', source: 'Source' };

/**
 * List cell and record header text for a Bitrix code (DA-90 to DA-93): the
 * Bitrix name only when it was matched; otherwise "{Stage|Status|Source} not
 * recognised (code in details)". Never an invented friendly name.
 */
export function bitrixNameText(vm: BitrixNameVM, kind: BitrixCodeKind): string {
  const name = vm.labelState === 'named' ? vm.name?.trim() : '';
  return name ? name : `${CODE_WORD[kind]} not recognised (code in details)`;
}

/** True when the cell shows the "not recognised" fallback. */
export function bitrixNameUnrecognised(vm: BitrixNameVM): boolean {
  return !(vm.labelState === 'named' && vm.name?.trim());
}

/** The Details line for a Bitrix code (DA-90 to DA-93, B1-1 "No longer in the Bitrix list"). */
export function bitrixCodeDetail(vm: BitrixNameVM): string {
  const code = `Bitrix code: ${vm.code}.`;
  switch (vm.labelState) {
    case 'named':
      return vm.noLongerInList ? `${code} No longer in the Bitrix list.` : code;
    case 'not_in_list':
      return `${code} This code is not in Bitrix’s list of names.`;
    case 'list_unreadable':
      return `${code} The list of Bitrix names could not be read; showing the code.`;
    case 'switched_off':
      return `${code} Reading Bitrix names is switched off.`;
  }
}

/** Owner in words (L-04, DL-03, D-15). null = waiting for an owner (shown as a status, never a name). */
export function recordOwnerText(owner: RecordOwnerVM): string | null {
  if (owner.kind === 'waiting') return null;
  if (owner.kind === 'you') return 'You';
  return owner.displayName?.trim() || 'Another staff member';
}

export const WAITING_FOR_OWNER_TEXT = 'Waiting for owner';
/** DA-45 row badge and D-02 / L-13 header warning (only when late). */
export const LATE_TEXT = 'Not updated from Bitrix for over a day';
/** DA-45 when the page cannot tell. */
export const FRESHNESS_UNKNOWN_TEXT = 'Bitrix update time not known';

/** "5 minutes", "3 hours", "2 days": a rounded-down span for "updated … ago". */
export function spanText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** DA-45 list line: "Bitrix data updated {time} ago", or "Bitrix update time not known". */
export function freshnessText(freshness: ListFreshnessVM, now: number = Date.now()): string {
  if (freshness.state === 'unknown') return FRESHNESS_UNKNOWN_TEXT;
  const at = Date.parse(freshness.oldestCheckedAt);
  if (Number.isNaN(at)) return FRESHNESS_UNKNOWN_TEXT;
  return `Bitrix data updated ${spanText(now - at)} ago`;
}

const DAY_UTC = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY_IST = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * One date format for every Batch 1 screen (Echo L9): "20 Dec 2026". A plain
 * day ("2026-12-20", already an IST date) is shown as that day; a timestamp is
 * shown as its IST day; anything else is shown as given.
 */
export function dayText(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return DAY_UTC.format(Date.parse(`${value}T00:00:00Z`));
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : DAY_IST.format(t);
}
