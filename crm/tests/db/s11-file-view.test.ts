import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC_BOX, ACCOUNTS, ANON, type Attempt, DEAL, DESK, ID_BOX, MANAGER, OWNER, PURCHASE, SALES_B, SQL, SUPER, SVC, s11Helpers,
} from './s11-support';

/**
 * S11 "files to Bitrix", the view path (migration 20261212000130; contract
 * file 14 section 2.4, file 11 sections 2.4 (g)(h) and 4.2 "s11-file-view"):
 *   - for each of the seven tables file_view_begin refuses exactly when that
 *     table's existing authorize function refuses (every role fixture,
 *     Purchase-only included, a removed deal, a file that is not stored) and
 *     writes the same audit row; its answer is that function's answer plus
 *     only the location;
 *   - a Purchase-only user is refused every customer payment proof whether the
 *     file is in the CRM or in Bitrix, with the same code and no difference in
 *     the answer; no selling price, margin or payment detail appears in any
 *     error or answer of file_view_begin, file_view_resolve, file_view_finish;
 *   - an unknown table is refused; the answer to the user's session holds no
 *     Bitrix id, box key or file id; a row without a CRM copy (any state) or
 *     delete_pending is routed to Bitrix;
 *   - file_view_resolve: once, within 60 seconds, unfinished views only;
 *     file_view_finish: same person, once; the 30-a-minute view limit.
 * Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const s = s11Helpers(() => db);
const { one, owner } = s;

/** Every role fixture (Purchase-only, Visa-only, Accounts, Super Admin, other branch, other company, aal1, former staff). */
const ACTORS: Array<[string, Actor]> = [
  ['sales owner', OWNER],
  ['sales other', SALES_B],
  ['manager Delhi', MANAGER],
  ['purchase only', PURCHASE],
  ['accounts', ACCOUNTS],
  ['super admin', SUPER],
  ['visa desk', DESK],
  ['sales Ahmedabad', { userId: U.salesAhmedabad }],
  ['manager Ahmedabad', { userId: U.managerAhmedabad }],
  ['other company', { userId: U.salesEntityB }],
  ['former staff', { userId: U.formerStaff }],
  ['owner at aal1', { userId: U.salesDelhiA, aal: 'aal1' }],
];
const BITRIX_DEAL = 993601;
const FORBIDDEN = /sell|margin|paise|amount|payer|price|commercial|receipt|utr|pan\b|bitrix|ufcrm|https?:/i;

const AUTHORIZE: Record<string, string> = {
  traveller_id_proofs: 'traveller_id_proof_authorize_download',
  department_evidence: 'department_evidence_authorize_download',
  customer_party_documents: 'customer_party_document_authorize_download',
  finance_evidence: 'finance_evidence_authorize_download',
  refund_evidence: 'refund_evidence_authorize_download',
  supplier_money_evidence: 'supplier_money_evidence_authorize_download',
  booking_evidence: 'booking_authorize_evidence_download',
};

/** Gives a listed file a Bitrix identity and makes Bitrix hold its only copy (any state). */
async function soleCopyOf(table: string, id: string, fileId: number, state = 'deleted'): Promise<string> {
  const moveId = await s.moveIdOf(table, id);
  await s.settings({ box: ACC_BOX });
  await s.setMove(moveId, `source_deal_id = ${BITRIX_DEAL}, source_portal = 'SYNTHETIC_MEMBER_0001',
    bitrix_field = case when m.file_class = 'id_proof' then '${ID_BOX}' else '${ACC_BOX}' end`);
  await s.soleCopy(moveId, fileId, state);
  return moveId;
}

/** Calls the authorize function and file_view_begin as the actor (each rolled back) and asserts they agree. */
async function agree(label: string, actor: Actor, table: string, id: string, expectLocation?: 'crm' | 'bitrix'): Promise<{ direct: Attempt; begin: Attempt }> {
  const direct = await s.attempt(actor, `select public.${AUTHORIZE[table]}($1) as r`, [id]);
  const begin = await s.attempt(actor, SQL.viewBegin, [table, id]);
  expect(begin.ok, `${label}: allowed the same`).toBe(direct.ok);
  if (direct.ok) {
    const { location, viewId, ...rest } = begin.value as Record<string, unknown>;
    expect(rest, `${label}: the authorize answer, unchanged`).toEqual(direct.value);
    expect(begin.audits, `${label}: the same audit rows`).toEqual(direct.audits);
    expect(direct.audits.length, `${label}: the view is audited`).toBeGreaterThan(0);
    if (expectLocation) expect(location, label).toBe(expectLocation);
    if (location === 'bitrix') expect(viewId, label).toEqual(expect.any(String));
    else expect(viewId, label).toBeUndefined();
    expect(Object.keys(begin.value as object).sort().filter((k) => !['fileName', 'location', 'mime', 'objectPath', 'viewId'].includes(k))).toEqual([]);
    expect(JSON.stringify(begin.value)).not.toMatch(new RegExp(`${BITRIX_DEAL}|${ID_BOX}|${ACC_BOX}|"14\\d\\d"`));
  } else {
    expect(begin.error, `${label}: the same refusal`).toEqual(direct.error);
    for (const field of [begin.error!.message, begin.error!.hint, begin.error!.detail]) {
      expect(field ?? '', `${label}: nothing leaks in the refusal`).not.toMatch(FORBIDDEN);
    }
  }
  return { direct, begin };
}

/** Runs the whole comparison for a table's files: in the CRM, with Bitrix holding the only copy, on a removed deal, unstored. */
async function compareTable(table: string, stored: string[], pending: string, opts: { deal?: string } = {}) {
  const allowed = new Set<string>();
  for (const id of stored) {
    for (const [name, actor] of ACTORS) {
      const { direct } = await agree(`${table} ${name} (CRM)`, actor, table, id, 'crm');
      if (direct.ok) allowed.add(name);
    }
    // ANON: no grant on either function (the message names the function), both 42501.
    const anon = await s.attempt(ANON, SQL.viewBegin, [table, id]);
    expect(anon.error?.code).toBe('42501');
  }
  expect(allowed.size, `${table}: some role may open the file`).toBeGreaterThan(0);
  for (const [name, actor] of ACTORS) await agree(`${table} ${name} (not stored)`, actor, table, pending);
  expect(await s.moveOf(table, pending)).toBeUndefined();

  // Bitrix holds the only copy: the same people are allowed and refused, with the same answers.
  const listed: string[] = [];
  for (const [i, id] of stored.entries()) {
    if (!(await s.moveOf(table, id))) continue;
    await soleCopyOf(table, id, 1400 + i);
    listed.push(id);
  }
  expect(listed.length, `${table}: a moving file`).toBeGreaterThan(0);
  for (const id of listed) {
    for (const [name, actor] of ACTORS) await agree(`${table} ${name} (Bitrix)`, actor, table, id, 'bitrix');
  }
  if (opts.deal) {
    await s.removeDeal(opts.deal);
    for (const id of stored) {
      for (const [name, actor] of ACTORS) await agree(`${table} ${name} (removed deal)`, actor, table, id);
    }
  }
  return allowed;
}

describe('file_view_begin refuses exactly when the authorize function refuses, for each of the seven tables', () => {
  it('traveller_id_proofs', async () => {
    await asOwner(db, async () => {
      const f = await s.proofFiles();
      await compareTable('traveller_id_proofs', f.stored, f.pending, { deal: DEAL });
    });
  }, 300_000);

  it('booking_evidence', async () => {
    await asOwner(db, async () => {
      const f = await s.bookingFiles();
      await compareTable('booking_evidence', [f.acceptance, f.payment, f.bill], f.pending, { deal: DEAL });
    });
  }, 300_000);

  it('finance_evidence', async () => {
    await asOwner(db, async () => {
      const f = await s.financeFiles();
      const allowed = await compareTable('finance_evidence', [f.bankProof, f.chequeImage, f.slip], f.pending, { deal: DEAL });
      expect(allowed.has('purchase only')).toBe(false);
    });
  }, 300_000);

  it('refund_evidence', async () => {
    await asOwner(db, async () => {
      const stored = await s.refundFile(DEAL);
      const pending = await s.refundFile(DEAL, { status: 'pending_upload' });
      const allowed = await compareTable('refund_evidence', [stored.id], pending.id, { deal: DEAL });
      expect(allowed.has('purchase only')).toBe(false);
    });
  }, 300_000);

  it('supplier_money_evidence', async () => {
    await asOwner(db, async () => {
      const pkg = await s.confirmedPackage();
      const stored = [
        await s.supplierMoneyFile(pkg.purchaseTask, 'proforma'),
        await s.supplierMoneyFile(pkg.purchaseTask, 'invoice'),
        await s.supplierMoneyFile(pkg.purchaseTask, 'credit_note'),
      ];
      const pending = await s.supplierMoneyFile(pkg.purchaseTask, 'invoice', 'pending_upload');
      await compareTable('supplier_money_evidence', stored, pending, { deal: DEAL });
    });
  }, 300_000);

  it('department_evidence', async () => {
    await asOwner(db, async () => {
      const pkg = await s.confirmedPackage();
      const stored = [
        await s.departmentFile(pkg.visaTask, 'applicant_document'),
        await s.departmentFile(pkg.visaTask, 'fee_receipt'),
        await s.departmentFile(pkg.visaTask, 'direct_payment_proof'),
        await s.departmentFile(pkg.visaTask, 'other'),
      ];
      const pending = await s.departmentFile(pkg.visaTask, 'applicant_document', 'pending_upload');
      await compareTable('department_evidence', stored, pending, { deal: DEAL });
    });
  }, 300_000);

  it('customer_party_documents', async () => {
    await asOwner(db, async () => {
      const stored = [await s.partyFile('id_proof'), await s.partyFile('gst_certificate')];
      const pending = await s.partyFile('id_proof', 'pending_upload');
      await compareTable('customer_party_documents', stored, pending);
    });
  }, 300_000);

  it('an unknown table or a missing id is refused before any authorize function runs; no dynamic SQL', async () => {
    await asOwner(db, async () => {
      for (const table of ['purchase_evidence', 'TRAVELLER_ID_PROOFS', 'traveller_id_proofs; select 1', '', null]) {
        const a = await s.attempt(OWNER, SQL.viewBegin, [table, crypto.randomUUID()]);
        expect(a.error).toMatchObject({ code: '22023', message: 'invalid_input', hint: 'sourceTable' });
      }
      const a = await s.attempt(OWNER, SQL.viewBegin, ['traveller_id_proofs', null]);
      expect(a.error).toMatchObject({ code: '22023', message: 'invalid_input', hint: 'sourceId' });
      const [src] = await owner<{ s: string }>(`select p.prosrc as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'file_view_begin'`);
      const body = src!.s;
      expect(body).not.toMatch(/\bexecute\b|format\(/i);
      const location = body.indexOf('from public.file_bitrix_moves');
      for (const [table, fn] of Object.entries(AUTHORIZE)) {
        expect(body.indexOf(`when '${table}' then public.${fn}(p_source_id)`), table).toBeGreaterThan(0);
        expect(body.indexOf(`public.${fn}(p_source_id)`), table).toBeLessThan(location);
      }
    });
  });
});

describe('Purchase never sees a customer payment proof, in the CRM or in Bitrix', () => {
  it('the Purchase-only user is refused every customer payment proof with the same answer wherever the file is', async () => {
    await asOwner(db, async () => {
      const roles = await owner<{ role_code: string }>('select distinct role_code from public.memberships where user_id = $1 and status = $2',
        [U.purchaseJodhpur, 'active']);
      expect(roles.map((x) => x.role_code)).toEqual(['purchase']);
      const fin = await s.financeFiles();
      const booking = await s.bookingFiles();
      const refund = await s.refundFile(DEAL);
      const proofs: Array<[string, string, Actor]> = [
        ['finance_evidence', fin.bankProof, ACCOUNTS],
        ['finance_evidence', fin.chequeImage, ACCOUNTS],
        ['booking_evidence', booking.payment, OWNER],
        ['refund_evidence', refund.id, ACCOUNTS],
      ];
      const views = async () => Number((await owner<{ n: string }>('select count(*)::text as n from public.file_bitrix_views'))[0]!.n);
      for (const [i, [table, id, entitled]] of proofs.entries()) {
        const inCrm = await agree(`${table} purchase (CRM)`, PURCHASE, table, id);
        expect(inCrm.begin.ok, `${table}: refused`).toBe(false);
        await soleCopyOf(table, id, 1450 + i);
        const before = await views();
        const inBitrix = await agree(`${table} purchase (Bitrix)`, PURCHASE, table, id);
        expect(inBitrix.begin.error, `${table}: no difference between CRM and Bitrix`).toEqual(inCrm.begin.error);
        expect(await views()).toBe(before);
        // The person entitled to the file does get it from Bitrix: the refusal above is the rule, not a missing file.
        const ok = await agree(`${table} entitled (Bitrix)`, entitled, table, id, 'bitrix');
        expect(ok.begin.ok).toBe(true);
      }
    });
  }, 300_000);

  it('no selling price, margin or payment detail in any answer or error of the three view functions', async () => {
    await asOwner(db, async () => {
      const fin = await s.financeFiles();
      await soleCopyOf('finance_evidence', fin.bankProof, 1461);
      const begun = await one<Record<string, unknown>>(ACCOUNTS, SQL.viewBegin, ['finance_evidence', fin.bankProof]);
      expect(Object.keys(begun).sort()).toEqual(['fileName', 'location', 'mime', 'objectPath', 'viewId']);
      const resolved = await one<Record<string, unknown>>(SVC, SQL.viewResolve, [begun.viewId]);
      expect(Object.keys(resolved).sort()).toEqual(['bitrixDealId', 'bitrixField', 'bitrixFileId', 'mime', 'sha256', 'sizeBytes']);
      const finished = await one<Record<string, unknown>>(ACCOUNTS, SQL.viewFinish, [begun.viewId, 'served']);
      expect(finished).toEqual({ outcome: 'served' });
      for (const value of [begun, resolved, finished]) expect(JSON.stringify(value)).not.toMatch(/sell|margin|paise|amount|payer|price|receipt/i);
      const errors = [
        await s.failure(PURCHASE, SQL.viewBegin, ['finance_evidence', fin.bankProof]),
        await s.failure(ACCOUNTS, SQL.viewBegin, ['nope', fin.bankProof]),
        await s.failure(SVC, SQL.viewResolve, [begun.viewId]),
        await s.failure(PURCHASE, SQL.viewFinish, [begun.viewId, 'served']),
        await s.failure(ACCOUNTS, SQL.viewFinish, [begun.viewId, 'served']),
        await s.failure(ACCOUNTS, SQL.viewFinish, [begun.viewId, 'anything']),
      ];
      for (const e of errors) {
        expect(e).not.toBeNull();
        expect(['not_authorized', 'not_found', 'invalid_input', 'wrong_state']).toContain(e!.message);
        expect([e!.hint, e!.detail].join(' ')).not.toMatch(FORBIDDEN);
      }
      // The finish audit carries codes and ids only.
      const [audit] = await s.audits('files.served_from_bitrix');
      expect(Object.keys(audit!.details).sort()).toEqual(['moveId', 'outcome', 'sourceId', 'sourceTable', 'viewId']);
    });
  }, 300_000);
});

describe('where a view goes', () => {
  it('a row without a CRM copy goes to Bitrix in any state; delete_pending goes to Bitrix; every other row to the CRM', async () => {
    await asOwner(db, async () => {
      const f = await s.proofFiles();
      const id = f.stored[0]!;
      const moveId = await soleCopyOf('traveller_id_proofs', id, 1471);
      const where = async () => (await one<{ location: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', id])).location;
      for (const state of ['deleted', 'quarantined', 'needs_manual_check', 'failed', 'restore_pending', 'lost_in_bitrix', 'lost_accepted']) {
        await s.setMove(moveId, `state = '${state}'`);
        expect(await where(), state).toBe('bitrix');
      }
      await s.setMoveAsCopyWriter(moveId, `state = 'delete_pending', crm_copy_present = true`);
      expect(await where(), 'delete_pending').toBe('bitrix');
      for (const state of ['verified', 'copied', 'quarantined', 'waiting', 'no_target', 'cancelled']) {
        await s.setMove(moveId, `state = '${state}'`);
        expect(await where(), state).toBe('crm');
      }
      // A file with no move row at all (class C) stays in the CRM.
      const booking = await s.bookingFiles();
      expect((await one<{ location: string }>(OWNER, SQL.viewBegin, ['booking_evidence', booking.acceptance])).location).toBe('crm');
    });
  }, 300_000);
});

describe('file_view_resolve and file_view_finish', () => {
  async function bitrixView() {
    const f = await s.proofFiles();
    const moveId = await soleCopyOf('traveller_id_proofs', f.stored[0]!, 1481);
    const begun = await one<{ viewId: string; location: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', f.stored[0]!]);
    expect(begun.location).toBe('bitrix');
    return { moveId, viewId: begun.viewId, fileId: f.stored[0]!, other: f.stored[1]! };
  }

  it('resolve: service role only, once, within 60 seconds, unfinished views only', async () => {
    await asOwner(db, async () => {
      const v = await bitrixView();
      await s.refusedWith(OWNER, SQL.viewResolve, [v.viewId], '42501');
      const m = await s.move(v.moveId);
      expect(await one(SVC, SQL.viewResolve, [v.viewId])).toEqual({
        bitrixDealId: String(BITRIX_DEAL), bitrixField: ID_BOX, bitrixFileId: '1481', sha256: m.sha256, sizeBytes: 2048, mime: 'image/jpeg',
      });
      await s.refusedWith(SVC, SQL.viewResolve, [v.viewId], 'P0002', 'not_found');
      await s.refusedWith(SVC, SQL.viewResolve, [crypto.randomUUID()], 'P0002', 'not_found');
      // A view begun more than 60 seconds ago.
      const entity = await s.entityId();
      const [old] = await owner<{ id: string }>(
        `insert into public.file_bitrix_views (legal_entity_id, actor_user_id, move_id, started_at) values ($1, $2, $3, now() - interval '61 seconds') returning id`,
        [entity, U.salesDelhiA, v.moveId]);
      await s.refusedWith(SVC, SQL.viewResolve, [old!.id], 'P0002', 'not_found');
      // A finished view.
      const again = await one<{ viewId: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', v.fileId]);
      expect(await one(OWNER, SQL.viewFinish, [again.viewId, 'bitrix_unavailable'])).toEqual({ outcome: 'bitrix_unavailable' });
      await s.refusedWith(SVC, SQL.viewResolve, [again.viewId], 'P0002', 'not_found');
    });
  }, 300_000);

  it('finish: the same person, once; served needs a resolved view; audited; the view row keeps who, which file and the outcome', async () => {
    await asOwner(db, async () => {
      const v = await bitrixView();
      await s.refusedWith(OWNER, SQL.viewFinish, [v.viewId, 'opened'], '22023', 'invalid_input', 'outcome');
      await s.refusedWith(OWNER, SQL.viewFinish, [v.viewId, 'served'], '55000', 'wrong_state', 'not_resolved');
      await one(SVC, SQL.viewResolve, [v.viewId]);
      for (const other of [SALES_B, SUPER, { userId: U.salesDelhiA, aal: 'aal1' } as Actor]) {
        await s.refusedWith(other, SQL.viewFinish, [v.viewId, 'served'], 'P0002', 'not_found');
      }
      expect(await one(OWNER, SQL.viewFinish, [v.viewId, 'served'])).toEqual({ outcome: 'served' });
      await s.refusedWith(OWNER, SQL.viewFinish, [v.viewId, 'served'], '55000', 'wrong_state', 'finished');
      const [row] = await owner<{ actor: string; move: string; outcome: string; finished: boolean; resolved: boolean }>(
        `select actor_user_id as actor, move_id as move, outcome, finished_at is not null as finished, resolved_at is not null as resolved
         from public.file_bitrix_views where id = $1`, [v.viewId]);
      expect(row).toEqual({ actor: U.salesDelhiA, move: v.moveId, outcome: 'served', finished: true, resolved: true });
      const [audit] = await s.audits('files.served_from_bitrix');
      expect(audit).toMatchObject({ actor_user_id: U.salesDelhiA, details: { viewId: v.viewId, moveId: v.moveId, outcome: 'served',
        sourceTable: 'traveller_id_proofs', sourceId: v.fileId } });
    });
  }, 300_000);

  it('finish mismatch quarantines and turns the delete switch off; not_found_in_bitrix queues a search; deal_not_found opens an alert', async () => {
    await asOwner(db, async () => {
      const v = await bitrixView();
      await s.settings({ box: ACC_BOX, check: true, del: true });
      await one(SVC, SQL.viewResolve, [v.viewId]);
      expect(await one(OWNER, SQL.viewFinish, [v.viewId, 'mismatch'])).toEqual({ outcome: 'mismatch' });
      expect(await s.move(v.moveId)).toMatchObject({ state: 'quarantined', crm_copy_present: false, last_error_code: 'copy_mismatch' });
      expect((await s.settingsRow())!.delete_after_hold).toBe(false);
      expect((await s.stops()).map((x) => [x.move_id, x.reason_code])).toEqual([[v.moveId, 'copy_mismatch']]);

      const m2 = await soleCopyOf('traveller_id_proofs', v.other, 1482);
      await s.settings({ box: ACC_BOX, check: true, del: true });
      const v2 = await one<{ viewId: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', v.other]);
      await one(SVC, SQL.viewResolve, [v2.viewId]);
      await one(OWNER, SQL.viewFinish, [v2.viewId, 'not_found_in_bitrix']);
      expect(await s.move(m2)).toMatchObject({ state: 'deleted', relocate_due: true, last_error_code: 'missing_at_view' });

      const v3 = await one<{ viewId: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', v.other]);
      await one(SVC, SQL.viewResolve, [v3.viewId]);
      await one(OWNER, SQL.viewFinish, [v3.viewId, 'deal_not_found']);
      expect((await s.stops()).map((x) => [x.move_id, x.reason_code])).toContainEqual([m2, 'deal_not_found']);
    });
  }, 300_000);

  it('a mismatch reported while the row is delete_pending opens the stop and lets the delete step settle it', async () => {
    await asOwner(db, async () => {
      const f = await s.proofFiles();
      const moveId = await soleCopyOf('traveller_id_proofs', f.stored[0]!, 1483);
      await s.setMoveAsCopyWriter(moveId, `state = 'delete_pending', crm_copy_present = true`);
      const v = await one<{ viewId: string; location: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', f.stored[0]!]);
      expect(v.location).toBe('bitrix');
      await one(SVC, SQL.viewResolve, [v.viewId]);
      await one(OWNER, SQL.viewFinish, [v.viewId, 'mismatch']);
      expect((await s.move(moveId)).state).toBe('delete_pending');
      expect((await s.stops()).map((x) => [x.move_id, x.reason_code])).toEqual([[moveId, 'copy_mismatch']]);
    });
  }, 300_000);
});

describe('view limit', () => {
  it('30 Bitrix views by one person within a minute: the next is refused (PT429 view_limit); older views and CRM views do not count', async () => {
    await asOwner(db, async () => {
      const f = await s.proofFiles();
      const moveId = await soleCopyOf('traveller_id_proofs', f.stored[0]!, 1491);
      const entity = await s.entityId();
      const seed = (n: number, ago: string) =>
        owner(`insert into public.file_bitrix_views (legal_entity_id, actor_user_id, move_id, started_at)
               select $1::uuid, $2::uuid, $3::uuid, now() - $4::interval from generate_series(1, $5::int)`, [entity, U.salesDelhiA, moveId, ago, n]);
      await seed(40, '2 minutes');
      await seed(29, '10 seconds');
      expect((await one<{ location: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', f.stored[0]!])).location).toBe('bitrix');
      await s.refusedWith(OWNER, SQL.viewBegin, ['traveller_id_proofs', f.stored[0]!], 'PT429', 'view_limit');
      // Another person is not limited; a file in the CRM is not counted.
      let other: Actor | undefined;
      for (const candidate of [MANAGER, ACCOUNTS, SUPER]) {
        if ((await s.attempt(candidate, 'select public.traveller_id_proof_authorize_download($1) as r', [f.stored[0]!])).ok) {
          other = candidate;
          break;
        }
      }
      expect(other, 'a second person allowed to open the proof').toBeDefined();
      expect((await one<{ location: string }>(other!, SQL.viewBegin, ['traveller_id_proofs', f.stored[0]!])).location).toBe('bitrix');
      expect((await one<{ location: string }>(OWNER, SQL.viewBegin, ['traveller_id_proofs', f.stored[1]!])).location).toBe('crm');
    });
  }, 300_000);
});
