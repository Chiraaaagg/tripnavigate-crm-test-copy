import { expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Actor, ACC2_FIXTURE_USERS as U2, FIXTURE_USERS as U, type TestDb, resetActor } from '../helpers/db';
import { ACC, ACC2, DEAL, HOTEL_ITEM, type Item, MANAGER, OWNER, PURCHASE, REASON, SUPER, rid, today } from './acc-support';
import { acc2cHelpers } from './acc2c-support';

/**
 * Accounts phase 3, Track T (independent tests) — shared scenario helpers for
 * tests/db/acc3-*.test.ts. Written from the frozen contract
 * (Tripnavigate-docs implementation/accounts-phase3-2026-11-12/contract.md,
 * sections 5-14 with Addenda O1 and L1), NOT from the tracks' code: every new
 * command and read is called with the positional signature the contract
 * freezes. Where the contract leaves a detail open, the helper or the test
 * says so in an "ASSUMPTION" comment.
 *
 * Every scenario runs inside ONE rolled-back owner transaction (asOwner) and
 * impersonates a request only for the statement under test (Phase 1 / 2 pattern).
 */

export const WORKER: Actor = { userId: null, role: 'service_role' };
export const MANAGER_J: Actor = { userId: U2.managerJodhpur };
export const MANAGER_J2: Actor = { userId: U2.managerJodhpur2 };
export const MANAGER_F: Actor = { userId: U2.managerFlightDelhi };
export const ACC_J2: Actor = { userId: U2.accountsJodhpur2 };
export const FLIGHT_J: Actor = { userId: U2.flightJodhpur };
export const VISA_J2: Actor = { userId: U2.visaJodhpur2 };
export { ACC, ACC2, DEAL, MANAGER, OWNER, PURCHASE, REASON, SUPER, U, U2, rid, today };

/** Synthetic Bitrix portal member of the fixtures (intake_synthetic.sql). */
const LIVE_MEMBER = 'SYNTHETIC_MEMBER_0001';
const migrationsDir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
/** True when a Phase 3 migration whose name starts with `20261205000<prefix>` exists (prefix '1' = track A, '2' = B, ...). */
export function trackLanded(prefix: string): boolean {
  return readdirSync(migrationsDir).some((f) => f.startsWith(`20261205000${prefix}`));
}

// ---------------------------------------------------------------------------
// Frozen vocabularies (contract 5.4, 5.5, 6.3, 7.4, 8.6, 12, 13)
// ---------------------------------------------------------------------------
export const MESSAGE_TYPES = [
  'booking_confirmed', 'payment_received', 'hotel_voucher', 'e_ticket', 'boarding_pass', 'visa_status', 'trip_reminder', 'refund_paid',
  'booking_changed',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const CHANNELS = ['email', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
/** LD5: held back 21:00-08:00 India time. */
export const QUIET_TYPES: MessageType[] = ['booking_confirmed', 'hotel_voucher', 'visa_status', 'trip_reminder', 'booking_changed'];
export const LOUD_TYPES: MessageType[] = ['payment_received', 'refund_paid', 'e_ticket', 'boarding_pass'];
/** 5.5: order of the skip checks. */
export const SKIP_ORDER = [
  'test_deal', 'not_in_pilot', 'trip_cancelled', 'change_in_progress', 'channel_off_on_deal', 'no_contact', 'opted_out', 'template_not_approved',
] as const;
export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'stopped'] as const;
export const HOLD_CODES = [
  'company_identity_missing', 'billing_not_verified', 'amount_mismatch', 'amount_zero', 'newer_version_waiting', 'receipt_not_money',
  'cancellation_open', 'change_open', 'refund_open', 'duplicate_cover', 'number_conflict',
] as const;
export const LEFT_OUT_REASONS = [
  'ledger_not_mapped', 'party_not_mapped', 'voucher_type_missing', 'already_in_file', 'kind_not_in_file', 'changed_since_file',
] as const;
export const MATCH_OUTCOMES = ['matched', 'amount_differs', 'not_found', 'already_matched', 'duplicate_in_file', 'no_tag'] as const;
export const RELEASE_A_NOTICE_KINDS = [
  'bill_held', 'write_off_to_approve', 'write_off_decided', 'message_failed', 'whatsapp_stopped', 'boarding_pass_due', 'timer_stalled',
] as const;
export const RELEASE_B_NOTICE_KINDS = [
  'change_to_approve', 'change_decided', 'reconfirm_supplier', 'change_not_possible', 'reconfirm_undo', 'removal_charges_to_enter',
  'contract_to_approve', 'contract_decided', 'contract_ending',
] as const;
/** Section 13: new refusal tokens and their SQLSTATE. */
export const TOKENS: Record<string, string> = {
  template_not_approved: '55000', push_off: '55000', push_too_many_devices: '55000', write_off_off: '55000', write_off_over_limit: '22023',
  write_off_not_balance: '22023', write_off_open_exists: '23505', tally_xml_off: '55000', nothing_to_export: '55000', rate_contracts_off: '55000',
  lines_overlap: '22023', in_use: '55000', changes_off: '55000', service_changes_off: '55000', change_open_exists: '23505',
  change_not_supported: '55000', change_outside_request: '22023', use_change_flow: '55000', change_in_progress: '55000', charges_missing: '55000',
  service_removed: '55000',
};

// ---------------------------------------------------------------------------
// Contract signatures, positional, in contract order (Release A).
// ---------------------------------------------------------------------------
export const SQL3 = {
  // A 5.1 / 5.2
  systemRule: 'select authz.system_rule($1) as r',
  writeSystemAudit: 'select authz.write_system_audit($1, $2, $3, $4, $5, $6, $7::jsonb) as r',
  timerTick: 'select public.timer_tick() as r',
  provisionTimer: 'select authz.provision_timer_job() as r',
  // A 5.3
  prefsSet: 'select public.deal_message_prefs_set($1, $2, $3::jsonb, $4) as r',
  restart: 'select public.customer_whatsapp_restart($1, $2, $3) as r',
  // A 5.5 (internal, frozen signature)
  enqueue: 'select authz.cmsg_enqueue($1, $2, $3, $4::jsonb, $5::jsonb) as r',
  // A 5.6
  voucherReady: 'select public.purchase_voucher_mark_ready($1, $2) as r',
  taskMessageStatus: 'select public.task_customer_message_status($1) as r',
  // A 5.8 / 5.9 (worker)
  eventRecord: 'select public.customer_message_event_record($1, $2, $3, $4, $5, $6) as r',
  claim: 'select public.customer_message_claim($1, $2, $3) as r',
  complete: 'select public.customer_message_complete($1, $2, $3, $4, $5) as r',
  resend: 'select public.customer_message_resend($1, $2) as r',
  setSwitch: 'select public.admin_set_customer_message_switch($1, $2, $3, $4, $5, $6) as r',
  setPilotOnly: 'select public.admin_set_customer_message_pilot($1, $2, $3) as r',
  pilotSet: 'select public.customer_message_pilot_set($1, $2, $3, $4) as r',
  setTemplate: 'select public.admin_set_whatsapp_template_status($1, $2, $3, $4) as r',
  setTimer: 'select public.admin_set_timer_enabled($1, $2) as r',
  // A 5.10
  dealMessages: 'select public.deal_customer_messages($1) as r',
  adminMessages: 'select public.admin_customer_messages($1) as r',
  // B 6.1 / 6.2
  setAutoBills: 'select public.admin_set_auto_bills($1, $2, $3, $4) as r',
  setWriteOff: 'select public.admin_set_write_off($1, $2, $3::bigint, $4) as r',
  accountsSettings: 'select public.admin_accounts_settings($1) as r',
  autoRun: 'select authz.cdoc_auto_run($1, $2) as r',
  changeOpen: 'select authz.deal_change_open($1) as r',
  // B 6.6
  woPropose: 'select public.write_off_propose($1, $2::jsonb, $3) as r',
  woDecide: 'select public.write_off_decide($1, $2, $3::bigint, $4, $5, $6) as r',
  woWithdraw: 'select public.write_off_withdraw($1, $2, $3, $4) as r',
  woUndo: 'select public.write_off_undo($1, $2, $3, $4) as r',
  // ASSUMPTION: p_filter is jsonb and p_after text, like refund_requests_list / accounts_records.
  smallBalances: 'select public.small_balances_list($1::jsonb, $2, $3) as r',
  woMonthly: 'select public.write_off_monthly($1::date) as r',
  // Phase 2 reads B replaces
  dealDocs: 'select public.deal_customer_documents($1) as r',
  docsList: 'select public.customer_documents_list($1::jsonb, $2, $3) as r',
  docRelease: 'select public.customer_document_release($1, $2, $3, $4) as r',
  docDraft: 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
  setDocs: 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r',
  dealDues: 'select public.deal_dues($1) as r',
  dailyCheck: 'select public.accounts_daily_check() as r',
  // C 7.2-7.4
  partyTallyName: 'select public.customer_party_tally_name_set($1, $2, $3, $4) as r',
  setTallyXml: 'select public.admin_set_tally_xml($1, $2, $3, $4) as r',
  fileCreate: 'select public.accounts_tally_file_create($1, $2::date, $3::date, $4::text[], $5::uuid[], $6, $7, $8) as r',
  filePreview: 'select public.accounts_tally_file_preview($1, $2::date, $3::date, $4::text[], $5::uuid[]) as r',
  exports: 'select public.accounts_tally_exports($1) as r',
  leftOut: 'select public.accounts_tally_export_left_out($1, $2, $3) as r',
  matchStage: 'select public.accounts_tally_match_stage($1, $2, $3, $4::jsonb, $5) as r',
  matchApply: 'select public.accounts_tally_match_apply($1, $2, $3) as r',
  matchCancel: 'select public.accounts_tally_match_cancel($1, $2) as r',
  matchGet: 'select public.accounts_tally_match_get($1, $2, $3, $4) as r',
  // D 8.3
  pushRegister: 'select public.push_device_register($1, $2, $3, $4, $5) as r',
  pushRemove: 'select public.push_device_remove($1, $2) as r',
  pushRemoveCurrent: 'select public.push_device_remove_current($1) as r',
  // ASSUMPTION: D3 is written `push_devices_list()` (no argument) although it says "matched by a hash of the endpoint passed in".
  pushList: 'select public.push_devices_list() as r',
  pushTest: 'select public.push_test_send($1, $2) as r',
  setPush: 'select public.admin_set_push_enabled($1, $2) as r',
  pushClaim: 'select public.push_claim($1, $2, $3) as r',
  pushComplete: 'select public.push_complete($1, $2, $3, $4) as r',
  inbox: 'select public.notice_inbox($1::bigint, $2) as r',
} as const;

/** A JSON value scanned as text (fence and leak tests). */
export const text = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Worker commands may return a jsonb array, one jsonb object, or a set of
 * rows. ASSUMPTION (contract 5.9 / 8.3 do not freeze the return form): the
 * tests accept any of the three and read a list of objects.
 */
export function asItems<T = Record<string, unknown>>(value: unknown): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['items', 'jobs', 'messages', 'claimed', 'rows']) if (Array.isArray(o[key])) return o[key] as T[];
    return [o as T];
  }
  return [];
}

export type MessageRow = {
  id: string; deal_id: string; message_type: string; channel: string; language: string; event_key: string; status: string;
  skip_reason: string | null; template_code: string | null; params: Record<string, unknown>; attachment: Record<string, unknown> | null;
  to_masked: string | null; not_before: string; next_attempt_at: string | null; attempts: number; rule: string | null; resend_of: string | null;
  provider_message_id: string | null; last_error_code: string | null; row_version: number;
};

export function acc3Helpers(getDb: () => TestDb) {
  const h = acc2cHelpers(getDb);
  const db = () => getDb();
  const { one, owner } = h;

  // -------------------------------------------------------------------------
  // Deals that may receive customer messages
  // -------------------------------------------------------------------------
  /**
   * ASSUMPTION / CONTRACT GAP (reported to the lead): 5.5 makes `test_deal`
   * (= deals.is_synthetic) the first skip check, but every fixture Deal is
   * synthetic and the finance gate refuses a non-synthetic Deal in the 'test'
   * environment. To observe a queued message the scenario is built on the
   * synthetic Deal, then — as the owner, after every finance step — the Deal
   * is relabelled as an imported Bitrix Deal (the stage0 / stage7 pattern; the
   * relabelled as an imported Bitrix Deal with full provenance (no constraint is dropped).
   */
  async function liveDeal(deal: string = DEAL, bitrixId = 990_000_000 + Math.floor(Math.random() * 9_000_000)): Promise<void> {
    // Real-stack lesson (lead, 13 Nov): never drop a constraint here — a caller may be inside a COMMITTED block. The Deal is
    // relabelled with the full provenance deals_provenance requires (a processed inbox row + every source column), the way
    // tests/supabase/b11-won-only.real.test.ts creates an imported Deal. Its synthetic commercial row (deal_commercials_synthetic_parent)
    // is removed first. Callers that commit must remove the inbox row and the Deal in their own cleanup (acc3-concurrency does).
    await resetActor(db());
    await owner('delete from public.deal_commercials where deal_id = $1', [deal]);
    const [inbox] = await owner<{ id: string }>(
      `insert into public.integration_inbox
         (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at, next_attempt_at, origin)
       values ($1::text, 'deal', 'RECONCILE', $2::bigint, extract(epoch from now())::bigint,
               authz.intake_dedupe_key($1::text, 'ACC3:' || $2::text, $2::bigint, 0::bigint), 'processed', now(), null, 'reconcile')
       returning id`, [LIVE_MEMBER, bitrixId]);
    await owner(
      `update public.deals set is_synthetic = false, source_system = 'bitrix', source_portal = $3, source_deal_id = $2,
         source_stage_id = 'C7:NEW', source_category_id = 7, source_created_at = now() - interval '1 day', source_modified_at = now() - interval '1 hour',
         last_synced_at = now(), last_verified_at = now(), source_assigned_by_id = 101, intake_inbox_id = $4 where id = $1`,
      [deal, bitrixId, LIVE_MEMBER, inbox!.id],
    );
  }
  const entityId = h.entityId;

  /** Owner SQL: the switches of `types` × `channels` On, pilot-only Off, WhatsApp templates approved. */
  async function messagesOn(types: readonly string[] = MESSAGE_TYPES, channels: readonly string[] = CHANNELS,
    opts: { pilotOnly?: boolean; templates?: boolean } = {}): Promise<void> {
    await resetActor(db());
    const entity = await entityId();
    await owner(`update public.customer_message_switches set enabled = true
      where legal_entity_id = $1 and message_type = any ($2::text[]) and channel = any ($3::text[])`, [entity, types, channels]);
    await owner('update public.customer_message_settings set pilot_only = $2 where legal_entity_id = $1', [entity, opts.pilotOnly ?? false]);
    if (opts.templates ?? true) await templates(types, 'approved');
  }
  /**
   * Owner SQL: WhatsApp template status for `types` in both languages (v1 codes of 5.7).
   * ASSUMPTION: rows may or may not be seeded per entity (5.4 does not say), so this upserts.
   */
  async function templates(types: readonly string[], status: 'not_submitted' | 'submitted' | 'approved' | 'rejected'): Promise<void> {
    await resetActor(db());
    await owner(`insert into public.whatsapp_templates (legal_entity_id, template_code, status)
      select $1, 'tn_' || t || '_' || l || '_v1', $3 from unnest($2::text[]) t cross join (values ('en'), ('hi')) x(l)
      on conflict (legal_entity_id, template_code) do update set status = excluded.status`, [await entityId(), types, status]);
  }
  /** Owner SQL: a switch Off again. */
  async function switchOff(type: string, channel: string): Promise<void> {
    await resetActor(db());
    await owner('update public.customer_message_switches set enabled = false where legal_entity_id = $1 and message_type = $2 and channel = $3',
      [await entityId(), type, channel]);
  }
  /** authz.cmsg_enqueue as the owner (the definer function the triggers and tracks G / H call). */
  async function enqueue(deal: string, type: string, eventKey: string, params: Record<string, unknown> = {}, attachment: unknown = null) {
    await resetActor(db());
    const [row] = await owner<{ r: number }>(SQL3.enqueue, [deal, type, eventKey, JSON.stringify(params),
      attachment === null ? null : JSON.stringify(attachment)]);
    return row!.r;
  }
  const messages = (deal: string = DEAL, type?: string) => owner<MessageRow>(
    `select id, deal_id, message_type, channel, language, event_key, status, skip_reason, template_code, params, attachment, to_masked,
            not_before::text, next_attempt_at::text, attempts, rule, resend_of, provider_message_id, last_error_code, row_version
     from public.customer_messages where deal_id = $1 and ($2::text is null or message_type = $2) order by created_at, channel, id`,
    [deal, type ?? null]);
  const messageRow = async (id: string) => (await owner<MessageRow>(
    `select id, deal_id, message_type, channel, language, event_key, status, skip_reason, template_code, params, attachment, to_masked,
            not_before::text, next_attempt_at::text, attempts, rule, resend_of, provider_message_id, last_error_code, row_version
     from public.customer_messages where id = $1`, [id]))[0]!;
  /** Make every queued row due now (owner SQL; the guard leaves the schedule columns mutable). */
  async function dueNow(): Promise<void> {
    await resetActor(db());
    await owner(`update public.customer_messages set not_before = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
      where status in ('queued', 'sending')`);
  }
  async function msgClaim(limit = 25, worker = 'acc3-test', lease = 60) {
    return asItems<Record<string, unknown> & { id: string; to?: string; channel: string }>(await one(WORKER, SQL3.claim, [worker, limit, lease]));
  }
  const msgComplete = (id: string, ok: boolean, providerId: string | null = null, error: string | null = null, worker = 'acc3-test') =>
    one<Record<string, unknown>>(WORKER, SQL3.complete, [id, worker, ok, providerId, error]);
  const alerts = (table: 'customer_message_alerts' | 'timer_alerts' | 'flight_boarding_pass_alerts') =>
    owner<Record<string, unknown>>(`select * from public.${table} order by 1`);

  /** Deal message preferences row (lazily created). */
  const prefsRow = async (deal: string = DEAL) =>
    (await owner<Record<string, unknown> & { row_version: number }>('select * from public.deal_message_prefs where deal_id = $1', [deal]))[0];
  const prefsSet = async (fields: Record<string, unknown>, actor: Actor = OWNER, deal: string = DEAL) =>
    one<Record<string, unknown>>(actor, SQL3.prefsSet, [deal, (await prefsRow(deal))?.row_version ?? 0, JSON.stringify(fields), rid()]);

  // -------------------------------------------------------------------------
  // Accounts settings (B, C) and documents
  // -------------------------------------------------------------------------
  const docsOn = async (on = true) => one(SUPER, SQL3.setDocs, [await entityId(), on, REASON]);
  const autoBills = async (drafts: boolean, release: boolean) => one(SUPER, SQL3.setAutoBills, [await entityId(), drafts, release, REASON]);
  const writeOffOn = async (on = true, limit = '500000') => one(SUPER, SQL3.setWriteOff, [await entityId(), on, limit, REASON]);
  const tallyXmlOn = async (on = true, company = 'Holiday Chacha Copy Co') => one(SUPER, SQL3.setTallyXml, [await entityId(), on, company, REASON]);
  type DocRow = { id: string; kind: string; status: string; number: string | null; seq: number | null; receipt_id: string | null;
    basis_version_id: string | null; refund_request_id: string | null; replaces_document_id: string | null; total_paise: string;
    auto_rule: string | null; auto_state: string | null; hold_reasons: string[]; release_rule: string | null; created_by: string | null;
    released_by: string | null };
  const documents = (deal: string = DEAL) => owner<DocRow>(
    `select id, kind, status, number, seq, receipt_id, basis_version_id, refund_request_id, replaces_document_id, total_paise::text, auto_rule,
            auto_state, hold_reasons, release_rule, created_by, released_by
     from public.customer_documents where deal_id = $1 order by created_at, id`, [deal]);
  const renderJobs = (docId: string) => owner<{ id: string; requested_by: string | null; status: string }>(
    'select id, requested_by, status from public.customer_document_render_jobs where document_id = $1', [docId]);
  const pending = () => owner<{ deal_id: string; reason_code: string }>('select deal_id, reason_code from public.cdoc_auto_pending order by created_at');

  /** Approved hotel booking (real Accounts approval: billing verified) on `deal`; ACC2 second Accounts person. */
  async function approvedBooking(deal: string = DEAL, opts: { selling?: string; items?: Item[] } = {}) {
    await h.people();
    const b = await h.book(opts.items ?? [HOTEL_ITEM], { deal, ...(opts.selling ? { selling: opts.selling } : {}) });
    await h.approveReal(b.versionId, deal);
    return b;
  }

  /** System audit rows of `action` (details carry by: 'crm' and the rule). */
  const audits = (action: string) => h.audits(action);
  /** Every audit row written since `afterId` (fence and leak scans). */
  const auditsSince = (afterId: number) =>
    owner<{ id: number; action: string; details: unknown; reason: string | null }>('select id, action, details, reason from public.audit_events where id > $1 order by id', [afterId]);
  const lastAuditId = async () => Number((await owner<{ m: string | null }>('select max(id)::text as m from public.audit_events'))[0]!.m ?? 0);

  /** The function exists in the database (a track has landed). */
  const fnExists = async (qualified: string) =>
    (await owner<{ ok: boolean }>('select to_regprocedure($1) is not null as ok', [qualified]))[0]!.ok;
  /** EXECUTE privilege of a role on a function given by regprocedure text. */
  const canExecute = async (role: string, signature: string) =>
    (await owner<{ ok: boolean }>('select has_function_privilege($1, $2, \'execute\') as ok', [role, signature]))[0]!.ok;
  /** Functions named `name` in schema `schema` (any argument list), as regprocedure text. */
  const signatures = async (schema: string, name: string) =>
    (await owner<{ sig: string }>(`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = $1 and p.proname = $2`, [schema, name])).map((r) => r.sig);

  function expectNoAmountIn(value: unknown, amounts: string[], label: string): void {
    const t = text(value);
    for (const a of amounts) expect(t, `${label}: ${a}`).not.toMatch(new RegExp(`(?<![0-9])${a}(?![0-9])`));
  }

  return {
    ...h, liveDeal, messagesOn, templates, switchOff, enqueue, messages, messageRow, dueNow, msgClaim, msgComplete, alerts, prefsRow, prefsSet, docsOn,
    autoBills, writeOffOn, tallyXmlOn, documents, renderJobs, pending, approvedBooking, audits, auditsSince, lastAuditId, fnExists, canExecute,
    signatures, expectNoAmountIn, MANAGER, ACC, ACC2, PURCHASE,
  };
}
