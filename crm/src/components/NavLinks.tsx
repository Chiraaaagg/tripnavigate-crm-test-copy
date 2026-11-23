'use client';

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookCheck,
  Briefcase,
  Building2,
  CalendarClock,
  Circle,
  ClipboardCheck,
  ClipboardList,
  FileText,
  FolderSearch,
  House,
  Inbox,
  KeyRound,
  Landmark,
  ListChecks,
  Map as MapIcon,
  Plane,
  ReceiptText,
  ScrollText,
  Settings,
  Stamp,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  currentMenuKey,
  groupCount,
  type MenuCounts,
  type MenuGroupKey,
  type MenuLink,
  menuFromLinks,
  type SectionIcon,
  type SectionKey,
  type SectionLink,
} from '@/app/app/sections';
import { cn, focusRing } from '@/components/ui/cn';
import { Collapsible } from '@/components/ui/collapsible';
import { NavCount } from '@/components/ui/sidebar-nav';

/** One picture per link name (CQ-6: the name is chosen where the link is built, in sections.ts). */
const ICONS: Record<SectionIcon, LucideIcon> = {
  house: House,
  'list-checks': ListChecks,
  inbox: Inbox,
  briefcase: Briefcase,
  'file-text': FileText,
  map: MapIcon,
  'calendar-clock': CalendarClock,
  'clipboard-list': ClipboardList,
  'receipt-text': ReceiptText,
  plane: Plane,
  stamp: Stamp,
  'building-2': Building2,
  'scroll-text': ScrollText,
  'clipboard-check': ClipboardCheck,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-up-from-line': ArrowUpFromLine,
  landmark: Landmark,
  'folder-search': FolderSearch,
  'book-check': BookCheck,
  settings: Settings,
};

/** The link that marks the current page: the longest matching address (so /app/purchase/suppliers marks "Suppliers" only). */
export function currentHref(hrefs: string[], path: string | null | undefined): string | undefined {
  const matches = (href: string) => (href === '/app' ? path === '/app' : !!path && (path === href || path.startsWith(`${href}/`)));
  return hrefs.filter(matches).sort((x, y) => y.length - x.length)[0];
}

/**
 * The current item's href: currentHref over the hrefs, plus each item's
 * activePrefix. Longest matching address wins, so an exact item beats a
 * shorter prefix.
 */
export function currentNavHref(items: Array<{ href: string; activePrefix?: string }>, path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const matches = (prefix: string) => (prefix === '/app' ? path === '/app' : path === prefix || path.startsWith(`${prefix}/`));
  let best: { href: string; length: number } | undefined;
  for (const item of items) {
    for (const prefix of item.activePrefix ? [item.href, item.activePrefix] : [item.href]) {
      if (matches(prefix) && (!best || prefix.length > best.length)) best = { href: item.href, length: prefix.length };
    }
  }
  return best?.href;
}

// ---------------------------------------------------------------------------
// Folded groups, remembered on this device (C11, design plan 1.1)
// ---------------------------------------------------------------------------

/** localStorage key. Holds the folded group keys as a JSON list. */
export const FOLD_STORAGE_KEY = 'tn-nav-folded';
const FOLDABLE: readonly MenuGroupKey[] = ['sales', 'desks', 'accounts'];

/** The folded groups in a stored value; anything unreadable counts as "none folded". */
export function parseFoldedGroups(raw: string | null | undefined): MenuGroupKey[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return FOLDABLE.filter((key) => value.includes(key));
  } catch {
    return [];
  }
}

/** The stored list after folding (open = false) or unfolding (open = true) one group. */
export function withGroupFolded(folded: readonly MenuGroupKey[], key: MenuGroupKey, open: boolean): MenuGroupKey[] {
  const rest = folded.filter((k) => k !== key);
  return open ? rest : FOLDABLE.filter((k) => k === key || rest.includes(k));
}

/**
 * Whether a group shows its links. A group the person folded stays folded on
 * every page, except the group holding the current page, which opens on
 * arrival (so the current link is always visible) until the person folds it
 * again on this page (closedHere).
 */
export function isGroupOpen(key: MenuGroupKey, folded: readonly MenuGroupKey[], currentGroup: MenuGroupKey | undefined, closedHere: readonly MenuGroupKey[] = []): boolean {
  if (key === currentGroup) return !closedHere.includes(key);
  return !folded.includes(key);
}

// One store for every menu in the page (sidebar and phone sheet), so a fold shows in both.
// Storage can be blocked (private mode, policy): the choice then lasts until the page is reloaded.
let memoryFolded: string | null = null;
const foldListeners = new Set<() => void>();

function readFoldedRaw(): string {
  try {
    const stored = window.localStorage.getItem(FOLD_STORAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    // Storage blocked: fall back to this page's memory.
  }
  return memoryFolded ?? '[]';
}

function writeFolded(list: MenuGroupKey[]) {
  const raw = JSON.stringify(list);
  memoryFolded = raw;
  try {
    window.localStorage.setItem(FOLD_STORAGE_KEY, raw);
  } catch {
    // Storage blocked: memoryFolded keeps the choice for this page.
  }
  foldListeners.forEach((listener) => listener());
}

function subscribeFolded(listener: () => void) {
  foldListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === FOLD_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    foldListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The folded groups; on the server and during hydration nothing is folded (every link is in the page HTML). */
function useFoldedGroups(): MenuGroupKey[] {
  const raw = useSyncExternalStore(subscribeFolded, readFoldedRaw, () => '[]');
  return parseFoldedGroups(raw);
}

// ---------------------------------------------------------------------------
// Counts: given at once (preview) or as a promise the layout streams in
// ---------------------------------------------------------------------------

const settledCounts = new WeakMap<PromiseLike<MenuCounts>, MenuCounts>();

function isPromiseLike(value: unknown): value is PromiseLike<MenuCounts> {
  return !!value && typeof (value as PromiseLike<MenuCounts>).then === 'function';
}

/**
 * The counts to show. A promise never holds the menu back: links render at
 * once without badges, and the badges appear when the reads finish. A promise
 * that fails shows no badge (each read already turns its own failure into
 * "count not known").
 */
function useMenuCounts(counts: MenuCounts | PromiseLike<MenuCounts> | undefined): MenuCounts {
  const [resolved, setResolved] = useState<MenuCounts | undefined>(() => (isPromiseLike(counts) ? settledCounts.get(counts) : undefined));
  useEffect(() => {
    if (!isPromiseLike(counts)) return;
    let live = true;
    counts.then(
      (value) => {
        settledCounts.set(counts, value);
        if (live) setResolved(value);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [counts]);
  if (!counts) return {};
  return isPromiseLike(counts) ? (resolved ?? settledCounts.get(counts) ?? {}) : counts;
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

const LINK = cn(
  'group/navlink flex min-h-9 w-full items-center gap-2.5 overflow-hidden rounded-control px-2.5 py-1.5 text-left text-base font-medium text-copy no-underline',
  'transition-[color,background-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
  'hover:bg-wash hover:text-ink',
  'aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
  focusRing,
  'focus-visible:outline-offset-0',
);

function NavLink({ link, current }: { link: MenuLink; current: boolean }) {
  const Icon = ICONS[link.icon] ?? Circle;
  return (
    <li className="relative m-0">
      <Link href={link.href} aria-current={current ? 'page' : undefined} className={LINK} data-section={link.key}>
        <Icon aria-hidden="true" className={cn('size-4 shrink-0', current ? 'text-brand' : 'text-quiet')} />
        <span className="min-w-0 flex-1">{link.label}</span>
        <NavCount count={link.count} word={link.countWord} />
      </Link>
    </li>
  );
}

function LinkList({ links, current }: { links: MenuLink[]; current: SectionKey | undefined }) {
  return (
    <ul className="m-0 flex w-full min-w-0 list-none flex-col gap-0.5 p-0">
      {links.map((link) => (
        <NavLink key={link.key} link={link} current={link.key === current} />
      ))}
    </ul>
  );
}

/**
 * The staff frame's menu (C1: shadcn Sidebar look, 21st.dev id 1627, MIT;
 * group folds on Radix Collapsible, C11). Groups: top (no heading), Sales,
 * Desks, Accounts; a group with one link has no heading. Group headings are
 * buttons that fold the group; the choice is remembered on this device and
 * a folded group shows its total count on the heading. Settings is pinned
 * below the scrolling list, so it can never be scrolled out of sight.
 * Server-rendered links with every group open, so the menu works without
 * script; the current page carries aria-current="page", a heavier weight and
 * the tint (never colour alone). No fold animation (motion rule).
 *
 * layout="sidebar": the list scrolls inside the column with Settings pinned
 * under it. layout="sheet" (phone Menu sheet): the whole sheet scrolls.
 */
export function NavLinks({
  links,
  counts,
  currentPath,
  layout = 'sidebar',
}: {
  /** sectionsFor(viewer): the person's links, worked out on the server. */
  links: readonly SectionLink[];
  /** Counts per address, or the promise the layout streams in. */
  counts?: MenuCounts | PromiseLike<MenuCounts>;
  currentPath?: string;
  layout?: 'sidebar' | 'sheet';
}) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  const menu = menuFromLinks(links, useMenuCounts(counts));
  const current = currentMenuKey([...menu.groups.flatMap((g) => g.links), ...(menu.settings ? [menu.settings] : [])], path);
  const currentGroup = menu.groups.find((g) => g.label && g.links.some((l) => l.key === current))?.key;
  const folded = useFoldedGroups();
  // Groups the person folded on this page although they hold the current page (forgotten on the next page).
  const [closedHere, setClosedHere] = useState<{ path: string | null | undefined; keys: MenuGroupKey[] }>({ path, keys: [] });
  const closed = closedHere.path === path ? closedHere.keys : [];

  const toggle = (key: MenuGroupKey, open: boolean) => {
    writeFolded(withGroupFolded(folded, key, open));
    if (key === currentGroup) setClosedHere({ path, keys: open ? closed.filter((k) => k !== key) : [...closed, key] });
  };

  const groups = (
    <div className="flex flex-col gap-1 font-sans">
      {menu.groups.map((group) => {
        if (!group.label) {
          return (
            <div key={group.key} className="relative flex w-full min-w-0 flex-col py-1" data-group={group.key}>
              <LinkList links={group.links} current={current} />
            </div>
          );
        }
        const open = isGroupOpen(group.key, folded, currentGroup, closed);
        return (
          <div key={group.key} role="group" aria-label={group.label} className="relative flex w-full min-w-0 flex-col py-1" data-group={group.key}>
            <Collapsible open={open} onOpenChange={(next) => toggle(group.key, next)} trigger={group.label} meta={open ? null : <NavCount count={groupCount(group)} />}>
              <LinkList links={group.links} current={current} />
            </Collapsible>
          </div>
        );
      })}
    </div>
  );

  const settings = menu.settings ? (
    <div role="group" aria-label="Settings" data-group="settings">
      <LinkList links={[menu.settings]} current={current} />
    </div>
  ) : null;

  if (layout === 'sheet') {
    return (
      <nav aria-label="Main" className="flex flex-col gap-1">
        {groups}
        {settings ? <div className="border-t border-line pt-2">{settings}</div> : null}
      </nav>
    );
  }
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-24 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" data-slot="nav-scroll">
        {groups}
        {/* Soft edge: a hint that the list goes on when it is taller than the column. */}
        <div aria-hidden="true" className="pointer-events-none sticky bottom-0 -mb-2 h-3 bg-linear-to-t from-card to-transparent" />
      </div>
      {settings ? (
        <div className="shrink-0 border-t border-line px-2 py-1.5" data-slot="nav-pinned">
          {settings}
        </div>
      ) : null}
    </nav>
  );
}

/**
 * "My access" in the account panel (plan T5: it left the menu; /app/access
 * still opens). Marked as the current page while the person is on it.
 */
export function AccountAccessLink({ currentPath }: { currentPath?: string }) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  const isCurrent = path === '/app/access' || !!path?.startsWith('/app/access/');
  return (
    <Link
      href="/app/access"
      aria-current={isCurrent ? 'page' : undefined}
      className={cn(
        'flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 font-sans text-base font-medium text-copy no-underline',
        'hover:bg-wash hover:text-ink',
        'aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
        focusRing,
        'focus-visible:outline-offset-0',
      )}
    >
      <KeyRound aria-hidden="true" className="size-4 shrink-0 text-quiet" />
      My access
    </Link>
  );
}
