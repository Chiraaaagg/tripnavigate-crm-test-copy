import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDealDocuments } from '@/modules/deals/server/documents';
import { loadMyWorkList } from '@/modules/fulfilment/server/work-list';
import { loadRecordOwnerNames } from '@/modules/identity/server/staff-names';
import { runBitrixNameRefresh } from '@/modules/integration/bitrix/name-refresh';
import { loadBitrixNameMap, loadBitrixNameReadState, setBitrixNameRead } from '@/modules/integration/server/name-map';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, DEAL2, MANAGER, OWNER, PURCHASE, SALES_B, SUPER, SVC, b1Helpers } from './b1-support';
import { rpcAs, staffAs } from './b12-ts-support';

/**
 * Direction A Batch 1: the TypeScript wrappers of B1-1..B1-4 against the real
 * functions (PGlite, or real Postgres with TEST_DATABASE_URL), called the way
 * PostgREST calls them. Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const d = () => db;

describe('B1-1 name map wrappers', () => {
  it('switch, worker refresh (mock Bitrix) and staff read round-trip; off restores the fallback', async () => {
    await asOwner(db, async () => {
      expect(await loadBitrixNameMap(staffAs(d, OWNER) as never)).toEqual({ state: 'switched_off' });
      expect(await setBitrixNameRead(rpcAs(d, OWNER), true, 'Owner approval APPROVE, synthetic test run')).toEqual({ ok: false, code: 'not_authorized' });
      expect(await setBitrixNameRead(rpcAs(d, SUPER), true, 'short')).toEqual({ ok: false, code: 'reason_required' });
      expect(await setBitrixNameRead(rpcAs(d, SUPER), true, 'Owner approval APPROVE, synthetic test run'))
        .toEqual({ ok: true, result: { changed: true, enabled: true } });
      // DEC-55: the switch card's state with who and when.
      expect(await loadBitrixNameReadState(staffAs(d, SUPER) as never)).toMatchObject({
        state: 'known', enabled: true, canSwitch: true,
        connectionEnabled: true, effective: true,
        lastChange: { byName: 'Synthetic Admin Jodhpur', via: 'command', to: true, reason: 'Owner approval APPROVE, synthetic test run' },
      });
      expect(await loadBitrixNameReadState(staffAs(d, OWNER) as never)).toEqual({ state: 'unknown', reason: 'not_authorized' });
      const bitrix = {
        call: (async (_method: string, params: Record<string, unknown> = {}) => {
          const entity = (params.filter as { ENTITY_ID: string }).ENTITY_ID;
          const result = entity === 'DEAL_STAGE_7'
            ? [{ STATUS_ID: 'C7:NEW', NAME: 'New enquiry', SORT: 10 }, { STATUS_ID: 'C7:WON', NAME: 'Booked', SORT: 20, SEMANTICS: 'S' }]
            : entity === 'STATUS' ? [{ STATUS_ID: 'NEW', NAME: 'Fresh lead', SORT: 10 }] : [{ STATUS_ID: 'WEB', NAME: 'Website', SORT: 10 }];
          return { result, next: null, total: null };
        }) as never,
      };
      const r = await runBitrixNameRefresh({ rpc: rpcAs(d, SVC), bitrix, config: { portalMemberId: 'SYNTHETIC_MEMBER_0001' } });
      expect(r).toEqual({ status: 'ran', listsRead: 3, listsFailed: 0, added: 4, renamed: 0, missing: 0, restored: 0 });
      expect(await runBitrixNameRefresh({ rpc: rpcAs(d, SVC), bitrix, config: { portalMemberId: 'SYNTHETIC_MEMBER_0001' } }))
        .toEqual({ status: 'not_due', reason: 'fresh' });
      const view = await loadBitrixNameMap(staffAs(d, OWNER) as never);
      expect(view).toMatchObject({ state: 'on', names: expect.arrayContaining([
        { entityId: 'DEAL_STAGE_7', code: 'C7:WON', name: 'Booked', kind: 'won', missing: false },
        { entityId: 'STATUS', code: 'NEW', name: 'Fresh lead', kind: null, missing: false },
      ]) });
      // Echo L3: Purchase gets the Deal stage names only.
      const purchaseView = await loadBitrixNameMap(staffAs(d, PURCHASE) as never);
      expect(purchaseView.state === 'on' && purchaseView.names.every((n) => n.entityId.startsWith('DEAL_STAGE'))).toBe(true);
      await setBitrixNameRead(rpcAs(d, SUPER), false, 'Owner asked to switch it off again');
      expect(await loadBitrixNameMap(staffAs(d, OWNER) as never)).toEqual({ state: 'switched_off' });
    });
  });
});

describe('B1-2, B1-3, B1-4 wrappers', () => {
  it('documents: the owner sees the booking proof link; Purchase does not', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyHotel(OWNER, DEAL);
      const owner = await loadDealDocuments(staffAs(d, OWNER) as never, DEAL);
      expect(owner.state).toBe('ok');
      const files = owner.state === 'ok' ? owner.files : [];
      expect(files.find((f) => f.kind === 'booking_file')).toMatchObject({ context: { versionNo: 1, evidenceKind: 'acceptance_message' } });
      expect(files.every((f) => f.href.startsWith('/app/'))).toBe(true);
      const purchase = await loadDealDocuments(staffAs(d, PURCHASE) as never, DEAL);
      expect(purchase).toEqual({ state: 'ok', files: [] });
      expect(ready.versionId).toBeTruthy();
    });
  });

  it('work list: pages through drafts with the cursor; Purchase gets applies:false', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      await h.openDraft(OWNER, DEAL);
      await h.openDraft(SALES_B, DEAL2);
      const first = await loadMyWorkList(staffAs(d, MANAGER) as never, 'drafts', { limit: 1 });
      expect(first).toMatchObject({ state: 'ok', page: { applies: true, available: true, hasMore: true } });
      const next = first.state === 'ok' && first.page.applies && first.page.available ? first.page.next : null;
      const second = await loadMyWorkList(staffAs(d, MANAGER) as never, 'drafts', { limit: 1, after: next });
      expect(second).toMatchObject({ state: 'ok', page: { hasMore: false, next: null } });
      expect(await loadMyWorkList(staffAs(d, PURCHASE) as never, 'drafts')).toEqual({ state: 'ok', page: { applies: false } });
      expect(await loadMyWorkList(staffAs(d, OWNER) as never, 'needs_booking'))
        .toEqual({ state: 'ok', page: { applies: true, available: false, reason: 'switched_off' } });
    });
  });

  it('owner names: the Deal owner by name; an assignee or unrelated colleague stays unnamed', async () => {
    await asOwner(db, async () => {
      await h.addSalesAssignee(DEAL, U.salesDelhiB);
      expect(await loadRecordOwnerNames(staffAs(d, SALES_B) as never, [U.salesDelhiA, U.accountsJodhpur]))
        .toEqual(new Map([[U.salesDelhiA, 'Synthetic Sales Delhi A']]));
      expect(await loadRecordOwnerNames(staffAs(d, OWNER) as never, [U.salesDelhiB])).toEqual(new Map());
    });
  });
});
