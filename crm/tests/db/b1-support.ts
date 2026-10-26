import { expect } from 'vitest';
import type { ConfirmBookingResult, OpenDraftResult, ServiceItemAddResult } from '@/modules/fulfilment/contracts';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Shared scenario helpers for the B1 PGlite suites (tests/db/b1-*.test.ts),
 * migration 20261118000100_b1_service_items. Every scenario runs inside ONE
 * rolled-back owner transaction (asOwner) and switches to an impersonated
 * request only for the statement under test, as the booking suite does.
 *
 * Synthetic roles (all @example.test, see supabase/fixtures):
 *   OWNER      Synthetic Sales Delhi A      owns SYN-DEL-001 (Delhi)
 *   SALES_B    Synthetic Sales Delhi B      owns SYN-DEL-002
 *   MANAGER    Synthetic Manager Delhi      manager, Delhi branch
 *   PURCHASE   Synthetic Purchase Jodhpur   purchase, Jodhpur (entity-wide)
 *   FLIGHT     Synthetic Visa Jodhpur       given a 'flight' membership per test (addFlight)
 *   ACCOUNTS   Synthetic Accounts Jodhpur   entity-wide deal.read grant
 *   SUPER      Synthetic Admin Jodhpur      super_admin (workflow switches)
 */

export const OWNER: Actor = { userId: U.salesDelhiA };
export const SALES_B: Actor = { userId: U.salesDelhiB };
export const SALES_AMD: Actor = { userId: U.salesAhmedabad };
export const MANAGER: Actor = { userId: U.managerDelhi };
export const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
export const PURCHASE: Actor = { userId: U.purchaseJodhpur };
export const FLIGHT: Actor = { userId: U.visaJodhpur };
export const ACCOUNTS: Actor = { userId: U.accountsJodhpur };
export const SUPER: Actor = { userId: U.adminJodhpur };
export const OTHER_ENTITY: Actor = { userId: U.salesEntityB };
export const ANON: Actor = { userId: null };
export const SVC: Actor = { userId: null, role: 'service_role' };
export const DEAL = D.del001;
export const DEAL2 = D.del002;
export const DEAL_AMD = D.amd001;

export const SHA = 'a'.repeat(64);
export const SELLING = '9876543';
export const REASON = 'Synthetic test reason for the switch';

export const HOTEL = {
  hotelName: 'Synthetic Hotel (fixture)',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-13',
  rooms: 2,
  adults: 3,
  roomType: 'Synthetic Deluxe',
  mealPlan: 'Breakfast',
  children: 1,
  inclusions: null,
  specialRequests: null,
};
export const TRANSFER = {
  route: 'Synthetic airport to hotel',
  date: '2026-12-10',
  vehicleType: 'Sedan',
  passengers: 4,
  pickupTime: '09:30',
  notes: null,
};
export const ACTIVITY = {
  name: 'Synthetic desert safari',
  city: 'Synthetic City',
  date: '2026-12-11',
  participants: 4,
  time: null,
  notes: 'Synthetic note',
};
export const FLIGHT_FACTS = {
  segments: [
    { from: 'DEL', to: 'JDH', date: '2026-12-10' },
    { from: 'JDH', to: 'DEL', date: '2026-12-13' },
  ],
  passengers: 4,
  preferredTime: null,
  cabin: 'Economy',
  notes: null,
};
export const TRAVELLERS = [
  { fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 },
  { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 },
  { fullName: 'Synthetic Traveller Three', type: 'adult', seq: 3 },
  { fullName: 'Synthetic Traveller Four', type: 'child', seq: 4, ageYears: 9 },
];
export const BUDGETS: Record<string, string> = { hotel: '4500000', transfer: '350000', activity: '120000', flight: '2800000' };

export const rid = () => crypto.randomUUID();

/** B1.1 (20261119000100): the rest of a submittable package draft. */
export const TRIP = { destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' };
export const CONTACT = {
  contactName: 'Synthetic Contact', mobile: '9876500011', email: 'contact@example.test', contactConfirmed: true,
  bookingFor: 'individual', payerDifferent: false, payerName: null,
};
export const BILLING = {
  billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur',
  stateCode: '08', postalCode: '342001', gstin: null,
};

export const ADD_SQL = 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r';
export const SAVE_ITEM_SQL = 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r';
export const REMOVE_SQL = 'select public.service_item_remove($1, $2, $3) as r';
export const TRAVELLERS_SQL = 'select public.deal_travellers_save($1, $2, $3::jsonb) as r';
export const OPEN_SQL = 'select public.booking_open_draft($1) as r';
export const CONFIRM_SQL = 'select public.booking_confirm($1, $2) as r';
export const READINESS_SQL = 'select public.booking_readiness($1) as r';
export const CHECKLIST_SQL = 'select public.intake_checklist($1) as r';
export const SERVICES_SQL = 'select public.deal_services($1) as r';
export const SUMMARY_SQL = 'select public.deal_service_summary($1::uuid[]) as r';
export const COUNTS_SQL = 'select public.my_work_counts() as r';
export const PANEL_SQL = 'select public.booking_panel($1) as r';
export const FLIGHT_LIST_SQL = 'select public.flight_task_list() as r';
export const FLIGHT_GET_SQL = 'select public.flight_task_get($1) as r';
export const FLIGHT_CLAIM_SQL = 'select public.flight_task_claim($1) as r';
export const PURCHASE_LIST_SQL = 'select public.purchase_task_list() as r';
export const PURCHASE_GET_SQL = 'select public.purchase_task_get($1) as r';
export const PURCHASE_CLAIM_SQL = 'select public.purchase_task_claim($1) as r';
export const SETTING_SQL = 'select public.admin_set_workflow_setting($1, $2, $3) as r';
export const SETTINGS_GET_SQL = 'select public.workflow_settings_get() as r';

/** Every key of a JSON value, recursively (for "never a selling value" assertions). */
export function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}
export const FORBIDDEN_KEY = /sell|margin|commercial|evidence|traveller(?!Count)|fullName|review|returnReason|dealTitle|ownerName|receipt|payer/i;

export function b1Helpers(getDb: () => TestDb) {
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
    await expectDbError(db(), () => run(actor, sql, params), {
      code,
      ...(token ? { message: new RegExp(`^${token}$`) } : {}),
    });
  }
  /** Refusal whose hint (the invalid field keys) matches. */
  async function refusedWithHint(actor: Actor, sql: string, params: unknown[], hint: RegExp): Promise<void> {
    await db().exec('savepoint b1_hint');
    let error: { code?: string; message?: string; hint?: string } | undefined;
    try {
      await run(actor, sql, params);
    } catch (e) {
      error = e as { code?: string; message?: string; hint?: string };
      await db().exec('rollback to savepoint b1_hint');
    }
    if (error === undefined) throw new Error('expected a database error, but the statement succeeded');
    expect(error.code).toBe('22023');
    expect(error.message).toBe('invalid_input');
    expect(error.hint ?? '').toMatch(hint);
  }
  const owner = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db().query<T>(sql, params);

  /** Owner SQL: flips a workflow switch (audited by trigger as direct_sql). */
  async function setSwitch(key: 'service_items_enabled' | 'intake_prompt_enabled', on: boolean): Promise<void> {
    await resetActor(db());
    await owner(`update public.workflow_settings set ${key} = $1 where id`, [on]);
  }
  async function addFlight(user: string = U.visaJodhpur, branch = 'JDH'): Promise<void> {
    await owner(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, 'flight', 'active'
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $2`,
      [user, branch],
    );
  }
  async function addSalesAssignee(deal: string = DEAL, user: string = U.salesDelhiB): Promise<void> {
    await owner(
      `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
       select id, legal_entity_id, $2, 'sales', $3 from public.deals where id = $1`,
      [deal, user, U.adminJodhpur],
    );
  }

  const openDraft = (actor: Actor = OWNER, deal: string = DEAL) => one<OpenDraftResult>(actor, OPEN_SQL, [deal]);
  const addItem = (
    actor: Actor,
    versionId: string,
    rowVersion: number,
    type: string,
    facts: unknown,
    budget: string | null = BUDGETS[type] ?? '0',
    requestId: string = rid(),
  ) => one<ServiceItemAddResult>(actor, ADD_SQL, [versionId, rowVersion, type, JSON.stringify(facts), budget, requestId]);
  const saveTravellers = (actor: Actor, deal: string, rowVersion: number, travellers: unknown = TRAVELLERS) =>
    one<{ rowVersion: number; contentHash: string }>(actor, TRAVELLERS_SQL, [deal, rowVersion, JSON.stringify(travellers)]);
  const saveSelling = (actor: Actor, versionId: string, rowVersion: number, selling: string | null = SELLING) =>
    one<{ rowVersion: number; contentHash: string }>(
      actor,
      'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r',
      [
        versionId,
        rowVersion,
        JSON.stringify({
          hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null,
          adults: null, children: null, inclusions: null, specialRequests: null, purchaseBudgetPaise: null,
        }),
        selling,
      ],
    );
  async function storeEvidence(actor: Actor, versionId: string, kind = 'acceptance_message', sha: string = SHA): Promise<string> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(
      actor,
      'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
      [versionId, kind, 'acceptance.pdf', 'application/pdf', 2048, sha],
    );
    await owner(
      `insert into storage.objects (bucket_id, name, metadata) values ('booking-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath],
    );
    const fin = await one<{ status: string }>(actor, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
    expect(fin.status).toBe('stored');
    return ev.evidenceId;
  }
  const readiness = (actor: Actor, versionId: string) =>
    one<{ ready: boolean; issues: string[]; contentHash: string }>(actor, READINESS_SQL, [versionId]);
  const confirm = (actor: Actor, versionId: string, hash: string) => one<ConfirmBookingResult>(actor, CONFIRM_SQL, [versionId, hash]);

  /**
   * B1.1: trip, confirmed contact + billing proposal, every traveller on every
   * item, and a one-instalment plan equal to the selling total. Returns the
   * new row version.
   */
  async function completeB11(actor: Actor, deal: string, versionId: string, rowVersion: number, selling: string = SELLING): Promise<number> {
    let rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
      [versionId, rowVersion, JSON.stringify(TRIP)])).rowVersion;
    const billingRow = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
    rv = (await one<{ rowVersion: number }>(actor,
      'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r',
      [versionId, rv, JSON.stringify(CONTACT), billingRow.length ? null : JSON.stringify(BILLING), 0, rid()])).rowVersion;
    const seqs = (await owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [deal])).map((t) => t.seq);
    const items = await owner<{ id: string; service_type: string }>(
      `select i.id, i.service_type from public.service_items i join public.service_item_facts f on f.service_item_id = i.id
       where f.booking_version_id = $1 order by i.item_no`, [versionId]);
    for (const item of items) {
      rv = (await one<{ rowVersion: number }>(actor, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
        [item.id, versionId, rv, item.service_type === 'passport' ? seqs.slice(0, 1) : seqs])).rowVersion;
    }
    rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
      [versionId, rv, JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: selling, dueDate: '2026-11-01' }])])).rowVersion;
    // B1.2 (20261120000100, DEC-38): a stored identity proof per traveller (adults required).
    for (const seq of seqs) await storeIdProof(actor, deal, seq);
    return rv;
  }

  /** B1.2: begin (with consent), storage object and finish of one traveller identity proof; returns the file id. */
  async function storeIdProof(actor: Actor, deal: string, seq: number): Promise<string> {
    const begun = await one<{ fileId: string; objectPath: string }>(actor,
      'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
      [deal, seq, rid(), `id-proof-${seq}.jpg`, 'image/jpeg', 2048, SHA]);
    await owner(
      `insert into storage.objects (bucket_id, name, metadata) values ('traveller-id-proofs', $1, jsonb_build_object('size', 2048::bigint))`,
      [begun.objectPath],
    );
    const fin = await one<{ status: string }>(actor, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
    expect(fin.status).toBe('stored');
    return begun.fileId;
  }

  /**
   * Switch on, open a package draft on `deal`, add the given service types,
   * save travellers, selling total, the B1.1 steps and one stored acceptance proof.
   * Returns the version, the item ids by type and the hash after everything.
   */
  async function readyPackage(
    actor: Actor = OWNER,
    deal: string = DEAL,
    types: string[] = ['hotel', 'transfer', 'activity', 'flight'],
  ): Promise<{ versionId: string; rowVersion: number; hash: string; items: Record<string, ServiceItemAddResult> }> {
    await setSwitch('service_items_enabled', true);
    const opened = await openDraft(actor, deal);
    expect(opened.created).toBe(true);
    let rowVersion = opened.rowVersion;
    const items: Record<string, ServiceItemAddResult> = {};
    const facts: Record<string, unknown> = { hotel: HOTEL, transfer: TRANSFER, activity: ACTIVITY, flight: FLIGHT_FACTS };
    for (const type of types) {
      const added = await addItem(actor, opened.versionId, rowVersion, type, facts[type]);
      rowVersion = added.rowVersion;
      items[type] = added;
    }
    rowVersion = (await saveTravellers(actor, deal, rowVersion)).rowVersion;
    rowVersion = (await saveSelling(actor, opened.versionId, rowVersion)).rowVersion;
    rowVersion = await completeB11(actor, deal, opened.versionId, rowVersion);
    await storeEvidence(actor, opened.versionId);
    const r = await readiness(actor, opened.versionId);
    expect(r.issues).toEqual([]);
    return { versionId: opened.versionId, rowVersion, hash: r.contentHash, items };
  }

  /** Legacy hotel flow while the switch is off (today's path). */
  async function readyHotel(actor: Actor = OWNER, deal: string = DEAL): Promise<{ versionId: string; hash: string }> {
    await setSwitch('service_items_enabled', false);
    const opened = await openDraft(actor, deal);
    await one(actor, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [
      opened.versionId,
      opened.rowVersion,
      JSON.stringify({ ...HOTEL, purchaseBudgetPaise: BUDGETS.hotel }),
      SELLING,
    ]);
    await storeEvidence(actor, opened.versionId);
    const r = await readiness(actor, opened.versionId);
    expect(r.issues).toEqual([]);
    return { versionId: opened.versionId, hash: r.contentHash };
  }

  /**
   * Test-only imported (Bitrix) Deal in Delhi owned by Sales Delhi A, in the
   * given pipeline/stage, verified now. Real booking confirmation is switched
   * on for the transaction so the Deal can confirm in the 'test' environment.
   */
  async function insertRealDeal(stage: string, categoryId = 0, sourceDealId = 990001): Promise<string> {
    const [inbox] = await owner<{ id: string }>(
      `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
       values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', $1::bigint, 1, repeat('b', 58) || lpad($2::text, 6, '0'), 'processed', now()) returning id`,
      [sourceDealId, String(sourceDealId)],
    );
    const [deal] = await owner<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
         source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
         source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
       select b.legal_entity_id, b.id, 'BX-' || $6::text, 'Synthetic test-only imported deal', $1, false,
         'bitrix', 'SYNTHETIC_MEMBER_0001', $4::bigint, $2, $3::bigint, now() - interval '3 days', now() - interval '2 days',
         now(), now(), $5, 101
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
       returning id`,
      [U.salesDelhiA, stage, categoryId, sourceDealId, inbox!.id, String(sourceDealId)],
    );
    await owner('update public.booking_settings set real_booking_enabled = true where id');
    return deal!.id;
  }

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await owner<{ n: string }>(`select count(*)::text as n from (${sql}) q`, params))[0]!.n);

  return {
    run, one, refused, refusedWithHint, owner, setSwitch, addFlight, addSalesAssignee,
    openDraft, addItem, saveTravellers, saveSelling, storeEvidence, readiness, confirm,
    readyPackage, readyHotel, insertRealDeal, count, completeB11, storeIdProof,
  };
}
