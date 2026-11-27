import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import { ACCOUNTS, CHECKLIST_SQL, DEAL, DEAL2, FLIGHT, HOTEL, OWNER, PURCHASE, SERVICES_SQL, TRAVELLERS, TRIP } from './b1-support';
import { IDENTITY_SQL, b11Helpers, rid } from './b11-support';

/**
 * Booking reliability fix batch 2, B2-1 (migrations 20261210000100 and
 * 20261210000290; build contract section 6 and addendum 1 Q4): the age of a
 * child or infant comes from the saved date of birth on the trip start of the
 * open draft; a typed age counts only without one; readiness accepts a date
 * of birth; a confirmed version's snapshot never changes; the one-time fill
 * touches open drafts only; the date of birth reaches no new reader.
 * Owner Q4 (warn and allow): a number outside 0 to 17 is not stored and
 * nothing is refused. Synthetic data only; every scenario is rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner } = h;

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const AGE_MIGRATION = '20261210000100_age_from_date_of_birth.sql';
const FILL_MIGRATION = '20261210000290_age_fill_open_drafts.sql';
const OPEN_REVISION = 'select public.booking_open_revision($1) as r';
const REVIEW_RETURN = 'select public.accounts_review_return($1, $2, $3) as r';

/** TRAVELLERS with the child (seq 4) saved without an age. */
const NO_AGE = TRAVELLERS.map((t) => (t.seq === 4 ? { fullName: t.fullName, type: t.type, seq: t.seq } : t));
const dob = (dateOfBirth: string | null) => ({ dateOfBirth, nationality: null, passportNumber: null, passportExpiry: null });

type IdentityAnswer = { seq: number; rowVersion: number; ageYears?: number | null; draftRowVersion?: { from: number; to: number } | null };
const saveDob = (seq: number, expected: number, dateOfBirth: string | null) =>
  one<IdentityAnswer>(OWNER, IDENTITY_SQL, [DEAL, seq, expected, JSON.stringify(dob(dateOfBirth))]);
const ageOf = async (seq: number, deal: string = DEAL) =>
  (await owner<{ age_years: number | null }>('select age_years from public.deal_travellers where deal_id = $1 and seq = $2', [deal, seq]))[0]!.age_years;
const draftRow = async (versionId: string) =>
  (await owner<{ row_version: number; hash_ok: boolean; content_hash: string }>(
    `select row_version, content_hash, content_hash = authz.booking_content_hash(id) as hash_ok from public.booking_versions where id = $1`,
    [versionId]))[0]!;
const checklistCodes = async () => (await one<{ items: Array<{ code: string }> }>(OWNER, CHECKLIST_SQL, [DEAL])).items.map((i) => i.code);

/** A draft with the given travellers and (optionally) the trip saved. */
async function draft(travellers: unknown = TRAVELLERS, trip: Record<string, unknown> | null = TRIP) {
  const d = await h.draftWithTravellers(OWNER, DEAL, travellers);
  let rv = d.rowVersion;
  if (trip) rv = (await h.saveTrip(OWNER, d.versionId, rv, trip)).rowVersion;
  return { versionId: d.versionId, rowVersion: rv };
}

describe('age at travel from the date of birth', () => {
  it('derives whole years on the trip start: the day before, on and after the birthday; the draft version moves with it', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      expect(await ageOf(4)).toBe(9); // typed, no date of birth yet
      const first = await saveDob(4, 0, '2019-12-11');
      expect(first).toEqual({ seq: 4, rowVersion: 1, ageYears: 6, draftRowVersion: { from: d.rowVersion, to: d.rowVersion + 1 } });
      expect(await ageOf(4)).toBe(6);
      let row = await draftRow(d.versionId);
      expect(row).toMatchObject({ row_version: d.rowVersion + 1, hash_ok: true });
      const on = await saveDob(4, 1, '2019-12-10');
      expect(on).toMatchObject({ ageYears: 7, draftRowVersion: { from: d.rowVersion + 1, to: d.rowVersion + 2 } });
      // The day after: still 7, so the answer and the draft are as before the change.
      expect(await saveDob(4, 2, '2019-12-09')).toEqual({ seq: 4, rowVersion: 3 });
      row = await draftRow(d.versionId);
      expect(row).toMatchObject({ row_version: d.rowVersion + 2, hash_ok: true });
      expect((await h.readiness(OWNER, d.versionId)).contentHash).toBe(row.content_hash);
      // Audit: field names and ageDerived only, never the date or the number.
      const audit = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.traveller_identity_saved' order by occurred_at, id`);
      expect(audit.map((a) => a.details.ageDerived ?? null)).toEqual([true, true, null]);
      expect(JSON.stringify(audit)).not.toMatch(/2019|"ageYears"/);
    });
  });

  it('29 February, and a trip start moved across the birthday in the same transaction as the trip save', async () => {
    await asOwner(db, async () => {
      const d = await draft(TRAVELLERS, { ...TRIP, start: '2027-02-28', end: '2027-03-03' });
      await saveDob(4, 0, '2016-02-29');
      expect(await ageOf(4)).toBe(10);
      const rv = (await draftRow(d.versionId)).row_version;
      const moved = await h.saveTrip(OWNER, d.versionId, rv, { ...TRIP, start: '2027-03-01', end: '2027-03-03' });
      expect(await ageOf(4)).toBe(11);
      const row = await draftRow(d.versionId);
      expect(row).toMatchObject({ row_version: moved.rowVersion, hash_ok: true });
      expect(moved.contentHash).toBe(row.content_hash);
    });
  });

  it('a typed age is replaced while a date of birth decides it, and accepted without one (removing the date keeps the last number)', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      await saveDob(4, 0, '2019-12-10');
      let rv = (await draftRow(d.versionId)).row_version;
      const typed = TRAVELLERS.map((t) => (t.seq === 4 ? { ...t, ageYears: 12 } : t));
      rv = (await h.saveTravellers(OWNER, DEAL, rv, typed)).rowVersion;
      expect(await ageOf(4)).toBe(7);
      // The date of birth is removed: the last number stays, then a typed age counts.
      expect(await saveDob(4, 1, null)).toEqual({ seq: 4, rowVersion: 0 });
      expect(await ageOf(4)).toBe(7);
      await h.saveTravellers(OWNER, DEAL, rv, typed);
      expect(await ageOf(4)).toBe(12);
    });
  });

  it('warn and allow (owner Q4): a date of birth giving 18 or more is saved, the number is not stored, nothing is refused', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      expect(await saveDob(4, 0, '1990-05-17')).toEqual({ seq: 4, rowVersion: 1 });
      expect(await ageOf(4)).toBe(9);
      // Moving the trip start does not refuse either.
      const rv = (await draftRow(d.versionId)).row_version;
      await h.saveTrip(OWNER, d.versionId, rv, { ...TRIP, start: '2026-12-20', end: '2026-12-23' });
      expect(await ageOf(4)).toBe(9);
      // The column check (0 to 17) is not loosened.
      await expectDbError(db, () => owner('update public.deal_travellers set age_years = 18 where deal_id = $1 and seq = 4', [DEAL]), { code: '23514' });
    });
  });

  it('readiness accepts a date of birth: the four combinations of date of birth and trip start', async () => {
    // No date of birth, no trip dates: the age is asked for.
    await asOwner(db, async () => {
      const d = await draft(NO_AGE, null);
      expect((await h.readiness(OWNER, d.versionId)).issues).toContain('child_age_missing');
      expect(await checklistCodes()).toContain('child_age_missing');
    });
    // No date of birth, trip dates saved: still asked for.
    await asOwner(db, async () => {
      const d = await draft(NO_AGE);
      expect((await h.readiness(OWNER, d.versionId)).issues).toContain('child_age_missing');
      const item = (await one<{ items: Array<{ code: string; travellerSeqs?: number[] }> }>(OWNER, CHECKLIST_SQL, [DEAL])).items
        .find((i) => i.code === 'child_age_missing');
      expect(item?.travellerSeqs).toEqual([4]);
    });
    // Date of birth saved, no trip dates: the trip dates are asked for, not the age.
    await asOwner(db, async () => {
      const d = await draft(NO_AGE, null);
      await saveDob(4, 0, '2019-12-10');
      expect(await ageOf(4)).toBeNull();
      const issues = (await h.readiness(OWNER, d.versionId)).issues;
      expect(issues).toContain('trip_missing');
      expect(issues).not.toContain('child_age_missing');
      expect(await checklistCodes()).not.toContain('child_age_missing');
    });
    // Date of birth and trip dates: the age is derived, nothing is asked; a date giving 18+ still asks for an age.
    await asOwner(db, async () => {
      const d = await draft(NO_AGE);
      await saveDob(4, 0, '2019-12-10');
      expect(await ageOf(4)).toBe(7);
      expect((await h.readiness(OWNER, d.versionId)).issues).not.toContain('child_age_missing');
      await saveDob(4, 1, '1990-05-17');
      await resetActor(db);
      expect(await owner('select authz.child_age_missing($1) as m', [DEAL])).toEqual([{ m: false }]); // 7 stays stored
    });
    await asOwner(db, async () => {
      const d = await draft(NO_AGE);
      await saveDob(4, 0, '1990-05-17');
      expect(await ageOf(4)).toBeNull();
      expect((await h.readiness(OWNER, d.versionId)).issues).toContain('child_age_missing');
    });
  });

  it('a confirmed version keeps its snapshot; a later date of birth shows in the next revision draft', async () => {
    await asOwner(db, async () => {
      const base = await h.readyDraft(OWNER, DEAL, [['hotel', HOTEL]]);
      expect(base.issues).toEqual([]);
      await h.confirm(OWNER, base.versionId, base.hash);
      const snapshot = () => owner<{ age_years: number | null }>(
        'select age_years from public.booking_version_travellers where booking_version_id = $1 and seq = 4', [base.versionId]);
      const before = await draftRow(base.versionId);
      await one(ACCOUNTS, REVIEW_RETURN, [base.versionId, 'Synthetic return: the child age', rid()]);
      const revision = await one<{ versionId: string; rowVersion: number }>(OWNER, OPEN_REVISION, [base.versionId]);
      const saved = await saveDob(4, 0, '2019-12-10');
      expect(saved).toMatchObject({ ageYears: 7, draftRowVersion: { from: revision.rowVersion, to: revision.rowVersion + 1 } });
      expect(await ageOf(4)).toBe(7);
      expect(await snapshot()).toEqual([{ age_years: 9 }]);
      const after = await owner<{ content_hash: string }>('select content_hash from public.booking_versions where id = $1', [base.versionId]);
      expect(after[0]!.content_hash).toBe(before.content_hash);
      expect((await draftRow(revision.versionId)).hash_ok).toBe(true);
    });
  });
});

describe('the one-time fill of open drafts (20261210000290)', () => {
  const fillSql = () => {
    const text = readFileSync(join(MIGRATIONS, FILL_MIGRATION), 'utf8');
    const start = text.indexOf('do $$');
    const end = text.indexOf('$$;', start + 5);
    return text.slice(start, end + 3);
  };

  it('fills a child with a date of birth, a trip start and no age on an open draft only', async () => {
    await asOwner(db, async () => {
      const d = await draft(NO_AGE);
      // SYNTHETIC FIXTURE: a date of birth saved before the change (triggers off), so the age is still empty.
      await resetActor(db);
      await owner('set local session_replication_role = replica');
      await owner(
        `insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, date_of_birth, updated_by)
         select t.id, t.deal_id, t.legal_entity_id, date '2019-12-10', $2 from public.deal_travellers t where t.deal_id = $1 and t.seq = 4`,
        [DEAL, OWNER.userId]);
      await owner('set local session_replication_role = origin');
      // A Deal with no draft: never filled.
      await owner(
        `insert into public.deal_travellers (deal_id, legal_entity_id, seq, full_name, traveller_type)
         select id, legal_entity_id, 1, 'Synthetic Child Elsewhere', 'child' from public.deals where id = $1`, [DEAL2]);
      await owner(
        `insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, date_of_birth, updated_by)
         select t.id, t.deal_id, t.legal_entity_id, date '2019-12-10', $2 from public.deal_travellers t where t.deal_id = $1 and t.seq = 1`,
        [DEAL2, OWNER.userId]);
      expect(await ageOf(4)).toBeNull();
      expect(await owner('select authz.child_age_missing($1) as m', [DEAL])).toEqual([{ m: true }]);
      const snapshots = await owner<{ n: number }>('select count(*)::int as n from public.booking_version_travellers');
      const rv = (await draftRow(d.versionId)).row_version;

      await db.exec(fillSql());

      expect(await ageOf(4)).toBe(7);
      expect(await ageOf(1, DEAL2)).toBeNull();
      expect(await owner('select authz.child_age_missing($1) as m', [DEAL])).toEqual([{ m: false }]);
      expect(await owner<{ n: number }>('select count(*)::int as n from public.booking_version_travellers')).toEqual(snapshots);
      expect(await draftRow(d.versionId)).toMatchObject({ row_version: rv, hash_ok: true });
      // A second run changes nothing.
      await db.exec(fillSql());
      expect(await ageOf(4)).toBe(7);
    });
  });
});

describe('privacy and access', () => {
  it('Flight and Purchase reads return the number and never the date of birth', async () => {
    await asOwner(db, async () => {
      await h.addFlight();
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel', 'flight']);
      await h.confirm(OWNER, ready.versionId, ready.hash);
      const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]);
      await one(FLIGHT, 'select public.flight_task_claim($1) as r', [task!.id]);
      // SYNTHETIC FIXTURE: a child's date of birth on file (owner write).
      await resetActor(db);
      await owner(
        `insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, date_of_birth, updated_by)
         select t.id, t.deal_id, t.legal_entity_id, date '2019-12-10', $2 from public.deal_travellers t where t.deal_id = $1 and t.seq = 4`,
        [DEAL, OWNER.userId]);
      const workspace = JSON.stringify(await one(FLIGHT, 'select public.flight_workspace($1) as r', [DEAL]));
      expect(workspace).toContain('"ageYears"');
      expect(workspace).not.toContain('2019-12-10');
      const services = JSON.stringify(await one(PURCHASE, SERVICES_SQL, [DEAL]));
      expect(services).not.toContain('2019-12-10');
    });
  });

  it('no API role may call the new functions directly', async () => {
    await asOwner(db, async () => {
      const calls = [
        `select authz.age_on(date '2019-12-10', date '2026-12-10')`,
        `select authz.traveller_age_derived(gen_random_uuid(), '${DEAL}'::uuid)`,
        `select authz.traveller_age_sync('${DEAL}'::uuid)`,
        `select authz.child_age_missing('${DEAL}'::uuid)`,
        `select authz.child_age_missing_seqs('${DEAL}'::uuid)`,
      ];
      for (const actor of [PURCHASE, OWNER, ACCOUNTS, { userId: null }, { userId: null, role: 'service_role' as const }]) {
        for (const sql of calls) {
          await setActor(db, actor);
          await expectDbError(db, () => db.query(sql), { code: '42501' });
          await resetActor(db);
        }
      }
    });
  });

  it('a Purchase holder cannot save an identity (unchanged)', async () => {
    await asOwner(db, async () => {
      await draft();
      await h.refused(PURCHASE, IDENTITY_SQL, [DEAL, 4, 0, JSON.stringify(dob('2019-12-10'))], '42501', 'not_authorized');
    });
  });
});

// ---------------------------------------------------------------------------
// Definition diff: the three restated functions differ only in the intended lines
// ---------------------------------------------------------------------------

/** The text of `create [or replace] function <name>(` up to its closing `$$;` in a migration file. */
function definitionIn(file: string, name: string): string | null {
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const m = new RegExp(`^create (or replace )?function ${name.replace('.', '\\.')}\\(`, 'm').exec(text);
  if (!m) return null;
  const end = text.indexOf('\n$$;', m.index);
  return text.slice(m.index, end + 4);
}

/** The newest definition before 20261210000100 (what the restatement starts from). */
function previousDefinition(name: string): { file: string; text: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < AGE_MIGRATION).sort().reverse();
  for (const file of files) {
    const text = definitionIn(file, name);
    if (text) return { file, text };
  }
  throw new Error(`no earlier definition of ${name}`);
}

/** Lines removed from `a` and added in `b` (longest common subsequence of lines). */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n');
  const y = b.split('\n');
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) removed.push(x[i++]!);
    else added.push(y[j++]!);
  }
  removed.push(...x.slice(i));
  added.push(...y.slice(j));
  return { removed, added };
}

const RESTATED: Array<{ name: string; from: string; lang: string; volatility: string; removed: string[]; added: string[] }> = [
  {
    name: 'public.traveller_identity_save',
    from: '20261128000110_vn_booking_trip_rules.sql',
    lang: 'plpgsql',
    volatility: 'v',
    removed: [
      "      'rowVersion', v_row));",
      "  return jsonb_build_object('seq', p_seq, 'rowVersion', v_row);",
    ],
    added: [
      '  -- Booking reliability B2-1 (20261210000100)',
      '  v_draft public.booking_versions%rowtype;',
      '  v_draft_from integer;',
      '  v_age_before integer;',
      '  v_age_after integer;',
      '  -- B2-1: the open package draft first (the lock order of the other saves); its version moves when the stored age does.',
      '  select * into v_draft from public.booking_versions v',
      "  where v.deal_id = p_deal_id and v.status = 'draft' and v.service_type = 'package' for update;",
      '  v_age_before := v_trav.age_years;  -- B2-1',
      "  -- B2-1: the identity trigger re-derived a child's or infant's age from the date of birth",
      "  -- on the trip start; a changed stored age moves the draft's version (its hash already follows).",
      '  select t.age_years into v_age_after from public.deal_travellers t where t.id = v_trav.id;',
      '  if v_draft.id is not null and v_age_after is distinct from v_age_before then',
      '    v_draft_from := v_draft.row_version;',
      '    v_draft := authz.bump_package_version(v_draft.id);',
      '  end if;',
      "      'rowVersion', v_row)",
      "    || case when v_draft_from is not null then jsonb_build_object('ageDerived', true) else '{}'::jsonb end);  -- B2-1",
      "  return jsonb_build_object('seq', p_seq, 'rowVersion', v_row)",
      '    -- B2-1: only when this save changed the stored age.',
      '    || case when v_draft_from is not null',
      "            then jsonb_build_object('ageYears', v_age_after,",
      "                   'draftRowVersion', jsonb_build_object('from', v_draft_from, 'to', v_draft.row_version))",
      "            else '{}'::jsonb end;",
    ],
  },
  {
    name: 'authz.booking_issues',
    from: '20261205000640_change_reconfirmation.sql',
    lang: 'sql',
    volatility: 's',
    removed: [
      '    case when exists (select 1 from public.deal_travellers t',
      "                      where t.deal_id = d.id and t.traveller_type in ('child', 'infant') and t.age_years is null)",
      "      then 'child_age_missing' end,",
    ],
    added: [
      '    -- Booking reliability B2-1 (20261210000100): a saved date of birth counts as the age source.',
      "    case when authz.child_age_missing(d.id) then 'child_age_missing' end,",
    ],
  },
  {
    name: 'public.intake_checklist',
    from: '20261203000100_phase0_flight_id_rule.sql',
    lang: 'plpgsql',
    volatility: 's',
    removed: [
      "  select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[]) into v_seqs",
      "  from public.deal_travellers t where t.deal_id = p_deal_id and t.traveller_type in ('child', 'infant') and t.age_years is null;",
    ],
    added: [
      '  -- Booking reliability B2-1 (20261210000100): a saved date of birth counts as the age source.',
      '  v_seqs := authz.child_age_missing_seqs(p_deal_id);',
    ],
  },
];

describe('definition diff of the restated functions', () => {
  for (const r of RESTATED) {
    it(`${r.name}: starts from the newest body (${r.from}); only the intended lines differ; attributes unchanged`, async () => {
      const prev = previousDefinition(r.name);
      expect(prev.file, 'a later migration restated it: rebuild 20261210000100 from that body').toBe(r.from);
      const next = definitionIn(AGE_MIGRATION, r.name);
      expect(next).not.toBeNull();
      // Sorted: where a repeated line (such as "end if;") is matched does not matter, only which lines differ.
      const diff = lineDiff(prev.text, next!);
      expect({ removed: [...diff.removed].sort(), added: [...diff.added].sort() }).toEqual({ removed: [...r.removed].sort(), added: [...r.added].sort() });
      // No later migration restates it again.
      const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > AGE_MIGRATION && definitionIn(f, r.name));
      expect(later).toEqual([]);
      await resetActor(db);
      const [schema, fn] = r.name.split('.');
      const [p] = await owner<{ lang: string; volatility: string; definer: boolean; config: string[] | null }>(
        `select l.lanname as lang, p.provolatile as volatility, p.prosecdef as definer, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
         where n.nspname = $1 and p.proname = $2`, [schema, fn]);
      expect(p).toEqual({ lang: r.lang, volatility: r.volatility, definer: true, config: ['search_path=""'] });
    });
  }

  it('the two commands still execute for authenticated; booking_issues and the new functions do not', async () => {
    await resetActor(db);
    const rows = await owner<{ name: string; can: boolean }>(
      `select n.nspname || '.' || p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as can
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname, p.proname) in (('public', 'traveller_identity_save'), ('public', 'intake_checklist'), ('authz', 'booking_issues'),
         ('authz', 'age_on'), ('authz', 'traveller_age_derived'), ('authz', 'traveller_age_sync'), ('authz', 'child_age_missing'),
         ('authz', 'child_age_missing_seqs'), ('authz', 'deal_travellers_age_from_dob'), ('authz', 'traveller_identities_age_sync'),
         ('authz', 'booking_versions_age_sync'))
       order by 1`);
    expect(Object.fromEntries(rows.map((x) => [x.name, x.can]))).toEqual({
      'authz.age_on': false, 'authz.booking_issues': false, 'authz.booking_versions_age_sync': false, 'authz.child_age_missing': false,
      'authz.child_age_missing_seqs': false, 'authz.deal_travellers_age_from_dob': false, 'authz.traveller_age_derived': false,
      'authz.traveller_age_sync': false, 'authz.traveller_identities_age_sync': false,
      'public.intake_checklist': true, 'public.traveller_identity_save': true,
    });
  });
});
