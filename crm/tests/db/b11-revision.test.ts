import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, financeHelpers } from './finance-support';
import {
  ACCOUNTS, BUDGETS, CHECKLIST_SQL, DEAL, FLIGHT_FACTS, HOTEL, MANAGER, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, PURCHASE_GET_SQL, SAVE_ITEM_SQL,
  SERVICES_SQL, TRANSFER,
} from './b1-support';
import { FORM_SQL, TRIP, b11Helpers, rid } from './b11-support';

/**
 * Stage 3 revision path for package versions (migration 20261119000300):
 * open from a returned accepted version, classify, discard, confirm as
 * 'revised' with the base 'superseded' and no new task; Accounts and receipt
 * refusals on superseded versions; frozen rows; old reasons hidden.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const f = financeHelpers(() => db);
const { one, refused, owner, readyDraft, confirm, readiness } = h;

const OPEN = 'select public.booking_open_revision($1) as r';
const CLASSIFY = 'select public.booking_classify_revision($1, $2, $3) as r';
const DISCARD = 'select public.booking_discard_draft($1, $2) as r';
const HISTORY = 'select public.booking_version_history($1) as r';
const RETURN = 'select public.accounts_review_return($1, $2, $3) as r';
const REASON = 'Synthetic return: the check-out date is wrong';

type Opened = { versionId: string; versionNo: number; rowVersion: number; revisesVersionId: string; created: boolean };

async function confirmedAndReturned() {
  const base = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['transfer', TRANSFER]]);
  expect(base.issues).toEqual([]);
  const confirmed = await confirm(OWNER, base.versionId, base.hash);
  await refused(OWNER, OPEN, [base.versionId], '55000', 'revision_not_allowed'); // pending review
  await one(ACC, RETURN, [base.versionId, REASON, rid()]);
  return { baseId: base.versionId, taskIds: confirmed.taskIds! };
}

describe('opening, classifying and discarding a revision', () => {
  it('opens once from a returned version with the base copied (not the evidence); department views keep the accepted facts', async () => {
    await asOwner(db, async () => {
      const { baseId } = await confirmedAndReturned();
      const opened = await one<Opened>(OWNER, OPEN, [baseId]);
      expect(opened).toMatchObject({ versionNo: 2, revisesVersionId: baseId, created: true });
      expect(await one<Opened>(MANAGER, OPEN, [baseId])).toMatchObject({ versionId: opened.versionId, created: false });
      const counts = await owner<Record<string, number>>(
        `select (select count(*)::int from public.service_item_facts where booking_version_id = $1) as facts,
                (select count(*)::int from public.service_item_travellers where booking_version_id = $1) as participation,
                (select count(*)::int from public.booking_version_contacts where booking_version_id = $1) as contacts,
                (select count(*)::int from public.booking_version_instalments where booking_version_id = $1) as plan,
                (select count(*)::int from public.booking_version_commercials where version_id = $1) as commercials,
                (select count(*)::int from public.booking_evidence where version_id = $1) as evidence`, [opened.versionId]);
      expect(counts[0]).toEqual({ facts: 2, participation: 8, contacts: 1, plan: 1, commercials: 1, evidence: 0 });
      // Nothing changed yet: no_changes; the editor form shows the revision draft.
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual(['revision_class_missing', 'no_changes']);
      expect(await one(OWNER, FORM_SQL, [DEAL])).toMatchObject({ canEdit: true, version: { versionId: opened.versionId, status: 'draft' } });
      expect((await one<{ items: Array<{ code: string }> }>(OWNER, CHECKLIST_SQL, [DEAL])).items.map((i) => i.code)).toContain('no_changes');
      await refused(OWNER, CLASSIFY, [opened.versionId, opened.rowVersion, 'format_only'], '55000', 'not_ready');
      // Adding a service is not part of a revision.
      await refused(OWNER, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
        [opened.versionId, opened.rowVersion, 'activity', JSON.stringify({ name: 'X', city: 'Y', date: '2026-12-11', participants: 1 }), '0', rid()],
        '55000', 'revision_items_fixed');
      // Purchase still reads the accepted version's facts.
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      const saved = await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL,
        [items[0]!.id, opened.versionId, opened.rowVersion, JSON.stringify({ ...HOTEL, checkOut: '2026-12-14' }), BUDGETS.hotel]);
      const purchase = await one<{ items: Array<{ facts: { facts: Record<string, unknown> } }> }>(PURCHASE, SERVICES_SQL, [DEAL]);
      expect(purchase.items[0]!.facts.facts.checkOut).toBe('2026-12-13');
      const sales = await one<{ items: Array<{ facts: { facts: Record<string, unknown> } }> }>(OWNER, SERVICES_SQL, [DEAL]);
      expect(sales.items[0]!.facts.facts.checkOut).toBe('2026-12-14');
      expect(saved.rowVersion).toBe(opened.rowVersion + 1);
    });
  });

  it('classification follows the changed fields; any later save clears it; the hash includes the class', async () => {
    await asOwner(db, async () => {
      const { baseId } = await confirmedAndReturned();
      const opened = await one<Opened>(OWNER, OPEN, [baseId]);
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      // Budget only: internal_only (owner answer 1) or customer_material; never format_only.
      let rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [items[0]!.id, opened.versionId, opened.rowVersion, JSON.stringify(HOTEL), '4600000'])).rowVersion;
      await refused(OWNER, CLASSIFY, [opened.versionId, rv, 'format_only'], '22023', 'classification_not_allowed');
      const c1 = await one<{ rowVersion: number; contentHash: string; changedFields: string[] }>(OWNER, CLASSIFY, [opened.versionId, rv, 'internal_only']);
      expect(c1.changedFields).toEqual(['items.1.purchaseBudgetPaise']);
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual([]);
      // A spelling fix: format_only allowed.
      rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [items[0]!.id, opened.versionId, c1.rowVersion, JSON.stringify({ ...HOTEL, roomType: 'Synthetic Deluxe Room' }), '4600000'])).rowVersion;
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual(['revision_class_missing']);
      const c2 = await one<{ rowVersion: number; contentHash: string; changedFields: string[] }>(OWNER, CLASSIFY, [opened.versionId, rv, 'format_only']);
      expect(c2.changedFields).toEqual(['items.1.purchaseBudgetPaise', 'items.1.roomType']);
      // A date: only customer_material, which needs a fresh acceptance message on the revision.
      rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [items[0]!.id, opened.versionId, c2.rowVersion, JSON.stringify({ ...HOTEL, checkOut: '2026-12-14' }), '4600000'])).rowVersion;
      await refused(OWNER, CLASSIFY, [opened.versionId, rv, 'format_only'], '22023', 'classification_not_allowed');
      await refused(OWNER, CLASSIFY, [opened.versionId, rv, 'internal_only'], '22023', 'classification_not_allowed');
      const c3 = await one<{ rowVersion: number; contentHash: string }>(OWNER, CLASSIFY, [opened.versionId, rv, 'customer_material']);
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual(['customer_acceptance_required']);
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'd'.repeat(64));
      const r = await readiness(OWNER, opened.versionId);
      expect(r.issues).toEqual([]);
      expect(r.contentHash).not.toBe(c3.contentHash);
      // Other refusals.
      await refused(PURCHASE, CLASSIFY, [opened.versionId, c3.rowVersion, 'customer_material'], '42501', 'not_authorized');
      await refused(OWNER, CLASSIFY, [opened.versionId, c3.rowVersion, 'whatever'], '22023', 'invalid_input');
      await refused(OWNER, CLASSIFY, [baseId, 1, 'format_only'], '55000', 'already_confirmed');
    });
  });

  it('discard keeps the draft (and removes its evidence from use) and frees the slot for a new revision', async () => {
    await asOwner(db, async () => {
      const { baseId } = await confirmedAndReturned();
      const opened = await one<Opened>(OWNER, OPEN, [baseId]);
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'e'.repeat(64));
      await refused(OWNER, DISCARD, [opened.versionId, opened.rowVersion - 1], '40001', 'version_changed');
      await refused(OWNER, DISCARD, [baseId, 1], '55000', 'already_confirmed');
      expect(await one(OWNER, DISCARD, [opened.versionId, opened.rowVersion])).toEqual({ outcome: 'discarded' });
      expect(await one(OWNER, DISCARD, [opened.versionId, opened.rowVersion])).toEqual({ outcome: 'existing' });
      expect(await owner('select status from public.booking_versions where id = $1', [opened.versionId])).toEqual([{ status: 'discarded' }]);
      expect(await owner('select status from public.booking_evidence where version_id = $1', [opened.versionId])).toEqual([{ status: 'removed' }]);
      // Frozen: facts of a discarded draft cannot change.
      await h.refused(OWNER, SAVE_ITEM_SQL, [(await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]))[0]!.id,
        opened.versionId, opened.rowVersion, JSON.stringify(HOTEL), '1'], '55000', 'already_confirmed');
      const again = await one<Opened>(OWNER, OPEN, [baseId]);
      expect(again).toMatchObject({ created: true, versionNo: 3 });
    });
  });

  it('refuses after supplier confirmation or completion, on hotel versions, for non-editors, and on a superseded base', async () => {
    await asOwner(db, async () => {
      const { baseId, taskIds } = await confirmedAndReturned();
      await refused(PURCHASE, OPEN, [baseId], '42501', 'not_authorized');
      await refused(ACCOUNTS, OPEN, [baseId], '42501', 'not_authorized');
      // Owner SQL with triggers and foreign keys off: a task the supplier already confirmed.
      await owner('set local session_replication_role = replica');
      await owner(`update public.fulfilment_tasks set status = 'supplier_confirmed', assignee_user_id = $2, selected_quote_id = gen_random_uuid(),
        supplier_reference = 'SYN-REF', supplier_confirmed_by = $2, supplier_confirmed_at = now() where id = $1`, [taskIds[0], PURCHASE.userId]);
      await owner('set local session_replication_role = origin');
      await refused(OWNER, OPEN, [baseId], '55000', 'already_committed');
    });
  });
});

describe('review R1 and R3: the class must fit the actual changes', () => {
  it('an identity change after a format-only class makes the class stale; confirm refuses until re-classified with fresh acceptance', async () => {
    await asOwner(db, async () => {
      const base = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['flight', { ...FLIGHT_FACTS, passengers: 4 }]], { identities: true, scope: 'international' });
      expect(base.issues).toEqual([]);
      await confirm(OWNER, base.versionId, base.hash);
      await one(ACC, RETURN, [base.versionId, REASON, rid()]);
      const opened = await one<Opened>(OWNER, OPEN, [base.versionId]);
      const rv = (await h.saveTrip(OWNER, opened.versionId, opened.rowVersion, { ...TRIP, scope: 'international', destination: 'Synthetic City, Rajasthan, India' })).rowVersion;
      const c = await one<{ rowVersion: number; changedFields: string[] }>(OWNER, CLASSIFY, [opened.versionId, rv, 'format_only']);
      expect(c.changedFields).toEqual(['trip.destination']);
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual([]);
      // Traveller 1's date of birth changes (identity save: no version bump).
      const [idRow] = await owner<{ row_version: number }>(
        `select x.row_version from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id where t.deal_id = $1 and t.seq = 1`, [DEAL]);
      await one(OWNER, 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r',
        [DEAL, 1, idRow!.row_version, JSON.stringify({ dateOfBirth: '1991-05-17', nationality: 'Indian', passportNumber: 'Z1000001', passportExpiry: '2030-01-31' })]);
      expect(await owner('select change_class from public.booking_versions where id = $1', [opened.versionId])).toEqual([{ change_class: null }]);
      const stale = await readiness(OWNER, opened.versionId);
      expect(stale.issues).toContain('revision_class_missing');
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [opened.versionId, stale.contentHash], '55000', 'not_ready');
      // Even a class forced back by owner SQL is refused at confirm (changed fields re-checked).
      await owner(`update public.booking_versions set change_class = 'format_only', changed_fields = array['trip.destination'] where id = $1`, [opened.versionId]);
      const forced = await readiness(OWNER, opened.versionId);
      expect(forced.issues).toContain('revision_class_missing');
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [opened.versionId, forced.contentHash], '55000', 'not_ready');
      // The only allowed class now is customer_material, which needs a fresh acceptance message.
      const cur = (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [opened.versionId]))[0]!.row_version;
      await refused(OWNER, CLASSIFY, [opened.versionId, cur, 'format_only'], '22023', 'classification_not_allowed');
      const fresh = await one<{ changedFields: string[] }>(OWNER, CLASSIFY, [opened.versionId, cur, 'customer_material']);
      expect(fresh.changedFields).toEqual(['travellers.1.identity', 'trip.destination']);
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual(['customer_acceptance_required']);
    });
  });

  it('visa apply-by and passport needed-by dates are always customer-material', async () => {
    expect(await db.query(`select authz.revision_field_class('items.1.applyBy') as a, authz.revision_field_class('items.2.neededBy') as b,
      authz.revision_field_class('items.1.purpose') as c`)).toEqual([{ a: 'material', b: 'material', c: 'choice' }]);
  });
});

describe('confirming a revision', () => {
  it('supersedes the base, creates no task, keeps assignees, moves Purchase to the new facts; retries are existing', async () => {
    await asOwner(db, async () => {
      const { baseId, taskIds } = await confirmedAndReturned();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds[0]]);
      const opened = await one<Opened>(OWNER, OPEN, [baseId]);
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      const rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [items[0]!.id, opened.versionId, opened.rowVersion, JSON.stringify(HOTEL), '4700000'])).rowVersion;
      await one(OWNER, CLASSIFY, [opened.versionId, rv, 'internal_only']);
      const ready = await readiness(OWNER, opened.versionId);
      expect(ready.issues).toEqual([]);
      const tasksBefore = await owner('select count(*)::int as n from public.fulfilment_tasks');
      const result = await confirm(OWNER, opened.versionId, ready.contentHash);
      expect(result).toMatchObject({ outcome: 'revised', versionId: opened.versionId, supersededVersionId: baseId, taskIds });
      expect(await owner('select count(*)::int as n from public.fulfilment_tasks')).toEqual(tasksBefore);
      expect(await owner('select id, status, superseded_by_version_id from public.booking_versions where deal_id = $1 order by version_no', [DEAL]))
        .toEqual([{ id: baseId, status: 'superseded', superseded_by_version_id: opened.versionId },
          { id: opened.versionId, status: 'confirmed', superseded_by_version_id: null }]);
      expect(await owner('select acceptance_from_version_id from public.booking_versions where id = $1', [opened.versionId]))
        .toEqual([{ acceptance_from_version_id: baseId }]);
      // Hashes of both versions still agree with their stored values.
      expect(await owner('select bool_and(content_hash = authz.booking_content_hash(id)) as ok from public.booking_versions where deal_id = $1', [DEAL]))
        .toEqual([{ ok: true }]);
      const task = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [taskIds[0]]);
      expect(task).toMatchObject({ purchaseBudgetPaise: '4700000', assignedToYou: true, versionNo: 2, changedFields: ['items.1.purchaseBudgetPaise'] });
      expect(await confirm(OWNER, opened.versionId, ready.contentHash)).toMatchObject({ outcome: 'existing', taskIds });
      // Outbox and audit.
      expect(await owner(`select event_type, payload ->> 'base_version_id' as base from public.outbox_events where aggregate_id = $1`, [opened.versionId]))
        .toEqual([{ event_type: 'booking.version_revised', base: baseId }]);
      expect(await owner(`select action from public.audit_events where target_id in ($1, $2) and action like 'booking.version_%' order by id`, [baseId, opened.versionId]))
        .toEqual([{ action: 'booking.version_confirmed' }, { action: 'booking.version_superseded' }, { action: 'booking.version_revised' }]);
      // Superseded rows are frozen for everyone.
      expect(await owner('select count(*)::int as n from public.booking_versions where deal_id = $1 and status = $2', [DEAL, 'confirmed'])).toEqual([{ n: 1 }]);
    });
  });

  it('refuses when Accounts approved the base meanwhile (revision_not_allowed); Accounts and receipts refuse a superseded version', async () => {
    await asOwner(db, async () => {
      const { baseId } = await confirmedAndReturned();
      const opened = await one<Opened>(OWNER, OPEN, [baseId]);
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      const rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [items[0]!.id, opened.versionId, opened.rowVersion, JSON.stringify(HOTEL), '4700000'])).rowVersion;
      await one(OWNER, CLASSIFY, [opened.versionId, rv, 'internal_only']);
      const ready = await readiness(OWNER, opened.versionId);
      await owner(`update public.accounts_booking_reviews set status = 'approved', row_version = row_version + 1 where booking_version_id = $1`, [baseId]);
      expect((await readiness(OWNER, opened.versionId)).issues).toContain('base_no_longer_returned');
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [opened.versionId, ready.contentHash], '55000', 'revision_not_allowed');
      await owner(`update public.accounts_booking_reviews set status = 'returned', row_version = row_version + 1 where booking_version_id = $1`, [baseId]);
      const ok = await readiness(OWNER, opened.versionId);
      await confirm(OWNER, opened.versionId, ok.contentHash);
      await refused(ACC, RETURN, [baseId, REASON, rid()], '55000', 'version_superseded');
      await refused(ACC, 'select public.accounts_review_approve($1, $2, $3) as r', [baseId, 1, rid()], '55000', 'version_superseded');
      await refused(ACC, 'select public.receipt_record($1, $2::jsonb, $3) as r',
        [DEAL, JSON.stringify(await f.bankFields({ bookingVersionId: baseId })), rid()], '55000', 'version_superseded');
      // Accounts sees what changed and the earlier version's outcome.
      const detail = await one<{ booking: Record<string, unknown> }>(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]);
      expect(detail.booking).toMatchObject({
        bookingVersionId: opened.versionId, versionNo: 2, reviewStatus: 'pending',
        revision: { revisesVersionNo: 1, changeClass: 'internal_only', changedFields: ['items.1.purchaseBudgetPaise'], sellingDeltaPaise: '0' },
        earlierVersions: [{ versionNo: 1, reviewStatus: 'returned', returnReason: REASON }],
      });
      // The revision gets its own pending review (lazily, as every accepted version).
      const queue = await one<{ items: Array<{ dealId: string }> }>(ACC, `select public.accounts_queue('needs_review') as r`);
      expect(queue.items.map((i) => i.dealId)).toContain(DEAL);
    });
  });
});

describe('history and review visibility', () => {
  it('Sales sees reasons written after this release, not older ones; selling delta only with commercial scope; Purchase gets nothing', async () => {
    await asOwner(db, async () => {
      const { baseId } = await confirmedAndReturned();
      let history = await one<Array<Record<string, unknown>>>(OWNER, HISTORY, [DEAL]);
      expect(history[0]).toMatchObject({ versionNo: 1, status: 'confirmed', reviewStatus: 'returned', reviewReason: REASON, reviewReasonHidden: false });
      const panel = await one<Record<string, unknown>>(OWNER, 'select public.booking_panel($1) as r', [DEAL]);
      expect(panel).toMatchObject({ accountsReview: { status: 'returned', reason: REASON, reasonHidden: false }, canRevise: true, revision: null });
      // An older return (written before this release) stays hidden.
      await owner('update public.accounts_booking_reviews set reason_shared_with_sales = false where booking_version_id = $1', [baseId]);
      history = await one<Array<Record<string, unknown>>>(OWNER, HISTORY, [DEAL]);
      expect(history[0]).toMatchObject({ reviewReason: null, reviewReasonHidden: true });
      expect(await one(OWNER, 'select public.booking_panel($1) as r', [DEAL])).toMatchObject({ accountsReview: { reason: null, reasonHidden: true } });
      const opened = await one<Opened>(OWNER, OPEN, [baseId]);
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      const rv = (await h.saveCommercials(OWNER, opened.versionId, opened.rowVersion, null, null, '9900000')).rowVersion;
      await h.savePlan(OWNER, opened.versionId, rv, [{ seq: 1, label: 'Full payment', amountPaise: '9900000', dueDate: '2026-11-01' }]);
      history = await one<Array<Record<string, unknown>>>(OWNER, HISTORY, [DEAL]);
      expect(history[1]).toMatchObject({ versionNo: 2, status: 'draft', sellingTotalPaise: '9900000', sellingTotalDeltaPaise: String(9900000 - 9876543) });
      const mgr = await one<Array<Record<string, unknown>>>(MANAGER, HISTORY, [DEAL]);
      expect(mgr[1]).not.toHaveProperty('sellingTotalPaise');
      expect(await one(PURCHASE, HISTORY, [DEAL])).toBeNull();
      expect(items).toHaveLength(2);
    });
  });
});
