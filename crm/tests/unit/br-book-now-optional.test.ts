import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { draftView } from '@/app/preview/[state]/b11-fixtures';
import { BOOK_RELIABILITY_TEXT, type BookNowPart, type BookNowView } from '@/modules/fulfilment/contracts';
import { BookNowUnavailableView, SubmittedBookingView } from '@/views/b11/book-views';

/*
 * Booking reliability B1-3, server side (build contract section 6): the four
 * optional Book now readers (checklist, payment claims, history, ID-proof copy
 * status) never take the form down. A refusal or a missing function leaves the
 * part out as before; any other failure (here a statement timeout, 57014)
 * leaves it out AND lists it in view.partsNotLoaded. A session failure still
 * fails the load, and so does a failure of a required read (booking_form_get,
 * booking_panel, the Deal header). The "Booking did not load" page no longer
 * says "Nothing was changed" (W4). Fake RPC client; synthetic ids only.
 */

const rpc = vi.fn();
const bookLoader = await import('@/modules/fulfilment/server/book-now');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const HASH = 'c'.repeat(64);

type RpcReply = { data?: unknown; error?: { code: string; message: string } | null };
function rpcReplies(map: Record<string, RpcReply>) {
  rpc.mockImplementation(async (fn: string) => {
    const reply = map[fn];
    if (!reply) throw new Error(`unexpected rpc ${fn}`);
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

const dealRow = vi.fn();
const from = vi.fn((table: string) => {
  if (table === 'deals') return { select: () => ({ eq: () => ({ maybeSingle: () => dealRow() }) }) };
  return { select: () => ({ eq: () => ({ is: () => ({ data: [], error: null }) }) }) };
});
const access = { userId: USER, memberships: [], rolePermissions: [], grants: [] };
const staff = { access, supabase: { rpc, from } } as never;

const TIMEOUT = { error: { code: '57014', message: 'canceling statement due to statement timeout' } };
const SESSION = { error: { code: 'PGRST301', message: 'JWT expired' } };
const MISSING = { error: { code: 'PGRST202', message: 'Could not find the function' } };

const GOOD: Record<string, RpcReply> = {
  booking_form_get: {
    data: {
      dealId: DEAL,
      canEdit: true,
      canConfirm: true,
      serviceItemsEnabled: true,
      visaPassportTasksEnabled: false,
      dealNotActive: false,
      version: { versionId: VERSION, versionNo: 1, status: 'draft', serviceType: 'package', rowVersion: 6, contentHash: HASH, updatedAt: '2026-10-11T08:31:00Z', updatedByName: 'Rahul (synthetic)', confirmedAt: null },
      trip: { destination: null, scope: null, start: null, end: null },
      contacts: null,
      billing: { status: 'none', prefillSource: null, rowVersion: 0 },
      travellers: [],
      items: [],
      evidence: [],
    },
  },
  booking_panel: {
    data: { dealId: DEAL, canEdit: true, canConfirm: true, gate: { realBookingEnabled: false, environment: 'test' }, version: null, readiness: null, evidence: [], evidenceVisible: true, task: null },
  },
  intake_checklist: { data: { items: [{ code: 'contact_missing', blocking: true, owner: 'sales' }], canConfirm: false } },
  deal_payment_claims: MISSING,
  booking_version_history: { data: [] },
  bitrix_id_proof_copy_status: MISSING,
};

/** Which RPC each optional part reads. */
const READER: Record<BookNowPart, string> = {
  checklist: 'intake_checklist',
  claims: 'deal_payment_claims',
  history: 'booking_version_history',
  idProofCopies: 'bitrix_id_proof_copy_status',
};

beforeEach(() => {
  vi.clearAllMocks();
  dealRow.mockReturnValue({
    data: { id: DEAL, legal_entity_id: USER, branch_id: USER, owner_user_id: USER, reference: 'SYN-JOD-012', title: 'Synthetic trip', source_system: null, source_stage_id: null },
    error: null,
  });
});

async function loadView(): Promise<BookNowView> {
  const view = await bookLoader.loadBookNow(staff, DEAL);
  if (view === null || view === 'not_installed') throw new Error(`expected a view, got ${String(view)}`);
  return view;
}

describe('optional Book now parts (B1-3 a)', () => {
  it('all loaded: nothing listed', async () => {
    rpcReplies(GOOD);
    expect((await loadView()).partsNotLoaded).toEqual([]);
  });

  it.each(Object.entries(READER) as Array<[BookNowPart, string]>)('%s failing with 57014: the load succeeds and lists the part', async (part, fn) => {
    rpcReplies({ ...GOOD, [fn]: TIMEOUT });
    const view = await loadView();
    expect(view.partsNotLoaded).toEqual([part]);
    expect(view.dealId).toBe(DEAL);
    if (part === 'checklist') expect(view.checklist.some((i) => i.code === 'contact_missing')).toBe(false);
    if (part === 'history') expect(view).not.toHaveProperty('history');
    if (part === 'claims') expect(view).not.toHaveProperty('claims');
  });

  it('every optional part failing at once: still one view, all four listed', async () => {
    rpcReplies({ ...GOOD, intake_checklist: TIMEOUT, deal_payment_claims: TIMEOUT, booking_version_history: TIMEOUT, bitrix_id_proof_copy_status: TIMEOUT });
    expect([...(await loadView()).partsNotLoaded].sort()).toEqual(['checklist', 'claims', 'history', 'idProofCopies']);
  });

  it('a network failure (the client threw) is "did not load", too', async () => {
    rpc.mockImplementation(async (fn: string) => {
      if (fn === 'booking_version_history') throw new TypeError('fetch failed');
      const reply = GOOD[fn]!;
      return { data: reply.data ?? null, error: reply.error ?? null };
    });
    expect((await loadView()).partsNotLoaded).toEqual(['history']);
  });

  it('a refusal or a missing function is "absent", not "did not load" (unchanged)', async () => {
    rpcReplies({ ...GOOD, intake_checklist: { error: { code: '42501', message: 'not_authorized' } }, booking_version_history: MISSING, deal_payment_claims: { error: { code: '42501', message: 'not_authorized' } } });
    expect((await loadView()).partsNotLoaded).toEqual([]);
  });

  it.each(Object.values(READER))('a session failure in %s still fails the load', async (fn) => {
    rpcReplies({ ...GOOD, [fn]: SESSION });
    await expect(bookLoader.loadBookNow(staff, DEAL)).rejects.toThrow();
  });

  it.each(['booking_form_get', 'booking_panel'])('a required read (%s) failing still fails the load', async (fn) => {
    rpcReplies({ ...GOOD, [fn]: TIMEOUT });
    await expect(bookLoader.loadBookNow(staff, DEAL)).rejects.toThrow('Could not load the booking form. Please retry.');
  });

  it('the Deal header failing still fails the load', async () => {
    rpcReplies(GOOD);
    dealRow.mockReturnValue({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(bookLoader.loadBookNow(staff, DEAL)).rejects.toThrow();
  });
});

describe('wording (B1-3 c, W3, W4)', () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

  it('"Booking did not load" no longer claims "Nothing was changed"', () => {
    const out = html(createElement(BookNowUnavailableView, { dealHref: '/app/deals/x' }));
    expect(out).toContain(BOOK_RELIABILITY_TEXT.bookingDidNotLoad);
    expect(out).not.toContain('Nothing was changed');
    expect(out).toContain('role="alert"');
  });

  it('the submitted booking shows W3 in place of history and payments that did not load, and nothing when all loaded', () => {
    const submitted = draftView({ version: { ...draftView().version!, status: 'confirmed' }, checklist: [], claims: undefined, history: undefined });
    const ok = html(createElement(SubmittedBookingView, { view: { ...submitted, partsNotLoaded: [] }, dealHref: '/app/deals/x' }));
    expect(ok).not.toContain(BOOK_RELIABILITY_TEXT.partNotLoadedTail);
    const failed = html(createElement(SubmittedBookingView, { view: { ...submitted, partsNotLoaded: ['history', 'claims'] }, dealHref: '/app/deals/x' }));
    expect(failed).toContain(BOOK_RELIABILITY_TEXT.partNotLoaded.history);
    expect(failed).toContain(BOOK_RELIABILITY_TEXT.partNotLoaded.claims);
    expect(failed).toContain(BOOK_RELIABILITY_TEXT.partNotLoadedTail);
    expect(failed).toContain('role="status"');
  });

  it('a viewer without money scope never sees the payments line, even when claims did not load', () => {
    const submitted = draftView({ version: { ...draftView().version!, status: 'confirmed' }, checklist: [], commercials: undefined, plan: undefined, claims: undefined });
    const out = html(createElement(SubmittedBookingView, { view: { ...submitted, partsNotLoaded: ['claims'] }, dealHref: '/app/deals/x' }));
    expect(out).not.toContain(BOOK_RELIABILITY_TEXT.partNotLoaded.claims);
  });
});
