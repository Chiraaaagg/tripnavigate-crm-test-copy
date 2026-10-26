import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  expectDbError,
  istBusinessDate,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Shared scenario helpers for the Phase 5A PGlite suites
 * (tests/db/finance-*.test.ts). Every scenario runs inside ONE rolled-back
 * owner transaction (asOwner) and switches to an impersonated request only for
 * the statement under test, so the suites also run unchanged against a real
 * Postgres (TEST_DATABASE_URL) without leaving rows behind.
 *
 * Synthetic roles: Accounts = Synthetic Accounts Jodhpur; a second Accounts
 * person = Synthetic Visa Jodhpur given an accounts membership inside the
 * transaction (addSecondAccounts). Super Admin = Synthetic Admin Jodhpur.
 */

export const ACC: Actor = { userId: U.accountsJodhpur };
export const ACC2: Actor = { userId: U.visaJodhpur };
export const SUPER: Actor = { userId: U.adminJodhpur };
export const SALES: Actor = { userId: U.salesDelhiA }; // owner of SYN-DEL-001
export const SALES_B: Actor = { userId: U.salesDelhiB };
export const PURCHASE: Actor = { userId: U.purchaseJodhpur };
export const MANAGER: Actor = { userId: U.managerDelhi };
export const ANON: Actor = { userId: null };
export const DEAL = D.del001;
export const DEAL2 = D.del002;
export const DEAL3 = D.amd001;

export const today = () => istBusinessDate();
export function daysAgo(n: number): string {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export const sha = () => randomBytes(32).toString('hex');

type Fields = Record<string, unknown>;

/**
 * SYNTHETIC FIXTURE (Stage 2): an approved company destination for the deal's
 * entity with the deal's synthetic flag, inserted directly as the owner (the
 * maker/approver path is covered by finance-destinations.test.ts). Returns the
 * approved version ID.
 */
export async function insertApprovedDestination(db: TestDb, dealId: string, kind: 'bank' | 'upi'): Promise<string> {
  await resetActor(db);
  const [dest] = await db.query<{ id: string; legal_entity_id: string }>(
    `insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
     select d.legal_entity_id, $2, 'Synthetic fixture destination', d.is_synthetic, $3 from public.deals d where d.id = $1
     returning id, legal_entity_id`,
    [dealId, kind, U.accountsJodhpur],
  );
  const [version] = await db.query<{ id: string }>(
    `insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
       account_number, ifsc, payee_name, upi_id, status, maker, request_id, decided_by, decided_at)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'approved', $9, gen_random_uuid(), $10, now()) returning id`,
    kind === 'bank'
      ? [dest!.legal_entity_id, dest!.id, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', null, null, U.accountsJodhpur, U.visaJodhpur]
      : [dest!.legal_entity_id, dest!.id, null, null, null, null, 'Synthetic Payee', 'synthetic.payee@synbank', U.accountsJodhpur, U.visaJodhpur],
  );
  await db.query('update public.company_destinations set current_version_id = $1 where id = $2', [version!.id, dest!.id]);
  return version!.id;
}

const added = new WeakMap<Fields, Fields>();

/**
 * Adds an approved destination to bank-transfer/UPI fields that do not name
 * one. The same fields object always gets the same destination, so an exact
 * retry of the same submission stays exact.
 */
export async function withDestination(db: TestDb, dealId: string, fields: Fields): Promise<Fields> {
  if ((fields.mode !== 'bank_transfer' && fields.mode !== 'upi') || 'destinationVersionId' in fields) return fields;
  const known = added.get(fields);
  if (known) return known;
  const next = { ...fields, destinationVersionId: await insertApprovedDestination(db, dealId, fields.mode === 'upi' ? 'upi' : 'bank') };
  added.set(fields, next);
  return next;
}
export const rid = () => crypto.randomUUID();

export function financeHelpers(getDb: () => TestDb) {
  const db = () => getDb();

  async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    await setActor(db(), actor);
    const rows = await db().query<T>(sql, params);
    await resetActor(db());
    return rows;
  }
  async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
    return (await run<{ r: T }>(actor, sql, params))[0]!.r;
  }
  async function refused(actor: Actor, sql: string, params: unknown[], code: string, token?: string): Promise<void> {
    await expectDbError(db(), () => run(actor, sql, params), { code, ...(token ? { message: new RegExp(`^${token}$`) } : {}) });
  }
  async function owner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return db().query<T>(sql, params);
  }

  const entityId = async () => (await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  const branchId = async (code: string) =>
    (await owner<{ id: string }>(`select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $1`, [code]))[0]!.id;

  async function addSecondAccounts(): Promise<void> {
    await owner(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'`,
      [U.visaJodhpur],
    );
  }

  async function addSalesAssignment(dealId: string, userId: string): Promise<void> {
    await owner(
      `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
       select d.id, d.legal_entity_id, $2, 'sales' from public.deals d where d.id = $1`,
      [dealId, userId],
    );
  }

  async function setEnvironment(env: string): Promise<void> {
    await owner(`alter table public.deployment_settings disable trigger deployment_settings_refuse_operational_with_synthetic`);
    await owner(`update public.deployment_settings set environment = $1 where id`, [env]);
    await owner(`alter table public.deployment_settings enable trigger deployment_settings_refuse_operational_with_synthetic`);
  }

  /** Approved destination for the HOLIDAY_CHACHA fixture deals (synthetic in the test environment). */
  async function fixtureDestination(kind: 'bank' | 'upi'): Promise<string> {
    return insertApprovedDestination(db(), DEAL, kind);
  }

  async function bankFields(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const kind = over.mode === 'upi' ? 'upi' : 'bank';
    const destination = 'destinationVersionId' in over || (over.mode !== undefined && over.mode !== 'bank_transfer' && over.mode !== 'upi')
      ? {} : { destinationVersionId: await fixtureDestination(kind) };
    return {
      ...destination,
      mode: 'bank_transfer',
      amountPaise: '2500000',
      receivedOn: today(),
      branchId: await branchId('DEL'),
      payerName: 'Synthetic Payer',
      payerPan: 'ABCDE1234F',
      reference: `UTR${randomBytes(5).toString('hex').toUpperCase()}`,
      ...over,
    };
  }
  async function cashFields(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return {
      mode: 'cash',
      amountPaise: '1000000',
      receivedOn: today(),
      branchId: await branchId('JDH'),
      collectorUserId: U.accountsJodhpur,
      payerName: 'Synthetic Cash Payer',
      payerPan: 'PQRSX6789K',
      ...over,
    };
  }
  async function chequeFields(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return {
      mode: 'cheque',
      amountPaise: '3000000',
      receivedOn: today(),
      branchId: await branchId('DEL'),
      payerName: 'Synthetic Cheque Payer',
      payerMobile: '+91 98765 43210',
      micrCode: '110002003',
      chequeNumber: String(100000 + Math.floor(Math.random() * 899999)),
      chequeDate: today(),
      accountPayee: true,
      ...over,
    };
  }

  type Result = { outcome: string; id: string; receiptNo?: string; status?: string; rowVersion?: number };
  const RECORD = 'select public.receipt_record($1, $2::jsonb, $3) as r';
  const record = async (actor: Actor, dealId: string, fields: Record<string, unknown>, requestId = rid()) =>
    one<Result>(actor, RECORD, [dealId, JSON.stringify(await withDestination(db(), dealId, fields)), requestId]);

  const verify = (actor: Actor, receiptId: string, requestId = rid()) =>
    one<Result>(actor, 'select public.receipt_verify($1, $2) as r', [receiptId, requestId]);
  const reject = (actor: Actor, receiptId: string, kind: string, reason = 'Synthetic rejection reason', requestId = rid()) =>
    one<Result>(actor, 'select public.receipt_reject($1, $2, $3, $4) as r', [receiptId, kind, reason, requestId]);
  const reverse = (actor: Actor, receiptId: string, kind: string, reason = 'Synthetic reversal reason', requestId = rid()) =>
    one<Result>(actor, 'select public.receipt_reverse($1, $2, $3, $4) as r', [receiptId, kind, reason, requestId]);
  const clear = (actor: Actor, receiptId: string, date = today(), requestId = rid()) =>
    one<Result>(actor, 'select public.cheque_clear($1, $2::date, $3) as r', [receiptId, date, requestId]);
  const mark = (actor: Actor, receiptId: string, kind: string, note: string | null = null, date = today()) =>
    one<Result>(actor, 'select public.cheque_mark($1, $2, $3::date, $4, $5) as r', [receiptId, kind, date, note, rid()]);
  const represent = (actor: Actor, receiptId: string) =>
    one<Result>(actor, 'select public.cheque_represent($1, $2) as r', [receiptId, rid()]);

  const BEGIN = 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r';
  async function proof(actor: Actor, targetType: 'receipt' | 'branch', targetId: string, kind: string, hash = sha()) {
    const begun = await one<{ id: string; objectPath: string }>(actor, BEGIN, [
      targetType, targetId, kind, 'proof.pdf', 'application/pdf', 2048, hash, rid(),
    ]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`, [
      begun.objectPath,
    ]);
    const finished = await one<{ status: string }>(actor, 'select public.finance_evidence_finish($1, true) as r', [begun.id]);
    expect(finished.status).toBe('stored');
    return begun.id;
  }

  /** A verified bank receipt (recorded by ACC, verified by ACC2). */
  async function verifiedBank(dealId: string = DEAL, over: Record<string, unknown> = {}) {
    const rec = await record(ACC, dealId, await bankFields(over));
    await proof(ACC, 'receipt', rec.id, 'bank_proof');
    await verify(ACC2, rec.id);
    return rec;
  }
  async function verifiedCash(dealId: string = DEAL, over: Record<string, unknown> = {}) {
    const rec = await record(ACC, dealId, await cashFields(over));
    await verify(ACC2, rec.id);
    return rec;
  }

  async function entries(receiptId: string) {
    return owner<{ kind: string; lines: Array<[string, number, number]> }>(
      `select e.kind, jsonb_agg(jsonb_build_array(l.account, l.debit_paise, l.credit_paise) order by l.account) as lines
       from public.finance_journal_entries e join public.finance_journal_lines l on l.entry_id = e.id
       where e.receipt_id = $1 group by e.id, e.kind, e.posted_at order by e.posted_at, e.kind`,
      [receiptId],
    );
  }
  async function available(dealId: string): Promise<string> {
    return (await owner<{ v: string }>(
      `select coalesce(sum(credit_paise - debit_paise), 0)::text as v from public.finance_journal_lines
       where deal_id = $1 and account = 'customer_advances'`,
      [dealId],
    ))[0]!.v;
  }
  /** Fires the deferred journal-shape triggers now (as at commit). */
  async function checkConstraints(): Promise<void> {
    await owner('set constraints all immediate');
    await owner('set constraints all deferred');
  }

  /** Confirmed synthetic hotel booking on SYN-DEL-001 by its owner (Phase 3 path). */
  async function confirmedBooking(dealId: string = DEAL, ownerActor: Actor = SALES): Promise<string> {
    const opened = await one<{ versionId: string; rowVersion: number }>(ownerActor, 'select public.booking_open_draft($1) as r', [dealId]);
    await one(ownerActor, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [
      opened.versionId,
      opened.rowVersion,
      JSON.stringify({
        hotelName: 'Synthetic Hotel (fixture)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13',
        rooms: 2, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', adults: 3, children: 1,
        inclusions: 'Synthetic pickup', specialRequests: null, purchaseBudgetPaise: '4500000',
      }),
      '9876543',
    ]);
    const ev = await one<{ evidenceId: string; objectPath: string }>(ownerActor, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r', [
      opened.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, sha(),
    ]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('booking-evidence', $1, jsonb_build_object('size', 2048))`, [ev.objectPath]);
    await one(ownerActor, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
    const { contentHash } = await one<{ contentHash: string }>(ownerActor, 'select public.booking_readiness($1) as r', [opened.versionId]);
    await one(ownerActor, 'select public.booking_confirm($1, $2) as r', [opened.versionId, contentHash]);
    return opened.versionId;
  }

  return {
    run, one, refused, owner, entityId, branchId, addSecondAccounts, addSalesAssignment, setEnvironment,
    bankFields, cashFields, chequeFields, record, withDestination: (dealId: string, fields: Fields) => withDestination(db(), dealId, fields), verify, reject, reverse, clear, mark, represent, proof,
    verifiedBank, verifiedCash, entries, available, checkConstraints, confirmedBooking, RECORD,
  };
}
