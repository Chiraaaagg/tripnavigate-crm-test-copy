'use client';

import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isShownUrgent, isUnread, noticeText, type NoticeInboxDTO, type NoticeItemDTO, type NoticeMarkAction } from '@/modules/notices/contracts';
import { fetchNoticeHistory, fetchNoticeInbox, fetchRealtimeToken } from '@/modules/notices/feed-client';
import { groupNotices, type GroupedNotices } from '@/modules/notices/group';
import { NoticeSessionEnded, startNoticeLive, startNoticeReadOkSignal, type NoticeLiveHandle, type NoticeReadOkSignal } from '@/modules/notices/live';
import { announcement, decideSound } from '@/modules/notices/sound-policy';
import { askPopupPermission, popupAlreadyAsked, popupPermission, popupsSupported, showPopups } from '@/modules/notices/popup-browser';
import { decidePopup, nextPoppedSeq, type PopupPermission } from '@/modules/notices/popup-policy';
import { audioUnlocked, isSoundLeader, lastPlayedAt, playTone, startSoundLeader, unlockAudio } from './sound';
import { createDeviceAlertsClient } from '@/modules/notices/push-client';
import type { DeviceAlertsApi } from './device-alerts-types';
import type { NoticeHistory, NoticesConfig } from './types';

/*
 * One notices connection per tab (contract 9.4), shared by the bell buttons
 * in the sidebar (desktop) and the top bar (phone). Track C's live state
 * machine does the reading: Realtime on this person's staff_notices rows
 * (payload ignored, a debounced re-read through notice_inbox, which re-checks
 * access), a full re-read on every (re)subscribe and tab focus, a 30-second
 * poll, and on failure the last list plus "Notices may be out of date —
 * retrying" with retries after 5 s, 15 s, 60 s, then every 60 s. New notices
 * are announced to screen readers (urgent assertively, at most one every
 * 10 s) and play a sound when the person turned it on (sound-policy).
 *
 * S4 (contract 2.6 items 9-10): a refusal because the session ended throws
 * NoticeSessionEnded. After two such refusals in a row, at least 5 s apart,
 * the live state is 'ended': no 30-second poll and no Realtime channel, only
 * slow probes. `sessionEnded` is then true (and `stale` stays true), so the
 * bell's stale line can show "Your session has ended. Sign in again." instead
 * of the "retrying" text; the first successful probe clears both. Every
 * successful read posts a cross-tab "read ok" signal; an ended tab receiving
 * it probes at once (review 10b finding 1: the person signed in again in
 * another tab, and the ended tab may be the sound / pop-up leader). A tab
 * coming back to view (focus or visibilitychange) probes at once too.
 *
 * Accounts phase 2 (contract 8.4, 8.5): urgent notices also show a desktop
 * pop-up from the same leader tab when the CRM tab is not in front. Sound
 * and pop-ups are on by default (owner, Q12); each person turns them off in
 * the bell settings. The browser permission is asked once per browser on the
 * first click or key press after sign-in (track D's popup-policy / popup-browser).
 */

export interface NoticesState {
  loaded: boolean;
  inbox: NoticeInboxDTO | null;
  stale: boolean;
  /**
   * Two consecutive session refusals: the bell stopped polling and shows
   * NOTICE_ERROR_TEXT.session in its stale line (stale is true as well).
   * Cleared by the first successful probe.
   */
  sessionEnded: boolean;
  /** Sound is on but the browser has not allowed audio since the page loaded. */
  audioLocked: boolean;
  /** Notice ids whose mark failed twice: "Could not save — try again". */
  saveFailed: ReadonlySet<string>;
  /** Personal pop-up preference (default on; the inbox carries it once track D adds it). */
  popupsOn: boolean;
  /** This browser's notification permission, or 'unsupported'. */
  popupPermission: PopupPermission;
}

interface NoticesContextValue {
  state: NoticesState;
  grouped: GroupedNotices;
  mark: (n: NoticeItemDTO, action: NoticeMarkAction) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
  setSound: (on: boolean) => Promise<boolean>;
  setPopups: (on: boolean) => Promise<boolean>;
  /** "Allow pop-ups in this browser" (a click): asks the browser unless it already said no. */
  askPopups: () => Promise<PopupPermission>;
  testSound: () => Promise<boolean>;
  loadHistory: (beforeSeq: number | null) => Promise<NoticeHistory | null>;
  preview?: NoticesConfig['preview'];
  /** Phase 3: "Alerts on this device" calls (track D), or null until they exist. */
  deviceAlerts: DeviceAlertsApi | null;
}

/*
 * Shared through a tiny external store, NOT a React context wrapping the page.
 * A context provider around the page would push every bell update into the
 * page's own Suspense boundaries; an update reaching a boundary that is still
 * streaming makes React give up hydrating it and render it on the client,
 * which left a second, hidden copy of the page content in the document
 * (duplicate ids, lost focus and typed values; real journeys, 11 Nov 2026).
 * The bells subscribe to the store; the page content never re-renders.
 */
let current: NoticesContextValue | null = null;
const listeners = new Set<() => void>();
function publish(value: NoticesContextValue | null) {
  current = value;
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotices(): NoticesContextValue | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

const EMPTY_GROUPS: GroupedNotices = { urgent: [], entries: [] };

/** The inbox's pop-up preference; people without a saved choice read as on (contract 8.5). */
function popupsOnOf(inbox: NoticeInboxDTO | null | undefined): boolean {
  const v = (inbox as (NoticeInboxDTO & { popupsOn?: boolean }) | null | undefined)?.popupsOn;
  return v ?? true;
}

/** Renders the page unchanged and, beside it (not around it), the one notices connection of the tab. */
export function NoticesProvider({ config, children }: { config: NoticesConfig | null; children: ReactNode }) {
  return (
    <>
      {children}
      {config ? <NoticesHost config={config} /> : null}
    </>
  );
}

function NoticesHost({ config }: { config: NoticesConfig }) {
  const preview = config?.preview;
  const [state, setState] = useState<NoticesState>(() => ({
    loaded: !!preview,
    inbox: preview?.inbox ?? null,
    stale: !!preview?.outOfDate,
    sessionEnded: false,
    audioLocked: !!preview?.audioLocked,
    saveFailed: new Set(),
    popupsOn: preview?.popupsOn ?? popupsOnOf(preview?.inbox),
    popupPermission: preview?.popupPermission ?? 'default',
  }));
  const router = useRouter();
  const routerRef = useRef(router);
  const popupsOnRef = useRef(state.popupsOn);
  const lastPopped = useRef<number | null>(null);
  const [announce, setAnnounce] = useState<{ polite: string; assertive: string }>({ polite: '', assertive: '' });
  const live = useRef<NoticeLiveHandle | null>(null);
  const lastSeen = useRef<number | null>(null);
  const lastAnnounced = useRef<number | null>(null);
  const api = config?.api;
  const rt = config?.realtime ?? null;
  // The layout re-renders on every server action and refresh, handing new prop objects each time.
  // The live connection must NOT restart then (each restart fires a notice read, and server actions
  // run one at a time, so a page's own action would wait behind it): it keys on stable values only.
  const apiRef = useRef(api);
  const rtRef = useRef(rt);
  useEffect(() => {
    apiRef.current = api;
    rtRef.current = rt;
    routerRef.current = router;
    popupsOnRef.current = state.popupsOn;
  });
  const hasApi = !!api;
  const rtKey = rt ? `${rt.supabaseUrl}|${rt.supabasePublishableKey}|${rt.userId}` : null;

  // New rows since the last shown list: announce and maybe play (track C's policies decide).
  const onArrived = useCallback((inbox: NoticeInboxDTO) => {
    const seen = lastSeen.current;
    const now = Date.now();
    // Urgent notices are announced at once (never held back by the 10-second polite throttle).
    const freshUrgent = seen === null ? [] : inbox.items.filter((i) => i.seq > seen && isUnread(i) && isShownUrgent(i));
    const a = freshUrgent.length > 0 ? { politeness: 'assertive' as const, count: freshUrgent.length } : announcement(inbox.items, seen, lastAnnounced.current, now);
    if (a) {
      lastAnnounced.current = now;
      const fresh = inbox.items.filter((i) => seen !== null && i.seq > seen && isUnread(i));
      const urgent = fresh.find(isShownUrgent);
      const text = a.count === 1 ? noticeText(fresh[0]!) : `${a.count} new notices`;
      setAnnounce(a.politeness === 'assertive' ? { polite: '', assertive: `Urgent notice: ${urgent ? noticeText(urgent) : text}` } : { polite: `New notice: ${text}`, assertive: '' });
    }
    const d = decideSound({ soundOn: inbox.soundOn, isLeader: isSoundLeader(), audioUnlocked: audioUnlocked(), lastPlayedAt: lastPlayedAt(), now, items: inbox.items, lastSeenSeq: seen });
    if (d.play) playTone(d.tone);
    // Pop-ups (contract 8.4): urgent only, leader tab only, never while this tab is in front.
    const popped = lastPopped.current;
    const p = decidePopup({
      popupsOn: popupsOnRef.current,
      permission: popupPermission(),
      supported: popupsSupported(),
      isLeader: isSoundLeader(),
      tabVisibleAndFocused: document.visibilityState === 'visible' && document.hasFocus(),
      items: inbox.items,
      lastPoppedSeq: popped,
    });
    if (p.show) showPopups(p, (href) => routerRef.current.push(href));
    lastPopped.current = nextPoppedSeq(popped, inbox.latestSeq ?? null, p);
    lastSeen.current = inbox.latestSeq ?? seen;
  }, []);

  useEffect(() => {
    if (!hasApi || preview) return;
    startSoundLeader();
    let client: ReturnType<typeof createClient> | null = null;
    let readOk: NoticeReadOkSignal | null = null;
    const handle = startNoticeLive({
      read: async (afterSeq) => {
        const current = apiRef.current;
        if (!current) throw new Error('not available');
        // Track C: reads go through GET /api/notices, never a Server Action, so the
        // poll and catch-up never queue with the page's own actions.
        const r = await (current.inbox ?? fetchNoticeInbox)(afterSeq);
        if (r.ok) {
          // Tells ended tabs (signed out, then signed in again here) to probe now.
          readOk?.post();
          return r.data;
        }
        // An ended session: the live state machine stops polling after a second one in a row.
        if (r.code === 'session') throw new NoticeSessionEnded();
        // Any other refusal keeps the last list and retries with back-off.
        throw new Error(r.message);
      },
      onState: (s) => {
        if (s.inbox) onArrived(s.inbox);
        setState((prev) => ({
          ...prev,
          loaded: prev.loaded || s.inbox !== null,
          inbox: s.inbox ?? prev.inbox,
          stale: s.stale,
          sessionEnded: s.mode === 'ended',
          audioLocked: !!(s.inbox ?? prev.inbox)?.soundOn && !audioUnlocked(),
          // The first read carries the saved pop-up choice; a later local change wins until the next read.
          popupsOn: s.inbox ? popupsOnOf(s.inbox) : prev.popupsOn,
        }));
      },
      subscribe: ({ onChange, onStatus }) => {
        const rt = rtRef.current;
        if (!rt || !rtKey) throw new Error('no realtime');
        // Opened again after an ended session: reuse this tab's client (one auth client per tab).
        client ??= createClient(rt.supabaseUrl, rt.supabasePublishableKey, { accessToken: async () => (await ((rtRef.current ?? rt).getToken ?? fetchRealtimeToken)().catch(() => null)) ?? '' });
        const channel = client
          .channel(`notices-${rt.userId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_notices', filter: `recipient_user_id=eq.${rt.userId}` }, () => onChange())
          .subscribe((status) => onStatus(status as Parameters<typeof onStatus>[0]));
        // Removing the last channel closes the socket too (realtime-js 2.117.2:
        // channel close -> RealtimeClient._remove -> disconnect after
        // disconnectOnEmptyChannelsAfterMs, default 2 x 25 s heartbeat), so an
        // ended tab sends no heartbeats and asks for no token. Library code only;
        // not covered by a test here (review 10b finding 6: check the request logs on day 1).
        return () => {
          void client?.removeChannel(channel);
        };
      },
    });
    live.current = handle;
    readOk = startNoticeReadOkSignal(() => handle.sessionOk());
    const onFocus = () => handle.focus();
    const onVisible = () => {
      if (document.visibilityState === 'visible') handle.focus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      readOk?.stop();
      readOk = null;
      handle.stop();
      live.current = null;
      void client?.removeAllChannels();
    };
  }, [hasApi, preview, rtKey, onArrived]);

  // After a reload audio is locked: the first click anywhere turns sound back on.
  useEffect(() => {
    if (!state.audioLocked) return;
    const onClick = () => {
      void unlockAudio().then((ok) => {
        if (ok) setState((s) => ({ ...s, audioLocked: false }));
      });
    };
    document.addEventListener('click', onClick, { once: true });
    return () => document.removeEventListener('click', onClick);
  }, [state.audioLocked]);

  // Pop-up permission (contract 8.4): read it on mount, then ask once per browser on the first
  // click or key press after sign-in while pop-ups are on. Denied is never asked again.
  useEffect(() => {
    if (preview) return;
    const frame = requestAnimationFrame(() => setState((s) => ({ ...s, popupPermission: popupPermission() })));
    return () => cancelAnimationFrame(frame);
  }, [preview]);
  const askOnFirstInput = !preview && state.popupsOn && state.popupPermission === 'default';
  useEffect(() => {
    if (!askOnFirstInput || popupAlreadyAsked()) return;
    const onInput = () => {
      remove();
      void askPopupPermission(false, popupsOnRef.current).then((perm) => setState((s) => ({ ...s, popupPermission: perm })));
    };
    const remove = () => {
      document.removeEventListener('pointerdown', onInput, true);
      document.removeEventListener('keydown', onInput, true);
    };
    document.addEventListener('pointerdown', onInput, true);
    document.addEventListener('keydown', onInput, true);
    return remove;
  }, [askOnFirstInput]);

  const patchItem = useCallback((noticeId: string, readAt: string | null, doneAt: string | null) => {
    setState((s) => {
      if (!s.inbox) return s;
      const before = s.inbox.items.find((x) => x.noticeId === noticeId);
      const items = s.inbox.items.map((x) => (x.noticeId === noticeId ? { ...x, readAt, doneAt } : x));
      const closed = before && isUnread(before) && doneAt !== null;
      const saveFailed = new Set(s.saveFailed);
      saveFailed.delete(noticeId);
      return {
        ...s,
        saveFailed,
        inbox: {
          ...s.inbox,
          items,
          unreadCount: closed ? Math.max(0, s.inbox.unreadCount - 1) : s.inbox.unreadCount,
          urgentCount: closed && isShownUrgent(before) ? Math.max(0, s.inbox.urgentCount - 1) : s.inbox.urgentCount,
        },
      };
    });
  }, []);

  const mark = useCallback(
    async (n: NoticeItemDTO, action: NoticeMarkAction): Promise<boolean> => {
      if (preview) {
        const now = new Date().toISOString();
        patchItem(n.noticeId, now, action === 'read' && isShownUrgent(n) ? null : now);
        return true;
      }
      if (!api) return false;
      // Retried once; still failing: the notice stays unread with "Could not save — try again".
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const r = await api.mark(n.noticeId, action);
          if (r.ok) {
            patchItem(n.noticeId, r.data.readAt, r.data.doneAt);
            return true;
          }
        } catch {
          /* retry once */
        }
      }
      setState((s) => ({ ...s, saveFailed: new Set(s.saveFailed).add(n.noticeId) }));
      return false;
    },
    [api, preview, patchItem],
  );

  const markAllRead = useCallback(async (): Promise<boolean> => {
    const applyAll = () =>
      setState((s) => {
        if (!s.inbox) return s;
        const now = new Date().toISOString();
        const items = s.inbox.items.map((x) => (isUnread(x) && !isShownUrgent(x) ? { ...x, readAt: now, doneAt: now } : x));
        // Urgent notices stay until opened or Done, so only they remain unread.
        return { ...s, inbox: { ...s.inbox, items, unreadCount: s.inbox.urgentCount } };
      });
    if (preview) {
      applyAll();
      return true;
    }
    if (!api) return false;
    try {
      const r = await api.markAllRead();
      if (!r.ok) return false;
      applyAll();
      live.current?.refresh();
      return true;
    } catch {
      return false;
    }
  }, [api, preview]);

  const setSound = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (on) await unlockAudio();
      const apply = (soundOn: boolean) => setState((s) => (s.inbox ? { ...s, inbox: { ...s.inbox, soundOn }, audioLocked: soundOn && !audioUnlocked() } : s));
      if (preview) {
        apply(on);
        return true;
      }
      if (!api) return false;
      try {
        const r = await api.setSound(on);
        if (!r.ok) return false;
        apply(r.data.soundOn);
        return true;
      } catch {
        return false;
      }
    },
    [api, preview],
  );

  const askPopups = useCallback(async (): Promise<PopupPermission> => {
    if (preview) return state.popupPermission;
    const perm = await askPopupPermission(true);
    setState((s) => ({ ...s, popupPermission: perm }));
    return perm;
  }, [preview, state.popupPermission]);

  const setPopups = useCallback(
    async (on: boolean): Promise<boolean> => {
      const apply = (popupsOn: boolean) => setState((s) => ({ ...s, popupsOn }));
      if (preview) {
        apply(on);
        return true;
      }
      // Turning pop-ups on is a click: ask the browser now when it has not been asked.
      if (on) void askPopups();
      if (!api?.setPopups) return false;
      try {
        const r = await api.setPopups(on);
        if (!r.ok) return false;
        apply(r.data.popupsOn ?? on);
        return true;
      } catch {
        return false;
      }
    },
    [api, preview, askPopups],
  );

  const testSound = useCallback(async (): Promise<boolean> => {
    const ok = await unlockAudio();
    if (!ok) return false;
    setState((s) => ({ ...s, audioLocked: false }));
    return playTone('urgent');
  }, []);

  const loadHistory = useCallback(
    async (beforeSeq: number | null): Promise<NoticeHistory | null> => {
      if (preview) return preview.history ?? { enabled: true, items: [], nextBefore: null };
      if (!api) return null;
      try {
        const r = await (api.history ?? fetchNoticeHistory)(beforeSeq);
        return r.ok ? r.data : null;
      } catch {
        return null;
      }
    },
    [api, preview],
  );

  const grouped = useMemo(() => (state.inbox ? groupNotices(state.inbox.items) : EMPTY_GROUPS), [state.inbox]);
  const pushConfig = config.api.push;
  const explicitAlerts = config.api.deviceAlerts;
  const deviceAlerts = useMemo<DeviceAlertsApi | null>(
    () => explicitAlerts ?? (pushConfig ? createDeviceAlertsClient(pushConfig.actions, pushConfig.vapidPublicKey) : null),
    [explicitAlerts, pushConfig],
  );
  const value = useMemo<NoticesContextValue>(() => ({ state, grouped, mark, markAllRead, setSound, setPopups, askPopups, testSound, loadHistory, preview, deviceAlerts }),
    [state, grouped, mark, markAllRead, setSound, setPopups, askPopups, testSound, loadHistory, preview, deviceAlerts],
  );
  // Published after commit (never during render); cleared when the shell unmounts.
  useEffect(() => {
    publish(value);
  }, [value]);
  useEffect(() => () => publish(null), []);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {announce.polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {announce.assertive}
      </div>
    </>
  );
}
