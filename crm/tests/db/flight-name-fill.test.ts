import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, FLIGHT, MANAGER, OWNER, PURCHASE, SALES_B, SQL, flightHelpers, rid, sectorInput } from './flight-support';

/**
 * Flight build, contract Addendum 2 (owner decision R3, 5 November 2026): the
 * Deal's Sales owner may fill a missing traveller name on the confirmed
 * booking without a revision.
 *   - Only a blank can be filled (an existing name is refused); nothing else
 *     on the booking changes; no new booking version.
 *   - Caller: the active Sales owner; the branch Manager only when the Deal
 *     has no active Sales owner.
 *   - Works on a committed Deal (the way out of the R3 deadlock).
 *   - One audit row per fill, without the name; idempotent by request id.
 *   - The Flight group's unnamed-traveller block clears; Flight gets a Home
 *     count (flightTravellersNamed).
 * Command signature as documented by Track A (migration 20261201000190):
 * deal_traveller_name_fill(deal, version, seq, full name, type, request id).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner, refused, refusedHint } = h;
const FILL_SQL = 'select public.deal_traveller_name_fill($1, $2, $3, $4, $5, $6) as r';
const NAME = 'Synthetic Late Named Five';

/** Unnamed-traveller Deal (party 4 adults + 1 child, 4 named: the missing one is an adult), screenshot flight typed and taken. */
async function setup() {
  await h.addFlightPeople();
  const b = await h.unnamedDeal();
  const task = b.flightTasks[0]!;
  await h.claim();
  await one(FLIGHT, SQL.screenshotSave, [task, (await h.stateRow(task))!.row_version, JSON.stringify([sectorInput()]), rid()]);
  const summary = await one<{ nameFill: { versionId: string; slots: Array<{ seq: number; type: string }> } | null }>(OWNER, SQL.dealSummary, [DEAL]);
  expect(summary.nameFill, 'the Sales owner may fill a name').not.toBeNull();
  const slot = summary.nameFill!.slots[0]!;
  expect(summary.nameFill!.versionId).toBe(b.versionId);
  expect(slot.type).toBe('adult');
  return { b, task, slot };
}

describe('deal_traveller_name_fill (R3)', () => {
  it('the Sales owner fills the blank: the traveller joins the flights, the block clears, one audit row without the name', async () => {
    await asOwner(db, async () => {
      const { b, task, slot } = await setup();
      expect((await owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]))[0]!.i).toContain('travellers_unnamed');
      const versions = await owner<{ n: number }>('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL]);
      const [hash] = await owner<{ h: string }>('select content_hash as h from public.booking_versions where id = $1', [b.versionId]);
      const req = rid();
      const r = await one<Record<string, unknown>>(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, `  ${NAME} `, 'adult', req]);
      expect(r).toMatchObject({ dealId: DEAL, versionId: b.versionId, seq: slot.seq, type: 'adult', outcome: 'created' });
      // The traveller exists on the Deal and on the accepted version (trimmed); nothing else on the booking changed.
      expect(await owner('select full_name, traveller_type from public.deal_travellers where deal_id = $1 and seq = $2', [DEAL, slot.seq]))
        .toEqual([{ full_name: NAME, traveller_type: 'adult' }]);
      expect(await owner('select full_name from public.booking_version_travellers where booking_version_id = $1 and seq = $2', [b.versionId, slot.seq]))
        .toEqual([{ full_name: NAME }]);
      expect(await owner('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL])).toEqual(versions);
      expect(await owner('select content_hash as h from public.booking_versions where id = $1', [b.versionId])).toEqual([hash]);
      // Flight: the traveller is on the typed sector; the unnamed block clears; Flight sees a "named" Home count.
      expect((await owner<{ n: number }>('select authz.flight_unnamed_count($1) as n', [task]))[0]!.n).toBe(0);
      const [sector] = await h.sectors(task);
      expect(await h.seqsOn(sector!.id)).toContain(slot.seq);
      expect((await owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]))[0]!.i).not.toContain('travellers_unnamed');
      expect((await one<Record<string, number | null>>(FLIGHT, SQL.homeCounts)).flightTravellersNamed).toBeGreaterThanOrEqual(1);
      expect(await one<Record<string, number | null>>(OWNER, SQL.homeCounts)).toMatchObject({ salesTravellersToName: 0 });
      // No more blanks: nothing left to fill.
      const after = (await one<{ nameFill: { slots: unknown[] } | null }>(OWNER, SQL.dealSummary, [DEAL])).nameFill;
      expect(after?.slots ?? []).toEqual([]);
      // One audit row, ids and type only.
      const audits = await owner<{ details: Record<string, unknown>; reason: string | null }>(
        `select details, reason from public.audit_events where action = 'booking.traveller_name_filled'`);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ dealId: DEAL, versionId: b.versionId, seq: slot.seq, type: 'adult' });
      expect(JSON.stringify(audits)).not.toContain('Late Named');
      // Idempotent: the same request again is the stored result; the same id with other details is refused.
      expect(await one(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, `  ${NAME} `, 'adult', req])).toMatchObject({ seq: slot.seq });
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'booking.traveller_name_filled'`)).toEqual([{ n: 1 }]);
      await refused(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, 'Synthetic Other Name', 'adult', req], 'duplicate_request', '40001');
      // A set name is never changed this way.
      await refused(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, 'Synthetic Other Name', 'adult', rid()], 'name_already_set', '55000');
    });
  });

  it('existing names, other callers and bad input are refused; nothing is written', async () => {
    await asOwner(db, async () => {
      const { b, slot } = await setup();
      await refused(OWNER, FILL_SQL, [DEAL, b.versionId, 1, 'Synthetic Rename One', 'adult', rid()], 'name_already_set', '55000');
      for (const actor of [SALES_B, FLIGHT, PURCHASE, MANAGER]) {
        await refused(actor, FILL_SQL, [DEAL, b.versionId, slot.seq, NAME, 'adult', rid()], 'not_authorized', '42501');
      }
      await refusedHint(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, '   ', 'adult', rid()], 'invalid_input', /^fullName$/);
      await refusedHint(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, NAME, 'elder', rid()], 'invalid_input', /^type$/);
      await refusedHint(OWNER, FILL_SQL, [DEAL, b.versionId, 0, NAME, 'adult', rid()], 'invalid_input', /^seq$/);
      const wrong = await h.attempt(OWNER, FILL_SQL, [DEAL, rid(), slot.seq, NAME, 'adult', rid()]);
      expect(wrong.ok).toBe(false);
      expect(wrong.ok ? '' : wrong.error).toMatch(/^(version_changed|invalid_input)$/);
      // The missing traveller is an adult: filling it as a child does not match the party.
      await refusedHint(OWNER, FILL_SQL, [DEAL, b.versionId, slot.seq, NAME, 'child', rid()], 'invalid_input', /^type$/);
      expect(await owner('select count(*)::int as n from public.deal_travellers where deal_id = $1', [DEAL])).toEqual([{ n: 4 }]);
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'booking.traveller_name_filled'`)).toEqual([{ n: 0 }]);
    });
  });

  it('the branch Manager fills only when the Deal has no active Sales owner; a committed Deal can still be filled', async () => {
    await asOwner(db, async () => {
      // Two screenshot flights; the first one is done, the second still waits for the unnamed traveller.
      await h.addFlightPeople();
      const b = await h.unnamedDeal(DEAL, OWNER, 2);
      await h.claim();
      for (const t of b.flightTasks) {
        await one(FLIGHT, SQL.screenshotSave, [t, (await h.stateRow(t))!.row_version, JSON.stringify([sectorInput()]), rid()]);
      }
      // SYNTHETIC FIXTURE: the first flight is marked done as the owner (same assignee): the Deal is committed (no revision
      // possible), which is the R3 deadlock this command resolves. (Done is blocked while a name is missing, so the
      // flight that is done here stands in for any supplier-confirmed or completed task of the Deal.)
      await owner(`update public.fulfilment_tasks set status = 'completed', completed_at = now(), completed_by = assignee_user_id where id = $1`, [b.flightTasks[0]]);
      const slot = (await one<{ nameFill: { slots: Array<{ seq: number }> } }>(OWNER, SQL.dealSummary, [DEAL])).nameFill.slots[0]!;
      expect((await owner<{ c: boolean }>('select authz.deal_committed($1) as c', [DEAL]))[0]!.c).toBe(true);
      await refused(MANAGER, FILL_SQL, [DEAL, b.versionId, slot.seq, NAME, 'adult', rid()], 'not_authorized', '42501');
      // SYNTHETIC FIXTURE: the Deal owner's Sales membership ends (left the team).
      await owner(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      const summary = await one<{ nameFill: unknown }>(MANAGER, SQL.dealSummary, [DEAL]);
      expect(summary.nameFill).not.toBeNull();
      await one(MANAGER, FILL_SQL, [DEAL, b.versionId, slot.seq, NAME, 'adult', rid()]);
      expect(await owner('select full_name from public.deal_travellers where deal_id = $1 and seq = $2', [DEAL, slot.seq])).toEqual([{ full_name: NAME }]);
      const [audit] = await owner<{ actor_user_id: string }>(`select actor_user_id from public.audit_events where action = 'booking.traveller_name_filled'`);
      expect(audit!.actor_user_id).toBe(U.managerDelhi);
    });
  });
});
