import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACC2_FIXTURE_USERS as P, type Actor, FIXTURE_USERS as U, type TestDb, activateAcc2People, asOwner, createTestDb, expectDbError, resetActor } from '../helpers/db';
import { ACC, DEAL, HOTEL_ITEM, MANAGER, OWNER, PURCHASE, SQL, TRANSFER_ITEM, VISA, accHelpers, rid } from './acc-support';

/**
 * Accounts phase 2, Track A (builder's own tests): suppliers and hotels,
 * contract sections 5.1-5.5, 5.7, 10, 13.4 and Addendum L2 (kind 'channel').
 * Track F writes the independent acc2-* suites.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner } = h;

const FLIGHT_J: Actor = { userId: P.flightJodhpur };
const M_FLIGHT: Actor = { userId: P.managerFlightDelhi };
const ACC2: Actor = { userId: P.accountsJodhpur2 };

const SQLA = {
  create: 'select public.supplier_create($1, $2::jsonb) as r',
  update: 'select public.supplier_update($1, $2, $3::jsonb) as r',
  flightCreate: 'select public.flight_supplier_create($1::jsonb, $2) as r',
  contactSave: 'select public.supplier_contact_save($1, $2, $3, $4::jsonb, $5) as r',
  contactRemove: 'select public.supplier_contact_remove($1, $2, $3, $4) as r',
  link: 'select public.supplier_hotel_link($1, $2, $3) as r',
  unlink: 'select public.supplier_hotel_unlink($1, $2, $3) as r',
  register: 'select public.supplier_register($1::jsonb, $2, $3) as r',
  master: 'select public.supplier_master_get($1) as r',
  hotelSuppliers: 'select public.hotel_suppliers($1) as r',
  verify: 'select public.supplier_verify($1, $2) as r',
  workspace: 'select public.purchase_workspace($1) as r',
} as const;

type Warning = { supplierId: string; name: string; reasons: string[] };
type Created = { supplierId: string; rowVersion: number; warnings: Warning[] };

const base = (over: Record<string, unknown> = {}) => ({
  name: `Test Lake Hotels ${rid().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Udaipur', contactName: null, contactPhone: null,
  contactEmail: null, paymentTerms: null, ...over,
});

async function hotel(name = 'Test Lake View', city = 'Udaipur'): Promise<string> {
  await resetActor(db);
  const [row] = await owner<{ id: string }>(
    `insert into public.hotel_catalogue (legal_entity_id, name, city, source_ref, created_by, updated_by)
     select e.id, $1, $2, $3, $4, $4 from public.legal_entities e where e.code = 'HOLIDAY_CHACHA' returning id`,
    [name, city, `TST-H-${rid().slice(0, 8)}`, U.adminJodhpur],
  );
  return row!.id;
}

describe('5.1 name key and new columns', () => {
  it('name key drops the listed words, punctuation and spaces (TS mirror cases)', async () => {
    const rows = await db.query<{ k: string }>(
      `select authz.supplier_name_key(x) as k from unnest(array['The Lake-View Hotels Pvt. Ltd', 'Hotel Sunrise & Tours', 'A&B Travels LLP', '', 'Résort Ölé']) x`,
    );
    expect(rows.map((r) => r.k)).toEqual(['lakeview', 'sunrise', 'ab', '', 'rsortl']);
  });

  it('create stores kind, GSTIN, PAN, state, address; refuses inconsistent values with the field as hint', async () => {
    await asOwner(db, async () => {
      const e = await h.entityId();
      const ok = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({
        supplierKind: 'channel', gstin: '08aaaaa0001a1z1', pan: 'AAAAA0001A', stateCode: '08', address: '1 Test Ghat Road' }))]);
      expect(ok.warnings).toEqual([]);
      const [s] = await owner<Record<string, string>>('select supplier_kind, gstin, pan, state_code, address from public.suppliers where id = $1', [ok.supplierId]);
      expect(s).toEqual({ supplier_kind: 'channel', gstin: '08AAAAA0001A1Z1', pan: 'AAAAA0001A', state_code: '08', address: '1 Test Ghat Road' });
      await h.refusedHint(PURCHASE, SQLA.create, [e, JSON.stringify(base({ gstin: '08AAAAA0001A1Z1', pan: 'BBBBB0001B' }))], 'invalid_input', /^pan$/);
      await h.refusedHint(PURCHASE, SQLA.create, [e, JSON.stringify(base({ gstin: '08AAAAA0001A1Z1', stateCode: '07' }))], 'invalid_input', /^stateCode$/);
      await h.refusedHint(PURCHASE, SQLA.create, [e, JSON.stringify(base({ gstin: '08AAAAA0001' }))], 'invalid_input', /^gstin$/);
      await h.refusedHint(PURCHASE, SQLA.create, [e, JSON.stringify(base({ supplierKind: 'agent_channel' }))], 'invalid_input', /^supplierKind$/);
      // Exact same name stays blocked.
      const name = (await owner<{ name: string }>('select name from public.suppliers where id = $1', [ok.supplierId]))[0]!.name;
      await h.refused(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: name.toUpperCase() }))], 'supplier_exists', '23505');
    });
  });
});

describe('5.7 near-duplicate warnings (never a block)', () => {
  it('similar name and city, same GSTIN, same PAN, same bank', async () => {
    await asOwner(db, async () => {
      const e = await h.entityId();
      const a = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: 'Test Lakeview Hotels', gstin: '08AAAAA0001A1Z1', pan: 'AAAAA0001A' }))]);
      await one(PURCHASE, SQL.supplierBeneficiary, [a.supplierId, rid(), JSON.stringify({ accountHolder: 'Test', bankName: 'Test Bank', ifsc: 'TEST0000001', accountNumber: '100000000001' })]);
      const sim = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: 'The Lakeview Resort' }))]);
      // 'lakeview' vs 'testlakeview': neither is a prefix of the other.
      expect(sim.warnings).toEqual([]);
      const pre = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: 'Test Lakeview' }))]);
      expect(pre.warnings).toEqual([{ supplierId: a.supplierId, name: 'Test Lakeview Hotels', reasons: ['similar_name_city'] }]);
      const otherCity = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: 'Test Lakeview Stays', city: 'Jaipur' }))]);
      expect(otherCity.warnings.filter((w) => w.supplierId === a.supplierId)).toEqual([]);
      const gst = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: 'Unrelated Co', city: 'Delhi', gstin: '08AAAAA0001A1Z1' }))]);
      expect(gst.warnings.find((w) => w.supplierId === a.supplierId)?.reasons).toEqual(['same_gstin']);
      const pan = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: 'Another Co', city: 'Delhi', pan: 'AAAAA0001A' }))]);
      expect(pan.warnings.find((w) => w.supplierId === a.supplierId)?.reasons).toEqual(['same_pan']);
      const bank = await owner<{ r: Warning[] }>(
        `select authz.supplier_near_duplicates($1, null, 'Zed', 'Agra', null, null, 'TEST0000001', '0001') as r`, [e]);
      expect(bank[0]!.r).toEqual([{ supplierId: a.supplierId, name: 'Test Lakeview Hotels', reasons: ['same_bank'] }]);
    });
  });
});

describe('5.4 history and verification reset', () => {
  it('one history row per changed column, source edit/verify/bank; no account number; GSTIN change resets verification', async () => {
    await asOwner(db, async () => {
      const e = await h.entityId();
      const s = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ gstin: '08AAAAA0001A1Z1' }))]);
      await one(PURCHASE, SQL.supplierBeneficiary, [s.supplierId, rid(), JSON.stringify({ accountHolder: 'Holder X', bankName: 'Bank X', ifsc: 'TEST0000001', accountNumber: '998877665544' })]);
      await one(MANAGER, SQLA.verify, [s.supplierId, 1]);
      const { rv, name } = (await owner<{ rv: number; name: string }>('select row_version as rv, name from public.suppliers where id = $1', [s.supplierId]))[0]!;
      // Absent new keys keep the stored value; city changes; GSTIN changes.
      const u = await one<Created>(PURCHASE, SQLA.update, [s.supplierId, rv, JSON.stringify(base({ name, city: 'Jaipur', gstin: '08AAAAA0009A1Z1' }))]);
      expect(u.warnings).toEqual([]);
      const [after] = await owner<{ verification_status: string; gstin: string; supplier_kind: string }>(
        'select verification_status, gstin, supplier_kind from public.suppliers where id = $1', [s.supplierId]);
      expect(after).toEqual({ verification_status: 'unverified', gstin: '08AAAAA0009A1Z1', supplier_kind: 'direct' });
      const hist = await owner<{ source: string; field: string; old_value: string | null; new_value: string | null }>(
        'select source, field, old_value, new_value from public.supplier_changes where supplier_id = $1 order by id', [s.supplierId]);
      expect(hist.map((x) => `${x.source}:${x.field}`)).toEqual(['bank:bank_revision', 'verify:verification_status', 'edit:city', 'edit:verification_status', 'edit:gstin']);
      expect(hist[0]!.new_value).toBe('revision 1 (…5544) unverified');
      expect(JSON.stringify(hist)).not.toMatch(/998877665544|TEST0000001|Holder X/);
      // Append-only.
      await expectDbError(db, () => owner('update public.supplier_changes set field = $2 where supplier_id = $1', [s.supplierId, 'x']), { message: /append-only/ });
    });
  });
});

describe('5.2 contacts: one primary, legacy columns follow it (LD23)', () => {
  it('create makes the primary; a new primary demotes the old; removing the primary promotes another; removing the last clears legacy', async () => {
    await asOwner(db, async () => {
      const e = await h.entityId();
      const s = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ contactName: 'First Desk', contactPhone: '60000 10001' }))]);
      const contacts = () => owner<{ id: string; name: string; is_primary: boolean; status: string; row_version: number }>(
        'select id, name, is_primary, status, row_version from public.supplier_contacts where supplier_id = $1 order by name', [s.supplierId]);
      const legacy = async () => (await owner<{ n: string | null; p: string | null; m: string | null }>(
        'select contact_name n, contact_phone p, contact_email m from public.suppliers where id = $1', [s.supplierId]))[0];
      expect((await contacts()).map((c) => [c.name, c.is_primary])).toEqual([['First Desk', true]]);
      const second = await one<{ outcome: string; contactId: string }>(PURCHASE, SQLA.contactSave,
        [s.supplierId, null, 0, JSON.stringify({ name: 'Second Desk', email: 'SECOND@example.test', isPrimary: true }), rid()]);
      expect(second.outcome).toBe('created');
      expect((await contacts()).map((c) => [c.name, c.is_primary])).toEqual([['First Desk', false], ['Second Desk', true]]);
      expect(await legacy()).toEqual({ n: 'Second Desk', p: null, m: 'second@example.test' });
      await h.refusedHint(PURCHASE, SQLA.contactSave, [s.supplierId, null, 0, JSON.stringify({ name: 'No Reach' }), rid()], 'invalid_input', /^phone$/);
      const cs = await contacts();
      await h.refusedHint(PURCHASE, SQLA.contactRemove, [cs[1]!.id, cs[1]!.row_version, 'short', rid()], 'invalid_input', /^reason$/);
      await one(PURCHASE, SQLA.contactRemove, [cs[1]!.id, cs[1]!.row_version, 'Left the hotel desk team', rid()]);
      expect((await contacts()).map((c) => [c.name, c.is_primary, c.status])).toEqual([['First Desk', true, 'active'], ['Second Desk', false, 'removed']]);
      expect(await legacy()).toEqual({ n: 'First Desk', p: '60000 10001', m: null });
      const first = (await contacts())[0]!;
      await one(PURCHASE, SQLA.contactRemove, [first.id, first.row_version, 'No longer works there', rid()]);
      expect(await legacy()).toEqual({ n: null, p: null, m: null });
      // Removed is final; Visa (not an editor) refused; audit details carry ids only.
      await expectDbError(db, () => owner(`update public.supplier_contacts set name = 'x' where id = $1`, [first.id]), { message: /final/ });
      await h.refused(VISA, SQLA.contactSave, [s.supplierId, null, 0, JSON.stringify({ name: 'X', phone: '6000010009' }), rid()], 'not_authorized');
      const audit = await owner<{ details: unknown }>(
        `select details from public.audit_events where action in ('supplier.contact_saved', 'supplier.contact_removed') and target_id = $1`, [s.supplierId]);
      expect(JSON.stringify(audit)).not.toMatch(/Desk|example\.test|60000 ?10001/);
    });
  });

  it('replays the same request; a different payload for the same request is request_conflict', async () => {
    await asOwner(db, async () => {
      const s = await one<Created>(PURCHASE, SQLA.create, [await h.entityId(), JSON.stringify(base())]);
      const req = rid();
      const fields = JSON.stringify({ name: 'Desk', phone: '6000010001' });
      const a = await one<{ contactId: string }>(PURCHASE, SQLA.contactSave, [s.supplierId, null, 0, fields, req]);
      const b = await one<{ contactId: string; outcome: string }>(PURCHASE, SQLA.contactSave, [s.supplierId, null, 0, fields, req]);
      expect(b).toMatchObject({ contactId: a.contactId, outcome: 'existing' });
      await h.refused(PURCHASE, SQLA.contactSave, [s.supplierId, null, 0, JSON.stringify({ name: 'Other', phone: '6000010001' }), req], 'request_conflict');
    });
  });
});

describe('5.3 hotel links and 13.4 catalogue hotel on quotes and bookings', () => {
  it('manual link, several suppliers per hotel, transfer-only refused, unlink with reason', async () => {
    await asOwner(db, async () => {
      const e = await h.entityId();
      const hid = await hotel();
      const a = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base())]);
      const b = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base())]);
      const t = await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ serviceTypes: ['transfer'] }))]);
      const la = await one<{ outcome: string; linkId: string }>(PURCHASE, SQLA.link, [a.supplierId, hid, rid()]);
      expect(la.outcome).toBe('created');
      expect((await one<{ outcome: string }>(PURCHASE, SQLA.link, [a.supplierId, hid, rid()])).outcome).toBe('existing');
      await one(PURCHASE, SQLA.link, [b.supplierId, hid, rid()]);
      await h.refused(PURCHASE, SQLA.link, [t.supplierId, hid, rid()], 'link_not_allowed', '55000');
      await h.refusedHint(PURCHASE, SQLA.link, [a.supplierId, rid(), rid()], 'invalid_input', /^hotelId$/);
      const hs = await one<{ suppliers: Array<{ supplierId: string }> }>(ACC, SQLA.hotelSuppliers, [hid]);
      expect(hs.suppliers.map((x) => x.supplierId).sort()).toEqual([a.supplierId, b.supplierId].sort());
      expect(await one(OWNER, SQLA.hotelSuppliers, [hid])).toBeNull();
      await one(PURCHASE, SQLA.unlink, [la.linkId, 'Stopped selling this hotel', rid()]);
      expect((await one<{ suppliers: unknown[] }>(PURCHASE, SQLA.hotelSuppliers, [hid])).suppliers).toHaveLength(1);
    });
  });

  it('catalogueHotelId: kept in the facts column (facts and facts_hash unchanged), copied to a revision, shown on the form, workspace and quote; quote links the supplier', async () => {
    await asOwner(db, async () => {
      const hid = await hotel('Synthetic Hotel (fixture)', 'Synthetic City');
      const b = await h.book([{ ...HOTEL_ITEM, facts: { ...(HOTEL_ITEM.facts as object), catalogueHotelId: hid } }]);
      const [f] = await owner<{ facts: Record<string, unknown>; catalogue_hotel_id: string; same: boolean }>(
        `select f.facts, f.catalogue_hotel_id, f.facts_hash = authz.service_facts_hash(f.facts, f.purchase_budget_paise) as same
         from public.service_item_facts f where f.booking_version_id = $1`, [b.versionId]);
      expect(f!.catalogue_hotel_id).toBe(hid);
      expect(f!.facts).not.toHaveProperty('catalogueHotelId');
      expect(f!.same).toBe(true);
      const form = await one<{ items: Array<{ catalogueHotelId?: string | null }> }>(OWNER, SQL.formGet, [DEAL]);
      expect(form.items[0]!.catalogueHotelId).toBe(hid);
      // A revision copies the facts row and keeps the hotel.
      await one(ACC, SQL.reviewReturn, [b.versionId, 'Synthetic return: change the hotel dates', rid()]);
      const rev = await one<{ versionId: string }>(OWNER, SQL.openRevision, [b.versionId]);
      const [copy] = await owner<{ catalogue_hotel_id: string }>('select catalogue_hotel_id from public.service_item_facts where booking_version_id = $1', [rev.versionId]);
      expect(copy!.catalogue_hotel_id).toBe(hid);
      // Workspace and quote.
      const task = h.taskOf(b, 'hotel');
      const s = await one<Created>(PURCHASE, SQLA.create, [await h.entityId(), JSON.stringify(base())]);
      await one(PURCHASE, SQL.purchaseClaim, [task]);
      const q = { supplierId: s.supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: null, mealPlan: null, quotedCostPaise: '1000000',
        holdUntil: null, cancellationTerms: null };
      await h.refusedHint(PURCHASE, SQL.quoteAdd, [task, rid(), JSON.stringify({ ...q, catalogueHotelId: rid() })], 'invalid_input', /^catalogueHotelId$/);
      const quote = await one<{ quoteId: string }>(PURCHASE, SQL.quoteAdd, [task, rid(), JSON.stringify({ ...q, catalogueHotelId: hid })]);
      const [link] = await owner<{ source: string; first_quote_id: string }>('select source, first_quote_id from public.supplier_hotels where supplier_id = $1', [s.supplierId]);
      expect(link).toEqual({ source: 'quote', first_quote_id: quote.quoteId });
      const ws = await one<{ catalogueHotelId: string; catalogueHotelName: string; hotelSuppliers: Array<{ supplierId: string }> }>(PURCHASE, SQLA.workspace, [task]);
      expect(ws).toMatchObject({ catalogueHotelId: hid, catalogueHotelName: 'Synthetic Hotel (fixture)' });
      expect(ws.hotelSuppliers.map((x) => x.supplierId)).toEqual([s.supplierId]);
    });
  });

  it('a transfer task refuses catalogueHotelId', async () => {
    await asOwner(db, async () => {
      const hid = await hotel();
      const b = await h.book([TRANSFER_ITEM]);
      const task = h.taskOf(b, 'transfer');
      const s = await one<Created>(PURCHASE, SQLA.create, [await h.entityId(), JSON.stringify(base({ serviceTypes: ['transfer'] }))]);
      await one(PURCHASE, SQL.purchaseClaim, [task]);
      await h.refusedHint(PURCHASE, SQL.quoteAdd, [task, rid(), JSON.stringify({ supplierId: s.supplierId, hotelName: 'Cab', roomType: null,
        mealPlan: null, quotedCostPaise: '100000', holdUntil: null, cancellationTerms: null, catalogueHotelId: hid })], 'invalid_input', /^catalogueHotelId$/);
    });
  });
});

describe('5.7 reads and section 10 fences', () => {
  it('register: Purchase non-flight, Flight flight-only, Manager and Accounts all; others null; PAN masked except A/M; keyset', async () => {
    await asOwner(db, async () => {
      await activateAcc2People(db);
      const e = await h.entityId();
      const hs = [];
      for (const n of ['Aaa Test One', 'Aab Test Two', 'Aac Test Three']) {
        hs.push(await one<Created>(PURCHASE, SQLA.create, [e, JSON.stringify(base({ name: n, gstin: '08AAAAA0001A1Z1', pan: 'AAAAA0001A' }))]));
      }
      const fl = await one<{ supplierId: string; warnings: Warning[] }>(FLIGHT_J, SQLA.flightCreate,
        [JSON.stringify({ name: 'Aad Test Air', city: 'Delhi', contactName: null, contactPhone: null, contactEmail: 'air@example.test', supplierKind: 'channel' }), rid()]);
      type Reg = { items: Array<{ supplierId: string; panMasked: string | null; kind: string }>; nextAfter: string | null } | null;
      const ids = (r: Reg) => (r?.items ?? []).map((x) => x.supplierId);
      const p = await one<Reg>(PURCHASE, SQLA.register, [JSON.stringify({ q: 'aa' }), null, 50]);
      expect(ids(p)).toEqual(hs.map((x) => x.supplierId));
      expect(p!.items[0]!.panMasked).toBe('XXXXX0001X');
      const f = await one<Reg>(FLIGHT_J, SQLA.register, [JSON.stringify({ q: 'aa' }), null, 50]);
      expect(ids(f)).toEqual([fl.supplierId]);
      expect(f!.items[0]!.kind).toBe('channel');
      const m = await one<Reg>(MANAGER, SQLA.register, [JSON.stringify({ q: 'aa' }), null, 50]);
      expect(ids(m)).toEqual([...hs.map((x) => x.supplierId), fl.supplierId]);
      const mf = await one<Reg>(M_FLIGHT, SQLA.register, [JSON.stringify({ q: 'aa' }), null, 50]);
      expect(ids(mf)).toEqual([fl.supplierId]);
      for (const who of [OWNER, VISA]) expect(await one(who, SQLA.register, ['{}', null, 50])).toBeNull();
      // Keyset: two pages.
      const p1 = await one<Reg>(ACC2, SQLA.register, [JSON.stringify({ q: 'aa' }), null, 2]);
      const p2 = await one<Reg>(ACC2, SQLA.register, [JSON.stringify({ q: 'aa' }), p1!.nextAfter, 2]);
      expect([...ids(p1), ...ids(p2)]).toEqual([...hs.map((x) => x.supplierId), fl.supplierId]);
      expect(p2!.nextAfter).toBeNull();
      // GSTIN search, unknown filter key refused.
      expect(ids(await one<Reg>(ACC, SQLA.register, [JSON.stringify({ q: '08aaaaa0001a1z1' }), null, 50]))).toEqual(hs.map((x) => x.supplierId));
      await h.refusedHint(ACC, SQLA.register, [JSON.stringify({ colour: 'red' }), null, 50], 'invalid_input', /^filter$/);
      // Master: full PAN for A/M, masked for Purchase; Flight supplier invisible to Purchase.
      type Master = { pan: string; can: { edit: boolean; linkHotel: boolean }; history: unknown[] } | null;
      expect((await one<Master>(ACC, SQLA.master, [hs[0]!.supplierId]))!.pan).toBe('AAAAA0001A');
      expect((await one<Master>(MANAGER, SQLA.master, [hs[0]!.supplierId]))!.pan).toBe('AAAAA0001A');
      const pm = (await one<Master>(PURCHASE, SQLA.master, [hs[0]!.supplierId]))!;
      expect(pm.pan).toBe('XXXXX0001X');
      expect(pm.can).toMatchObject({ edit: true, linkHotel: true });
      expect(await one(PURCHASE, SQLA.master, [fl.supplierId])).toBeNull();
      expect(await one(OWNER, SQLA.master, [hs[0]!.supplierId])).toBeNull();
      expect((await one<Master>(FLIGHT_J, SQLA.master, [fl.supplierId]))!.can.edit).toBe(true);
    });
  });
});
