import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import {
  ACCOUNTS,
  ANON,
  CHECKLIST_SQL,
  DEAL,
  DEAL2,
  FLIGHT,
  FLIGHT_CLAIM_SQL,
  HOTEL,
  MANAGER,
  OTHER_ENTITY,
  OWNER,
  PURCHASE,
  PURCHASE_CLAIM_SQL,
  SALES_AMD,
  SALES_B,
  SUPER,
  TRAVELLERS,
  rid,
} from './b1-support';
import { DESK, VISA_CLAIM_SQL, b11Helpers } from './b11-support';
import { stripBookingFormKeys } from './booking-form-support';

/**
 * B1.2 Phase D (migration 20261120000100_b12_traveller_id_proof): identity
 * proof files per traveller (freeze note 2.2, DEC-38 … DEC-42).
 *   - writers: booking editors; consent tick required and stored;
 *   - viewers (DEC-41): Sales owner/assignee, branch Manager, Accounts, and the
 *     assignee of any task of the Deal; never Super Admin by role, never
 *     unlinked staff; every view audited with the viewer's role;
 *   - a proof never moves to another person (renumbered or removed traveller);
 *   - readiness: adults blocking, children warning, drafts only;
 *   - never hashed; old booking_form_get JSON unchanged apart from the new keys.
 * Synthetic fixtures only; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner, form, storeIdProof } = h;

const BEGIN = 'select public.traveller_id_proof_begin($1, $2, $3, $4, $5, $6, $7, $8) as r';
const FINISH = 'select public.traveller_id_proof_finish($1, $2) as r';
const REMOVE = 'select public.traveller_id_proof_remove($1, $2) as r';
const DOWNLOAD = 'select public.traveller_id_proof_authorize_download($1) as r';
const FOR_TASK = 'select public.traveller_id_proofs_for_task($1) as r';
const FOR_DEAL = 'select public.traveller_id_proofs_for_deal($1) as r';
type DealProofs = { dealId: string; travellers: Array<{ seq: number; fullName: string; type: string; idProofs: Array<Record<string, unknown>> }> };

const SHA = 'c'.repeat(64);
const NAME = 'Synthetic Aadhaar Front.jpg';

type Begun = { fileId: string; objectPath: string | null; outcome: 'created' | 'existing'; status: string; rowVersion: number };
type Finished = { fileId: string; status: string; rowVersion: number };
type Proof = {
  fileId: string; fileName: string; mime: string; sizeBytes: number; status: string; rowVersion: number;
  uploadedByName: string | null; uploadedByYou: boolean; consentByName: string | null; consentAt: string;
  createdAt: string; storedAt: string | null;
};
type FormTraveller = { seq: number; fullName: string; idProofs?: Proof[] };
type Checklist = { items: Array<{ code: string; blocking: boolean; travellerSeqs?: number[] }>; canConfirm: boolean };

type BeginOpts = { deal?: string; seq?: number; requestId?: string; consent?: boolean | null; name?: string; mime?: string; size?: number; sha?: string };
const beginParams = (o: BeginOpts = {}) =>
  [o.deal ?? DEAL, o.seq ?? 1, o.requestId ?? rid(), o.consent === undefined ? true : o.consent, o.name ?? NAME, o.mime ?? 'image/jpeg', o.size ?? 4096, o.sha ?? SHA];
const begin = (actor: Actor, o: BeginOpts = {}) => one<Begun>(actor, BEGIN, beginParams(o));

async function putObject(path: string, size = 4096): Promise<void> {
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('traveller-id-proofs', $1, jsonb_build_object('size', $2::bigint))`,
    [path, size]);
}
async function storedFile(actor: Actor = OWNER, o: BeginOpts = {}): Promise<Finished> {
  const b = await begin(actor, o);
  await putObject(b.objectPath!, o.size ?? 4096);
  const f = await one<Finished>(actor, FINISH, [b.fileId, true]);
  expect(f.status).toBe('stored');
  return f;
}
const travellersOf = async (actor: Actor = OWNER, deal: string = DEAL) =>
  ((await form(actor, deal))!.travellers as FormTraveller[]);
const checklist = (deal: string = DEAL) => one<Checklist>(OWNER, CHECKLIST_SQL, [deal]);
const viewedRole = async (fileId: string) =>
  (await owner<{ role: string }>(`select details ->> 'viewerRole' as role from public.audit_events
     where action = 'booking.id_proof_viewed' and target_id = $1 order by occurred_at desc, id desc limit 1`, [fileId]))[0]?.role;
const markRemoved = async (deal: string = DEAL) => {
  await owner('alter table public.deals drop constraint deals_removed_imported_only');
  await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [deal]);
};

describe('traveller_id_proofs table and bucket', () => {
  it('is RLS-protected with no privilege for any API role; the bucket is private; helpers are not callable', async () => {
    await asOwner(db, async () => {
      const [t] = await owner<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where oid = 'public.traveller_id_proofs'::regclass`);
      expect(t!.rls).toBe(true);
      const [p] = await owner<Record<string, boolean>>(
        `select has_table_privilege('authenticated', 'public.traveller_id_proofs', 'select') as auth,
                has_table_privilege('anon', 'public.traveller_id_proofs', 'select') as anon,
                has_table_privilege('service_role', 'public.traveller_id_proofs', 'select') as svc`);
      expect(p).toEqual({ auth: false, anon: false, svc: false });
      expect(await owner(`select policyname, permissive from pg_policies where schemaname = 'public' and tablename = 'traveller_id_proofs'`))
        .toEqual([{ policyname: 'require_valid_session', permissive: 'RESTRICTIVE' }]);
      const [bucket] = await owner<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
        `select public, file_size_limit::text, allowed_mime_types from storage.buckets where id = 'traveller-id-proofs'`);
      expect(bucket).toEqual({ public: false, file_size_limit: '4194304', allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] });
      const [fn] = await owner<Record<string, boolean>>(
        `select has_function_privilege('authenticated', 'public.traveller_id_proof_begin(uuid, integer, uuid, boolean, text, text, integer, text)', 'execute') as begin,
                has_function_privilege('authenticated', 'public.traveller_id_proofs_for_task(uuid)', 'execute') as task,
                has_function_privilege('anon', 'public.traveller_id_proof_authorize_download(uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'authz.id_proof_viewer_role(uuid)', 'execute') as helper,
                has_function_privilege('authenticated', 'authz.traveller_id_proofs_detach()', 'execute') as detach`);
      expect(fn).toEqual({ begin: true, task: true, anon: false, helper: false, detach: false });
      // Review D1-7: trigger functions are not security definer.
      expect(await owner(`select proname, prosecdef from pg_proc where proname in ('traveller_id_proofs_guard', 'traveller_id_proofs_detach') order by proname`))
        .toEqual([{ proname: 'traveller_id_proofs_detach', prosecdef: false }, { proname: 'traveller_id_proofs_guard', prosecdef: false }]);
      // There is no column for a typed ID number.
      const cols = (await owner<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'traveller_id_proofs'`)).map((c) => c.column_name);
      expect(cols.filter((c) => /aadhaar|aadhar|id_number|document_number|passport/i.test(c))).toEqual([]);
    });
  });

  it('no role reads the table through the Data API', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      await storedFile();
      for (const actor of [OWNER, MANAGER, SALES_B, PURCHASE, FLIGHT, DESK, ACCOUNTS, SUPER, OTHER_ENTITY]) {
        await expectDbError(db, async () => {
          await setActor(db, actor);
          await db.query('select * from public.traveller_id_proofs');
        }, { code: '42501' });
        await resetActor(db);
      }
    });
  });

  it('guard: never deleted; identity and consent columns fixed; removed is final', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const f = await storedFile();
      await expectDbError(db, () => owner('delete from public.traveller_id_proofs where id = $1', [f.fileId]), { code: '42501' });
      for (const set of [`file_name = 'x.jpg'`, `traveller_seq = 2`, `consent_at = now() - interval '1 day'`, `status = 'pending_upload'`]) {
        await expectDbError(db, () => owner(`update public.traveller_id_proofs set ${set} where id = $1`, [f.fileId]), { code: '42501' });
      }
      await one(OWNER, REMOVE, [f.fileId, f.rowVersion]);
      await expectDbError(db, () => owner(
        `update public.traveller_id_proofs set status = 'stored', removed_at = null, removed_by = null, removed_reason = null where id = $1`,
        [f.fileId]), { code: '42501' });
    });
  });
});

describe('begin / finish', () => {
  it('stores consent, traveller and version; path is server-generated; audits carry no file name', async () => {
    await asOwner(db, async () => {
      const d = await h.draftWithTravellers();
      const b = await begin(OWNER, { seq: 2 });
      expect(b).toMatchObject({ outcome: 'created', status: 'pending_upload', rowVersion: 1 });
      const [row] = await owner<Record<string, unknown>>(
        `select f.traveller_seq, f.booking_version_id, f.consent_by, f.consent_at is not null as consent_at,
                t.id = f.traveller_id as same_traveller, t.id as traveller_id, d.legal_entity_id
         from public.traveller_id_proofs f join public.deal_travellers t on t.deal_id = f.deal_id and t.seq = 2
         join public.deals d on d.id = f.deal_id where f.id = $1`, [b.fileId]);
      expect(row).toMatchObject({ traveller_seq: 2, booking_version_id: d.versionId, consent_by: U.salesDelhiA, consent_at: true, same_traveller: true });
      expect(b.objectPath).toBe(`${row!.legal_entity_id}/${DEAL}/${row!.traveller_id}/${b.fileId}`);
      await putObject(b.objectPath!);
      expect(await one<Finished>(OWNER, FINISH, [b.fileId, true])).toEqual({ fileId: b.fileId, status: 'stored', rowVersion: 2 });
      expect(await one<Finished>(OWNER, FINISH, [b.fileId, true])).toEqual({ fileId: b.fileId, status: 'stored', rowVersion: 2 });
      await refused(OWNER, FINISH, [b.fileId, false], '22023', 'invalid_input');
      await one(OWNER, DOWNLOAD, [b.fileId]);

      const audits = await owner<{ action: string; target_type: string; details: Record<string, unknown> }>(
        `select action, target_type, details from public.audit_events where target_id = $1 order by occurred_at, action`, [b.fileId]);
      expect(audits.map((a) => a.action).sort()).toEqual(['booking.id_proof_started', 'booking.id_proof_stored', 'booking.id_proof_viewed']);
      expect(audits.every((a) => a.target_type === 'traveller_id_proof')).toBe(true);
      const byAction = Object.fromEntries(audits.map((a) => [a.action, a.details]));
      expect(byAction['booking.id_proof_started']).toEqual({ dealId: DEAL, fileId: b.fileId, travellerSeq: 2, mime: 'image/jpeg', sizeBytes: 4096 });
      expect(byAction['booking.id_proof_stored']).toEqual({ dealId: DEAL, fileId: b.fileId, objectMissing: false });
      expect(byAction['booking.id_proof_viewed']).toEqual({ dealId: DEAL, fileId: b.fileId, travellerSeq: 2, viewerRole: 'sales_owner' });
      expect(JSON.stringify(audits)).not.toMatch(/Aadhaar|Synthetic Traveller/);
    });
  });

  it('refuses without the consent tick, an unknown or missing seq, and a missing request id', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      await refused(OWNER, BEGIN, beginParams({ consent: false }), '22023', 'consent_required');
      await refused(OWNER, BEGIN, beginParams({ consent: null }), '22023', 'consent_required');
      await refused(OWNER, BEGIN, beginParams({ seq: 9 }), 'P0002', 'not_found');
      await expectHint(OWNER, BEGIN, [DEAL, null, rid(), true, NAME, 'image/jpeg', 4096, SHA], 'seq');
      await expectHint(OWNER, BEGIN, [DEAL, 1, null, true, NAME, 'image/jpeg', 4096, SHA], 'requestId');
      expect(await h.count('select 1 from public.traveller_id_proofs')).toBe(0);
    });
  });

  it('finish: missing object or wrong size → failed; only the uploader while still an editor', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const missing = await begin(OWNER);
      expect((await one<Finished>(OWNER, FINISH, [missing.fileId, true])).status).toBe('failed');
      const wrong = await begin(OWNER);
      await putObject(wrong.objectPath!, 1);
      expect((await one<Finished>(OWNER, FINISH, [wrong.fileId, true])).status).toBe('failed');
      const [a] = await owner<{ details: { objectMissing: boolean } }>(
        `select details from public.audit_events where target_id = $1 and action = 'booking.id_proof_failed'`, [missing.fileId]);
      expect(a!.details.objectMissing).toBe(true);
      const other = await begin(OWNER);
      await putObject(other.objectPath!);
      await refused(MANAGER, FINISH, [other.fileId, true], '42501', 'not_authorized');
      // Review D1-9: an uploader who loses the editor right between begin and finish.
      await h.addSalesAssignee(DEAL, U.salesDelhiB);
      const byAssignee = await begin(SALES_B);
      await putObject(byAssignee.objectPath!);
      await owner(`update public.deal_assignments set ended_at = now() where deal_id = $1 and user_id = $2`, [DEAL, U.salesDelhiB]);
      await refused(SALES_B, FINISH, [byAssignee.fileId, true], '42501', 'not_authorized');
    });
  });

  it('is idempotent by request id; the path is handed out only while the upload is pending (review D1-3)', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const requestId = rid();
      const first = await begin(OWNER, { requestId });
      expect(await begin(OWNER, { requestId })).toEqual({ ...first, outcome: 'existing' });
      await putObject(first.objectPath!);
      await one(OWNER, FINISH, [first.fileId, true]);
      expect(await begin(OWNER, { requestId })).toEqual({ fileId: first.fileId, outcome: 'existing', status: 'stored', rowVersion: 2, objectPath: null });
      await one(OWNER, REMOVE, [first.fileId, 2]);
      expect(await begin(OWNER, { requestId })).toMatchObject({ status: 'removed', objectPath: null });
      const failedId = rid();
      const failed = await begin(OWNER, { requestId: failedId });
      await one(OWNER, FINISH, [failed.fileId, true]);
      expect(await begin(OWNER, { requestId: failedId })).toMatchObject({ status: 'failed', objectPath: null });
      for (const o of [{ size: 4097 }, { name: 'Other.jpg' }, { seq: 2 }]) {
        await refused(OWNER, BEGIN, beginParams({ requestId, ...o }), '40001', 'request_conflict');
      }
      await refused(MANAGER, BEGIN, beginParams({ requestId }), '40001', 'request_conflict');
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.id_proof_started'`)).toBe(2);
    });
  });

  it('accepts pdf, jpeg, png and webp up to the effective limit; refuses other files', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      for (const mime of ['application/pdf', 'image/png', 'image/webp']) {
        const b = await begin(OWNER, { mime, size: 4194304 });
        await one(OWNER, REMOVE, [b.fileId, b.rowVersion]);
      }
      const bad: BeginOpts[] = [{ mime: 'image/heic' }, { mime: 'text/plain' }, { size: 4194305 }, { size: 0 }, { sha: 'xyz' }, { name: '' }, { name: '...' }];
      for (const o of bad) await refused(OWNER, BEGIN, beginParams(o), '22023', 'evidence_rejected');
      const odd = await begin(OWNER, { name: 'aadhaar/../front?.jpg', sha: 'C'.repeat(64) });
      expect(await owner('select file_name, sha256 from public.traveller_id_proofs where id = $1', [odd.fileId]))
        .toEqual([{ file_name: 'aadhaar_.._front_.jpg', sha256: 'c'.repeat(64) }]);
      // Review D1-11: a lower setting is what the form shows and what begin enforces.
      await owner('update public.booking_settings set evidence_max_bytes = 1000000 where id');
      expect((await form(OWNER))!.idProofLimits).toEqual({ maxFilesPerTraveller: 4, maxBytes: 1000000 });
      await refused(OWNER, BEGIN, beginParams({ size: 1000001 }), '22023', 'evidence_rejected');
    });
  });

  it('caps a traveller at 4 live files with its own token; failed and removed files do not count', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const failed = await begin(OWNER);
      await one(OWNER, FINISH, [failed.fileId, true]); // no object → failed
      const live: Begun[] = [];
      for (let i = 0; i < 4; i += 1) live.push(await begin(OWNER));
      await refused(OWNER, BEGIN, beginParams(), '55000', 'id_proof_limit');
      await one(OWNER, REMOVE, [live[0]!.fileId, live[0]!.rowVersion]);
      expect((await begin(OWNER)).outcome).toBe('created');
      await refused(OWNER, BEGIN, beginParams(), '55000', 'id_proof_limit');
      expect((await begin(OWNER, { seq: 2 })).outcome).toBe('created');
    });
  });
});

describe('remove', () => {
  it('soft-removes with the file row version; repeat idempotent; storage object kept; any editor, nobody else', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const f = await storedFile();
      await refused(OWNER, REMOVE, [f.fileId, f.rowVersion - 1], '40001', 'version_changed');
      await refused(OWNER, REMOVE, [f.fileId, null], '40001', 'version_changed');
      const removed = await one<Finished>(MANAGER, REMOVE, [f.fileId, f.rowVersion]);
      expect(removed).toEqual({ fileId: f.fileId, status: 'removed', rowVersion: f.rowVersion + 1 });
      expect(await one<Finished>(OWNER, REMOVE, [f.fileId, 999])).toEqual(removed);
      expect(await owner('select removed_by, removed_reason from public.traveller_id_proofs where id = $1', [f.fileId]))
        .toEqual([{ removed_by: U.managerDelhi, removed_reason: 'staff' }]);
      expect(await h.count(`select 1 from storage.objects where bucket_id = 'traveller-id-proofs'`)).toBe(1);
      await refused(OWNER, DOWNLOAD, [f.fileId], 'P0002', 'not_found');
      expect((await owner<{ details: unknown }>(`select details from public.audit_events where action = 'booking.id_proof_removed'`))[0]!.details)
        .toEqual({ dealId: DEAL, fileId: f.fileId, previousStatus: 'stored' });
      for (const actor of [ACCOUNTS, PURCHASE, DESK, SUPER, SALES_AMD]) {
        const g = await storedFile();
        await refused(actor, REMOVE, [g.fileId, g.rowVersion], '42501', 'not_authorized');
        await one(OWNER, REMOVE, [g.fileId, g.rowVersion]);
      }
    });
  });

  it('removed Deal and switch (review D1-2): remove works with the switch off; begin, finish, download and remove refuse a removed Deal', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const a = await storedFile();
      const b = await storedFile();
      const pending = await begin(OWNER);
      await putObject(pending.objectPath!);
      await h.setSwitch('service_items_enabled', false);
      await refused(OWNER, BEGIN, beginParams(), '55000', 'service_items_disabled');
      expect((await one<Finished>(OWNER, REMOVE, [a.fileId, a.rowVersion])).status).toBe('removed');
      await markRemoved();
      await refused(OWNER, BEGIN, beginParams(), '55000', 'deal_removed');
      await refused(OWNER, FINISH, [pending.fileId, true], '55000', 'deal_removed');
      await refused(OWNER, DOWNLOAD, [b.fileId], '55000', 'deal_removed');
      // Nobody holds booking rights on a removed Deal any more: members get the honest token.
      await refused(OWNER, REMOVE, [b.fileId, b.rowVersion], '55000', 'deal_removed');
      await refused(OTHER_ENTITY, REMOVE, [b.fileId, b.rowVersion], '42501', 'not_authorized');
    });
  });

  it('lost Deal: begin refused; finish of an earlier upload, download and remove still work', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const lost = await h.insertRealDeal('UC_AD0SLH');
      const opened = await h.openDraft(OWNER, lost);
      await h.saveTravellers(OWNER, lost, opened.rowVersion, TRAVELLERS.slice(0, 1));
      const f = await storedFile(OWNER, { deal: lost });
      const pending = await begin(OWNER, { deal: lost });
      await putObject(pending.objectPath!);
      await owner(`update public.deals set source_stage_id = 'LOSE' where id = $1`, [lost]);
      await refused(OWNER, BEGIN, beginParams({ deal: lost }), '55000', 'deal_not_active');
      expect((await one<Finished>(OWNER, FINISH, [pending.fileId, true])).status).toBe('stored');
      expect((await one<{ mime: string }>(OWNER, DOWNLOAD, [f.fileId])).mime).toBe('image/jpeg');
      expect((await one<Finished>(OWNER, REMOVE, [f.fileId, f.rowVersion])).status).toBe('removed');
    });
  });
});

describe('viewers (DEC-41)', () => {
  it('Sales owner, sales assignee, branch Manager and Accounts view; only editors write; each view audited with the role', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      await h.addSalesAssignee(DEAL, U.salesDelhiB);
      const f = await storedFile(OWNER);
      await storedFile(SALES_B, { seq: 2 });
      await storedFile(MANAGER, { seq: 3 });
      for (const [actor, role] of [[OWNER, 'sales_owner'], [SALES_B, 'sales_assignee'], [MANAGER, 'manager'], [ACCOUNTS, 'accounts']] as const) {
        expect(await one(actor, DOWNLOAD, [f.fileId])).toEqual({ objectPath: expect.stringMatching(new RegExp(`/${f.fileId}$`)), fileName: NAME, mime: 'image/jpeg' });
        expect(await viewedRole(f.fileId)).toBe(role);
      }
      await refused(ACCOUNTS, BEGIN, beginParams({ seq: 4 }), '42501', 'not_authorized');
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.id_proof_viewed'`)).toBe(4);
      for (const actor of [OWNER, SALES_B, MANAGER]) {
        const travellers = await travellersOf(actor);
        expect(travellers.map((t) => t.idProofs?.length)).toEqual([1, 1, 1, 0]);
      }
    });
  });

  it('Accounts of the entity view without any Deal assignment or read grant (the Accounts Deal-detail gate); Accounts of another entity do not', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const f = await storedFile(OWNER);
      // Withdraw the fixture's entity-wide deal.read / deal.read_commercial grants: Accounts now holds only its role.
      await owner(`update public.access_grants set revoked_at = now(), revoked_by = $2, revocation_reason = 'Synthetic test revocation'
                   where user_id = $1 and revoked_at is null`, [U.accountsJodhpur, U.adminJodhpur]);
      await setActor(db, ACCOUNTS);
      const [readable] = await db.query<{ r: boolean }>('select exists (select 1 from public.deals where id = $1) as r', [DEAL]);
      await resetActor(db);
      expect(readable!.r).toBe(false); // the Deal is no longer readable to this Accounts user through the Data API
      const list = await one<{ travellers: Array<{ seq: number; idProofs: Array<{ fileId: string }> }> }>(ACCOUNTS,
        'select public.traveller_id_proofs_for_deal($1) as r', [DEAL]);
      expect(list.travellers[0]!.idProofs.map((x) => x.fileId)).toEqual([f.fileId]);
      expect((await one<{ mime: string }>(ACCOUNTS, DOWNLOAD, [f.fileId])).mime).toBe('image/jpeg');
      expect(await viewedRole(f.fileId)).toBe('accounts');
      // Accounts of another legal entity: nothing.
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'SB1'`, [U.salesEntityB]);
      await refused(OTHER_ENTITY, DOWNLOAD, [f.fileId], '42501', 'not_authorized');
      expect(await one(OTHER_ENTITY, 'select public.traveller_id_proofs_for_deal($1) as r', [DEAL])).toBeNull();
    });
  });

  it('unlinked staff get nothing: Purchase, Flight and the desk without a task, Super Admin, other branch, other entity, anon', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      await h.addFlight();
      const f = await storedFile();
      for (const actor of [PURCHASE, FLIGHT, DESK, SUPER, SALES_AMD, OTHER_ENTITY]) {
        await refused(actor, BEGIN, beginParams(), '42501', 'not_authorized');
        await refused(actor, DOWNLOAD, [f.fileId], '42501', 'not_authorized');
        await refused(actor, REMOVE, [f.fileId, f.rowVersion], '42501', 'not_authorized');
        const r = await h.run<{ r: Record<string, unknown> | null }>(actor, 'select public.booking_form_get($1) as r', [DEAL]);
        expect(r[0]!.r).toBeNull();
      }
      await expectDbError(db, () => h.run(ANON, DOWNLOAD, [f.fileId]), { code: '42501' });
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.id_proof_viewed'`)).toBe(0);
    });
  });

  it('Visa desk and Purchase assignees of a task on the Deal view and list their travellers; not before the claim, not on another Deal', async () => {
    await asOwner(db, async () => {
      const desk = await h.deskTask(); // hotel + visa confirmed, proofs stored by completeB11, desk switch on
      const [proof] = await owner<{ id: string }>(
        `select f.id from public.traveller_id_proofs f join public.deal_travellers t on t.id = f.traveller_id
         where f.deal_id = $1 and t.seq = 1 and f.status = 'stored'`, [DEAL]);
      await refused(DESK, DOWNLOAD, [proof!.id], '42501', 'not_authorized');
      expect(await one(DESK, FOR_TASK, [desk.taskId])).toBeNull();
      await one(DESK, VISA_CLAIM_SQL, [desk.taskId]);
      await one(DESK, DOWNLOAD, [proof!.id]);
      expect(await viewedRole(proof!.id)).toBe('visa_assignee');
      const deskList = await one<{ taskId: string; travellers: Array<{ seq: number; fullName: string; idProofs: Array<Record<string, unknown>> }> }>(
        DESK, FOR_TASK, [desk.taskId]);
      expect(deskList.taskId).toBe(desk.taskId);
      expect(deskList.travellers.map((t) => t.seq)).toEqual(TRAVELLERS.map((t) => t.seq));
      expect(Object.keys(deskList.travellers[0]!.idProofs[0]!).sort()).toEqual(['fileId', 'fileName', 'mime', 'sizeBytes', 'storedAt']);

      await refused(PURCHASE, DOWNLOAD, [proof!.id], '42501', 'not_authorized');
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [desk.hotelTaskId]);
      await one(PURCHASE, DOWNLOAD, [proof!.id]);
      expect(await viewedRole(proof!.id)).toBe('purchase_assignee');
      expect((await one<{ travellers: unknown[] }>(PURCHASE, FOR_TASK, [desk.hotelTaskId])).travellers).toHaveLength(TRAVELLERS.length);
      // Another person's task is not theirs; the Manager sees both; Accounts, Super Admin and Sales get no task list.
      expect(await one(PURCHASE, FOR_TASK, [desk.taskId])).toBeNull();
      expect(await one(MANAGER, FOR_TASK, [desk.taskId])).not.toBeNull();
      for (const actor of [ACCOUNTS, SUPER, OWNER]) expect(await one(actor, FOR_TASK, [desk.taskId])).toBeNull();
      // Another Deal: neither has a task there.
      await h.draftWithTravellers(SALES_B, DEAL2);
      const other = await storedFile(SALES_B, { deal: DEAL2 });
      await refused(DESK, DOWNLOAD, [other.fileId], '42501', 'not_authorized');
      await refused(PURCHASE, DOWNLOAD, [other.fileId], '42501', 'not_authorized');
    });
  });

  it('Flight assignee views on a domestic trip too (any task of the Deal; recorded choice); writers stay editors', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel', 'flight']);
      await h.confirm(OWNER, ready.versionId, ready.hash);
      await h.addFlight();
      const [flightTask] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]);
      const [proof] = await owner<{ id: string }>(`select id from public.traveller_id_proofs where deal_id = $1 and status = 'stored' limit 1`, [DEAL]);
      await refused(FLIGHT, DOWNLOAD, [proof!.id], '42501', 'not_authorized');
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [flightTask!.id]);
      await one(FLIGHT, DOWNLOAD, [proof!.id]);
      expect(await viewedRole(proof!.id)).toBe('flight_assignee');
      expect((await one<{ travellers: unknown[] }>(FLIGHT, FOR_TASK, [flightTask!.id])).travellers).toHaveLength(TRAVELLERS.length);
      await refused(FLIGHT, BEGIN, beginParams(), '42501', 'not_authorized');
    });
  });
});

describe('a proof never moves to another person', () => {
  it('renumbering after a removal detaches the renamed and the deleted traveller proofs; same-person saves keep them', async () => {
    await asOwner(db, async () => {
      const travellers = [
        { fullName: 'Synthetic Person A', type: 'adult', seq: 1 },
        { fullName: 'Synthetic Person B', type: 'adult', seq: 2 },
        { fullName: 'Synthetic Person C', type: 'adult', seq: 3 },
      ];
      const d = await h.draftWithTravellers(OWNER, DEAL, travellers);
      const a = await storedFile(OWNER, { seq: 1 });
      const b = await storedFile(OWNER, { seq: 2 });
      const c = await storedFile(OWNER, { seq: 3 });
      // Same person: spacing and case of the name, or the type, change nothing.
      let rv = (await h.saveTravellers(OWNER, DEAL, d.rowVersion,
        [{ ...travellers[0]!, fullName: 'synthetic  person a' }, { ...travellers[1]!, type: 'child', ageYears: 12 }, travellers[2]!])).rowVersion;
      rv = (await h.saveTravellers(OWNER, DEAL, rv, travellers)).rowVersion;
      expect(await h.count(`select 1 from public.traveller_id_proofs where status = 'removed'`)).toBe(0);
      // The form removes B and numbers by position: C is sent as seq 2.
      rv = (await h.saveTravellers(OWNER, DEAL, rv, [travellers[0]!, { ...travellers[2]!, seq: 2 }])).rowVersion;
      const rows = await owner<{ id: string; status: string; removed_reason: string | null }>(
        'select id, status, removed_reason from public.traveller_id_proofs');
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[a.fileId]).toMatchObject({ status: 'stored', removed_reason: null });
      expect(byId[b.fileId]).toMatchObject({ status: 'removed', removed_reason: 'traveller_changed' });
      expect(byId[c.fileId]).toMatchObject({ status: 'removed', removed_reason: 'traveller_removed' });
      const view = await travellersOf();
      expect(view.map((t) => [t.seq, t.fullName, t.idProofs?.map((p) => p.fileId)])).toEqual([
        [1, 'Synthetic Person A', [a.fileId]],
        [2, 'Synthetic Person C', []],
      ]);
      const detached = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.id_proof_detached' order by details ->> 'reason'`);
      expect(detached.map((x) => x.details)).toEqual([
        { dealId: DEAL, fileId: b.fileId, reason: 'traveller_changed' },
        { dealId: DEAL, fileId: c.fileId, reason: 'traveller_removed' },
      ]);
      await refused(OWNER, DOWNLOAD, [b.fileId], 'P0002', 'not_found');
      expect((await checklist()).items.find((i) => i.code === 'id_proof_missing')).toMatchObject({ blocking: true, travellerSeqs: [2] });
      expect(rv).toBeGreaterThan(d.rowVersion);
    });
  });
});

describe('readiness and checklist (DEC-38)', () => {
  it('adults block, children warn; a hash taken before the proofs confirms only once they exist; confirmed versions are not re-checked', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel', 'transfer']);
      const proofs = await owner<{ id: string; seq: number; row_version: number }>(
        `select f.id, t.seq, f.row_version from public.traveller_id_proofs f join public.deal_travellers t on t.id = f.traveller_id
         where f.deal_id = $1 and f.status = 'stored' order by t.seq`, [DEAL]);
      expect(proofs.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
      const versionRow = () => owner('select row_version, content_hash from public.booking_versions where id = $1', [ready.versionId]);
      const before = await versionRow();
      // Child (seq 4) without proof: warning only.
      await one(OWNER, REMOVE, [proofs[3]!.id, proofs[3]!.row_version]);
      let list = await checklist();
      expect(list.items.find((i) => i.code === 'id_proof_missing_child')).toMatchObject({ blocking: false, travellerSeqs: [4] });
      expect(list.canConfirm).toBe(true);
      expect((await h.readiness(OWNER, ready.versionId)).issues).toEqual([]);
      // Adult (seq 2) without proof: blocks, and the earlier hash cannot confirm.
      await one(OWNER, REMOVE, [proofs[1]!.id, proofs[1]!.row_version]);
      expect(await h.readiness(OWNER, ready.versionId)).toMatchObject({ ready: false, issues: ['id_proof_missing'], contentHash: ready.hash });
      list = await checklist();
      expect(list.items.find((i) => i.code === 'id_proof_missing')).toMatchObject({ blocking: true, travellerSeqs: [2] });
      expect(list.canConfirm).toBe(false);
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [ready.versionId, ready.hash], '55000', 'not_ready');
      expect(await versionRow()).toEqual(before);
      // A new proof: the same hash now confirms (proofs are never hashed).
      await storeIdProof(OWNER, DEAL, 2);
      expect(await versionRow()).toEqual(before);
      expect((await h.confirm(OWNER, ready.versionId, ready.hash)).versionId).toBe(ready.versionId);
      // After confirmation: removing a proof re-checks nothing on the confirmed version.
      const [again] = await owner<{ id: string; row_version: number }>(
        `select f.id, f.row_version from public.traveller_id_proofs f join public.deal_travellers t on t.id = f.traveller_id
         where f.deal_id = $1 and t.seq = 1 and f.status = 'stored'`, [DEAL]);
      await one(OWNER, REMOVE, [again!.id, again!.row_version]);
      expect((await h.readiness(OWNER, ready.versionId)).issues).not.toContain('id_proof_missing');
      expect((await checklist()).items.map((i) => i.code)).not.toContain('id_proof_missing');
      // Attach after confirmation: allowed; the confirmed hash still recomputes equal.
      await storeIdProof(OWNER, DEAL, 1);
      expect(await owner('select v.content_hash as stored, authz.booking_content_hash(v.id) as recomputed from public.booking_versions v where v.id = $1',
        [ready.versionId])).toEqual([{ stored: ready.hash, recomputed: ready.hash }]);
    });
  });
});

describe('booking_form_get', () => {
  it('per-traveller idProofs (open files, frozen shape) and idProofLimits', async () => {
    await asOwner(db, async () => {
      await h.draftWithTravellers();
      const stored = await storedFile(OWNER);
      const pending = await begin(MANAGER, { mime: 'application/pdf', name: 'back.pdf', size: 2048 });
      const gone = await storedFile(OWNER);
      await one(OWNER, REMOVE, [gone.fileId, gone.rowVersion]);
      const failed = await begin(OWNER);
      await one(OWNER, FINISH, [failed.fileId, true]); // no object → failed: never listed (review D2-1)
      const f = await form(OWNER);
      expect(f!.idProofLimits).toEqual({ maxFilesPerTraveller: 4, maxBytes: 4194304 });
      expect(f!.idProofCanEdit).toBe(true);
      const first = (f!.travellers as FormTraveller[])[0]!.idProofs!;
      expect(first).toHaveLength(2);
      expect(first.find((p) => p.fileId === stored.fileId)).toEqual({
        fileId: stored.fileId, fileName: NAME, mime: 'image/jpeg', sizeBytes: 4096, status: 'stored', rowVersion: 2,
        uploadedByName: expect.any(String), uploadedByYou: true, consentByName: expect.any(String), consentAt: expect.any(String),
        createdAt: expect.any(String), storedAt: expect.any(String),
      });
      expect(first.find((p) => p.fileId === pending.fileId)).toMatchObject({ status: 'pending_upload', rowVersion: 1, uploadedByYou: false, storedAt: null });
      expect((f!.travellers as FormTraveller[])[1]!.idProofs).toEqual([]);
    });
  });

  it('a draft saved before this migration loads unchanged: the old body gives the same JSON minus the new keys', async () => {
    await asOwner(db, async () => {
      const source = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'migrations', '20261119000100_b11_book_now.sql'), 'utf8');
      const start = source.indexOf('create function public.booking_form_get(p_deal_id uuid)');
      const end = source.indexOf('\n$$;', start);
      expect(start).toBeGreaterThan(0);
      await owner(source.slice(start, end + 4).replace('public.booking_form_get(', 'public.b11_booking_form_get_before_b12('));
      await owner('grant execute on function public.b11_booking_form_get_before_b12(uuid) to authenticated');
      await h.addSalesAssignee(DEAL, U.salesDelhiB);
      await h.readyPackage(OWNER, DEAL, ['hotel', 'transfer', 'flight']);
      let compared = 0;
      for (const actor of [OWNER, MANAGER, SALES_B, PURCHASE, ACCOUNTS, SUPER]) {
        const now = (await h.run<{ r: Record<string, unknown> | null }>(actor, 'select public.booking_form_get($1) as r', [DEAL]))[0]!.r;
        const before = (await h.run<{ r: Record<string, unknown> | null }>(actor, 'select public.b11_booking_form_get_before_b12($1) as r', [DEAL]))[0]!.r;
        if (before === null) {
          expect(now).toBeNull();
          continue;
        }
        compared += 1;
        // sourceQuotation: added by 20261120000200 (null for a draft not converted from a quotation).
        // prefill: added by 20261120000600 (Bitrix values; unavailable here).
        // Booking form keys: added by 20261124000120 (stripped here; covered by booking-form-*.test.ts).
        const { idProofLimits, idProofCanEdit, idProofCanRemove, sourceQuotation, prefill, travellers, ...rest } =
          stripBookingFormKeys(now!);
        expect(sourceQuotation).toBeNull();
        expect(prefill).toMatchObject({ available: false });
        expect(typeof idProofCanEdit).toBe('boolean');
        expect(typeof idProofCanRemove).toBe('boolean');
        const { travellers: oldTravellers, ...oldRestRaw } = before;
        // Book now v2 review round 1: purchaseBudgetPaise reaches booking-form readers only with
        // commercial access (the budget can now equal the "Our cost" estimate), so it is dropped
        // from the old body for readers that no longer receive it.
        const oldRest = JSON.stringify(rest).includes('"purchaseBudgetPaise"')
          ? oldRestRaw
          : (JSON.parse(JSON.stringify(oldRestRaw, (k, v) => (k === 'purchaseBudgetPaise' ? undefined : v))) as typeof oldRestRaw);
        expect(rest).toEqual(oldRest);
        expect(idProofLimits).toBeDefined();
        const stripped = (travellers as Array<Record<string, unknown>>).map(({ idProofs, ...t }) => {
          expect(Array.isArray(idProofs)).toBe(true);
          return t;
        });
        expect(stripped).toEqual(oldTravellers);
      }
      expect(compared).toBe(3);
    });
  });
});

describe('idProofCanEdit and traveller_id_proofs_for_deal (review D2-3, D2-5)', () => {
  it('idProofCanEdit follows attach rights: editors yes (also after submission); switch off, lost Deal no', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel']);
      expect((await form(OWNER))!.idProofCanEdit).toBe(true);
      expect((await form(MANAGER))!.idProofCanEdit).toBe(true);
      await h.confirm(OWNER, ready.versionId, ready.hash);
      const after = await form(OWNER);
      expect(after).toMatchObject({ canEdit: false, idProofCanEdit: true, idProofCanRemove: true });
      await h.setSwitch('service_items_enabled', false);
      // Review D3-5: removing stays possible while attaching is paused.
      expect(await form(OWNER)).toMatchObject({ idProofCanEdit: false, idProofCanRemove: true });
    });
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const lost = await h.insertRealDeal('UC_AD0SLH');
      await h.openDraft(OWNER, lost);
      expect((await form(OWNER, lost))!.idProofCanEdit).toBe(true);
      await owner(`update public.deals set source_stage_id = 'LOSE' where id = $1`, [lost]);
      expect(await form(OWNER, lost)).toMatchObject({ idProofCanEdit: false, idProofCanRemove: true });
    });
  });

  it('every DEC-41 viewer incl. Accounts reads stored proofs per traveller; unlinked staff and removed Deals get null', async () => {
    await asOwner(db, async () => {
      const desk = await h.deskTask();
      const extra = await begin(OWNER, { seq: 2 }); // pending: not listed for viewers
      for (const actor of [OWNER, MANAGER, ACCOUNTS]) {
        const r = await one<DealProofs>(actor, FOR_DEAL, [DEAL]);
        expect(r.dealId).toBe(DEAL);
        expect(r.travellers.map((t) => [t.seq, t.idProofs.length])).toEqual(TRAVELLERS.map((t) => [t.seq, 1]));
        expect(Object.keys(r.travellers[0]!.idProofs[0]!).sort()).toEqual(['fileId', 'fileName', 'mime', 'sizeBytes', 'storedAt']);
        expect(JSON.stringify(r)).not.toContain(extra.fileId);
      }
      for (const actor of [PURCHASE, DESK, SUPER, SALES_AMD, OTHER_ENTITY]) expect(await one(actor, FOR_DEAL, [DEAL])).toBeNull();
      await one(DESK, VISA_CLAIM_SQL, [desk.taskId]);
      expect(await one(DESK, FOR_DEAL, [DEAL])).not.toBeNull();
      // Accounts may download what it can list.
      const listed = await one<DealProofs>(ACCOUNTS, FOR_DEAL, [DEAL]);
      const fileId = listed.travellers[0]!.idProofs[0]!.fileId as string;
      await one(ACCOUNTS, DOWNLOAD, [fileId]);
      expect(await viewedRole(fileId)).toBe('accounts');
      await markRemoved();
      expect(await one(MANAGER, FOR_DEAL, [DEAL])).toBeNull();
      // Review D3-4: no proof metadata in any read of a removed Deal.
      expect(await one(DESK, FOR_TASK, [desk.taskId])).toBeNull();
      expect(await one(MANAGER, FOR_TASK, [desk.taskId])).toBeNull();
      for (const actor of [OWNER, MANAGER]) {
        const removedForm = await form(actor);
        if (removedForm !== null) {
          expect((removedForm.travellers as FormTraveller[]).every((t) => t.idProofs === undefined)).toBe(true);
          expect(removedForm.idProofCanEdit).toBe(false);
          expect(removedForm.idProofCanRemove).toBe(false);
        }
      }
    });
  });
});

describe('revision drafts (DEC-38)', () => {
  it('a revision draft needs adult proofs again only when one is missing; the confirmed base is never re-checked', async () => {
    await asOwner(db, async () => {
      const base = await h.readyDraft(OWNER, DEAL, [['hotel', HOTEL]]);
      expect(base.issues).toEqual([]);
      await h.confirm(OWNER, base.versionId, base.hash);
      await one(ACCOUNTS, 'select public.accounts_review_return($1, $2, $3) as r', [base.versionId, 'Synthetic return for the revision test', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [base.versionId]);
      expect((await h.readiness(OWNER, opened.versionId)).issues).not.toContain('id_proof_missing');
      const [adult] = await owner<{ id: string; row_version: number }>(
        `select f.id, f.row_version from public.traveller_id_proofs f join public.deal_travellers t on t.id = f.traveller_id
         where f.deal_id = $1 and t.seq = 1 and f.status = 'stored'`, [DEAL]);
      await one(OWNER, REMOVE, [adult!.id, adult!.row_version]);
      expect((await h.readiness(OWNER, opened.versionId)).issues).toContain('id_proof_missing');
      expect((await checklist()).items.find((i) => i.code === 'id_proof_missing')).toMatchObject({ blocking: true, travellerSeqs: [1] });
      expect((await h.readiness(OWNER, base.versionId)).issues).not.toContain('id_proof_missing');
      await storeIdProof(OWNER, DEAL, 1);
      expect((await h.readiness(OWNER, opened.versionId)).issues).not.toContain('id_proof_missing');
    });
  });
});

describe('never in any other read (review D1-10)', () => {
  it('no file id, object path or file name appears in Deal, department, desk, Accounts or admin reads', async () => {
    await asOwner(db, async () => {
      const desk = await h.deskTask();
      await one(DESK, VISA_CLAIM_SQL, [desk.taskId]);
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [desk.hotelTaskId]);
      const files = await owner<{ id: string; object_path: string; file_name: string }>('select id, object_path, file_name from public.traveller_id_proofs');
      expect(files.length).toBeGreaterThan(0);
      const needles = files.flatMap((f) => [f.id, f.object_path, f.file_name]);
      const reads: Array<[Actor, string, unknown[]]> = [
        [OWNER, 'select public.deal_services($1) as r', [DEAL]],
        [OWNER, 'select public.booking_panel($1) as r', [DEAL]],
        [OWNER, CHECKLIST_SQL, [DEAL]],
        [OWNER, 'select public.booking_version_history($1) as r', [DEAL]],
        [PURCHASE, 'select public.purchase_task_get($1) as r', [desk.hotelTaskId]],
        [PURCHASE, 'select public.purchase_task_list() as r', []],
        [PURCHASE, 'select public.department_work_form($1) as r', [desk.hotelTaskId]],
        [DESK, 'select public.visa_task_get($1) as r', [desk.taskId]],
        [DESK, 'select public.visa_task_list() as r', []],
        [DESK, 'select public.department_work_form($1) as r', [desk.taskId]],
        [DESK, 'select public.deal_services($1) as r', [DEAL]],
        [ACCOUNTS, 'select public.accounts_deal_detail($1) as r', [DEAL]],
        [ACCOUNTS, 'select public.my_work_counts() as r', []],
        [SUPER, 'select public.booking_health() as r', []],
      ];
      for (const [actor, sql, params] of reads) {
        const json = JSON.stringify(await h.run(actor, sql, params));
        for (const needle of needles) expect(json.includes(needle), `${sql} leaks ${needle}`).toBe(false);
      }
    });
  });
});

/** Refusal 22023 invalid_input with the given hint. */
async function expectHint(actor: Actor, sql: string, params: unknown[], hint: string): Promise<void> {
  await db.exec('savepoint b12_hint');
  let error: { code?: string; message?: string; hint?: string } | undefined;
  try {
    await h.run(actor, sql, params);
  } catch (e) {
    error = e as typeof error;
    await db.exec('rollback to savepoint b12_hint');
  }
  expect(error).toMatchObject({ code: '22023', message: 'invalid_input', hint });
}
