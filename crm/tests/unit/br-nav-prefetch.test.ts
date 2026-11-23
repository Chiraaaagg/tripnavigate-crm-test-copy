import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SectionLink } from '@/app/app/sections';
import { BOOK_SAVE_REFRESH_MODE } from '@/modules/fulfilment/book-refresh';

/**
 * Booking reliability B1-6 (BR-11), slice S5: the staff menu does not fetch
 * its links again after every Book now save, and needs no product change.
 *
 * Gate M0 (build contract, addendum 2) showed that the 10 to 12 menu
 * prefetches per autosave came from the save itself: any revalidatePath in
 * the action empties the browser's route cache, and every visible menu link
 * then prefetches again. With BOOK_SAVE_REFRESH_MODE = 'server' (variant V2)
 * a draft save calls refresh() from next/cache instead, which re-renders the
 * current page and leaves the route cache alone: 0 prefetches. Switching the
 * menu links' prefetch off (V3b) removed the loading skeleton on a click, so
 * the menu keeps Next's default prefetch.
 *
 * This file pins the three facts that conclusion rests on:
 * 1. the refresh mode is 'server';
 * 2. in the pinned Next.js, refresh() marks the answer "dynamic data only"
 *    and the browser empties its route cache only for "static and dynamic"
 *    (path or tag revalidation, or a changed cookie);
 * 3. the menu (NavLinks, rendered by StaffShell) uses plain links with the
 *    default prefetch, so it prefetches once per route cache, not per save.
 * The action side (draft saves call refresh() and no revalidatePath) is S4's
 * contract, and one refresh per save on the client is S3's; both are checked
 * there and by the requests-per-save journey.
 */

const require = createRequire(import.meta.url);
const NEXT_VERSION = (require('next/package.json') as { version: string }).version;
const nextDist = (file: string) => require.resolve(`next/dist/${file}`);

const seenLinks: Array<Record<string, unknown>> = [];
let pathname = '/app/deals/d0000000-0000-4000-8000-000000000001/book';

vi.mock('next/link', () => ({
  default: (props: Record<string, unknown> & { children?: ReactNode }) => {
    seenLinks.push(props);
    const { children, href, className } = props as { children?: ReactNode; href: string; className?: string };
    return createElement('a', { href, className, 'aria-current': props['aria-current'] as string | undefined, 'data-section': props['data-section'] as string | undefined }, children);
  },
}));
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { AccountAccessLink, NavLinks } = await import('@/components/NavLinks');

/** Synthetic menu: the routes M0 saw prefetched after every save (Home, Deals, the three desks, Settings). */
const LINKS: SectionLink[] = [
  { key: 'home', href: '/app', label: 'Home', group: 'top', icon: 'house' },
  { key: 'deals', href: '/app/deals', label: 'Deals', group: 'sales', icon: 'briefcase' },
  { key: 'purchase', href: '/app/purchase', label: 'Purchase tasks', group: 'desks', icon: 'clipboard-list', countWord: 'not taken yet' },
  { key: 'flight', href: '/app/flight', label: 'Flight tasks', group: 'desks', icon: 'plane', countWord: 'waiting' },
  { key: 'visa', href: '/app/visa', label: 'Visa and passport tasks', group: 'desks', icon: 'stamp', countWord: 'waiting' },
  { key: 'settings', href: '/app/settings', label: 'Settings', group: 'settings', icon: 'settings', prefixes: ['/app/settings'] },
];

beforeEach(() => {
  seenLinks.length = 0;
  pathname = '/app/deals/d0000000-0000-4000-8000-000000000001/book';
});

describe('B1-6 decision input: who refreshes after a draft save', () => {
  it("is the server action ('server', gate M0 variant V2): the client calls no router.refresh() after a successful draft save", () => {
    // With 'client' the browser's router.refresh() empties the route cache too (M0 V1: 5 to 6
    // menu prefetches per save); S5's "no product change" would have to be decided again.
    expect(BOOK_SAVE_REFRESH_MODE).toBe('server');
  });
});

describe(`Next.js ${NEXT_VERSION}: refresh() does not empty the browser's route cache`, () => {
  it('runs on the version pinned in the lockfile (re-check this file on an upgrade)', () => {
    expect(NEXT_VERSION).toBe('16.3.8');
  });

  it('refresh() inside a server action marks the answer "dynamic data only" and revalidates no path or tag', async () => {
    // Next's request stores need the global the Next server installs at start-up.
    const g = globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage };
    g.AsyncLocalStorage ??= AsyncLocalStorage;
    const { refresh } = await import('next/cache');
    const { workAsyncStorage } = require(nextDist('server/app-render/work-async-storage.external.js')) as {
      workAsyncStorage: { run: <T>(store: unknown, fn: () => T) => T };
    };
    const { workUnitAsyncStorage } = require(nextDist('server/app-render/work-unit-async-storage.external.js')) as {
      workUnitAsyncStorage: { run: <T>(store: unknown, fn: () => T) => T };
    };
    const kinds = require(nextDist('shared/lib/action-revalidation-kind.js')) as Record<string, number>;
    const workStore: { page: string; route: string; pathWasRevalidated?: number; pendingRevalidatedTags?: unknown[] } = {
      page: '/app/deals/[id]/book/(form)/travellers/page',
      route: '/app/deals/[id]/book/(form)/travellers',
    };
    workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run({ type: 'request', phase: 'action' }, () => refresh()));
    expect(workStore.pathWasRevalidated).toBe(kinds.ActionDidRevalidateDynamicOnly);
    expect(workStore.pathWasRevalidated).not.toBe(kinds.ActionDidRevalidateStaticAndDynamic);
    expect(workStore.pendingRevalidatedTags ?? []).toEqual([]);
  });

  it('the server answers "static and dynamic" only for a revalidated path or tag or a changed cookie; refresh() alone stays "dynamic only"', () => {
    const handler = readFileSync(nextDist('server/app-render/action-handler.js'), 'utf8');
    // Path and tag revalidation (revalidatePath adds a tag without a profile) and cookie changes come first...
    expect(handler).toMatch(/if \(isTagRevalidated \|\| isCookieRevalidated\) \{\s*res\.setHeader\([^;]*ActionDidRevalidateStaticAndDynamic\)\)/);
    // ...and only otherwise does refresh()'s own kind (dynamic only) reach the browser.
    expect(handler).toMatch(/else if \([^{]*workStore\.pathWasRevalidated !== _actionrevalidationkind\.ActionDidNotRevalidate\) \{\s*res\.setHeader\([^;]*JSON\.stringify\(workStore\.pathWasRevalidated\)\)/);
  });

  it('the browser empties its prefetch (route) cache only for "static and dynamic", so the menu links do not prefetch again after refresh()', () => {
    const reducer = readFileSync(nextDist('client/components/router-reducer/reducers/server-action-reducer.js'), 'utf8');
    const calls = reducer.match(/invalidateEntirePrefetchCache\)?\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(reducer).toMatch(/if \(revalidationKind === _actionrevalidationkind\.ActionDidRevalidateStaticAndDynamic\) \{\s*\(0, _cache\.invalidateEntirePrefetchCache\)\(/);
  });
});

describe('S5 menu: plain links with the default prefetch (no product change)', () => {
  const render = (node: ReactNode) => renderToStaticMarkup(node as never);

  it('the sidebar and the phone sheet render every menu link once, with no prefetch prop (default "auto": prefetch once, skeleton at once on a click)', () => {
    for (const layout of ['sidebar', 'sheet'] as const) {
      seenLinks.length = 0;
      render(createElement(NavLinks, { links: LINKS, layout }));
      expect(seenLinks.map((p) => p.href)).toEqual(LINKS.map((l) => l.href));
      for (const props of seenLinks) {
        expect(props).not.toHaveProperty('prefetch');
        expect(props).not.toHaveProperty('onMouseEnter');
      }
    }
  });

  it('"My access" in the account panel is a plain link with the default prefetch too', () => {
    render(createElement(AccountAccessLink, {}));
    expect(seenLinks).toHaveLength(1);
    expect(seenLinks[0]!.href).toBe('/app/access');
    expect(seenLinks[0]).not.toHaveProperty('prefetch');
  });

  it('renders the same links after a save (same address, new counts): nothing in the menu depends on the save', () => {
    pathname = '/app/purchase';
    const before = render(createElement(NavLinks, { links: LINKS, counts: { '/app/purchase': 2 } }));
    const hrefsBefore = seenLinks.map((p) => p.href);
    seenLinks.length = 0;
    const after = render(createElement(NavLinks, { links: LINKS, counts: { '/app/purchase': 3 } }));
    expect(seenLinks.map((p) => p.href)).toEqual(hrefsBefore);
    // Only the count changes; links, order and the current-page mark stay.
    const withoutCounts = (html: string) => html.replace(/data-count="\d+"/g, '').replace(/>\d+</g, '><');
    expect(after).not.toBe(before);
    expect(withoutCounts(after)).toBe(withoutCounts(before));
  });

  it('keeps aria-current="page" on the current link only (keyboard order and current-page mark unchanged)', () => {
    pathname = '/app/flight';
    const html = render(createElement(NavLinks, { links: LINKS }));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/app\/flight"[^>]*aria-current="page"/);
    expect(seenLinks.filter((p) => p['aria-current'] === 'page').map((p) => p.href)).toEqual(['/app/flight']);
  });

  it('StaffShell renders the menu only through NavLinks and AccountAccessLink (no link of its own, no prefetch setting)', () => {
    const shell = readFileSync(fileURLToPath(new URL('../../src/views/StaffShell.tsx', import.meta.url)), 'utf8');
    const nav = readFileSync(fileURLToPath(new URL('../../src/components/NavLinks.tsx', import.meta.url)), 'utf8');
    expect(shell).not.toMatch(/from 'next\/link'/);
    expect(shell).not.toMatch(/prefetch/);
    expect(shell.match(/<NavLinks\b/g)).toHaveLength(2);
    expect(nav).not.toMatch(/prefetch/);
  });
});
