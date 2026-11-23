import { parseTab } from '@/lib/parse-tab';
import { QUEUE_LATE_MINUTES } from '@/views/customer-documents/acc3-pure';
import { duesHref, isEmptyFilter, TALLY_PATH, type SearchParams } from './address';
import type { DailyCheck, DuesFilter, DuesStatus } from './types';

/*
 * UX redesign R4 (helper A3): the address rules of Money in, Records and
 * Tally. Pure, so the unit test proves every old address keeps working.
 *
 * Dues (audit A9, design plan 2.3): the bare address /app/accounts/dues opens
 * on Overdue plus Due today. Any address that already names a filter (a Deal
 * reference, a branch, a status ...) keeps meaning exactly what it meant
 * before, so links and bookmarks are unchanged. "Every status" is
 * ?status=all: the filter parser drops the unknown value (no status filter),
 * and the key being present stops the default.
 *
 * Tally (owner answer D11): only the switched-on method shows; ?method=file
 * or ?method=csv picks one when both are on. The old address (no ?method=)
 * opens the first switched-on method, Tally file first.
 */

export const DUES_DEFAULT_STATUSES: readonly DuesStatus[] = ['overdue', 'due_now'];

/** True when the address names no filter at all (the bare Dues address, or an empty form sent). */
export function duesDefaultApplies(sp: SearchParams, filter: DuesFilter): boolean {
  return sp.status === undefined && isEmptyFilter(filter);
}

/** The filter the page reads: the parsed filter, or Overdue plus Due today on the bare address. */
export function duesFilterWithDefault(sp: SearchParams, filter: DuesFilter): { filter: DuesFilter; defaulted: boolean } {
  if (!duesDefaultApplies(sp, filter)) return { filter, defaulted: false };
  return { filter: { ...filter, status: [...DUES_DEFAULT_STATUSES] }, defaulted: true };
}

/** "Every status": the same filter without a status, kept from falling back to the default. */
export function duesEveryStatusHref(filter: DuesFilter): string {
  const href = duesHref({ ...filter, status: undefined });
  return `${href}${href.includes('?') ? '&' : '?'}status=all`;
}

/** A status chip: adds or removes that status; removing the last one shows every status (never the default again). */
export function duesToggleHref(filter: DuesFilter, status: DuesStatus): string {
  const current = filter.status ?? [];
  const next = current.includes(status) ? current.filter((s) => s !== status) : [...current, status];
  return next.length === 0 ? duesEveryStatusHref(filter) : duesHref({ ...filter, status: next });
}

export type TallyMethod = 'file' | 'csv';
export const TALLY_METHODS: readonly TallyMethod[] = ['file', 'csv'];
export const TALLY_METHOD_LABEL: Record<TallyMethod, string> = { file: 'Tally file', csv: 'CSV export' };

/** The methods switched on, Tally file first. */
export function tallyMethodsOn(on: Record<TallyMethod, boolean>): TallyMethod[] {
  return TALLY_METHODS.filter((m) => on[m]);
}

/** The method the page shows: the asked one when it is on, else the first one on; null when both are off. */
export function tallyMethodFrom(raw: unknown, on: Record<TallyMethod, boolean>): TallyMethod | null {
  const list = tallyMethodsOn(on);
  if (list.length === 0) return null;
  return parseTab(raw, list, list[0]!);
}

export function tallyMethodHref(method: TallyMethod): string {
  return `${TALLY_PATH}?method=${method}`;
}

/**
 * How many things the daily check counts as waiting (audit A5: the check
 * folds to one line when this is 0). Every count the database sent, the
 * urgent notices of every branch, and a late customer message queue.
 */
export function dailyCheckWaiting(daily: DailyCheck): number {
  const counts = [
    daily.exceptionsOpen.count,
    daily.changedAfterExport,
    daily.originalsMissing,
    daily.receiptsAwaitingVerificationOverOneWorkingDay,
    daily.paymentsApprovedNotRecordedOverOneWorkingDay,
    daily.documentsToRelease,
    daily.pdfFailed,
    daily.refundPayoutsDueOverOneWorkingDay,
    daily.supplierRefundsDue,
    daily.billsHeldOverOneWorkingDay,
    daily.customerMessagesFailedOverOneWorkingDay,
    daily.tallyFileUnmatchedOverOneWorkingDay,
    daily.writeOffsToReview,
    ...daily.urgentNoticesUnopenedOverOneWorkingDay.map((b) => b.count),
  ];
  const late = typeof daily.messageQueueOldestMinutes === 'number' && daily.messageQueueOldestMinutes > QUEUE_LATE_MINUTES ? 1 : 0;
  return counts.reduce<number>((sum, n) => sum + (typeof n === 'number' && n > 0 ? n : 0), 0) + late;
}
