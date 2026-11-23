import { isUnread, NOTICE_TEXT, noticePopsUp, noticeText, type NoticeItemDTO } from './contracts';
import { noticeHref } from './href';

/**
 * Desktop pop-up decisions (Accounts phase 2 contract 8.4, 8.5, 13.5, LD26;
 * owner answer Q12). Pure, so they can be unit tested; the browser adapter is
 * popup-browser.ts and the bell UI (track E) supplies the leader flag, the
 * tab focus and the permission.
 *
 *   - Pop-ups are ON by default (per person, notice_preferences_set
 *     {popupsOn}); each person can turn them off.
 *   - Only urgent notices pop up (noticePopsUp: stored urgent with the urgent
 *     tone; an escalated receipt reminder never pops up), only rows newer
 *     than the last popped seq and still unread.
 *   - Never while this CRM tab is visible and focused (LD26: the bell is in
 *     view).
 *   - Only the sound leader tab (Phase 1 Web Lock / BroadcastChannel leader)
 *     shows them; more than 3 at once -> one summary pop-up "{n} urgent
 *     notices".
 *   - The first read after a page load only sets the cursor (nothing old
 *     pops up).
 *   - Text is the reference-only notice text (no names or amounts); no
 *     service worker, no push, nothing while the browser is closed.
 *   - The permission is asked once per browser on the first pointerdown /
 *     keydown after sign-in while pop-ups are on (localStorage
 *     POPUP_ASKED_KEY); a denied permission is never asked again.
 */

export type PopupPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export const POPUP_ASKED_KEY = 'tn-notice-popup-asked';
export const POPUP_TITLE = 'TripNavigate — urgent';
export const POPUP_SUMMARY_ABOVE = 3;
export const POPUP_TAG_PREFIX = 'tn-notice-';
export const POPUP_SUMMARY_TAG = 'tn-notice-summary';
/** Default of the per-person pop-up preference (contract 8.5). */
export const POPUP_DEFAULT_ON = true;

export interface PopupInput {
  popupsOn: boolean;
  permission: PopupPermission;
  supported: boolean;
  isLeader: boolean;
  tabVisibleAndFocused: boolean;
  items: readonly NoticeItemDTO[];
  /** Highest seq already shown (or seen) by this tab; null on the first read after a page load. */
  lastPoppedSeq: number | null;
}

export interface PopupSpec {
  tag: string;
  body: string;
  href: string | null;
}

export type PopupDecision =
  | { show: false; reason: 'off' | 'unsupported' | 'no_permission' | 'first_load' | 'nothing' | 'not_leader' | 'focused' }
  | { show: true; popups: PopupSpec[]; maxSeq: number };

/** Urgent, unread notices newer than the cursor. */
export function popupCandidates(items: readonly NoticeItemDTO[], lastPoppedSeq: number): NoticeItemDTO[] {
  return items.filter((i) => i.seq > lastPoppedSeq && isUnread(i) && noticePopsUp(i));
}

export function decidePopup(input: PopupInput): PopupDecision {
  if (!input.popupsOn) return { show: false, reason: 'off' };
  if (!input.supported) return { show: false, reason: 'unsupported' };
  if (input.permission !== 'granted') return { show: false, reason: 'no_permission' };
  if (input.lastPoppedSeq === null) return { show: false, reason: 'first_load' };
  const fresh = popupCandidates(input.items, input.lastPoppedSeq).sort((a, b) => b.seq - a.seq);
  if (fresh.length === 0) return { show: false, reason: 'nothing' };
  if (!input.isLeader) return { show: false, reason: 'not_leader' };
  if (input.tabVisibleAndFocused) return { show: false, reason: 'focused' };
  const maxSeq = fresh[0]!.seq;
  if (fresh.length > POPUP_SUMMARY_ABOVE) {
    return { show: true, popups: [{ tag: POPUP_SUMMARY_TAG, body: `${fresh.length} urgent notices`, href: null }], maxSeq };
  }
  return {
    show: true,
    popups: fresh.map((i) => ({ tag: POPUP_TAG_PREFIX + i.noticeId, body: noticeText(i), href: noticeHref(i) })),
    maxSeq,
  };
}

/** The cursor after a read: never moves back; covers everything the read returned. */
export function nextPoppedSeq(previous: number | null, latestSeq: number | null, decision: PopupDecision): number {
  return Math.max(previous ?? 0, latestSeq ?? 0, decision.show ? decision.maxSeq : 0);
}

/**
 * Ask the browser for permission on this input? Only while pop-ups are on, the API exists, the browser has not
 * decided yet ('default') and this browser was not asked before. `force` (the bell's "Allow pop-ups" button) asks
 * again after an earlier ask, but never after a denial (the browser would not show the prompt anyway).
 */
export function shouldAskPermission(input: {
  popupsOn: boolean;
  supported: boolean;
  permission: PopupPermission;
  alreadyAsked: boolean;
  force?: boolean;
}): boolean {
  if (!input.supported || input.permission !== 'default') return false;
  if (input.force) return true;
  return input.popupsOn && !input.alreadyAsked;
}

/** The bell settings line for this browser (screen 13). */
export function popupStateText(input: { popupsOn: boolean; permission: PopupPermission }): string {
  if (input.permission === 'unsupported') return NOTICE_TEXT.popupsUnsupported;
  if (input.permission === 'denied') return NOTICE_TEXT.popupsBlocked;
  return input.popupsOn ? NOTICE_TEXT.popupsOn : NOTICE_TEXT.popupsOff;
}
