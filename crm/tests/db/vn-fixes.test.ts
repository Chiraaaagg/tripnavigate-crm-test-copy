import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HotelFactsSchema } from '@/modules/fulfilment/commands';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, DEAL, HOTEL, OWNER, SUPER, TRIP } from './b1-support';
import { PARTY, SERVICE_SQL } from './booking-form-support';
import { BUSINESS, PERSONAL, REASON, SQL, rid, vnHelpers } from './vn-support';

/**
 * Voice-note batch fix round (Echo-A review of 24 Oct): M1 customer import
 * branch scope, L1 adults cannot be cleared, L3 proposal hash at apply, L4
 * staged cells blanked, L5 formula text refused, L6 "will clear" notes, L7
 * document removal resets a checked customer, L9 readiness needs hotel adults,
 * L10 Bitrix values that fail the trip checks are treated as missing.
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
const SHA = 'f'.repeat(64);
type Batch = Record<string, unknown> & { rowVersion: number; proposalHash: string; rowNotes: unknown[]; rows: Array<Record<string, unknown>> };

const stageArgs = async (kind: string, rows: unknown[], branch: string | null, entityWide: boolean | null) =>
  [await h.entity(), kind, branch, 'synthetic.csv', SHA, JSON.stringify(rows), rid(), entityWide];
const STAGE8 = 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7, $8) as r';
const APPLY4 = 'select public.import_batch_apply($1, $2, $3, $4) as r';
const { adults: _a, ...HOTEL_NO_ADULTS } = HOTEL;
void _a;

describe('M1: customer imports are branch-scoped unless the whole company is chosen', () => {
  it('refuses no branch without the explicit choice, and both together; the whole-company choice is recorded', async () => {
    await asOwner(db, async () => {
      const rows = [{ sourceRef: 'W-1', partyType: 'personal', name: 'Synthetic Whole Company Person' }];
      await refusedWithHint(ACCOUNTS, STAGE8, await stageArgs('customer', rows, null, false), /^branchId$/);
      await refusedWithHint(ACCOUNTS, STAGE8, await stageArgs('customer', rows, await h.branch('DEL'), true), /^entityWide$/);
      await refusedWithHint(SUPER, STAGE8, await stageArgs('hotel', [{ name: 'X', city: 'Y' }], null, true), /^entityWide$/);
      const branchOne = await one<{ batchId: string }>(ACCOUNTS, STAGE8, await stageArgs('customer', rows, await h.branch('JDH'), false));
      const whole = await one<{ batchId: string }>(ACCOUNTS, STAGE8, await stageArgs('customer',
        [{ sourceRef: 'W-2', partyType: 'personal', name: 'Synthetic Entity Person' }], null, true));
      for (const id of [branchOne.batchId, whole.batchId]) {
        const v = await one<Batch>(ACCOUNTS, SQL.importValidate, [id]);
        await one(ACCOUNTS, APPLY4, [id, v.rowVersion, REASON, v.proposalHash]);
      }
      expect(await owner(`select p.source_ref, b.code as branch from public.customer_parties p left join public.branches b on b.id = p.branch_id
        order by p.source_ref`)).toEqual([{ source_ref: 'W-1', branch: 'JDH' }, { source_ref: 'W-2', branch: null }]);
      // Both batches share one transaction time, so read each batch by id (created_at cannot order them).
      expect(await owner(`select entity_wide from public.import_batches where id = '${branchOne.batchId}'`)).toEqual([{ entity_wide: false }]);
      expect(await owner(`select entity_wide from public.import_batches where id = '${whole.batchId}'`)).toEqual([{ entity_wide: true }]);
      // A Delhi salesperson does not see the Jodhpur branch customer; the whole-company one is visible.
      const hits = await one<{ items: Array<{ name: string }> }>(OWNER, SQL.partySearch, ['synthetic', null, 20, 0]);
      expect(hits.items.map((x) => x.name)).toEqual(['Synthetic Entity Person']);
    });
  });
});

describe('L3 and L4: apply what was shown; staged cells blanked afterwards', () => {
  it('a changed target version or a different shown hash is import_stale; after apply or cancel the cells are blank', async () => {
    await asOwner(db, async () => {
      const created = await one<{ id: string }>(SUPER, SQL.hotelSave, [await h.entity(), null, 0,
        JSON.stringify({ name: 'Synthetic Target Hotel', city: 'Jodhpur', sourceRef: 'T-1', area: 'Old City' }), REASON]);
      const s = await one<{ batchId: string }>(SUPER, STAGE8, await stageArgs('hotel',
        [{ sourceRef: 'T-1', name: 'Synthetic Target Hotel Renamed', city: 'Jodhpur', area: '' }], null, false));
      const v = await one<Batch>(SUPER, SQL.importValidate, [s.batchId]);
      expect(v.proposalHash).toMatch(/^[0-9a-f]{64}$/);
      // L6: the blank area clears the stored one: noted before apply.
      expect(v).toMatchObject({ clearRows: 1, rowNotes: [{ rowNo: 1, notes: ['will_clear:area'] }] });
      await refused(SUPER, APPLY4, [s.batchId, v.rowVersion, REASON, '0'.repeat(64)], '40001', 'import_stale');
      // The target changes after the dry run (same counts): stale.
      await one(SUPER, SQL.hotelSave, [await h.entity(), created.id, 1, JSON.stringify({ address: 'Synthetic address' }), REASON]);
      await refused(SUPER, APPLY4, [s.batchId, v.rowVersion, REASON, v.proposalHash], '40001', 'import_stale');
      const v2 = await one<Batch>(SUPER, SQL.importValidate, [s.batchId]);
      expect(v2.proposalHash).not.toBe(v.proposalHash);
      await one(SUPER, APPLY4, [s.batchId, v2.rowVersion, REASON, v2.proposalHash]);
      expect(await owner('select data from public.import_rows where batch_id = $1', [s.batchId])).toEqual([{ data: {} }]);
      const got = await one<Batch>(SUPER, SQL.importGet, [s.batchId, 100, 0]);
      expect(got.rows[0]).toMatchObject({ rowNo: 1, sourceRef: 'T-1', outcome: 'update', name: null });
      expect(await owner('select area from public.hotel_catalogue where id = $1', [created.id])).toEqual([{ area: null }]);
      // Cancel blanks too.
      const c = await one<{ batchId: string }>(SUPER, STAGE8, await stageArgs('hotel', [{ name: 'Synthetic Cancelled', city: 'Jaipur' }], null, false));
      await one(SUPER, SQL.importCancel, [c.batchId, 1]);
      expect(await owner('select data from public.import_rows where batch_id = $1', [c.batchId])).toEqual([{ data: {} }]);
    });
  });
});

describe('L5: formula text is refused in the field rules', () => {
  it('import rows and commands refuse leading = + - @ (numbers and phone numbers pass)', async () => {
    await asOwner(db, async () => {
      const s = await one<{ batchId: string }>(SUPER, STAGE8, await stageArgs('hotel', [
        { name: '=HYPERLINK("x")', city: 'Jodhpur' }, { name: '@SUM(A1)', city: 'Jodhpur' }, { name: 'Synthetic -5 Hotel', city: '-Jaipur' },
        { name: 'Synthetic Fine Hotel', city: 'Jodhpur', starCategory: '4' }], null, false));
      const v = await one<Batch>(SUPER, SQL.importValidate, [s.batchId]);
      expect(v.invalidRows).toEqual([{ rowNo: 1, reasons: ['formula_text'] }, { rowNo: 2, reasons: ['formula_text'] },
        { rowNo: 3, reasons: ['formula_text'] }]);
      await refusedWithHint(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...PERSONAL, name: '+cmd|calc' }), rid()], /^name$/);
      // A phone number with + and a number with - are not formulas.
      expect(await one(OWNER, SQL.partyCreate, [DEAL, JSON.stringify({ ...BUSINESS, phone: '+971501234567' }), rid()]))
        .toMatchObject({ outcome: 'created' });
      expect(await owner<{ k: string[] }>(`select authz.vn_formula_keys('{"a": "-12.50", "b": "+91 98765 00011", "c": "\\tx", "d": "-x"}'::jsonb) as k`))
        .toEqual([{ k: ['c', 'd'] }]);
    });
  });
});

describe('L7: removing a document from a checked customer sends it back to Accounts', () => {
  it('resets to not_checked with an audit row; removing a never-stored file does not', async () => {
    await asOwner(db, async () => {
      const p = await one<{ partyId: string }>(OWNER, SQL.partyCreate, [DEAL, JSON.stringify(PERSONAL), rid()]);
      const begun = await one<{ fileId: string; objectPath: string }>(OWNER, SQL.docBegin,
        [p.partyId, 'other', rid(), false, 'synthetic.pdf', 'application/pdf', 2048, 'a'.repeat(64)]);
      const pending = await one<{ fileId: string }>(OWNER, SQL.docBegin,
        [p.partyId, 'other', rid(), false, 'pending.pdf', 'application/pdf', 2048, 'b'.repeat(64)]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('customer-party-documents', $1, jsonb_build_object('size', 2048::bigint))`,
        [begun.objectPath]);
      await one(OWNER, SQL.docFinish, [begun.fileId, true]);
      await one(ACCOUNTS, SQL.partyCheck, [p.partyId, 1, 'checked', null]);
      await one(OWNER, SQL.docRemove, [pending.fileId, 1]);
      expect(await one(ACCOUNTS, SQL.partyGet, [p.partyId])).toMatchObject({ checkStatus: 'checked' });
      await one(OWNER, SQL.docRemove, [begun.fileId, 2]);
      expect(await one(ACCOUNTS, SQL.partyGet, [p.partyId])).toMatchObject({ checkStatus: 'not_checked' });
      expect((await h.auditRows('party.check_reset')).map((a) => a.details.cause)).toEqual(['document_removed']);
    });
  });
});

describe('L1, L9, L10: booking trip rules', () => {
  it('L1: once adults are recorded, an explicit null is refused', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      // A draft without recorded adults still accepts null (older callers).
      const n = await one<{ rowVersion: number }>(OWNER, SQL.trip, [d.versionId, d.rowVersion, JSON.stringify({ ...TRIP, ...PARTY, adults: null })]);
      const r = await one<{ rowVersion: number }>(OWNER, SQL.trip, [d.versionId, n.rowVersion, JSON.stringify({ ...TRIP, ...PARTY, adults: 3 })]);
      await refusedWithHint(OWNER, SQL.trip, [d.versionId, r.rowVersion, JSON.stringify({ ...TRIP, ...PARTY, adults: null })], /^adults$/);
    });
  });

  it('L9 (amended 25 October): a hotel whose adults cannot be known is refused, never stored without adults', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      // Every reader parses hotel facts with adults required, so a stored hotel without adults would not load.
      await refusedWithHint(OWNER, SERVICE_SQL, [d.versionId, d.rowVersion, null, 'hotel', JSON.stringify(HOTEL_NO_ADULTS),
        null, null, null, rid()], /^paxTotal$/);
      // Any other write path is refused by the trigger as well.
      await refusedWithHint(OWNER, 'select public.service_item_add($1, $2, $3, $4::jsonb, 0, $5) as r',
        [d.versionId, d.rowVersion, 'hotel', JSON.stringify(HOTEL_NO_ADULTS), rid()], /^adults$/);
      const trip = await one<{ rowVersion: number }>(OWNER, SQL.trip, [d.versionId, d.rowVersion, JSON.stringify({ ...TRIP, ...PARTY, adults: 3 })]);
      await h.saveService(OWNER, d.versionId, trip.rowVersion, { type: 'hotel', facts: HOTEL_NO_ADULTS });
      expect((await h.readiness(OWNER, d.versionId)).issues).not.toContain('service_facts_invalid');
    });
  });

  it('a picked catalogue hotel id is checked but never stored in the facts (every reader keeps parsing them)', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      const trip = await one<{ rowVersion: number }>(OWNER, SQL.trip, [d.versionId, d.rowVersion, JSON.stringify({ ...TRIP, ...PARTY, adults: 3 })]);
      await h.saveService(OWNER, d.versionId, trip.rowVersion, { type: 'hotel',
        facts: { ...HOTEL_NO_ADULTS, catalogueHotelId: '00000000-0000-4000-8000-0000000000aa' } });
      const rows = await h.owner<{ facts: Record<string, unknown> }>(
        `select f.facts from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
         where f.booking_version_id = $1 and i.service_type = 'hotel'`, [d.versionId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.facts).not.toHaveProperty('catalogueHotelId');
      expect(HotelFactsSchema.safeParse(rows[0]!.facts).success).toBe(true);
    });
  });

  it('L10: Bitrix counts that would fail the trip checks are treated as missing', async () => {
    await asOwner(db, async () => {
      await h.switches(true, true);
      await h.storeFacts(DEAL, { adults: 60, children: 50, infants: 0 });
      const d = await h.draft(OWNER);
      const facts = await one<{ fields: Record<string, Record<string, unknown>> }>(OWNER, SQL.tripFacts, [DEAL]);
      expect(facts.fields.adults).toMatchObject({ bitrix: 60, source: 'missing' });
      const r = await one<{ bitrixFields?: string[] }>(OWNER, SQL.trip, [d.versionId, d.rowVersion,
        JSON.stringify({ ...TRIP, ...PARTY, adults: 3 })]);
      expect(r.bitrixFields).toBeUndefined();
    });
  });
});
