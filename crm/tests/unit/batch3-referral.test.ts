import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTATION_ERROR_TEXT, QUOTATION_TEXT } from '@/modules/quotations/contracts';
import type { ReferralDraftRecord, ReferralLinkCandidate, WorkQuotationRow } from '@/modules/quotations/referral';
import { parseReferralCreateForm, parseReferralReassignForm, parseReferralUnlinkForm } from '@/modules/quotations/referral-input';
import {
  decodeWorkCursor,
  draftStateVM,
  encodeWorkCursor,
  newWorkVM,
  parseReferralTab,
  parseWorkListQuery,
  quotationListPageVM,
  referralDraftVM,
  referralLinkStepVM,
  referralSwitchState,
  subjectReferralDraftsVM,
  WORK_TEXT,
  workListHref,
  workQuotationRowVM,
} from '@/modules/quotations/work-model';

/**
 * Direction A Batch 3, T-3 (Terra): referral draft view models, form parsers
 * and server actions with a fake RPC client. Synthetic ids and names only; no
 * database. Shapes follow atlas-batch3-shapes v2.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const referralActions = await import('@/modules/quotations/server/referral-actions');
const quoteActions = await import('@/modules/quotations/server/actions');

const USER = 'c0000000-0000-4000-8000-000000000001';
const DRAFT = 'c1000000-0000-4000-8000-000000000001';
const BRANCH = 'c2000000-0000-4000-8000-000000000001';
const Q = 'c3000000-0000-4000-8000-000000000001';
const V = 'c4000000-0000-4000-8000-000000000001';
const DEAL = 'c5000000-0000-4000-8000-000000000001';
const LINK = 'c6000000-0000-4000-8000-000000000001';
const DOC = 'c7000000-0000-4000-8000-000000000001';
const BV = 'c8000000-0000-4000-8000-000000000001';
const REQ = '77777777-7777-4777-8777-777777777777';
const HASH = 'd'.repeat(64);

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null };
function rpcReplies(map: Record<string, RpcReply | RpcReply[]>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string) => {
    const queue = queues[fn];
    if (!queue || queue.length === 0) throw new Error(`unexpected rpc ${fn}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc } });
});

const scheduled = { state: 'scheduled' as const, dueOn: '2027-01-13' };

const qRow = (over: Partial<WorkQuotationRow> = {}): WorkQuotationRow => ({
  quotationId: Q,
  reference: 'TQ-7003',
  title: 'Referral – Mehra couple, Kerala',
  subjectKind: 'referral',
  subject: { kind: 'referral', id: DRAFT, reference: 'TD-301', title: 'Ishaan Mehra' },
  referralDraftId: DRAFT,
  draft: { status: 'open', closedReason: null, closedAt: null, autoClose: scheduled, reference: 'TD-301' },
  linkedDealId: null,
  currentVersion: { versionId: V, versionNo: 1, status: 'draft', validUntil: '2026-10-28' },
  accepted: false,
  converted: false,
  acceptedNotLinked: false,
  customerName: 'Ishaan Mehra',
  destination: 'Kerala',
  tripStart: '2027-01-10',
  ownerName: 'Synthetic Sales',
  ownerIsYou: true,
  since: '2026-10-21T08:00:00Z',
  ...over,
});

const draftRecord = (over: Partial<ReferralDraftRecord> = {}): ReferralDraftRecord => ({
  status: 'open',
  closedReason: null,
  closedAt: null,
  autoClose: scheduled,
  referralDraftId: DRAFT,
  reference: 'TD-301',
  branchId: BRANCH,
  branchName: 'Jodhpur',
  ownerUserId: USER,
  ownerName: 'Synthetic Sales',
  ownerIsYou: true,
  createdByYou: true,
  customer: { customerName: 'Ishaan Mehra', mobile: null, email: null, companyName: null },
  source: { kind: 'referral', note: 'past customer' },
  closeNote: null,
  linked: false,
  bound: false,
  lastActivityAt: '2026-10-15T08:00:00Z',
  rowVersion: 3,
  createdAt: '2026-10-15T08:00:00Z',
  switchOn: true,
  can: { edit: true, close: true, reopen: false, reassign: false, link: true, unlink: true },
  links: [],
  quotations: [{ quotationId: Q, reference: 'TQ-7003', title: 'Kerala', currentVersion: { versionId: V, versionNo: 1, status: 'draft', validUntil: null }, accepted: false, converted: false, linkedDealId: null }],
  itineraries: [{ documentId: DOC, title: 'Kerala days', quotationId: null, factsStatus: 'draft' }],
  ...over,
});

describe('list addresses and query', () => {
  it('defaults are left out; Home rows open scope all; unknown values fall back; references normalise', () => {
    expect(workListHref('quotations', {})).toBe('/app/quotations');
    expect(workListHref('quotations', { filter: 'to_finish', scope: 'all' })).toBe('/app/quotations?filter=to_finish&scope=all');
    expect(workListHref('itineraries', { reference: 'TD-301', filter: 'draft' })).toBe('/app/itineraries?reference=TD-301');
    const q = parseWorkListQuery('quotations', { filter: 'nope', scope: 'everything', reference: ' td-301 ' });
    expect(q).toEqual({ filter: 'open', scope: 'mine', reference: 'TD-301', after: null });
    expect(parseWorkListQuery('itineraries', { filter: 'final_made', scope: ['all'] })).toMatchObject({ filter: 'final_made', scope: 'all' });
    expect(parseWorkListQuery('quotations', { reference: 'DROP TABLE' }).reference).toBeNull();
  });

  it('keyset cursor survives the address round trip; malformed is the first page', () => {
    const c = { since: '2026-10-21T08:00:00.123456+00:00', id: Q };
    expect(decodeWorkCursor(encodeWorkCursor(c))).toEqual(c);
    expect(decodeWorkCursor('garbage')).toBeNull();
    expect(decodeWorkCursor(`x~not-a-uuid`)).toBeNull();
    expect(workListHref('quotations', { filter: 'drafts', after: c })).toContain('after=');
  });
});

describe('Quotations list page', () => {
  const q = parseWorkListQuery('quotations', {});
  const page = (rows: WorkQuotationRow[], over: Record<string, unknown> = {}) => ({
    applies: true as const,
    scope: 'mine' as const,
    filter: { status: 'open', scope: 'mine' as const, reference: null },
    counts: { open: rows.length, to_finish: 1, drafts: 1, ready: 0, shared: 0, accepted: 0, accepted_not_linked: 0, declined_or_expired: 0, closed_drafts: 2, all: 5 },
    total: rows.length,
    rows,
    hasMore: true,
    next: { since: '2026-10-20T08:00:00Z', id: Q },
    ...over,
  });

  it('states: not installed, error (never an empty list), no Sales/Manager role', () => {
    expect(quotationListPageVM(q, 'not_installed').state).toBe('not_installed');
    expect(quotationListPageVM(q, 'error')).toMatchObject({ state: 'error', rows: [] });
    expect(quotationListPageVM(q, { applies: false }).state).toBe('not_applicable');
    expect(quotationListPageVM(q, null).state).toBe('not_applicable');
  });

  it('ok: exact counts on chips with their scope, keyset next page, the hidden-closed line, no money', () => {
    const vm = quotationListPageVM(q, page([qRow()]));
    expect(vm.state).toBe('ok');
    expect(vm.filters.chips.find((c) => c.filter === 'closed_drafts')).toMatchObject({ label: 'Closed drafts (2)', count: 2, current: false });
    expect(vm.filters.chips.find((c) => c.filter === 'open')?.current).toBe(true);
    expect(vm.filters.scopeText).toBe(WORK_TEXT.countScope);
    expect(vm.pager).toMatchObject({ firstHref: null, shown: 1, total: 1 });
    expect(vm.pager.nextHref).toMatch(/^\/app\/quotations\?after=/);
    expect(vm.hiddenClosedLine).toBe(WORK_TEXT.hiddenClosed);
    expect(vm.scope).toEqual({ current: 'mine', mineHref: '/app/quotations', allHref: '/app/quotations?scope=all' });
    expect(JSON.stringify(vm)).not.toMatch(/Paise|₹|price|margin|cost/i);
  });

  it('a reference with no result says so; the closed-drafts chip hides the hidden-closed line', () => {
    const ref = parseWorkListQuery('quotations', { reference: 'TQ-404' });
    expect(quotationListPageVM(ref, page([], { total: 0, hasMore: false, next: null })).openByReference).toMatchObject({ value: 'TQ-404', missText: WORK_TEXT.referenceMiss });
    expect(quotationListPageVM(parseWorkListQuery('quotations', { filter: 'closed_drafts' }), page([])).hiddenClosedLine).toBeNull();
  });
});

describe('rows: one action each, never an "undefined" address', () => {
  it('draft → Continue; closed draft → Reopen on the draft page; referral accepted not linked → the draft link step', () => {
    expect(workQuotationRowVM(qRow()).action).toEqual({ kind: 'continue', label: 'Continue', href: `/app/quotations/${V}` });
    const closed = workQuotationRowVM(qRow({ draft: { status: 'closed', closedReason: 'no_activity', closedAt: '2026-10-10T00:00:00Z', autoClose: { state: 'closed', dueOn: '2026-10-10' }, reference: 'TD-298' } }));
    expect(closed.action).toEqual({ kind: 'reopen', label: 'Reopen draft', href: `/app/quotations/drafts/${DRAFT}` });
    expect(closed.draft?.statusText).toBe('Closed after 90 days without activity');
    const toLink = workQuotationRowVM(qRow({ accepted: true, acceptedNotLinked: true, currentVersion: { versionId: V, versionNo: 1, status: 'accepted', validUntil: null } }));
    expect(toLink.action).toEqual({ kind: 'link_to_deal', label: 'Link to deal', href: `/app/quotations/drafts/${DRAFT}?tab=link` });
    // Mercury F1: the list row does not know whether the draft is linked, so the subject claims nothing.
    expect(toLink.subject.text).toBe('Referral draft TD-301');
  });

  it('converted → Continue booking on the bound deal; a deal row links the deal', () => {
    const booked = workQuotationRowVM(qRow({ accepted: true, converted: true, linkedDealId: DEAL, currentVersion: { versionId: V, versionNo: 2, status: 'accepted', validUntil: null } }));
    expect(booked.action).toEqual({ kind: 'continue_booking', label: 'Continue booking', href: `/app/deals/${DEAL}/book` });
    expect(booked.statusWord).toBe('Booking started');
    const deal = workQuotationRowVM(qRow({ subjectKind: 'deal', subject: { kind: 'deal', id: DEAL, reference: 'D-5103', title: 'x' }, referralDraftId: null, draft: null }));
    expect(deal.subject).toEqual({ kind: 'deal', text: 'Deal D-5103', href: `/app/deals/${DEAL}` });
    expect(JSON.stringify([booked, deal])).not.toContain('undefined');
  });
});

describe('draft state: dates come from the database; paused never shows a date', () => {
  it('scheduled, paused, closed by hand', () => {
    expect(draftStateVM({ status: 'open', closedReason: null, autoClose: scheduled }).autoCloseLine).toBe('Closes on 13 Jan 2027 if nothing changes.');
    expect(draftStateVM({ status: 'open', closedReason: null, autoClose: { state: 'paused', dueOn: null } })).toMatchObject({ autoCloseLine: WORK_TEXT.autoClosePaused, statusText: 'Open' });
    expect(draftStateVM({ status: 'closed', closedReason: 'duplicate', autoClose: { state: 'none', dueOn: null } })).toMatchObject({ statusText: 'Closed', autoCloseLine: null });
  });
});

describe('switch state and the New pages', () => {
  it('Unknown is never Off', () => {
    expect(referralSwitchState({ referralDrafts: true })).toBe('on');
    expect(referralSwitchState({ referralDrafts: false })).toBe('off');
    expect(referralSwitchState({})).toBe('unknown');
    expect(referralSwitchState(null)).toBe('unknown');
  });

  it('referral line per state; branches only where the person holds Sales or Manager and no Purchase', () => {
    const memberships = [
      { branchId: 'b-jdh', branchName: 'Jodhpur', roleCode: 'sales', legalEntityId: 'e1' },
      { branchId: 'b-del', branchName: 'Delhi', roleCode: 'manager', legalEntityId: 'e1' },
      { branchId: 'b-x', branchName: 'Elsewhere', roleCode: 'sales', legalEntityId: 'e2' },
      { branchId: 'b-x', branchName: 'Elsewhere', roleCode: 'purchase', legalEntityId: 'e2' },
      { branchId: 'b-acc', branchName: 'Accounts branch', roleCode: 'accounts', legalEntityId: 'e1' },
    ];
    const on = newWorkVM({ kind: 'quotations', switchState: 'on', memberships, canSeeLeads: true });
    expect(on.referral).toMatchObject({ state: 'on', line: null, branches: [{ id: 'b-del', name: 'Delhi' }, { id: 'b-jdh', name: 'Jodhpur' }] });
    expect(on.fromBitrix).toMatchObject({ leadsHref: '/app/leads', dealsHref: '/app/deals' });
    expect(newWorkVM({ kind: 'itineraries', switchState: 'off', memberships, canSeeLeads: false }).referral.line).toBe(WORK_TEXT.switchOff);
    expect(newWorkVM({ kind: 'itineraries', switchState: 'unknown', memberships, canSeeLeads: false }).referral.line).toBe(WORK_TEXT.switchUnknown);
  });
});

describe('referral draft page', () => {
  it('open, not linked: primary Link to Bitrix, honest next line, privacy line, tabs as links', () => {
    const vm = referralDraftVM(draftRecord(), parseReferralTab('nope'));
    expect(vm.tab).toBe('overview');
    expect(vm.header).toMatchObject({ title: 'Ishaan Mehra · referral draft', refLine: 'Referral draft TD-301 · not linked to Bitrix yet', primary: 'link', ownerName: 'You', privacyLine: WORK_TEXT.privacyNotLinked });
    expect(vm.header.nextLine).toBe('Next: link this draft to the Bitrix lead or deal once it exists. Booking needs the confirmed deal.');
    expect(vm.defaultTitle).toBe('Trip for Ishaan Mehra');
    expect(vm.header.startBooking).toBeNull();
    // Echo M2: newest first, India time, never a raw ISO string.
    expect(vm.history).toEqual([{ at: '15 Oct 2026, 13:30', text: 'Draft TD-301 created by you.' }]);
    expect(vm.header.state.autoCloseLine).toBe('Closes on 13 Jan 2027 if nothing changes.');
    expect(vm.tabs.map((t) => t.href)).toEqual([
      `/app/quotations/drafts/${DRAFT}`,
      `/app/quotations/drafts/${DRAFT}?tab=quotations`,
      `/app/quotations/drafts/${DRAFT}?tab=itineraries`,
      `/app/quotations/drafts/${DRAFT}?tab=link`,
      `/app/quotations/drafts/${DRAFT}?tab=history`,
    ]);
    expect(vm.overview.find((o) => o.label === 'Mobile')?.value).toBe('Not given');
    expect(vm.can).toMatchObject({ addQuotation: true, addItinerary: true });
  });

  it('linked to a deal with an accepted quotation: primary Start booking; closed: Reopen only, read-only', () => {
    const linked = referralDraftVM(
      draftRecord({
        linked: true,
        links: [{ linkId: LINK, targetKind: 'deal', targetId: DEAL, reference: 'D-5109', title: 'Kerala', active: true, linkedAt: '2026-10-18T08:00:00Z', linkedByYou: true, endedAt: null, endReason: null, canRemove: true }],
        quotations: [{ quotationId: Q, reference: 'TQ-7003', title: 'Kerala', currentVersion: { versionId: V, versionNo: 1, status: 'accepted', validUntil: null }, accepted: true, converted: false, linkedDealId: null }],
      }),
      'overview',
    );
    expect(linked.header).toMatchObject({
      refLine: 'Referral draft TD-301 · linked to deal D-5109',
      primary: 'start_booking',
      // Echo M4: the button says what it does.
      startBooking: { label: 'Open TQ-7003 to start booking', href: `/app/quotations/${V}` },
      // DA-219: linked drafts name who else can open them.
      privacyLine: 'The owner, the branch Manager and Sales on deal D-5109 can open this draft.',
    });
    expect(linked.history.map((h) => h.text)).toEqual(['Linked to deal D-5109.', 'Draft TD-301 created by you.']);
    expect(linked.links[0]).toMatchObject({ href: `/app/deals/${DEAL}`, canRemove: true, linkedText: 'Linked on 18 Oct 2026 by you' });
    expect(linked.quotations[0]?.action?.kind).toBe('start_booking');
    const closed = referralDraftVM(draftRecord({ status: 'closed', closedReason: 'lost', closedAt: '2026-10-20T08:00:00Z', autoClose: { state: 'none', dueOn: null }, can: { edit: false, close: false, reopen: true, reassign: false, link: false, unlink: false } }), 'overview');
    expect(closed).toMatchObject({ readOnly: true, header: { primary: 'reopen' }, can: { addQuotation: false, addItinerary: false } });
  });
});

describe('linking and the Deal section', () => {
  const cand = (over: Partial<ReferralLinkCandidate>): ReferralLinkCandidate => ({ kind: 'deal', id: DEAL, reference: 'D-5109', title: 'Kerala', branchName: 'Jodhpur', active: true, fromLinkedLead: false, alreadyHasAcceptedQuotation: false, linkable: true, ...over });

  it('candidates carry flags and refusal words; nothing is preselected; the confirm names the record', () => {
    const vm = referralLinkStepVM({ kind: 'deal', branchName: 'Jodhpur', query: '', candidates: [cand({ fromLinkedLead: true }), cand({ id: Q, reference: 'D-5103', alreadyHasAcceptedQuotation: true, linkable: false })] });
    expect(vm.heading).toBe('Deals in Jodhpur that you can work on');
    expect(vm.confirmTemplate).toBe(WORK_TEXT.linkConfirm.deal);
    expect(vm.loadError).toBeNull();
    expect(vm.candidates[0]).toMatchObject({ flags: ['Made from the linked lead'], refusedText: null });
    expect(vm.candidates[1]).toMatchObject({ linkable: false, refusedText: 'That deal already has an accepted quotation.' });
    expect(JSON.stringify(vm)).not.toMatch(/selected|checked/i);
    expect(vm.confirmTemplate).toContain('{ref}');
    expect(referralLinkStepVM({ kind: 'lead', branchName: 'Jodhpur', query: 'zz', candidates: [] }).emptyText).toBe(WORK_TEXT.linkNone);
  });

  it('DA-71: no section on error, not installed or no drafts; the duplicates note with two or more', () => {
    expect(subjectReferralDraftsVM('error')).toBeNull();
    expect(subjectReferralDraftsVM('not_installed')).toBeNull();
    expect(subjectReferralDraftsVM([])).toBeNull();
    const row = { status: 'open' as const, closedReason: null, closedAt: null, autoClose: scheduled, referralDraftId: DRAFT, reference: 'TD-301', customerName: 'Ishaan Mehra', ownerName: null, ownerIsYou: false, quotationCount: 1, hasAccepted: false };
    expect(subjectReferralDraftsVM([row])?.note).toBeNull();
    expect(subjectReferralDraftsVM([row, { ...row, reference: 'TD-302' }])?.note).toBe(WORK_TEXT.subjectDraftsNote);
  });
});

describe('referral form parsers keep typed values safe', () => {
  it('create: name required, Indian mobile normalised, empty title becomes "Trip for {name}", bad source refused', () => {
    const ok = parseReferralCreateForm(form({ requestId: REQ, branchId: BRANCH, customerName: '  Ishaan   Mehra ', mobile: '+91 98765 11102', email: '', companyName: '', sourceKind: 'referral', sourceNote: 'past customer', title: '' }));
    expect(ok).toEqual({ ok: true, value: { branchId: BRANCH, requestId: REQ, title: 'Trip for Ishaan Mehra', customer: { customerName: 'Ishaan Mehra', mobile: '9876511102', email: null, companyName: null, sourceKind: 'referral', sourceNote: 'past customer' } } });
    expect(parseReferralCreateForm(form({ requestId: REQ, branchId: 'x', customerName: '', mobile: '12345', sourceKind: 'carrier pigeon' }))).toEqual({ ok: false, fields: ['branchId', 'customerName', 'mobile', 'sourceKind'] });
  });

  it('unlink note and reassign reason are 10 to 500 characters', () => {
    expect(parseReferralUnlinkForm(form({ linkId: LINK, rowVersion: '3', reason: 'wrong_link', note: 'too short' }))).toEqual({ ok: false, fields: ['note'] });
    expect(parseReferralUnlinkForm(form({ linkId: LINK, rowVersion: '3', reason: 'wrong_link', note: 'Picked the wrong Patel family.' })).ok).toBe(true);
    expect(parseReferralReassignForm(form({ draftId: DRAFT, rowVersion: '0', newOwner: USER, reason: 'x' }))).toEqual({ ok: false, fields: ['rowVersion', 'reason'] });
  });
});

describe('referral actions (one command under the staff session)', () => {
  const createForm = { requestId: REQ, branchId: BRANCH, customerName: 'Ishaan Mehra', mobile: '', email: '', companyName: '', sourceKind: '', sourceNote: '', title: 'Kerala' };

  it('create referral quotation: exact arguments; success opens the editor; duplicates are links, never a block', async () => {
    rpcReplies({ quotation_create_standalone: { data: { referralDraftId: DRAFT, referralReference: 'TD-302', quotationId: Q, reference: 'TQ-7010', versionId: V, versionNo: 1, rowVersion: 1, created: true, possibleDuplicates: [{ reference: 'TD-298' }] } } });
    const result = await referralActions.createReferralQuotationAction(null, form(createForm));
    expect(rpc).toHaveBeenCalledWith('quotation_create_standalone', { p_branch_id: BRANCH, p_customer: { customerName: 'Ishaan Mehra', mobile: null, email: null, companyName: null, sourceKind: null, sourceNote: null }, p_title: 'Kerala', p_request_id: REQ });
    expect(result).toMatchObject({ ok: true, data: { href: `/app/quotations/${V}`, referralReference: 'TD-302', possibleDuplicates: [{ reference: 'TD-298', href: '/app/quotations?reference=TD-298' }] } });
  });

  it('switch off: refused in plain words; invalid input names the RFIELD inputs', async () => {
    rpcReplies({ quotation_create_standalone: { error: { code: '55000', message: 'referral_drafts_disabled' } } });
    await expect(referralActions.createReferralQuotationAction(null, form(createForm))).resolves.toEqual({ ok: false, code: 'referral_drafts_disabled', message: QUOTATION_ERROR_TEXT.referral_drafts_disabled });
    rpcReplies({ itinerary_create_standalone: { error: { code: '22023', message: 'invalid_input', hint: 'customerName,branch' } } });
    await expect(referralActions.createReferralItineraryAction(null, form(createForm))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['customerName', 'branchId'] });
  });

  it('link refusals use the referral words (DA-65); an unexplained failure is never "nothing changed"', async () => {
    rpcReplies({ referral_draft_link: { error: { code: '22023', message: 'branch_mismatch' } } });
    await expect(referralActions.linkReferralDraftAction(null, form({ draftId: DRAFT, rowVersion: '3', targetKind: 'deal', targetId: DEAL, note: '' }))).resolves.toEqual({ ok: false, code: 'branch_mismatch', message: 'That deal is in another branch. Ask that branch’s Manager.' });
    rpcReplies({ referral_draft_unlink: { error: { code: 'XX000', message: 'boom' } } });
    await expect(referralActions.unlinkReferralDraftAction(null, form({ linkId: LINK, rowVersion: '3', reason: 'other', note: 'Linked by mistake today.' }))).rejects.toThrow('Reload the page to check');
  });

  it('reopen reports the new closing date from the database', async () => {
    rpcReplies({ referral_draft_reopen: { data: { status: 'open', closedAutomatically: true, dueOn: '2026-10-10', autoClose: { state: 'scheduled', dueOn: '2027-01-19' }, rowVersion: 5 } } });
    await expect(referralActions.reopenReferralDraftAction(null, form({ draftId: DRAFT, rowVersion: '4', note: '' }))).resolves.toMatchObject({ ok: true, message: 'Reopened. The 90 days start again. Closes on 19 Jan 2027 if nothing changes.' });
  });
});

describe('Start booking from a referral quotation: bind to the draft’s deal, then convert (two steps, honest report)', () => {
  const getRecord = (over: Record<string, unknown> = {}) => ({
    quotationId: Q,
    reference: 'TQ-7003',
    title: 'Kerala',
    rowVersion: 4,
    subject: { kind: 'referral', leadId: null, dealId: null, referralDraftId: DRAFT, linkedDealId: null, reference: 'TD-301', title: 'Ishaan Mehra' },
    version: { versionId: V, versionNo: 1, status: 'accepted', rowVersion: 7, contentHash: HASH, validUntil: null, basedOnVersionId: null, sentAt: null, sentChannel: null, acceptedAt: '2026-10-20T08:00:00Z', acceptedTier: 'quoted', declinedAt: null, declineReason: null },
    trip: { destination: null, scope: null, start: null, end: null },
    pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 0, infants: 0, remarks: null },
    content: {},
    tiers: [{ tierKey: 'quoted', label: null }],
    items: [],
    evidence: [],
    issues: [],
    canEdit: false,
    conversion: null,
    referral: { referralDraftId: DRAFT, reference: 'TD-301', status: 'open', closedReason: null, closedAt: null, autoClose: { state: 'none', dueOn: null }, linked: true, bound: false, activeDealId: DEAL, activeLeadId: null, canReopen: false },
    ...over,
  });
  const convertForm = () => form({ versionId: V, contentHash: HASH, requestId: REQ });

  it('binds to the draft’s ACTIVE deal link (from the database, never the form), then converts', async () => {
    rpcReplies({
      quotation_get: { data: getRecord() },
      quotation_link_deal: { data: { quotationId: Q, linkedDealId: DEAL, rowVersion: 5 } },
      quotation_convert_to_booking: { data: { outcome: 'created', bookingVersionId: BV, dealId: DEAL, itemsCreated: 0 } },
    });
    await expect(quoteActions.convertQuotationAction(null, convertForm())).resolves.toMatchObject({ ok: true, message: QUOTATION_TEXT.converted });
    expect(rpc.mock.calls.map(([fn]) => fn)).toEqual(['quotation_get', 'quotation_link_deal', 'quotation_convert_to_booking']);
    expect(rpc).toHaveBeenCalledWith('quotation_link_deal', expect.objectContaining({ p_quotation_id: Q, p_deal_id: DEAL }));
  });

  it('bound, then the booking is refused: the answer says both', async () => {
    rpcReplies({
      quotation_get: { data: getRecord() },
      quotation_link_deal: { data: { quotationId: Q, linkedDealId: DEAL, rowVersion: 5 } },
      quotation_convert_to_booking: { error: { code: '55000', message: 'draft_not_empty' } },
    });
    await expect(quoteActions.convertQuotationAction(null, convertForm())).resolves.toEqual({
      ok: false,
      code: 'draft_not_empty',
      message: QUOTATION_TEXT.boundNotBooked.replace('{reason}', QUOTATION_ERROR_TEXT.draft_not_empty),
    });
  });

  it('the bind is refused: nothing is converted; no deal link means no bind (the conversion refuses in words)', async () => {
    rpcReplies({ quotation_get: { data: getRecord() }, quotation_link_deal: { error: { code: '55000', message: 'deal_not_linked_to_draft' } } });
    await expect(quoteActions.convertQuotationAction(null, convertForm())).resolves.toEqual({ ok: false, code: 'deal_not_linked_to_draft', message: QUOTATION_ERROR_TEXT.deal_not_linked_to_draft });
    expect(rpc.mock.calls.map(([fn]) => fn)).not.toContain('quotation_convert_to_booking');
    vi.clearAllMocks();
    requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc } });
    rpcReplies({
      quotation_get: { data: getRecord({ referral: { ...getRecord().referral, activeDealId: null, linked: false } }) },
      quotation_convert_to_booking: { error: { code: '55000', message: 'deal_link_required' } },
    });
    await expect(quoteActions.convertQuotationAction(null, convertForm())).resolves.toMatchObject({ ok: false, code: 'deal_link_required' });
    expect(rpc.mock.calls.map(([fn]) => fn)).toEqual(['quotation_get', 'quotation_convert_to_booking']);
  });
});

describe('quotation view of a referral quotation', async () => {
  const { QuotationGetSchema } = await import('@/modules/quotations/commands');
  const { toQuotationVersionView } = await import('@/modules/quotations/dto');
  const { quoteHeader } = await import('@/modules/quotations/editor-model');
  const base = {
    quotationId: Q,
    reference: 'TQ-7003',
    title: 'Kerala',
    rowVersion: 4,
    subject: { kind: 'referral', leadId: null, dealId: null, referralDraftId: DRAFT, linkedDealId: null, reference: 'TD-301', title: 'Ishaan Mehra' },
    version: { versionId: V, versionNo: 1, status: 'accepted', rowVersion: 7, contentHash: HASH, validUntil: null, basedOnVersionId: null, sentAt: null, sentChannel: null, acceptedAt: '2026-10-20T08:00:00Z', acceptedTier: 'quoted', declinedAt: null, declineReason: null },
    trip: { destination: null, scope: null, start: null, end: null },
    pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 0, infants: 0, remarks: null },
    content: {},
    tiers: [{ tierKey: 'quoted', label: null }],
    items: [],
    evidence: [],
    issues: [],
    canEdit: false,
    conversion: null,
  };
  const referral = (over: Record<string, unknown> = {}) => ({ referralDraftId: DRAFT, reference: 'TD-301', status: 'open', closedReason: null, closedAt: null, autoClose: { state: 'none', dueOn: null }, linked: true, bound: false, activeDealId: DEAL, activeLeadId: null, canReopen: false, ...over });
  const view = (r: unknown) => toQuotationVersionView(QuotationGetSchema.parse({ ...base, referral: r }));

  it('accepted and linked to a deal: Start booking is offered (it binds, then converts)', () => {
    const v = view(referral());
    expect(v).toMatchObject({ canConvert: true, canLinkDeal: false, referral: { activeDealId: DEAL } });
    expect(quoteHeader({ version: v, ownerName: null }).primary).toBe('start_booking');
  });

  it('accepted, draft not linked to a deal: no booking; the next line says to link the draft', () => {
    const v = view(referral({ activeDealId: null, linked: false }));
    expect(v.canConvert).toBe(false);
    // Mercury F31: the waiting sentence is the page notice's; it is not repeated as the next-step text.
    expect(v.nextStepText).toBeNull();
    expect(v.referral).toMatchObject({ canLink: true, activeDealReference: null });
    expect(quoteHeader({ version: v, ownerName: null }).nextLine).toBe('Next: link the referral draft to the confirmed Bitrix deal');
  });

  it('closed draft: every write is off and the next line says reopen', () => {
    const v = view(referral({ status: 'closed', closedReason: 'lost', canReopen: true }));
    expect(v).toMatchObject({ canEdit: false, canConvert: false, canNewVersion: false, canUploadEvidence: false, nextStepText: QUOTATION_TEXT.referralDraftClosed });
    expect(quoteHeader({ version: v, ownerName: null }).nextLine).toBe('Next: reopen the referral draft to make changes');
  });

  it('a Lead quotation is unchanged (no referral block on an older database)', () => {
    const v = toQuotationVersionView(QuotationGetSchema.parse({ ...base, subject: { ...base.subject, kind: 'lead', leadId: DEAL, referralDraftId: undefined } }));
    expect(v).toMatchObject({ referral: null, canConvert: false, canLinkDeal: true });
  });
});


describe('fix round: link step failures, F4 words, result notices, rows from the lists', () => {
  it('a failed candidate read says so (Echo M3); a lead-linked draft explains a deal not made from that lead (F4)', () => {
    const failed = referralLinkStepVM({ kind: 'deal', branchName: 'Jodhpur', query: '', candidates: null });
    expect(failed).toMatchObject({ candidates: [], emptyText: null, loadError: WORK_TEXT.linkLoadError });
    const c = { kind: 'deal' as const, id: DEAL, reference: 'D-1', title: 'x', branchName: null, active: true, fromLinkedLead: false, alreadyHasAcceptedQuotation: false, linkable: false };
    expect(referralLinkStepVM({ kind: 'deal', branchName: 'Jodhpur', query: '', candidates: [c], draftLeadLinked: true }).candidates[0]?.refusedText).toBe('That deal was not made from the linked lead in Bitrix.');
    expect(referralLinkStepVM({ kind: 'lead', branchName: 'Jodhpur', query: '', candidates: [] })).toMatchObject({ heading: 'Leads in Jodhpur that you can work on', confirmTemplate: WORK_TEXT.linkConfirm.lead });
  });

  it('DA-64 / DA-68 notices name the record from the draft’s own links; anything else shows nothing', async () => {
    const { referralResultNotice } = await import('@/modules/quotations/work-model');
    const link = { linkId: LINK, targetKind: 'deal' as const, targetId: DEAL, reference: 'D-5109', title: null, active: true, linkedAt: '2026-10-18T08:00:00Z', linkedByYou: true, endedAt: null, endReason: null, canRemove: true };
    expect(referralResultNotice({ links: [link] }, 'linked', LINK)).toBe('Linked to D-5109. Nothing changed in Bitrix.');
    expect(referralResultNotice({ links: [{ ...link, active: false, endedAt: '2026-10-19T08:00:00Z' }] }, 'unlinked', LINK)).toBe('Link to D-5109 removed. You can link the right record now.');
    expect(referralResultNotice({ links: [link] }, 'unlinked', LINK)).toBeNull();
    expect(referralResultNotice({ links: [link] }, 'linked', Q)).toBeNull();
    expect(referralResultNotice({ links: [link] }, '<script>', LINK)).toBeNull();
  });

  it('the draft page uses the lists’ rows (own update time) and says when a difference count is unknown (Echo L2, Mercury F6)', () => {
    const fromList = referralDraftVM(draftRecord(), 'quotations', { quotations: [qRow({ since: '2026-10-20T08:00:00Z' })] });
    expect(fromList.quotations[0]?.updatedText).toBe('Updated 20 Oct 2026');
    const fallback = referralDraftVM(draftRecord(), 'itineraries');
    expect(fallback.quotations[0]?.updatedText).toBe('');
    expect(fallback.itineraries[0]).toMatchObject({ openDifferences: 0, differencesKnown: false, updatedText: '' });
  });

  it('New pages: not for people without the Quotations menu item (Echo L4); title hint names the default', () => {
    const vm = newWorkVM({ kind: 'quotations', switchState: 'on', memberships: [], canSeeLeads: false, allowed: false });
    expect(vm.allowed).toBe(false);
    expect(vm.referral.titleHint).toBe(WORK_TEXT.titleHint.quotations);
  });

  it('per-action not-authorized words (DA-236); link success returns to the Link tab with the record named', async () => {
    rpcReplies({ referral_draft_reassign: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(referralActions.reassignReferralDraftAction(null, form({ draftId: DRAFT, rowVersion: '3', newOwner: USER, reason: 'Moving to the Delhi team' }))).resolves.toMatchObject({ message: 'Only the branch Manager can change the owner. Nothing was changed.' });
    rpcReplies({ referral_draft_link: { data: { linkId: LINK, targetKind: 'deal', targetId: DEAL, rowVersion: 4, existing: false } } });
    await expect(referralActions.linkReferralDraftAction(null, form({ draftId: DRAFT, rowVersion: '3', targetKind: 'deal', targetId: DEAL, note: '' }))).rejects.toThrow('NEXT_REDIRECT');
    rpcReplies({ referral_draft_unlink: { data: { linkId: LINK, ended: true, rowVersion: 5 } } });
    await expect(referralActions.unlinkReferralDraftAction(null, form({ linkId: LINK, rowVersion: '4', reason: 'other', note: 'Linked by mistake today.' }))).resolves.toMatchObject({ ok: true, message: 'Link removed. You can link the right record now.' });
    await expect(referralActions.unlinkReferralDraftAction(null, form({ draftId: DRAFT, linkId: LINK, rowVersion: '4', reason: 'other', note: 'Linked by mistake today.' }))).rejects.toThrow('NEXT_REDIRECT');
  });
});

describe('Atlas §7: ready to book and the draft link on rows (Mercury F1, DA-209)', () => {
  it('a linked draft’s accepted quotation is "Start booking" with "linked to deal"; unlinked says so; an older database says nothing', () => {
    const ready = workQuotationRowVM({ ...qRow({ accepted: true, currentVersion: { versionId: V, versionNo: 1, status: 'accepted', validUntil: null } }), readyToBook: true, draftLink: { kind: 'deal', reference: 'D-5109' } });
    expect(ready.action).toEqual({ kind: 'start_booking', label: 'Start booking', href: `/app/quotations/${V}` });
    expect(ready.subject.text).toBe('Referral draft TD-301 · linked to deal D-5109');
    expect(workQuotationRowVM({ ...qRow(), draftLink: { kind: 'lead', reference: 'L-3102' } }).subject.text).toBe('Referral draft TD-301 · linked to lead L-3102');
    expect(workQuotationRowVM({ ...qRow(), draftLink: null }).subject.text).toBe('Referral draft TD-301 · not linked to Bitrix yet');
    expect(workQuotationRowVM(qRow()).subject.text).toBe('Referral draft TD-301');
    const closedAccepted = workQuotationRowVM({ ...qRow({ accepted: true, currentVersion: { versionId: V, versionNo: 1, status: 'accepted', validUntil: null } }), readyToBook: false });
    expect(closedAccepted.action?.kind).toBe('open');
  });

  it('"Ready to book" is a chip and a valid filter', () => {
    expect(parseWorkListQuery('quotations', { filter: 'ready_to_book' }).filter).toBe('ready_to_book');
    const vm = quotationListPageVM(parseWorkListQuery('quotations', { filter: 'ready_to_book' }), 'error');
    expect(vm.filters.chips.find((c) => c.filter === 'ready_to_book')).toMatchObject({ label: 'Ready to book', current: true, href: '/app/quotations?filter=ready_to_book' });
  });
});
