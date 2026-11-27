'use client';

import { Bell, BellOff, BellRing, ChevronRight, CircleCheck, CircleSlash, History, MonitorX, RefreshCw, Settings2, TriangleAlert, Volume2, VolumeX } from 'lucide-react';
import Link from 'next/link';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { groupedText, isShownUrgent, isUnread, NOTICE_ERROR_TEXT, NOTICE_TEXT, noticeText, pushEnabledOf } from '@/modules/notices/contracts';
import type { NoticeEntry } from '@/modules/notices/group';
import { noticeHref } from '@/modules/notices/href';
import { DeviceAlertsSection } from './device-alerts';
import { useNotices } from './provider';
import type { NoticeHistory, NoticeItem } from './types';

/*
 * The notification bell (contract 9.4, 11.5): a button with the unread count
 * (and a second, labelled urgent count, never colour alone) that opens a
 * popover dialog: urgent notices first (never grouped, "Open" and "Done"),
 * then the normal ones grouped per Deal ("{n} updates on {BX}", expandable,
 * "Open" and "Mark read"), "Mark all read", History (30 days) and Sound
 * settings. Hidden while notices are switched off. Shared state comes from
 * NoticesProvider (one connection per tab). 21st.dev ideas: "Notification
 * Panel" (seen vs dealt with) and "NotificationInbox Popover" (header action,
 * footer link); built on the CRM kit (DESIGN-NOTES.md).
 */

const TIME = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const timeText = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : TIME.format(t);
};

type View = 'inbox' | 'history' | 'settings';

/**
 * Where the bell sits (UX redesign R1, B1): 'sidebar' is the desktop sidebar's header row beside the
 * wordmark (the panel opens to the right, under the bell); 'top' is the phone top bar (opens to the left).
 * The button is the same compact bell in both; its name always starts with "Notices".
 */
export type NoticeBellPlacement = 'sidebar' | 'top';

export function NoticeBell({ id, placement = 'top' }: { id: string; placement?: NoticeBellPlacement }) {
  const ctx = useNotices();
  const p = ctx?.preview;
  const [open, setOpen] = useState(false);
  // Preview gallery: open the bell that is visible at this width (sidebar on desktop, top bar on phones).
  const [view, setView] = useState<View>(p?.view ?? 'inbox');
  // The shared store is published after the first commit, so the preview's view is applied here too.
  useEffect(() => {
    if (!p?.open || window.matchMedia('(min-width: 1024px)').matches !== (placement === 'sidebar')) return;
    const frame = requestAnimationFrame(() => {
      setView(p.view ?? 'inbox');
      setOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [p?.open, p?.view, placement]);
  const headingId = useId();
  if (!ctx || !ctx.state.loaded || !ctx.state.inbox?.enabled) return null;
  const { state } = ctx;
  const inbox = ctx.state.inbox;
  const unread = inbox.unreadCount;
  const urgent = inbox.urgentCount;
  const soundPaused = state.audioLocked && inbox.soundOn;
  const label = `Notices: ${unread === 0 ? 'none unread' : `${unread} unread`}${urgent > 0 ? `, ${urgent} urgent` : ''}${state.stale ? ', may be out of date' : ''}${soundPaused ? ', sound paused until you click the page' : ''}`;
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setView('inbox');
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-label={label}
          className={cn(
            'relative inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-line bg-card px-2.5 text-ink hover:bg-wash',
            focusRing,
          )}
        >
          {state.stale ? <BellOff aria-hidden="true" className="size-5 text-quiet" /> : <Bell aria-hidden="true" className="size-5" />}
          {unread > 0 ? (
            <span aria-hidden="true" className="min-w-5 rounded-full bg-brand-strong px-1.5 text-xs leading-5 font-semibold text-white tabular-nums">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
          {urgent > 0 ? (
            <span aria-hidden="true" className="inline-flex items-center gap-0.5 rounded-full border border-status-danger-line bg-status-danger-tint px-1.5 text-xs leading-5 font-semibold text-status-danger">
              <TriangleAlert className="size-3" />
              {urgent}
              <span className="max-sm:hidden"> urgent</span>
            </span>
          ) : null}
          {soundPaused ? (
            <span aria-hidden="true" title="Sound paused: click anywhere to turn it back on" className="inline-flex items-center gap-0.5 rounded-full border border-line bg-wash px-1.5 text-xs leading-5 font-medium text-quiet">
              <VolumeX className="size-3" />
              <span className="max-sm:hidden">paused</span>
            </span>
          ) : null}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={placement === 'sidebar' ? 'start' : 'end'}
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={headingId}
          className={cn(
            'z-50 flex max-h-[calc(100dvh-5rem)] w-[26rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-card border border-line bg-card font-sans text-base text-copy shadow-overlay outline-none',
            'data-[state=open]:animate-ui-pop-in data-[state=closed]:animate-ui-pop-out motion-reduce:animate-none',
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 id={headingId} tabIndex={-1} data-notice-heading className="m-0 text-lg font-semibold text-ink outline-none">
              {view === 'history' ? 'Notice history' : view === 'settings' ? 'Sound, pop-ups and alerts' : 'Notices'}
            </h2>
            <div className="flex items-center gap-1">
              {view !== 'inbox' ? (
                <Button variant="ghost" size="sm" onClick={() => setView('inbox')}>
                  Back to notices
                </Button>
              ) : (
                <>
                  {/* B1: a visible word on the settings button; the name keeps the full description. */}
                  <Button variant="ghost" size="sm" onClick={() => setView('settings')} aria-label="Sound, pop-up and alert settings">
                    <Settings2 aria-hidden="true" />
                    Settings
                  </Button>
                </>
              )}
            </div>
          </div>
          {state.stale ? (
            <p role="status" className="m-0 flex items-start gap-2 border-b border-status-warning-line bg-status-warning-tint px-4 py-2 text-sm text-copy">
              {/* S4: after an ended session the bell no longer retries, so no spinning icon and the session text. */}
              {state.sessionEnded ? (
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
              ) : (
                <RefreshCw aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-warning motion-safe:animate-spin" />
              )}
              {state.sessionEnded ? NOTICE_ERROR_TEXT.session : `${NOTICE_TEXT.outOfDate}. Your work lists and Home counts are not affected.`}
            </p>
          ) : null}
          {state.audioLocked && inbox.soundOn ? (
            <p className="m-0 flex items-start gap-2 border-b border-line bg-wash px-4 py-2 text-sm text-copy">
              <VolumeX aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-quiet" />
              {NOTICE_TEXT.soundUnlock}.
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {view === 'inbox' ? <Inbox onHistory={() => setView('history')} close={() => setOpen(false)} /> : view === 'history' ? <HistoryView close={() => setOpen(false)} /> : <SoundSettings />}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function Inbox({ onHistory, close }: { onHistory: () => void; close: () => void }) {
  const ctx = useNotices()!;
  const { urgent, entries } = ctx.grouped;
  const lines = entries.filter((e) => e.type === 'group' || isUnread(e.item));
  const [allMsg, setAllMsg] = useState<string | null>(null);
  const normalOpen = lines.length > 0;
  return (
    <div className="flex flex-col">
      {urgent.length === 0 && !normalOpen ? (
        <p className="m-0 px-4 py-6 text-center text-copy">{NOTICE_TEXT.empty}. New work and decisions show here.</p>
      ) : null}
      {urgent.length > 0 ? (
        <section aria-labelledby="notices-urgent">
          <h3 id="notices-urgent" className="m-0 px-4 pt-3 pb-1 text-xs font-semibold tracking-label text-status-danger uppercase">
            Urgent · stays until you open it or press Done
          </h3>
          <ul className="m-0 list-none p-0">
            {urgent.map((n) => (
              <NoticeRow key={n.noticeId} n={n} urgent close={close} />
            ))}
          </ul>
        </section>
      ) : null}
      {normalOpen ? (
        <section aria-labelledby="notices-normal">
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
            <h3 id="notices-normal" className="m-0 text-xs font-semibold tracking-label text-quiet uppercase">
              New
            </h3>
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                void ctx.markAllRead().then((ok) => {
                  setAllMsg(ok ? 'All normal notices marked read. Urgent ones stay until opened or Done.' : `${NOTICE_TEXT.couldNotSave}.`);
                  // The button may leave the list: keep focus inside the panel.
                  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-notice-heading]')?.focus());
                })
              }
            >
              Mark all read
            </Button>
          </div>
          <ul className="m-0 list-none p-0">
            {lines.map((l) => (l.type === 'single' ? <NoticeRow key={l.item.noticeId} n={l.item} close={close} /> : <GroupRow key={`g-${l.items[0]!.noticeId}`} line={l} close={close} />))}
          </ul>
        </section>
      ) : null}
      {allMsg ? (
        <p role="status" className="m-0 px-4 py-2 text-sm text-copy">
          {allMsg}
        </p>
      ) : null}
      <div className="mt-[0.25rem] flex flex-col gap-1 border-t border-line px-4 py-3 text-sm text-quiet">
        <button type="button" onClick={onHistory} className={cn('inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-chip border-0 bg-transparent p-0 font-medium text-brand-strong underline underline-offset-4', focusRing)}>
          <History aria-hidden="true" className="size-4" />
          History (last 30 days)
        </button>
        <span>Notices never replace your work lists: Home and each queue still show everything.</span>
      </div>
    </div>
  );
}

function GroupRow({ line, close }: { line: Extract<NoticeEntry, { type: 'group' }>; close: () => void }) {
  return (
    <li className="m-0 border-b border-line last:border-b-0">
      <details className="group/notice">
        <summary className={cn('flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2.5 hover:bg-wash [&::-webkit-details-marker]:hidden', focusRing, 'focus-visible:outline-offset-[-2px]')}>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-quiet transition-transform group-open/notice:rotate-90 motion-reduce:transition-none" />
          <span className="font-semibold text-ink">
            {groupedText(line.items.length, line.dealReference)}
          </span>
          <span className="ml-auto text-xs text-quiet">{timeText(line.items[0]!.createdAt)}</span>
        </summary>
        <ul className="m-0 list-none border-t border-line bg-canvas p-0 pl-4">
          {line.items.map((n) => (
            <NoticeRow key={n.noticeId} n={n} close={close} nested />
          ))}
        </ul>
      </details>
    </li>
  );
}

function NoticeRow({ n, urgent = false, close, nested = false, readOnly = false }: { n: NoticeItem; urgent?: boolean; close: () => void; nested?: boolean; readOnly?: boolean }) {
  const ctx = useNotices()!;
  const href = noticeHref(n);
  const failed = ctx.state.saveFailed.has(n.noticeId);
  const text = noticeText(n);
  const open = isUnread(n);
  return (
    <li className={cn('m-0 flex flex-col gap-1.5 border-b border-line px-4 py-3 last:border-b-0', urgent && 'border-l-4 border-l-status-danger bg-status-danger-tint/40', nested && 'pl-2')}>
      <div className="flex items-start gap-2">
        {urgent ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-danger-line bg-status-danger-tint px-1.5 text-xs leading-5 font-semibold text-status-danger">
            <TriangleAlert aria-hidden="true" className="size-3" />
            Urgent
          </span>
        ) : null}
        <p className={cn('m-0 min-w-0 flex-1 wrap-anywhere', open ? 'font-semibold text-ink' : 'text-copy')}>
          {text}
          {!open ? <span className="sr-only"> (read)</span> : null}
          {n.escalated && n.priority !== 'urgent' ? <span className="block text-sm font-normal text-quiet">Waiting over one working day.</span> : null}
        </p>
      </div>
      <p className="m-0 text-xs text-quiet">
        {timeText(n.createdAt)}
        {n.resolvedReason ? ` · ${RESOLVED_TEXT[n.resolvedReason] ?? 'Handled'}` : ''}
      </p>
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          {href ? (
            <Link
              href={href}
              onClick={() => {
                if (open) void ctx.mark(n, 'open');
                close();
              }}
              className={cn('inline-flex min-h-9 items-center rounded-control border border-line-strong bg-card px-3 text-sm font-semibold text-ink no-underline hover:bg-wash', focusRing)}
            >
              Open<span className="sr-only">: {text}</span>
            </Link>
          ) : null}
          {open ? (
            <Button
              variant={urgent ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() =>
                void ctx.mark(n, urgent ? 'done' : 'read').then((ok) => {
                  // The pressed button leaves the list: keep focus inside the panel.
                  if (ok) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-notice-heading]')?.focus());
                })
              }
            >
              {urgent ? 'Done' : 'Mark read'}
              <span className="sr-only">: {text}</span>
            </Button>
          ) : null}
          {failed ? (
            <span role="alert" className="text-sm font-medium text-status-danger">
              {NOTICE_TEXT.couldNotSave}.
            </span>
          ) : null}
        </div>
      ) : href ? (
        <Link href={href} onClick={close} className={cn('w-fit rounded-chip text-sm font-medium text-brand-strong underline underline-offset-4', focusRing)}>
          Open<span className="sr-only">: {text}</span>
        </Link>
      ) : null}
    </li>
  );
}

const RESOLVED_TEXT: Record<string, string> = {
  acted: 'Done by you or a colleague',
  taken: 'Taken by a colleague',
  handled_by_other: 'Handled by a colleague',
  reassigned: 'Work moved to a colleague',
  revised: 'Booking sent again',
  superseded: 'Replaced by a newer request',
};

function HistoryView({ close }: { close: () => void }) {
  const ctx = useNotices()!;
  const [data, setData] = useState<NoticeHistory | 'loading' | 'error'>(() => (ctx.preview ? (ctx.preview.history ?? { enabled: true, items: [], nextBefore: null }) : 'loading'));
  // First page once on open (the ref guards against a second fetch, e.g. Strict Mode's double effect).
  const started = useRef(false);
  const loadHistory = ctx.loadHistory;
  const needsLoad = data === 'loading';
  useEffect(() => {
    if (!needsLoad || started.current) return;
    started.current = true;
    // Not cancelled on cleanup: the one request's answer is used (a late setState after closing is harmless).
    void loadHistory(null).then((h) => setData(h ?? 'error'));
  }, [needsLoad, loadHistory]);
  if (data === 'loading') return <p className="m-0 px-4 py-6 text-center text-quiet">Loading history…</p>;
  if (data === 'error') return <p className="m-0 px-4 py-6 text-center text-copy">The history could not be loaded. Close and open the bell to try again.</p>;
  const more = data.nextBefore;
  return (
    <div className="flex flex-col">
      <p className="m-0 px-4 pt-3 text-sm text-quiet">Read, done and handled notices of the last 30 days.</p>
      {data.items.length === 0 ? <p className="m-0 px-4 py-6 text-center text-copy">Nothing in the last 30 days.</p> : null}
      <ul className="m-0 list-none p-0">
        {data.items.map((n) => (
          <NoticeRow key={n.noticeId} n={n} close={close} readOnly urgent={isShownUrgent(n)} />
        ))}
      </ul>
      {more !== null ? (
        <div className="px-4 py-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void ctx.loadHistory(more).then((h) => {
                if (h && typeof data === 'object') setData({ ...h, items: [...data.items, ...h.items] });
              })
            }
          >
            Show older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SoundSettings() {
  const ctx = useNotices()!;
  const [msg, setMsg] = useState<string | null>(null);
  const on = !!ctx.state.inbox?.soundOn;
  const popupsOn = ctx.state.popupsOn;
  const perm = ctx.state.popupPermission;
  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <section aria-labelledby="bell-sound-h" className="flex flex-col gap-2">
        <h3 id="bell-sound-h" className="m-0 text-base font-semibold text-ink">
          Sound: {on ? 'on' : 'off'}
        </h3>
        <p className="m-0 text-copy">Urgent notices play a distinct three-note tone; new tasks a single soft tone; other notices are silent. At most one sound every 10 seconds, from one open tab.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void ctx.setSound(!on).then((ok) => setMsg(ok ? (on ? 'Sound turned off.' : 'Sound turned on.') : `${NOTICE_TEXT.couldNotSave}.`))}>
            {on ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
            {on ? 'Turn sound off' : 'Turn sound on'}
          </Button>
          <Button variant="ghost" onClick={() => void ctx.testSound().then((ok) => setMsg(ok ? 'Test sound played. Sound can now play in this tab.' : 'This browser did not allow sound. Check that the tab is not muted.'))}>
            {NOTICE_TEXT.testSound}
          </Button>
        </div>
        <p className="m-0 text-sm text-quiet">{NOTICE_TEXT.soundLimits}</p>
      </section>
      <section aria-labelledby="bell-popup-h" className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 id="bell-popup-h" className="m-0 text-base font-semibold text-ink">
          Pop-ups: {popupsOn ? 'on' : 'off'}
        </h3>
        <p className="m-0 text-copy">{NOTICE_TEXT.popupsLimits} They show the reference, never names or amounts.</p>
        <PopupStateLine popupsOn={popupsOn} permission={perm} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void ctx.setPopups(!popupsOn).then((ok) => setMsg(ok ? (popupsOn ? 'Pop-ups turned off.' : 'Pop-ups turned on.') : `${NOTICE_TEXT.couldNotSave}.`))}>
            {popupsOn ? <BellOff aria-hidden="true" /> : <BellRing aria-hidden="true" />}
            {popupsOn ? 'Turn pop-ups off' : 'Turn pop-ups on'}
          </Button>
          {popupsOn && perm === 'default' ? (
            <Button
              variant="ghost"
              onClick={() =>
                void ctx.askPopups().then((p) =>
                  setMsg(p === 'granted' ? 'Pop-ups allowed in this browser.' : p === 'denied' ? 'This browser blocked pop-ups. Allow notifications for this site in the browser settings.' : 'The browser did not answer. Try again.'),
                )
              }
            >
              Allow pop-ups in this browser
            </Button>
          ) : null}
        </div>
      </section>
      {msg ? (
        <p role="status" className="m-0 text-sm text-copy">
          {msg}
        </p>
      ) : (
        <div role="status" className="contents" />
      )}
      <DeviceAlertsSection api={ctx.deviceAlerts} pushEnabled={pushEnabledOf(ctx.state.inbox)} preview={ctx.preview?.deviceAlerts} />
      <p className="m-0 text-sm text-quiet">Do not rely on sound, pop-ups or alerts: the bell and your work lists always show the work.</p>
    </div>
  );
}

/** The browser's side of pop-ups, in words (contract 8.4); never colour alone. */
function PopupStateLine({ popupsOn, permission }: { popupsOn: boolean; permission: 'default' | 'granted' | 'denied' | 'unsupported' }) {
  const line =
    permission === 'unsupported'
      ? { icon: MonitorX, text: `${NOTICE_TEXT.popupsUnsupported}.` }
      : permission === 'denied'
        ? { icon: CircleSlash, text: `${NOTICE_TEXT.popupsBlocked}.` }
        : !popupsOn
          ? { icon: BellOff, text: 'Pop-ups off. Urgent notices still show in the bell and play the urgent sound when sound is on.' }
          : permission === 'granted'
            ? { icon: CircleCheck, text: 'Pop-ups on in this browser.' }
            : { icon: Bell, text: 'This browser has not been asked yet. It asks on your next click; choose Allow.' };
  const Icon = line.icon;
  return (
    <p className="m-0 flex items-start gap-2 rounded-control border border-line bg-wash px-3 py-2 text-sm text-copy">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-quiet" />
      <span>
        <span className="sr-only">This browser: </span>
        {line.text}
      </span>
    </p>
  );
}
