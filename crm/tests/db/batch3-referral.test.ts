import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, DEAL, MANAGER, MANAGER_AMD, OWNER, PURCHASE, REASON, SALES_AMD, SALES_B, SETTING_SQL, SETTINGS_GET_SQL, SUPER, rid } from './b1-support';
import { DESK } from './b11-support';
import { rpcAs } from './b12-ts-support';
import { B3, CUSTOMER, type DraftView, batch3Helpers } from './batch3-support';

/**
 * Batch 3 (migration 20261123000100): referral drafts (contracts.md B as
 * amended by F.3, F.5a, F.6), audited linking and binding, the scoped
 * Quotations / Itineraries lists and the FP-081 Home rows. Contract tests
 * B.7 and F.3.4 1-4, 8-12, 14 (the two-session cases 5, 6, 7, 13 and 15 run
 * on real Postgres in batch3-referral-race.test.ts). Synthetic fixtures only;
 * every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = batch3Helpers(() => db);
const { one, refused, refusedWithHint, owner } = h;
const FLIGHT_ONLY: Actor = { userId: U.visaJodhpur };

type Got = { subject: Record<string, unknown>; referral: Record<string, unknown> | null; canEdit: boolean; money?: unknown;
  prefill: unknown; version: { status: string; rowVersion: number; contentHash: string | null } };

describe('schema, privileges and the switch', () => {
  it('new tables are RLS-protected with no API privilege; internals are not callable; the job is service_role only', async () => {
    await asOwner(db, async () => {
      for (const t of ['referral_draft_counters', 'referral_drafts', 'referral_draft_links']) {
        const [r] = await owner<{ rls: boolean; auth: boolean; svc: boolean }>(
          `select c.relrowsecurity as rls, has_table_privilege('authenticated', c.oid, 'select') as auth,
                  has_table_privilege('service_role', c.oid, 'select') as svc from pg_class c where c.oid = ('public.' || $1)::regclass`, [t]);
        expect(r, t).toEqual({ rls: true, auth: false, svc: false });
      }
      const fns = await owner<{ name: string; auth: boolean; anon: boolean; svc: boolean }>(
        `select p.oid::regprocedure::text as name, has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname = 'authz' and (p.proname like 'referral%' or p.proname in ('work_quotation_rows', 'work_itinerary_rows',
                  'quotation_bitrix_subject', 'provision_referral_close_job')))
            or (n.nspname = 'public' and (p.proname like 'referral%' or p.proname in ('work_drafts_list', 'quotation_create_standalone',
                  'itinerary_create_standalone')))`);
      expect(fns.length).toBeGreaterThan(30);
      for (const f of fns) {
        expect(f.anon, f.name).toBe(false);
        if (f.name.startsWith('authz.')) expect(f.auth || f.svc, f.name).toBe(false);
        else if (f.name.startsWith('referral_drafts_close_inactive')) expect([f.auth, f.svc], f.name).toEqual([false, true]);
        else expect([f.auth, f.svc], f.name).toEqual([true, false]);
      }
    });
  });

  it('exactly one subject, even for the table owner; deletes and truncates are refused', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      await db.exec('savepoint subj');
      await expect(owner(`update public.quotations set deal_id = $2 where id = $1`, [s.quotationId, DEAL])).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint subj');
      await expect(owner(
        `insert into public.quotations (legal_entity_id, branch_id, quote_no, reference, lead_id, deal_id, referral_draft_id, title, request_id, created_by)
         select q.legal_entity_id, q.branch_id, 99999, 'TQ-99999', null, null, null, 'X', gen_random_uuid(), q.created_by
         from public.quotations q where q.id = $1`, [s.quotationId])).rejects.toMatchObject({ code: '23514' });
      await db.exec('rollback to savepoint subj');
      await expect(owner(
        `insert into public.itinerary_documents (legal_entity_id, branch_id, quotation_id, referral_draft_id, title, request_id, created_by)
         select q.legal_entity_id, q.branch_id, q.id, q.referral_draft_id, 'X', gen_random_uuid(), q.created_by
         from public.quotations q where q.id = $1`, [s.quotationId])).rejects.toMatchObject({ code: '23514' });
      await db.exec('rollback to savepoint subj');
      await expect(owner('delete from public.referral_drafts where id = $1', [s.referralDraftId])).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint subj');
      await expect(owner('truncate public.referral_draft_links')).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint subj');
      await expect(owner(`update public.referral_drafts set reference = 'TD-77' where id = $1`, [s.referralDraftId])).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint subj');
    });
  });

  it('F.3.4-14: the switch command and direct SQL both restart the clock and audit referral_drafts', async () => {
    await asOwner(db, async () => {
      expect(await one(OWNER, SETTINGS_GET_SQL)).toMatchObject({ referralDrafts: false });
      const on = await one<{ changed: boolean; after: boolean }>(SUPER, SETTING_SQL, ['referral_drafts', true, REASON]);
      expect(on).toMatchObject({ changed: true, after: true });
      const [s] = await owner<{ resumed: boolean }>(`select referral_auto_close_resumed_at = now() as resumed from public.workflow_settings where id`);
      expect(s!.resumed).toBe(true);
      const audit = await owner<{ details: { via: string; changes: Record<string, unknown> } }>(
        `select details from public.audit_events where action = 'settings.workflow_changed' order by id desc limit 1`);
      expect(Object.keys(audit[0]!.details.changes).sort()).toEqual(['referral_auto_close_resumed_at', 'referral_drafts']);
      expect(audit[0]!.details.via).toBe('command');
      await refused(OWNER, SETTING_SQL, ['referral_drafts', false, REASON], '42501');
      // Direct owner SQL: off, then on again.
      await owner(`update public.workflow_settings set referral_drafts = false, referral_auto_close_resumed_at = now() - interval '9 days' where id`);
      await h.referralSwitch(true);
      const [again] = await owner<{ resumed: boolean }>(`select referral_auto_close_resumed_at = now() as resumed from public.workflow_settings where id`);
      expect(again!.resumed).toBe(true);
      const last = await owner<{ details: { via: string; changes: Record<string, unknown> } }>(
        `select details from public.audit_events where action = 'settings.workflow_changed' order by id desc limit 1`);
      expect(last[0]!.details).toMatchObject({ via: 'direct_sql', changes: { referral_drafts: { from: false, to: true } } });
      // N1: every earlier column is still audited.
      const [trigger] = await owner<{ def: string }>(`select pg_get_triggerdef(t.oid) as def from pg_trigger t
        where t.tgrelid = 'public.workflow_settings'::regclass and t.tgname = 'workflow_settings_audit'`);
      for (const col of ['intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled', 'prefill_auto_fill', 'referral_drafts',
        'referral_auto_close_resumed_at']) expect(trigger!.def).toContain(`'${col}'`);
    });
  });
});

describe('creating standalone drafts (B.4)', () => {
  it('switch off refuses creation after authorization; on creates draft + version 1 in one step, replay-safe', async () => {
    await asOwner(db, async () => {
      const del = await h.branchId('DEL');
      await refused(PURCHASE, B3.qStandalone, [del, JSON.stringify(CUSTOMER), 'X', rid()], '42501', 'not_authorized');
      await refused(OWNER, B3.qStandalone, [del, JSON.stringify(CUSTOMER), 'X', rid()], '55000', 'referral_drafts_disabled');
      await refused(OWNER, B3.iStandalone, [del, JSON.stringify(CUSTOMER), 'X', rid()], '55000', 'referral_drafts_disabled');
      await h.referralSwitch(true);
      const req = rid();
      const s = await h.standalone(OWNER, CUSTOMER, 'DEL', 'Synthetic referral quote', req);
      expect(s).toMatchObject({ referralReference: 'TD-1', versionNo: 1, created: true, possibleDuplicates: [] });
      expect(s.reference).toMatch(/^TQ-\d+$/);
      const replay = await h.standalone(OWNER, CUSTOMER, 'DEL', 'Synthetic referral quote', req);
      expect(replay).toMatchObject({ referralDraftId: s.referralDraftId, quotationId: s.quotationId, versionId: s.versionId, created: false });
      await refused(OWNER, B3.qStandalone, [del, JSON.stringify({ ...CUSTOMER, customerName: 'Someone else' }), 'Synthetic referral quote', req],
        '40001', 'request_conflict');
      const [row] = await owner<Record<string, unknown>>(
        `select r.owner_user_id, r.created_by, r.branch_id, r.status, q.referral_draft_id, q.lead_id, q.deal_id, q.owner_user_id as q_owner,
                c.contact_name, c.mobile
         from public.referral_drafts r join public.quotations q on q.referral_draft_id = r.id
         left join public.quotation_version_contacts c on c.quotation_version_id = $2 where r.id = $1`, [s.referralDraftId, s.versionId]);
      expect(row).toMatchObject({ owner_user_id: U.salesDelhiA, created_by: U.salesDelhiA, branch_id: del, status: 'open',
        referral_draft_id: s.referralDraftId, lead_id: null, deal_id: null, q_owner: U.salesDelhiA,
        contact_name: 'Synthetic Walk-in Customer', mobile: '9876500101' });
      // Creation history: the typed mobile counts as a staff write (F.1.1); audit ids only.
      expect(await owner(`select field_code from public.prefill_field_history where target_id = $1 order by field_code`, [s.versionId]))
        .toEqual([{ field_code: 'contacts.contactName' }, { field_code: 'contacts.mobile' }]);
      const [audit] = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'referral.draft_created' and target_id = $1`, [s.referralDraftId]);
      expect(JSON.stringify(audit!.details)).not.toMatch(/9876500101|Walk-in/);
      // Inputs: refused keys named in the hint.
      await refusedWithHint(OWNER, B3.qStandalone, [del, JSON.stringify({ customerName: '', mobile: '12345', colour: 'x' }), ' ', rid()],
        /^colour,customerName,mobile,title$/);
      // Duplicate hint: only drafts the caller can already open.
      const second = await h.standalone(OWNER);
      expect(second.possibleDuplicates).toEqual([{ reference: 'TD-1' }]);
      expect((await h.standalone(SALES_B)).possibleDuplicates).toEqual([]);
    });
  });

  it('standalone itinerary: a draft and a document without a quotation; basis none', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const it = await h.standaloneItinerary();
      expect(it).toMatchObject({ referralReference: 'TD-1', created: true });
      expect(await owner('select count(*)::int as n from public.quotations where referral_draft_id = $1', [it.referralDraftId])).toEqual([{ n: 0 }]);
      const doc = await one<{ subject: Record<string, unknown>; basis: { kind: string }; referral: Record<string, unknown>; money: unknown }>(
        OWNER, B3.iGet, [it.documentId]);
      expect(doc.subject).toMatchObject({ kind: 'referral', referralDraftId: it.referralDraftId, quotationId: null, dealId: null });
      expect(doc.basis.kind).toBe('none');
      expect(doc.money).toBeNull();
      expect(doc.referral).toMatchObject({ referralDraftId: it.referralDraftId, status: 'open', linked: false });
      expect(await one(OWNER, B3.iList, ['referral', it.referralDraftId])).toMatchObject([{ documentId: it.documentId, subjectKind: 'referral' }]);
      // Add a quotation to the same draft (subject kind referral).
      const q = await one<{ autoFill: string; created: boolean }>(OWNER, B3.qCreate, ['referral', it.referralDraftId, 'Second quote', rid()]);
      expect(q).toMatchObject({ created: true, autoFill: 'unavailable' });
      expect((await h.draft(OWNER, it.referralDraftId))!.quotations).toHaveLength(1);
    });
  });
});

describe('access (B.3) and money (M3)', () => {
  it('role matrix: owner and branch Manager only; never other Sales, other branches, Purchase, Accounts, Flight, Visa or Super Admin', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.addRole(U.accountsJodhpur, 'accounts', 'DEL');
      await h.addFlight(U.visaJodhpur, 'DEL');
      const s = await h.standalone();
      const it = await h.standaloneItinerary();
      expect(await h.draft(OWNER, s.referralDraftId)).toMatchObject({ ownerIsYou: true, can: { edit: true, close: true, reassign: false } });
      expect(await h.draft(MANAGER, s.referralDraftId)).toMatchObject({ ownerIsYou: false, can: { edit: true, close: true, reassign: true } });
      for (const [actor, label] of [[SALES_B, 'other sales'], [SALES_AMD, 'other branch sales'], [MANAGER_AMD, 'other branch manager'],
        [PURCHASE, 'purchase'], [ACCOUNTS, 'accounts'], [FLIGHT_ONLY, 'flight+visa'], [DESK, 'desk'], [SUPER, 'super admin']] as const) {
        await h.expectNull(actor, B3.get, [s.referralDraftId], label);
        await h.expectNull(actor, B3.qGet, [s.versionId], label);
        await h.expectNull(actor, B3.iGet, [it.documentId], label);
        await refused(actor, B3.draftSave, [s.referralDraftId, 1, JSON.stringify({ companyName: 'X' })], '42501', 'not_authorized');
        await refused(actor, B3.qSave, [s.versionId, s.rowVersion, JSON.stringify({ adults: 2 })], '42501', 'not_authorized');
        expect((await h.list(actor, 'quotations', { scope: 'all' })).rows ?? [], label).toEqual([]);
      }
      for (const actor of [PURCHASE, SUPER, DESK]) {
        await refused(actor, B3.qStandalone, [await h.branchId('DEL'), JSON.stringify(CUSTOMER), 'X', rid()], '42501', 'not_authorized');
      }
      await refused(ANON, B3.get, [s.referralDraftId], '42501');
      // A creator who later holds Purchase in the entity loses access.
      await h.addRole(U.salesDelhiA, 'purchase', 'DEL');
      await h.expectNull(OWNER, B3.get, [s.referralDraftId], 'owner with purchase');
    });
  });

  it('M3: owner sees prices; Manager without a grant sees the draft but no prices; with a branch grant sees them; after binding the Deal team does', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      const acc = await h.acceptedReferral();
      expect(await one<Got>(OWNER, B3.qGet, [acc.versionId])).toHaveProperty('money');
      const mgr = await one<Got>(MANAGER, B3.qGet, [acc.versionId]);
      expect(mgr.subject).toMatchObject({ kind: 'referral' });
      expect(mgr).not.toHaveProperty('money');
      // Deal team member (assignee) through an active link: opens it, no prices before binding.
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980201);
      await h.addSalesAssignee(deal, U.salesDelhiB);
      await h.linkDeal(OWNER, acc.referralDraftId, deal);
      const team = await one<Got>(SALES_B, B3.qGet, [acc.versionId]);
      expect(team).not.toBeNull();
      expect(team).not.toHaveProperty('money');
      const q = (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [acc.quotationId]))[0]!;
      await one(OWNER, B3.qBind, [acc.quotationId, deal, q.row_version]);
      expect(await one<Got>(SALES_B, B3.qGet, [acc.versionId])).toHaveProperty('money');
      await h.grantCommercial(U.managerDelhi);
      expect(await one<Got>(MANAGER, B3.qGet, [acc.versionId])).toHaveProperty('money');
    });
  });

  it('A5 creator keeps access after linking to another salesperson\'s Deal; ending the link removes the Deal team at once', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980202);
      await owner('update public.deals set owner_user_id = $2 where id = $1', [deal, U.salesDelhiB]);
      // OWNER cannot edit SALES_B's Deal: not_authorized; the Manager can edit both.
      await refused(OWNER, B3.link, [s.referralDraftId, 1, 'deal', deal, null], '42501', 'not_authorized');
      const link = await h.linkDeal(MANAGER, s.referralDraftId, deal);
      expect(await h.draft(SALES_B, s.referralDraftId)).not.toBeNull();
      expect(await h.draft(OWNER, s.referralDraftId)).not.toBeNull();
      expect(await one(SALES_B, B3.forSubject, ['deal', deal])).toMatchObject([{ referralDraftId: s.referralDraftId, ownerIsYou: false, ownerName: null }]);
      await refused(SALES_B, B3.unlink, [link.linkId, link.rowVersion, 'wrong_link', 'Synthetic: wrong customer linked'], '42501', 'not_authorized');
      await refusedWithHint(OWNER, B3.unlink, [link.linkId, link.rowVersion, 'wrong_link', 'short'], /^note$/);
      const ended = await one<{ ended: boolean; rowVersion: number }>(OWNER, B3.unlink,
        [link.linkId, link.rowVersion, 'wrong_link', 'Synthetic: wrong customer linked']);
      expect(ended.ended).toBe(true);
      await h.expectNull(SALES_B, B3.get, [s.referralDraftId], 'deal team after unlink');
      expect(await owner('select end_reason, ended_by from public.referral_draft_links where id = $1', [link.linkId]))
        .toEqual([{ end_reason: 'wrong_link', ended_by: U.salesDelhiA }]);
    });
  });
});

describe('Echo-A review fixes and Mercury F1/F24', () => {
  it('M1: bound or converted drafts never take a job batch slot; the due unbound draft closes', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.resumedDaysAgo(400);
      const bound = [await h.standalone(), await h.standalone(), await h.standalone()];
      for (const b of bound) {
        await owner('update public.quotations set converted_at = now() where id = $1', [b.quotationId]);
        await h.age(b.referralDraftId, 300);
      }
      const due = await h.standalone();
      await h.age(due.referralDraftId, 120);
      expect(await h.job(2)).toEqual({ closed: 1, skipped: null });
      expect((await h.draftRow(due.referralDraftId)).status).toBe('closed');
      for (const b of bound) expect((await h.draftRow(b.referralDraftId)).status).toBe('open');
    });
  });

  it('M2: a draft document compares only with the draft\'s own accepted quotation, never the linked Deal; both states can be checked and finalised', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      const s = await h.standalone();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980501);
      const dq = await one<{ versionId: string; rowVersion: number }>(OWNER, B3.qCreate, ['deal', deal, 'Synthetic deal quote', rid()]);
      await h.accept(OWNER, dq.versionId, await h.sendQuote(OWNER, dq.versionId, dq.rowVersion));
      await h.linkDeal(OWNER, s.referralDraftId, deal);
      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, B3.iCreate,
        ['referral', s.referralDraftId, 'Synthetic draft itinerary', rid()]);
      const facts = {
        destination: 'Synthetic City', startDate: '2026-12-20', endDate: '2026-12-23',
        party: { adults: 2, children: 0, childAges: [], infants: 0 },
        stays: [{ city: 'Synthetic City', nights: 3, checkIn: '2026-12-20', checkOut: '2026-12-23', hotelName: 'Synthetic Hotel (fixture)',
          roomType: null, mealPlan: 'Breakfast', rooms: 1 }],
        days: [{ n: 1, date: '2026-12-20', base: 'Synthetic City', title: 'Arrival', story: 'Synthetic arrival day.', highlights: ['Check-in'],
          meals: null }],
        transfers: [], activities: [], flights: [], inclusions: ['Breakfast'], exclusions: ['Lunch'],
      };
      type Doc = { basis: { kind: string; id: string | null; hash: string }; draft: { rowVersion: number } };
      // Linked Deal with its own accepted quotation: still nothing to compare with (honest state).
      expect((await one<Doc>(OWNER, B3.iGet, [doc.documentId])).basis.kind).toBe('none');
      let rv = (await one<{ rowVersion: number }>(OWNER, B3.iFacts, [doc.draftId, doc.rowVersion, JSON.stringify(facts), null])).rowVersion;
      let g = await one<Doc>(OWNER, B3.iGet, [doc.documentId]);
      await one(OWNER, 'select public.itinerary_differences_save($1, $2, $3, $4, $5, $6::jsonb) as r',
        [doc.draftId, rv, g.basis.kind, g.basis.id, g.basis.hash, '[]']);
      rv = (await one<{ rowVersion: number }>(OWNER, 'select public.itinerary_facts_mark_ready($1, $2) as r', [doc.draftId, rv])).rowVersion;
      expect(await one(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [doc.documentId, 'final', 'c'.repeat(64), 'v1']))
        .toMatchObject({ outcome: 'created' });
      // The draft's own accepted quotation becomes the basis; the server-side check reads it (the owner can).
      const own = await one<{ versionId: string }>(OWNER, B3.qCreate, ['referral', s.referralDraftId, 'Own quote', rid()]);
      const ownRv = (await owner<{ row_version: number }>('select row_version from public.quotation_versions where id = $1', [own.versionId]))[0]!.row_version;
      await h.accept(OWNER, own.versionId, await h.sendQuote(OWNER, own.versionId, ownRv));
      const doc2 = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, B3.iCreate,
        ['referral', s.referralDraftId, 'Synthetic draft itinerary 2', rid()]);
      g = await one<Doc>(OWNER, B3.iGet, [doc2.documentId]);
      expect(g.basis).toMatchObject({ kind: 'quotation_version', id: own.versionId });
      const { computeItineraryDifferences } = await import('@/modules/documents/server/itinerary');
      const staff = { supabase: rpcAs(() => db, OWNER), access: { memberships: [], grants: [] } } as never;
      rv = (await one<{ rowVersion: number }>(OWNER, B3.iFacts, [doc2.draftId, doc2.rowVersion, JSON.stringify(facts), null])).rowVersion;
      const diff = await computeItineraryDifferences(staff, doc2.documentId);
      expect(diff).toMatchObject({ status: 'ok', basisKind: 'quotation_version', basisId: own.versionId });
      if (diff.status !== 'ok') throw new Error('unreachable');
      const saved = await one<{ runId: string }>(OWNER, 'select public.itinerary_differences_save($1, $2, $3, $4, $5, $6::jsonb) as r',
        [doc2.draftId, rv, diff.basisKind, diff.basisId, diff.basisHash, JSON.stringify(diff.differences)]);
      expect(saved).toBeTruthy();
    });
  });

  it('L1 + L2: replays answer before the row-version check and do not count as activity; a real write does', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone(OWNER, CUSTOMER, 'DEL', 'Synthetic referral quote', 'b0000000-0000-4000-8000-0000000000b1');
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980502);
      const link = await h.linkDeal(OWNER, s.referralDraftId, deal);
      await h.age(s.referralDraftId, 10);
      const aged = (await h.draftRow(s.referralDraftId)).last_activity_at;
      expect(await one(OWNER, B3.link, [s.referralDraftId, 1, 'deal', deal, null])).toMatchObject({ existing: true, linkId: link.linkId });
      expect(await one(MANAGER, B3.reassign, [s.referralDraftId, 1, U.salesDelhiA, 'Synthetic handover reason']))
        .toMatchObject({ changed: false });
      await one(OWNER, B3.qStandalone, [await h.branchId('DEL'), JSON.stringify(CUSTOMER), 'Synthetic referral quote',
        'b0000000-0000-4000-8000-0000000000b1']);
      expect((await h.draftRow(s.referralDraftId)).last_activity_at).toBe(aged);
      await one(OWNER, B3.qSave, [s.versionId, s.rowVersion, JSON.stringify({ adults: 2 })]);
      expect((await h.draftRow(s.referralDraftId)).last_activity_at).not.toBe(aged);
      const ended = await one<{ rowVersion: number }>(OWNER, B3.unlink, [link.linkId, (await h.draftRow(s.referralDraftId)).row_version,
        'wrong_link', 'Synthetic wrong customer']);
      expect(await one(OWNER, B3.unlink, [link.linkId, 1, 'wrong_link', 'Synthetic wrong customer']))
        .toEqual({ linkId: link.linkId, ended: true, rowVersion: ended.rowVersion });
    });
  });

  it('F1 + F24 + L4: ready to book vs accepted not linked; the draft link reference; owner name and You marker name the same owner', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      const acc = await h.acceptedReferral();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980503);
      await h.linkDeal(OWNER, acc.referralDraftId, deal);
      const ref = (await owner<{ reference: string }>('select reference from public.deals where id = $1', [deal]))[0]!.reference;
      const page = await h.list(OWNER, 'quotations', { scope: 'all', status: 'ready_to_book' });
      expect(page.rows).toMatchObject([{ quotationId: acc.quotationId, readyToBook: true, acceptedNotLinked: false,
        draftLink: { kind: 'deal', reference: ref } }]);
      expect(page.counts).toMatchObject({ accepted_not_linked: 0, ready_to_book: 1 });
      expect((await one<{ acceptedQuotesToLink: number }>(OWNER, B3.myCounts)).acceptedQuotesToLink).toBe(0);
      expect((await one<{ rows: unknown[] }>(OWNER, B3.myList, ['accepted_to_link', null, 50])).rows).toHaveLength(0);
      // F24: a Deal quotation the Manager made on OWNER's Deal names OWNER for both.
      const mq = await one<{ quotationId: string }>(MANAGER, B3.qCreate, ['deal', DEAL, 'Manager-made quote', rid()]);
      const asOwnerRow = (await h.list(OWNER, 'quotations', { scope: 'all' })).rows!.find((r) => r.quotationId === mq.quotationId)!;
      const asMgrRow = (await h.list(MANAGER, 'quotations', { scope: 'all' })).rows!.find((r) => r.quotationId === mq.quotationId)!;
      expect(asOwnerRow).toMatchObject({ ownerIsYou: true });
      expect(asMgrRow).toMatchObject({ ownerIsYou: false, ownerName: asOwnerRow.ownerName });
      expect(asOwnerRow.ownerName).not.toBeNull();
      // L4: a Lead quotation bound to a Deal: the Deal's assignee (who cannot open the Lead) sees no Lead owner name.
      const lead = await h.insertLead(8301);
      const lq = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, B3.qCreate, ['lead', lead, 'Lead quote', rid()]);
      await h.accept(OWNER, lq.versionId, await h.sendQuote(OWNER, lq.versionId, lq.rowVersion));
      const ldeal = await h.insertRealDeal('UC_AD0SLH', 0, 980504);
      await owner('update public.deals set source_lead_id = 8301 where id = $1', [ldeal]);
      const qrv = (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [lq.quotationId]))[0]!.row_version;
      await one(OWNER, B3.qBind, [lq.quotationId, ldeal, qrv]);
      await h.addSalesAssignee(ldeal, U.salesDelhiB);
      const bRow = (await h.list(SALES_B, 'quotations', { scope: 'all' })).rows!.find((r) => r.quotationId === lq.quotationId)!;
      expect(bRow).toMatchObject({ subjectKind: 'lead', ownerName: null, ownerIsYou: false });
    });
  });

  it('L6: duplicate hints use the effective state; a draft document stays in the draft\'s branch', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.resumedDaysAgo(400);
      const old = await h.standalone(OWNER, { customerName: 'Synthetic Old', mobile: '9876500201' });
      await h.age(old.referralDraftId, 200);
      expect((await h.standalone(OWNER, { customerName: 'Synthetic New', mobile: '9876500201' })).possibleDuplicates).toEqual([]);
      await db.exec('savepoint l6');
      await expect(owner(
        `insert into public.itinerary_documents (legal_entity_id, branch_id, referral_draft_id, title, request_id, created_by)
         select r.legal_entity_id, b.id, r.id, 'X', gen_random_uuid(), r.created_by
         from public.referral_drafts r join public.branches b on b.legal_entity_id = r.legal_entity_id and b.id <> r.branch_id
         where r.id = $1 limit 1`, [old.referralDraftId])).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint l6');
    });
  });
});

describe('Echo-B M5: quotation_list for a referral draft', () => {
  it('the draft editors get every quotation with all versions (latest first); everyone else null; owner in the editor summary', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      const hash = await h.sendQuote(OWNER, s.versionId, s.rowVersion);
      void hash;
      const v2 = await one<{ versionId: string; versionNo: number; created: boolean }>(OWNER, B3.qNewVersion, [s.quotationId, s.versionId, rid()]);
      expect(v2).toMatchObject({ versionNo: 2, created: true });
      const second = await one<{ quotationId: string }>(OWNER, B3.qCreate, ['referral', s.referralDraftId, 'Second referral quote', rid()]);
      type Row = { quotationId: string; subjectKind: string; referralDraftId: string; versions: Array<{ versionId: string; versionNo: number; status: string }> };
      for (const actor of [OWNER, MANAGER]) {
        const rows = await one<Row[]>(actor, B3.qList, ['referral', s.referralDraftId]);
        expect(rows.map((r) => r.quotationId).sort()).toEqual([s.quotationId, second.quotationId].sort());
        const first = rows.find((r) => r.quotationId === s.quotationId)!;
        expect(first).toMatchObject({ subjectKind: 'referral', referralDraftId: s.referralDraftId });
        // The older version links to the latest one (version 2, first in the list).
        expect(first.versions.map((v) => [v.versionNo, v.status])).toEqual([[2, 'draft'], [1, 'sent']]);
        expect(first.versions[0]!.versionId).toBe(v2.versionId);
        expect(JSON.stringify(rows)).not.toMatch(/Paise|money|margin/i);
      }
      await h.addRole(U.accountsJodhpur, 'accounts', 'DEL');
      for (const [actor, label] of [[SALES_B, 'other sales'], [SALES_AMD, 'other branch'], [PURCHASE, 'purchase'], [ACCOUNTS, 'accounts'],
        [FLIGHT_ONLY, 'flight+visa'], [DESK, 'desk'], [SUPER, 'super admin']] as const) {
        await h.expectNull(actor, B3.qList, ['referral', s.referralDraftId], label);
      }
      await refused(ANON, B3.qList, ['referral', s.referralDraftId], '42501');
      // Closed drafts stay listable for their editors (read-only).
      await one(OWNER, B3.close, [s.referralDraftId, (await h.draftRow(s.referralDraftId)).row_version, 'lost', null]);
      expect(await one<Row[]>(MANAGER, B3.qList, ['referral', s.referralDraftId])).toHaveLength(2);
      // Owner in the editor summary (name only for the owner or the branch Manager).
      const own = await one<Got>(OWNER, B3.qGet, [s.versionId]);
      expect(own.referral).toMatchObject({ ownerIsYou: true, ownerName: expect.any(String) });
      expect((await one<Got>(MANAGER, B3.qGet, [s.versionId])).referral).toMatchObject({ ownerIsYou: false, ownerName: expect.any(String) });
    });
  });
});

describe('lead ruling Q1: removing a link never requires reopening', () => {
  it('owner or Manager unlinks on a closed or due draft; it stays closed, last activity unchanged; link_locked after binding', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980401);
      await h.addSalesAssignee(deal, U.salesDelhiB);
      const link = await h.linkDeal(OWNER, s.referralDraftId, deal);
      const closed = await one<{ rowVersion: number }>(OWNER, B3.close, [s.referralDraftId, link.rowVersion, 'lost', null]);
      expect(await h.draft(SALES_B, s.referralDraftId)).toMatchObject({ status: 'closed' });
      expect((await h.draft(OWNER, s.referralDraftId))!).toMatchObject({ can: { unlink: true }, links: [{ canRemove: true }] });
      const before = await h.draftRow(s.referralDraftId);
      await refused(SALES_B, B3.unlink, [link.linkId, closed.rowVersion, 'wrong_link', 'Synthetic wrong customer'], '42501', 'not_authorized');
      const ended = await one<{ ended: boolean; rowVersion: number }>(OWNER, B3.unlink,
        [link.linkId, closed.rowVersion, 'wrong_link', 'Synthetic wrong customer']);
      expect(ended).toEqual({ linkId: link.linkId, ended: true, rowVersion: closed.rowVersion + 1 });
      const after = await h.draftRow(s.referralDraftId);
      expect(after).toMatchObject({ status: 'closed', closed_reason: 'lost', last_activity_at: before.last_activity_at });
      await h.expectNull(SALES_B, B3.get, [s.referralDraftId], 'deal team after unlink on a closed draft');
      expect(await h.auditCount('referral.draft_reopened')).toBe(0);

      // A due (effectively closed) draft: the Manager unlinks; no closure is persisted, nothing reopens.
      await h.resumedDaysAgo(200);
      const d = await h.standalone();
      const l2 = await h.linkDeal(MANAGER, d.referralDraftId, deal);
      await h.age(d.referralDraftId, 120);
      expect((await h.draft(MANAGER, d.referralDraftId))!.status).toBe('closed');
      await one(MANAGER, B3.unlink, [l2.linkId, l2.rowVersion, 'duplicate', 'Synthetic duplicate link']);
      expect(await h.draftRow(d.referralDraftId)).toMatchObject({ status: 'open', closed_reason: null });
      expect(await owner('select count(*)::int as n from public.audit_events where target_id = $1 and action = $2',
        [d.referralDraftId, 'referral.draft_closed'])).toEqual([{ n: 0 }]);

      // Bound, then closed by hand: still link_locked.
      await h.setSwitch('service_items_enabled', true);
      const acc = await h.acceptedReferral(OWNER, { customerName: 'Synthetic Bound Closed' });
      const deal2 = await h.insertRealDeal('UC_AD0SLH', 0, 980402);
      const l3 = await h.linkDeal(OWNER, acc.referralDraftId, deal2);
      const qrv = (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [acc.quotationId]))[0]!.row_version;
      await one(OWNER, B3.qBind, [acc.quotationId, deal2, qrv]);
      const c3 = await one<{ rowVersion: number }>(OWNER, B3.close, [acc.referralDraftId, (await h.draftRow(acc.referralDraftId)).row_version, 'other', null]);
      await refused(OWNER, B3.unlink, [l3.linkId, c3.rowVersion, 'wrong_link', 'Synthetic wrong link note'], '55000', 'link_locked');
      expect((await h.draft(OWNER, acc.referralDraftId))!).toMatchObject({ can: { unlink: false }, links: [{ canRemove: false }] });
    });
  });
});

describe('linking and binding (B.5)', () => {
  it('no automatic link on matching contact details; link refusals', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone(OWNER, { customerName: 'Synthetic Match', mobile: '9876500033' });
      expect(await owner('select count(*)::int as n from public.referral_draft_links')).toEqual([{ n: 0 }]);
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980203);
      // deal_removed
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [deal]);
      await refused(OWNER, B3.link, [s.referralDraftId, 1, 'deal', deal, null], '55000', 'deal_removed');
      await owner('update public.deals set removed_at = null, removed_reason = null where id = $1', [deal]);
      // deal_not_active
      await owner(`update public.deals set source_stage_id = 'LOSE' where id = $1`, [deal]);
      await refused(OWNER, B3.link, [s.referralDraftId, 1, 'deal', deal, null], '55000', 'deal_not_active');
      await owner(`update public.deals set source_stage_id = 'UC_AD0SLH' where id = $1`, [deal]);
      // branch_mismatch: a Manager of both branches.
      await h.addRole(U.managerDelhi, 'manager', 'AMD');
      await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
                   select $1, b.legal_entity_id, b.id, 'deal.read', $2, 'Synthetic branch read grant' from public.branches b
                   join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'AMD'`,
        [U.managerDelhi, U.adminJodhpur]);
      const amdDeal = await h.insertRealDeal('UC_AD0SLH', 0, 980210);
      await owner('update public.deals set branch_id = $2, owner_user_id = $3 where id = $1', [amdDeal, await h.branchId('AMD'), U.salesAhmedabad]);
      await refused(MANAGER, B3.link, [s.referralDraftId, 1, 'deal', amdDeal, null], '22023', 'branch_mismatch');
      // version_changed, then a good link and draft_already_linked.
      await refused(OWNER, B3.link, [s.referralDraftId, 9, 'deal', deal, null], '40001', 'version_changed');
      const link = await h.linkDeal(OWNER, s.referralDraftId, deal);
      expect(link.existing).toBe(false);
      expect((await h.linkDeal(OWNER, s.referralDraftId, deal)).existing).toBe(true);
      const other = await h.insertRealDeal('UC_AD0SLH', 0, 980204);
      await refused(OWNER, B3.link, [s.referralDraftId, link.rowVersion, 'deal', other, null], '55000', 'draft_already_linked');
      // deal_not_from_lead: a draft linked to a Lead takes only the Deal made from it.
      const s2 = await h.standalone();
      const lead = await h.insertLead(8101);
      await h.linkDeal(OWNER, s2.referralDraftId, lead, 'lead');
      await refused(OWNER, B3.link, [s2.referralDraftId, (await h.draftRow(s2.referralDraftId)).row_version, 'deal', other, null], '22023',
        'deal_not_from_lead');
      await owner('update public.deals set source_lead_id = 8101 where id = $1', [other]);
      const cands = await one<Array<{ id: string; fromLinkedLead: boolean; linkable: boolean }>>(OWNER, B3.candidates, [s2.referralDraftId, 'deal', null]);
      expect(cands.find((c) => c.id === other)).toMatchObject({ fromLinkedLead: true, linkable: true });
      expect(cands[0]!.id).toBe(other);
      await h.linkDeal(OWNER, s2.referralDraftId, other);
      // Linking writes nothing in Bitrix, bookings, tasks or money.
      expect(await owner(`select count(*)::int as n from public.outbox_events`)).toEqual([{ n: 0 }]);
      expect(await owner(`select count(*)::int as n from public.booking_versions where deal_id in ($1, $2)`, [deal, other])).toEqual([{ n: 0 }]);
      expect(await one(SALES_B, B3.candidates, [s.referralDraftId, 'deal', null])).toBeNull();
    });
  });

  it('binding and conversion of a referral quotation; deal_already_linked; link_locked after binding; no tasks or finance rows', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      const acc = await h.acceptedReferral();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980205);
      const qrv = async (id: string) => (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [id]))[0]!.row_version;
      await refused(OWNER, B3.qBind, [acc.quotationId, deal, await qrv(acc.quotationId)], '55000', 'deal_not_linked_to_draft');
      await refused(OWNER, B3.qConvert, [acc.versionId, acc.hash, rid()], '55000', 'deal_link_required');
      const link = await h.linkDeal(OWNER, acc.referralDraftId, deal);
      const before = await owner<{ tasks: number; outbox: number; receipts: number }>(
        `select (select count(*)::int from public.fulfilment_tasks) as tasks, (select count(*)::int from public.outbox_events) as outbox,
                (select count(*)::int from public.customer_receipts) as receipts`);
      // A second draft with an accepted quotation on the same Deal: link refused deal_already_linked once the first is bound.
      const acc2 = await h.acceptedReferral(OWNER, { customerName: 'Synthetic Second' });
      await h.linkDeal(OWNER, acc2.referralDraftId, deal);
      const bound = await one<{ linkedDealId: string }>(OWNER, B3.qBind, [acc.quotationId, deal, await qrv(acc.quotationId)]);
      expect(bound.linkedDealId).toBe(deal);
      await refused(OWNER, B3.qBind, [acc2.quotationId, deal, await qrv(acc2.quotationId)], '55000', 'deal_already_linked');
      const acc3 = await h.acceptedReferral(OWNER, { customerName: 'Synthetic Third' });
      await refused(OWNER, B3.link, [acc3.referralDraftId, (await h.draftRow(acc3.referralDraftId)).row_version, 'deal', deal, null],
        '55000', 'deal_already_linked');
      // Bound: the link cannot be removed (A4), and the draft never closes.
      await refused(OWNER, B3.unlink, [link.linkId, (await h.draftRow(acc.referralDraftId)).row_version, 'wrong_link', 'Synthetic wrong link note'],
        '55000', 'link_locked');
      expect(await owner<Record<string, number>>(
        `select (select count(*)::int from public.fulfilment_tasks) as tasks, (select count(*)::int from public.outbox_events) as outbox,
                (select count(*)::int from public.customer_receipts) as receipts`)).toEqual(before);
      // quotation_list on the Deal labels the bound row 'referral' (never 'deal').
      expect(await one(OWNER, B3.qList, ['deal', deal])).toMatchObject([{ quotationId: acc.quotationId, subjectKind: 'referral',
        referralDraftId: acc.referralDraftId, linkedDealId: deal }]);
      // Conversion is its own explicit step; acceptance evidence unchanged.
      const conv = await one<{ outcome: string; dealId: string }>(OWNER, B3.qConvert, [acc.versionId, acc.hash, rid()]);
      expect(conv).toMatchObject({ outcome: 'created', dealId: deal });
      expect((await h.draft(OWNER, acc.referralDraftId))).toMatchObject({ bound: true, autoClose: { state: 'none' } });
      expect(await owner(`select count(*)::int as n from public.quotation_evidence where quotation_version_id = $1 and status = 'stored'`,
        [acc.versionId])).toEqual([{ n: 1 }]);
    });
  });
});

describe('close, reopen, reassign', () => {
  it('owner closes with a reason; edits refused draft_closed writing nothing; reopen needs a note after duplicate', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      await refused(SALES_B, B3.close, [s.referralDraftId, 1, 'duplicate', null], '42501', 'not_authorized');
      await refusedWithHint(OWNER, B3.close, [s.referralDraftId, 1, 'bored', null], /^reason$/);
      const closed = await one<{ alreadyClosed: boolean; closedReason: string; rowVersion: number }>(OWNER, B3.close,
        [s.referralDraftId, 1, 'duplicate', 'Synthetic: same customer as TD-0']);
      expect(closed).toMatchObject({ alreadyClosed: false, closedReason: 'duplicate', rowVersion: 2 });
      expect(await one(OWNER, B3.close, [s.referralDraftId, 2, 'lost', null])).toMatchObject({ alreadyClosed: true, closedReason: 'duplicate' });
      const snap = await h.snapshot();
      await refused(OWNER, B3.qSave, [s.versionId, s.rowVersion, JSON.stringify({ adults: 2 })], '55000', 'draft_closed');
      await refused(OWNER, B3.draftSave, [s.referralDraftId, 2, JSON.stringify({ companyName: 'X' })], '55000', 'draft_closed');
      await refused(OWNER, B3.qCreate, ['referral', s.referralDraftId, 'More', rid()], '55000', 'draft_closed');
      // N2: no access still answers not_authorized on a closed draft.
      await refused(SALES_B, B3.qSave, [s.versionId, s.rowVersion, JSON.stringify({ adults: 2 })], '42501', 'not_authorized');
      expect(await h.snapshot()).toEqual(snap);
      expect((await one<Got>(OWNER, B3.qGet, [s.versionId])).canEdit).toBe(false);
      await refusedWithHint(OWNER, B3.reopen, [s.referralDraftId, 2, null], /^note$/);
      const reopened = await one<{ status: string; closedAutomatically: boolean; autoClose: { state: string } }>(OWNER, B3.reopen,
        [s.referralDraftId, 2, 'Synthetic: not a duplicate after all']);
      expect(reopened).toMatchObject({ status: 'open', closedAutomatically: false, autoClose: { state: 'scheduled' } });
      await refused(OWNER, B3.reopen, [s.referralDraftId, 3, null], '55000', 'draft_not_closed');
      expect(await owner(`select action, reason from public.audit_events where target_id = $1 and action like 'referral.draft_%' order by id`,
        [s.referralDraftId])).toEqual([
        { action: 'referral.draft_created', reason: null },
        { action: 'referral.draft_closed', reason: 'Synthetic: same customer as TD-0' },
        { action: 'referral.draft_reopened', reason: 'Synthetic: not a duplicate after all' },
      ]);
    });
  });

  it('reassign: branch Manager only, to active Sales in the branch; the old owner loses access', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      await refused(OWNER, B3.reassign, [s.referralDraftId, 1, U.salesDelhiB, 'Synthetic handover reason'], '42501', 'not_authorized');
      expect(await one(OWNER, B3.owners, [s.referralDraftId])).toBeNull();
      const choices = await one<Array<{ userId: string; isCurrentOwner: boolean }>>(MANAGER, B3.owners, [s.referralDraftId]);
      expect(choices.map((c) => c.userId).sort()).toEqual([U.salesDelhiA, U.salesDelhiB].sort());
      for (const bad of [U.managerDelhi, U.salesAhmedabad]) {
        await refusedWithHint(MANAGER, B3.reassign, [s.referralDraftId, 1, bad, 'Synthetic handover reason'], /^newOwner$/);
      }
      await refusedWithHint(MANAGER, B3.reassign, [s.referralDraftId, 1, U.salesDelhiB, 'short'], /^reason$/);
      expect(await one(MANAGER, B3.reassign, [s.referralDraftId, 1, U.salesDelhiB, 'Synthetic handover reason']))
        .toMatchObject({ changed: true, rowVersion: 2 });
      await h.expectNull(OWNER, B3.get, [s.referralDraftId], 'old owner');
      expect(await h.draft(SALES_B, s.referralDraftId)).toMatchObject({ ownerIsYou: true });
    });
  });
});

describe('90-day closure (F.3)', () => {
  it('F.3.4-1, 2, 12: switch off = no closure anywhere; existing drafts keep working; switching on restarts the 90 days', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      await h.referralSwitch(false);
      await h.age(s.referralDraftId, 120);
      const d = (await h.draft(OWNER, s.referralDraftId))!;
      expect(d).toMatchObject({ status: 'open', autoClose: { state: 'paused', dueOn: null }, switchOn: false, can: { edit: true } });
      expect(await h.job()).toEqual({ closed: 0, skipped: 'switch_off' });
      const before = await h.draftRow(s.referralDraftId);
      const saved = await one<{ rowVersion: number }>(OWNER, B3.qSave, [s.versionId, s.rowVersion, JSON.stringify({ adults: 2 })]);
      expect(saved.rowVersion).toBe(s.rowVersion + 1);
      expect((await h.draftRow(s.referralDraftId)).last_activity_at).not.toBe(before.last_activity_at);
      // DEC-54: link, save, add a quotation, close and reopen all work while off.
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980206);
      await h.linkDeal(OWNER, s.referralDraftId, deal);
      await one(OWNER, B3.qCreate, ['referral', s.referralDraftId, 'Off-time quote', rid()]);
      const rv = (await h.draftRow(s.referralDraftId)).row_version;
      await one(OWNER, B3.close, [s.referralDraftId, rv, 'lost', null]);
      await one(OWNER, B3.reopen, [s.referralDraftId, rv + 1, null]);
      expect(await h.auditCount('referral.draft_closed')).toBe(1);
      // Switching on: the clock restarts (DEC-53), nothing closes that day.
      await h.age(s.referralDraftId, 120);
      await h.referralSwitch(true);
      const today = (await owner<{ d: string }>(`select (authz.finance_today() + 91)::text as d`))[0]!.d;
      expect((await h.draft(OWNER, s.referralDraftId))!.autoClose).toEqual({ state: 'scheduled', dueOn: today });
      expect(await h.job()).toEqual({ closed: 0, skipped: null });
    });
  });

  it('F.3.4-3, 4, 11: past dueOn reads closed before the job; writes refuse having written nothing; the job closes once; reads never write', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      const it = await h.standaloneItinerary();
      await h.resumedDaysAgo(200);
      await h.age(s.referralDraftId, 96);
      await h.age(it.referralDraftId, 10);
      const due = (await owner<{ d: string }>(`select (authz.finance_today() - 5)::text as d`))[0]!.d;
      const snap = await h.snapshot();
      const read = await h.draft(OWNER, s.referralDraftId);
      expect(read).toMatchObject({ status: 'closed', closedReason: 'no_activity', autoClose: { state: 'closed', dueOn: due },
        can: { edit: false, reopen: true } });
      await one(OWNER, B3.qGet, [s.versionId]);
      await one(OWNER, B3.iGet, [it.documentId]);
      await h.list(OWNER, 'quotations', { status: 'all' });
      await h.list(OWNER, 'itineraries', { status: 'all' });
      await one(OWNER, B3.myCounts);
      expect(await h.snapshot()).toEqual(snap);
      await refused(OWNER, B3.qSave, [s.versionId, s.rowVersion, JSON.stringify({ adults: 2 })], '55000', 'draft_closed');
      expect(await h.snapshot()).toEqual(snap);
      expect(await h.job()).toEqual({ closed: 1, skipped: null });
      expect(await h.job()).toEqual({ closed: 0, skipped: null });
      const row = await h.draftRow(s.referralDraftId);
      expect(row).toMatchObject({ status: 'closed', closed_reason: 'no_activity', closed_due_on: due });
      const [ts] = await owner<{ now: boolean }>(`select closed_at = now() as now from public.referral_drafts where id = $1`, [s.referralDraftId]);
      expect(ts!.now).toBe(true);
      const audits = await owner<{ actor_user_id: string | null; details: Record<string, unknown> }>(
        `select actor_user_id, details from public.audit_events where action = 'referral.draft_closed' and target_id = $1`, [s.referralDraftId]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor_user_id: null, details: { automatic: true, dueOn: due } });
      expect((await h.draftRow(it.referralDraftId)).status).toBe('open');
      // Nothing about the quotation changed.
      expect(await owner(`select status from public.quotation_versions where id = $1`, [s.versionId])).toEqual([{ status: 'draft' }]);
      await refused({ userId: U.salesDelhiA }, B3.job, [10], '42501');
      await refusedWithHint({ userId: null, role: 'service_role' }, B3.job, [500], /^limit$/);
    });
  });

  it('F.3.4-8: reopen on a due stored-open draft persists closure and reopening together; close answers alreadyClosed', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.resumedDaysAgo(200);
      const a = await h.standalone();
      const b = await h.standalone();
      await h.age(a.referralDraftId, 100);
      await h.age(b.referralDraftId, 100);
      const r = await one<{ status: string; closedAutomatically: boolean; dueOn: string; autoClose: { state: string; dueOn: string } }>(
        OWNER, B3.reopen, [a.referralDraftId, 1, null]);
      expect(r).toMatchObject({ status: 'open', closedAutomatically: true, autoClose: { state: 'scheduled' } });
      expect(r.dueOn).toBe((await owner<{ d: string }>(`select (authz.finance_today() - 9)::text as d`))[0]!.d);
      expect(await owner(`select action from public.audit_events where target_id = $1 and action in ('referral.draft_closed', 'referral.draft_reopened')
        order by id`, [a.referralDraftId])).toEqual([{ action: 'referral.draft_closed' }, { action: 'referral.draft_reopened' }]);
      const c = await one<{ alreadyClosed: boolean; closedReason: string }>(OWNER, B3.close, [b.referralDraftId, 1, 'lost', null]);
      expect(c).toEqual({ status: 'closed', closedReason: 'no_activity', alreadyClosed: true, rowVersion: 2 });
      expect((await h.draftRow(b.referralDraftId)).closed_reason).toBe('no_activity');
    });
  });

  it('F.3.4-9: IST boundary; F.3.4-10: bound drafts never close, linked-but-unbound drafts do', async () => {
    await asOwner(db, async () => {
      await h.resumedDaysAgo(400);
      const [b] = await owner<{ late: string; early: string }>(
        `select authz.referral_due_on('2026-03-01 23:59:00+05:30')::text as late, authz.referral_due_on('2026-03-02 00:01:00+05:30')::text as early`);
      expect(b).toEqual({ late: '2026-05-31', early: '2026-06-01' });
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      await h.resumedDaysAgo(400);
      const boundOne = await h.acceptedReferral();
      const linkedOnly = await h.standalone();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980207);
      const deal2 = await h.insertRealDeal('UC_AD0SLH', 0, 980208);
      await h.linkDeal(OWNER, boundOne.referralDraftId, deal);
      const qrv = (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [boundOne.quotationId]))[0]!.row_version;
      await one(OWNER, B3.qBind, [boundOne.quotationId, deal, qrv]);
      await h.linkDeal(OWNER, linkedOnly.referralDraftId, deal2);
      await h.age(boundOne.referralDraftId, 300);
      await h.age(linkedOnly.referralDraftId, 300);
      expect((await h.draft(OWNER, boundOne.referralDraftId))).toMatchObject({ status: 'open', autoClose: { state: 'none' } });
      expect(await h.job()).toEqual({ closed: 1, skipped: null });
      expect((await h.draftRow(boundOne.referralDraftId)).status).toBe('open');
      expect((await h.draftRow(linkedOnly.referralDraftId)).status).toBe('closed');
    });
  });
});

describe('scoped lists and Home rows (FP-040, FP-051, FP-081)', () => {
  it('scope, counts = rows, keyset pages, department roles get nothing; Home counts equal the list', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const deal = await one<{ versionId: string }>(OWNER, B3.qCreate, ['deal', DEAL, 'Synthetic deal quote', rid()]);
      const refs = [await h.standalone(), await h.standalone(), await h.standalone()];
      await h.standalone(SALES_B);
      const page1 = await h.list(OWNER, 'quotations', {}, null, 2);
      expect(page1).toMatchObject({ applies: true, scope: 'mine', total: 4, hasMore: true });
      expect(page1.counts).toMatchObject({ open: 4, to_finish: 4, drafts: 4, all: 4, closed_drafts: 0 });
      const page2 = await h.list(OWNER, 'quotations', {}, page1.next, 2);
      expect(page2).toMatchObject({ hasMore: false, next: null });
      const ids = [...page1.rows!, ...page2.rows!].map((r) => r.quotationId);
      expect(new Set(ids).size).toBe(4);
      expect(ids).toContain(refs[0]!.quotationId);
      expect(page1.rows![0]).toMatchObject({ currentVersion: { status: 'draft' }, ownerIsYou: true });
      expect(JSON.stringify(page1.rows)).not.toMatch(/Paise|money|selling|margin/i);
      const referralRow = [...page1.rows!, ...page2.rows!].find((r) => r.quotationId === refs[0]!.quotationId)!;
      expect(referralRow).toMatchObject({ subjectKind: 'referral', subject: { kind: 'referral', reference: refs[0]!.referralReference },
        draft: { status: 'open', reference: refs[0]!.referralReference }, ownerName: expect.any(String) });
      // Manager: mine = none; all = the whole branch (5).
      expect((await h.list(MANAGER, 'quotations')).total).toBe(0);
      expect((await h.list(MANAGER, 'quotations', { scope: 'all' })).counts).toMatchObject({ all: 5 });
      for (const actor of [PURCHASE, ACCOUNTS, SUPER, DESK]) expect(await h.list(actor, 'quotations')).toEqual({ applies: false });
      // Home (FP-081): count = my_work_list rows = list to_finish (scope all).
      const counts = await one<{ quotationDraftsToFinish: number; acceptedQuotesToLink: number }>(OWNER, B3.myCounts);
      const rows = await one<{ rows: unknown[] }>(OWNER, B3.myList, ['quotation_drafts', null, 50]);
      expect(counts.quotationDraftsToFinish).toBe(4);
      expect(rows.rows).toHaveLength(4);
      expect((await h.list(OWNER, 'quotations', { scope: 'all', status: 'to_finish' })).total).toBe(4);
      expect(rows.rows[0]).toEqual({ quotationId: expect.any(String), versionId: expect.any(String), reference: expect.any(String),
        title: expect.any(String), subjectKind: expect.any(String), subjectReference: expect.any(String), since: expect.any(String) });
      void deal;
      await refusedWithHint(OWNER, B3.list, ['quotations', JSON.stringify({ status: 'final_made' }), null, 10], /^status$/);
      await refusedWithHint(OWNER, B3.list, ['quotations', JSON.stringify({ colour: 1 }), null, 10], /^filter$/);
      await refusedWithHint(OWNER, B3.list, ['quotations', '{}', JSON.stringify({ since: 'x', id: 'y' }), 10], /^after$/);
    });
  });

  it('accepted, not linked: Home count equals rows; closed never-linked drafts only under closed_drafts or by reference', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      const acc = await h.acceptedReferral();
      expect((await one<{ acceptedQuotesToLink: number }>(OWNER, B3.myCounts)).acceptedQuotesToLink).toBe(1);
      expect((await one<{ rows: unknown[] }>(OWNER, B3.myList, ['accepted_to_link', null, 50])).rows).toHaveLength(1);
      expect((await h.list(OWNER, 'quotations', { status: 'accepted_not_linked' })).rows).toMatchObject([{ quotationId: acc.quotationId,
        acceptedNotLinked: true }]);
      const lonely = await h.standalone();
      const linked = await h.standalone();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980209);
      const l = await h.linkDeal(OWNER, linked.referralDraftId, deal);
      await one(OWNER, B3.close, [lonely.referralDraftId, 1, 'lost', null]);
      await one(OWNER, B3.close, [linked.referralDraftId, l.rowVersion, 'lost', null]);
      const all = await h.list(OWNER, 'quotations', { status: 'all' });
      const allIds = all.rows!.map((r) => r.quotationId);
      expect(allIds).not.toContain(lonely.quotationId);
      expect(allIds).toContain(linked.quotationId);
      expect((await h.list(OWNER, 'quotations')).rows!.map((r) => r.quotationId)).not.toContain(linked.quotationId);
      const closed = await h.list(OWNER, 'quotations', { status: 'closed_drafts' });
      expect(closed.rows!.map((r) => r.quotationId).sort()).toEqual([lonely.quotationId, linked.quotationId].sort());
      expect(closed.counts!.closed_drafts).toBe(2);
      expect((await h.list(OWNER, 'quotations', { reference: lonely.referralReference.toLowerCase() })).rows).toMatchObject([
        { quotationId: lonely.quotationId }]);
      expect(await one(OWNER, B3.find, [lonely.referralReference])).toEqual({ referralDraftId: lonely.referralDraftId });
      expect(await one(MANAGER, B3.find, [lonely.referralReference])).toEqual({ referralDraftId: lonely.referralDraftId });
      expect(await one(SALES_B, B3.find, [lonely.referralReference])).toBeNull();
      expect(await one(OWNER, B3.find, ['TD-999999'])).toBeNull();
      expect(await one(OWNER, B3.find, ['nonsense'])).toBeNull();
      expect(await h.draft(OWNER, lonely.referralDraftId)).toMatchObject({ status: 'closed', can: { reopen: true, edit: false } });
    });
  });

  it('itinerary list: draft, ready, closed chips; referral and Deal documents; scope', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const it = await h.standaloneItinerary();
      await one(OWNER, B3.iCreate, ['deal', DEAL, 'Synthetic deal itinerary', rid()]);
      const page = await h.list(OWNER, 'itineraries');
      expect(page).toMatchObject({ applies: true, total: 2, counts: { open: 2, draft: 2, ready: 0, final_made: 0, closed_drafts: 0, all: 2 } });
      expect(page.rows!.find((r) => r.documentId === it.documentId)).toMatchObject({ subjectKind: 'referral', basisKind: 'none',
        factsStatus: 'draft', openDifferences: 0, createdByYou: true, draft: { status: 'open' } });
      expect(page.rows!.find((r) => r.documentId === it.documentId)).toMatchObject({ ownerIsYou: true, ownerName: expect.any(String) });
      // Echo L9: the Manager sees the same owner named, not marked as themselves; a Deal document names the Deal owner.
      const mgrPage = await h.list(MANAGER, 'itineraries', { scope: 'all' });
      for (const r of mgrPage.rows!) expect(r).toMatchObject({ ownerIsYou: false, ownerName: expect.any(String) });
      expect(page.rows!.every((r) => r.ownerIsYou === true)).toBe(true);
      expect((await h.list(SALES_B, 'itineraries', { scope: 'all' })).total).toBe(0);
      await one(OWNER, B3.close, [it.referralDraftId, 1, 'lost', null]);
      expect((await h.list(OWNER, 'itineraries')).counts).toMatchObject({ open: 1, closed_drafts: 1, all: 1 });
    });
  });
});

describe('FP-081 Home counts equal the list totals (lead request)', () => {
  it('owner, branch Manager and mixed roles: quotationDraftsToFinish = to_finish total, acceptedQuotesToLink = accepted_not_linked total (scope all)', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      await one(OWNER, B3.qCreate, ['deal', DEAL, 'Synthetic deal quote', rid()]);
      await h.standalone();
      await h.standalone(SALES_B);
      await h.acceptedReferral();
      const closed = await h.standalone();
      await one(OWNER, B3.close, [closed.referralDraftId, 1, 'lost', null]);
      // Bound: accepted but no longer "to link".
      const bound = await h.acceptedReferral(OWNER, { customerName: 'Synthetic Bound' });
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980301);
      await h.linkDeal(OWNER, bound.referralDraftId, deal);
      const qrv = (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [bound.quotationId]))[0]!.row_version;
      // Terra's start-booking order: bind to the draft's active Deal link, then convert (two explicit commands).
      await one(OWNER, B3.qBind, [bound.quotationId, deal, qrv]);
      // Mixed roles: Manager also Accounts; Sales B also Flight.
      await h.addRole(U.managerDelhi, 'accounts', 'DEL');
      await h.addFlight(U.salesDelhiB, 'DEL');
      const expectations: Array<[Actor, string, number, number]> = [[OWNER, 'owner', 2, 1], [MANAGER, 'manager+accounts', 3, 1],
        [SALES_B, 'sales+flight', 1, 0]];
      for (const [actor, label, finish, link] of expectations) {
        const c = await one<{ quotationDraftsToFinish: number; acceptedQuotesToLink: number }>(actor, B3.myCounts);
        const toFinish = await h.list(actor, 'quotations', { scope: 'all', status: 'to_finish' });
        const toLink = await h.list(actor, 'quotations', { scope: 'all', status: 'accepted_not_linked' });
        expect([c.quotationDraftsToFinish, c.acceptedQuotesToLink], label).toEqual([finish, link]);
        expect([toFinish.total, toLink.total], label).toEqual([finish, link]);
        expect([toFinish.counts!.to_finish, toLink.counts!.accepted_not_linked], label).toEqual([finish, link]);
        expect((await one<{ rows: unknown[] }>(actor, B3.myList, ['quotation_drafts', null, 50])).rows, label).toHaveLength(finish);
        expect((await one<{ rows: unknown[] }>(actor, B3.myList, ['accepted_to_link', null, 50])).rows, label).toHaveLength(link);
      }
    });
  });

  it('binding without an active Deal link refuses deal_not_linked_to_draft and writes nothing; after unlink it refuses again', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const acc = await h.acceptedReferral();
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 980302);
      const qrv = async () => (await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [acc.quotationId]))[0]!.row_version;
      const snap = await h.snapshot();
      await refused(OWNER, B3.qBind, [acc.quotationId, deal, await qrv()], '55000', 'deal_not_linked_to_draft');
      expect(await h.snapshot()).toEqual(snap);
      const link = await h.linkDeal(OWNER, acc.referralDraftId, deal);
      await one(OWNER, B3.unlink, [link.linkId, link.rowVersion, 'wrong_link', 'Synthetic wrong customer']);
      await refused(OWNER, B3.qBind, [acc.quotationId, deal, await qrv()], '55000', 'deal_not_linked_to_draft');
      expect(await owner('select linked_deal_id from public.quotations where id = $1', [acc.quotationId])).toEqual([{ linked_deal_id: null }]);
    });
  });
});

describe('itinerary basis and prices on referral subjects (DA-80, DEC-48)', () => {
  it('a document on the draft compares with the draft\'s accepted quotation once there is one; prices only for money readers', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await h.setSwitch('service_items_enabled', true);
      const acc = await h.acceptedReferral();
      const doc = await one<{ documentId: string }>(OWNER, B3.iCreate, ['referral', acc.referralDraftId, 'Synthetic draft itinerary', rid()]);
      const own = await one<{ basis: { kind: string; id: string }; money: unknown }>(OWNER, B3.iGet, [doc.documentId]);
      expect(own.basis).toMatchObject({ kind: 'quotation_version', id: acc.versionId });
      expect(own.money).not.toBeNull();
      const mgr = await one<{ basis: { kind: string }; money: unknown }>(MANAGER, B3.iGet, [doc.documentId]);
      expect(mgr.basis.kind).toBe('quotation_version');
      expect(mgr.money).toBeNull();
    });
  });
});

describe('effective state carried by the editors (lead ruling 6)', () => {
  it('quotation_get and itinerary_document_get carry the draft status, link and reopen right', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      const s = await h.standalone();
      const g = await one<Got>(OWNER, B3.qGet, [s.versionId]);
      expect(g.subject).toMatchObject({ kind: 'referral', referralDraftId: s.referralDraftId, reference: s.referralReference,
        title: CUSTOMER.customerName });
      expect(g.referral).toMatchObject({ referralDraftId: s.referralDraftId, status: 'open', linked: false, bound: false, canReopen: false,
        autoClose: { state: 'scheduled' } });
      expect(g.prefill).toBeNull();
      await one(OWNER, B3.close, [s.referralDraftId, 1, 'lost', null]);
      const closed = await one<Got>(MANAGER, B3.qGet, [s.versionId]);
      expect(closed.referral).toMatchObject({ status: 'closed', closedReason: 'lost', canReopen: true });
      expect(closed.canEdit).toBe(false);
      const dl = await one<Got>(OWNER, B3.qGet, [(await one<{ versionId: string }>(OWNER, B3.qCreate, ['deal', DEAL, 'Deal quote', rid()])).versionId]);
      expect(dl.referral).toBeNull();
      expect(dl.subject).toMatchObject({ kind: 'deal', referralDraftId: null });
      const view: DraftView | null = await h.draft(MANAGER, s.referralDraftId);
      expect(view!.ownerName).not.toBeNull();
    });
  });
});
