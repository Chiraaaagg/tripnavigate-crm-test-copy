import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
} from '../helpers/db';
import { HOTEL, PURCHASE_CLAIM_SQL, SAVE_ITEM_SQL, TRANSFER, b1Helpers } from './b1-support';

/**
 * Purchase build, Track A (migration 20261130000100_purchase_workflow.sql),
 * written by the independent test author (Track D) from the frozen contract
 * (purchase-contract.md, owner decisions of 2 November 2026), not from the
 * implementation:
 *
 *   - "Send booking request": one transaction records the booking request
 *     e-mail and, for hotel tasks only, a pending Accounts go-ahead bound to
 *     {task, accepted booking version, quote, cost version, amount}.
 *   - Accounts approves only when the booking version's Accounts review is
 *     approved (booking_not_approved), never the requester and never an
 *     Accounts person who also holds Purchase.
 *   - Validity is computed: a new cost version or a new accepted booking
 *     version makes an approval stale; an old approval never authorizes a
 *     changed cost. Supplier confirmation is refused without a valid go-ahead
 *     (go_ahead_missing) and without a booking request for the current cost
 *     (booking_request_not_sent).
 *   - Cost above budget: the Deal's branch Manager approves one exact version.
 *   - Trip cancellation: branch Manager opens; Purchase enters charges per task;
 *     send refused until every task with a cost has a charge; Manager decides
 *     (never the person who entered); a change after sending resets the case.
 *     An open cancellation blocks new commitments (trip_cancelled).
 *   - E-mail switch default off: rate requests are allowed before the
 *     go-ahead and are recorded as marked_sent.
 *   - Purchase reads never carry selling price, margin, receipts, funding or
 *     customer-side amounts.
 *
 * Every scenario runs in ONE rolled-back owner transaction and impersonates
 * a request only for the statement under test (tests/helpers/db.ts).
 *
 * Synthetic actors (supabase/fixtures, all @example.test):
 *   OWNER       Sales Delhi A, owns SYN-DEL-001 (Delhi branch)
 *   PURCHASE    Purchase Jodhpur (entity-wide Purchase)
 *   PURCHASE_2  Moved Staff, given an active Purchase membership per test
 *   ACC         Accounts Jodhpur
 *   ACC2        Visa Jodhpur, given an Accounts membership per test
 *   MANAGER     Manager Delhi (the Deal's branch)
 *   MANAGER_AMD Manager Ahmedabad (same entity, other branch)
 *   VISA        Visa Jodhpur (Visa desk role in the fixtures)
 *   FLIGHT      Moved Staff, given a Flight membership per test
 *   SUPER       Admin Jodhpur (super_admin)
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { run, one, owner } = h;
const rid = () => crypto.randomUUID();

const OWNER: Actor = { userId: U.salesDelhiA };
const SALES_B: Actor = { userId: U.salesDelhiB };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const PURCHASE_2: Actor = { userId: U.movedStaff };
const ACC: Actor = { userId: U.accountsJodhpur };
const ACC2: Actor = { userId: U.visaJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
const VISA: Actor = { userId: U.visaJodhpur };
const FLIGHT: Actor = { userId: U.movedStaff };
const SUPER: Actor = { userId: U.adminJodhpur };
const SERVICE: Actor = { userId: null, role: 'service_role' };
const PROVIDER_ID = '0b0e6f3c-5d7a-4c1e-9f00-000000000001';
const DEAL = D.del001;

// Distinctive synthetic values: any of them in a Purchase read is a leak.
const SELLING = '45678901';
const HOTEL_BUDGET = '20000000';
const TRANSFER_BUDGET = '1500000';
const HOTEL_COST = '4123457';
const TRANSFER_COST = '612347';
const FIXTURE_COMMERCIALS = ['12345600', '1111100']; // deal_commercials fixture for SYN-DEL-001
const SHA = 'c'.repeat(64);
const SUPPLIER_EMAIL = 'desk@example.test';

// Contract command signatures (positional, in contract order).
const EMAIL_RECORD_SQL = 'select public.purchase_email_record($1, $2, $3, $4, $5::text[], $6, $7, $8) as r';
const BR_SEND_SQL = 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r';
const MARK_RESULT_SQL = 'select public.purchase_email_mark_result($1, $2, $3, $4) as r';
const GA_DECIDE_SQL = 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r';
const GA_LIST_SQL = 'select public.accounts_go_ahead_list() as r';
const CANCEL_OPEN_SQL = 'select public.deal_cancellation_open($1, $2, $3) as r';
const CHARGE_SET_SQL = 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r';
const CANCEL_SEND_SQL = 'select public.deal_cancellation_send($1, $2, $3) as r';
const CANCEL_DECIDE_SQL = 'select public.deal_cancellation_decide($1, $2, $3, $4, $5) as r';
const CANCEL_LIST_SQL = 'select public.manager_cancellation_list() as r';
const EMAIL_SWITCH_SQL = 'select public.admin_set_supplier_email_sending($1, $2) as r';
// Existing commands.
const QUOTE_ADD_SQL = 'select public.purchase_quote_add($1, $2, $3::jsonb) as r';
const COST_SQL = 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r';
const OVER_BUDGET_SQL = 'select public.purchase_cost_approve_over_budget($1, $2) as r';
const CONFIRM_SQL = 'select public.purchase_supplier_confirm($1, $2, $3) as r';
const WORKSPACE_SQL = 'select public.purchase_workspace($1) as r';
const TASK_LIST_SQL = 'select public.purchase_task_list() as r';
const EV_BEGIN_SQL = 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r';
const EV_FINISH_SQL = 'select public.purchase_evidence_finish($1, $2) as r';
const OPEN_REVISION_SQL = 'select public.booking_open_revision($1) as r';
const CLASSIFY_SQL = 'select public.booking_classify_revision($1, $2, $3) as r';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts a refusal whose message is exactly the token (any SQLSTATE unless given). */
async function refused(actor: Actor, sql: string, params: unknown[], token: string | RegExp, code?: string): Promise<void> {
  const message = typeof token === 'string' ? new RegExp(`^${token}$`) : token;
  await expectDbError(db, () => run(actor, sql, params), { message, ...(code ? { code } : {}) });
}

async function addMembership(user: string, role: string, branch = 'JDH'): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $2, 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $3
     on conflict do nothing`,
    [user, role, branch],
  );
  // Moved Staff's fixture membership is inactive: make sure the profile is active.
  await owner(`update public.staff_profiles set status = 'active' where user_id = $1`, [user]);
}

type Booked = { versionId: string; hotelTask: string; transferTask: string | null; hotelItem: string; transferItem: string | null };

/** Confirmed package on SYN-DEL-001: a hotel (and by default a transfer) item; Purchase tasks for both. */
async function bookedDeal(opts: { transfer?: boolean; hotelBudget?: string } = {}): Promise<Booked> {
  const withTransfer = opts.transfer ?? true;
  await h.setSwitch('service_items_enabled', true);
  const opened = await h.openDraft(OWNER, DEAL);
  let rv = opened.rowVersion;
  const hotel = await h.addItem(OWNER, opened.versionId, rv, 'hotel', HOTEL, opts.hotelBudget ?? HOTEL_BUDGET);
  rv = hotel.rowVersion;
  let transferItem: string | null = null;
  if (withTransfer) {
    const t = await h.addItem(OWNER, opened.versionId, rv, 'transfer', TRANSFER, TRANSFER_BUDGET);
    rv = t.rowVersion;
    transferItem = t.itemId;
  }
  rv = (await h.saveTravellers(OWNER, DEAL, rv)).rowVersion;
  rv = (await h.saveSelling(OWNER, opened.versionId, rv, SELLING)).rowVersion;
  rv = await h.completeB11(OWNER, DEAL, opened.versionId, rv, SELLING);
  await h.storeEvidence(OWNER, opened.versionId);
  const ready = await h.readiness(OWNER, opened.versionId);
  expect(ready.issues).toEqual([]);
  await h.confirm(OWNER, opened.versionId, ready.contentHash);
  const tasks = await owner<{ id: string; service_purpose: string }>(
    `select id, service_purpose from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [DEAL]);
  const hotelTask = tasks.find((t) => t.service_purpose === 'hotel')!.id;
  const transferTask = tasks.find((t) => t.service_purpose === 'transfer')?.id ?? null;
  return { versionId: opened.versionId, hotelTask, transferTask, hotelItem: hotel.itemId, transferItem };
}

/** SYNTHETIC FIXTURE: the Accounts booking review of a version, set to approved as the owner. */
async function approveReview(versionId: string): Promise<void> {
  await owner(
    `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
     select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1
     on conflict (booking_version_id) do update set status = 'approved', row_version = public.accounts_booking_reviews.row_version + 1,
       reviewed_by = excluded.reviewed_by, reviewed_at = now(), updated_at = now()`,
    [versionId, U.accountsJodhpur],
  );
}

async function createSupplier(actor: Actor = PURCHASE, serviceTypes: string[] = ['hotel', 'transfer']): Promise<string> {
  const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
  const { supplierId } = await one<{ supplierId: string }>(actor, 'select public.supplier_create($1, $2::jsonb) as r', [
    entity!.id,
    JSON.stringify({
      name: `Synthetic Supplier ${rid().slice(0, 8)}`, serviceTypes, city: 'Synthetic City', contactName: 'Synthetic Desk',
      contactPhone: '+91 00000 00000', contactEmail: SUPPLIER_EMAIL, paymentTerms: 'Synthetic: 50% at confirmation',
    }),
  ]);
  return supplierId;
}

async function addQuote(actor: Actor, taskId: string, supplierId: string, cost: string, name = 'Synthetic Hotel (fixture)'): Promise<string> {
  const { quoteId } = await one<{ quoteId: string }>(actor, QUOTE_ADD_SQL, [taskId, rid(), JSON.stringify({
    supplierId, hotelName: name, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', quotedCostPaise: cost,
    holdUntil: '2026-11-30', cancellationTerms: 'Synthetic: free until 7 days before arrival',
  })]);
  return quoteId;
}

const latestCostNo = async (taskId: string) =>
  (await owner<{ n: number }>('select coalesce(max(version_no), 0)::int as n from public.purchase_cost_versions where task_id = $1', [taskId]))[0]!.n;

async function propose(actor: Actor, taskId: string, quoteId: string, amount: string): Promise<number> {
  const r = await one<{ versionNo: number }>(actor, COST_SQL, [taskId, quoteId, await latestCostNo(taskId), amount, '2026-11-25', null, rid()]);
  return r.versionNo;
}

/** Claimed task with supplier, open quote and a proposed final rate. */
async function pricedTask(taskId: string, cost: string, actor: Actor = PURCHASE, supplierId?: string) {
  await one(actor, PURCHASE_CLAIM_SQL, [taskId]);
  const sid = supplierId ?? await createSupplier(actor);
  const quoteId = await addQuote(actor, taskId, sid, cost);
  const versionNo = await propose(actor, taskId, quoteId, cost);
  return { supplierId: sid, quoteId, versionNo };
}

const brParams = (taskId: string, expected: number, requestId: string = rid()) => [
  taskId, expected, SUPPLIER_EMAIL, ['reservations@example.test'],
  'Booking request · SYN-DEL-001 · Synthetic Hotel · 10–13 Dec 2026',
  'Synthetic booking request body. Please hold two Synthetic Deluxe rooms.', requestId,
];
async function sendBookingRequest(taskId: string, actor: Actor = PURCHASE, requestId: string = rid()) {
  return one<Record<string, unknown>>(actor, BR_SEND_SQL, brParams(taskId, await latestCostNo(taskId), requestId));
}
const rateParams = (taskId: string, supplierId: string, requestId: string = rid(), kind = 'rate_request', cc: string[] = []) => [
  taskId, kind, supplierId, SUPPLIER_EMAIL, cc,
  'Rate request · SYN-DEL-001 · Synthetic Hotel · 10–13 Dec 2026', 'Synthetic rate request body.', requestId,
];

type GoAhead = {
  id: string; status: string; booking_version_id: string; quote_id: string; cost_version_no: number; amount_paise: string;
  requested_by: string; decided_by: string | null; return_reason: string | null; row_version: number; email_id: string | null;
};
const goAheads = (taskId: string) =>
  owner<GoAhead>(
    `select id, status, booking_version_id, quote_id, cost_version_no, amount_paise::text as amount_paise, requested_by, decided_by,
       return_reason, row_version, email_id from public.purchase_go_ahead_requests where task_id = $1 order by cost_version_no, id`, [taskId]);
const pendingGoAhead = async (taskId: string) => {
  const rows = (await goAheads(taskId)).filter((g) => g.status === 'pending');
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
type Email = { id: string; kind: string; status: string; amount_paise: string | null; cost_version_no: number | null; quote_id: string | null;
  subject: string; to_email: string; cc_emails: string[]; sent_by: string; deal_id: string; body: string };
const emails = (taskId: string) =>
  owner<Email>(`select id, kind, status, amount_paise::text as amount_paise, cost_version_no, quote_id, subject, to_email, cc_emails,
    sent_by, deal_id, body from public.purchase_supplier_emails where task_id = $1 order by sent_at, id`, [taskId]);

const decide = (actor: Actor, g: { id: string; row_version: number }, decision: 'approve' | 'return', reason: string | null = null, requestId: string = rid()) =>
  one<Record<string, unknown>>(actor, GA_DECIDE_SQL, [g.id, decision, reason, g.row_version, requestId]);

async function storeConfirmationProof(actor: Actor, taskId: string): Promise<void> {
  const ev = await one<{ evidenceId: string; objectPath: string }>(actor, EV_BEGIN_SQL, [
    taskId, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, SHA]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
    [ev.objectPath]);
  expect((await one<{ status: string }>(actor, EV_FINISH_SQL, [ev.evidenceId, true])).status).toBe('stored');
}
const confirmParams = async (taskId: string, reference = 'SYN-CONF-0001') => [taskId, await latestCostNo(taskId), reference];

const workspace = (actor: Actor, taskId: string) => one<Record<string, unknown>>(actor, WORKSPACE_SQL, [taskId]);
const goAheadState = async (taskId: string, actor: Actor = PURCHASE) =>
  ((await workspace(actor, taskId)).goAhead as { state: string } | undefined)?.state;
const issues = async (taskId: string) => (await workspace(PURCHASE, taskId)).issues as string[];
const taskStatus = async (taskId: string) =>
  (await owner<{ status: string }>('select status from public.fulfilment_tasks where id = $1', [taskId]))[0]!.status;

/** Hotel task with the Accounts booking review approved, a sent booking request and an approved go-ahead. */
async function approvedHotel(cost: string = HOTEL_COST) {
  const booked = await bookedDeal();
  await approveReview(booked.versionId);
  const priced = await pricedTask(booked.hotelTask, cost);
  await sendBookingRequest(booked.hotelTask);
  const g = await pendingGoAhead(booked.hotelTask);
  await decide(ACC, g, 'approve');
  expect(await goAheadState(booked.hotelTask)).toBe('approved');
  return { ...booked, ...priced, goAheadId: g.id };
}

/** A replay answers with the stored result; only the outcome word may differ ('created' vs 'existing'). */
const sansOutcome = (v: unknown) => {
  const { outcome: _o, created: _c, ...rest } = (v ?? {}) as Record<string, unknown>;
  return rest;
};

/** Every key of a JSON value, recursively. */
function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}
/** First object in a JSON value that names `id` as id/taskId. */
function findRow(value: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const f = findRow(v, id);
      if (f) return f;
    }
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.id === id || o.taskId === id) return o;
    for (const v of Object.values(o)) {
      const f = findRow(v, id);
      if (f) return f;
    }
  }
  return undefined;
}
const LEAK_KEY = /sell|margin|commercial|receipt|fundingAmount|fundingReason|companyFund.*(Amount|Reason)|paymentProof|customerMoneyAvailable|customerRefund|refundToCustomer|payer/i;
function expectNoLeak(label: string, value: unknown, extraValues: string[] = []): void {
  const keys = [...allKeys(value)].filter((k) => LEAK_KEY.test(k));
  expect(keys, `${label}: forbidden keys`).toEqual([]);
  const text = JSON.stringify(value);
  for (const v of [SELLING, ...FIXTURE_COMMERCIALS, ...extraValues]) {
    expect(text.includes(v), `${label}: contains ${v}`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Schema and switch
// ---------------------------------------------------------------------------

describe('schema, grants and the e-mail switch', () => {
  it('creates the new tables with RLS, no direct writes for staff, and the e-mail switch off by default', async () => {
    await asOwner(db, async () => {
      const tables = ['purchase_supplier_emails', 'purchase_go_ahead_requests', 'deal_cancellations', 'purchase_cancellation_charges'];
      const rows = await owner<{ t: string; rls: boolean; anon: boolean; auth_write: boolean }>(
        `select c.relname as t, c.relrowsecurity as rls,
           has_table_privilege('anon', c.oid, 'select') as anon,
           has_table_privilege('authenticated', c.oid, 'insert,update,delete') as auth_write
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1::text[]) order by 1`, [tables]);
      expect(rows.map((r) => r.t)).toEqual([...tables].sort());
      for (const r of rows) expect(r, r.t).toMatchObject({ rls: true, anon: false, auth_write: false });
      const [s] = await owner<{ on: boolean }>('select supplier_email_sending_enabled as on from public.procurement_settings');
      expect(s!.on).toBe(false);
      const fns = await owner<{ fn: string; anon: boolean }>(
        `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1::text[])`,
        [['purchase_email_record', 'purchase_booking_request_send', 'purchase_go_ahead_decide', 'deal_cancellation_open',
          'purchase_cancellation_charge_set', 'deal_cancellation_send', 'deal_cancellation_decide', 'purchase_email_mark_result',
          'accounts_go_ahead_list', 'manager_cancellation_list', 'admin_set_supplier_email_sending']]);
      expect(fns.map((f) => f.fn).sort()).toEqual(['accounts_go_ahead_list', 'admin_set_supplier_email_sending', 'deal_cancellation_decide',
        'deal_cancellation_open', 'deal_cancellation_send', 'manager_cancellation_list', 'purchase_booking_request_send',
        'purchase_cancellation_charge_set', 'purchase_email_mark_result', 'purchase_email_record', 'purchase_go_ahead_decide']);
      for (const f of fns) expect(f.anon, f.fn).toBe(false);
    });
  });

  it('only a super admin flips the e-mail switch, with an audit row; Purchase and managers are refused', async () => {
    await asOwner(db, async () => {
      // Mirrors admin_set_supplier_confirmation_live, whose refusal text is 'not authorized'.
      await refused(PURCHASE, EMAIL_SWITCH_SQL, [true, 'Synthetic reason to send e-mail'], /^not.authorized$/, '42501');
      await refused(MANAGER, EMAIL_SWITCH_SQL, [true, 'Synthetic reason to send e-mail'], /^not.authorized$/, '42501');
      await one(SUPER, EMAIL_SWITCH_SQL, [true, 'Synthetic reason to send e-mail']);
      const [s] = await owner<{ on: boolean }>('select supplier_email_sending_enabled as on from public.procurement_settings');
      expect(s!.on).toBe(true);
      const audit = await owner<{ details: unknown }>(
        `select details from public.audit_events where action = 'settings.procurement_changed' and actor_user_id = $1`, [U.adminJodhpur]);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).toContain('supplier_email_sending_enabled');
    });
  });
});

// ---------------------------------------------------------------------------
// Rate requests and e-mail records
// ---------------------------------------------------------------------------

describe('rate requests (e-mail switch off)', () => {
  it('the assignee records a rate request before any go-ahead or cost: marked_sent, Deal ID subject, replay by request id', async () => {
    await asOwner(db, async () => {
      const { hotelTask } = await bookedDeal();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      const supplierId = await createSupplier();
      const req = rid();
      await one(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId, req, 'rate_request', ['ops@example.test']));
      await one(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId, req, 'rate_request', ['ops@example.test']));
      const rows = await emails(hotelTask);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'rate_request', status: 'marked_sent', to_email: SUPPLIER_EMAIL, sent_by: U.purchaseJodhpur, deal_id: DEAL });
      expect(rows[0]!.cc_emails).toEqual(['ops@example.test']);
      expect(rows[0]!.subject).toContain('SYN-DEL-001');
      expect(rows[0]!.body).not.toContain(SELLING);
      // Rate requests need no go-ahead and leave none behind.
      expect(await goAheads(hotelTask)).toEqual([]);
      const ws = await workspace(PURCHASE, hotelTask);
      expect(ws.emailSendingEnabled).toBe(false);
      expect((ws.emails as unknown[]).length).toBe(1);
    });
  });

  it('refuses a booking_request kind, bad Cc lists, an unassigned Purchase person and other departments', async () => {
    await asOwner(db, async () => {
      await addMembership(U.movedStaff, 'purchase');
      const { hotelTask } = await bookedDeal();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      const supplierId = await createSupplier();
      // Booking requests go only through purchase_booking_request_send.
      await refused(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId, rid(), 'booking_request'), /invalid_input|not_authorized|not_ready/);
      await refused(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId, rid(), 'rate_request', ['not-an-email']), 'invalid_input', '22023');
      const elevenCc = Array.from({ length: 11 }, (_, i) => `cc${i}@example.test`);
      await refused(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId, rid(), 'rate_request', elevenCc), 'invalid_input', '22023');
      for (const actor of [PURCHASE_2, OWNER, VISA, MANAGER, ACC]) {
        await refused(actor, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId), 'not_authorized', '42501');
      }
      expect(await emails(hotelTask)).toEqual([]);
    });
  });

  it('with the switch on a record is queued; only the server (service role) marks the provider result, once', async () => {
    await asOwner(db, async () => {
      await addMembership(U.movedStaff, 'purchase');
      await owner('update public.procurement_settings set supplier_email_sending_enabled = true');
      const { hotelTask } = await bookedDeal();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      const supplierId = await createSupplier();
      await one(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId));
      const [queued] = await emails(hotelTask);
      expect(queued!.status).toBe('queued');
      // Lead change (review): no staff session marks a result, not even the sender's own.
      for (const actor of [PURCHASE, PURCHASE_2, OWNER, ACC, SUPER]) {
        await expectDbError(db, () => run(actor, MARK_RESULT_SQL, [queued!.id, 'sent', PROVIDER_ID, null]), { code: '42501' });
      }
      expect((await emails(hotelTask))[0]!.status).toBe('queued');
      // The provider id must be a UUID.
      await refused(SERVICE, MARK_RESULT_SQL, [queued!.id, 'sent', 'synthetic-provider-id', null], 'invalid_input', '22023');
      await one(SERVICE, MARK_RESULT_SQL, [queued!.id, 'sent', PROVIDER_ID, null]);
      expect((await emails(hotelTask))[0]!.status).toBe('sent');
      // Replay answers existing; a sent row never goes back to failed.
      await one(SERVICE, MARK_RESULT_SQL, [queued!.id, 'sent', PROVIDER_ID, null]);
      await expectDbError(db, () => run(SERVICE, MARK_RESULT_SQL, [queued!.id, 'failed', null, 'synthetic_failure']), {});
      expect((await emails(hotelTask))[0]!.status).toBe('sent');
    });
  });

  it('a marked_sent record (switch off) cannot be marked by the provider follow-up', async () => {
    await asOwner(db, async () => {
      const { hotelTask } = await bookedDeal();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      const supplierId = await createSupplier();
      await one(PURCHASE, EMAIL_RECORD_SQL, rateParams(hotelTask, supplierId));
      const [row] = await emails(hotelTask);
      await expectDbError(db, () => run(SERVICE, MARK_RESULT_SQL, [row!.id, 'sent', PROVIDER_ID, null]), {});
      expect((await emails(hotelTask))[0]!.status).toBe('marked_sent');
    });
  });
});

// ---------------------------------------------------------------------------
// Go-ahead
// ---------------------------------------------------------------------------

describe('Send booking request and the hotel go-ahead', () => {
  it('records the booking request e-mail and a pending go-ahead bound to the task, accepted version, quote, cost version and amount', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      const { quoteId, versionNo } = await pricedTask(booked.hotelTask, HOTEL_COST);
      expect(await goAheadState(booked.hotelTask)).toBe('not_requested');
      await sendBookingRequest(booked.hotelTask);
      const [email] = await emails(booked.hotelTask);
      expect(email).toMatchObject({ kind: 'booking_request', status: 'marked_sent', amount_paise: HOTEL_COST, cost_version_no: versionNo, quote_id: quoteId });
      expect(email!.subject).toContain('SYN-DEL-001');
      const g = await pendingGoAhead(booked.hotelTask);
      expect(g).toMatchObject({
        booking_version_id: booked.versionId, quote_id: quoteId, cost_version_no: versionNo, amount_paise: HOTEL_COST,
        requested_by: U.purchaseJodhpur, decided_by: null,
      });
      expect(g.email_id).toBe(email!.id);
      expect(await goAheadState(booked.hotelTask)).toBe('pending');
      expect(await issues(booked.hotelTask)).toContain('go_ahead_missing');
      expect(await taskStatus(booked.hotelTask)).toBe('in_progress');
      // The task list row carries the state.
      const row = findRow(await one(PURCHASE, TASK_LIST_SQL), booked.hotelTask);
      expect(row?.goAheadState).toBe('pending');
      // Accounts sees it in its list.
      expect(JSON.stringify(await one(ACC, GA_LIST_SQL))).toContain(g.id);
    });
  });

  it('a transfer task needs no go-ahead: the e-mail is recorded, no request, and confirmation needs only the booking request', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await pricedTask(booked.transferTask!, TRANSFER_COST);
      await storeConfirmationProof(PURCHASE, booked.transferTask!);
      expect(await goAheadState(booked.transferTask!)).toBe('not_needed');
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(booked.transferTask!), 'booking_request_not_sent');
      await sendBookingRequest(booked.transferTask!);
      expect((await emails(booked.transferTask!)).map((e) => e.kind)).toEqual(['booking_request']);
      expect(await goAheads(booked.transferTask!)).toEqual([]);
      expect(await issues(booked.transferTask!)).not.toContain('go_ahead_missing');
      expect((await one<{ outcome: string }>(PURCHASE, CONFIRM_SQL, await confirmParams(booked.transferTask!))).outcome).toBe('created');
    });
  });

  it('supplier confirmation is refused before a booking request and while the go-ahead is pending (go_ahead_missing)', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await storeConfirmationProof(PURCHASE, booked.hotelTask);
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(booked.hotelTask), /go_ahead_missing|booking_request_not_sent|not_ready/);
      expect(await issues(booked.hotelTask)).toEqual(expect.arrayContaining(['go_ahead_missing', 'booking_request_not_sent']));
      await sendBookingRequest(booked.hotelTask);
      expect(await issues(booked.hotelTask)).toEqual(['go_ahead_missing']);
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(booked.hotelTask), 'go_ahead_missing');
      expect(await taskStatus(booked.hotelTask)).toBe('in_progress');
      // After the approval the same confirmation goes through.
      await decide(ACC, await pendingGoAhead(booked.hotelTask), 'approve');
      expect(await issues(booked.hotelTask)).toEqual([]);
      expect((await one<{ outcome: string }>(PURCHASE, CONFIRM_SQL, await confirmParams(booked.hotelTask))).outcome).toBe('created');
    });
  });

  it('Accounts cannot approve before the booking review is approved (booking_not_approved)', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], 'booking_not_approved');
      // A returned review is not approved either.
      await owner(
        `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, return_reason)
         select id, deal_id, legal_entity_id, 'returned', 'Synthetic return: dates to check' from public.booking_versions where id = $1`,
        [booked.versionId]);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], 'booking_not_approved');
      expect((await pendingGoAhead(booked.hotelTask)).status).toBe('pending');
      await approveReview(booked.versionId);
      await decide(ACC, g, 'approve');
      const [after] = await goAheads(booked.hotelTask);
      expect(after).toMatchObject({ status: 'approved', decided_by: U.accountsJodhpur });
    });
  });

  it('only Accounts without Purchase, never the requester, decides; Purchase, Sales, managers and other desks are refused', async () => {
    await asOwner(db, async () => {
      await addMembership(U.visaJodhpur, 'accounts');
      await addMembership(U.visaJodhpur, 'purchase'); // ACC2: Accounts who also holds Purchase
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      for (const actor of [PURCHASE, ACC2, OWNER, MANAGER, MANAGER_AMD, SUPER]) {
        await refused(actor, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], /not_authorized|not_self_approval/);
      }
      expect((await pendingGoAhead(booked.hotelTask)).decided_by).toBeNull();
    });
  });

  it('an Accounts person who also holds Purchase and sent the request cannot approve it', async () => {
    await asOwner(db, async () => {
      await addMembership(U.accountsJodhpur, 'purchase');
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST, ACC);
      await sendBookingRequest(booked.hotelTask, ACC);
      const g = await pendingGoAhead(booked.hotelTask);
      expect(g.requested_by).toBe(U.accountsJodhpur);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], /not_authorized|not_self_approval/);
    });
  });

  it('return needs a 10-500 character reason; Purchase sees it; sending again creates a new pending request', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'return', 'short', g.row_version, rid()], 'invalid_input', '22023');
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'return', null, g.row_version, rid()], 'invalid_input', '22023');
      await decide(ACC, g, 'return', 'Synthetic: supplier rate needs a second quote');
      const ws = await workspace(PURCHASE, booked.hotelTask);
      expect(ws.goAhead).toMatchObject({ state: 'returned', returnReason: 'Synthetic: supplier rate needs a second quote' });
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(booked.hotelTask), /go_ahead_missing|not_ready/);
      await sendBookingRequest(booked.hotelTask);
      const rows = await goAheads(booked.hotelTask);
      expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'returned']);
      expect(await goAheadState(booked.hotelTask)).toBe('pending');
    });
  });
});

describe('go-ahead validity is computed: changes make it stale', () => {
  it('a new final rate after approval makes it stale; the old approval never authorizes the changed cost', async () => {
    await asOwner(db, async () => {
      const a = await approvedHotel();
      await storeConfirmationProof(PURCHASE, a.hotelTask);
      // Same quote, new final rate: a new cost version.
      await propose(PURCHASE, a.hotelTask, a.quoteId, '4100000');
      expect(await goAheadState(a.hotelTask)).toBe('stale');
      expect(await issues(a.hotelTask)).toEqual(expect.arrayContaining(['go_ahead_missing', 'booking_request_not_sent']));
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask), /go_ahead_missing|booking_request_not_sent|not_ready/);
      // A new booking request for the new rate: a NEW pending request; the old approval stays approved but unused.
      await sendBookingRequest(a.hotelTask);
      const rows = await goAheads(a.hotelTask);
      expect(rows.map((r) => [r.cost_version_no, r.status, r.amount_paise])).toEqual([
        [1, 'approved', HOTEL_COST],
        [2, 'pending', '4100000'],
      ]);
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask), 'go_ahead_missing');
      expect(await taskStatus(a.hotelTask)).toBe('in_progress');
    });
  });

  it('a new cost version while a request is pending: approving the old request is version_changed', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      const { quoteId } = await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      await propose(PURCHASE, booked.hotelTask, quoteId, '3900000');
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], 'version_changed');
      expect((await goAheads(booked.hotelTask)).find((r) => r.id === g.id)!.status).not.toBe('approved');
      expect(await goAheadState(booked.hotelTask)).not.toBe('approved');
    });
  });

  it('a revised booking (new accepted version) makes the approval stale; a new request binds the new version', async () => {
    await asOwner(db, async () => {
      const a = await approvedHotel();
      await storeConfirmationProof(PURCHASE, a.hotelTask);
      // Accounts returns the base (owner SQL, as tests/db/b11-revision.test.ts does), Sales revises an internal field.
      await owner(`update public.accounts_booking_reviews set status = 'returned', return_reason = 'Synthetic return: budget to change',
        row_version = row_version + 1 where booking_version_id = $1`, [a.versionId]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, OPEN_REVISION_SQL, [a.versionId]);
      const saved = await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL,
        [a.hotelItem, opened.versionId, opened.rowVersion, JSON.stringify(HOTEL), '21000000']);
      await one(OWNER, CLASSIFY_SQL, [opened.versionId, saved.rowVersion, 'internal_only']);
      const ready = await h.readiness(OWNER, opened.versionId);
      expect(ready.issues).toEqual([]);
      expect((await h.confirm(OWNER, opened.versionId, ready.contentHash)).outcome).toBe('revised');

      expect(await goAheadState(a.hotelTask)).toBe('stale');
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask), /go_ahead_missing|not_ready/);
      // The new version's review is not approved yet: a new request cannot be approved.
      await sendBookingRequest(a.hotelTask);
      const g2 = await pendingGoAhead(a.hotelTask);
      expect(g2.booking_version_id).toBe(opened.versionId);
      await refused(ACC, GA_DECIDE_SQL, [g2.id, 'approve', null, g2.row_version, rid()], 'booking_not_approved');
      await approveReview(opened.versionId);
      await decide(ACC, g2, 'approve');
      expect(await goAheadState(a.hotelTask)).toBe('approved');
      expect((await one<{ outcome: string }>(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask))).outcome).toBe('created');
    });
  });

  it('a stale approval cannot be revived by owner-visible flags: validity is not stored on the task', async () => {
    await asOwner(db, async () => {
      const cols = await owner<{ c: string }>(
        `select column_name as c from information_schema.columns where table_schema = 'public'
         and table_name in ('fulfilment_tasks', 'purchase_go_ahead_requests') and column_name ilike '%valid%'`);
      expect(cols).toEqual([]);
    });
  });
});

describe('duplicates and concurrency (sequential half)', () => {
  it('the same request id replays a booking request without a second e-mail or go-ahead', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await pricedTask(booked.hotelTask, HOTEL_COST);
      const req = rid();
      const first = await sendBookingRequest(booked.hotelTask, PURCHASE, req);
      const again = await sendBookingRequest(booked.hotelTask, PURCHASE, req);
      expect(sansOutcome(again)).toEqual(sansOutcome(first));
      expect(await emails(booked.hotelTask)).toHaveLength(1);
      expect(await goAheads(booked.hotelTask)).toHaveLength(1);
      // A fresh request id while one is pending for the same cost: a second e-mail, still one go-ahead.
      await sendBookingRequest(booked.hotelTask);
      expect(await emails(booked.hotelTask)).toHaveLength(2);
      expect(await goAheads(booked.hotelTask)).toHaveLength(1);
      // A stale expected cost version is version_changed.
      await refused(PURCHASE, BR_SEND_SQL, brParams(booked.hotelTask, 0), 'version_changed');
    });
  });

  it('a stale row version is version_changed; a second decision is refused; a replayed decision changes nothing', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal();
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version + 5, rid()], 'version_changed');
      const req = rid();
      const first = await decide(ACC, g, 'approve', null, req);
      expect(sansOutcome(await decide(ACC, g, 'approve', null, req))).toEqual(sansOutcome(first));
      const [after] = await goAheads(booked.hotelTask);
      expect(after!.status).toBe('approved');
      // A second decision with the current row version: already_decided; with the old one: version_changed or already_decided.
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'return', 'Synthetic: second thoughts here', after!.row_version, rid()], 'already_decided');
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'return', 'Synthetic: second thoughts here', g.row_version, rid()], /version_changed|already_decided/);
      expect((await goAheads(booked.hotelTask))[0]!.status).toBe('approved');
    });
  });
});

// ---------------------------------------------------------------------------
// Cost above budget
// ---------------------------------------------------------------------------

describe('cost above budget', () => {
  it('a booking request above budget needs the branch Manager approval of that exact version', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      const booked = await bookedDeal({ hotelBudget: '4500000' });
      const { quoteId, versionNo } = await pricedTask(booked.hotelTask, '5000000');
      expect(await issues(booked.hotelTask)).toContain('over_budget');
      await refused(PURCHASE, BR_SEND_SQL, brParams(booked.hotelTask, versionNo), 'over_budget');
      expect(await emails(booked.hotelTask)).toEqual([]);
      // Other-branch manager, Sales, Accounts and Purchase cannot approve.
      for (const actor of [MANAGER_AMD, OWNER, ACC, PURCHASE]) {
        await refused(actor, OVER_BUDGET_SQL, [booked.hotelTask, versionNo], /not_authorized|not_self_approval/);
      }
      await one(MANAGER, OVER_BUDGET_SQL, [booked.hotelTask, versionNo]);
      expect(await issues(booked.hotelTask)).not.toContain('over_budget');
      await sendBookingRequest(booked.hotelTask);
      expect((await pendingGoAhead(booked.hotelTask)).cost_version_no).toBe(versionNo);
      // A new version above budget is not covered by the old approval.
      const v2 = await propose(PURCHASE, booked.hotelTask, quoteId, '5100000');
      expect(await issues(booked.hotelTask)).toContain('over_budget');
      await refused(PURCHASE, BR_SEND_SQL, brParams(booked.hotelTask, v2), 'over_budget');
    });
  });

  it('a Manager who also holds Purchase and proposed the cost cannot approve it (self-approval)', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      const booked = await bookedDeal({ hotelBudget: '4500000' });
      const { versionNo } = await pricedTask(booked.hotelTask, '5000000', MANAGER);
      await refused(MANAGER, OVER_BUDGET_SQL, [booked.hotelTask, versionNo], /not_authorized|not_self_approval/);
      expect(await owner('select 1 from public.purchase_cost_approvals where task_id = $1', [booked.hotelTask])).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

const REASON = 'Synthetic: the customer cancelled the trip';
type Cancellation = { id: string; status: string; row_version: number; opened_by: string; decided_by: string | null };
const cancellation = async () =>
  (await owner<Cancellation>(`select id, status, row_version, opened_by, decided_by from public.deal_cancellations where deal_id = $1`, [DEAL]));
type Charge = { task_id: string; revision_no: number; supplier_keeps_paise: string; supplier_refund_paise: string; committed_cost_paise: string; entered_by: string };
const charges = (taskId: string) =>
  owner<Charge>(`select task_id, revision_no, supplier_keeps_paise::text as supplier_keeps_paise, supplier_refund_paise::text as supplier_refund_paise,
    committed_cost_paise::text as committed_cost_paise, entered_by from public.purchase_cancellation_charges where task_id = $1 order by revision_no`, [taskId]);
const chargeParams = (taskId: string, keeps: string, refund: string, expected: number, requestId: string = rid()) =>
  [taskId, keeps, refund, 'Synthetic: supplier keeps one night', null, expected, requestId];

describe('trip cancellation', () => {
  it('only the Deal branch Manager opens it, with a 10-500 character reason, once per Deal; replays are existing', async () => {
    await asOwner(db, async () => {
      await bookedDeal();
      for (const actor of [MANAGER_AMD, OWNER, PURCHASE, ACC, SUPER]) {
        await refused(actor, CANCEL_OPEN_SQL, [DEAL, REASON, rid()], 'not_authorized', '42501');
      }
      await refused(MANAGER, CANCEL_OPEN_SQL, [DEAL, 'short', rid()], 'invalid_input', '22023');
      const req = rid();
      const first = await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, req]);
      expect(sansOutcome(await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, req]))).toEqual(sansOutcome(first));
      await expectDbError(db, () => run(MANAGER, CANCEL_OPEN_SQL, [DEAL, `${REASON} again`, rid()]), {}).catch(() => undefined);
      const rows = await cancellation();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'open', opened_by: U.managerDelhi });
    });
  });

  it('an open cancellation blocks booking requests, new final rates and supplier confirmation (trip_cancelled)', async () => {
    await asOwner(db, async () => {
      const a = await approvedHotel();
      await storeConfirmationProof(PURCHASE, a.hotelTask);
      expect(await issues(a.hotelTask)).toEqual([]);
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      expect(await issues(a.hotelTask)).toContain('trip_cancelled');
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask), 'trip_cancelled');
      await refused(PURCHASE, BR_SEND_SQL, brParams(a.hotelTask, a.versionNo), 'trip_cancelled');
      await refused(PURCHASE, COST_SQL, [a.hotelTask, a.quoteId, a.versionNo, '4000000', '2026-11-25', null, rid()], 'trip_cancelled');
      expect(await taskStatus(a.hotelTask)).toBe('in_progress');
      const ws = await workspace(PURCHASE, a.hotelTask);
      expect(ws.cancellation).toMatchObject({ status: 'open', reason: REASON });
    });
  });

  it('Purchase enters charges; send waits for every task with a cost; the Manager decides; a later change resets the case', async () => {
    await asOwner(db, async () => {
      // Both tasks hold a committed cost (supplier confirmed), so both need a charge however "agreed" is read.
      const booked = await approvedHotel();
      await storeConfirmationProof(PURCHASE, booked.hotelTask);
      await one(PURCHASE, CONFIRM_SQL, await confirmParams(booked.hotelTask));
      await pricedTask(booked.transferTask!, TRANSFER_COST);
      await sendBookingRequest(booked.transferTask!);
      await storeConfirmationProof(PURCHASE, booked.transferTask!);
      await one(PURCHASE, CONFIRM_SQL, await confirmParams(booked.transferTask!));
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      // Not Sales, managers, Accounts or another desk.
      for (const actor of [OWNER, MANAGER, ACC, VISA]) {
        await refused(actor, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '1000000', '3123457', 0), 'not_authorized', '42501');
      }
      await refused(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '-1', '0', 0), 'invalid_input', '22023');
      const req = rid();
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '1000000', '3123457', 0, req));
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '1000000', '3123457', 0, req)); // replay
      expect(await charges(booked.hotelTask)).toEqual([
        expect.objectContaining({ revision_no: 1, supplier_keeps_paise: '1000000', supplier_refund_paise: '3123457', committed_cost_paise: HOTEL_COST, entered_by: U.purchaseJodhpur }),
      ]);
      await refused(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '900000', '0', 0), 'version_changed');
      let c = (await cancellation())[0]!;
      expect(c.status).toBe('charges_entered');
      // The transfer has a cost but no charge yet.
      await expectDbError(db, () => run(PURCHASE, CANCEL_SEND_SQL, [c.id, c.row_version, rid()]), { message: /not_ready|invalid_input|charges_missing/ });
      expect((await cancellation())[0]!.status).toBe('charges_entered');
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.transferTask!, '612347', '0', 0));
      c = (await cancellation())[0]!;
      await refused(PURCHASE, CANCEL_SEND_SQL, [c.id, c.row_version + 3, rid()], 'version_changed');
      await one(PURCHASE, CANCEL_SEND_SQL, [c.id, c.row_version, rid()]);
      c = (await cancellation())[0]!;
      expect(c.status).toBe('sent_to_manager');
      // A change after sending puts it back to charges_entered.
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '1100000', '3023457', 1));
      c = (await cancellation())[0]!;
      expect(c.status).toBe('charges_entered');
      await one(PURCHASE, CANCEL_SEND_SQL, [c.id, c.row_version, rid()]);
      c = (await cancellation())[0]!;
      // Only the Deal's branch Manager decides; a return needs a reason.
      for (const actor of [MANAGER_AMD, PURCHASE, OWNER, ACC]) {
        await refused(actor, CANCEL_DECIDE_SQL, [c.id, 'approve', null, c.row_version, rid()], /not_authorized|not_self_approval/);
      }
      await refused(MANAGER, CANCEL_DECIDE_SQL, [c.id, 'return', 'short', c.row_version, rid()], 'invalid_input', '22023');
      await one(MANAGER, CANCEL_DECIDE_SQL, [c.id, 'approve', null, c.row_version, rid()]);
      c = (await cancellation())[0]!;
      expect(c).toMatchObject({ status: 'approved', decided_by: U.managerDelhi });
      // A second decision is refused.
      await refused(MANAGER, CANCEL_DECIDE_SQL, [c.id, 'return', 'Synthetic: second thoughts on it', c.row_version, rid()], /already_decided|version_changed/);
    });
  });

  it('the Manager who entered a current charge cannot decide the case', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      const booked = await bookedDeal({ transfer: false });
      // The task is not taken: any Purchase person of the entity may enter its charge.
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [booked.hotelTask]);
      const sid = await createSupplier();
      const quoteId = await addQuote(PURCHASE, booked.hotelTask, sid, HOTEL_COST);
      await propose(PURCHASE, booked.hotelTask, quoteId, HOTEL_COST);
      await one(PURCHASE, 'select public.purchase_task_release($1) as r', [booked.hotelTask]);
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await one(MANAGER, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '500000', '3623457', 0));
      let c = (await cancellation())[0]!;
      await one(PURCHASE, CANCEL_SEND_SQL, [c.id, c.row_version, rid()]);
      c = (await cancellation())[0]!;
      expect(c.status).toBe('sent_to_manager');
      await refused(MANAGER, CANCEL_DECIDE_SQL, [c.id, 'approve', null, c.row_version, rid()], /not_self_approval|not_authorized/);
      expect((await cancellation())[0]!.status).toBe('sent_to_manager');
    });
  });

  it('the Purchase workspace shows only the supplier side of the cancellation', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal({ transfer: false });
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '1000000', '3123457', 0));
      const ws = await workspace(PURCHASE, booked.hotelTask);
      expect(ws.cancellation).toMatchObject({ status: 'charges_entered', canEnter: true });
      expectNoLeak('workspace with cancellation', ws);
      // The Delhi manager sees the case; the Ahmedabad manager does not.
      const c = (await cancellation())[0]!;
      expect(JSON.stringify(await one(MANAGER, CANCEL_LIST_SQL))).toContain(c.id);
      const other = await run(MANAGER_AMD, CANCEL_LIST_SQL).then((r) => JSON.stringify(r)).catch(() => '');
      expect(other).not.toContain(c.id);
    });
  });
});

// ---------------------------------------------------------------------------
// Direct API permission failures
// ---------------------------------------------------------------------------

describe('direct calls by people who may not do the work', () => {
  it('Sales, Flight, Visa, another-branch Manager and an unassigned Purchase person cannot drive the hotel task', async () => {
    await asOwner(db, async () => {
      await addMembership(U.movedStaff, 'flight');
      const booked = await bookedDeal();
      const { supplierId, versionNo } = await pricedTask(booked.hotelTask, HOTEL_COST);
      const outsiders: Array<[string, Actor]> = [['sales', OWNER], ['sales B', SALES_B], ['flight', FLIGHT], ['visa', VISA], ['manager AMD', MANAGER_AMD], ['accounts', ACC]];
      for (const [label, actor] of outsiders) {
        await refused(actor, BR_SEND_SQL, brParams(booked.hotelTask, versionNo), 'not_authorized', '42501').catch((e) => { throw new Error(`${label}: ${e}`); });
        await refused(actor, EMAIL_RECORD_SQL, rateParams(booked.hotelTask, supplierId), 'not_authorized', '42501');
      }
      // Moved Staff becomes Purchase too, but the task is someone else's.
      await addMembership(U.movedStaff, 'purchase');
      await refused(PURCHASE_2, BR_SEND_SQL, brParams(booked.hotelTask, versionNo), 'not_authorized', '42501');
      await refused(PURCHASE_2, EMAIL_RECORD_SQL, rateParams(booked.hotelTask, supplierId), 'not_authorized', '42501');
      expect(await emails(booked.hotelTask)).toEqual([]);
      expect(await goAheads(booked.hotelTask)).toEqual([]);
    });
  });

  it('Sales reads no supplier e-mails, go-ahead amounts or cancellation charges through the Data API', async () => {
    await asOwner(db, async () => {
      const a = await approvedHotel();
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(a.hotelTask, '1000000', '3123457', 0));
      for (const t of ['purchase_supplier_emails', 'purchase_go_ahead_requests', 'purchase_cancellation_charges', 'deal_cancellations']) {
        for (const actor of [OWNER, SALES_B, VISA]) {
          const rows = await run(actor, `select * from public.${t}`).catch(() => []);
          expect(rows, `${t} ${actor.userId}`).toEqual([]);
        }
      }
    });
  });

  it('a Sales person of the Deal who also holds Accounts cannot decide its go-ahead (deal conflict)', async () => {
    await asOwner(db, async () => {
      await addMembership(U.visaJodhpur, 'accounts');
      await owner(`insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
        select d.id, d.legal_entity_id, $2, 'sales' from public.deals d where d.id = $1`, [DEAL, U.visaJodhpur]);
      const booked = await bookedDeal({ transfer: false });
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      await refused(ACC2, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], /not_self_approval|not_authorized/);
    });
  });

  it('an open cancellation stops Accounts approving a pending go-ahead', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal({ transfer: false });
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], 'trip_cancelled');
    });
  });

  it('Accounts go-ahead list is Accounts-only', async () => {
    await asOwner(db, async () => {
      const booked = await bookedDeal({ transfer: false });
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const g = await pendingGoAhead(booked.hotelTask);
      for (const actor of [PURCHASE, OWNER, MANAGER_AMD]) {
        const seen = await run(actor, GA_LIST_SQL).then((r) => JSON.stringify(r)).catch(() => '');
        expect(seen).not.toContain(g.id);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Leakage
// ---------------------------------------------------------------------------

describe('Purchase reads never carry selling price, margin, receipts or customer amounts', () => {
  it('workspace, task list and supplier reads after a go-ahead, e-mails and a verified customer receipt', async () => {
    await asOwner(db, async () => {
      await addMembership(U.visaJodhpur, 'accounts');
      const a = await approvedHotel();
      // A verified customer receipt with a distinctive amount (Accounts records, a second Accounts person verifies).
      const RECEIPT = '1765433';
      const [dest] = await owner<{ id: string; legal_entity_id: string }>(
        `insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
         select d.legal_entity_id, 'bank', 'Synthetic fixture destination', d.is_synthetic, $2 from public.deals d where d.id = $1
         returning id, legal_entity_id`, [DEAL, U.accountsJodhpur]);
      const [ver] = await owner<{ id: string }>(
        `insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
           account_number, ifsc, status, maker, request_id, decided_by, decided_at)
         values ($1, $2, 1, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', 'approved', $3, gen_random_uuid(), $4, now()) returning id`,
        [dest!.legal_entity_id, dest!.id, U.accountsJodhpur, U.visaJodhpur]);
      await owner('update public.company_destinations set current_version_id = $1 where id = $2', [ver!.id, dest!.id]);
      const [del] = await owner<{ id: string }>(`select b.id from public.branches b where b.code = 'DEL'`);
      const rec = await one<{ id: string }>(ACC, 'select public.receipt_record($1, $2::jsonb, $3) as r', [DEAL, JSON.stringify({
        mode: 'bank_transfer', amountPaise: RECEIPT, receivedOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
        branchId: del!.id, payerName: 'Synthetic Payer', payerPan: 'ABCDE1234F', reference: 'UTRSYNTHETIC001', destinationVersionId: ver!.id,
      }), rid()]);
      const proof = await one<{ id: string; objectPath: string }>(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
        ['receipt', rec.id, 'bank_proof', 'proof.pdf', 'application/pdf', 2048, 'd'.repeat(64), rid()]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`, [proof.objectPath]);
      await one(ACC, 'select public.finance_evidence_finish($1, true) as r', [proof.id]);
      await one(ACC2, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()]);

      const reads: Array<[string, unknown]> = [
        ['purchase_workspace', await workspace(PURCHASE, a.hotelTask)],
        ['purchase_workspace (transfer)', await workspace(PURCHASE, a.transferTask!)],
        ['purchase_task_list', await one(PURCHASE, TASK_LIST_SQL)],
        ['purchase_task_get', await one(PURCHASE, 'select public.purchase_task_get($1) as r', [a.hotelTask])],
        ['supplier_list', await one(PURCHASE, 'select public.supplier_list() as r')],
        ['supplier_get', await one(PURCHASE, 'select public.supplier_get($1) as r', [a.supplierId])],
      ];
      for (const [label, value] of reads) expectNoLeak(label, value, [RECEIPT, proof.id, rec.id]);
      // The e-mails Purchase wrote are stored without the selling price.
      for (const e of await emails(a.hotelTask)) expect(`${e.subject} ${e.body}`).not.toContain(SELLING);
    });
  });

  it('audit rows of the new commands carry no amounts', async () => {
    await asOwner(db, async () => {
      const a = await approvedHotel();
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(a.hotelTask, '1000000', '3123457', 0));
      const audit = await owner<{ action: string; details: unknown }>(
        `select action, details from public.audit_events where action ~* '(go_ahead|booking_request|email|cancellation|charge)'`);
      expect(audit.length).toBeGreaterThan(0);
      const text = JSON.stringify(audit);
      for (const v of [HOTEL_COST, '3123457', '1000000', SELLING]) expect(text, v).not.toContain(v);
    });
  });
});

// ---------------------------------------------------------------------------
// Lead contract changes after the independent review (2 November 2026)
// ---------------------------------------------------------------------------

describe('review changes: go-ahead follows the booking review; queued e-mails; cancellation deciders', () => {
  it('an approved go-ahead is valid only while the Accounts booking review of its version stays approved', async () => {
    await asOwner(db, async () => {
      const a = await approvedHotel();
      await storeConfirmationProof(PURCHASE, a.hotelTask);
      expect(await issues(a.hotelTask)).toEqual([]);
      await owner(`update public.accounts_booking_reviews set status = 'returned', return_reason = 'Synthetic return: billing to check',
        row_version = row_version + 1 where booking_version_id = $1`, [a.versionId]);
      expect(await goAheadState(a.hotelTask)).not.toBe('approved');
      expect(await issues(a.hotelTask)).toContain('go_ahead_missing');
      await refused(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask), 'go_ahead_missing');
      expect(await taskStatus(a.hotelTask)).toBe('in_progress');
      // Approved again: the same go-ahead counts again (validity is computed).
      await approveReview(a.versionId);
      expect(await goAheadState(a.hotelTask)).toBe('approved');
      expect((await one<{ outcome: string }>(PURCHASE, CONFIRM_SQL, await confirmParams(a.hotelTask))).outcome).toBe('created');
    });
  });

  it('Accounts cannot approve while the booking e-mail is queued or failed (booking_request_not_sent)', async () => {
    await asOwner(db, async () => {
      await owner('update public.procurement_settings set supplier_email_sending_enabled = true');
      const booked = await bookedDeal({ transfer: false });
      await approveReview(booked.versionId);
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await sendBookingRequest(booked.hotelTask);
      const [queued] = await emails(booked.hotelTask);
      expect(queued!.status).toBe('queued');
      const g = await pendingGoAhead(booked.hotelTask);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], 'booking_request_not_sent');
      // Failed at the provider: still refused.
      await one(SERVICE, MARK_RESULT_SQL, [queued!.id, 'failed', null, 'synthetic_failure']);
      await refused(ACC, GA_DECIDE_SQL, [g.id, 'approve', null, g.row_version, rid()], 'booking_request_not_sent');
      expect((await pendingGoAhead(booked.hotelTask)).decided_by).toBeNull();
      // Sent again and delivered: Accounts can approve the (current) request.
      await sendBookingRequest(booked.hotelTask);
      const delivered = (await emails(booked.hotelTask)).find((e) => e.status === 'queued')!;
      await one(SERVICE, MARK_RESULT_SQL, [delivered.id, 'sent', PROVIDER_ID, null]);
      const current = await pendingGoAhead(booked.hotelTask);
      await decide(ACC, current, 'approve');
      expect(await goAheadState(booked.hotelTask)).toBe('approved');
    });
  });

  it('a Manager who entered an earlier charge revision cannot decide, even after Purchase replaced it', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      const booked = await bookedDeal({ transfer: false });
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await one(PURCHASE, 'select public.purchase_task_release($1) as r', [booked.hotelTask]);
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await one(MANAGER, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '500000', '3623457', 0));
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '600000', '3523457', 1));
      expect((await charges(booked.hotelTask)).map((c) => c.entered_by)).toEqual([U.managerDelhi, U.purchaseJodhpur]);
      let c = (await cancellation())[0]!;
      await one(PURCHASE, CANCEL_SEND_SQL, [c.id, c.row_version, rid()]);
      c = (await cancellation())[0]!;
      await refused(MANAGER, CANCEL_DECIDE_SQL, [c.id, 'approve', null, c.row_version, rid()], 'not_self_approval');
      expect((await cancellation())[0]!.status).toBe('sent_to_manager');
    });
  });

  it('a Manager who sent the case to the Manager cannot decide it', async () => {
    await asOwner(db, async () => {
      await addMembership(U.managerDelhi, 'purchase', 'DEL');
      const booked = await bookedDeal({ transfer: false });
      await pricedTask(booked.hotelTask, HOTEL_COST);
      await one(PURCHASE, 'select public.purchase_task_release($1) as r', [booked.hotelTask]);
      await one(MANAGER, CANCEL_OPEN_SQL, [DEAL, REASON, rid()]);
      await one(PURCHASE, CHARGE_SET_SQL, chargeParams(booked.hotelTask, '500000', '3623457', 0));
      let c = (await cancellation())[0]!;
      await one(MANAGER, CANCEL_SEND_SQL, [c.id, c.row_version, rid()]);
      c = (await cancellation())[0]!;
      expect(c.status).toBe('sent_to_manager');
      await refused(MANAGER, CANCEL_DECIDE_SQL, [c.id, 'approve', null, c.row_version, rid()], 'not_self_approval');
    });
  });
});
