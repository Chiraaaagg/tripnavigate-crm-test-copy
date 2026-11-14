import { spawn } from 'node:child_process';
import { createECDH, createHash, randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { join } from 'node:path';
import { type BrowserContext, type Page, expect } from '@playwright/test';
import { db } from './acc-real-support';
import {
  FLIGHT, HOTEL, SELLING, USERS, type UserKey, VISA, activateFixturePeople, approveBooking, asUser, configured, confirmedBooking, entityId, freshDeal,
  istToday, mobile, noServiceWorker, outbound, prepareUsers, putObject, q, releaseDoc, renderCustomerOnce, restoreFixturePeople,
  restoreSwitches as restorePhase2Switches, saveSwitches as savePhase2Switches, session, sha, signIn, stamp, supabaseUrl,
  switchesOn as phase2SwitchesOn, ticketBatch, verifiedCash,
} from './acc2-real-support';

/**
 * Accounts Phase 3 (contract accounts-phase3-2026-11-12, test plan 16.4),
 * Track T: shared steps of the real journeys tests/e2e/acc3-*.real.e2e.ts
 * (disposable local stack, production build, providers are LOCAL test
 * doubles, the timer is driven by scripts/timer-tick.mjs). Written from the
 * contract, not from the tracks' code; builds on the Phase 2 journey helpers
 * (acc2-real-support.ts: E2E users, synthetic Deals, bookings, money).
 *
 * Every switch a journey changes is saved first and restored in teardown
 * through the audited setter commands (restoreSwitches3). Set-up steps are
 * SYNTHETIC FIXTURE STEPS through the database commands the screens call;
 * the Phase 3 screens are driven in the browser where the contract freezes
 * their words (section 15: "Send again", "Restart", "Made by the CRM",
 * "Ready for customer", "Make Tally file", "Upload Tally vouchers", "Alerts on
 * this device", "Send a test alert", "Differs from contract", "Send change",
 * "Supplier refused" …).
 *
 * Provider doubles: one local HTTP server (PROVIDER_DOUBLE_PORT, default
 * 3297) records every request at /resend, /interakt and /push and answers
 * like the provider. ASSUMPTION (contract 5.7 / 8.4 name no override): the
 * production build and scripts/timer-tick.mjs are started with
 *   RESEND_API_URL=http://127.0.0.1:3297/resend
 *   INTERAKT_API_URL=http://127.0.0.1:3297/interakt
 *   PUSH_SENDER_URL=http://127.0.0.1:3297/push   (the test push sender of track D)
 * and dummy RESEND_API_KEY / INTERAKT_API_KEY / VAPID keys / TIMER_SECRET. The
 * names live only in DOUBLE_ENV below so the lead can align them with tracks
 * A and D.
 *
 * CONTRACT GAP (reported to the lead): message journeys need a non-synthetic
 * pilot Deal or a lead fixture — 5.5's first skip check is `test_deal`
 * (deals.is_synthetic) and every Deal on the disposable stack is synthetic,
 * while the finance gate refuses a non-synthetic Deal in the 'test'
 * environment. The journeys are written to the contract (the pilot Deal's
 * messages are queued and sent); until the lead settles the fixture they fail
 * at the first "queued" assertion.
 */

export {
  FLIGHT, HOTEL, SELLING, USERS, VISA, activateFixturePeople, approveBooking, asUser, configured, confirmedBooking, entityId, freshDeal, istToday, mobile,
  noServiceWorker, outbound, prepareUsers, putObject, q, releaseDoc, renderCustomerOnce, restoreFixturePeople, session, sha, signIn, stamp, supabaseUrl,
  ticketBatch, verifiedCash, type UserKey,
};

export const SUPER = 'a0000000-0000-4000-8000-000000000007';
export const REASON = 'Synthetic: Accounts phase 3 real journey (local stack)';
export const DONE = 'Synthetic: Accounts phase 3 real journey finished (local stack)';
export const DOUBLE_PORT = Number(process.env.PROVIDER_DOUBLE_PORT ?? 3297);
export const DOUBLE_URL = `http://127.0.0.1:${DOUBLE_PORT}`;
/** Fake push-service host of the stubbed browser subscription (never resolved: the harness routes it to the double). */
export const PUSH_HOST = 'push.acc3.test';

/*
 * PROVIDER HARNESS (replaces the earlier ASSUMPTION of RESEND_API_URL / INTERAKT_API_URL / PUSH_SENDER_URL: the
 * adapters have fixed endpoints — src/lib/email/customer-email.ts RESEND_ENDPOINT, src/lib/whatsapp/interakt.ts
 * INTERAKT_ENDPOINT — and web-push posts encrypted bodies to the subscription endpoint). A Node preload (HARNESS_JS,
 * loaded with --import) is put in front of every process that may send:
 *   - fetch to api.resend.com / api.interakt.ai → the local double (/resend, /interakt);
 *   - fetch to the fake push host → the double (/push);
 *   - fetch to any other non-loopback host → refused before it leaves (ECONNREFUSED), so nothing reaches the network;
 *   - web-push sendNotification → a plain JSON POST of the payload to the (rerouted) endpoint, so the double can
 *     read {title, body, tag, url}. Payload encryption is web-push's own and is not under test here.
 * timer-tick.mjs children get it from timerTick(). The production server (next start) is started by Playwright
 * BEFORE any test file loads, so it gets the same preload and dummy keys only from the calling shell:
 *   source acc3-harness-env.sh   (the lines of harnessShellEnv(); sets ACC3_PROVIDER_HARNESS=1)
 * Steps that need the server itself to send or to know the VAPID key call needHarness() and fail with that hint.
 * Keys are dummies; the VAPID pair is derived from a fixed synthetic seed (local test doubles only).
 */
export const HARNESS_JS = String.raw`
import { createRequire } from 'node:module';
const D = process.env.ACC3_DOUBLE_URL || 'http://127.0.0.1:3297';
const LOOP = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
const target = (u) => {
  let url;
  try { url = new URL(u); } catch { return u; }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') return u;
  if (url.hostname === 'api.resend.com') return D + '/resend' + url.pathname;
  if (url.hostname === 'api.interakt.ai') return D + '/interakt' + url.pathname;
  if (url.hostname === 'push.acc3.test') return D + '/push' + url.pathname;
  return LOOP.has(url.hostname) ? u : null;
};
if (realFetch) {
  globalThis.fetch = function acc3HarnessFetch(input, init) {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const t = target(u);
    if (t === null) {
      const e = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('acc3 harness: outbound request refused'), { code: 'ECONNREFUSED' });
      return Promise.reject(e);
    }
    return t === u ? realFetch(input, init) : realFetch(t, init);
  };
}
try {
  const wp = createRequire(process.cwd() + '/package.json')('web-push');
  wp.sendNotification = async (sub, payload, opts) => {
    const r = await globalThis.fetch(sub.endpoint, { method: 'POST', body: payload == null ? '' : String(payload),
      headers: { 'content-type': 'application/json', urgency: (opts && opts.urgency) || 'normal', ttl: String((opts && opts.TTL) || 0) } });
    if (r.status >= 200 && r.status < 300) return { statusCode: r.status, body: '', headers: {} };
    throw new wp.WebPushError('Received unexpected response code', r.status, {}, '', sub.endpoint);
  };
} catch {}
globalThis.__acc3Harness = true;
`;
const vapidPair = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(createHash('sha256').update('tripnavigate-acc3-local-double-vapid').digest());
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
};
/** The environment of a process behind the harness (timer-tick children; the same values the shell script gives the server). */
export function harnessEnv(): Record<string, string> {
  const v = vapidPair();
  return {
    ACC3_PROVIDER_HARNESS: '1',
    ACC3_DOUBLE_URL: DOUBLE_URL,
    RESEND_API_KEY: 're_acc3_local_double_not_a_key',
    INTERAKT_API_KEY: 'acc3_local_double_not_a_key',
    VAPID_SUBJECT: 'mailto:acc3-local@example.test',
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: v.publicKey,
    VAPID_PRIVATE_KEY: v.privateKey,
    NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(HARNESS_JS).toString('base64')}`,
  };
}
/** Shell lines for the calling shell (the production server is started before any test file loads). */
export const harnessShellEnv = () => Object.entries(harnessEnv()).map(([k, v]) => `export ${k}='${v}'`).join('\n');
/** True when the calling shell (and so the production server) runs behind the harness. */
export const providerHarness = process.env.ACC3_PROVIDER_HARNESS === '1';
export const needHarness = () => expect(providerHarness,
  'the production server must run behind the provider harness: source acc3-harness-env.sh before the run (acc3-real-support.ts)').toBe(true);
export const DOUBLE_ENV: Record<string, string> = harnessEnv();
// ASSUMPTION: preview-independent app routes of section 15 that the contract does not print.
export const ROUTES = {
  deal: (id: string, tab?: string) => `/app/deals/${id}${tab ? `?tab=${tab}` : ''}`,
  accountsDeal: (id: string, tab = 'documents') => `/app/accounts/deals/${id}?tab=${tab}`,
  billsToCheck: '/app/accounts/documents?preset=toCheck',
  smallBalances: '/app/accounts/small-balances',
  tally: '/app/accounts/tally',
  approvals: '/app/approvals',
  rateContracts: '/app/purchase/rate-contracts',
  purchaseTask: (id: string, tab = 'work') => `/app/purchase/${id}?tab=${tab}`,
  flightTask: (dealId: string) => `/app/flight/deals/${dealId}`,
  settingsMessages: '/app/settings/customer-messages',
  bellSettings: '/app/settings/notifications',
} as const;

export const MESSAGE_TYPES = ['booking_confirmed', 'payment_received', 'hotel_voucher', 'e_ticket', 'boarding_pass', 'visa_status', 'trip_reminder',
  'refund_paid', 'booking_changed'] as const;

// ---------------------------------------------------------------- provider doubles
export type DoubleRequest = { provider: 'resend' | 'interakt' | 'push'; path: string; headers: Record<string, string>; body: string; at: number };
const recorded: DoubleRequest[] = [];
const failures: Record<string, number> = { resend: 0, interakt: 0, push: 0 };
let server: Server | null = null;
const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let s = '';
  req.on('data', (d) => { s += String(d); });
  req.on('end', () => resolve(s));
});
/** Starts the local provider double (idempotent). */
export async function startDoubles(): Promise<void> {
  if (server) return;
  server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const provider = path.startsWith('/resend') ? 'resend' : path.startsWith('/interakt') ? 'interakt' : path.startsWith('/push') ? 'push' : null;
    const body = await readBody(req);
    if (!provider) { res.writeHead(404).end(); return; }
    recorded.push({ provider, path, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body, at: Date.now() });
    if (failures[provider]! > 0) {
      failures[provider]! -= 1;
      res.writeHead(provider === 'push' ? 500 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'synthetic failure' }));
      return;
    }
    // Unique across runs: provider message ids are unique per provider in customer_messages (a reused id makes complete fail).
    const id = randomUUID();
    // Resend: {id}; Interakt: {result: true, id}; push service: 201 Created.
    if (provider === 'push') res.writeHead(201).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(provider === 'resend' ? { id } : { result: true, message: 'ok', id }));
  });
  await new Promise<void>((resolve) => server!.listen(DOUBLE_PORT, '127.0.0.1', resolve));
}
export async function stopDoubles(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}
export const doubleRequests = (provider?: DoubleRequest['provider']) => recorded.filter((r) => !provider || r.provider === provider);
/** The next `n` requests to `provider` fail (5xx). */
export const failNext = (provider: DoubleRequest['provider'], n = 1) => { failures[provider] = n; };

// ---------------------------------------------------------------- timer
/** Runs scripts/timer-tick.mjs once against the stack (track A; 5.2). Returns its JSON output lines. */
export async function timerTick(): Promise<Array<Record<string, unknown>>> {
  const crm = join(import.meta.dirname, '..', '..');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(crm, 'scripts', 'timer-tick.mjs')], {
      cwd: crm,
      env: { ...process.env, ...DOUBLE_ENV, APP_ENV: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`timer-tick exit ${code}: ${err.slice(0, 400)}`));
      else resolve(out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l }; } }));
    });
  });
}
/** Ticks until `check` is true or `timeoutMs` passes. */
export async function tickUntil(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await timerTick();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(await check(), 'condition reached by the timer').toBe(true);
}

// ---------------------------------------------------------------- switches (17.2)
type Saved3 = { accounts?: Record<string, unknown> | null; push?: boolean; rate?: boolean; changes?: Record<string, unknown> | null; timer?: boolean;
  pilotOnly?: boolean; switches?: Array<{ message_type: string; channel: string; enabled: boolean }>; templates?: Array<{ template_code: string; status: string }>;
  pilot?: string[] };
const saved3: Saved3 = {};
/** Saves the Phase 2 and Phase 3 switches (beforeAll, before any change). */
export async function saveSwitches3(): Promise<void> {
  await savePhase2Switches();
  const e = await entityId();
  saved3.accounts = (await q<Record<string, unknown>>(`select auto_bills_enabled, auto_bill_release_enabled, write_off_enabled, write_off_limit_paise::text,
    tally_xml_enabled, tally_company_name from public.accounts_settings where legal_entity_id = $1`, [e]))[0] ?? null;
  saved3.push = (await q<{ p: boolean }>('select push_enabled as p from public.notice_settings where id'))[0]?.p;
  saved3.rate = (await q<{ r: boolean }>('select rate_contracts_enabled as r from public.procurement_settings limit 1'))[0]?.r;
  saved3.changes = (await q<Record<string, unknown>>('select changes_enabled, service_changes_enabled from public.booking_change_settings limit 1'))[0] ?? null;
  saved3.timer = (await q<{ t: boolean }>('select enabled as t from public.timer_settings limit 1'))[0]?.t;
  saved3.pilotOnly = (await q<{ p: boolean }>('select pilot_only as p from public.customer_message_settings where legal_entity_id = $1', [e]))[0]?.p;
  saved3.switches = await q('select message_type, channel, enabled from public.customer_message_switches where legal_entity_id = $1', [e]);
  saved3.templates = await q('select template_code, status from public.whatsapp_templates where legal_entity_id = $1', [e]);
  saved3.pilot = (await q<{ d: string }>('select deal_id as d from public.customer_message_pilot where legal_entity_id = $1 and removed_at is null', [e]))
    .map((r) => r.d);
}
/** Phase 2 switches on (documents, refunds, Tally CSV, notices) plus the Phase 3 switches the journeys need, through the audited setters. */
export async function switchesOn3(opts: { autoBills?: boolean; release?: boolean; writeOff?: boolean; tallyXml?: boolean; push?: boolean;
  rateContracts?: boolean; changes?: boolean; serviceChanges?: boolean; timer?: boolean } = {}): Promise<void> {
  await phase2SwitchesOn();
  const e = await entityId();
  if (opts.autoBills) await asUser(SUPER, 'select public.admin_set_auto_bills($1, $2, $3, $4) as r', [e, true, opts.release ?? true, REASON]);
  if (opts.writeOff) await asUser(SUPER, 'select public.admin_set_write_off($1, $2, $3::bigint, $4) as r', [e, true, '500000', REASON]);
  if (opts.tallyXml) await asUser(SUPER, 'select public.admin_set_tally_xml($1, $2, $3, $4) as r', [e, true, 'Synthetic Copy Company', REASON]);
  if (opts.push) await asUser(SUPER, 'select public.admin_set_push_enabled($1, $2) as r', [true, REASON]);
  if (opts.rateContracts) await asUser(SUPER, 'select public.admin_set_rate_contracts_enabled($1, $2) as r', [true, REASON]);
  if (opts.changes) await asUser(SUPER, 'select public.admin_set_booking_changes_enabled($1, $2) as r', [true, REASON]);
  if (opts.serviceChanges) await asUser(SUPER, 'select public.admin_set_service_changes_enabled($1, $2) as r', [true, REASON]);
  if (opts.timer) await asUser(SUPER, 'select public.admin_set_timer_enabled($1, $2) as r', [true, REASON]);
}
/** Every message type × channel On, templates approved (SA, audited); pilot mode stays On, `pilotDeals` added to the pilot list. */
export async function messagesOn(pilotDeals: string[], channels: Array<'email' | 'whatsapp'> = ['email', 'whatsapp']): Promise<void> {
  const e = await entityId();
  for (const t of MESSAGE_TYPES) for (const lang of ['en', 'hi']) {
    await asUser(SUPER, 'select public.admin_set_whatsapp_template_status($1, $2, $3, $4) as r', [e, `tn_${t}_${lang}_v1`, 'approved', REASON]);
  }
  for (const t of MESSAGE_TYPES) for (const ch of channels) {
    const rv = (await q<{ v: number }>('select row_version as v from public.customer_message_switches where legal_entity_id = $1 and message_type = $2 and channel = $3',
      [e, t, ch]))[0]!.v;
    await asUser(SUPER, 'select public.admin_set_customer_message_switch($1, $2, $3, $4, $5, $6) as r', [e, t, ch, true, REASON, rv]);
  }
  for (const d of pilotDeals) await asUser(SUPER, 'select public.customer_message_pilot_set($1, $2, $3, $4) as r', [e, d, true, REASON]);
}
/** Puts every saved switch back (teardown). */
export async function restoreSwitches3(): Promise<void> {
  const e = await entityId();
  const a = saved3.accounts;
  const x = (sql: string, params: unknown[]) => asUser(SUPER, sql, params).catch(() => undefined);
  await x('select public.admin_set_auto_bills($1, $2, $3, $4) as r', [e, Boolean(a?.auto_bills_enabled), a?.auto_bill_release_enabled ?? true, DONE]);
  await x('select public.admin_set_write_off($1, $2, $3::bigint, $4) as r', [e, Boolean(a?.write_off_enabled), a?.write_off_limit_paise ?? '500000', DONE]);
  await x('select public.admin_set_tally_xml($1, $2, $3, $4) as r', [e, Boolean(a?.tally_xml_enabled), a?.tally_company_name ?? null, DONE]);
  await x('select public.admin_set_push_enabled($1, $2) as r', [Boolean(saved3.push), DONE]);
  await x('select public.admin_set_rate_contracts_enabled($1, $2) as r', [Boolean(saved3.rate), DONE]);
  await x('select public.admin_set_booking_changes_enabled($1, $2) as r', [Boolean(saved3.changes?.changes_enabled), DONE]);
  await x('select public.admin_set_service_changes_enabled($1, $2) as r', [Boolean(saved3.changes?.service_changes_enabled), DONE]);
  await x('select public.admin_set_timer_enabled($1, $2) as r', [Boolean(saved3.timer), DONE]);
  if (saved3.pilotOnly !== undefined) await x('select public.admin_set_customer_message_pilot($1, $2, $3) as r', [e, saved3.pilotOnly, DONE]);
  for (const s of saved3.switches ?? []) {
    const rv = (await q<{ v: number; on: boolean }>('select row_version as v, enabled as on from public.customer_message_switches where legal_entity_id = $1 and message_type = $2 and channel = $3',
      [e, s.message_type, s.channel]))[0];
    if (rv && rv.on !== s.enabled) await x('select public.admin_set_customer_message_switch($1, $2, $3, $4, $5, $6) as r', [e, s.message_type, s.channel, s.enabled, DONE, rv.v]);
  }
  for (const t of saved3.templates ?? []) await x('select public.admin_set_whatsapp_template_status($1, $2, $3, $4) as r', [e, t.template_code, t.status, DONE]);
  const nowPilot = (await q<{ d: string }>('select deal_id as d from public.customer_message_pilot where legal_entity_id = $1 and removed_at is null', [e])).map((r) => r.d);
  for (const d of nowPilot.filter((d) => !(saved3.pilot ?? []).includes(d))) await x('select public.customer_message_pilot_set($1, $2, $3, $4) as r', [e, d, false, DONE]);
  await restorePhase2Switches();
}

// ---------------------------------------------------------------- reads used by several journeys
export type MessageRow = { id: string; message_type: string; channel: string; language: string; status: string; skip_reason: string | null;
  event_key: string; template_code: string; params: Record<string, unknown>; attempts: number; last_error_code: string | null; resend_of: string | null };
export const messagesOf = (dealId: string, type?: string) => q<MessageRow>(
  `select id, message_type, channel, language, status, skip_reason, event_key, template_code, params, attempts, last_error_code, resend_of
   from public.customer_messages where deal_id = $1 and ($2::text is null or message_type = $2) order by created_at, channel`, [dealId, type ?? null]);
export const documentsOf = (dealId: string) => q<{ id: string; kind: string; status: string; number: string | null; auto_rule: string | null;
  auto_state: string | null; hold_reasons: string[]; release_rule: string | null; created_by: string | null; released_by: string | null }>(
  `select id, kind, status, number, auto_rule, auto_state, hold_reasons, release_rule, created_by, released_by
   from public.customer_documents where deal_id = $1 order by created_at, id`, [dealId]);
export const noticesOf = (kind: string, dealId?: string) => q<{ recipient_user_id: string; priority: string; params: Record<string, unknown> }>(
  `select recipient_user_id, priority, params from public.staff_notices where kind = $1 and ($2::uuid is null or deal_id = $2) order by seq`,
  [kind, dealId ?? null]);
/** Approved hotel booking with verified billing on a fresh synthetic Deal (fixture steps). */
export async function approvedDeal(prefix: string, slot: number, items: Array<[string, unknown]> = [['hotel', HOTEL]]) {
  const id = await freshDeal(`${prefix}-${stamp}-${slot}`);
  const v = await confirmedBooking(id, items, slot);
  await approveBooking(id, v.versionId);
  return { dealId: id, versionId: v.versionId, itemIds: v.itemIds, reference: `${prefix}-${stamp}-${slot}` };
}
/** Purchase path on the Deal's hotel task up to supplier confirmation (fixture steps; returns task, supplier and quote). */
export async function supplierConfirmedHotel(dealId: string, costPaise = '300000') {
  const [task] = await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase' order by created_at limit 1`, [dealId]);
  const e = await entityId();
  const { supplierId } = await asUser<{ supplierId: string }>(USERS.purchase.id, 'select public.supplier_create($1, $2::jsonb) as r', [e, JSON.stringify({
    name: `E2E Acc3 Stays ${stamp}-${randomUUID().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null,
    contactEmail: 'desk@example.test', paymentTerms: null, supplierKind: 'direct' })]);
  await asUser(USERS.purchase.id, 'select public.purchase_task_claim($1) as r', [task!.id]);
  const { quoteId } = await asUser<{ quoteId: string }>(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task!.id, randomUUID(),
    JSON.stringify({ supplierId, hotelName: 'Synthetic Hotel (e2e)', roomType: null, mealPlan: null, quotedCostPaise: costPaise, holdUntil: null,
      cancellationTerms: null })]);
  await asUser(USERS.purchase.id, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [task!.id, quoteId, 0, costPaise, null,
    null, randomUUID()]);
  await asUser(USERS.purchase.id, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
    [task!.id, 1, 'desk@example.test', [], 'Booking request · SYN · Synthetic', 'Synthetic body.', randomUUID()]);
  const [g] = await q<{ id: string; row_version: number }>(`select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`,
    [task!.id]);
  await asUser(USERS.accA.id, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [g!.id, 'approve', null, g!.row_version, randomUUID()]);
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(USERS.purchase.id, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
    [task!.id, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, sha()]);
  await putObject('purchase-evidence', ev.objectPath);
  await asUser(USERS.purchase.id, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
  await asUser(USERS.purchase.id, 'select public.purchase_supplier_confirm($1, $2, $3) as r', [task!.id, 1, `SYN-CONF-${stamp}`]);
  return { taskId: task!.id, supplierId, quoteId };
}
/** Stored file of `kind` on a Purchase task (purchase evidence). */
export async function purchaseFile(taskId: string, kind: string): Promise<string> {
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(USERS.purchase.id, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
    [taskId, kind, `${kind}.pdf`, 'application/pdf', 2048, sha()]);
  await putObject('purchase-evidence', ev.objectPath);
  await asUser(USERS.purchase.id, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
  return ev.evidenceId;
}
/** Stored department file of `kind` on a task (Flight / Visa evidence). */
export async function departmentFile(userId: string, taskId: string, kind: string): Promise<string> {
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(userId, 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
    [taskId, null, kind, `${kind}.pdf`, 'application/pdf', 2048, sha()]);
  await putObject('department-evidence', ev.objectPath);
  await asUser(userId, 'select public.department_evidence_finish($1, $2) as r', [ev.evidenceId, true]);
  return ev.evidenceId;
}

// ---------------------------------------------------------------- browser side of alerts (8.4)
/**
 * Stubs Notification and PushManager.subscribe in a context: the real service worker registers from /sw.js (same origin),
 * the subscription points at the local double. ASSUMPTION: the double endpoint is accepted by D1 in the local build
 * (8.1 asks for https endpoints; the local double serves http).
 */
export async function stubPush(ctx: BrowserContext, endpoint: string, permission: 'granted' | 'denied' = 'granted'): Promise<void> {
  await ctx.addInitScript(([perm, ep]) => {
    const w = window as unknown as { __subscribes: number; Notification: unknown };
    w.__subscribes = 0;
    class FakeNotification {
      static permission = perm;
      static async requestPermission() { return perm; }
      close() {}
    }
    w.Notification = FakeNotification;
    const key = (n: number) => new Uint8Array(n).fill(7).buffer;
    // The subscription survives page loads like a real one (localStorage flag); unsubscribe ends it.
    const KEY = '__acc3_push_subscribed';
    const subscribed = () => { try { return localStorage.getItem(KEY) === ep; } catch { return w.__subscribes > 0; } };
    const sub = { endpoint: ep, expirationTime: null, options: { userVisibleOnly: true },
      getKey: (name: string) => (name === 'p256dh' ? key(65) : key(16)),
      toJSON: () => ({ endpoint: ep, keys: { p256dh: 'BPerfSyntheticP256dhKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', auth: 'c3ludGhldGljLWF1dGg' } }),
      unsubscribe: async () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } w.__subscribes = 0; return true; } };
    const proto = (globalThis as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager?.prototype;
    if (proto) {
      proto.subscribe = async () => { w.__subscribes += 1; try { localStorage.setItem(KEY, ep); } catch { /* ignore */ } return sub; };
      proto.getSubscription = async () => (subscribed() ? sub : null);
      proto.permissionState = async () => perm;
    }
  }, [permission, endpoint] as const);
}
/** Bell › "Sound, pop-up and alert settings" (screen 15.8: "Alerts on this device" lives in the bell's settings view). */
export async function openAlertSettings(page: Page, path = '/app'): Promise<void> {
  // Always a fresh navigation: init scripts (stubPush) apply only to documents loaded after they were added.
  await page.goto(path);
  await page.getByRole('button', { name: /^Notices:/ }).first().click();
  await page.getByRole('button', { name: 'Sound, pop-up and alert settings' }).click();
  await expect(page.getByRole('heading', { name: /^Alerts on this device:/ })).toBeVisible();
}
export const serviceWorkers = (page: Page) =>
  page.evaluate(async () => ('serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.active?.scriptURL ?? r.installing?.scriptURL ?? '') : []));

/** Request log: every request of the page whose host is not the app, the local Supabase or the provider double (16.4 item 9). */
export function allowedOutbound(): string[] {
  const allowed = new Set([new URL(supabaseUrl!).host, new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3100').host, `127.0.0.1:${DOUBLE_PORT}`]);
  return outbound.filter((u) => !allowed.has(new URL(u).host));
}

/** A scan for sentinel values that must never leave the database in a notice, push body or audit row. */
export function leaks(text: string, sentinels: string[]): string[] {
  return sentinels.filter((s) => new RegExp(`(?<![0-9A-Za-z])${s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9A-Za-z])`).test(text));
}

// ---------------------------------------------------------------- bookings with a chosen trip (reminders, write-off)
const dayFromToday = (days: number) => new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
export { dayFromToday };
/**
 * Confirmed booking (Sales) with the trip and hotel stay on the given dates — the Phase 2 helper fixes the trip in
 * December 2026; reminders (D-3, D-1) and write-offs (trip ended) need other dates. Same steps as confirmedBooking.
 */
export async function bookingWithTrip(dealId: string, startDays: number, endDays: number, slot: number,
  opts: { items?: Array<[string, unknown]>; email?: string | null; selling?: string; budget?: string } = {}) {
  const S = USERS.sales.id;
  const start = dayFromToday(startDays);
  const end = dayFromToday(endDays);
  const hotel = { ...HOTEL, checkIn: start, checkOut: end };
  const items = opts.items ?? [['hotel', hotel]];
  const selling = opts.selling ?? SELLING;
  const opened = await asUser<{ versionId: string; rowVersion: number }>(S, 'select public.booking_open_draft($1) as r', [dealId]);
  let rv = opened.rowVersion;
  const itemIds: string[] = [];
  for (const [type, facts] of items) {
    const added = await asUser<{ rowVersion: number; itemId: string }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
      [opened.versionId, rv, type, JSON.stringify(facts), opts.budget ?? '99999999', randomUUID()]);
    rv = added.rowVersion;
    itemIds.push(added.itemId);
  }
  const travellers = [{ fullName: 'Synthetic Acc3 One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Acc3 Two', type: 'adult', seq: 2 }];
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [dealId, rv, JSON.stringify(travellers)])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [opened.versionId, rv,
    JSON.stringify({ hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null,
      inclusions: null, specialRequests: null, purchaseBudgetPaise: null }), selling])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify({ destination: 'Synthetic City, Rajasthan', scope: 'domestic', start, end })])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [opened.versionId, rv,
    JSON.stringify({ contactName: 'Synthetic Contact', mobile: mobile(slot), email: opts.email === undefined ? `e2e.acc3.contact.${slot}@example.test` : opts.email,
      contactConfirmed: true, bookingFor: 'individual', payerDifferent: false, payerName: null }), JSON.stringify({ billingName: 'Synthetic Billing',
      addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }), 0, randomUUID()])).rowVersion;
  for (const itemId of itemIds) {
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
      [itemId, opened.versionId, rv, [1, 2]])).rowVersion;
  }
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: selling, dueDate: dayFromToday(Math.min(startDays, 0)) }])])).rowVersion;
  if (items.some(([type]) => type === 'visa')) {
    for (const seq of [1, 2]) {
      await asUser(S, 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r', [dealId, seq, 0, JSON.stringify({ dateOfBirth: '1990-05-17',
        nationality: 'Indian', passportNumber: `Z${7300000 + slot * 10 + seq}`, passportExpiry: '2030-01-31' })]);
    }
  }
  for (const seq of [1, 2]) {
    const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
      [dealId, seq, randomUUID(), `id-${seq}.pdf`, 'application/pdf', 2048, sha()]);
    await putObject('traveller-id-proofs', begun.objectPath);
    await asUser(S, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
  }
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [opened.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, sha()]);
  await putObject('booking-evidence', ev.objectPath);
  await asUser(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
  const r = await asUser<{ issues: string[]; contentHash: string }>(S, 'select public.booking_readiness($1) as r', [opened.versionId]);
  expect(r.issues).toEqual([]);
  await asUser(S, 'select public.booking_confirm($1, $2) as r', [opened.versionId, r.contentHash]);
  return { versionId: opened.versionId, itemIds, start, end };
}
/** One committed statement as the service role (worker commands: never callable by staff). */
export async function asService<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  return db(async (client) => {
    await client.query('begin');
    try {
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      await client.query('set local role service_role');
      const { rows } = await client.query<{ r: T }>(sql, params);
      await client.query('commit');
      return rows[0]?.r as T;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}
/** Deal message preferences (A1) as the Sales owner, with the row version read first. */
export async function setPrefs(dealId: string, fields: Record<string, unknown>, userId: string = USERS.sales.id) {
  const rv = (await q<{ v: number }>('select row_version as v from public.deal_message_prefs where deal_id = $1', [dealId]))[0]?.v ?? 0;
  return asUser(userId, 'select public.deal_message_prefs_set($1, $2, $3::jsonb, $4) as r', [dealId, rv, JSON.stringify(fields), randomUUID()]);
}
/*
 * Live relabel (Addendum L5 "Test data": message journeys relabel their Deal as live inside the disposable test
 * only). Every stack Deal is synthetic, and 5.5 skips a synthetic Deal as `test_deal`; but in the 'test'
 * environment the finance gate (authz.finance_gate_issue) refuses money commands on a NON-synthetic Deal. So a
 * journey keeps the Deal synthetic for money steps (receipt verify, Accounts approval, refund payout) and relabels
 * it live — with the provenance deals_provenance requires, as tests/db/acc3-support.ts liveDeal() does — for the
 * other events. liveOff() puts every column back (afterAll calls allLiveOff()).
 */
const LIVE_MEMBER = 'SYNTHETIC_MEMBER_0001';
const liveDeals = new Set<string>();
export async function liveOn(dealId: string): Promise<void> {
  const bitrixId = 990_000_000 + Math.floor(Math.random() * 9_000_000);
  const [inbox] = await q<{ id: string }>(
    `insert into public.integration_inbox
       (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at, next_attempt_at, origin)
     values ($1::text, 'deal', 'RECONCILE', $2::bigint, extract(epoch from now())::bigint,
             authz.intake_dedupe_key($1::text, 'ACC3E2E:' || $2::text, $2::bigint, 0::bigint), 'processed', now(), null, 'reconcile')
     returning id`, [LIVE_MEMBER, bitrixId]);
  await q(`update public.deals set is_synthetic = false, source_system = 'bitrix', source_portal = $3, source_deal_id = $2,
      source_stage_id = 'C7:NEW', source_category_id = 7, source_created_at = now() - interval '1 day', source_modified_at = now() - interval '1 hour',
      last_synced_at = now(), last_verified_at = now(), source_assigned_by_id = 101, intake_inbox_id = $4 where id = $1`,
  [dealId, bitrixId, LIVE_MEMBER, inbox!.id]);
  liveDeals.add(dealId);
}
export async function liveOff(dealId: string): Promise<void> {
  const [d] = await q<{ inbox: string | null }>('select intake_inbox_id as inbox from public.deals where id = $1', [dealId]);
  await q(`update public.deals set is_synthetic = true, source_system = null, source_portal = null, source_deal_id = null, source_stage_id = null,
      source_category_id = null, source_created_at = null, source_modified_at = null, last_synced_at = null, last_verified_at = null,
      source_assigned_by_id = null, intake_inbox_id = null where id = $1`, [dealId]);
  if (d?.inbox) await q('delete from public.integration_inbox where id = $1', [d.inbox]).catch(() => undefined);
  liveDeals.delete(dealId);
}
export async function allLiveOff(): Promise<void> {
  for (const d of [...liveDeals]) await liveOff(d).catch(() => undefined);
}

/** "Clock moved by the test": every waiting message of the Deal is due now (owner SQL; quiet hours and retry delays skipped). */
export async function messagesDueNow(dealId: string): Promise<void> {
  await q(`update public.customer_messages set not_before = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
    where deal_id = $1 and status in ('queued', 'sending')`, [dealId]);
}
