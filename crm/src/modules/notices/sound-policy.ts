import { type NoticeItemDTO, type NoticeTone, isUnread, noticeTone } from './contracts';

/**
 * Bell sound decisions (contract 9.4), pure so they can be unit tested; the
 * browser adapter (track D) supplies the clock, the shared timestamp, the
 * leader flag and the audio state.
 *
 *   - Sound is ON by default (Accounts phase 2, owner Q12; preference stored
 *     per person, N3; a person without a saved choice reads ON). The browser
 *     still allows audio only after the first click on each page load.
 *   - Urgent kinds play the urgent tone; new / assigned tasks the normal
 *     tone; every other kind is silent; an escalated receipt never plays.
 *   - At most one sound per 10 s per person (timestamp shared by every tab in
 *     localStorage, read and written inside try/catch).
 *   - Only one tab plays: the leader holds the Web Lock 'tn-notice-sound'
 *     (navigator.locks.request(..., { ifAvailable: true })); without Web Locks
 *     a BroadcastChannel heartbeat elects the tab with the smallest id seen in
 *     the last HEARTBEAT_STALE_MS.
 *   - After a full reload audio is locked until the first click; the bell then
 *     says "Click anywhere to turn sound back on".
 */

/** Default of the per-person sound preference (Accounts phase 2, 8.5). */
export const SOUND_DEFAULT_ON = true;

export const SOUND_THROTTLE_MS = 10_000;
export const SOUND_LOCK_NAME = 'tn-notice-sound';
export const SOUND_CHANNEL_NAME = 'tn-notice-sound';
export const SOUND_STORAGE_KEY = 'tn-notice-sound-at';
export const HEARTBEAT_INTERVAL_MS = 2_000;
export const HEARTBEAT_STALE_MS = 5_000;

export type LeaderStrategy = 'locks' | 'broadcast' | 'solo';

export function leaderStrategy(env: { webLocks: boolean; broadcastChannel: boolean }): LeaderStrategy {
  if (env.webLocks) return 'locks';
  if (env.broadcastChannel) return 'broadcast';
  return 'solo';
}

/** BroadcastChannel fallback: the live tab with the smallest id leads. */
export function broadcastLeader(selfId: string, heartbeats: ReadonlyMap<string, number>, now: number): boolean {
  let leader = selfId;
  for (const [id, at] of heartbeats) {
    if (now - at <= HEARTBEAT_STALE_MS && id < leader) leader = id;
  }
  return leader === selfId;
}

/** The strongest tone among notices that arrived after `lastSeenSeq` and are still unread. */
export function toneFor(items: readonly NoticeItemDTO[], lastSeenSeq: number | null): NoticeTone {
  let tone: NoticeTone = 'none';
  for (const item of items) {
    if (lastSeenSeq !== null && item.seq <= lastSeenSeq) continue;
    if (!isUnread(item)) continue;
    const t = noticeTone(item);
    if (t === 'urgent') return 'urgent';
    if (t === 'normal') tone = 'normal';
  }
  return tone;
}

export type SoundDecision =
  | { play: true; tone: 'urgent' | 'normal' }
  | { play: false; reason: 'off' | 'silent' | 'not_leader' | 'throttled' | 'locked' | 'first_load' };

export interface SoundInput {
  soundOn: boolean;
  isLeader: boolean;
  audioUnlocked: boolean;
  /** Shared last-played time (ms) from localStorage; null when unknown or unreadable. */
  lastPlayedAt: number | null;
  now: number;
  items: readonly NoticeItemDTO[];
  /** Highest seq the tab had already shown; null on the very first read (never play then). */
  lastSeenSeq: number | null;
}

export function decideSound(input: SoundInput): SoundDecision {
  if (!input.soundOn) return { play: false, reason: 'off' };
  if (input.lastSeenSeq === null) return { play: false, reason: 'first_load' };
  const tone = toneFor(input.items, input.lastSeenSeq);
  if (tone === 'none') return { play: false, reason: 'silent' };
  if (!input.isLeader) return { play: false, reason: 'not_leader' };
  if (input.lastPlayedAt !== null && input.now - input.lastPlayedAt < SOUND_THROTTLE_MS) return { play: false, reason: 'throttled' };
  if (!input.audioUnlocked) return { play: false, reason: 'locked' };
  return { play: true, tone };
}

/** Minimal storage surface (window.localStorage); every access may throw. */
export interface SoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readLastPlayed(storage: SoundStorage | null | undefined): number | null {
  try {
    const raw = storage?.getItem(SOUND_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastPlayed(storage: SoundStorage | null | undefined, now: number): void {
  try {
    storage?.setItem(SOUND_STORAGE_KEY, String(now));
  } catch {
    // Private mode or blocked storage: the throttle stays per tab.
  }
}

/** Screen reader announcements: at most one per 10 s; urgent assertively. */
export function announcement(
  items: readonly NoticeItemDTO[],
  lastSeenSeq: number | null,
  lastAnnouncedAt: number | null,
  now: number,
): { politeness: 'assertive' | 'polite'; count: number } | null {
  if (lastSeenSeq === null) return null;
  if (lastAnnouncedAt !== null && now - lastAnnouncedAt < SOUND_THROTTLE_MS) return null;
  const fresh = items.filter((i) => i.seq > lastSeenSeq && isUnread(i));
  if (fresh.length === 0) return null;
  return { politeness: fresh.some((i) => i.priority === 'urgent') ? 'assertive' : 'polite', count: fresh.length };
}
