import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, HOTEL, OWNER, TRAVELLERS } from './b1-support';
import { FORM_SQL, VISA, b11Helpers, rid } from './b11-support';
import { ACC } from './finance-support';
import { flightHelpers } from './flight-support';
import { formHelpers } from './booking-form-support';

/**
 * Visa build, track C smoke checks (migration 20261202000200; contract
 * sections 5.5 and 5.6): visa facts, revision classes, deal_committed
 * without visa tasks, and "a traveller number is never reused" in
 * deal_travellers_save, booking_form_get and flight_name_slots.
 * Synthetic data only; every scenario runs in a rolled-back owner transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const fh = formHelpers(() => db);
const flight = flightHelpers(() => db);
const { one, owner, run } = h;

const TRAVELLERS_SQL = 'select public.deal_travellers_save($1, $2, $3::jsonb) as r';
const OPEN = 'select public.booking_open_revision($1) as r';
const RETURN = 'select public.accounts_review_return($1, $2, $3) as r';

const facts = async (value: unknown) =>
  (await owner<{ r: string[] }>(`select authz.validate_service_facts('visa', $1::jsonb) as r`, [JSON.stringify(value)]))[0]!.r;
const fieldClass = async (field: string) =>
  (await owner<{ r: string }>('select authz.revision_field_class($1) as r', [field]))[0]!.r;
const seqHigh = async (deal: string = DEAL) =>
  (await owner<{ r: number }>('select authz.deal_traveller_seq_high($1) as r', [deal]))[0]!.r;

/** The refusal of one statement (message, code, hint); the transaction stays usable. */
async function refusal(actor: Parameters<typeof run>[0], sql: string, params: unknown[]) {
  await db.exec('savepoint visa_c');
  try {
    await run(actor, sql, params);
  } catch (e) {
    await db.exec('rollback to savepoint visa_c');
    const { code, message, hint } = e as { code?: string; message?: string; hint?: string };
    return { code, message, hint };
  }
  throw new Error('expected a database error, but the statement succeeded');
}

describe('visa facts (contract 5.5)', () => {
  it('accepts the new optional keys and refuses bad values with the key as hint', async () => {
    expect(await facts(VISA)).toEqual([]);
    expect(await facts({ ...VISA, visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi',
      documentsNeeded: ['Passport copy (front and back)', 'Photo, white background', 'Synthetic own letter'] })).toEqual([]);
    expect(await facts({ ...VISA, visaKind: null, jurisdiction: null, jurisdictionPlace: null, documentsNeeded: [] })).toEqual([]);
    expect(await facts({ ...VISA, visaKind: 'e_visa', jurisdiction: 'no' })).toEqual([]);
    expect(await facts({ ...VISA, visaKind: 'stamp' })).toEqual(['visaKind']);
    expect(await facts({ ...VISA, visaKind: 1 })).toEqual(['visaKind']);
    expect(await facts({ ...VISA, jurisdiction: 'maybe' })).toEqual(['jurisdiction']);
    expect(await facts({ ...VISA, jurisdiction: true })).toEqual(['jurisdiction']);
    // The place is required with "yes" and must be absent otherwise.
    expect(await facts({ ...VISA, jurisdiction: 'yes' })).toEqual(['jurisdictionPlace']);
    expect(await facts({ ...VISA, jurisdiction: 'yes', jurisdictionPlace: '  ' })).toEqual(['jurisdictionPlace']);
    expect(await facts({ ...VISA, jurisdiction: 'yes', jurisdictionPlace: 'x'.repeat(121) })).toEqual(['jurisdictionPlace']);
    expect(await facts({ ...VISA, jurisdiction: 'no', jurisdictionPlace: 'Mumbai' })).toEqual(['jurisdictionPlace']);
    expect(await facts({ ...VISA, jurisdictionPlace: 'Mumbai' })).toEqual(['jurisdictionPlace']);
    // Documents: array of trimmed single-spaced labels, 1..120, at most 30, distinct ignoring case.
    expect(await facts({ ...VISA, documentsNeeded: 'Photo' })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: [1] })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: [''] })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: [' Photo'] })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: ['Bank  statement'] })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: ['x'.repeat(121)] })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: ['Photo', 'photo'] })).toEqual(['documentsNeeded']);
    expect(await facts({ ...VISA, documentsNeeded: Array.from({ length: 30 }, (_, i) => `Synthetic document ${i + 1}`) })).toEqual([]);
    expect(await facts({ ...VISA, documentsNeeded: Array.from({ length: 31 }, (_, i) => `Synthetic document ${i + 1}`) })).toEqual(['documentsNeeded']);
    // Passport facts gain nothing.
    expect((await owner<{ r: string[] }>(`select authz.validate_service_facts('passport', $1::jsonb) as r`,
      [JSON.stringify({ applicationType: 'fresh', officeCity: 'Jodhpur', visaKind: 'sticker', documentsNeeded: [] })]))[0]!.r)
      .toEqual(['visaKind', 'documentsNeeded']);
  });

  it('booking_service_save stores the new keys on a visa item; booking_form_get returns them', async () => {
    await asOwner(db, async () => {
      const r = await fh.readyForm();
      const visa = { ...VISA, visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', documentsNeeded: ['Photo, white background', 'Synthetic own letter'] };
      const saved = await fh.saveService(OWNER, r.versionId, r.rowVersion, { type: 'visa', facts: visa, participants: [1, 2] });
      const [row] = await owner<{ facts: Record<string, unknown> }>(
        'select facts from public.service_item_facts where service_item_id = $1 and booking_version_id = $2', [saved.itemId, r.versionId]);
      expect(row!.facts).toMatchObject({ visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi',
        documentsNeeded: ['Photo, white background', 'Synthetic own letter'] });
      const form = await one<{ items: Array<{ itemId: string; facts: { facts: Record<string, unknown> } }> }>(OWNER, FORM_SQL, [DEAL]);
      expect(form.items.find((i) => i.itemId === saved.itemId)!.facts.facts).toMatchObject({ visaKind: 'sticker', documentsNeeded: visa.documentsNeeded });
      const bad = await refusal(OWNER, 'select public.booking_service_save($1, $2, $3, $4, $5::jsonb, $6::bigint, $7::jsonb, $8::integer[], $9) as r',
        [r.versionId, saved.rowVersion, saved.itemId, null, JSON.stringify({ ...visa, jurisdictionPlace: null }), null, null, null, rid()]);
      expect(bad).toMatchObject({ code: '22023', message: 'invalid_input', hint: 'jurisdictionPlace' });
    });
  });
});

describe('revision field classes (QB6)', () => {
  it('jurisdiction, place and documents are choice; the visa kind stays material; others unchanged', async () => {
    expect(await fieldClass('items.2.jurisdiction')).toBe('choice');
    expect(await fieldClass('items.2.jurisdictionPlace')).toBe('choice');
    expect(await fieldClass('items.12.documentsNeeded')).toBe('choice');
    expect(await fieldClass('items.2.visaKind')).toBe('material');
    expect(await fieldClass('items.1.applyBy')).toBe('material');
    expect(await fieldClass('items.1.purpose')).toBe('choice');
    expect(await fieldClass('items.1.purchaseBudgetPaise')).toBe('internal');
    expect(await fieldClass('items.x.jurisdiction')).toBe('material');
  });
});

describe('deal_committed without visa tasks (QB3)', () => {
  it('a completed visa task does not commit the Deal; a supplier-confirmed hotel still does', async () => {
    await asOwner(db, async () => {
      const t = await h.deskTask();
      const committed = async () => (await owner<{ r: boolean }>('select authz.deal_committed($1) as r', [DEAL]))[0]!.r;
      expect(await committed()).toBe(false);
      // Status only (the desk flow is track A's): triggers and row checks off inside this rolled-back transaction.
      await db.exec(`set local session_replication_role = replica`);
      await db.exec(`do $$ declare c text; begin
        for c in select conname from pg_constraint where conrelid = 'public.fulfilment_tasks'::regclass and contype = 'c' loop
          execute format('alter table public.fulfilment_tasks drop constraint %I', c);
        end loop; end $$`);
      await owner(`update public.fulfilment_tasks set status = 'completed' where id = $1`, [t.taskId]);
      expect(await committed()).toBe(false);
      await owner(`update public.fulfilment_tasks set status = 'supplier_confirmed' where id = $1`, [t.hotelTaskId]);
      expect(await committed()).toBe(true);
      await owner(`update public.fulfilment_tasks set status = 'completed', department = 'flight' where id = $1`, [t.hotelTaskId]);
      expect(await committed()).toBe(true);
      await db.exec(`set local session_replication_role = origin`);
    });
  });
});

describe('a traveller number is never reused (QB1)', () => {
  it('draft: seqs of removed draft-only travellers may come back; booking_form_get reports the high-water', async () => {
    await asOwner(db, async () => {
      const d = await h.draftWithTravellers();
      expect(await seqHigh()).toBe(4);
      expect((await one<{ travellerSeqHigh: number }>(OWNER, FORM_SQL, [DEAL])).travellerSeqHigh).toBe(4);
      const rv = (await h.saveTravellers(OWNER, DEAL, d.rowVersion, TRAVELLERS.slice(0, 3))).rowVersion;
      // Never confirmed anywhere: only deal_travellers knew seq 4 (contract 5.6 sources).
      expect(await seqHigh()).toBe(3);
      await h.saveTravellers(OWNER, DEAL, rv, TRAVELLERS);
    });
  });

  it('revision: a seq of the accepted version cannot be reused; a new one above the high-water is accepted', async () => {
    await asOwner(db, async () => {
      const base = await h.readyDraft(OWNER, DEAL, [['hotel', HOTEL]]);
      expect(base.issues).toEqual([]);
      await h.confirm(OWNER, base.versionId, base.hash);
      await one(ACC, RETURN, [base.versionId, 'Synthetic return: one child is not travelling', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, OPEN, [base.versionId]);
      // Remove traveller 4 in the revision draft.
      const removed = await h.saveTravellers(OWNER, DEAL, opened.rowVersion, TRAVELLERS.slice(0, 3));
      expect(await seqHigh()).toBe(4);
      expect((await one<{ travellerSeqHigh: number }>(OWNER, FORM_SQL, [DEAL])).travellerSeqHigh).toBe(4);
      // A stale form re-adds someone as seq 4: refused, nothing saved.
      const again = [...TRAVELLERS.slice(0, 3), { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 4 }];
      expect(await refusal(OWNER, TRAVELLERS_SQL, [DEAL, removed.rowVersion, JSON.stringify(again)]))
        .toMatchObject({ code: '22023', message: 'traveller_seq_reused', hint: 'travellers[4].seq' });
      expect(await owner('select seq from public.deal_travellers where deal_id = $1 order by seq', [DEAL]))
        .toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
      // Numbered above the high-water: accepted; existing travellers keep their seqs.
      const next = await h.saveTravellers(OWNER, DEAL, removed.rowVersion, [...TRAVELLERS.slice(0, 3), { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 5 }]);
      expect(next.rowVersion).toBeGreaterThan(removed.rowVersion);
      expect((await one<{ travellerSeqHigh: number }>(OWNER, FORM_SQL, [DEAL])).travellerSeqHigh).toBe(5);
      // Other refusals keep their tokens (a duplicate posted seq is still invalid_input).
      expect(await refusal(OWNER, TRAVELLERS_SQL, [DEAL, next.rowVersion, JSON.stringify([TRAVELLERS[0], { ...TRAVELLERS[1], seq: 1 }])]))
        .toMatchObject({ code: '22023', message: 'invalid_input', hint: 'travellers[2].seq' });
    });
  });

  it('flight_name_slots numbers blanks above every seq ever used', async () => {
    await asOwner(db, async () => {
      await flight.addFlightPeople();
      const b = await flight.unnamedDeal();
      const slotsOf = async () => (await owner<{ r: Array<{ seq: number; type: string | null }> }>('select authz.flight_name_slots($1) as r', [DEAL]))[0]!.r;
      expect(await slotsOf()).toEqual([{ seq: 5, type: 'adult' }]);
      // A seq used earlier elsewhere on the Deal (here a fill row of seq 9; FK checks off in this rolled-back transaction).
      await db.exec(`set local session_replication_role = replica`);
      await owner(`insert into public.deal_traveller_fills (legal_entity_id, deal_id, booking_version_id, traveller_seq, traveller_type, filled_by, request_id)
                   select v.legal_entity_id, v.deal_id, v.id, 9, 'adult', $2, gen_random_uuid() from public.booking_versions v where v.id = $1`,
        [b.versionId, '00000000-0000-4000-8000-000000000001']);
      await db.exec(`set local session_replication_role = origin`);
      expect(await seqHigh()).toBe(9);
      expect(await slotsOf()).toEqual([{ seq: 10, type: 'adult' }]);
    });
  });
});
