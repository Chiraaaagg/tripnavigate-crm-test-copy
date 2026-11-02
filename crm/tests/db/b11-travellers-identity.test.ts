import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import { ACCOUNTS, DEAL, FLIGHT, HOTEL, MANAGER, OWNER, PURCHASE, SALES_B, SUPER, TRAVELLERS, TRAVELLERS_SQL } from './b1-support';
import { IDENTITY, IDENTITY_SQL, VISA, b11Helpers } from './b11-support';

/**
 * B1.1a travellers (migration 20261119000100): age and special needs, stable
 * traveller ids (upsert by seq), restricted identities with no Data API read,
 * the identity snapshot at confirmation, passport details after confirmation.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, refusedWithHint, owner, saveIdentity, draftWithTravellers, readyDraft, confirm, addFlight } = h;

describe('deal_travellers_save (B1.1)', () => {
  it('keeps traveller ids by seq, stores age and special needs, drops removed travellers from the draft participation', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const added = await h.addItem(OWNER, d.versionId, d.rowVersion, 'hotel', HOTEL); // takes travellers 1-4
      const before = await owner<{ id: string; seq: number }>('select id, seq from public.deal_travellers where deal_id = $1 order by seq', [DEAL]);
      await saveIdentity(OWNER, DEAL, 2, 0);
      const next = [
        { ...TRAVELLERS[0]!, specialNeeds: 'Wheelchair at the airport' },
        TRAVELLERS[1]!,
        { ...TRAVELLERS[3]!, ageYears: 10 },
      ];
      await h.saveTravellers(OWNER, DEAL, added.rowVersion, next);
      const after = await owner<{ id: string; seq: number; age_years: number | null; special_needs: string | null }>(
        'select id, seq, age_years, special_needs from public.deal_travellers where deal_id = $1 order by seq', [DEAL]);
      expect(after.map((t) => t.seq)).toEqual([1, 2, 4]);
      expect(after.map((t) => t.id)).toEqual([before[0]!.id, before[1]!.id, before[3]!.id]);
      expect(after[0]!.special_needs).toBe('Wheelchair at the airport');
      expect(after[2]!.age_years).toBe(10);
      expect(await owner('select traveller_seq from public.service_item_travellers where booking_version_id = $1 order by traveller_seq', [d.versionId]))
        .toEqual([{ traveller_seq: 1 }, { traveller_seq: 2 }, { traveller_seq: 4 }]);
      // The identity of seq 2 survived (same traveller row).
      expect(await owner('select count(*)::int as n from public.traveller_identities where deal_id = $1', [DEAL])).toEqual([{ n: 1 }]);
    });
  });

  it('refuses out-of-range ages, long special needs and unknown keys', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      for (const bad of [{ ageYears: 18 }, { ageYears: -1 }, { specialNeeds: 'x'.repeat(501) }, { passport: 'A1' }]) {
        await refusedWithHint(OWNER, TRAVELLERS_SQL, [DEAL, d.rowVersion, JSON.stringify([{ ...TRAVELLERS[0]!, ...bad }])], /^travellers\[1\]$/);
      }
    });
  });
});

describe('traveller_identity_save', () => {
  it('saves, updates and clears an identity with its own row version; audit has field names only', async () => {
    await asOwner(db, async () => {
      await draftWithTravellers();
      const first = await saveIdentity(OWNER, DEAL, 1, 0, { ...IDENTITY, passportNumber: 'z 123-4567' });
      expect(first).toEqual({ seq: 1, rowVersion: 1 });
      expect(await owner('select date_of_birth::text as dob, nationality, passport_number from public.traveller_identities'))
        .toEqual([{ dob: '1990-05-17', nationality: 'Indian', passport_number: 'Z1234567' }]);
      await refused(OWNER, IDENTITY_SQL, [DEAL, 1, 0, JSON.stringify(IDENTITY)], '40001', 'version_changed');
      const second = await saveIdentity(MANAGER, DEAL, 1, 1, { ...IDENTITY, passportExpiry: null });
      expect(second.rowVersion).toBe(2);
      const cleared = await saveIdentity(OWNER, DEAL, 1, 2, { dateOfBirth: null, nationality: null, passportNumber: null, passportExpiry: null });
      expect(cleared.rowVersion).toBe(0);
      expect(await owner('select count(*)::int as n from public.traveller_identities')).toEqual([{ n: 0 }]);
      const audit = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.traveller_identity_saved' order by id`);
      expect(audit).toHaveLength(3);
      expect(JSON.stringify(audit)).not.toMatch(/1990|Indian|Z1234567|2030/);
    });
  });

  it('validates the fields and refuses everyone except booking editors', async () => {
    await asOwner(db, async () => {
      await draftWithTravellers();
      const cases: Array<[unknown, RegExp]> = [
        [{ ...IDENTITY, dateOfBirth: '2999-01-01' }, /^dateOfBirth$/],
        [{ ...IDENTITY, dateOfBirth: '1990-02-30' }, /^dateOfBirth$/],
        [{ ...IDENTITY, nationality: 'I' }, /^nationality$/],
        [{ ...IDENTITY, passportNumber: 'AB1' }, /^passportNumber$/],
        [{ ...IDENTITY, passportExpiry: 'soon' }, /^passportExpiry$/],
        [{ ...IDENTITY, aadhaar: '1' }, /^aadhaar$/],
      ];
      for (const [fields, hint] of cases) await refusedWithHint(OWNER, IDENTITY_SQL, [DEAL, 1, 0, JSON.stringify(fields)], hint);
      await refused(OWNER, IDENTITY_SQL, [DEAL, 9, 0, JSON.stringify(IDENTITY)], 'P0002', 'not_found');
      await addFlight();
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT, SUPER]) {
        await refused(actor, IDENTITY_SQL, [DEAL, 1, 0, JSON.stringify(IDENTITY)], '42501', 'not_authorized');
      }
    });
  });

  it('identity tables are unreadable through the Data API for every role, owner included', async () => {
    await asOwner(db, async () => {
      await draftWithTravellers();
      await saveIdentity(OWNER, DEAL, 1, 0);
      for (const actor of [OWNER, MANAGER, ACCOUNTS, PURCHASE, SUPER, { userId: null, role: 'service_role' as const }]) {
        for (const table of ['traveller_identities', 'booking_version_traveller_identities']) {
          await setActor(db, actor);
          await expectDbError(db, () => db.query(`select * from public.${table}`), { code: '42501' });
          await resetActor(db);
        }
      }
    });
  });

  it('confirmation snapshots only the identities the trip needs (review A1)', async () => {
    await asOwner(db, async () => {
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['visa', VISA]], { identities: true });
      // The visa is for traveller 1 only.
      const visaItem = ready.itemIds[1]!;
      const p = await h.saveParticipation(OWNER, visaItem, ready.versionId, ready.rowVersion, [1]);
      const r = await h.readiness(OWNER, ready.versionId);
      expect(r.issues).toEqual([]);
      expect(r.contentHash).toBe(p.contentHash);
      await confirm(OWNER, ready.versionId, r.contentHash);
      expect(await owner('select seq from public.booking_version_traveller_identities where booking_version_id = $1', [ready.versionId]))
        .toEqual([{ seq: 1 }]);
      expect(await owner('select content_hash = authz.booking_content_hash(id) as ok from public.booking_versions where id = $1', [ready.versionId]))
        .toEqual([{ ok: true }]);
    });
  });

  it('confirmation snapshots identities; passport details added later leave the confirmed hash unchanged', async () => {
    await asOwner(db, async () => {
      const ready = await readyDraft(OWNER, DEAL, [['visa', VISA]], { identities: true });
      expect(ready.issues).toEqual([]);
      await confirm(OWNER, ready.versionId, ready.hash);
      expect(await owner('select seq, passport_number from public.booking_version_traveller_identities where booking_version_id = $1 order by seq', [ready.versionId]))
        .toEqual([1, 2, 3, 4].map((seq) => ({ seq, passport_number: `Z${1000000 + seq}` })));
      const [identityRow] = await owner<{ row_version: number }>(
        'select x.row_version from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id where t.deal_id = $1 and t.seq = 1', [DEAL]);
      await saveIdentity(OWNER, DEAL, 1, identityRow!.row_version, { ...IDENTITY, passportNumber: 'N7654321' });
      const [row] = await owner<{ stored: string; computed: string }>(
        'select content_hash as stored, authz.booking_content_hash(id) as computed from public.booking_versions where id = $1', [ready.versionId]);
      expect(row!.computed).toBe(row!.stored);
      await expectDbError(db, () => owner('update public.booking_version_traveller_identities set nationality = $1', ['Other']), { code: '42501' });
      expect(await one(OWNER, 'select 1 as r')).toBe(1);
    });
  });
});
