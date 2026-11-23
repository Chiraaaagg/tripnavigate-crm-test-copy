import { describe, expect, it } from 'vitest';
import { dealDocumentHref, toDealDocumentViews } from '@/modules/deals/documents';
import { loadDealDocuments } from '@/modules/deals/server/documents';
import { loadMyWorkList } from '@/modules/fulfilment/server/work-list';
import { MY_WORK_LIST_COUNT_KEY, parseMyWorkListCursor, toMyWorkListPage } from '@/modules/fulfilment/work-list';
import { loadRecordOwnerNames } from '@/modules/identity/server/staff-names';
import { STAFF_NAMES_MAX_IDS, staffNameRequestIds, toStaffNameMap } from '@/modules/identity/staff-names';

/**
 * Direction A Batch 1 B1-2, B1-3, B1-4: application wrappers of the new reads.
 * DTO allowlists, honest failure states (never an empty list or a zero for a
 * failure), and the existing download routes for links. Fake clients only;
 * tests/db/batch1-ts-wrappers.test.ts runs the same wrappers on the database.
 */

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Reply = { data: unknown; error: { code?: string } | null } | Error;
function staff(reply: Reply) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const supabase = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { staff: { supabase } as never, calls };
}

describe('B1-2 Deal documents', () => {
  const row = (kind: string, context: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    kind, id: UUID(1), fileName: 'f.pdf', mime: 'application/pdf', uploadedAt: '2026-10-19T00:00:00Z', context, ...extra,
  });

  it('copies allowlisted keys only and links each kind to its existing download route', () => {
    const views = toDealDocumentViews({ files: [
      row('id_proof', { travellerSeq: 2 }, { objectPath: 'secret/path', uploadedBy: UUID(9) }),
      row('booking_file', { versionNo: 1, evidenceKind: 'payment_proof' }),
      row('itinerary_pdf', { pdfKind: 'final', documentId: UUID(3) }),
    ] });
    expect(views).toEqual([
      { kind: 'id_proof', id: UUID(1), fileName: 'f.pdf', mime: 'application/pdf', uploadedAt: '2026-10-19T00:00:00Z', context: { travellerSeq: 2 }, href: `/app/id-proofs/${UUID(1)}` },
      { kind: 'booking_file', id: UUID(1), fileName: 'f.pdf', mime: 'application/pdf', uploadedAt: '2026-10-19T00:00:00Z', context: { versionNo: 1, evidenceKind: 'payment_proof' }, href: `/app/bookings/evidence/${UUID(1)}` },
      { kind: 'itinerary_pdf', id: UUID(1), fileName: 'f.pdf', mime: 'application/pdf', uploadedAt: '2026-10-19T00:00:00Z', context: { pdfKind: 'final', documentId: UUID(3) }, href: `/app/itineraries/rendered/${UUID(1)}` },
    ]);
    expect(JSON.stringify(views)).not.toMatch(/secret|uploadedBy/);
    expect(dealDocumentHref('quotation_acceptance', UUID(4))).toBe(`/app/quotations/evidence/${UUID(4)}`);
    expect(dealDocumentHref('itinerary_source', UUID(4))).toBe(`/app/itineraries/sources/${UUID(4)}`);
    expect(dealDocumentHref('purchase_file', UUID(4))).toBe(`/app/purchase/files/${UUID(4)}`);
    expect(dealDocumentHref('department_file', UUID(4))).toBe(`/app/department/evidence/${UUID(4)}`);
  });

  it('a malformed row makes the whole reply invalid (never a partial tab)', () => {
    expect(toDealDocumentViews({ files: [row('id_proof', { travellerSeq: 'x' })] })).toBeNull();
    expect(toDealDocumentViews({ files: [row('finance_evidence', {})] })).toBeNull();
    expect(toDealDocumentViews({})).toBeNull();
    expect(toDealDocumentViews({ files: [] })).toEqual([]);
  });

  it('loader states: ok, error (never "No documents"), not_installed; a bad id asks nothing', async () => {
    const ok = staff({ data: { files: [] }, error: null });
    expect(await loadDealDocuments(ok.staff, UUID(5))).toEqual({ state: 'ok', files: [] });
    expect(ok.calls).toEqual([['deal_documents_list', { p_deal_id: UUID(5) }]]);
    expect(await loadDealDocuments(staff({ data: null, error: { code: '42501' } }).staff, UUID(5))).toEqual({ state: 'error' });
    expect(await loadDealDocuments(staff({ data: null, error: { code: 'PGRST202' } }).staff, UUID(5))).toEqual({ state: 'not_installed' });
    expect(await loadDealDocuments(staff(new Error('network')).staff, UUID(5))).toEqual({ state: 'error' });
    expect(await loadDealDocuments(staff({ data: { files: 'x' }, error: null }).staff, UUID(5))).toEqual({ state: 'error' });
    const bad = staff({ data: { files: [] }, error: null });
    expect(await loadDealDocuments(bad.staff, 'not-a-uuid')).toEqual({ state: 'ok', files: [] });
    expect(bad.calls).toEqual([]);
  });
});

describe('B1-3 Home work lists', () => {
  const ROW = { dealId: UUID(1), reference: 'SYN-1', title: 'Synthetic', branchId: UUID(2), versionNo: 3, since: '2026-10-19T00:00:00Z', amount: 1 };

  it('each kind names the count it mirrors (drafts read draftsToContinue, never waitingForMe)', () => {
    expect(MY_WORK_LIST_COUNT_KEY).toEqual({ drafts: 'draftsToContinue', missing_details: 'missingDetails', returned: 'returnedToMe', needs_booking: 'intakeNeeded' });
  });

  it('parses pages with allowlisted keys; malformed is null', () => {
    expect(toMyWorkListPage({ applies: false })).toEqual({ applies: false });
    expect(toMyWorkListPage({ applies: true, available: false, reason: 'switched_off' })).toEqual({ applies: true, available: false, reason: 'switched_off' });
    expect(toMyWorkListPage({ applies: true, available: true, rows: [ROW], hasMore: true, next: { since: ROW.since, dealId: UUID(1) } })).toEqual({
      applies: true, available: true,
      rows: [{ dealId: UUID(1), reference: 'SYN-1', title: 'Synthetic', branchId: UUID(2), versionNo: 3, since: ROW.since }],
      hasMore: true, next: { since: ROW.since, dealId: UUID(1) },
    });
    expect(toMyWorkListPage({ applies: true, available: true, rows: [{ ...ROW, dealId: 'x' }], hasMore: false, next: null })).toBeNull();
    expect(parseMyWorkListCursor({ since: 's', dealId: UUID(1) })).toEqual({ since: 's', dealId: UUID(1) });
    expect(parseMyWorkListCursor({ since: 's', dealId: 'x' })).toBeNull();
  });

  it('loader: arguments, bounded limit, error and not_installed states', async () => {
    const ok = staff({ data: { applies: false }, error: null });
    expect(await loadMyWorkList(ok.staff, 'returned', { limit: 500, after: { since: 's', dealId: UUID(1) } })).toEqual({ state: 'ok', page: { applies: false } });
    expect(ok.calls).toEqual([['my_work_list', { p_kind: 'returned', p_after: { since: 's', dealId: UUID(1) }, p_limit: 50 }]]);
    expect(await loadMyWorkList(staff({ data: null, error: { code: '22023' } }).staff, 'drafts')).toEqual({ state: 'error' });
    expect(await loadMyWorkList(staff({ data: null, error: { code: '42883' } }).staff, 'drafts')).toEqual({ state: 'not_installed' });
    expect(await loadMyWorkList(staff({ data: { applies: 'x' }, error: null }).staff, 'drafts')).toEqual({ state: 'error' });
    expect(await loadMyWorkList(staff(new Error('network')).staff, 'drafts')).toEqual({ state: 'error' });
    expect(await loadMyWorkList(staff({ data: null, error: null }).staff, 'everything' as never)).toEqual({ state: 'error' });
  });
});

describe('B1-4 owner names', () => {
  it('request ids: distinct, valid, at most 200', () => {
    expect(staffNameRequestIds([UUID(1), null, UUID(1), 'x', undefined, UUID(2)])).toEqual([UUID(1), UUID(2)]);
    expect(staffNameRequestIds(Array.from({ length: 300 }, (_, i) => UUID(i + 1)))).toHaveLength(STAFF_NAMES_MAX_IDS);
  });

  it('reply map keeps the display name only; malformed is null', () => {
    expect(toStaffNameMap([{ userId: UUID(1), displayName: 'Synthetic A', email: 'a@example.test' }])).toEqual(new Map([[UUID(1), 'Synthetic A']]));
    expect(toStaffNameMap([{ userId: 'x', displayName: 'A' }])).toBeNull();
  });

  it('loader never throws and falls back to an empty map (today\'s wording)', async () => {
    const ok = staff({ data: [{ userId: UUID(1), displayName: 'Synthetic A' }], error: null });
    expect(await loadRecordOwnerNames(ok.staff, [UUID(1), UUID(1)])).toEqual(new Map([[UUID(1), 'Synthetic A']]));
    expect(ok.calls).toEqual([['record_staff_names', { p_user_ids: [UUID(1)] }]]);
    const none = staff({ data: [], error: null });
    expect(await loadRecordOwnerNames(none.staff, [null, 'x'])).toEqual(new Map());
    expect(none.calls).toEqual([]);
    expect(await loadRecordOwnerNames(staff({ data: null, error: { code: 'PGRST202' } }).staff, [UUID(1)])).toEqual(new Map());
    expect(await loadRecordOwnerNames(staff(new Error('network')).staff, [UUID(1)])).toEqual(new Map());
    expect(await loadRecordOwnerNames(staff({ data: { odd: true }, error: null }).staff, [UUID(1)])).toEqual(new Map());
  });
});
