import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, HOTEL, OWNER } from './b1-support';
import { CONTACT, TRIP, VISA, b11Helpers } from './b11-support';

/**
 * Hash compatibility (migration 20261119000100, appendix A section 1.6):
 * hotel versions keep authz.booking_hash; package versions confirmed under B1
 * (hash_schema 1) keep their stored hash even when live travellers change
 * (review E13: confirmed versions read the snapshot); new drafts use schema 2
 * and every new input moves the hash.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { owner, readyHotel, confirm, draftWithTravellers, saveTrip, saveContacts, saveIdentity } = h;

// The B1 package formula, written out independently (20261118000100 booking_package_hash).
const B1_FORMULA = `
  encode(sha256(convert_to(jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise) order by i.item_no)
              from public.service_item_facts f join public.service_items i on i.id = f.service_item_id where f.booking_version_id = v.id), '[]'::jsonb),
    'travellers', coalesce((select jsonb_agg(jsonb_build_array(s.seq, s.full_name, s.traveller_type) order by s.seq)
              from public.booking_version_travellers s where s.booking_version_id = v.id), '[]'::jsonb),
    'commercial_revision', v.commercial_revision,
    'stored_evidence', authz.booking_stored_evidence(v.id))::text, 'UTF8')), 'hex')`;

describe('existing hashes', () => {
  it('a hotel version hashes exactly as authz.booking_hash, before and after confirmation', async () => {
    await asOwner(db, async () => {
      const ready = await readyHotel();
      const expected = `select authz.booking_hash(v.hotel_name, v.city, v.check_in, v.check_out, v.rooms, v.room_type, v.meal_plan,
          v.adults, v.children, v.inclusions, v.special_requests, v.purchase_budget_paise, v.commercial_revision,
          authz.booking_stored_evidence(v.id)) as e, v.content_hash as stored, authz.booking_content_hash(v.id) as computed
        from public.booking_versions v where v.id = $1`;
      const [before] = await owner<{ e: string; stored: string; computed: string }>(expected, [ready.versionId]);
      expect(before!.stored).toBe(before!.e);
      expect(before!.computed).toBe(before!.e);
      await confirm(OWNER, ready.versionId, ready.hash);
      const [after] = await owner<{ e: string; stored: string; computed: string }>(expected, [ready.versionId]);
      expect(after!.stored).toBe(before!.e);
      expect(after!.computed).toBe(before!.e);
    });
  });

  it('a package version confirmed under B1 (hash_schema 1) keeps its stored hash when live travellers change', async () => {
    await asOwner(db, async () => {
      // Build a B1-shaped confirmed version as the table owner: schema 1, snapshot = live travellers.
      const d = await draftWithTravellers();
      await h.addItem(OWNER, d.versionId, d.rowVersion, 'hotel', HOTEL);
      await owner('alter table public.booking_versions disable trigger booking_versions_a_guard');
      await owner('update public.booking_versions set hash_schema = 1 where id = $1', [d.versionId]);
      await owner('alter table public.booking_versions enable trigger booking_versions_a_guard');
      const [b1] = await owner<{ content_hash: string }>('select content_hash from public.booking_versions where id = $1', [d.versionId]);
      await owner(`insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type)
        select $1, legal_entity_id, seq, full_name, traveller_type from public.deal_travellers where deal_id = $2`, [d.versionId, DEAL]);
      await owner(`update public.booking_versions set status = 'confirmed', confirmed_by = created_by, confirmed_at = now() where id = $1`, [d.versionId]);
      const [row] = await owner<{ stored: string; computed: string; independent: string }>(
        `select v.content_hash as stored, authz.booking_content_hash(v.id) as computed, ${B1_FORMULA} as independent
         from public.booking_versions v where v.id = $1`, [d.versionId]);
      expect(row!.stored).toBe(b1!.content_hash);
      expect(row!.computed).toBe(row!.stored);
      expect(row!.independent).toBe(row!.stored);
      // Live travellers drift (owner SQL); the confirmed hash still agrees (E13).
      await owner(`update public.deal_travellers set full_name = 'Synthetic Renamed' where deal_id = $1 and seq = 1`, [DEAL]);
      const [drift] = await owner<{ stored: string; computed: string }>(
        'select content_hash as stored, authz.booking_content_hash(id) as computed from public.booking_versions where id = $1', [d.versionId]);
      expect(drift!.computed).toBe(drift!.stored);
    });
  });
});

describe('schema 2/3 drafts', () => {
  it('new drafts use hash_schema 4 (voice-note batch, 20261128000110); trip, contacts, participation, identity, traveller extras and the plan each move the hash', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      // Voice-note batch (20261128000110): new drafts use hash_schema 4.
      expect(await owner('select hash_schema from public.booking_versions where id = $1', [d.versionId])).toEqual([{ hash_schema: 4 }]);
      const hashOf = async () => (await owner<{ h: string }>('select content_hash as h from public.booking_versions where id = $1', [d.versionId]))[0]!.h;
      const seen = new Set<string>([await hashOf()]);
      const step = async (label: string, fn: () => Promise<unknown>) => {
        await fn();
        const now = await hashOf();
        expect(seen.has(now), label).toBe(false);
        seen.add(now);
        const [check] = await owner<{ ok: boolean }>('select content_hash = authz.booking_content_hash(id) as ok from public.booking_versions where id = $1', [d.versionId]);
        expect(check!.ok, label).toBe(true);
      };
      let rv = d.rowVersion;
      let itemId = '';
      await step('item', async () => { const a = await h.addItem(OWNER, d.versionId, rv, 'hotel', HOTEL); rv = a.rowVersion; itemId = a.itemId; });
      await step('trip', async () => { rv = (await saveTrip(OWNER, d.versionId, rv, TRIP)).rowVersion; });
      await step('contacts', async () => { rv = (await saveContacts(OWNER, d.versionId, rv, CONTACT)).rowVersion; });
      await step('participation', async () => { rv = (await h.saveParticipation(OWNER, itemId, d.versionId, rv, [1, 2])).rowVersion; });
      // Review A1: identity is hashed only for travellers the trip needs it for (here: a visa item).
      await saveIdentity(OWNER, DEAL, 2, 0);
      expect(seen.has(await hashOf())).toBe(true);
      await step('visa item', async () => { rv = (await h.addItem(OWNER, d.versionId, rv, 'visa', VISA)).rowVersion; });
      await step('identity', async () => { await saveIdentity(OWNER, DEAL, 1, 0); });
      await step('special needs', async () => {
        const [t] = await owner<{ j: unknown }>(`select jsonb_agg(jsonb_build_object('fullName', full_name, 'type', traveller_type, 'seq', seq,
          'ageYears', age_years, 'specialNeeds', case when seq = 1 then 'Vegetarian' else special_needs end) order by seq) as j
          from public.deal_travellers where deal_id = $1`, [DEAL]);
        rv = (await h.saveTravellers(OWNER, DEAL, rv, t!.j)).rowVersion;
      });
      await step('total', async () => { rv = (await h.saveCommercials(OWNER, d.versionId, rv, null, null, '100')).rowVersion; });
      await step('plan', async () => { rv = (await h.savePlan(OWNER, d.versionId, rv, [{ seq: 1, label: 'All', amountPaise: '100', dueDate: '2026-10-10' }])).rowVersion; });
      await step('list price', async () => { rv = (await h.saveCommercials(OWNER, d.versionId, rv, '150', '50', '100')).rowVersion; });
    });
  });
});
