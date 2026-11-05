import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { ACC, ACC2, ANON, DEAL, MANAGER, PURCHASE, SALES, SUPER, financeHelpers, rid } from './finance-support';

/**
 * Stage 2 company destinations (stage-2-company-destinations-contract-2026-10-08.md,
 * stage-2-implementation-addendum-2026-10-08.md): maker/checker, immutable
 * versions, expected versions, exact replay, retirement, private values,
 * synthetic separation and receipt binding. Synthetic values only; every
 * scenario runs in one rolled-back owner transaction.
 */

const FINANCE_DB_TEST_LOCK = 5_000_000_001n;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [FINANCE_DB_TEST_LOCK.toString()]);
});
afterAll(async () => {
  await db?.close();
});

const h = financeHelpers(() => db);

const ACCOUNT = '000987654321';
const UPI = 'synthetic.collect@synbank';
const BANK_VALUES = { holderName: 'Synthetic Holidays Ltd', bankName: 'Synthetic Bank', accountNumber: ACCOUNT, ifsc: 'synb0001234' };

type Result = { outcome: string; id: string; destinationId: string; versionId: string; versionNo: number; status: string; rowVersion: number };
type View = {
  destinationId: string; state: string; rowVersion: number; label: string;
  current: { versionId: string; versionNo: number; accountMasked: string | null; upiMasked: string | null } | null;
  pending: { versionId: string; versionNo: number } | null;
  versions: Array<{ versionNo: number; status: string; predecessorVersionNo: number | null }>;
  actions: { submit: string | null; decide: string | null; retire: string | null };
};

const SUBMIT = 'select public.company_destination_submit($1, $2, $3::jsonb, $4, $5) as r';
const APPROVE = 'select public.company_destination_approve($1, $2, $3) as r';
const RETURN = 'select public.company_destination_return($1, $2, $3, $4) as r';
const RETIRE = 'select public.company_destination_retire($1, $2, $3, $4) as r';
const LIST = 'select public.company_destinations_list($1) as r';
const OPTIONS = 'select public.company_destination_options($1) as r';
const DETAIL = 'select public.company_destination_version_detail($1) as r';

async function submitNew(actor: Actor, kind: 'bank' | 'upi' = 'bank', requestId = rid()): Promise<Result> {
  const fields = kind === 'bank'
    ? { kind, label: 'Synthetic current account', ...BANK_VALUES }
    : { kind, label: 'Synthetic UPI collection', payeeName: 'Synthetic Holidays', upiId: UPI };
  return h.one<Result>(actor, SUBMIT, [await h.entityId(), null, JSON.stringify(fields), null, requestId]);
}
const submitNext = async (actor: Actor, destinationId: string, rowVersion: number, values: Record<string, string>, requestId = rid()) =>
  h.one<Result>(actor, SUBMIT, [await h.entityId(), destinationId, JSON.stringify(values), rowVersion, requestId]);
const approve = (actor: Actor, versionId: string, rowVersion: number, requestId = rid()) =>
  h.one<Result>(actor, APPROVE, [versionId, rowVersion, requestId]);
const view = async (actor: Actor, destinationId: string): Promise<View> => {
  const page = await h.one<{ destinations: View[] }>(actor, LIST, [await h.entityId()]);
  return page.destinations.find((d) => d.destinationId === destinationId)!;
};
/** Approved bank destination: ACC submits, ACC2 approves. */
async function approvedBank(): Promise<{ destinationId: string; versionId: string; rowVersion: number }> {
  const s = await submitNew(ACC);
  const a = await approve(ACC2, s.versionId, s.rowVersion);
  return { destinationId: s.destinationId, versionId: s.versionId, rowVersion: a.rowVersion };
}
const bankReceipt = async (destinationVersionId: string, over: Record<string, unknown> = {}) =>
  h.bankFields({ destinationVersionId, ...over });

describe('maker and checker', () => {
  it('submits version 1, refuses self-approval and self-return, and lets another Accounts person approve', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const s = await submitNew(ACC);
      expect(s).toMatchObject({ outcome: 'created', versionNo: 1, status: 'submitted' });
      expect((await view(ACC, s.destinationId)).actions.decide).toBe('own_record');
      await h.refused(ACC, APPROVE, [s.versionId, s.rowVersion, rid()], '42501', 'not_self_approval');
      await h.refused(ACC, RETURN, [s.versionId, s.rowVersion, 'Synthetic self return reason', rid()], '42501', 'not_self_approval');
      expect(await h.one<unknown[]>(ACC, OPTIONS, [DEAL])).toEqual([]);
      const a = await approve(ACC2, s.versionId, s.rowVersion);
      expect(a).toMatchObject({ outcome: 'updated', status: 'approved' });
      const v = await view(ACC, s.destinationId);
      expect(v.state).toBe('approved');
      expect(v.current).toMatchObject({ versionNo: 1, accountMasked: 'XXXX4321' });
      expect(await h.one<Array<{ versionId: string }>>(ACC, OPTIONS, [DEAL])).toEqual([
        expect.objectContaining({ versionId: s.versionId, accountMasked: 'XXXX4321' }),
      ]);
    });
  });

  it('a replacement waits for approval while the current version stays selectable; approval supersedes the old version', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const first = await approvedBank();
      const next = await submitNext(ACC2, first.destinationId, first.rowVersion, { ...BANK_VALUES, accountNumber: '000111222333' });
      expect(next).toMatchObject({ versionNo: 2, status: 'submitted' });
      expect((await h.one<Array<{ versionId: string }>>(ACC, OPTIONS, [DEAL])).map((o) => o.versionId)).toEqual([first.versionId]);
      await h.refused(ACC2, APPROVE, [next.versionId, next.rowVersion, rid()], '42501', 'not_self_approval');
      await approve(ACC, next.versionId, next.rowVersion);
      const v = await view(ACC, first.destinationId);
      expect(v.current).toMatchObject({ versionNo: 2, accountMasked: 'XXXX2333' });
      expect(v.versions.map((x) => [x.versionNo, x.status, x.predecessorVersionNo])).toEqual([[2, 'approved', 1], [1, 'superseded', null]]);
      expect((await h.one<Array<{ versionId: string }>>(ACC, OPTIONS, [DEAL])).map((o) => o.versionId)).toEqual([next.versionId]);
    });
  });

  it('a returned version keeps its reason; the correction is a new linked version', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const s = await submitNew(ACC, 'upi');
      const r = await h.one<Result>(ACC2, RETURN, [s.versionId, s.rowVersion, 'Synthetic: payee name differs from the app', rid()]);
      expect(r.status).toBe('returned');
      expect((await view(ACC, s.destinationId)).state).toBe('returned');
      const fixed = await submitNext(ACC, s.destinationId, r.rowVersion, { payeeName: 'Synthetic Holidays Pvt', upiId: UPI });
      const v = await view(ACC, s.destinationId);
      expect(v.state).toBe('submitted');
      expect(v.versions.map((x) => [x.versionNo, x.status, x.predecessorVersionNo])).toEqual([[2, 'submitted', 1], [1, 'returned', null]]);
      expect(fixed.versionNo).toBe(2);
    });
  });
});

describe('expected versions, one open version and replay', () => {
  it('refuses stale submit, approve, return and retire with version_changed', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const stale = d.rowVersion - 1;
      await h.refused(ACC, SUBMIT, [await h.entityId(), d.destinationId, JSON.stringify(BANK_VALUES), stale, rid()], '40001', 'version_changed');
      const next = await submitNext(ACC, d.destinationId, d.rowVersion, BANK_VALUES);
      await h.refused(ACC2, APPROVE, [next.versionId, d.rowVersion, rid()], '40001', 'version_changed');
      await h.refused(ACC2, RETURN, [next.versionId, d.rowVersion, 'Synthetic stale return reason', rid()], '40001', 'version_changed');
      await h.refused(ACC2, RETIRE, [d.destinationId, d.rowVersion, 'Synthetic stale retire reason', rid()], '40001', 'version_changed');
    });
  });

  it('allows one open version per destination', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const next = await submitNext(ACC, d.destinationId, d.rowVersion, BANK_VALUES);
      expect((await view(ACC2, d.destinationId)).actions.submit).toBe('wrong_state');
      await h.refused(ACC2, SUBMIT, [await h.entityId(), d.destinationId, JSON.stringify(BANK_VALUES), next.rowVersion, rid()], '55000', 'wrong_state');
    });
  });

  it('replays an exact retry; a changed payload or another actor with the same request id is refused', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const requestId = rid();
      const first = await submitNew(ACC, 'bank', requestId);
      const again = await submitNew(ACC, 'bank', requestId);
      expect(again).toMatchObject({ outcome: 'existing', versionId: first.versionId });
      await h.refused(ACC, SUBMIT, [await h.entityId(), null, JSON.stringify({ kind: 'upi', label: 'Other', payeeName: 'X', upiId: UPI }), null, requestId], '40001', 'request_conflict');
      await h.refused(ACC2, SUBMIT, [await h.entityId(), null, JSON.stringify({ kind: 'bank', label: 'Synthetic current account', ...BANK_VALUES }), null, requestId], '40001', 'request_conflict');
      const approveId = rid();
      await approve(ACC2, first.versionId, first.rowVersion, approveId);
      expect((await approve(ACC2, first.versionId, first.rowVersion, approveId)).outcome).toBe('existing');
      const stored = await h.owner<{ result: unknown }>('select result from public.finance_command_results where request_id = any($1::uuid[])', [[requestId, approveId]]);
      expect(JSON.stringify(stored)).not.toContain(ACCOUNT);
    });
  });
});

describe('retirement', () => {
  it('retires immediately with a reason; it stops selection, keeps history and allows only a return of an open version', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const next = await submitNext(ACC, d.destinationId, d.rowVersion, BANK_VALUES);
      await h.refused(ACC, RETIRE, [d.destinationId, next.rowVersion, 'short', rid()], '22023', 'invalid_input');
      const retired = await h.one<Result>(ACC, RETIRE, [d.destinationId, next.rowVersion, 'Synthetic: account closed by the bank', rid()]);
      expect(retired.status).toBe('retired');
      expect(await h.one<unknown[]>(ACC, OPTIONS, [DEAL])).toEqual([]);
      const v = await view(ACC2, d.destinationId);
      expect(v.state).toBe('retired');
      expect(v.actions).toMatchObject({ submit: 'wrong_state', retire: 'wrong_state' });
      await h.refused(ACC2, APPROVE, [next.versionId, retired.rowVersion, rid()], '55000', 'wrong_state');
      await h.refused(ACC2, RETIRE, [d.destinationId, retired.rowVersion, 'Synthetic second retirement', rid()], '55000', 'wrong_state');
      expect((await h.one<Result>(ACC2, RETURN, [next.versionId, retired.rowVersion, 'Synthetic: destination retired', rid()])).status).toBe('returned');
    });
  });
});

describe('receipt binding', () => {
  it('stores the approved version and a snapshot that survives replacement and retirement; old receipts stay unmapped', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const rec = await h.record(ACC, DEAL, await bankReceipt(d.versionId));
      const next = await submitNext(ACC, d.destinationId, d.rowVersion, { ...BANK_VALUES, accountNumber: '000555666777' });
      await approve(ACC2, next.versionId, next.rowVersion);
      const latest = await view(ACC, d.destinationId);
      await h.one(ACC, RETIRE, [d.destinationId, latest.rowVersion, 'Synthetic: account closed by the bank', rid()]);
      const [row] = await h.owner<{ destination_version_id: string; destination_snapshot: { accountNumber: string; versionNo: number } }>(
        'select destination_version_id, destination_snapshot from public.customer_receipts where id = $1', [rec.id]);
      expect(row!.destination_version_id).toBe(d.versionId);
      expect(row!.destination_snapshot).toMatchObject({ accountNumber: ACCOUNT, versionNo: 1 });
      await h.refused(SALES, 'update public.customer_receipts set destination_snapshot = null where id = $1', [rec.id], '42501');
      await expectDbError(db, () => db.query('update public.customer_receipts set destination_version_id = $2 where id = $1', [rec.id, next.versionId]), { code: '42501' });
      const detail = await h.one<{ receipts: Array<{ receiptId: string; destination: unknown }> }>(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]);
      expect(detail.receipts.find((r) => r.receiptId === rec.id)!.destination).toEqual({
        unmapped: false, label: 'Synthetic current account', kind: 'bank', versionNo: 1, bankName: 'Synthetic Bank',
        accountMasked: 'XXXX4321', upiMasked: null,
      });
      expect(JSON.stringify(detail)).not.toContain(ACCOUNT);
      // A bank receipt recorded before Stage 2 (simulated by clearing the pair as the owner with the guard off) shows unmapped.
      const legacy = await h.record(ACC, DEAL, await h.bankFields({}));
      // Table owner, not superuser (works on PGlite and on the CI database): fire pending deferred checks first.
      await h.checkConstraints();
      await db.query('alter table public.customer_receipts disable trigger customer_receipts_a_guard');
      await db.query('update public.customer_receipts set destination_version_id = null, destination_snapshot = null where id = $1', [legacy.id]);
      await db.query('alter table public.customer_receipts enable trigger customer_receipts_a_guard');
      const after = await h.one<{ receipts: Array<{ receiptId: string; destination: unknown }> }>(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]);
      expect(after.receipts.find((r) => r.receiptId === legacy.id)!.destination).toEqual({ unmapped: true });
    });
  });

  it('refuses superseded, retired, submitted, wrong-kind and other-entity versions with destination_changed', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const next = await submitNext(ACC, d.destinationId, d.rowVersion, BANK_VALUES);
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await bankReceipt(next.versionId)), rid()], '55000', 'destination_changed');
      await approve(ACC2, next.versionId, next.rowVersion);
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await bankReceipt(d.versionId)), rid()], '55000', 'destination_changed');
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await bankReceipt(next.versionId, { mode: 'upi' })), rid()], '55000', 'destination_changed');
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await bankReceipt(rid())), rid()], '55000', 'destination_changed');
      // Cash and cheque never take a destination; bank transfer and UPI always need one.
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ destinationVersionId: next.versionId })), rid()], '22023', 'invalid_input');
      const noDestination = await h.bankFields({});
      delete noDestination.destinationVersionId;
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(noDestination), rid()], '22023', 'invalid_input');
      expect((await h.record(ACC, DEAL, await h.cashFields())).status).toBe('recorded');
    });
  });

  it('a correction selects the current version and never inherits the original receipt version', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const orig = await h.record(ACC, DEAL, await bankReceipt(d.versionId, { reference: 'UTRSTAGE2FIX1', amountPaise: '100' }));
      await h.reject(ACC2, orig.id, 'data_error');
      const next = await submitNext(ACC, d.destinationId, d.rowVersion, BANK_VALUES);
      await approve(ACC2, next.versionId, next.rowVersion);
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await bankReceipt(d.versionId, { reference: 'UTRSTAGE2FIX1', correctsReceiptId: orig.id })), rid()], '55000', 'destination_changed');
      const fixed = await h.record(ACC, DEAL, await bankReceipt(next.versionId, { reference: 'UTRSTAGE2FIX1', correctsReceiptId: orig.id }));
      const [row] = await h.owner<{ v: string }>('select destination_version_id as v from public.customer_receipts where id = $1', [fixed.id]);
      expect(row!.v).toBe(next.versionId);
    });
  });

  it('verification and money totals are unchanged by the binding', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const rec = await h.record(ACC, DEAL, await bankReceipt(d.versionId, { amountPaise: '123400' }));
      await h.proof(ACC, 'receipt', rec.id, 'bank_proof');
      await h.verify(ACC2, rec.id);
      expect(await h.available(DEAL)).toBe('123400');
      expect(await h.entries(rec.id)).toHaveLength(1);
    });
  });

  it('synthetic destinations never bind to real deals', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank(); // created in the test environment: synthetic
      await db.exec('alter table public.deals drop constraint deals_provenance');
      await db.exec('alter table public.deals drop constraint deals_source_assigned_by_provenance');
      const [real] = await db.query<{ id: string }>(
        `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
         select b.legal_entity_id, b.id, 'SYN-REAL-DEST-001', 'Synthetic row flagged real', $1, false
         from public.branches b where b.code = 'DEL' returning id`, [U.salesDelhiA]);
      await h.setEnvironment('operational');
      await db.query(`update public.finance_live_settings set bank_transfer_live = true`);
      await h.refused(ACC, h.RECORD, [real!.id, JSON.stringify(await bankReceipt(d.versionId)), rid()], '55000', 'destination_changed');
      expect(await h.one<unknown[]>(ACC, OPTIONS, [real!.id])).toEqual([]);
      const created = await submitNew(ACC);
      const [flag] = await h.owner<{ s: boolean }>('select is_synthetic as s from public.company_destinations where id = $1', [created.destinationId]);
      expect(flag!.s).toBe(false);
    });
  });
});

describe('access and private values', () => {
  it('only Accounts in the entity may use the commands; Sales, Purchase, Manager, Super Admin, anon, aal1 and inactive are refused', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      const entity = await h.entityId();
      const aal1: Actor = { userId: U.accountsJodhpur, aal: 'aal1' };
      for (const actor of [SALES, PURCHASE, MANAGER, SUPER, ANON, aal1]) {
        // Anonymous requests have no EXECUTE grant at all (permission denied); staff get not_authorized.
        const token = actor === ANON ? undefined : 'not_authorized';
        await h.refused(actor, LIST, [entity], '42501', token);
        await h.refused(actor, OPTIONS, [DEAL], '42501', token);
        await h.refused(actor, DETAIL, [d.versionId], '42501', token);
        await h.refused(actor, SUBMIT, [entity, null, JSON.stringify({ kind: 'bank', label: 'X', ...BANK_VALUES }), null, rid()], '42501', token);
        await h.refused(actor, RETIRE, [d.destinationId, d.rowVersion, 'Synthetic unauthorized retire', rid()], '42501', token);
      }
      await h.refused(ACC, LIST, [rid()], '42501', 'not_authorized');
      await h.refused(ACC, DETAIL, [rid()], '42501', 'not_authorized');
      await db.query(`update public.staff_profiles set status = 'inactive', deactivated_at = now(), deactivation_reason = 'SYNTHETIC test' where user_id = $1`, [U.visaJodhpur]);
      await h.refused(ACC2, LIST, [entity], '42501', 'not_authorized');
    });
  });

  it('a mixed Accounts and Purchase holder is refused; a Super Admin who also holds Accounts acts only through Accounts', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`, [U.accountsJodhpur]);
      await h.refused(ACC, LIST, [entity], '42501', 'not_authorized');
      await db.query(`delete from public.memberships where user_id = $1 and role_code = 'purchase'`, [U.accountsJodhpur]);
      expect((await h.one<{ entityId: string }>(ACC, LIST, [entity])).entityId).toBe(entity);
      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'`, [U.adminJodhpur]);
      const s = await submitNew(SUPER);
      expect(s.status).toBe('submitted');
    });
  });

  it('a session behind the barrier (open recovery) is refused like any other unauthorized caller', async () => {
    await asOwner(db, async () => {
      await h.one(SUPER, `select public.begin_mfa_recovery($1, 'Synthetic: lost phone, verified in person') as r`, [U.accountsJodhpur]);
      await h.refused(ACC, LIST, [await h.entityId()], '42501', 'not_authorized');
      await h.refused(ACC, SUBMIT, [await h.entityId(), null, JSON.stringify({ kind: 'bank', label: 'X', ...BANK_VALUES }), null, rid()], '42501', 'not_authorized');
    });
  });

  it('a version from another entity can never be bound to a receipt', async () => {
    await asOwner(db, async () => {
      const [other] = await h.owner<{ id: string }>(`select id from public.legal_entities where code <> 'HOLIDAY_CHACHA' order by code limit 1`);
      const [dest] = await h.owner<{ id: string }>(
        `insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
         values ($1, 'bank', 'Synthetic other entity', true, $2) returning id`, [other!.id, U.accountsJodhpur]);
      const [version] = await h.owner<{ id: string }>(
        `insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
           account_number, ifsc, status, maker, request_id, decided_by, decided_at)
         values ($1, $2, 1, 'Synthetic', 'Synthetic Bank', '000999888777', 'SYNB0009999', 'approved', $3, gen_random_uuid(), $4, now()) returning id`,
        [other!.id, dest!.id, U.accountsJodhpur, U.visaJodhpur]);
      await h.owner('update public.company_destinations set current_version_id = $1 where id = $2', [version!.id, dest!.id]);
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await bankReceipt(version!.id)), rid()], '55000', 'destination_changed');
    });
  });

  it('the current version must belong to the same destination', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const a = await approvedBank();
      const b = await approvedBank();
      await expectDbError(db, () => db.query('update public.company_destinations set current_version_id = $1 where id = $2', [b.versionId, a.destinationId]), { code: '23503' });
    });
  });

  it('labels cannot carry account numbers even with separators', async () => {
    await asOwner(db, async () => {
      for (const label of ['Acct 1234 5678 9012', 'Acct 1234-5678-9012', 'pay.me@synbank']) {
        await h.refused(ACC, SUBMIT, [await h.entityId(), null, JSON.stringify({ kind: 'bank', label, ...BANK_VALUES }), null, rid()], '22023', 'invalid_input');
      }
    });
  });

  it('values never reach the queue, the deal detail or the cash overview', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const d = await approvedBank();
      await h.record(ACC, DEAL, await bankReceipt(d.versionId));
      for (const sql of [`select public.accounts_queue('all') as r`, 'select public.accounts_deal_detail($1) as r', 'select public.accounts_cash_overview($1) as r']) {
        const params = sql.includes('deal_detail') ? [DEAL] : sql.includes('cash_overview') ? [await h.entityId()] : [];
        expect(JSON.stringify(await h.one(ACC, sql, params))).not.toContain(ACCOUNT);
      }
    });
  });

  it('direct table access is refused for every API role', async () => {
    await asOwner(db, async () => {
      for (const actor of [ANON, SALES, ACC, SUPER]) {
        for (const table of ['company_destinations', 'company_destination_versions']) {
          await h.refused(actor, `select * from public.${table} limit 1`, [], '42501');
        }
      }
    });
  });

  it('values never reach lists, audit rows, stored results or error messages, even for invalid input', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const s = await submitNew(ACC, 'upi');
      await approve(ACC2, s.versionId, s.rowVersion);
      const page = JSON.stringify(await h.one(ACC, LIST, [await h.entityId()]));
      expect(page).not.toContain(UPI);
      expect(page).toContain('s***@synbank');
      const detail = await h.one<{ upiId: string }>(ACC2, DETAIL, [s.versionId]);
      expect(detail.upiId).toBe(UPI);
      const audit = await h.owner<{ action: string; details: unknown }>(
        `select action, details from public.audit_events where target_type = 'company_destination' and target_id = $1 order by id`, [s.destinationId]);
      expect(audit.map((a) => a.action)).toEqual(['finance.destination_submitted', 'finance.destination_approved', 'finance.destination_viewed']);
      expect(JSON.stringify(audit)).not.toContain(UPI);
      for (const bad of [
        { kind: 'bank', label: 'Synthetic', holderName: 'X', bankName: 'Y', accountNumber: '12AB99887766', ifsc: 'SYNB0001234' },
        { kind: 'upi', label: 'Synthetic', payeeName: 'X', upiId: 'not-a-upi-9988776655' },
        { kind: 'bank', label: 'Account 99887766554', holderName: 'X', bankName: 'Y', accountNumber: '998877665544', ifsc: 'SYNB0001234' },
      ]) {
        const entity = await h.entityId();
        let seen: (Error & { detail?: string }) | null = null;
        await expectDbError(db, async () => {
          try {
            await h.run(ACC, SUBMIT, [entity, null, JSON.stringify(bad), null, rid()]);
          } catch (error) {
            seen = error as Error & { detail?: string };
            throw error;
          }
        }, { code: '22023', message: /^invalid_input$/ });
        const e = seen as (Error & { detail?: string }) | null;
        expect(`${e?.message} ${e?.detail ?? ''}`).not.toMatch(/9988|12AB|not-a-upi/);
      }
    });
  });
});
