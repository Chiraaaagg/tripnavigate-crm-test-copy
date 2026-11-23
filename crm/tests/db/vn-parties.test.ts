import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, DEAL, DEAL_AMD, MANAGER, MANAGER_AMD, OWNER, PURCHASE, SALES_AMD, SALES_B, SUPER } from './b1-support';
import { BUSINESS, PERSONAL, SQL, rid, vnHelpers } from './vn-support';

/**
 * Voice-note batch, migration 20261128000130: bill-to parties. Access per role
 * (Sales and Manager of the party's branch, Accounts of the entity; never
 * Purchase, Super Admin by role or another branch), create from a booking,
 * Sales edit, Accounts edit / check / return with a reason, the copy into a
 * Deal's billing (a snapshot that later party edits never change), private
 * documents with consent, audit rows.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = vnHelpers(() => db);
const { one, owner, refused, refusedWithHint } = h;

type Created = { partyId: string; rowVersion: number; checkStatus: string; outcome: string };
type Saved = { rowVersion: number; checkStatus: string; outcome: string };
const create = (fields: unknown, actor: Actor = OWNER, deal: string = DEAL, requestId = rid()) =>
  one<Created>(actor, SQL.partyCreate, [deal, JSON.stringify(fields), requestId]);
const get = (actor: Actor, id: string) => one<(Record<string, unknown> & { documents: unknown[] }) | null>(actor, SQL.partyGet, [id]);
const search = (actor: Actor, q: string, deal: string | null = null) =>
  one<{ items: Array<{ id: string; name: string }>; hasMore: boolean }>(actor, SQL.partySearch, [q, deal, 20, 0]);
const billing = () => owner<Record<string, unknown>>(
  `select billing_name, address_line1, city, state_code, postal_code, gstin, bill_to_type, contact_person, phone, email,
          gst_status, gst_reason, status, party_id is not null as has_party
   from public.customer_billing_profiles where deal_id = $1`, [DEAL]).then((r) => r[0]);

describe('create and read', () => {
  it('a booking editor creates parties in the Deal branch (never checked); the field rule names keys; retries are idempotent', async () => {
    await asOwner(db, async () => {
      const req = rid();
      const p = await create(PERSONAL, OWNER, DEAL, req);
      expect(p).toMatchObject({ rowVersion: 1, checkStatus: 'not_checked', outcome: 'created' });
      expect(await create(PERSONAL, OWNER, DEAL, req)).toMatchObject({ partyId: p.partyId, outcome: 'existing' });
      await refused(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...PERSONAL, name: 'Other' }), req], '40001', 'request_conflict');
      const b = await create(BUSINESS);
      expect(await owner('select branch_id = (select branch_id from public.deals where id = $2) as same, check_status from public.customer_parties where id = $1',
        [b.partyId, DEAL])).toEqual([{ same: true, check_status: 'not_checked' }]);
      await refusedWithHint(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...BUSINESS, gstStatus: null, gstin: null }), rid()], /^gstStatus$/);
      await refusedWithHint(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...BUSINESS, stateCode: '27' }), rid()], /^gstin$/);
      await refusedWithHint(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...BUSINESS, gstStatus: 'unregistered', gstin: null, gstReason: 'short' }), rid()],
        /^gstReason$/);
      await refusedWithHint(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...PERSONAL, gstin: '08ABCDE1234F1Z5', phone: '123', postalCode: '012345' }), rid()],
        /^gstStatus,phone,postalCode$/);
      await refusedWithHint(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...PERSONAL, sourceRef: 'X1' }), rid()], /^fields$/);
      for (const actor of [SALES_B, ACCOUNTS, PURCHASE, SUPER, SALES_AMD] as Actor[]) {
        await refused(actor, SQL.partyCreate, [DEAL, JSON.stringify(PERSONAL), rid()], '42501', 'not_authorized');
      }
      await refused(ANON, SQL.partyCreate, [DEAL, JSON.stringify(PERSONAL), rid()], '42501');
      const audit = await h.auditRows('party.created');
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain(PERSONAL.phone);
      expect(audit[0]!.details).toMatchObject({ dealId: DEAL, partyType: 'personal' });
    });
  });

  it('readers: Sales and Manager of the branch and Accounts; never Purchase, Super Admin or another branch', async () => {
    await asOwner(db, async () => {
      const p = await create(PERSONAL);
      for (const actor of [OWNER, SALES_B, MANAGER, ACCOUNTS] as Actor[]) {
        expect(await get(actor, p.partyId)).toMatchObject({ id: p.partyId, name: PERSONAL.name, checkStatus: 'not_checked' });
        expect((await search(actor, 'synthetic per')).items.map((x) => x.id)).toEqual([p.partyId]);
      }
      for (const actor of [PURCHASE, SUPER, SALES_AMD, MANAGER_AMD] as Actor[]) {
        expect(await get(actor, p.partyId)).toBeNull();
        expect((await search(actor, 'synthetic per')).items).toEqual([]);
      }
      await refused(ANON, SQL.partyGet, [p.partyId], '42501');
      // Search by phone digits and by GSTIN prefix; a Deal limits it to that Deal's branch.
      const b = await create(BUSINESS);
      expect((await search(OWNER, '0021')).items.map((x) => x.id)).toEqual([p.partyId]);
      expect((await search(OWNER, '08abcde')).items.map((x) => x.id)).toEqual([b.partyId]);
      expect((await search(OWNER, 'synthetic', DEAL)).items).toHaveLength(2);
      await refused(SALES_AMD, SQL.partySearch, ['synthetic', DEAL, 20, 0], '42501');
      await refused(PURCHASE, SQL.partySearch, ['synthetic', DEAL, 20, 0], '42501');
      expect((await search(SALES_AMD, 'synthetic', DEAL_AMD)).items).toEqual([]);
      // Get answers what the caller may do.
      expect(await get(OWNER, p.partyId)).toMatchObject({ canEdit: true, canAccountsEdit: false, canCheck: false });
      expect(await get(ACCOUNTS, p.partyId)).toMatchObject({ canEdit: false, canAccountsEdit: true, canCheck: true });
    });
  });
});

describe('Sales edit, Accounts edit / check / return', () => {
  it('runs the check cycle with reasons, refuses Sales edits of a checked party and audits every step', async () => {
    await asOwner(db, async () => {
      const p = await create(PERSONAL);
      let s = await one<Saved>(OWNER, SQL.partySave, [p.partyId, 1, JSON.stringify({ city: 'Jaipur' })]);
      expect(s).toEqual({ rowVersion: 2, checkStatus: 'not_checked', outcome: 'updated' });
      await refused(OWNER, SQL.partyCheck, [p.partyId, 2, 'checked', null], '42501', 'not_authorized');
      await refused(SUPER, SQL.partyCheck, [p.partyId, 2, 'checked', null], '42501', 'not_authorized');
      await refused(ACCOUNTS, SQL.partyCheck, [p.partyId, 2, 'returned', null], '22023', 'invalid_input');
      s = await one<Saved>(ACCOUNTS, SQL.partyCheck, [p.partyId, 2, 'returned', 'Synthetic: address does not match ID']);
      expect(s).toMatchObject({ checkStatus: 'returned', rowVersion: 3 });
      expect(await get(OWNER, p.partyId)).toMatchObject({ checkStatus: 'returned', checkReason: 'Synthetic: address does not match ID' });
      s = await one<Saved>(OWNER, SQL.partySave, [p.partyId, 3, JSON.stringify({ addressLine1: '9 Synthetic Lane' })]);
      expect(s).toMatchObject({ checkStatus: 'not_checked', rowVersion: 4 });
      expect(await get(OWNER, p.partyId)).toMatchObject({ checkReason: null });
      // The same Accounts person edits and checks (owner answer 4).
      s = await one<Saved>(ACCOUNTS, SQL.partyAccountsSave, [p.partyId, 4, JSON.stringify({ email: 'fixed@example.test' }), 'Synthetic fix']);
      expect(s).toMatchObject({ checkStatus: 'not_checked', rowVersion: 5 });
      s = await one<Saved>(ACCOUNTS, SQL.partyCheck, [p.partyId, 5, 'checked', null]);
      expect(s).toMatchObject({ checkStatus: 'checked', rowVersion: 6 });
      expect(await get(ACCOUNTS, p.partyId)).toMatchObject({ checkStatus: 'checked', checkedByName: expect.any(String) });
      await refused(OWNER, SQL.partySave, [p.partyId, 6, JSON.stringify({ city: 'Delhi' })], '55000', 'party_checked');
      await refused(ACCOUNTS, SQL.partyCheck, [p.partyId, 5, 'checked', null], '40001', 'version_changed');
      s = await one<Saved>(ACCOUNTS, SQL.partyAccountsSave, [p.partyId, 6, JSON.stringify({ city: 'Delhi' }), null]);
      expect(s).toMatchObject({ checkStatus: 'not_checked' });
      expect((await h.auditRows('party.returned'))[0]).toMatchObject({ reason: 'Synthetic: address does not match ID' });
      expect(await h.auditRows('party.checked')).toHaveLength(1);
      expect((await h.auditRows('party.updated')).map((a) => a.details.changedFields)).toEqual([['city'], ['addressLine1']]);
      expect((await h.auditRows('party.accounts_updated')).map((a) => a.details.changedFields)).toEqual([['email'], ['city']]);
      // Accounts list.
      const q = await one<{ items: Array<{ id: string }> }>(ACCOUNTS, SQL.partyQueue, ['not_checked', 50, 0]);
      expect(q.items.map((x) => x.id)).toEqual([p.partyId]);
      for (const actor of [OWNER, MANAGER, PURCHASE, SUPER] as Actor[]) await refused(actor, SQL.partyQueue, ['not_checked', 50, 0], '42501');
      await refused(ACCOUNTS, 'delete from public.customer_parties', [], '42501');
    });
  });

  it('a check needs the full rule (business without GST status is incomplete)', async () => {
    await asOwner(db, async () => {
      const b = await create(BUSINESS);
      await owner(`update public.customer_parties set gst_status = null, gstin = null where id = $1`, [b.partyId]);
      await refused(ACCOUNTS, SQL.partyCheck, [b.partyId, 1, 'checked', null], '22023', 'party_incomplete');
    });
  });
});

describe('Bill To: select a party into the booking', () => {
  it('copies the party into the Deal billing and keeps the reference; later party edits never change it', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      const b = await create(BUSINESS);
      const req = rid();
      const r = await one<Record<string, unknown>>(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, b.partyId, 0, req]);
      expect(r).toMatchObject({ partyId: b.partyId, billing: { outcome: 'created', status: 'draft', rowVersion: 1 } });
      expect(await one(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, b.partyId, 0, req])).toMatchObject({ outcome: 'existing' });
      const before = await billing();
      expect(before).toEqual({ billing_name: BUSINESS.name, address_line1: BUSINESS.addressLine1, city: 'Jodhpur', state_code: '08',
        postal_code: '342001', gstin: BUSINESS.gstin, bill_to_type: 'business', contact_person: BUSINESS.contactPerson,
        phone: BUSINESS.phone, email: BUSINESS.email, gst_status: 'registered', gst_reason: null, status: 'draft', has_party: true });
      await one(ACCOUNTS, SQL.partyAccountsSave, [b.partyId, 1, JSON.stringify({ name: 'Synthetic Renamed Pvt Ltd', city: 'Delhi' }), null]);
      expect(await billing()).toEqual(before);
      expect(await h.auditRows('booking.bill_to_party_selected')).toHaveLength(1);
      // The form keeps the reference and shows the party's current check state.
      expect(((await h.form(OWNER))!.billing as Record<string, unknown>)).toMatchObject({ partyId: b.partyId, partyCheckStatus: 'not_checked',
        billingName: BUSINESS.name });
      // The party shows its history and where it was used (Deals the reader may open; no money).
      const party = (await get(ACCOUNTS, b.partyId))!;
      expect((party.history as Array<{ action: string }>).map((x) => x.action)).toEqual(['party.accounts_updated', 'party.created']);
      expect(party.usedOn).toEqual([expect.objectContaining({ dealId: DEAL, reference: 'SYN-DEL-001' })]);
      expect(JSON.stringify(party.usedOn)).not.toMatch(/paise|selling|amount/i);
      expect(((await get(SALES_B, b.partyId))!.usedOn as unknown[])).toEqual([]);
    });
  });

  it('refuses a returned party, an incomplete party and a party of another branch', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      const p = await create(PERSONAL);
      await one(ACCOUNTS, SQL.partyCheck, [p.partyId, 1, 'returned', 'Synthetic: please recheck the ID']);
      await refused(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, p.partyId, 0, rid()], '55000', 'party_returned');
      const bare = await create({ partyType: 'personal', name: 'Synthetic No Address', phone: '9876500055' });
      await refused(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, bare.partyId, 0, rid()], '22023', 'party_incomplete');
      await db.exec('savepoint incomplete');
      try {
        await one(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, bare.partyId, 0, rid()]);
        throw new Error('expected a refusal');
      } catch (e) {
        await db.exec('rollback to savepoint incomplete');
        expect((e as { hint?: string }).hint).toBe('addressLine1,city,stateCode,postalCode');
      }
      const amdParty = await create(PERSONAL, SALES_AMD, DEAL_AMD);
      await refused(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, amdParty.partyId, 0, rid()], 'P0002', 'not_found');
      await refused(PURCHASE, SQL.selectParty, [d.versionId, d.rowVersion, p.partyId, 0, rid()], '42501');
    });
  });
});

describe('party documents', () => {
  it('consent for an ID file, kinds by party type, limit, audited views; Purchase refused', async () => {
    await asOwner(db, async () => {
      const p = await create(PERSONAL);
      const file = (kind: string, consent: boolean, req = rid()) =>
        [p.partyId, kind, req, consent, 'synthetic id.pdf', 'application/pdf', 2048, 'c'.repeat(64)];
      await refused(OWNER, SQL.docBegin, file('id_proof', false), '22023', 'consent_required');
      await refused(OWNER, SQL.docBegin, file('gst_certificate', true), '22023', 'invalid_input');
      await refused(PURCHASE, SQL.docBegin, file('id_proof', true), '42501');
      await refused(SALES_AMD, SQL.docBegin, file('id_proof', true), '42501');
      const begun = await one<{ fileId: string; objectPath: string; status: string }>(OWNER, SQL.docBegin, file('id_proof', true));
      expect(begun.objectPath.endsWith(`/${p.partyId}/${begun.fileId}`)).toBe(true);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('customer-party-documents', $1, jsonb_build_object('size', 2048::bigint))`,
        [begun.objectPath]);
      expect(await one(OWNER, SQL.docFinish, [begun.fileId, true])).toMatchObject({ status: 'stored' });
      expect(await one(ACCOUNTS, SQL.docDownload, [begun.fileId])).toMatchObject({ objectPath: begun.objectPath });
      await refused(PURCHASE, SQL.docDownload, [begun.fileId], '42501');
      await refused(SUPER, SQL.docDownload, [begun.fileId], '42501');
      expect((await h.auditRows('party.document_viewed'))[0]!.details).toMatchObject({ viewerRole: 'accounts', kind: 'id_proof' });
      expect(JSON.stringify(await h.auditRows('party.document_started'))).not.toContain('synthetic id');
      for (let i = 0; i < 5; i += 1) await one(OWNER, SQL.docBegin, file('other', false));
      await refused(OWNER, SQL.docBegin, file('other', false), '55000', 'party_doc_limit');
      expect((await get(OWNER, p.partyId))!.documents).toHaveLength(6);
      expect(await h.auditRows('party.check_reset')).toEqual([]);
      const removed = await one<{ status: string }>(ACCOUNTS, SQL.docRemove, [begun.fileId, 2]);
      expect(removed.status).toBe('removed');
      await refused(OWNER, 'delete from public.customer_party_documents', [], '42501');
    });
  });
});

describe('no anonymous execute', () => {
  it('every public party function refuses an anonymous caller', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ fn: string; anon: boolean; pub: boolean }>(
        `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'authz') and (p.proname like 'customer_party%' or p.proname like 'import_batch%'
           or p.proname like 'hotel_catalogue%' or p.proname like 'vn\\_%' or p.proname in ('booking_bill_to_select_party',
           'customer_party_accounts_list', 'booking_trip_facts', 'bitrix_destination_options', 'bitrix_destination_scope_set',
           'integration_set_bitrix_trip_details_read', 'bitrix_trip_details_read_state'))`);
      expect(rows.length).toBeGreaterThan(25);
      expect(rows.filter((r) => r.anon || r.pub)).toEqual([]);
    });
  });
});

describe('lead ruling Q10', () => {
  it('a document stored on a checked party sends it back to Accounts (audited); the Deal billing copy is untouched', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      const b = await create(BUSINESS);
      await one(OWNER, SQL.selectParty, [d.versionId, d.rowVersion, b.partyId, 0, rid()]);
      await one(ACCOUNTS, SQL.partyCheck, [b.partyId, 1, 'checked', null]);
      const before = await billing();
      const begun = await one<{ fileId: string; objectPath: string }>(OWNER, SQL.docBegin,
        [b.partyId, 'gst_certificate', rid(), false, 'synthetic gst.pdf', 'application/pdf', 2048, 'e'.repeat(64)]);
      // A begun but never stored file changes nothing.
      expect(await get(ACCOUNTS, b.partyId)).toMatchObject({ checkStatus: 'checked' });
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('customer-party-documents', $1, jsonb_build_object('size', 2048::bigint))`,
        [begun.objectPath]);
      await one(OWNER, SQL.docFinish, [begun.fileId, true]);
      expect(await get(ACCOUNTS, b.partyId)).toMatchObject({ checkStatus: 'not_checked', checkedByName: null });
      const [reset] = await h.auditRows('party.check_reset');
      expect(reset).toMatchObject({ target_id: b.partyId, details: { cause: 'document_added', fileId: begun.fileId, previousStatus: 'checked' } });
      expect(await billing()).toEqual(before);
    });
  });
});
