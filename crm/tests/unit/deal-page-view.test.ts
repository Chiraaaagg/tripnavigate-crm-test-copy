import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type FunctionComponent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DealMoneyVM, DealWorkspaceVM } from '@/modules/deals/workspace-contract';
import { dealOwnerText, recordOwnerText } from '@/views/deal-labels';
import { DealNotFoundView, DealPageLoading, HotelBookingUnavailable } from '@/views/deal-page-view';
import { DealWorkspaceView } from '@/views/deal-workspace/workspace';

/**
 * Deal page: the Direction A Batch 1 workspace (header, one primary action,
 * link tabs, only the open tab rendered, money only on the Money tab for
 * price readers), plus the kept leaf parts (not found, hotel could-not-load,
 * loading) and their module boundaries.
 */

const views = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/views');

const ws = (over: Omit<Partial<DealWorkspaceVM>, 'header'> & { header?: Partial<DealWorkspaceVM['header']> } = {}): DealWorkspaceVM => {
  const { header, ...rest } = over;
  return {
    header: {
      dealId: '00000000-0000-4000-8000-000000000001',
      reference: 'D-0001',
      title: 'Synthetic Goa trip',
      status: { state: 'in_progress', word: 'Booking in progress' },
      stage: { code: 'C1:NEW', name: null, labelState: 'switched_off' },
      owner: { kind: 'colleague', displayName: 'Synthetic Sales A' },
      next: { text: 'finish 5 things', actor: 'You' },
      primary: { kind: 'continue_booking', label: 'Continue booking', href: '/app/deals/x/book' },
      waitsForWon: false,
      bitrixLate: false,
      testRecord: false,
      lostInBitrix: false,
      ...header,
    },
    tabs: [
      { tab: 'overview', label: 'Overview', href: '/app/deals/x', current: true },
      { tab: 'services', label: 'Services and tasks', href: '/app/deals/x?tab=services', current: false },
      { tab: 'money', label: 'Money', href: '/app/deals/x?tab=money', current: false },
      { tab: 'history', label: 'History', href: '/app/deals/x?tab=history', current: false },
    ],
    current: 'overview',
    overview: { branchName: 'Jodhpur', createdOn: '2026-10-06', relation: 'assigned', team: [{ kindLabel: 'Purchase', isYou: false }], tripText: null, travellersText: null },
    ...rest,
  };
};
const MONEY: DealMoneyVM = { dealValue: { state: 'shown', sellingTotal: '₹1,000.00', estimatedMargin: '₹100.00' } };
const render = (props: Parameters<typeof DealWorkspaceView>[0]) => renderToStaticMarkup(createElement(DealWorkspaceView, props));
const headerOf = (html: string) => html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';

describe('dealOwnerText (book pages and intake keep the same rule)', () => {
  it('you, the named owner, another staff member, or null while waiting', () => {
    expect(dealOwnerText({ relation: 'owner', ownerName: 'Someone' })).toBe('You');
    expect(dealOwnerText({ relation: 'assigned', ownerName: 'Synthetic Sales B' })).toBe('Synthetic Sales B');
    expect(dealOwnerText({ relation: 'scope', ownerName: null })).toBe('Another staff member');
    expect(dealOwnerText({ relation: 'scope' })).toBe('Another staff member');
    expect(dealOwnerText({ relation: 'waiting', ownerName: 'Ignored' })).toBeNull();
  });

  it('recordOwnerText: the Batch 1 owner rule (DEC-52 owner name only)', () => {
    expect(recordOwnerText({ kind: 'you' })).toBe('You');
    expect(recordOwnerText({ kind: 'colleague', displayName: 'Synthetic Sales B' })).toBe('Synthetic Sales B');
    expect(recordOwnerText({ kind: 'colleague' })).toBe('Another staff member');
    expect(recordOwnerText({ kind: 'waiting' })).toBeNull();
  });
});

describe('DealWorkspaceView header (P-HEADER)', () => {
  it('one h1 with customer and trip, the reference above it, the owner and the status word with its icon', () => {
    const html = render({ workspace: ws() });
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) ?? [];
    expect(h1).toHaveLength(1);
    expect(h1[0]!.replace(/<[^>]+>/g, '')).toBe('Synthetic Goa trip');
    expect(headerOf(html)).toContain('D-0001');
    expect(html).toMatch(/Owner: <span[^>]*>Synthetic Sales A<\/span>/);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<span class="sr-only">Booking status: <\/span>Booking in progress/);
    // DA-115: no "Stage:" label before the fallback, and "Details" names the disclosure.
    expect(html).toContain('Stage not recognised (code in Details)');
    expect(html).not.toContain('Stage:');
    expect(html).toContain('Next:</span> finish 5 things');
  });

  it('exactly one primary action; none when the viewer does not act next; Start booking is the route form', () => {
    const one = headerOf(render({ workspace: ws() }));
    expect(one.match(/bg-brand-strong/g)).toHaveLength(1);
    expect(one).toContain('>Continue booking</a>');
    const none = headerOf(render({ workspace: ws({ header: { primary: null, next: { text: 'Accounts checks the booking' } } }) }));
    expect(none).not.toMatch(/bg-brand-strong/);
    const start = render({
      workspace: ws({ header: { primary: { kind: 'start_booking', label: 'Start booking' } } }),
      startBookingForm: createElement('form', { 'data-test': 'start' }, createElement('button', null, 'Start booking')),
    });
    expect(headerOf(start)).toContain('<form data-test="start"><button>Start booking</button></form>');
    expect(start).toContain('Starts the booking form. Nothing is booked or paid.');
  });

  it('no status word when none is provable (amended contract): no badge, Next line still there', () => {
    const html = render({ workspace: ws({ header: { status: undefined, next: { text: 'See Services and tasks' } } }) });
    expect(html).not.toContain('Booking status:');
    expect(html).toContain('See Services and tasks');
  });

  it('waiting for an owner is a status pill with a word, not a name', () => {
    const html = render({ workspace: ws({ header: { owner: { kind: 'waiting' } } }) });
    expect(html).toMatch(/data-tone="warning"[^>]*>.*?Waiting for owner/);
    expect(html).not.toContain('Owner:');
  });

  it('test record, late Bitrix update, lost deal and returned booking say so in words', () => {
    const html = render({
      workspace: ws({
        header: { testRecord: true, stage: undefined, bitrixLate: true, lostInBitrix: true, returnNotice: { reviewedAt: null, reason: 'Synthetic reason', reasonHidden: false } },
      }),
    });
    expect(html).toMatch(/data-tone="warning"[^>]*>.*?Test record \(not from Bitrix\)/);
    expect(html).toContain('Not updated from Bitrix for over a day. Check the stage in Bitrix before you rely on it.');
    // Echo M6 / copy L-14: the repair step stays with the late warning, as one Next line.
    expect(html).toContain('<span class="font-semibold text-ink">Next:</span> an admin checks the Bitrix connection.');
    // DA-29a: without a booking to read, the notice says none can be started.
    expect(html).toContain('This deal is lost or rejected in Bitrix, so a booking cannot be started.');
    expect(html).toContain('Reason: <span class="wrap-break-word">Synthetic reason</span>');
    const hidden = render({ workspace: ws({ header: { returnNotice: { reviewedAt: null, reason: null, reasonHidden: true } } }) });
    expect(hidden).toContain('Accounts did not share the reason');
  });

  it('From lead only when the route passes it; the live indicator sits in the header; no style attribute', () => {
    expect(render({ workspace: ws() })).not.toContain('From lead');
    const html = render({ workspace: ws({ header: { leadLink: { href: '/app/leads/l1', reference: 'BXL-1' } } }), live: createElement('p', { role: 'status' }, 'Live') });
    expect(html).toContain('href="/app/leads/l1"');
    const header = headerOf(html);
    expect(header).toMatch(/<div[^>]*><p role="status">Live<\/p><\/div>/);
    expect(header).not.toMatch(/<span[^>]*><p role="status">/);
    expect(html).not.toMatch(/\sstyle="/);
  });
});

describe('DealWorkspaceView tabs and money per role', () => {
  it('tabs are links with aria-current and never a count', () => {
    const html = render({ workspace: ws() });
    const nav = html.match(/<nav aria-label="Deal sections"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect(nav.match(/<a /g)).toHaveLength(4);
    expect(nav).toMatch(/aria-current="page"[^>]*>Overview<\/a>/);
    expect(nav.replace(/<[^>]+>/g, ' ')).not.toMatch(/\d/);
  });

  it('only the open tab is rendered: Overview carries no money even for a price reader', () => {
    const html = render({ workspace: ws({ money: MONEY }) }); // a stray money model is ignored off the Money tab
    expect(html).toContain('id="deal-overview-heading"');
    expect(html).not.toContain('₹');
    expect(html).not.toMatch(/estimated margin|selling/i);
  });

  it('a price reader on the Money tab sees deal value and margin; not recorded is not hidden', () => {
    const html = render({ workspace: ws({ current: 'money', overview: undefined, money: MONEY }) });
    expect(html).toContain('₹1,000.00');
    expect(html).toContain('Estimated margin');
    // DA-118: deal values exist on test records only, and the screen says so.
    expect(html).toContain('Deal value (test record only)');
    expect(html).toContain('Test figures. No tax is calculated here.');
    // DA-118 / DA-121: nothing recorded hides the block and says what will appear; never "Hidden for your role".
    const nr = render({ workspace: ws({ current: 'money', overview: undefined, money: { dealValue: { state: 'not_recorded' } } }) });
    expect(nr).toContain('No money recorded on this deal yet. The selling total shows here once the booking has a price.');
    expect(nr).not.toContain('Deal value');
    expect(nr).not.toContain('Hidden for your role');
  });

  it('a withheld viewer (Purchase), built by the route builder, on every tab incl. ?tab=money: no Money tab, no amount', async () => {
    const { buildDealWorkspace } = await import('@/modules/deals/workspace');
    // The DTO for Purchase: commercial withheld (no values), assigned, Bitrix source.
    const deal = {
      id: 'd1', reference: 'D-0001', title: 'Synthetic Goa trip', branchName: 'Jodhpur', relation: 'assigned' as const, createdOn: '2026-10-06', ownerName: null,
      assignments: [{ kind: 'purchase', isYou: true }],
      commercial: { visible: false as const }, commercialAbsence: 'withheld' as const,
    };
    for (const tab of ['overview', 'services', 'quotations', 'documents', 'money', 'history']) {
      const workspace = buildDealWorkspace({
        dealId: 'd1', deal, tab, book: { state: 'none' }, legacyBooking: { ok: true, exists: false }, services: { ok: true, view: null },
        quotations: null, itinerariesReadable: false, leadLink: null, documentsAvailable: true, documents: [],
      });
      expect(workspace.tabs.map((t) => t.tab), tab).not.toContain('money');
      expect(workspace, tab).not.toHaveProperty('money');
      const html = render({ workspace, servicesTab: workspace.current === 'services' ? createElement('p', null, 'services') : undefined });
      expect(html, tab).not.toContain('₹');
      expect(html, tab).not.toMatch(/>Money</);
      expect(html, tab).not.toMatch(/estimated margin|selling/i);
    }
  });

  it('a tab whose model or slot is missing says it did not load (never empty)', () => {
    expect(render({ workspace: ws({ current: 'services', overview: undefined }) })).toContain('Services and tasks did not load. Nothing was changed.');
    expect(render({ workspace: ws({ current: 'history', overview: undefined, history: { state: 'error' } }) })).toContain('History did not load. Nothing was changed.');
    expect(render({ workspace: ws({ current: 'documents', overview: undefined, documents: { state: 'error' } }) })).toContain('Documents did not load. Nothing was changed.');
  });

  it('History: honest empty line; events carry no amount', () => {
    expect(render({ workspace: ws({ current: 'history', overview: undefined, history: { state: 'ok', events: [] } }) })).toContain(
      'No history you can see on this deal yet.',
    );
    const html = render({
      workspace: ws({
        current: 'history',
        overview: undefined,
        history: { state: 'ok', events: [{ kind: 'booking_version', id: 'v1', at: '2026-10-12T10:00:00Z', versionNo: 2, statusText: 'Submitted', changeClass: null }, { kind: 'payment_reported', id: 'p1', at: '2026-10-12T10:00:00Z', status: 'reported' }] },
      }),
    });
    expect(html).toContain('Booking version 2: Submitted');
    expect(html).not.toContain('₹');
  });

  it('Documents: each file links to its existing route, with what it is in words', () => {
    const html = render({
      workspace: ws({
        current: 'documents',
        overview: undefined,
        documents: { state: 'ok', rows: [{ kind: 'id_proof', id: 'f1', fileName: 'id.pdf', mime: 'application/pdf', uploadedAt: '2026-10-08T05:00:00Z', href: '/app/id-proofs/f1', context: { travellerSeq: 1 } }] },
      }),
    });
    expect(html).toContain('href="/app/id-proofs/f1"');
    expect(html).toContain('ID proof · traveller 1');
  });
});

describe('DealNotFoundView', () => {
  it('the status holds only the message; the way back is a link after it', () => {
    const html = renderToStaticMarkup(createElement(DealNotFoundView));
    const status = html.match(/<div[^>]*role="status"[^>]*>[\s\S]*?<\/p><\/div><\/div>/)?.[0] ?? '';
    expect(status).toContain('This deal does not exist, or it is not visible to you.');
    expect(status).not.toContain('<a ');
    expect(html.indexOf('href="/app/deals"')).toBeGreaterThan(html.indexOf('role="status"') + status.length - 1);
  });
});

describe('HotelBookingUnavailable', () => {
  it('is the same component from booking-views (the deal page test compares by identity)', async () => {
    const bookingViews = await import('@/views/booking-views');
    expect(bookingViews.HotelBookingUnavailable).toBe(HotelBookingUnavailable);
  });

  it('says it could not load, that nothing changed, and keeps the status prefix for screen readers', () => {
    const html = renderToStaticMarkup(createElement(HotelBookingUnavailable));
    expect(html).toContain('<span class="sr-only">Booking status: </span>Did not load');
    expect(html).toContain('The hotel booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.');
    expect(html).toContain('aria-labelledby="booking-heading"');
  });
});

describe('DealPageLoading', () => {
  it('one hidden h1, one polite status, a busy placeholder that is not the status', () => {
    const html = renderToStaticMarkup(createElement(DealPageLoading));
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('<h1 class="sr-only">Deal</h1>');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/<p role="status" aria-live="polite"[^>]*>Loading deal…<\/p>/);
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
  });
});

describe('deal page module boundaries', () => {
  it('imports no view module at all (no cycle with staff-views, booking-views or the Deals list)', () => {
    const source = readFileSync(resolve(views, 'deal-page-view.tsx'), 'utf8');
    const local = [...source.matchAll(/(?:from|import) '\.\/([^']+)'/g)].map((m) => m[1]).sort();
    expect(local).toEqual([]);
    for (const leaf of ['deal-labels.ts', 'handoff.tsx', 'value-states.tsx']) {
      expect(readFileSync(resolve(views, leaf), 'utf8'), leaf).not.toMatch(/(?:from|import) '\.\/(?!deal-labels')/);
    }
    // booking-views takes formatIst from the leaf too, not from staff-views.
    expect(readFileSync(resolve(views, 'booking-views.tsx'), 'utf8')).not.toContain("from './staff-views'");
  });
});

describe('StatusBadge wrap (opt-in; every other badge keeps one truncated line)', () => {
  it('default stays truncate; wrap lets the words break onto more lines', async () => {
    const { StatusBadge } = await import('@/components/ui/badge');
    // createElement passes the words as children (its third argument); the cast only relaxes the required-children type.
    const Badge = StatusBadge as unknown as FunctionComponent<{ tone: 'danger'; wrap?: boolean; children?: ReactNode }>;
    const one = renderToStaticMarkup(createElement(Badge, { tone: 'danger' }, 'Could not load'));
    const wrapped = renderToStaticMarkup(createElement(Badge, { tone: 'danger', wrap: true }, 'Could not load'));
    expect(one).toContain('<span class="truncate">Could not load</span>');
    expect(one).toContain('whitespace-nowrap');
    expect(wrapped).not.toContain('truncate');
    expect(wrapped).toContain('<span class="min-w-0 wrap-anywhere">Could not load</span>');
    expect(wrapped).toContain('whitespace-normal');
    expect(wrapped).not.toContain('whitespace-nowrap');
  });

  it('the deal page could-not-load status uses it', () => {
    const html = renderToStaticMarkup(createElement(HotelBookingUnavailable));
    expect(html).toMatch(/<span class="min-w-0 wrap-anywhere"><span class="sr-only">Booking status: <\/span>Did not load<\/span>/);
  });
});
