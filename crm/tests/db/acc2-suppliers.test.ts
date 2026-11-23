import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { HOTEL, HOTEL_ITEM, TRANSFER_ITEM } from './acc-support';
import { ACC, FLIGHT, MANAGER, OWNER, PURCHASE, SENTINEL2, SQL2, acc2Helpers, idOf, landed, rid, waits } from './acc2-support';

/**
 * Accounts Phase 2 contract section 5 (Track A: suppliers and hotels) and
 * test plan 12.1 "A suppliers", Track F. Written from the contract. Supplier
 * kind values per Addendum L2: 'direct' and 'channel'. Every scenario runs in
 * a rolled-back owner transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const { one, owner } = h;
const READY = landed('supplier_contacts', 'supplier_hotels', 'supplier_changes', 'supplier_name_key', 'supplier_near_duplicates', 'supplier_contact_save',
  'supplier_hotel_link');
/** R-A1..R-A3 (suggested file 0130) may land later than the commands. */
const READS = landed('supplier_register', 'supplier_master_get', 'hotel_suppliers');
const GST = SENTINEL2.supplierGstin; // 08AAAPZ4321K1Z5
const PAN = SENTINEL2.supplierPan; // AAAPZ4321K
type Warning = { supplierId: string; name?: string; reasons: string[] };

describe.skipIf(!READY)(`5.1 columns and checks${READY ? '' : ` — ${waits('A', 'supplier_contacts …')}`}`, () => {
  it('GSTIN, PAN and state are format-checked and consistent; kind is direct or channel (L2)', async () => {
    await asOwner(db, async () => {
      const ok = await h.newSupplier({ gstin: GST, pan: PAN, stateCode: '08', address: '1 Synthetic Market Road', supplierKind: 'channel' });
      expect(ok).toMatchObject({ supplierId: expect.any(String), rowVersion: expect.any(Number), warnings: [] });
      const row = await h.supplierRow(ok.supplierId);
      expect(row).toMatchObject({ supplier_kind: 'channel', gstin: GST, pan: PAN, state_code: '08', address: '1 Synthetic Market Road' });
      const ent = await h.entityId();
      const base = { name: `Synthetic Check ${rid().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null,
        contactEmail: 'desk@example.test', paymentTerms: null };
      const create = (f: Record<string, unknown>) => [ent, JSON.stringify({ ...base, ...f })];
      await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ gstin: '08AAAPZ4321K1X5' }), 'invalid_input', /gstin/, '22023');
      await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ pan: 'AAAP4321K' }), 'invalid_input', /pan/, '22023');
      await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ gstin: GST, pan: 'BBBPZ4321K' }), 'invalid_input', /pan/, '22023');
      await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ stateCode: '39' }), 'invalid_input', /stateCode/, '22023');
      await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ gstin: GST, stateCode: '07' }), 'invalid_input', /stateCode/, '22023');
      for (const kind of ['agent_channel', 'agent', 'other']) {
        await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ supplierKind: kind }), 'invalid_input', undefined, '22023');
      }
      // Default kind is direct; unknown keys stay refused (allowlist).
      const plain = await h.newSupplier({ supplierKind: undefined });
      expect((await h.supplierRow(plain.supplierId)).supplier_kind).toBe('direct');
      await h.refusedHint(PURCHASE, SQL2.supplierCreate, create({ sellingPaise: '1' }), 'invalid_input', undefined, '22023');
      // Table checks back the command (owner SQL: GSTIN whose PAN part differs).
      await expectDbError(db, () => owner('update public.suppliers set pan = $2 where id = $1', [ok.supplierId, 'BBBPZ4321K']), { code: '23514' });
      await expectDbError(db, () => owner('update public.suppliers set state_code = $2 where id = $1', [ok.supplierId, '07']), { code: '23514' });
      await expectDbError(db, () => owner(`update public.suppliers set supplier_kind = 'agent_channel' where id = $1`, [ok.supplierId]), { code: '23514' });
    });
  });

  it('name key: lower-case, letters and digits, drops the listed words and spaces; exact same name stays supplier_exists', async () => {
    await asOwner(db, async () => {
      const key = async (s: string) => (await owner<{ k: string }>(SQL2.nameKey, [s]))[0]!.k;
      expect(await key('The Synthetic Palace Hotel Pvt. Ltd.')).toBe('syntheticpalace');
      expect(await key('Synthetic Tours & Travels LLP')).toBe('synthetic');
      expect(await key('Synthetic Resorts and Hotels Private Limited')).toBe('syntheticresorts');
      expect(await key('  SYNTHETIC-123 Stays ')).toBe('synthetic123stays');
      const a = await h.newSupplier({ name: 'Synthetic Exact Name' });
      expect(a.supplierId).toBeTruthy();
      await h.refused(PURCHASE, SQL2.supplierCreate, [await h.entityId(), JSON.stringify({ name: 'synthetic exact name', serviceTypes: ['hotel'],
        city: 'Synthetic City', contactName: null, contactPhone: null, contactEmail: null, paymentTerms: null })], 'supplier_exists');
    });
  });
});

describe.skipIf(!READY)('5.7 near-duplicate warnings (never a block)', () => {
  it('similar name + same city, same GSTIN, same PAN, same bank; up to 10; never blocks', async () => {
    await asOwner(db, async () => {
      const first = await h.newSupplier({ name: 'Synthetic Palace Hotel', city: 'Jodhpur', gstin: GST, pan: PAN, stateCode: '08' });
      // Similar name (key equal) + same city.
      const similar = await h.newSupplier({ name: 'The Synthetic Palace', city: 'jodhpur' });
      expect(similar.warnings as Warning[]).toEqual([expect.objectContaining({ supplierId: first.supplierId, reasons: ['similar_name_city'] })]);
      // Prefix (shorter key >= 5 chars) + same city.
      const prefix = await h.newSupplier({ name: 'Synthetic Palace Grand', city: 'Jodhpur' });
      expect((prefix.warnings as Warning[]).map((w) => w.supplierId)).toContain(first.supplierId);
      // Same name key in another city: no warning.
      const elsewhere = await h.newSupplier({ name: 'Synthetic Palace Resort', city: 'Udaipur' });
      expect((elsewhere.warnings as Warning[]).filter((w) => w.supplierId === first.supplierId)).toEqual([]);
      // Same GSTIN / same PAN in another city with another name: warnings, still created.
      const gst = await h.newSupplier({ name: 'Synthetic Unrelated Stays', city: 'Jaipur', gstin: GST, pan: PAN, stateCode: '08' });
      expect(gst.supplierId).toBeTruthy();
      const reasons = (gst.warnings as Warning[]).find((w) => w.supplierId === first.supplierId)?.reasons ?? [];
      expect(reasons).toEqual(expect.arrayContaining(['same_gstin', 'same_pan']));
      // Same bank (IFSC + last 4 of the latest revision).
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [first.supplierId, rid(), JSON.stringify({
        accountHolder: 'Synthetic Palace', bankName: 'Synthetic Bank', ifsc: 'SYNB0000009', accountNumber: SENTINEL2.accountNumber })]);
      const [dup] = await owner<{ r: Warning[] }>(SQL2.nearDuplicates, [await h.entityId(), null, 'Synthetic Other Name', 'Pune', null, null, 'SYNB0000009',
        SENTINEL2.accountLast4]);
      expect(dup!.r).toEqual([expect.objectContaining({ supplierId: first.supplierId, reasons: ['same_bank'] })]);
      // p_except leaves the supplier itself out (edit screen).
      const [self] = await owner<{ r: Warning[] }>(SQL2.nearDuplicates, [await h.entityId(), first.supplierId, 'Synthetic Palace Hotel', 'Jodhpur', GST, PAN,
        null, null]);
      expect(self!.r.map((w) => w.supplierId)).not.toContain(first.supplierId);
      // Edits return warnings too.
      const upd = await h.updateSupplier(similar.supplierId, { gstin: GST, pan: PAN, stateCode: '08' });
      expect(upd.warnings.map((w) => w.supplierId)).toContain(first.supplierId);
      // At most 10.
      for (let i = 0; i < 12; i += 1) await h.newSupplier({ name: `Synthetic Clone ${i} Stays`, city: 'Kota', gstin: GST, pan: PAN, stateCode: '08' });
      const [many] = await owner<{ r: Warning[] }>(SQL2.nearDuplicates, [await h.entityId(), null, 'x', 'x', GST, null, null, null]);
      expect(many!.r.length).toBeLessThanOrEqual(10);

    });
  });
});

describe.skipIf(!READY)('5.2 contacts', () => {
  it('backfill/create gives one primary; a new primary demotes the old one; legacy columns follow the primary (LD23); removal is final', async () => {
    await asOwner(db, async () => {
      const s = await h.newSupplier({ contactName: 'Synthetic Desk One', contactPhone: '+91 00000 00001', contactEmail: 'one@example.test' });
      const contacts = () => owner<{ id: string; name: string; is_primary: boolean; status: string; row_version: number }>(
        'select id, name, is_primary, status, row_version from public.supplier_contacts where supplier_id = $1 order by created_at, id', [s.supplierId]);
      expect(await contacts()).toEqual([expect.objectContaining({ name: 'Synthetic Desk One', is_primary: true, status: 'active' })]);
      const second = await one(PURCHASE, SQL2.contactSave, [s.supplierId, null, 0, JSON.stringify({ name: 'Synthetic Desk Two', roleLabel: 'Reservations',
        phone: null, email: 'two@example.test', isPrimary: true }), rid()]);
      const secondId = idOf(second, 'contactId');
      const after = await contacts();
      expect(after.filter((c) => c.is_primary).map((c) => c.id)).toEqual([secondId]);
      expect(await h.supplierRow(s.supplierId)).toMatchObject({ contact_name: 'Synthetic Desk Two', contact_email: 'two@example.test', contact_phone: null });
      // Phone or e-mail required.
      await h.refusedHint(PURCHASE, SQL2.contactSave, [s.supplierId, null, 0, JSON.stringify({ name: 'No Way', roleLabel: null, phone: null, email: null,
        isPrimary: false }), rid()], 'invalid_input', undefined, '22023');
      // Two active primaries are impossible (unique index).
      await expectDbError(db, () => owner('update public.supplier_contacts set is_primary = true where supplier_id = $1', [s.supplierId]), { code: '23505' });
      // Remove the primary with a reason; the other active contact or nothing becomes the legacy contact.
      const row = after.find((c) => c.id === secondId)!;
      await one(PURCHASE, SQL2.contactRemove, [secondId, row.row_version, 'Synthetic: this desk closed down', rid()]);
      const removed = (await contacts()).find((c) => c.id === secondId)!;
      expect(removed.status).toBe('removed');
      await expectDbError(db, () => owner(`update public.supplier_contacts set status = 'active' where id = $1`, [secondId]), {});
      await expectDbError(db, () => owner('delete from public.supplier_contacts where id = $1', [secondId]), {});
      expect(await h.audits('supplier.contact_saved')).toEqual(expect.arrayContaining([expect.objectContaining({
        details: expect.objectContaining({ supplierId: s.supplierId, contactId: secondId, primary: true }) })]));
      expect((await h.audits('supplier.contact_removed'))[0]?.reason).toBe('Synthetic: this desk closed down');
      // Flight suppliers: only Flight edits their contacts (supplier_can_edit).
      await h.people.flight();
      await one(FLIGHT, SQL2.flightSupplierCreate, [JSON.stringify({ name: `Synthetic Air ${rid().slice(0, 6)}`, city: 'Synthetic City',
        contactName: 'Synthetic Air Desk', contactPhone: '+91 00000 00002', contactEmail: 'air@example.test', supplierKind: 'channel' }), rid()]);
      const [air] = await owner<{ id: string }>(`select id from public.suppliers where 'flight' = any(service_types) order by created_at desc limit 1`);
      await h.refused(PURCHASE, SQL2.contactSave, [air!.id, null, 0, JSON.stringify({ name: 'Synthetic X', roleLabel: null, phone: '+91 00000 00003',
        email: null, isPrimary: false }), rid()], 'not_authorized');
      await one(FLIGHT, SQL2.contactSave, [air!.id, null, 0, JSON.stringify({ name: 'Synthetic Y', roleLabel: null, phone: '+91 00000 00003', email: null,
        isPrimary: false }), rid()]);
    });
  });
});

describe.skipIf(!READY)('5.3 hotel links, 5.1 catalogue hotel id on quotes and bookings (LD22)', () => {
  it('several suppliers per hotel (Q9); link is idempotent; non-hotel supplier refused; unlink needs a reason; R-A3 lists them', async () => {
    await asOwner(db, async () => {
      const hotel = await h.catalogueHotel();
      const a = await h.newSupplier();
      const b = await h.newSupplier();
      const link = await one<{ outcome: string }>(PURCHASE, SQL2.hotelLink, [a.supplierId, hotel, rid()]);
      expect(link.outcome).toBe('created');
      expect((await one<{ outcome: string }>(PURCHASE, SQL2.hotelLink, [a.supplierId, hotel, rid()])).outcome).toBe('existing');
      await one(PURCHASE, SQL2.hotelLink, [b.supplierId, hotel, rid()]);
      const transferOnly = await h.newSupplier({ serviceTypes: ['transfer'] });
      await h.refused(PURCHASE, SQL2.hotelLink, [transferOnly.supplierId, hotel, rid()], 'link_not_allowed');
      expect(await owner(`select supplier_id from public.supplier_hotels where hotel_id = $1 and status = 'active' order by supplier_id`, [hotel]))
        .toEqual([a.supplierId, b.supplierId].sort().map((x) => ({ supplier_id: x })));
      if (READS) {
        const listed = await one<{ hotelId: string; suppliers: Array<{ supplierId: string }> }>(PURCHASE, SQL2.hotelSuppliers, [hotel]);
        expect(listed.suppliers.map((s) => s.supplierId).sort()).toEqual([a.supplierId, b.supplierId].sort());
      }
      const [row] = await owner<{ id: string }>('select id from public.supplier_hotels where supplier_id = $1 and status = $2', [a.supplierId, 'active']);
      await h.refusedHint(PURCHASE, SQL2.hotelUnlink, [row!.id, 'short', rid()], 'invalid_input', undefined, '22023');
      await one(PURCHASE, SQL2.hotelUnlink, [row!.id, 'Synthetic: no longer sells this hotel', rid()]);
      if (READS) {
        expect((await one<{ suppliers: Array<{ supplierId: string }> }>(PURCHASE, SQL2.hotelSuppliers, [hotel])).suppliers.map((s) => s.supplierId))
          .toEqual([b.supplierId]);
      }
      await expectDbError(db, () => owner('delete from public.supplier_hotels where id = $1', [row!.id]), {});
      expect(await h.audits('supplier.hotel_linked')).toHaveLength(2);
      expect((await h.audits('supplier.hotel_unlinked'))[0]?.reason).toBe('Synthetic: no longer sells this hotel');
      // Sales and other departments never read the hotel-supplier list (P, M, A only).
      if (READS) expect(await h.attempt(OWNER, SQL2.hotelSuppliers, [hotel])).toMatchObject({ ok: true, value: null });
    });
  });

  it('a quote with catalogueHotelId stores the column and auto-links the supplier (source quote); existing quotes untouched', async () => {
    await asOwner(db, async () => {
      const hotel = await h.catalogueHotel();
      const b = await h.approvedDeal([{ ...HOTEL_ITEM, facts: { ...HOTEL, catalogueHotelId: hotel } }]);
      const task = h.taskOf(b, 'hotel');
      const s = await h.newSupplier();
      await one(PURCHASE, 'select public.purchase_task_claim($1) as r', [task]);
      const q = await one<{ quoteId: string }>(PURCHASE, SQL2.quoteAdd, [task, rid(), JSON.stringify({ supplierId: s.supplierId, hotelName: 'Synthetic Hotel',
        roomType: null, mealPlan: null, quotedCostPaise: '1000000', holdUntil: null, cancellationTerms: null, catalogueHotelId: hotel })]);
      expect(await owner('select catalogue_hotel_id from public.purchase_quotes where id = $1', [q.quoteId])).toEqual([{ catalogue_hotel_id: hotel }]);
      expect(await owner('select source, first_quote_id from public.supplier_hotels where supplier_id = $1 and hotel_id = $2', [s.supplierId, hotel]))
        .toEqual([{ source: 'quote', first_quote_id: q.quoteId }]);
      // A second quote from the same supplier: no duplicate link.
      await one(PURCHASE, SQL2.quoteAdd, [task, rid(), JSON.stringify({ supplierId: s.supplierId, hotelName: 'Synthetic Hotel', roomType: null, mealPlan: null,
        quotedCostPaise: '1100000', holdUntil: null, cancellationTerms: null, catalogueHotelId: hotel })]);
      expect(await owner('select count(*)::int as n from public.supplier_hotels where supplier_id = $1', [s.supplierId])).toEqual([{ n: 1 }]);
      // Not a catalogue hotel of the entity / not a uuid: invalid_input hint catalogueHotelId.
      await h.refusedHint(PURCHASE, SQL2.quoteAdd, [task, rid(), JSON.stringify({ supplierId: s.supplierId, hotelName: 'Synthetic Hotel', roomType: null,
        mealPlan: null, quotedCostPaise: '1000000', holdUntil: null, cancellationTerms: null, catalogueHotelId: rid() })], 'invalid_input', /catalogueHotelId/, '22023');
      // Without the key the quote still works (free-text hotel name required as today) and stores null.
      const plain = await one<{ quoteId: string }>(PURCHASE, SQL2.quoteAdd, [task, rid(), JSON.stringify({ supplierId: s.supplierId, hotelName: 'Synthetic Hotel',
        roomType: null, mealPlan: null, quotedCostPaise: '1200000', holdUntil: null, cancellationTerms: null })]);
      expect(await owner('select catalogue_hotel_id from public.purchase_quotes where id = $1', [plain.quoteId])).toEqual([{ catalogue_hotel_id: null }]);
      // Workspace (13.4): catalogue hotel and its suppliers for the picker (A10, may land later).
      if (!landed('purchase_workspace')) return;
      const ws = await one<Record<string, unknown>>(PURCHASE, SQL2.workspace, [task]);
      const text = JSON.stringify(ws);
      expect(text).toContain(hotel);
      expect(text).toContain('catalogueHotelName');
      expect(text).toContain('hotelSuppliers');
    });
  });

  it('booking facts keep catalogueHotelId in a column, not in facts; facts_hash equals the same facts without it; revision copies it', async () => {
    await asOwner(db, async () => {
      const hotel = await h.catalogueHotel();
      const b = await h.approvedDeal([{ ...HOTEL_ITEM, facts: { ...HOTEL, catalogueHotelId: hotel } }, HOTEL_ITEM]);
      const rows = await owner<{ service_item_id: string; facts: Record<string, unknown>; facts_hash: string; catalogue_hotel_id: string | null }>(
        `select f.service_item_id, f.facts, f.facts_hash, f.catalogue_hotel_id from public.service_item_facts f
         where f.booking_version_id = $1 order by (select item_no from public.service_items i where i.id = f.service_item_id)`, [b.versionId]);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.catalogue_hotel_id).toBe(hotel);
      expect(rows[1]!.catalogue_hotel_id).toBeNull();
      expect(Object.keys(rows[0]!.facts)).not.toContain('catalogueHotelId');
      expect(rows[0]!.facts_hash, 'facts_hash unchanged by the key').toBe(rows[1]!.facts_hash);
      // Booking form read carries it (additive).
      if (landed('booking_form_get')) expect(JSON.stringify(await one(OWNER, SQL2.formGet, [b.deal]))).toContain(hotel);
      // Revision: copy keeps the column.
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [b.versionId, 'Synthetic return: room type to check', rid()]);
      const opened = await one<{ versionId: string }>(OWNER, 'select public.booking_open_revision($1) as r', [b.versionId]);
      expect(await owner('select catalogue_hotel_id from public.service_item_facts where booking_version_id = $1 and service_item_id = $2',
        [opened.versionId, rows[0]!.service_item_id])).toEqual([{ catalogue_hotel_id: hotel }]);
    });
  });
});

describe.skipIf(!READY)('5.4 history, LD25 verification reset', () => {
  it('one history row per changed column with old/new and source; bank rows never carry numbers', async () => {
    await asOwner(db, async () => {
      const s = await h.newSupplier({ city: 'Jodhpur' });
      await h.updateSupplier(s.supplierId, { city: 'Jaipur', gstin: GST, pan: PAN, stateCode: '08', address: 'Synthetic Lane' });
      const rows = await h.history(s.supplierId);
      const byField = Object.fromEntries(rows.filter((r) => r.source === 'edit').map((r) => [r.field, [r.old_value, r.new_value]]));
      expect(byField).toMatchObject({ city: ['Jodhpur', 'Jaipur'], gstin: [null, GST], pan: [null, PAN], state_code: [null, '08'], address: [null, 'Synthetic Lane'] });
      expect(rows.every((r) => r.changed_by === U.purchaseJodhpur)).toBe(true);
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [s.supplierId, rid(), JSON.stringify({
        accountHolder: 'Synthetic Holder', bankName: 'Synthetic Bank', ifsc: 'SYNB0000007', accountNumber: SENTINEL2.accountNumber })]);
      const all = await h.history(s.supplierId);
      const bank = all.filter((r) => r.source === 'bank');
      expect(bank).toEqual([expect.objectContaining({ field: 'bank_revision' })]);
      expect(bank[0]!.new_value).toMatch(/^revision 1 \((…|\.\.\.)5501\)/);
      const text = JSON.stringify(all);
      expect(text).not.toContain(SENTINEL2.accountNumber);
      expect(text).not.toContain('SYNB0000007');
      expect(text).not.toContain('Synthetic Holder');
      // Append-only.
      await expectDbError(db, () => owner('delete from public.supplier_changes where supplier_id = $1', [s.supplierId]), {});
      await expectDbError(db, () => owner(`update public.supplier_changes set new_value = 'x' where supplier_id = $1`, [s.supplierId]), {});
      // R-A2: history with PAN masked for Purchase, full for A and M.
      if (!READS) return;
      const forP = await one<{ pan: string; history: Array<{ field: string; newValue: string | null }> }>(PURCHASE, SQL2.masterGet, [s.supplierId]);
      // The GSTIN itself contains the PAN (chars 3-12) and is shown to Purchase; the PAN field is masked.
      expect(JSON.stringify(forP).replaceAll(GST, '')).not.toContain(PAN);
      expect(forP.history.find((x) => x.field === 'pan')?.newValue).toBe('XXXXX4321X');
      const forM = await one<{ pan: string }>(MANAGER, SQL2.masterGet, [s.supplierId]);
      expect(forM.pan).toBe(PAN);
      const forA = await one<{ pan: string }>(ACC, SQL2.masterGet, [s.supplierId]);
      expect(forA.pan).toBe(PAN);
      expect(await one(OWNER, SQL2.masterGet, [s.supplierId])).toBeNull();
    });
  });

  it('a change of name, kind, GSTIN, PAN or state resets verification (as today)', async () => {
    const changes: Array<Record<string, unknown>> = [
      { name: `Synthetic Renamed ${rid().slice(0, 4)}` }, { supplierKind: 'channel' }, { gstin: '08AAAPZ4321K2Z4', pan: PAN, stateCode: '08' },
      { pan: 'AAAPZ9999K', gstin: null }, { stateCode: '27', gstin: null },
    ];
    for (const change of changes) {
      await asOwner(db, async () => {
        const s = await h.newSupplier({ gstin: GST, pan: PAN, stateCode: '08' });
        await one(MANAGER, 'select public.supplier_verify($1, $2) as r', [s.supplierId, (await h.supplierRow(s.supplierId)).row_version]);
        expect((await h.supplierRow(s.supplierId)).verification_status).toBe('verified');
        const upd = await h.updateSupplier(s.supplierId, change);
        expect(upd.rowVersion).toBeGreaterThan(1);
        expect((await h.supplierRow(s.supplierId)).verification_status, JSON.stringify(change)).toBe('unverified');
      });
    }
  });

  it.skipIf(!READS)('R-A1 register: fenced (P non-flight, F flight, M, A), filters, keyset', async () => {
    await asOwner(db, async () => {
      for (let i = 0; i < 5; i += 1) await h.newSupplier({ name: `Synthetic Register ${i} Stays`, city: 'Ajmer', gstin: i === 0 ? GST : null,
        pan: i === 0 ? PAN : null, stateCode: i === 0 ? '08' : null });
      type Page = { items: Array<{ supplierId: string; name: string; panMasked: string | null; gstin: string | null }>; nextAfter: string | null };
      const p1 = await one<Page>(PURCHASE, SQL2.register, [JSON.stringify({ city: 'Ajmer' }), null, 3]);
      expect(p1.items).toHaveLength(3);
      expect(p1.nextAfter).toBeTruthy();
      const p2 = await one<Page>(PURCHASE, SQL2.register, [JSON.stringify({ city: 'Ajmer' }), p1.nextAfter, 3]);
      expect(p2.items).toHaveLength(2);
      expect(new Set([...p1.items, ...p2.items].map((x) => x.supplierId)).size).toBe(5);
      const byGst = await one<Page>(PURCHASE, SQL2.register, [JSON.stringify({ q: GST }), null, 10]);
      expect(byGst.items).toHaveLength(1);
      expect(byGst.items[0]!.panMasked).toBe('XXXXX4321X');
      expect(JSON.stringify(byGst).replaceAll(GST, '')).not.toContain(PAN);
      const byPrefix = await one<Page>(PURCHASE, SQL2.register, [JSON.stringify({ q: 'synthetic regis' }), null, 10]);
      expect(byPrefix.items.length).toBe(5);
      expect(await one(MANAGER, SQL2.register, [JSON.stringify({}), null, 5])).not.toBeNull();
      expect(await one(ACC, SQL2.register, [JSON.stringify({}), null, 5])).not.toBeNull();
      expect(await one(OWNER, SQL2.register, [JSON.stringify({}), null, 5])).toBeNull();
      await h.people.flight();
      const forFlight = await one<Page>(FLIGHT, SQL2.register, [JSON.stringify({ city: 'Ajmer' }), null, 10]);
      expect(forFlight?.items ?? [], 'Flight sees flight suppliers only').toEqual([]);
    });
  });
});

describe.skipIf(!READY)('A3 Flight suppliers', () => {
  it('flight_supplier_create/update take the new fields; no hotel links', async () => {
    await asOwner(db, async () => {
      await h.people.flight();
      const name = `Synthetic Air Channel ${rid().slice(0, 6)}`;
      await one(FLIGHT, SQL2.flightSupplierCreate, [JSON.stringify({ name, city: 'Synthetic City', contactName: 'Synthetic Air Desk',
        contactPhone: '+91 00000 00004', contactEmail: 'air2@example.test', supplierKind: 'channel', gstin: GST, pan: PAN, stateCode: '08' }), rid()]);
      const [s] = await owner<{ id: string; supplier_kind: string; gstin: string; row_version: number }>(
        'select id, supplier_kind, gstin, row_version from public.suppliers where name = $1', [name]);
      expect(s).toMatchObject({ supplier_kind: 'channel', gstin: GST });
      await h.updateSupplier(s!.id, { address: 'Synthetic Air Lane' }, FLIGHT, true);
      expect((await h.supplierRow(s!.id)).address).toBe('Synthetic Air Lane');
      await h.refused(PURCHASE, SQL2.hotelLink, [s!.id, await h.catalogueHotel(), rid()], 'link_not_allowed');
      // Purchase still cannot edit a Flight supplier (existing rule).
      await h.refused(PURCHASE, SQL2.supplierUpdate, [s!.id, (await h.supplierRow(s!.id)).row_version, JSON.stringify(await h.supplierFields(s!.id, { city: 'X' }))],
        'not_authorized');
    });
  });

  it('existing transfer suppliers keep working (no hotel)', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedDeal([HOTEL_ITEM, TRANSFER_ITEM]);
      const s = await h.newSupplier({ serviceTypes: ['transfer'] });
      await h.purchaseCost(h.taskOf(b, 'transfer'), s.supplierId);
      expect(await owner('select count(*)::int as n from public.supplier_hotels where supplier_id = $1', [s.supplierId])).toEqual([{ n: 0 }]);
    });
  });
});
