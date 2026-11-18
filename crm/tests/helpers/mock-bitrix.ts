import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process MOCK Bitrix24 REST server (inbound-webhook style URLs) for tests.
 * It is never the real portal and holds only synthetic deals.
 *
 *   POST {base}/rest/{userId}/{code}/{method}.json   JSON body
 *
 * Shapes follow apidocs.bitrix24.com: success {result, time[, next, total]};
 * errors {error, error_description} with the documented HTTP statuses
 * (401 INVALID_CREDENTIALS, 503 QUERY_LIMIT_EXCEEDED, 429 OPERATION_TIME_LIMIT,
 * 400 "Not found" for crm.deal.get, 404 ERROR_METHOD_NOT_FOUND).
 *
 * Also exports FakeIntakeDb: an in-memory stand-in for agent B's intake commands
 * used by unit tests of the worker/receiver. The REAL semantics are tested by B
 * against Postgres (tests/db, tests/supabase/intake*.real.test.ts).
 */

export interface MockDeal {
  ID: string;
  TITLE: string;
  STAGE_ID: string;
  CATEGORY_ID: string;
  ASSIGNED_BY_ID: string;
  DATE_CREATE: string;
  DATE_MODIFY: string;
  OPPORTUNITY?: string;
  [key: string]: unknown;
}

/** Phase 6: synthetic Lead (header fields plus content fields the client must drop). */
export interface MockLead {
  ID: string;
  TITLE: string;
  STATUS_ID: string;
  SOURCE_ID: string;
  ASSIGNED_BY_ID: string;
  DATE_CREATE: string;
  DATE_MODIFY: string;
  [key: string]: unknown;
}

export type MockFailure =
  | { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
  | 'hang';

export interface MockRequest {
  method: string;
  path: string;
  authorized: boolean;
  body: Record<string, unknown>;
}

export interface MockBitrix {
  /** Valid REST base URL for this server (ends with "/"). */
  baseUrl: string;
  port: number;
  webhookCode: string;
  deals: Map<string, MockDeal>;
  leads: Map<string, MockLead>;
  /** Book now v2: synthetic Contacts / Companies for crm.contact.get / crm.company.get. */
  contacts: Map<string, Record<string, unknown>>;
  companies: Map<string, Record<string, unknown>>;
  requests: MockRequest[];
  /** Queue a one-shot failure for a method (FIFO). */
  failNext(method: string, failure: MockFailure): void;
  /** crm.deal.list page size (Bitrix: always 50). */
  pageSize: number;
  close(): Promise<void>;
}

const READ_METHODS = new Set([
  'crm.deal.get',
  'crm.deal.list',
  'crm.lead.get',
  'crm.lead.list',
  'crm.deal.fields',
  'crm.contact.get',
  'crm.company.get',
  'crm.category.list',
  'crm.status.list',
  'user.get',
  'app.info',
  'profile',
  'server.time',
  'department.get',
]);

/** Synthetic users; NAME/EMAIL/PERSONAL_MOBILE exist so tests can prove they are dropped. */
const SYNTHETIC_USERS = [
  { ID: '501', ACTIVE: true, NAME: 'Synthetic Person', EMAIL: 'synthetic@example.test', PERSONAL_MOBILE: '+10000000000', UF_DEPARTMENT: [11] },
  { ID: '502', ACTIVE: false, NAME: 'Synthetic Other', EMAIL: 'other@example.test', UF_DEPARTMENT: [12] },
];

function send(res: ServerResponse, status: number, body: unknown, raw?: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(raw ?? JSON.stringify(body));
}

const time = () => ({ start: Date.now() / 1000, finish: Date.now() / 1000, duration: 0.01 });

function matchesFilter(deal: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const m = /^(>=|<=|>|<|@|=|!)?([A-Z_]+)$/.exec(key);
    if (!m) return false;
    const [, op = '=', field] = m;
    const actual = deal[field!];
    if (op === '@') {
      if (!Array.isArray(value) || !value.map(String).includes(String(actual))) return false;
    } else if (op === '>=' || op === '>' || op === '<=' || op === '<') {
      // ID compares as a number, date fields as instants.
      const a = field === 'ID' ? Number(actual) : Date.parse(String(actual));
      const b = field === 'ID' ? Number(value) : Date.parse(String(value));
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === '>=' && !(a >= b)) return false;
      if (op === '>' && !(a > b)) return false;
      if (op === '<=' && !(a <= b)) return false;
      if (op === '<' && !(a < b)) return false;
    } else if (op === '=') {
      if (String(actual) !== String(value)) return false;
    } else return false;
  }
  return true;
}

export async function startMockBitrix(options: { port?: number; webhookCode?: string; userId?: number } = {}): Promise<MockBitrix> {
  const webhookCode = options.webhookCode ?? 'mockwebhookcode0001';
  const userId = options.userId ?? 1;
  const deals = new Map<string, MockDeal>();
  const leads = new Map<string, MockLead>();
  const contacts = new Map<string, Record<string, unknown>>();
  const companies = new Map<string, Record<string, unknown>>();
  const requests: MockRequest[] = [];
  const failures = new Map<string, MockFailure[]>();
  const hanging = new Set<ServerResponse>();
  const state = { pageSize: 50 };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const path = new URL(req.url ?? '/', 'http://mock').pathname;
    const m = /^\/rest\/(\d+)\/([^/]+)\/([a-z.]+)\.json$/.exec(path);
    const method = m?.[3] ?? '';
    const authorized = !!m && Number(m[1]) === userId && m[2] === webhookCode;
    requests.push({ method, path: authorized ? '/rest/[ok]/' + method : path, authorized, body });

    if (!m) return send(res, 404, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' });
    if (!authorized) return send(res, 401, { error: 'INVALID_CREDENTIALS', error_description: 'Invalid request credentials' });

    const queued = failures.get(method);
    const failure = queued?.shift();
    if (failure === 'hang') {
      hanging.add(res);
      return;
    }
    if (failure) return send(res, failure.status, failure.body ?? {}, failure.raw, failure.headers);

    if (!READ_METHODS.has(method)) {
      return send(res, 404, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' });
    }
    switch (method) {
      case 'crm.deal.get': {
        const deal = deals.get(String(body.id ?? body.ID ?? ''));
        if (!deal) return send(res, 400, { error: '', error_description: 'Not found' });
        return send(res, 200, { result: deal, time: time() });
      }
      case 'crm.contact.get':
      case 'crm.company.get': {
        const record = (method === 'crm.contact.get' ? contacts : companies).get(String(body.id ?? body.ID ?? ''));
        if (!record) return send(res, 400, { error: '', error_description: 'Not found' });
        return send(res, 200, { result: record, time: time() });
      }
      case 'crm.lead.get': {
        const lead = leads.get(String(body.id ?? body.ID ?? ''));
        if (!lead) return send(res, 400, { error: '', error_description: 'Not found' });
        return send(res, 200, { result: lead, time: time() });
      }
      case 'crm.deal.list':
      case 'crm.lead.list': {
        const filter = (body.filter ?? {}) as Record<string, unknown>;
        const select = Array.isArray(body.select) ? (body.select as string[]) : null;
        const start = Number(body.start ?? 0) || 0;
        const order = (body.order ?? { ID: 'ASC' }) as Record<string, string>;
        const byModify = Object.keys(order)[0] === 'DATE_MODIFY';
        const source: Array<Record<string, unknown> & { ID: string }> = method === 'crm.lead.list' ? [...leads.values()] : [...deals.values()];
        const modifiedAt = (r: Record<string, unknown>) => Date.parse(String(r.DATE_MODIFY));
        const all = source
          .filter((d) => matchesFilter(d, filter))
          .sort((a, b) =>
            byModify && modifiedAt(a) !== modifiedAt(b) ? modifiedAt(a) - modifiedAt(b) : Number(a.ID) - Number(b.ID),
          );
        const page = all.slice(start, start + state.pageSize).map((d) =>
          select ? Object.fromEntries(select.map((k) => [k, d[k]])) : d,
        );
        const next = start + state.pageSize < all.length ? start + state.pageSize : undefined;
        return send(res, 200, { result: page, ...(next !== undefined ? { next } : {}), total: all.length, time: time() });
      }
      case 'crm.deal.fields':
        return send(res, 200, {
          result: {
            ID: { type: 'integer', isRequired: false, isReadOnly: true, title: 'ID' },
            TITLE: { type: 'string', isRequired: false, isReadOnly: false, title: 'Name' },
            UF_CRM_SYNTHETIC: { type: 'string', isRequired: false, isReadOnly: false, title: 'UF_CRM_SYNTHETIC', listLabel: 'Synthetic field' },
          },
          time: time(),
        });
      case 'crm.category.list':
        return send(res, 200, {
          result: { categories: [{ id: 0, name: 'General', sort: 100, entityTypeId: 2, isDefault: 'Y' }, { id: 7, name: 'Synthetic pipeline', sort: 200, entityTypeId: 2, isDefault: 'N' }] },
          total: 2,
          time: time(),
        });
      case 'crm.status.list':
        return send(res, 200, {
          result: [
            { ID: '1', ENTITY_ID: 'DEAL_STAGE_7', STATUS_ID: 'C7:NEW', NAME: 'New', SORT: 10, CATEGORY_ID: '7', SEMANTICS: null },
            { ID: '2', ENTITY_ID: 'DEAL_STAGE_7', STATUS_ID: 'C7:WON', NAME: 'Confirmed', SORT: 20, CATEGORY_ID: '7', SEMANTICS: 'S' },
          ],
          total: 2,
          time: time(),
        });
      case 'app.info':
        return send(res, 200, { result: { SCOPE: ['crm', 'user_brief', 'department'], LICENSE: 'synthetic' }, time: time() });
      case 'profile':
        return send(res, 200, { result: { ID: String(userId), ADMIN: true, NAME: 'Synthetic Owner', LAST_NAME: 'Synthetic' }, time: time() });
      case 'server.time':
        return send(res, 200, { result: '2026-10-06T05:30:00+05:30', time: time() });
      case 'user.get': {
        const filter = (body.filter ?? body.FILTER ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(filter['@ID']) ? (filter['@ID'] as unknown[]).map(String) : null;
        const users = SYNTHETIC_USERS.filter((u) => !ids || ids.includes(u.ID));
        return send(res, 200, { result: users, total: users.length, time: time() });
      }
      case 'department.get':
        return send(res, 200, {
          result: [
            { ID: '11', NAME: 'Synthetic Branch A', PARENT: '1', UF_HEAD: '501' },
            { ID: '12', NAME: 'Synthetic Branch B', PARENT: '1' },
          ],
          time: time(),
        });
      default:
        return send(res, 200, { result: [], time: time() });
    }
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => send(res, 500, { error: 'INTERNAL_SERVER_ERROR', error_description: 'mock failure' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/rest/${userId}/${webhookCode}/`,
    port,
    webhookCode,
    deals,
    leads,
    contacts,
    companies,
    requests,
    get pageSize() {
      return state.pageSize;
    },
    set pageSize(v: number) {
      state.pageSize = v;
    },
    failNext(method, failure) {
      failures.set(method, [...(failures.get(method) ?? []), failure]);
    },
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function syntheticDeal(id: number, overrides: Partial<MockDeal> = {}): MockDeal {
  return {
    ID: String(id),
    TITLE: `Synthetic trip ${id}`,
    STAGE_ID: 'C7:WON',
    CATEGORY_ID: '7',
    ASSIGNED_BY_ID: '501',
    SOURCE_ID: 'WEBFORM',
    DATE_CREATE: '2026-10-05T10:00:00+05:30',
    DATE_MODIFY: '2026-10-05T10:00:00+05:30',
    OPPORTUNITY: '99999.00',
    ...overrides,
  };
}

export function syntheticLead(id: number, overrides: Partial<MockLead> = {}): MockLead {
  return {
    ID: String(id),
    TITLE: `Synthetic enquiry ${id}`,
    STATUS_ID: 'NEW',
    SOURCE_ID: 'WEBFORM',
    ASSIGNED_BY_ID: '501',
    DATE_CREATE: '2026-10-04T10:00:00+05:30',
    DATE_MODIFY: '2026-10-04T10:00:00+05:30',
    // Content fields that must never leave the client.
    NAME: 'Synthetic Person',
    PHONE: [{ VALUE: '+10000000000', VALUE_TYPE: 'WORK' }],
    EMAIL: [{ VALUE: 'synthetic@example.test', VALUE_TYPE: 'WORK' }],
    COMMENTS: 'synthetic comment',
    OPPORTUNITY: '12345.00',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FakeIntakeDb: in-memory approximation of agent B's commands (contract §5).
// ---------------------------------------------------------------------------

export interface FakeInboxRow {
  id: string;
  memberId: string;
  /** Phase 6: 'deal' | 'lead'; dealId holds the Bitrix ID of either. */
  sourceObject: 'deal' | 'lead';
  eventType: string;
  dealId: string;
  dedupeKey: string;
  status: 'pending' | 'processing' | 'processed' | 'ignored' | 'needs_review' | 'failed' | 'dead_letter';
  origin: 'event' | 'reconcile' | 'manual_retry';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lockedUntil: number | null;
  lockToken: string | null;
  reasonCode: string | null;
  lastErrorCode: string | null;
}

export interface FakeDeal {
  id: string;
  sourceDealId: string;
  title: string;
  stageId: string;
  categoryId: string;
  modifiedAt: string;
  ownerBitrixId: string;
  lastVerifiedAt: number;
  createdAt?: string;
  /** Soft removal reason (20261008000100), null/undefined = in the CRM. */
  removed?: string | null;
}

export interface FakeResyncJob {
  id: string;
  reason: string;
  status: 'queued' | 'running' | 'done' | 'superseded';
  cutoff: string;
  categoryIds: string[];
  stageIds: string[];
  cursor: number;
  listingDone: boolean;
  total: number | null;
  scanned: number;
  seen: Set<number>;
  lockToken: string | null;
  lockedUntil: number | null;
  createdAt: number;
  result: Record<string, unknown> | null;
}

export interface FakeLead {
  id: string;
  sourceLeadId: string;
  title: string;
  statusId: string;
  sourceIdCode: string;
  modifiedAt: string;
  ownerBitrixId: string;
  lastVerifiedAt: number;
}

export interface FakeWorkerRun {
  kind: string;
  outcome: string;
  [key: string]: unknown;
}

const ERROR_CODES = [
  'provider_timeout',
  'provider_unavailable',
  'provider_rate_limited',
  'provider_auth_failed',
  'provider_bad_response',
  'internal_error',
];

function sqlError(sqlState: string, message: string): Error {
  return Object.assign(new Error(message), { sqlState });
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Mirrors agent B's SQL (migration 20261003000100 + contract §12) closely
 * enough for app-level tests:
 * - dedupe key sha256(member|event|deal|ts); an event for a deal with a PENDING
 *   (unclaimed) row coalesces into it (L6);
 * - claim: pending/failed due, or processing with locked_until <= now; only
 *   attempts < max; an expired lease already at max attempts becomes dead_letter;
 * - apply: entry = category + stage + DATE_CREATE >= cutoff; a stored deal moved
 *   out of the pipeline (or created before the cutoff) is soft-removed, a removed
 *   one passing the entry rule again is restored; stale = older dateModify, or
 *   equal with identical Bitrix-owned content (M1); stale -> inbox `ignored`;
 * - resync jobs (20261008000200): next (+daily job), page (cursor), finish, release;
 * - fail: back-off 60 s * 2^(attempts-1) capped at 1 h; dead_letter when not
 *   retryable or attempts >= max;
 * - release: back to pending without consuming the attempt (L1);
 * - reconcile: up to date / open row (pending|processing|failed) / new row with
 *   sha256(member|RECONCILE|deal|modified); watermark via record_reconcile_run;
 * - request_reconcile: 5-minute cooldown (L5).
 * Authoritative semantics are tested by B against Postgres.
 */
export class FakeIntakeDb {
  now = Date.parse('2026-10-06T00:00:00Z');
  inbox: FakeInboxRow[] = [];
  deals = new Map<string, FakeDeal>();
  /** Phase 6: crm_leads stand-in (keyed by Bitrix lead id). */
  leads = new Map<string, FakeLead>();
  /**
   * Phase 6 manifest gate (authz.intake_manifest_allows). Off by default so the
   * Phase 2-5 Deal tests keep their meaning; when on, a missing active manifest
   * imports nothing.
   */
  manifestGate = false;
  manifests: Record<'deal' | 'lead', { ids: Set<string>; sourceCode: string; from: string; to: string } | null> = {
    deal: null,
    lead: null,
  };
  calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  config = {
    memberId: 'synthetic-member-0001',
    categoryId: '7',
    stages: ['C7:WON'],
    cutoff: '2026-10-01T00:00:00+05:30',
    lastReconciledAt: null as string | null,
  };
  mappedOwners = new Set(['501']);
  maxAttempts = 3;
  workerRuns: FakeWorkerRun[] = [];
  resyncJobs: FakeResyncJob[] = [];
  /** integration_resync_next queues the daily job (as the database does). */
  autoDailyResync = true;
  lastReconcileRequestAt: number | null = null;
  reconcileCooldownSeconds = 300;

  rpc = (fn: string, args: Record<string, unknown> = {}) => {
    this.calls.push({ fn, args });
    try {
      return Promise.resolve({ data: this.dispatch(fn, args), error: null });
    } catch (e) {
      const err = e as Error & { sqlState?: string };
      return Promise.resolve({ data: null, error: { code: err.sqlState ?? 'P0001', message: err.message } });
    }
  };

  private dispatch(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'integration_record_bitrix_event': {
        if (a.p_member_id !== this.config.memberId) throw sqlError('42501', 'portal not recognised');
        const { object, id } = this.source(a);
        const event = String(a.p_event_type);
        const leadEvent = event === 'ONCRMLEADADD' || event === 'ONCRMLEADUPDATE';
        const dealEvent = event === 'ONCRMDEALADD' || event === 'ONCRMDEALUPDATE';
        if ((object === 'lead' && !leadEvent) || (object === 'deal' && !dealEvent)) throw sqlError('22023', 'invalid event type');
        const key = sha256(`${a.p_member_id}|${object}|${event}|${id}|${a.p_source_ts}`);
        const existing = this.inbox.find((r) => r.dedupeKey === key);
        if (existing) return { inboxId: existing.id, duplicate: true };
        const pending = this.inbox.find((r) => r.sourceObject === object && r.dealId === id && r.status === 'pending');
        if (pending) return { inboxId: pending.id, duplicate: true };
        const row = this.newRow(id, event, key, 'event', object);
        if (!this.allows(object, id)) Object.assign(row, { status: 'ignored', reasonCode: 'not_in_manifest' });
        return { inboxId: row.id, duplicate: false };
      }
      case 'integration_claim_inbox': {
        const limit = Number(a.p_limit);
        const lease = Number(a.p_lease_seconds) * 1000;
        for (const r of this.inbox) {
          if (r.status === 'processing' && (r.lockedUntil ?? 0) <= this.now && r.attempts >= r.maxAttempts) {
            Object.assign(r, { status: 'dead_letter', lockToken: null, lockedUntil: null });
            r.lastErrorCode ??= 'internal_error';
          }
        }
        const due = this.inbox.filter(
          (r) =>
            r.attempts < r.maxAttempts &&
            (((r.status === 'pending' || r.status === 'failed') && r.nextAttemptAt <= this.now) ||
              (r.status === 'processing' && (r.lockedUntil ?? 0) <= this.now)),
        );
        return due.slice(0, limit).map((r) => {
          r.status = 'processing';
          r.lockToken = randomUUID();
          r.lockedUntil = this.now + lease;
          r.attempts += 1;
          return {
            inboxId: r.id,
            lockToken: r.lockToken,
            portalMemberId: r.memberId,
            sourceObject: r.sourceObject,
            sourceId: r.dealId,
            sourceDealId: r.dealId,
            eventType: r.eventType,
            origin: r.origin,
            attempts: r.attempts,
          };
        });
      }
      case 'integration_apply_bitrix_lead': {
        const row = this.leased(a);
        if (row.sourceObject !== 'lead') throw sqlError('22023', 'not a lead row');
        const l = a.p_lead as Record<string, string> | null;
        const done = (outcome: string, reasonCode: string | null, leadId: string | null) => {
          row.status =
            outcome === 'created' || outcome === 'updated' ? 'processed' : outcome === 'needs_review' ? 'needs_review' : 'ignored';
          row.reasonCode = reasonCode;
          row.lockToken = null;
          row.lockedUntil = null;
          return { outcome, leadId, reasonCode };
        };
        if (!this.allows('lead', row.dealId)) return done('ignored', 'not_in_manifest', null);
        if (l === null) return done('needs_review', 'source_deal_not_found', null);
        if (!l.title || l.title.length > 200 || l.id !== row.dealId) return done('needs_review', 'invalid_source_data', null);
        const m = this.manifests.lead;
        if (m) {
          const created = Date.parse(l.dateCreate!);
          if (l.sourceId !== m.sourceCode || !(created >= Date.parse(m.from) && created < Date.parse(m.to))) {
            return done('needs_review', 'outside_manifest_scope', null);
          }
        }
        const existing = this.leads.get(l.id);
        if (existing && Date.parse(l.dateModify!) <= Date.parse(existing.modifiedAt)) {
          existing.lastVerifiedAt = this.now;
          return done('stale_ignored', 'stale_ignored', existing.id);
        }
        if (!this.mappedOwners.has(l.assignedById!)) return done('needs_review', 'unmapped_owner', null);
        if (existing) {
          Object.assign(existing, { title: l.title, statusId: l.statusId, ownerBitrixId: l.assignedById, modifiedAt: l.dateModify, lastVerifiedAt: this.now });
          return done('updated', null, existing.id);
        }
        const lead: FakeLead = {
          id: randomUUID(),
          sourceLeadId: l.id,
          title: l.title,
          statusId: l.statusId!,
          sourceIdCode: l.sourceId!,
          modifiedAt: l.dateModify!,
          ownerBitrixId: l.assignedById!,
          lastVerifiedAt: this.now,
        };
        this.leads.set(l.id, lead);
        return done('created', null, lead.id);
      }
      case 'integration_apply_bitrix_deal': {
        const row = this.leased(a);
        if (row.sourceObject !== 'deal') throw sqlError('22023', 'not a deal row');
        const d = a.p_deal as Record<string, string> | null;
        const done = (outcome: string, reasonCode: string | null, dealId: string | null) => {
          row.status =
            outcome === 'created' || outcome === 'updated' ? 'processed' : outcome === 'needs_review' ? 'needs_review' : 'ignored';
          row.reasonCode = reasonCode;
          row.lockToken = null;
          row.lockedUntil = null;
          return { outcome, dealId, reasonCode };
        };
        if (!this.allows('deal', row.dealId)) return done('ignored', 'not_in_manifest', null);
        if (d === null) return done('needs_review', 'source_deal_not_found', null);
        if (!d.title || d.title.length > 300 || d.id !== row.dealId) return done('needs_review', 'invalid_source_data', null);
        const existing = this.deals.get(d.id);
        const catOk = d.categoryId === this.config.categoryId;
        const entryReason = !catOk
          ? 'not_eligible_category'
          : !this.config.stages.includes(d.stageId!)
            ? 'not_eligible_stage'
            : Date.parse(d.dateCreate!) < Date.parse(this.config.cutoff)
              ? 'before_cutoff'
              : null;
        if (!existing) {
          if (entryReason) return done('ignored', entryReason, null);
        } else {
          const modified = Date.parse(d.dateModify!);
          const stored = Date.parse(existing.modifiedAt);
          const removeReason = existing.removed
            ? null
            : !catOk
              ? 'pipeline_not_eligible'
              : Date.parse(d.dateCreate!) < Date.parse(this.config.cutoff)
                ? 'before_sync_date'
                : null;
          const restore = !!existing.removed && entryReason === null;
          const sameContent =
            existing.title === d.title &&
            existing.stageId === d.stageId &&
            existing.categoryId === d.categoryId &&
            existing.ownerBitrixId === d.assignedById;
          if (modified < stored) {
            existing.lastVerifiedAt = this.now;
            return done('stale_ignored', 'stale_ignored', existing.id);
          }
          if (modified === stored && sameContent && !removeReason && !restore) {
            existing.lastVerifiedAt = this.now;
            return existing.removed ? done('ignored', entryReason, existing.id) : done('stale_ignored', 'stale_ignored', existing.id);
          }
          if (removeReason || (existing.removed && !restore)) {
            Object.assign(existing, {
              title: d.title,
              stageId: d.stageId,
              categoryId: d.categoryId,
              ownerBitrixId: d.assignedById,
              modifiedAt: d.dateModify,
              createdAt: d.dateCreate,
              lastVerifiedAt: this.now,
              removed: existing.removed ?? removeReason,
            });
            return removeReason ? done('updated', null, existing.id) : done('ignored', entryReason, existing.id);
          }
          if (restore) existing.removed = null;
        }
        if (!this.mappedOwners.has(d.assignedById!)) return done('needs_review', 'unmapped_owner', null);
        if (existing) {
          Object.assign(existing, {
            title: d.title,
            stageId: d.stageId,
            categoryId: d.categoryId,
            ownerBitrixId: d.assignedById,
            modifiedAt: d.dateModify,
            lastVerifiedAt: this.now,
          });
          return done('updated', null, existing.id);
        }
        const deal: FakeDeal = {
          id: randomUUID(),
          sourceDealId: d.id,
          title: d.title,
          stageId: d.stageId!,
          categoryId: d.categoryId!,
          modifiedAt: d.dateModify!,
          ownerBitrixId: d.assignedById!,
          lastVerifiedAt: this.now,
          createdAt: d.dateCreate!,
          removed: null,
        };
        this.deals.set(d.id, deal);
        return done('created', null, deal.id);
      }
      case 'integration_fail_inbox': {
        if (!ERROR_CODES.includes(String(a.p_error_code))) throw sqlError('22023', 'unknown error code');
        const row = this.leased(a);
        row.lockToken = null;
        row.lockedUntil = null;
        row.lastErrorCode = String(a.p_error_code);
        if (!a.p_retryable || row.attempts >= row.maxAttempts) {
          row.status = 'dead_letter';
        } else {
          row.status = 'failed';
          row.nextAttemptAt = this.now + Math.min(3_600_000, 60_000 * 2 ** Math.max(row.attempts - 1, 0));
        }
        return { inboxId: row.id, status: row.status, attempts: row.attempts };
      }
      case 'integration_release_inbox': {
        const row = this.leased(a);
        Object.assign(row, {
          status: 'pending',
          lockToken: null,
          lockedUntil: null,
          attempts: Math.max(row.attempts - 1, 0),
          nextAttemptAt: this.now,
        });
        return { inboxId: row.id, status: 'pending' };
      }
      case 'integration_enqueue_reconcile':
      case 'integration_enqueue_reconcile_lead': {
        if (a.p_member_id !== this.config.memberId) throw sqlError('42501', 'portal not recognised');
        if ((fn === 'integration_enqueue_reconcile_lead') !== (a.p_lead_id !== undefined) || (a.p_lead_id !== undefined && a.p_deal_id !== undefined)) {
          throw sqlError('22023', 'invalid arguments');
        }
        const { object, id } = this.source(a);
        if (!this.allows(object, id)) {
          return { inboxId: null, duplicate: false, upToDate: false, ignored: true, reasonCode: 'not_in_manifest' };
        }
        const stored = object === 'lead' ? this.leads.get(id) : this.deals.get(id);
        if (stored && Math.floor(Date.parse(stored.modifiedAt) / 1000) >= Number(a.p_source_modified)) {
          stored.lastVerifiedAt = this.now;
          return { inboxId: null, duplicate: true, upToDate: true };
        }
        const open = this.inbox.find(
          (r) => r.sourceObject === object && r.dealId === id && ['pending', 'processing', 'failed'].includes(r.status),
        );
        if (open) return { inboxId: open.id, duplicate: true, upToDate: false };
        const key = sha256(`${a.p_member_id}|${object}|RECONCILE|${id}|${a.p_source_modified}`);
        const same = this.inbox.find((r) => r.dedupeKey === key);
        if (same) return { inboxId: same.id, duplicate: true, upToDate: false };
        const row = this.newRow(id, 'RECONCILE', key, 'reconcile', object);
        return { inboxId: row.id, duplicate: false, upToDate: false };
      }
      case 'integration_active_manifest': {
        if (a.p_member_id !== this.config.memberId) throw sqlError('42501', 'portal not recognised');
        const object = a.p_source_object as 'deal' | 'lead';
        if (object !== 'deal' && object !== 'lead') throw sqlError('22023', 'invalid source object');
        const m = this.manifests[object];
        if (!m) return null;
        const ids = [...m.ids].sort((x, y) => Number(x) - Number(y));
        return {
          manifestId: '00000000-0000-4000-8000-00000000a11d',
          sourceObject: object,
          sourceCode: m.sourceCode,
          businessDate: m.from.slice(0, 10),
          intervalFrom: m.from,
          intervalTo: m.to,
          expectedCount: ids.length,
          ids,
        };
      }
      case 'integration_record_reconcile_run': {
        const advance =
          a.p_ok === true &&
          (this.config.lastReconciledAt === null || Date.parse(String(a.p_started_at)) > Date.parse(this.config.lastReconciledAt));
        if (advance) this.config.lastReconciledAt = String(a.p_started_at);
        return { portalMemberId: a.p_member_id, lastReconciledAt: this.config.lastReconciledAt, advanced: advance };
      }
      case 'integration_record_worker_run': {
        const run = a.p_run as FakeWorkerRun;
        // Sync completion: optional 'trigger' (migration 20261111000100).
        const allowed = ['kind', 'startedAt', 'finishedAt', 'outcome', 'trigger', 'claimed', 'created', 'updated', 'ignored', 'needsReview', 'failed', 'deadLettered', 'enqueued'];
        if (!run || Object.keys(run).some((k) => !allowed.includes(k))) throw sqlError('22023', 'unknown run field');
        if (run.trigger !== undefined && !['manual', 'cron', 'event'].includes(String(run.trigger))) throw sqlError('22023', 'invalid run trigger');
        if (!['worker', 'reconcile'].includes(run.kind)) throw sqlError('22023', 'invalid run');
        if (!['ok', 'partial', 'provider_error', 'internal_error'].includes(run.outcome)) throw sqlError('22023', 'invalid run');
        this.workerRuns.push(run);
        return { id: randomUUID() };
      }
      case 'integration_request_reconcile': {
        const wait =
          this.lastReconcileRequestAt === null
            ? 0
            : Math.ceil((this.lastReconcileRequestAt + this.reconcileCooldownSeconds * 1000 - this.now) / 1000);
        if (wait > 0) return { portalMemberId: this.config.memberId, allowed: false, retryAfterSeconds: wait };
        this.lastReconcileRequestAt = this.now;
        return { portalMemberId: this.config.memberId, allowed: true, retryAfterSeconds: 0 };
      }
      case 'integration_retry_inbox': {
        const row = this.inbox.find((r) => r.id === a.p_inbox_id);
        if (!row) throw sqlError('42501', 'not authorized');
        if (!['needs_review', 'failed', 'dead_letter'].includes(row.status)) throw sqlError('22023', 'not retryable');
        Object.assign(row, { status: 'pending', origin: 'manual_retry', attempts: 0, nextAttemptAt: this.now, reasonCode: null });
        return { inboxId: row.id, status: 'pending' };
      }
      case 'integration_queue_resync': {
        if (a.p_member_id !== this.config.memberId) throw sqlError('42501', 'portal not recognised');
        return { jobId: this.queueResync('manual').id };
      }
      case 'integration_resync_next': {
        if (a.p_member_id !== this.config.memberId) throw sqlError('42501', 'portal not recognised');
        const open = () => this.resyncJobs.find((j) => j.status === 'queued' || j.status === 'running');
        if (this.autoDailyResync && !open() && !this.resyncJobs.some((j) => j.createdAt > this.now - 86_400_000)) {
          this.queueResync('daily');
        }
        const job = open();
        if (!job || (job.lockedUntil !== null && job.lockedUntil > this.now)) return null;
        Object.assign(job, { status: 'running', lockToken: randomUUID(), lockedUntil: this.now + Number(a.p_lease_seconds) * 1000 });
        return {
          jobId: job.id,
          lockToken: job.lockToken,
          cutoffAt: job.cutoff,
          categoryIds: job.categoryIds,
          stageIds: job.stageIds,
          cursorId: job.cursor,
          listingDone: job.listingDone,
          bitrixTotal: job.total,
          scanned: job.scanned,
        };
      }
      case 'integration_resync_page': {
        const job = this.resyncLeased(a);
        const deals = a.p_deals as Array<{ id: number; modified: number }>;
        let enqueued = 0;
        let max = job.cursor;
        for (const d of deals) {
          if (d.id <= job.cursor) throw sqlError('22023', 'resync page out of order');
          job.seen.add(d.id);
          const r = this.dispatch('integration_enqueue_reconcile', {
            p_member_id: this.config.memberId,
            p_deal_id: d.id,
            p_source_modified: d.modified,
          }) as { duplicate: boolean };
          if (!r.duplicate) enqueued += 1;
          max = Math.max(max, d.id);
        }
        if (job.cursor === 0 && job.total === null) job.total = (a.p_total as number | null) ?? null;
        job.cursor = max;
        job.scanned += deals.length;
        job.listingDone = a.p_last === true;
        return { enqueued, scanned: job.scanned, cursorId: max };
      }
      case 'integration_resync_finish': {
        const job = this.resyncLeased(a);
        if (!job.listingDone) throw sqlError('22023', 'resync listing not complete');
        const waiting = this.inbox.filter((r) => ['pending', 'processing', 'failed'].includes(r.status)).length;
        if (waiting > 0) {
          Object.assign(job, { lockToken: null, lockedUntil: null });
          return { done: false, waiting };
        }
        const live = [...this.deals.values()].filter((d) => !d.removed);
        const liveIds = new Set(live.map((d) => Number(d.sourceDealId)));
        const missing = [...job.seen].filter((id) => !liveIds.has(id)).length;
        const notSeen = live.filter((d) => !job.seen.has(Number(d.sourceDealId)));
        const kept = notSeen.filter((d) => job.categoryIds.includes(d.categoryId) && !job.stageIds.includes(d.stageId)).length;
        const extra = live.length - (job.seen.size - missing) - kept;
        // Stored but not listed (and not a kept stage move): read again from Bitrix.
        for (const d of notSeen) {
          if (job.categoryIds.includes(d.categoryId) && !job.stageIds.includes(d.stageId)) continue;
          this.newRow(d.sourceDealId, 'RECONCILE', sha256(`${job.id}|${d.sourceDealId}`), 'reconcile');
        }
        const result = {
          bitrix: job.seen.size,
          bitrixTotal: job.total,
          crm: live.length,
          missing,
          extra,
          keptAfterStageMove: kept,
          reRead: notSeen.length - kept,
          inSync: missing === 0 && extra === 0,
        };
        Object.assign(job, { status: 'done', result, lockToken: null, lockedUntil: null });
        return { done: true, result };
      }
      case 'integration_resync_release': {
        const job = this.resyncJobs.find((j) => j.id === a.p_job);
        if (job && job.lockToken === a.p_token && job.status === 'running') Object.assign(job, { lockToken: null, lockedUntil: null });
        return null;
      }
      default:
        throw new Error(`unknown command ${fn}`);
    }
  }

  queueResync(reason: string): FakeResyncJob {
    const open = this.resyncJobs.find((j) => j.status === 'queued' || j.status === 'running');
    if (open) return open;
    const job: FakeResyncJob = {
      id: randomUUID(),
      reason,
      status: 'queued',
      cutoff: this.config.cutoff,
      categoryIds: [this.config.categoryId],
      stageIds: [...this.config.stages],
      cursor: 0,
      listingDone: false,
      total: null,
      scanned: 0,
      seen: new Set(),
      lockToken: null,
      lockedUntil: null,
      createdAt: this.now,
      result: null,
    };
    this.resyncJobs.push(job);
    return job;
  }

  private resyncLeased(a: Record<string, unknown>): FakeResyncJob {
    const job = this.resyncJobs.find((j) => j.id === a.p_job);
    if (!job || job.status !== 'running' || job.lockToken !== a.p_token || (job.lockedUntil ?? 0) <= this.now) {
      throw sqlError('55P03', 'resync lease not held');
    }
    return job;
  }

  /** Same signatures as migration 20261007000100: p_deal_id carries the ID; the object comes from the event type. */
  private source(a: Record<string, unknown>): { object: 'deal' | 'lead'; id: string } {
    const event = String(a.p_event_type ?? '');
    if (event === 'ONCRMLEADADD' || event === 'ONCRMLEADUPDATE') return { object: 'lead', id: String(a.p_deal_id) };
    if (a.p_lead_id !== undefined) return { object: 'lead', id: String(a.p_lead_id) };
    return { object: 'deal', id: String(a.p_deal_id) };
  }

  /** authz.intake_manifest_allows: only an active manifest for the object admits the id. */
  allows(object: 'deal' | 'lead', id: string): boolean {
    if (!this.manifestGate) return true;
    return this.manifests[object]?.ids.has(id) ?? false;
  }

  private newRow(
    dealId: string,
    eventType: string,
    dedupeKey: string,
    origin: FakeInboxRow['origin'],
    sourceObject: 'deal' | 'lead' = 'deal',
  ): FakeInboxRow {
    const row: FakeInboxRow = {
      id: randomUUID(),
      memberId: this.config.memberId,
      sourceObject,
      eventType,
      dealId,
      dedupeKey,
      status: 'pending',
      origin,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      nextAttemptAt: this.now,
      lockedUntil: null,
      lockToken: null,
      reasonCode: null,
      lastErrorCode: null,
    };
    this.inbox.push(row);
    return row;
  }

  private leased(a: Record<string, unknown>): FakeInboxRow {
    const row = this.inbox.find((r) => r.id === a.p_inbox_id);
    if (!row || row.status !== 'processing' || row.lockToken !== a.p_lock_token || (row.lockedUntil ?? 0) <= this.now) {
      throw sqlError('55P03', 'inbox lease not held');
    }
    return row;
  }

  /** Records a Lead event row as the receiver would. */
  enqueueLeadEvent(leadId: number, ts: number, eventType = 'ONCRMLEADADD') {
    return this.dispatch('integration_record_bitrix_event', {
      p_member_id: this.config.memberId,
      p_event_type: eventType,
      p_deal_id: leadId,
      p_source_ts: ts,
    }) as { inboxId: string; duplicate: boolean };
  }

  /** Records an event row as the receiver would (dedupe + coalescing). */
  enqueueEvent(dealId: number, ts: number, eventType = 'ONCRMDEALUPDATE') {
    return this.dispatch('integration_record_bitrix_event', {
      p_member_id: this.config.memberId,
      p_event_type: eventType,
      p_deal_id: dealId,
      p_source_ts: ts,
    }) as { inboxId: string; duplicate: boolean };
  }
}

// ---------------------------------------------------------------------------
// Synthetic outbound-event deliveries (Bitrix -> receiver), form-urlencoded.
// ---------------------------------------------------------------------------

export interface SyntheticEventOptions {
  event?: string;
  dealId?: string;
  ts?: string;
  domain?: string;
  memberId?: string;
  applicationToken?: string;
  /** Extra or overriding keys; undefined removes a key. */
  extra?: Record<string, string | undefined>;
}

/** Field map shaped like a Bitrix ONCRMDEAL* delivery (synthetic values only). */
export function syntheticEventFields(options: SyntheticEventOptions = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    event: options.event ?? 'ONCRMDEALUPDATE',
    event_handler_id: '185',
    'data[FIELDS][ID]': options.dealId ?? '662',
    ts: options.ts ?? '1759700000',
    'auth[domain]': options.domain ?? 'synthetic.bitrix24.example',
    'auth[client_endpoint]': 'https://synthetic.bitrix24.example/rest/',
    'auth[server_endpoint]': 'https://oauth.bitrix.info/rest/',
    'auth[member_id]': options.memberId ?? 'synthetic-member-0001',
    'auth[application_token]': options.applicationToken ?? 'synthetic-application-token-0123456789',
    ...options.extra,
  };
  return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
}

/** A POST Request carrying a synthetic delivery to `url`. */
export function syntheticEventRequest(url: string, options: SyntheticEventOptions = {}, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    body: new URLSearchParams(syntheticEventFields(options)).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
}
