import { expect } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb } from '../helpers/db';
import { priceQuotationVersion } from './b12-quotation-money-support';
import { HOTEL, OWNER, TRANSFER, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * Batch 3 (migration 20261123000100) test helpers: referral drafts,
 * standalone quotations and itineraries, links and the 90-day closure.
 * Synthetic data only.
 */

export const B3 = {
  qStandalone: 'select public.quotation_create_standalone($1, $2::jsonb, $3, $4) as r',
  iStandalone: 'select public.itinerary_create_standalone($1, $2::jsonb, $3, $4) as r',
  draftSave: 'select public.referral_draft_save($1, $2, $3::jsonb) as r',
  close: 'select public.referral_draft_close($1, $2, $3, $4) as r',
  reopen: 'select public.referral_draft_reopen($1, $2, $3) as r',
  reassign: 'select public.referral_draft_reassign($1, $2, $3, $4) as r',
  link: 'select public.referral_draft_link($1, $2, $3, $4, $5) as r',
  unlink: 'select public.referral_draft_unlink($1, $2, $3, $4) as r',
  job: 'select public.referral_drafts_close_inactive($1) as r',
  list: 'select public.work_drafts_list($1, $2::jsonb, $3::jsonb, $4) as r',
  get: 'select public.referral_draft_get($1) as r',
  find: 'select public.referral_draft_find($1) as r',
  candidates: 'select public.referral_link_candidates($1, $2, $3) as r',
  owners: 'select public.referral_owner_candidates($1) as r',
  forSubject: 'select public.referral_drafts_for_subject($1, $2) as r',
  qCreate: 'select public.quotation_create($1, $2, $3, $4) as r',
  qSave: 'select public.quotation_version_save($1, $2, $3::jsonb) as r',
  qContacts: 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
  qItemAdd: 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
  qReady: 'select public.quotation_mark_ready($1, $2) as r',
  qSent: 'select public.quotation_mark_sent($1, $2, $3, $4) as r',
  qEvBegin: 'select public.quotation_evidence_begin($1, $2, $3, $4, $5, $6) as r',
  qEvFinish: 'select public.quotation_evidence_finish($1, $2) as r',
  qAccept: 'select public.quotation_accept($1, $2, $3, $4, $5) as r',
  qBind: 'select public.quotation_link_deal($1, $2, $3) as r',
  qConvert: 'select public.quotation_convert_to_booking($1, $2, $3) as r',
  qGet: 'select public.quotation_get($1) as r',
  qList: 'select public.quotation_list($1, $2) as r',
  qNewVersion: 'select public.quotation_new_version($1, $2, $3) as r',
  iCreate: 'select public.itinerary_document_create($1, $2, $3, $4) as r',
  iGet: 'select public.itinerary_document_get($1) as r',
  iList: 'select public.itinerary_document_list($1, $2) as r',
  iFacts: 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
  myCounts: 'select public.my_work_counts() as r',
  myList: 'select public.my_work_list($1, $2::jsonb, $3) as r',
} as const;

export const CUSTOMER = { customerName: 'Synthetic Walk-in Customer', mobile: '9876500101', sourceKind: 'walk_in' };

export type Standalone = {
  referralDraftId: string; referralReference: string; quotationId: string; reference: string; versionId: string; versionNo: number;
  rowVersion: number; created: boolean; possibleDuplicates: Array<{ reference: string }>;
};
export type StandaloneItin = {
  referralDraftId: string; referralReference: string; documentId: string; draftId: string; rowVersion: number; created: boolean;
  possibleDuplicates: Array<{ reference: string }>;
};
export type AutoClose = { state: string; dueOn: string | null };
export type DraftView = {
  referralDraftId: string; reference: string; status: string; closedReason: string | null; autoClose: AutoClose; rowVersion: number;
  ownerIsYou: boolean; ownerName: string | null; lastActivityAt: string; linked: boolean; bound: boolean;
  can: Record<string, boolean>; links: Array<{ linkId: string; targetKind: string; targetId: string; active: boolean; canRemove: boolean }>;
  quotations: Array<{ quotationId: string; accepted: boolean }>; itineraries: Array<{ documentId: string }>;
  customer: Record<string, unknown>;
};
export type ListPage = {
  applies: boolean; scope?: string; counts?: Record<string, number>; total?: number; hasMore?: boolean;
  next?: { since: string; id: string } | null; rows?: Array<Record<string, unknown>>;
};

export function batch3Helpers(getDb: () => TestDb) {
  const h = b11Helpers(getDb);
  const { one, owner } = h;

  const branchId = async (code = 'DEL') =>
    (await owner<{ id: string }>(
      `select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $1`, [code]))[0]!.id;

  /** Owner SQL: the referral switch (trigger sets the resume time on off -> on). */
  const referralSwitch = (on: boolean) => owner('update public.workflow_settings set referral_drafts = $1 where id', [on]);

  async function standalone(actor: Actor = OWNER, customer: Record<string, unknown> = CUSTOMER, branch = 'DEL', title = 'Synthetic referral quote',
    requestId: string = rid()) {
    return one<Standalone>(actor, B3.qStandalone, [await branchId(branch), JSON.stringify(customer), title, requestId]);
  }
  async function standaloneItinerary(actor: Actor = OWNER, customer: Record<string, unknown> = CUSTOMER, branch = 'DEL') {
    return one<StandaloneItin>(actor, B3.iStandalone, [await branchId(branch), JSON.stringify(customer), 'Synthetic referral itinerary', rid()]);
  }
  const draft = (actor: Actor, id: string) => one<DraftView | null>(actor, B3.get, [id]);
  const draftRow = async (id: string) =>
    (await owner<{ status: string; closed_reason: string | null; row_version: number; last_activity_at: string; closed_at: string | null;
      closed_due_on: string | null; owner_user_id: string }>(
      `select status, closed_reason, row_version, last_activity_at::text, closed_at::text, closed_due_on::text, owner_user_id
       from public.referral_drafts where id = $1`, [id]))[0]!;
  /** Moves the draft's last activity back (never the server clock, F.3.4). */
  const age = (id: string, days: number) =>
    owner(`update public.referral_drafts set last_activity_at = now() - make_interval(days => $2) where id = $1`, [id, days]);
  /** Moves the switch-on time back so it does not hold the clock. */
  const resumedDaysAgo = (days: number) =>
    owner(`update public.workflow_settings set referral_auto_close_resumed_at = now() - make_interval(days => $1) where id`, [days]);
  const list = (actor: Actor, kind: 'quotations' | 'itineraries', filter: Record<string, unknown> = {}, after: unknown = null, limit = 25) =>
    one<ListPage>(actor, B3.list, [kind, JSON.stringify(filter), after === null ? null : JSON.stringify(after), limit]);
  const auditCount = async (action?: string) =>
    Number((await owner<{ n: string }>(
      `select count(*)::text as n from public.audit_events where $1::text is null or action = $1`, [action ?? null]))[0]!.n);
  const job = (limit = 100) => one<{ closed: number; skipped: string | null }>({ userId: null, role: 'service_role' }, B3.job, [limit]);

  /** Ready, priced and shared version of a quotation the actor can edit; returns the content hash. */
  async function sendQuote(actor: Actor, versionId: string, rowVersion: number): Promise<string> {
    let rv = (await one<{ rowVersion: number }>(actor, B3.qSave, [versionId, rowVersion, JSON.stringify(
      { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-20', end: '2026-12-23', adults: 2 })])).rowVersion;
    rv = (await one<{ rowVersion: number }>(actor, B3.qContacts, [versionId, rv, JSON.stringify(
      { contactName: 'Synthetic Referral Contact', mobile: '9876500101', email: null, companyName: null })])).rowVersion;
    rv = (await one<{ rowVersion: number }>(actor, B3.qItemAdd, [versionId, rv, 'hotel', 'quoted', JSON.stringify(HOTEL)])).rowVersion;
    rv = (await one<{ rowVersion: number }>(actor, B3.qItemAdd, [versionId, rv, 'transfer', null, JSON.stringify(TRANSFER)])).rowVersion;
    rv = await priceQuotationVersion(one, owner, actor, versionId, rv);
    const ready = await one<{ contentHash: string }>(actor, B3.qReady, [versionId, rv]);
    await one(actor, B3.qSent, [versionId, ready.contentHash, 'whatsapp', rid()]);
    return ready.contentHash;
  }
  async function accept(actor: Actor, versionId: string, hash: string): Promise<void> {
    const ev = await one<{ evidenceId: string; objectPath: string }>(actor, B3.qEvBegin,
      [versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, 'e'.repeat(64)]);
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('quotation-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
      [ev.objectPath]);
    await one(actor, B3.qEvFinish, [ev.evidenceId, true]);
    await one(actor, B3.qAccept, [versionId, hash, ev.evidenceId, 'quoted', rid()]);
  }
  /** A referral draft with an accepted quotation (owner = actor). */
  async function acceptedReferral(actor: Actor = OWNER, customer: Record<string, unknown> = CUSTOMER) {
    const s = await standalone(actor, customer);
    const hash = await sendQuote(actor, s.versionId, s.rowVersion);
    await accept(actor, s.versionId, hash);
    return { ...s, hash };
  }
  async function linkDeal(actor: Actor, draftId: string, deal: string, kind: 'deal' | 'lead' = 'deal') {
    const rv = (await draftRow(draftId)).row_version;
    return one<{ linkId: string; rowVersion: number; existing: boolean }>(actor, B3.link, [draftId, rv, kind, deal, null]);
  }
  async function addRole(user: string, role: string, branch: string): Promise<void> {
    await owner(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $3`, [user, role, branch]);
  }
  /** Branch grant of deal.read_commercial (Manager price access, M3). */
  async function grantCommercial(user: string, branch = 'DEL'): Promise<void> {
    await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
                 select $1, b.legal_entity_id, b.id, 'deal.read_commercial', $2, 'Synthetic branch grant for the test'
                 from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
                 where e.code = 'HOLIDAY_CHACHA' and b.code = $3`, [user, U.adminJodhpur, branch]);
  }
  /** A synthetic imported Lead (scope intake). */
  async function insertLead(sourceLeadId: number, branch = 'DEL', ownerUser: string = U.salesDelhiA): Promise<string> {
    const [inbox] = await owner<{ id: string }>(
      `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
       values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', $1::bigint, 1, repeat('d', 58) || lpad($2::text, 6, '0'), 'processed', now()) returning id`,
      [sourceLeadId, String(sourceLeadId)]);
    const [lead] = await owner<{ id: string }>(
      `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
         source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
         manifest_id, intake_mode)
       select b.legal_entity_id, b.id, 'BXL-' || $1::text, 'Synthetic referral lead', $2, 'SYNTHETIC_MEMBER_0001', $1::bigint,
              'NEW', 'WEBFORM', now(), now(), now(), now(), $3, null, 'scope'
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $4 returning id`,
      [sourceLeadId, ownerUser, inbox!.id, branch]);
    return lead!.id;
  }
  /** Everything a read must not change (F.3.4-11). */
  const snapshot = async () =>
    (await owner<Record<string, string>>(
      `select (select count(*) from public.audit_events)::text as audit,
              (select string_agg(id::text || ':' || row_version || ':' || status || ':' || last_activity_at::text, ',' order by id)
               from public.referral_drafts) as drafts,
              (select string_agg(row_version::text, ',' order by id) from public.quotation_versions) as qrv,
              (select string_agg(status, ',' order by id) from public.quotation_versions) as qst`))[0];

  async function expectNull(actor: Actor, sql: string, params: unknown[], label: string): Promise<void> {
    expect(await one(actor, sql, params), label).toBeNull();
  }

  return {
    ...h, branchId, referralSwitch, standalone, standaloneItinerary, draft, draftRow, age, resumedDaysAgo, list, auditCount, job,
    sendQuote, accept, acceptedReferral, linkDeal, addRole, grantCommercial, insertLead, snapshot, expectNull,
  };
}
