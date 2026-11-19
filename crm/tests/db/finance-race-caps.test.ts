import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDestination } from './finance-support';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  istBusinessDate,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Phase 5A concurrency-sensitive rules on PGlite
 * (docs/implementation/history/contracts/phase-5a-contract.md sections 6, 9.1, 9.2, 11, 12):
 * cash caps across branches and deals, counted-cash rules with rejections,
 * reversals and corrections, the advisory keys a cash receipt holds, exact
 * retries after a policy change, request conflicts, one policy version per
 * receipt, duplicate references across bank/UPI and cheque MICR+number,
 * deposit membership (no double-counted deposit) and the mode/environment
 * gates.
 *
 * PGlite is ONE connection, so nothing here runs truly in parallel. These
 * tests prove the sequential half: the later of two receipts sees the
 * earlier one, and every cash receipt takes the contract's advisory keys in
 * ascending order before it sums. That two sessions really block on those
 * keys (and on the policy head and deal head row locks) is proven only by
 * tests/supabase/finance-concurrency.real.test.ts against real Postgres.
 */

/**
 * On real Postgres (CI job "supabase-integration", TEST_DATABASE_URL) test
 * files run in parallel against one database. Finance scenarios lock the same
 * fixture deal heads, policy head and receipt counter inside long rolled-back
 * transactions, so finance verification files take one session advisory lock
 * and run one after another instead of deadlocking each other.
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

const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur }; // second Accounts person, added per test
const ADMIN: Actor = { userId: U.adminJodhpur };

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  // On error the caller's savepoint rollback also reverts SET LOCAL ROLE.
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
async function refused(
  actor: Actor,
  sql: string,
  params: unknown[],
  code: string,
  token: string,
): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), { code, message: new RegExp(`^${token}$`) });
}

const today = () => istBusinessDate();
const rid = () => crypto.randomUUID();
async function idOf(sql: string, params: unknown[] = []): Promise<string> {
  return (await db.query<{ id: string }>(sql, params))[0]!.id;
}
const hcEntity = () => idOf(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
const branch = (code: string) => idOf(`select id from public.branches where code = $1`, [code]);
const addSecondAccounts = () =>
  db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'`,
    [U.visaJodhpur],
  );

type Fields = Record<string, unknown>;
interface Recorded {
  outcome: string;
  id: string;
  receiptNo: string;
  status: string;
}
const RECORD_SQL = 'select public.receipt_record($1, $2::jsonb, $3) as r';
const record = async (actor: Actor, dealId: string, fields: Fields, requestId = rid()) =>
  one<Recorded>(actor, RECORD_SQL, [dealId, JSON.stringify(await withDestination(db, dealId, fields)), requestId]);
const refusedRecord = async (actor: Actor, dealId: string, fields: Fields, code: string, token: string, requestId = rid()) =>
  refused(actor, RECORD_SQL, [dealId, JSON.stringify(await withDestination(db, dealId, fields)), requestId], code, token);

const cash = (branchId: string, amount: string, payer: Fields, extra: Fields = {}): Fields => ({
  mode: 'cash',
  amountPaise: amount,
  receivedOn: today(),
  branchId,
  collectorUserId: U.salesDelhiA,
  payerName: 'Synthetic Cash Payer',
  ...payer,
  ...extra,
});
const bank = (branchId: string, reference: string, mode: 'bank_transfer' | 'upi' = 'bank_transfer', extra: Fields = {}): Fields => ({
  mode,
  amountPaise: '250000',
  receivedOn: today(),
  branchId,
  payerName: 'Synthetic Payer',
  payerMobile: '9876500001',
  reference,
  ...extra,
});
const cheque = (branchId: string, micr: string, number: string, extra: Fields = {}): Fields => ({
  mode: 'cheque',
  amountPaise: '300000',
  receivedOn: today(),
  branchId,
  payerName: 'Synthetic Cheque Payer',
  payerPan: 'CHQPA1234Q',
  micrCode: micr,
  chequeNumber: number,
  chequeDate: today(),
  accountPayee: true,
  ...extra,
});

/** Policy manager sets caps effective now (same transaction timestamp). */
async function setPolicy(fields: Fields): Promise<{ id: string; rowVersion: number }> {
  return one(ADMIN, 'select public.finance_policy_update($1, $2::jsonb, null, $3, $4) as r', [
    await hcEntity(),
    JSON.stringify(fields),
    'Synthetic policy change for verification tests',
    rid(),
  ]);
}

let shaSeq = 0;
async function storeEvidence(actor: Actor, targetType: 'receipt' | 'branch', targetId: string, kind: string): Promise<string> {
  shaSeq += 1;
  const ev = await one<{ id: string; objectPath: string }>(
    actor,
    'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
    [targetType, targetId, kind, 'proof.pdf', 'application/pdf', 2048, shaSeq.toString(16).padStart(64, 'b'), rid()],
  );
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`,
    [ev.objectPath],
  );
  await one(actor, 'select public.finance_evidence_finish($1, true) as r', [ev.id]);
  return ev.id;
}

const verify = (actor: Actor, id: string) => one<{ status: string }>(actor, 'select public.receipt_verify($1, $2) as r', [id, rid()]);
const reject = (actor: Actor, id: string, kind: string) =>
  one(actor, 'select public.receipt_reject($1, $2, $3, $4) as r', [id, kind, 'Synthetic rejection reason', rid()]);
const reverse = (actor: Actor, id: string, kind: string) =>
  one(actor, 'select public.receipt_reverse($1, $2, $3, $4) as r', [id, kind, 'Synthetic reversal reason', rid()]);

async function balance(account: string, where: string, params: unknown[]): Promise<bigint> {
  const [row] = await db.query<{ b: string }>(
    `select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as b from public.finance_journal_lines l where l.account = $1 and ${where}`,
    [account, ...params],
  );
  return BigInt(row!.b);
}

// ---------------------------------------------------------------------------
// Cash caps (9.2)
// ---------------------------------------------------------------------------

describe('cash caps across branches and deals', () => {
  it('payer-day cap by PAN counts every branch and deal of the entity; exactly at the cap is allowed', async () => {
    await asOwner(db, async () => {
      await setPolicy({ cashPayerDayCapPaise: '100000', cashTripCapPaise: '1000000' });
      const [del, amd, jdh] = [await branch('DEL'), await branch('AMD'), await branch('JDH')];
      const pan = { payerPan: 'PAYER1234D' };
      await record(ACC, D.del001, cash(del, '40000', pan));
      await record(ACC, D.del002, cash(amd, '40000', pan));
      await refusedRecord(ACC, D.amd001, cash(jdh, '20001', pan), '55000', 'cash_cap_exceeded');
      expect((await record(ACC, D.amd001, cash(jdh, '20000', pan))).status).toBe('recorded');
      // Lower-case PAN is the same key.
      await refusedRecord(ACC, D.del003, cash(del, '1', { payerPan: 'payer1234d' }), '55000', 'cash_cap_exceeded');
      // Another day is another key.
      const yesterday = new Date(Date.parse(`${today()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      expect((await record(ACC, D.del003, cash(del, '100000', pan, { receivedOn: yesterday }))).status).toBe('recorded');
    });
  });

  it('payer-day cap by mobile normalises +91, spaces and a leading 0; PAN and mobile keys both apply', async () => {
    await asOwner(db, async () => {
      await setPolicy({ cashPayerDayCapPaise: '100000', cashTripCapPaise: '1000000' });
      const [del, amd] = [await branch('DEL'), await branch('AMD')];
      await record(ACC, D.del001, cash(del, '60000', { payerMobile: '+91 98765 43210' }));
      await refusedRecord(ACC, D.del002, cash(amd, '40001', { payerMobile: '09876543210' }), '55000', 'cash_cap_exceeded');
      // A new PAN does not escape the mobile key when the mobile is also given.
      await refusedRecord(ACC, D.del002, cash(amd, '40001', { payerMobile: '9876543210', payerPan: 'NEWPN1234X' }), '55000', 'cash_cap_exceeded');
      // Documented alias risk (9.2): a different PAN and mobile is a different payer key; only the trip cap applies.
      expect((await record(ACC, D.del002, cash(amd, '90000', { payerMobile: '9123456789', payerPan: 'ALIAS1234Z' }))).status).toBe('recorded');
    });
  });

  it('trip cap counts every payer and collecting branch on the deal', async () => {
    await asOwner(db, async () => {
      await setPolicy({ cashPayerDayCapPaise: '1000000', cashTripCapPaise: '150000' });
      const [del, amd, jdh] = [await branch('DEL'), await branch('AMD'), await branch('JDH')];
      await record(ACC, D.del001, cash(del, '50000', { payerPan: 'TRIPA1234A' }));
      await record(ACC, D.del001, cash(amd, '50000', { payerPan: 'TRIPB1234B' }));
      await refusedRecord(ACC, D.del001, cash(jdh, '50001', { payerPan: 'TRIPC1234C' }), '55000', 'cash_cap_exceeded');
      await record(ACC, D.del001, cash(jdh, '50000', { payerPan: 'TRIPC1234C' }));
      // Other deals are unaffected; non-cash modes never count.
      await record(ACC, D.del002, cash(jdh, '150000', { payerPan: 'TRIPD1234D' }));
      expect((await record(ACC, D.del001, bank(jdh, 'SYNTRIP0001'))).status).toBe('recorded');
    });
  });

  it('the refusal names the cap kind and writes nothing', async () => {
    await asOwner(db, async () => {
      await setPolicy({ cashPayerDayCapPaise: '100000', cashTripCapPaise: '100000' });
      const del = await branch('DEL');
      await record(ACC, D.del001, cash(del, '100000', { payerPan: 'KINDA1234A' }));
      const before = await db.query<{ n: number }>('select count(*)::int as n from public.customer_receipts');
      const counter = await db.query('select * from public.finance_receipt_counters');
      for (const [fields, kind] of [
        [cash(del, '1', { payerPan: 'KINDA1234A' }), 'payer_day'],
        [cash(del, '1', { payerPan: 'KINDB1234B' }), 'trip'],
      ] as const) {
        await db.exec('savepoint s');
        try {
          await run(ACC, RECORD_SQL, [D.del001, JSON.stringify(fields), rid()]);
          throw new Error('expected cash_cap_exceeded');
        } catch (error) {
          const e = error as { code?: string; message?: string; detail?: string };
          expect([e.code, e.message, e.detail]).toEqual(['55000', 'cash_cap_exceeded', kind]);
        } finally {
          await db.exec('rollback to savepoint s');
        }
      }
      expect(await db.query('select count(*)::int as n from public.customer_receipts')).toEqual(before);
      expect(await db.query('select * from public.finance_receipt_counters')).toEqual(counter);
    });
  });

  it('cash cap 0 means cash is off by policy', async () => {
    await asOwner(db, async () => {
      await setPolicy({ cashPayerDayCapPaise: '0' });
      await refusedRecord(ACC, D.del001, cash(await branch('DEL'), '1', { payerPan: 'ZEROC1234Z' }), '55000', 'cash_cap_exceeded');
    });
  });
});

describe('counted cash: rejections, reversals and corrections', () => {
  it('not_received outcomes free the cap; data_error outcomes keep counting', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      await setPolicy({ cashPayerDayCapPaise: '1000000', cashTripCapPaise: '100000' });
      const del = await branch('DEL');
      const a = await record(ACC, D.del001, cash(del, '100000', { payerPan: 'COUNT1234A' }));
      await refusedRecord(ACC, D.del001, cash(del, '1', { payerPan: 'COUNT1234B' }), '55000', 'cash_cap_exceeded');
      await reject(ACC2, a.id, 'data_error');
      await refusedRecord(ACC, D.del001, cash(del, '1', { payerPan: 'COUNT1234B' }), '55000', 'cash_cap_exceeded');

      const b = await record(ACC, D.del002, cash(del, '100000', { payerPan: 'COUNT1234C' }));
      await reject(ACC2, b.id, 'not_received');
      expect((await record(ACC, D.del002, cash(del, '100000', { payerPan: 'COUNT1234C' }))).status).toBe('recorded');

      const c = await record(ACC, D.del003, cash(del, '100000', { payerPan: 'COUNT1234D' }));
      await verify(ACC2, c.id);
      await reverse(ACC, c.id, 'not_received');
      expect((await record(ACC, D.del003, cash(del, '100000', { payerPan: 'COUNT1234D' }))).status).toBe('recorded');

      const d = await record(ACC, D.del004, cash(del, '100000', { payerPan: 'COUNT1234E' }));
      await verify(ACC2, d.id);
      await reverse(ACC, d.id, 'data_error');
      await refusedRecord(ACC, D.del004, cash(del, '1', { payerPan: 'COUNT1234E' }), '55000', 'cash_cap_exceeded');
    });
  });

  it('a correction replaces the original in the count (no double count) and cannot be not_received', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      await setPolicy({ cashPayerDayCapPaise: '100000', cashTripCapPaise: '100000' });
      const del = await branch('DEL');
      const orig = await record(ACC, D.del001, cash(del, '100000', { payerPan: 'CORRA1234A' }));
      await reject(ACC2, orig.id, 'data_error');
      // Correcting the full amount fits: the original no longer counts.
      const fix = await record(ACC, D.del001, cash(del, '100000', { payerPan: 'CORRA1234A' }, { correctsReceiptId: orig.id }));
      expect(fix.status).toBe('recorded');
      await refusedRecord(ACC, D.del001, cash(del, '1', { payerPan: 'CORRB1234B' }), '55000', 'cash_cap_exceeded');
      // The correction cannot be rejected or reversed as not_received (cash that arrived stays counted once).
      await refused(ACC2, 'select public.receipt_reject($1, $2, $3, $4)', [fix.id, 'not_received', 'Synthetic rejection reason', rid()], '22023', 'invalid_input');
      await verify(ACC2, fix.id);
      await refused(ACC, 'select public.receipt_reverse($1, $2, $3, $4)', [fix.id, 'not_received', 'Synthetic reversal reason', rid()], '22023', 'invalid_input');
      // A second correction of the same original is refused.
      await refused(ACC, RECORD_SQL, [D.del001, JSON.stringify(cash(del, '1', { payerPan: 'CORRA1234A' }, { correctsReceiptId: orig.id })), rid()], '55000', 'wrong_state');
      const [row] = await db.query<{ corrected_by_receipt_id: string }>('select corrected_by_receipt_id from public.customer_receipts where id = $1', [orig.id]);
      expect(row!.corrected_by_receipt_id).toBe(fix.id);
    });
  });

  it('a correction chain counts only its last link', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      await setPolicy({ cashPayerDayCapPaise: '1000000', cashTripCapPaise: '100000' });
      const del = await branch('DEL');
      const a = await record(ACC, D.del001, cash(del, '100000', { payerPan: 'CHAIN1234A' }));
      await reject(ACC2, a.id, 'data_error');
      const b = await record(ACC, D.del001, cash(del, '100000', { payerPan: 'CHAIN1234A' }, { correctsReceiptId: a.id }));
      await reject(ACC2, b.id, 'data_error');
      const c = await record(ACC, D.del001, cash(del, '100000', { payerPan: 'CHAIN1234A' }, { correctsReceiptId: b.id }));
      expect(c.status).toBe('recorded');
      await refusedRecord(ACC, D.del001, cash(del, '1', { payerPan: 'CHAIN1234B' }), '55000', 'cash_cap_exceeded');
    });
  });
});

describe('advisory cash keys (the sequential half of the race proof)', () => {
  it('a cash receipt holds exactly the payer and trip advisory keys of the contract until commit', async () => {
    await asOwner(db, async () => {
      const entity = await hcEntity();
      const del = await branch('DEL');
      const d = today();
      await record(ACC, D.del001, cash(del, '1000', { payerPan: 'LOCKS1234A', payerMobile: '+91 9876512345' }));
      const keys = [
        `cash-payer|${entity}|pan:LOCKS1234A|${d}`,
        `cash-payer|${entity}|mobile:9876512345|${d}`,
        `cash-trip|${entity}|${D.del001}`,
      ];
      const expected = await db.query<{ h: string }>(
        `select hashtextextended(k, 0)::text as h from unnest($1::text[]) as k order by 1`,
        [keys],
      );
      // The cash-branch posting key is taken only at verification, so only these three exist now.
      const held = await db.query<{ h: string }>(
        `select ((l.classid::bigint << 32) | l.objid::bigint)::text as h from pg_locks l
         where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted order by 1`,
      );
      const asSigned = held
        .map((r) => BigInt.asIntN(64, BigInt(r.h)).toString())
        .filter((h) => h !== FINANCE_DB_TEST_LOCK.toString())
        .sort();
      expect(asSigned).toEqual(expected.map((r) => r.h).sort());
    });
  });

  it('the function sums only after the deal head and advisory locks (static order check)', async () => {
    const [{ src }] = (await db.query<{ src: string }>(`select prosrc as src from pg_proc where oid = 'public.receipt_record(uuid,jsonb,uuid)'::regprocedure`)) as [{ src: string }];
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const policy = at('finance_lock_policy');
    const deal = at('finance_lock_deal');
    const advisory = at('pg_advisory_xact_lock');
    const firstSum = at('sum(r.amount_paise)');
    const counter = at('finance_receipt_counters');
    expect(policy).toBeLessThan(deal);
    expect(deal).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(firstSum);
    expect(firstSum).toBeLessThan(counter);
    expect(src).toMatch(/order by 1/);
  });
});

// ---------------------------------------------------------------------------
// Retry identity and policy versions (6, 11)
// ---------------------------------------------------------------------------

describe('retry identity and policy versions', () => {
  it('an exact retry returns the original result after a policy change; a changed payload, actor or command conflicts', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const del = await branch('DEL');
      const request = rid();
      const fields = cash(del, '400000', { payerPan: 'RETRY1234A' });
      const first = await record(ACC, D.del001, fields, request);
      expect(first.outcome).toBe('created');
      // The new policy would refuse this amount; the stored result still replays.
      await setPolicy({ cashPayerDayCapPaise: '1000', cashTripCapPaise: '1000', receiptMaxPaise: '1000' });
      const again = await record(ACC, D.del001, fields, request);
      expect(again).toEqual({ ...first, outcome: 'existing' });
      await refusedRecord(ACC, D.del001, { ...fields, amountPaise: '400001' }, '40001', 'request_conflict', request);
      await refusedRecord(ACC2, D.del001, fields, '40001', 'request_conflict', request);
      await refused(ACC, 'select public.receipt_verify($1, $2)', [first.id, request], '40001', 'request_conflict');
      expect(await db.query('select id from public.customer_receipts where request_id = $1', [request])).toHaveLength(1);
    });
  });

  it('a refused request id is not reserved', async () => {
    await asOwner(db, async () => {
      await setPolicy({ cashPayerDayCapPaise: '1000', cashTripCapPaise: '100000' });
      const del = await branch('DEL');
      const request = rid();
      await refusedRecord(ACC, D.del001, cash(del, '1001', { payerPan: 'RESER1234A' }), '55000', 'cash_cap_exceeded', request);
      expect((await record(ACC, D.del001, cash(del, '1000', { payerPan: 'RESER1234A' }), request)).outcome).toBe('created');
    });
  });

  it('each receipt stores exactly the version effective at its transaction time; a scheduled version is not used', async () => {
    await asOwner(db, async () => {
      const entity = await hcEntity();
      const del = await branch('DEL');
      const [v1] = await db.query<{ id: string }>(
        `select id from public.finance_policy_versions where legal_entity_id = $1 order by version_no desc limit 1`,
        [entity],
      );
      await one(ADMIN, `select public.finance_policy_update($1, $2::jsonb, now() + interval '1 day', $3, $4) as r`, [
        entity,
        JSON.stringify({ cashTripCapPaise: '1' }),
        'Synthetic scheduled policy for tests',
        rid(),
      ]);
      const a = await record(ACC, D.del001, cash(del, '1000', { payerPan: 'VERSN1234A' }));
      const [row] = await db.query<{ policy_version_id: string }>('select policy_version_id from public.customer_receipts where id = $1', [a.id]);
      expect(row!.policy_version_id).toBe(v1!.id);
      // An effective-now version is used by the next receipt; stored rows never change.
      await refused(ADMIN, `select public.finance_policy_update($1, $2::jsonb, null, $3, $4)`, [
        entity,
        JSON.stringify({ cashTripCapPaise: '2' }),
        'Synthetic policy before the scheduled one',
        rid(),
      ], '22023', 'invalid_input');
    });
  });

  it('policy update locks the head FOR UPDATE and receipts lock it FOR SHARE (static check)', async () => {
    const [{ src }] = (await db.query<{ src: string }>(
      `select prosrc as src from pg_proc where oid = 'authz.finance_lock_policy(uuid,boolean)'::regprocedure`,
    )) as [{ src: string }];
    expect(src).toMatch(/for update/);
    expect(src).toMatch(/for share/);
    const [{ upd }] = (await db.query<{ upd: string }>(
      `select prosrc as upd from pg_proc where oid = 'public.finance_policy_update(uuid,jsonb,timestamptz,text,uuid)'::regprocedure`,
    )) as [{ upd: string }];
    expect(upd).toMatch(/finance_lock_policy\(p_entity_id, true\)/);
  });
});

// ---------------------------------------------------------------------------
// Duplicate references (9.1)
// ---------------------------------------------------------------------------

describe('duplicate references', () => {
  it('bank transfer and UPI share one normalised namespace per entity', async () => {
    await asOwner(db, async () => {
      const del = await branch('DEL');
      await record(ACC, D.del001, bank(del, 'UTR-55-0001'));
      await refusedRecord(ACC, D.del002, bank(del, 'utr550001', 'upi'), '23505', 'duplicate_reference');
      await refusedRecord(ACC, D.del001, bank(del, 'UTR55-0001', 'bank_transfer'), '23505', 'duplicate_reference');
      expect((await record(ACC, D.del002, bank(del, 'UTR550002', 'upi'))).status).toBe('recorded');
    });
  });

  it('cheques are unique on MICR + number; the same number with another MICR is allowed', async () => {
    await asOwner(db, async () => {
      const del = await branch('DEL');
      await record(ACC, D.del001, cheque(del, '110002001', '654321'));
      await refusedRecord(ACC, D.del002, cheque(del, '110002001', '654321', { payerPan: 'OTHER1234O' }), '23505', 'duplicate_reference');
      expect((await record(ACC, D.del002, cheque(del, '400002001', '654321'))).status).toBe('recorded');
    });
  });

  it('a correction may reuse the genuine reference; nobody else may', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const del = await branch('DEL');
      const orig = await record(ACC, D.del001, bank(del, 'UTRFIX000001', 'upi', { amountPaise: '999' }));
      await reject(ACC2, orig.id, 'data_error');
      // Before the correction exists the reference is still taken.
      await refusedRecord(ACC, D.del002, bank(del, 'UTRFIX000001'), '23505', 'duplicate_reference');
      const fix = await record(ACC, D.del001, bank(del, 'UTRFIX000001', 'upi', { correctsReceiptId: orig.id }));
      expect(fix.status).toBe('recorded');
      await refusedRecord(ACC, D.del002, bank(del, 'UTRFIX000001'), '23505', 'duplicate_reference');
      // A correction must keep the mode and the deal.
      const other = await record(ACC, D.del001, bank(del, 'UTRFIX000002', 'upi'));
      await reject(ACC2, other.id, 'data_error');
      await refusedRecord(ACC, D.del001, bank(del, 'UTRFIX000002', 'bank_transfer', { correctsReceiptId: other.id }), '22023', 'invalid_input');
      await refusedRecord(ACC, D.del002, bank(del, 'UTRFIX000002', 'upi', { correctsReceiptId: other.id }), '22023', 'invalid_input');
    });
  });

  it('a cheque correction may reuse its MICR + number', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const del = await branch('DEL');
      const orig = await record(ACC, D.del001, cheque(del, '110002009', '111111', { amountPaise: '1' }));
      await reject(ACC2, orig.id, 'data_error');
      expect((await record(ACC, D.del001, cheque(del, '110002009', '111111', { correctsReceiptId: orig.id }))).status).toBe('recorded');
    });
  });
});

// ---------------------------------------------------------------------------
// Deposits (12): no double-counted deposit
// ---------------------------------------------------------------------------

describe('deposit membership', () => {
  it('a receipt sits in one live deposit; reject frees it; verify moves custody without touching customer funds', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const jdh = await branch('JDH');
      const a = await record(ACC, D.del001, cash(jdh, '70000', { payerPan: 'DEPOS1234A' }));
      const b = await record(ACC, D.del002, cash(jdh, '30000', { payerPan: 'DEPOS1234B' }));
      await verify(ACC2, a.id);
      await verify(ACC2, b.id);
      const advancesBefore = await balance('customer_advances', 'l.deal_id = any($2::uuid[])', [[D.del001, D.del002]]);
      expect(advancesBefore).toBe(-100000n);

      const depositSql = 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r';
      const slip1 = await storeEvidence(ACC, 'branch', jdh, 'deposit_slip');
      const dep1 = await one<{ id: string }>(ACC, depositSql, [jdh, [a.id, b.id], today(), 'SYN-DEP-0001', slip1, rid()]);
      const slip2 = await storeEvidence(ACC, 'branch', jdh, 'deposit_slip');
      await refused(ACC, depositSql, [jdh, [a.id], today(), 'SYN-DEP-0002', slip2, rid()], '55000', 'wrong_state');
      // Cash in a recorded deposit cannot be reversed until the deposit is decided.
      await refused(ACC, 'select public.receipt_reverse($1, $2, $3, $4)', [a.id, 'data_error', 'Synthetic reversal reason', rid()], '55000', 'wrong_state');

      await one(ACC2, 'select public.cash_deposit_reject($1, $2, $3) as r', [dep1.id, 'Synthetic slip unreadable', rid()]);
      const dep2 = await one<{ id: string }>(ACC, depositSql, [jdh, [a.id, b.id], today(), 'SYN-DEP-0002', slip2, rid()]);
      await one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [dep2.id, rid()]);
      // A verified deposit cannot be verified or rejected again, and its receipts cannot join another deposit.
      await refused(ACC2, 'select public.cash_deposit_verify($1, $2)', [dep2.id, rid()], '55000', 'wrong_state');
      const slip3 = await storeEvidence(ACC, 'branch', jdh, 'deposit_slip');
      await refused(ACC, depositSql, [jdh, [b.id], today(), 'SYN-DEP-0003', slip3, rid()], '55000', 'wrong_state');

      const entries = await db.query<{ n: number }>(
        `select count(*)::int as n from public.finance_journal_entries where kind = 'deposit' and deposit_id in ($1, $2)`,
        [dep1.id, dep2.id],
      );
      expect(entries[0]!.n).toBe(1);
      expect(await balance('customer_advances', 'l.deal_id = any($2::uuid[])', [[D.del001, D.del002]])).toBe(advancesBefore);
      expect(await balance('cash_in_hand', 'l.branch_id = $2', [jdh])).toBe(0n);
      // Deposited cash reversal goes against the bank, never cash in hand.
      await reverse(ACC, a.id, 'data_error');
      expect(await balance('cash_in_hand', 'l.branch_id = $2', [jdh])).toBe(0n);
      expect(await balance('customer_advances', 'l.deal_id = $2', [D.del001])).toBe(0n);
    });
  });

  it('a slip already used by a deposit cannot back another deposit', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const jdh = await branch('JDH');
      const a = await record(ACC, D.del001, cash(jdh, '1000', { payerPan: 'SLIPS1234A' }));
      const b = await record(ACC, D.del002, cash(jdh, '1000', { payerPan: 'SLIPS1234B' }));
      await verify(ACC2, a.id);
      await verify(ACC2, b.id);
      const slip = await storeEvidence(ACC, 'branch', jdh, 'deposit_slip');
      const depositSql = 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r';
      await one(ACC, depositSql, [jdh, [a.id], today(), 'SYN-DEP-0010', slip, rid()]);
      await refused(ACC, depositSql, [jdh, [b.id], today(), 'SYN-DEP-0011', slip, rid()], '55000', 'evidence_required');
    });
  });
});

// ---------------------------------------------------------------------------
// Mode and environment gates (5)
// ---------------------------------------------------------------------------

describe('mode and environment gates', () => {
  /**
   * Inside the rolled-back test transaction only: 'operational' is normally
   * refused while synthetic fixture deals exist (integration guard), so the
   * guard trigger is skipped for this one update.
   */
  const setEnv = async (env: string) => {
    await db.exec('set local session_replication_role = replica');
    await db.query('update public.deployment_settings set environment = $1 where id', [env]);
    await db.exec('set local session_replication_role = origin');
  };
  /**
   * A deal flagged non-synthetic without a Bitrix inbox row. Real deals only
   * arrive through the integration team's interface, so the provenance check
   * is dropped inside the rolled-back transaction; nothing persists.
   */
  const realDeal = async (reference: string): Promise<string> => {
    // Rolled back with the test: lets one synthetic row carry the real flag without Bitrix provenance.
    await db.exec('alter table public.deals drop constraint deals_provenance');
    await db.exec('alter table public.deals drop constraint if exists deals_source_assigned_by_provenance');
    const [row] = await db.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
       select b.legal_entity_id, b.id, $1, 'Synthetic row flagged real for the gate test', $2, false
       from public.branches b where b.code = 'DEL' returning id`,
      [reference, U.salesDelhiA],
    );
    return row!.id;
  };

  it('unset refuses with environment_unset; staging with not_configured (reads and commands)', async () => {
    await asOwner(db, async () => {
      const del = await branch('DEL');
      const hc = await hcEntity();
      for (const [env, token] of [['unset', 'environment_unset'], ['staging', 'not_configured']] as const) {
        await setEnv(env);
        await refusedRecord(ACC, D.del001, bank(del, `SYNENV${env}01`), '55000', token);
        await refused(ACC, `select public.accounts_queue('all')`, [], '55000', token);
        await refused(ACC, 'select public.accounts_cash_overview($1)', [hc], '55000', token);
        await refused(ACC, 'select public.accounts_deal_detail($1)', [D.del001], '55000', token);
        await refused(ADMIN, 'select public.finance_policy_get($1)', [hc], '55000', token);
      }
    });
  });

  it('test: synthetic deals only; operational: real deals only', async () => {
    await asOwner(db, async () => {
      const del = await branch('DEL');
      const real = { id: await realDeal('SYN-REAL-FLAG-001') };
      await refusedRecord(ACC, real.id, bank(del, 'SYNGATE00001'), '55000', 'not_configured');
      await setEnv('operational');
      await refusedRecord(ACC, D.del001, bank(del, 'SYNGATE00002'), '55000', 'not_configured');
      // Operational with every mode switched off (the default): recording refuses mode_not_live.
      for (const fields of [
        bank(del, 'SYNGATE00003'),
        bank(del, 'SYNGATE00004', 'upi'),
        cash(del, '1000', { payerPan: 'GATES1234A' }),
        cheque(del, '110002077', '777777'),
      ]) {
        await refusedRecord(ACC, real.id, fields, '55000', 'mode_not_live');
      }
      // The owner switches one mode on by SQL; only that mode records.
      await db.query(`update public.finance_live_settings set upi_live = true where legal_entity_id = $1`, [await hcEntity()]);
      expect((await record(ACC, real.id, bank(del, 'SYNGATE00005', 'upi'))).status).toBe('recorded');
      await refusedRecord(ACC, real.id, bank(del, 'SYNGATE00006'), '55000', 'mode_not_live');
      // Reads still work with modes off.
      const detail = await one<{ liveModes: Record<string, boolean> }>(ACC, 'select public.accounts_deal_detail($1) as r', [real.id]);
      expect(detail.liveModes).toEqual({ bank_transfer: false, upi: true, cash: false, cheque: false });
    });
  });

  it('operational: verification of an already recorded receipt works with its mode off; re-presentation needs the mode', async () => {
    await asOwner(db, async () => {
      await addSecondAccounts();
      const del = await branch('DEL');
      const entity = await hcEntity();
      const real = { id: await realDeal('SYN-REAL-FLAG-002') };
      await setEnv('operational');
      await db.query(`update public.finance_live_settings set cash_live = true, cheque_live = true where legal_entity_id = $1`, [entity]);
      const c = await record(ACC, real.id, cash(del, '1000', { payerPan: 'GATEV1234A' }));
      const q = await record(ACC, real.id, cheque(del, '110002078', '777778'));
      await storeEvidence(ACC, 'receipt', q.id, 'cheque_image');
      await verify(ACC2, q.id);
      await storeEvidence(ACC2, 'receipt', q.id, 'bank_proof');
      await one(ACC2, 'select public.cheque_mark($1, $2, $3::date, null, $4) as r', [q.id, 'bounced', today(), rid()]);
      await db.query(`update public.finance_live_settings set cash_live = false, cheque_live = false where legal_entity_id = $1`, [entity]);
      expect((await verify(ACC2, c.id)).status).toBe('verified');
      await storeEvidence(ACC2, 'receipt', q.id, 'cheque_image');
      await refused(ACC2, 'select public.cheque_represent($1, $2)', [q.id, rid()], '55000', 'mode_not_live');
    });
  });
});
