import type { TestDb } from '../helpers/db';
import { type Actor } from '../helpers/db';
import { BILLING, CONTACT, DEAL, HOTEL as HOTEL_FACTS, OWNER, SUPER, TRAVELLERS, TRIP, b1Helpers, rid } from './b1-support';

/**
 * Shared helpers for the B1.1 PGlite suites (tests/db/b11-*.test.ts),
 * migrations 20261119000100 (Book now), 0300 (revision) and 0500 (department
 * forms). Builds on b1-support (same synthetic actors and Deals).
 */

export const CONTACTS_SQL = 'select public.booking_contacts_save($1, $2, $3::jsonb) as r';
export const PROPOSE_SQL = 'select public.booking_billing_propose($1, $2, $3::jsonb, $4) as r';
export const CUSTOMER_SQL = 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r';
export const TRIP_SQL = 'select public.booking_trip_save($1, $2, $3::jsonb) as r';
export const IDENTITY_SQL = 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r';
export const PARTICIPATION_SQL = 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r';
export const COMMERCIALS_SQL = 'select public.booking_commercials_save($1, $2, $3::bigint, $4::bigint, $5::bigint) as r';
export const PLAN_SQL = 'select public.booking_instalments_save($1, $2, $3::jsonb) as r';
export const FORM_SQL = 'select public.booking_form_get($1) as r';

export const VISA = { country: 'United Arab Emirates', purpose: 'Tourism', travelDate: '2026-12-10', applyBy: null, feePaidBy: 'customer', notes: null };
export const PASSPORT = { applicationType: 'renewal', officeCity: 'Jodhpur', neededBy: '2026-11-20', notes: null };
export const IDENTITY = { dateOfBirth: '1990-05-17', nationality: 'Indian', passportNumber: 'Z1234567', passportExpiry: '2030-01-31' };

export { BILLING, CONTACT, TRAVELLERS, TRIP, rid };

type RV = { rowVersion: number; contentHash: string };

export function b11Helpers(getDb: () => TestDb) {
  const h = b1Helpers(getDb);
  const { one } = h;

  const saveContacts = (actor: Actor, versionId: string, rowVersion: number, fields: unknown = CONTACT) =>
    one<RV>(actor, CONTACTS_SQL, [versionId, rowVersion, JSON.stringify(fields)]);
  const saveTrip = (actor: Actor, versionId: string, rowVersion: number, fields: unknown = TRIP) =>
    one<RV>(actor, TRIP_SQL, [versionId, rowVersion, JSON.stringify(fields)]);
  const propose = (actor: Actor, deal: string, expected: number, fields: unknown = BILLING, requestId: string = rid()) =>
    one<{ outcome: string; status: string; rowVersion: number }>(actor, PROPOSE_SQL, [deal, expected, JSON.stringify(fields), requestId]);
  const saveIdentity = (actor: Actor, deal: string, seq: number, expected: number, fields: unknown = IDENTITY) =>
    one<{ seq: number; rowVersion: number }>(actor, IDENTITY_SQL, [deal, seq, expected, JSON.stringify(fields)]);
  const saveParticipation = (actor: Actor, itemId: string, versionId: string, rowVersion: number, seqs: number[]) =>
    one<RV>(actor, PARTICIPATION_SQL, [itemId, versionId, rowVersion, seqs]);
  const saveCommercials = (actor: Actor, versionId: string, rowVersion: number, list: string | null, discount: string | null, total: string | null) =>
    one<RV>(actor, COMMERCIALS_SQL, [versionId, rowVersion, list, discount, total]);
  const savePlan = (actor: Actor, versionId: string, rowVersion: number, plan: unknown) =>
    one<RV>(actor, PLAN_SQL, [versionId, rowVersion, JSON.stringify(plan)]);
  const form = (actor: Actor, deal: string = DEAL) => one<Record<string, unknown> | null>(actor, FORM_SQL, [deal]);

  /** Switch on, open a package draft and save travellers (no items). */
  async function draftWithTravellers(actor: Actor = OWNER, deal: string = DEAL, travellers: unknown = TRAVELLERS) {
    await h.setSwitch('service_items_enabled', true);
    const opened = await h.openDraft(actor, deal);
    const saved = await h.saveTravellers(actor, deal, opened.rowVersion, travellers);
    return { versionId: opened.versionId, rowVersion: saved.rowVersion };
  }

  /**
   * A complete, ready package draft with the given items (facts by type),
   * selling total, plan, identities for every traveller, acceptance proof.
   */
  async function readyDraft(
    actor: Actor,
    deal: string,
    items: Array<[string, unknown]>,
    opts: { scope?: 'domestic' | 'international'; identities?: boolean; travellers?: unknown } = {},
  ) {
    const d = await draftWithTravellers(actor, deal, opts.travellers ?? TRAVELLERS);
    let rv = d.rowVersion;
    const itemIds: string[] = [];
    for (const [type, facts] of items) {
      const added = await h.addItem(actor, d.versionId, rv, type, facts);
      rv = added.rowVersion;
      itemIds.push(added.itemId);
    }
    rv = (await h.saveSelling(actor, d.versionId, rv)).rowVersion;
    rv = await h.completeB11(actor, deal, d.versionId, rv);
    if (opts.scope === 'international') {
      rv = (await saveTrip(actor, d.versionId, rv, { ...TRIP, scope: 'international' })).rowVersion;
    }
    if (opts.identities) {
      const seqs = (await h.owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [deal])).map((t) => t.seq);
      for (const seq of seqs) await saveIdentity(actor, deal, seq, 0, { ...IDENTITY, passportNumber: `Z${1000000 + seq}` });
    }
    await h.storeEvidence(actor, d.versionId);
    const r = await h.readiness(actor, d.versionId);
    return { versionId: d.versionId, rowVersion: rv, hash: r.contentHash, issues: r.issues, itemIds };
  }

  /** A confirmed package with a visa item (desk switch off), then the switch on: returns the desk task. */
  async function deskTask(travellers: unknown = TRAVELLERS) {
    const n = (travellers as unknown[]).length;
    const hotel = { ...HOTEL_FACTS, adults: n, children: 0 };
    const ready = await readyDraft(OWNER, DEAL, [['hotel', hotel], ['visa', VISA]], { identities: true, travellers });
    if (ready.issues.length > 0) throw new Error(`deskTask not ready: ${ready.issues.join(',')}`);
    const confirmed = await h.confirm(OWNER, ready.versionId, ready.hash);
    const on = await one<{ tasksCreated: number }>(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
    const [task] = await h.owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'visa'`, [DEAL]);
    return { versionId: ready.versionId, hotelTaskId: confirmed.taskIds![0]!, taskId: task!.id, created: on.tasksCreated, itemIds: ready.itemIds };
  }

  /** Begins, uploads (storage row) and finishes a department evidence file; returns its id. */
  async function deskEvidence(actor: Actor, taskId: string, kind: string, applicationId: string | null = null): Promise<string> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(actor, EV_BEGIN_SQL,
      [taskId, applicationId, kind, `${kind}.pdf`, 'application/pdf', 2048, 'b'.repeat(64)]);
    await h.owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    const fin = await one<{ status: string }>(actor, EV_FINISH_SQL, [ev.evidenceId, true]);
    if (fin.status !== 'stored') throw new Error('evidence not stored');
    return ev.evidenceId;
  }

  return { ...h, deskTask, deskEvidence, saveContacts, saveTrip, propose, saveIdentity, saveParticipation, saveCommercials, savePlan, form, draftWithTravellers, readyDraft };
}

/** B1.1c (20261119000500): the Visa & Passport desk and department forms. */
/** visa.jodhpur holds the Visa role in the fixtures (the desk). */
export const DESK: Actor = { userId: 'a0000000-0000-4000-8000-000000000011' };
export const SETTING_SQL_B11 = 'select public.admin_set_workflow_setting($1, $2, $3) as r';
export const VISA_GET_SQL = 'select public.visa_task_get($1) as r';
export const VISA_LIST_SQL = 'select public.visa_task_list() as r';
export const VISA_CLAIM_SQL = 'select public.visa_task_claim($1) as r';
export const APP_UPDATE_SQL = 'select public.visa_application_update($1, $2, $3::jsonb) as r';
export const APP_STATE_SQL = 'select public.visa_application_set_state($1, $2, $3, $4) as r';
export const EV_BEGIN_SQL = 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r';
export const EV_FINISH_SQL = 'select public.department_evidence_finish($1, $2) as r';
export const EV_DOWNLOAD_SQL = 'select public.department_evidence_authorize_download($1) as r';
export const COST_SAVE_SQL = 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r';
export const COST_SUBMIT_SQL = 'select public.department_cost_submit($1, $2) as r';
export const EXPENSE_ACCEPT_SQL = 'select public.expense_record_accept($1, $2, $3) as r';
export const EXPENSE_RETURN_SQL = 'select public.expense_record_return($1, $2, $3, $4) as r';
export const EXPENSE_LIST_SQL = 'select public.accounts_expense_records($1, $2, $3) as r';
export const WORK_FORM_SQL = 'select public.department_work_form($1) as r';
export const SWITCH_REASON = 'Synthetic desk launch for the test';
