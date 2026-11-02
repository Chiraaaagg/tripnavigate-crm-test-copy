import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isReferralFunctionMissing,
  itineraryCreateStandalone,
  quotationCreateStandalone,
  ReferralCommandError,
  referralDraftClose,
  referralDraftFind,
  referralDraftGet,
  referralDraftLink,
  referralDraftReassign,
  referralDraftReopen,
  referralDraftSave,
  referralDraftsForSubject,
  referralDraftUnlink,
  referralLinkCandidates,
  referralOwnerCandidates,
  workDraftsList,
} from '@/modules/quotations/referral';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { MANAGER, OWNER, PURCHASE, SALES_B, rid } from './b1-support';
import { rpcAs } from './b12-ts-support';
import { CUSTOMER, batch3Helpers } from './batch3-support';

/**
 * Batch 3 TS wrappers (src/modules/quotations/referral.ts) against the real
 * SQL of 20261123000100 on PGlite: every reply parses through the zod
 * allowlists, refusals map to their codes with hint keys, and null answers
 * stay null. Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = batch3Helpers(() => db);

async function codeOf(p: Promise<unknown>): Promise<{ code: unknown; hint: string[] }> {
  await db.exec('savepoint ts_err');
  try {
    await p;
  } catch (e) {
    await db.exec('rollback to savepoint ts_err');
    expect(e).toBeInstanceOf(ReferralCommandError);
    return { code: (e as ReferralCommandError).code, hint: (e as ReferralCommandError).hintKeys };
  }
  throw new Error('expected a refusal');
}

describe('Batch 3 wrappers', () => {
  it('create, read, list, link, unlink, close, reopen, reassign through the TS layer', async () => {
    await asOwner(db, async () => {
      const rpc = rpcAs(() => db, OWNER);
      const mgr = rpcAs(() => db, MANAGER);
      const branchId = await h.branchId('DEL');
      expect(await codeOf(quotationCreateStandalone(rpc, { branchId, customer: CUSTOMER as never, title: 'T', requestId: rid() })))
        .toEqual({ code: 'referral_drafts_disabled', hint: [] });
      await h.referralSwitch(true);
      expect(await codeOf(quotationCreateStandalone(rpc, { branchId, customer: { customerName: '', mobile: '1' }, title: 'T', requestId: rid() })))
        .toEqual({ code: 'invalid_input', hint: ['customerName', 'mobile'] });
      const q = await quotationCreateStandalone(rpc, { branchId, customer: { customerName: 'Synthetic TS Customer', mobile: '9876500111',
        sourceKind: 'phone' }, title: 'Synthetic TS quote', requestId: rid() });
      expect(q).toMatchObject({ referralReference: 'TD-1', versionNo: 1, created: true, possibleDuplicates: [] });
      const it2 = await itineraryCreateStandalone(rpc, { branchId, customer: { customerName: 'Synthetic TS Customer', mobile: '9876500111' },
        title: 'Synthetic TS itinerary', requestId: rid() });
      expect(it2.possibleDuplicates).toEqual([{ reference: 'TD-1' }]);

      const draft = (await referralDraftGet(rpc, q.referralDraftId))!;
      expect(draft).toMatchObject({ reference: 'TD-1', status: 'open', autoClose: { state: 'scheduled' }, source: { kind: 'phone', note: null },
        customer: { customerName: 'Synthetic TS Customer', mobile: '9876500111', email: null } });
      expect(await referralDraftGet(rpcAs(() => db, SALES_B), q.referralDraftId)).toBeNull();
      const saved = await referralDraftSave(rpc, { draftId: q.referralDraftId, rowVersion: draft.rowVersion, fields: { companyName: 'Synthetic Co' } });
      expect(saved.changedFields).toEqual(['companyName']);

      const page = await workDraftsList(rpc, 'quotations', { status: 'open' }, null, 10);
      expect(page.applies).toBe(true);
      if (page.applies) {
        expect(page.counts.open).toBe(1);
        expect(page.rows[0]).toMatchObject({ quotationId: q.quotationId, subjectKind: 'referral', draft: { reference: 'TD-1' } });
      }
      const itins = await workDraftsList(rpc, 'itineraries');
      expect(itins.applies && itins.rows.map((r) => r.documentId)).toEqual([it2.documentId]);
      expect(await workDraftsList(rpcAs(() => db, PURCHASE), 'quotations')).toEqual({ applies: false });

      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 981001);
      const cands = (await referralLinkCandidates(rpc, q.referralDraftId, 'deal', null))!;
      expect(cands.map((c) => c.id)).toContain(deal);
      const link = await referralDraftLink(rpc, { draftId: q.referralDraftId, rowVersion: saved.rowVersion, targetKind: 'deal', targetId: deal });
      expect(link).toMatchObject({ targetKind: 'deal', targetId: deal, existing: false });
      expect(await referralDraftsForSubject(rpc, 'deal', deal)).toMatchObject([{ referralDraftId: q.referralDraftId, quotationCount: 1 }]);
      expect(await codeOf(referralDraftUnlink(rpc, { linkId: link.linkId, rowVersion: link.rowVersion, reason: 'wrong_link', note: 'x' })))
        .toEqual({ code: 'invalid_input', hint: ['note'] });
      const unlinked = await referralDraftUnlink(rpc, { linkId: link.linkId, rowVersion: link.rowVersion, reason: 'wrong_link',
        note: 'Synthetic wrong customer' });
      expect(unlinked.ended).toBe(true);

      expect(await referralOwnerCandidates(rpc, q.referralDraftId)).toBeNull();
      const owners = (await referralOwnerCandidates(mgr, q.referralDraftId))!;
      expect(owners.find((o) => o.userId === U.salesDelhiA)?.isCurrentOwner).toBe(true);
      const closed = await referralDraftClose(rpc, { draftId: q.referralDraftId, rowVersion: unlinked.rowVersion, reason: 'lost' });
      expect(closed).toEqual({ status: 'closed', closedReason: 'lost', alreadyClosed: false, rowVersion: unlinked.rowVersion + 1 });
      expect(await codeOf(referralDraftSave(rpc, { draftId: q.referralDraftId, rowVersion: closed.rowVersion, fields: { companyName: 'X' } })))
        .toEqual({ code: 'draft_closed', hint: [] });
      expect(await referralDraftFind(rpc, 'td-1')).toEqual({ referralDraftId: q.referralDraftId });
      const reopened = await referralDraftReopen(rpc, { draftId: q.referralDraftId, rowVersion: closed.rowVersion });
      expect(reopened).toMatchObject({ status: 'open', closedAutomatically: false, dueOn: null, autoClose: { state: 'scheduled' } });
      const re = await referralDraftReassign(mgr, { draftId: q.referralDraftId, rowVersion: reopened.rowVersion, newOwner: U.salesDelhiB,
        reason: 'Synthetic handover reason' });
      expect(re).toEqual({ ownerIsYou: false, changed: true, rowVersion: reopened.rowVersion + 1 });
      expect(await referralDraftGet(rpc, q.referralDraftId)).toBeNull();
      expect(isReferralFunctionMissing(new ReferralCommandError('x', null, '42883'))).toBe(true);
    });
  });
});
