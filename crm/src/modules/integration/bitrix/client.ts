import 'server-only';
import type { IntakeErrorCode } from '../contracts';
import type { BitrixRestTarget } from './config';
import {
  COMPANY_BASIC_FIELDS,
  CONTACT_BASIC_FIELDS,
  LEAD_FACT_FIELDS,
  pickKeys,
  type CompanyBasicField,
  type ContactBasicField,
  type LeadFactField,
} from './trip-facts';

/**
 * Read-only Bitrix24 REST client over an inbound webhook (contract §1).
 *
 * - Allow-listed READ methods only; no write method can be called.
 * - 10 s timeout per request; redirects are refused (never follow to another host).
 * - Rate limits (apidocs.bitrix24.com/limits.html): 503 QUERY_LIMIT_EXCEEDED and
 *   429 OPERATION_TIME_LIMIT are retried with exponential back-off + jitter.
 * - Errors carry an IntakeErrorCode and a fixed message. The base URL (which
 *   contains the webhook credential) never appears in errors or logs.
 * - Response bodies are size-bounded.
 */

export const ALLOWED_READ_METHODS = [
  'crm.deal.get',
  'crm.deal.list',
  'crm.lead.get',
  'crm.lead.list',
  'crm.deal.fields',
  'crm.category.list',
  'crm.status.list',
  'user.get',
  // B1.2 (DEC-36): linked Contact / Company basics only; answers are reduced to
  // CONTACT_BASIC_FIELDS / COMPANY_BASIC_FIELDS immediately (getContactBasics,
  // getCompanyBasics). Used only while bitrix_trip_facts_read is on.
  'crm.contact.get',
  'crm.company.get',
  // B1.2 (DEC-43, 13 Oct 2026 live probe): the ID-proof copy reads its one
  // Deal file field through the item API, whose file entries carry
  // urlMachine (a download link usable by a webhook caller); crm.deal.get only
  // returns browser-session links. Answers are reduced to that one field
  // immediately (getDealItemField).
  'crm.item.get',
] as const;
export type AllowedReadMethod = (typeof ALLOWED_READ_METHODS)[number];

/**
 * Phase 6: the only Lead fields ever selected from crm.lead.list (header only:
 * no contacts, phones, e-mails, comments, amounts or files). crm.lead.get has no
 * select parameter, so its answer is reduced to these keys immediately.
 */
export const LEAD_HEADER_FIELDS = ['ID', 'TITLE', 'STATUS_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY'] as const;
export type LeadHeaderField = (typeof LEAD_HEADER_FIELDS)[number];

export const BITRIX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class BitrixClientError extends Error {
  override name = 'BitrixClientError';
  constructor(
    readonly code: IntakeErrorCode,
    readonly httpStatus: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(`Bitrix request failed: ${code}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
  }
}

export interface BitrixClientOptions {
  target: BitrixRestTarget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries after a rate-limit answer (total attempts = maxRateLimitRetries + 1). */
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Base back-off delay in ms (doubles each retry). */
  backoffBaseMs?: number;
}

export interface BitrixListPage<T> {
  items: T[];
  next: number | null;
  total: number | null;
}

export type BitrixDealGetResult = { kind: 'ok'; deal: Record<string, unknown> } | { kind: 'not_found' };
export type BitrixLeadGetResult =
  | {
      kind: 'ok';
      lead: Partial<Record<LeadHeaderField, unknown>>;
      /** B1.2: present only when requested (bitrix_trip_facts_read on); reduced to LEAD_FACT_FIELDS. */
      facts?: Partial<Record<LeadFactField, unknown>>;
    }
  | { kind: 'not_found' };
export type BitrixContactGetResult = { kind: 'ok'; contact: Partial<Record<ContactBasicField, unknown>> } | { kind: 'not_found' };
/** One field of a Deal read through crm.item.get; everything else in the item is dropped. */
export type BitrixDealItemFieldResult = { kind: 'ok'; value: unknown } | { kind: 'not_found' };
/** Deal = entityTypeId 2 in the item API. */
const DEAL_ITEM_ENTITY_TYPE_ID = 2;
/** Item-API (camelCase) key of a Deal user field, e.g. ufCrm_1784359513. */
const ITEM_USER_FIELD_KEY = /^ufCrm_\d{1,20}$/;

export type BitrixCompanyGetResult = { kind: 'ok'; company: Partial<Record<CompanyBasicField, unknown>> } | { kind: 'not_found' };

/** Keeps only the Lead header keys; everything else in the provider answer is dropped. */
export function pickLeadHeader(raw: Record<string, unknown>): Partial<Record<LeadHeaderField, unknown>> {
  const out: Partial<Record<LeadHeaderField, unknown>> = {};
  for (const key of LEAD_HEADER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
  }
  return out;
}

/** Replaces any occurrence of the secret strings with "[redacted]". */
export function redact(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  // Defence in depth: hide webhook-shaped paths even if not passed explicitly.
  return out.replace(/\/rest\/\d+\/[A-Za-z0-9_-]+/g, '/rest/[redacted]');
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RawAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

function providerCodeOf(body: Record<string, unknown> | null): string | null {
  return body && typeof body.error === 'string' ? body.error : null;
}

function descriptionOf(body: Record<string, unknown> | null): string {
  return body && typeof body.error_description === 'string' ? body.error_description : '';
}

function isRateLimited(answer: RawAnswer): boolean {
  const code = providerCodeOf(answer.body);
  return (
    answer.status === 429 ||
    code === 'QUERY_LIMIT_EXCEEDED' ||
    code === 'OPERATION_TIME_LIMIT'
  );
}

function isNotFound(answer: RawAnswer): boolean {
  // crm.deal.get documents "Not found" with HTTP 400; error-codes.html shows 404
  // with an empty `error`. Accept both, but never for method-not-found.
  const code = providerCodeOf(answer.body);
  if (code === 'ERROR_METHOD_NOT_FOUND') return false;
  return (answer.status === 400 || answer.status === 404) && /not found/i.test(descriptionOf(answer.body));
}

function classify(answer: RawAnswer): BitrixClientError {
  const code = providerCodeOf(answer.body);
  const status = answer.status;
  if (isRateLimited(answer)) return new BitrixClientError('provider_rate_limited', status, code);
  if (code === 'OVERLOAD_LIMIT') return new BitrixClientError('provider_unavailable', status, code);
  if (status === 401 || status === 403) return new BitrixClientError('provider_auth_failed', status, code);
  if (code && /^(NO_AUTH_FOUND|INVALID_CREDENTIALS|insufficient_scope|expired_token|ACCESS_DENIED|INVALID_REQUEST|user_access_error)$/.test(code)) {
    return new BitrixClientError('provider_auth_failed', status, code);
  }
  if (status >= 500) return new BitrixClientError('provider_unavailable', status, code);
  return new BitrixClientError('provider_bad_response', status, code);
}

async function readBoundedJson(res: Response): Promise<Record<string, unknown> | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BitrixClientError('provider_bad_response', res.status);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createBitrixClient(options: BitrixClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BITRIX_TIMEOUT_MS;
  const maxRetries = options.maxRateLimitRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const backoffBase = options.backoffBaseMs ?? 1_000;
  const allowed = new Set<string>(ALLOWED_READ_METHODS);

  async function once(method: AllowedReadMethod, params: Record<string, unknown>): Promise<RawAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${options.target.baseUrl}${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(params),
        redirect: 'error',
        signal: controller.signal,
        cache: 'no-store',
      });
      const body = await readBoundedJson(res);
      return { status: res.status, body };
    } catch (error) {
      if (error instanceof BitrixClientError) throw error;
      if (controller.signal.aborted) throw new BitrixClientError('provider_timeout');
      // Network failure, DNS, TLS, refused redirect. Never include the cause text
      // (it can contain the URL).
      throw new BitrixClientError('provider_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function raw(method: AllowedReadMethod, params: Record<string, unknown>): Promise<RawAnswer> {
    if (!allowed.has(method)) throw new BitrixClientError('internal_error');
    // crm.item.get reads Deals only (DEC-43), also through call().
    if (method === 'crm.item.get' && params.entityTypeId !== DEAL_ITEM_ENTITY_TYPE_ID) throw new BitrixClientError('internal_error');
    for (let attempt = 0; ; attempt += 1) {
      const answer = await once(method, params);
      if (answer.status === 200 && answer.body && !('error' in answer.body)) return answer;
      if (isRateLimited(answer) && attempt < maxRetries) {
        const delay = backoffBase * 2 ** attempt + Math.floor(Math.random() * backoffBase);
        await sleep(delay);
        continue;
      }
      return answer;
    }
  }

  async function call<T = unknown>(method: AllowedReadMethod, params: Record<string, unknown> = {}): Promise<{ result: T; next: number | null; total: number | null }> {
    const answer = await raw(method, params);
    if (answer.status !== 200 || !answer.body || 'error' in answer.body) throw classify(answer);
    if (!('result' in answer.body)) throw new BitrixClientError('provider_bad_response', answer.status);
    const next = typeof answer.body.next === 'number' ? answer.body.next : null;
    const total = typeof answer.body.total === 'number' ? answer.body.total : null;
    return { result: answer.body.result as T, next, total };
  }

  async function getOne(method: 'crm.deal.get' | 'crm.lead.get' | 'crm.contact.get' | 'crm.company.get', id: string) {
    if (!/^[1-9][0-9]{0,15}$/.test(id)) throw new BitrixClientError('internal_error');
    const answer = await raw(method, { id });
    if (isNotFound(answer)) return null;
    if (answer.status !== 200 || !answer.body || 'error' in answer.body) throw classify(answer);
    const record = answer.body.result;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new BitrixClientError('provider_bad_response', answer.status);
    }
    return record as Record<string, unknown>;
  }

  async function list(
    method: 'crm.deal.list' | 'crm.lead.list',
    params: { filter: Record<string, unknown>; select: string[]; start: number; order?: Record<string, 'ASC' | 'DESC'> },
  ): Promise<BitrixListPage<Record<string, unknown>>> {
    const { result, next, total } = await call<unknown>(method, {
      filter: params.filter,
      select: params.select,
      order: params.order ?? { ID: 'ASC' },
      start: params.start,
    });
    if (!Array.isArray(result)) throw new BitrixClientError('provider_bad_response', 200);
    return {
      items: result.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object'),
      next,
      total,
    };
  }

  return {
    call,

    /** Phase 6: Lead header only. Never used for Deals (separate method, separate id space). */
    async getLead(id: string, options: { facts?: boolean } = {}): Promise<BitrixLeadGetResult> {
      const record = await getOne('crm.lead.get', id);
      if (record === null) return { kind: 'not_found' };
      // B1.2: the DEC-36 Lead keys only, and only when asked for.
      return options.facts
        ? { kind: 'ok', lead: pickLeadHeader(record), facts: pickKeys(record, LEAD_FACT_FIELDS) }
        : { kind: 'ok', lead: pickLeadHeader(record) };
    },

    /** B1.2 (DEC-36): name, phone, e-mail of a linked Contact; the rest of the answer is dropped here. */
    async getContactBasics(id: string): Promise<BitrixContactGetResult> {
      const record = await getOne('crm.contact.get', id);
      return record === null ? { kind: 'not_found' } : { kind: 'ok', contact: pickKeys(record, CONTACT_BASIC_FIELDS) };
    },

    /** B1.2 (DEC-36): name, phone, e-mail of a linked Company; the rest of the answer is dropped here. */
    async getCompanyBasics(id: string): Promise<BitrixCompanyGetResult> {
      const record = await getOne('crm.company.get', id);
      return record === null ? { kind: 'not_found' } : { kind: 'ok', company: pickKeys(record, COMPANY_BASIC_FIELDS) };
    },

    /** Phase 6: select must be a subset of LEAD_HEADER_FIELDS; rows are reduced to those keys. */
    async listLeads(params: {
      filter: Record<string, unknown>;
      select: LeadHeaderField[];
      start: number;
      /** Default ID ascending (sync completion: DATE_MODIFY keyset for the scope pass). */
      order?: Record<string, 'ASC' | 'DESC'>;
    }): Promise<BitrixListPage<Partial<Record<LeadHeaderField, unknown>>>> {
      const allowedSelect = new Set<string>(LEAD_HEADER_FIELDS);
      if (params.select.length === 0 || params.select.some((f) => !allowedSelect.has(f))) {
        throw new BitrixClientError('internal_error');
      }
      const page = await list('crm.lead.list', params);
      return { ...page, items: page.items.map(pickLeadHeader) };
    },

    async getDeal(id: string): Promise<BitrixDealGetResult> {
      const record = await getOne('crm.deal.get', id);
      return record === null ? { kind: 'not_found' } : { kind: 'ok', deal: record };
    },

    /**
     * B1.2 (DEC-43): one user field of a Deal through crm.item.get
     * (entityTypeId 2, camelCase keys). Returns only that field's raw value;
     * the rest of the item is dropped here. The answer must be for the asked
     * Deal and must show the field: a missing key is a bad answer, never read
     * as an empty field (an empty reading would let the copy's append drop
     * files the reader could not see).
     */
    async getDealItemField(id: string, field: string): Promise<BitrixDealItemFieldResult> {
      if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)) || !ITEM_USER_FIELD_KEY.test(field)) {
        throw new BitrixClientError('internal_error');
      }
      const answer = await raw('crm.item.get', { entityTypeId: DEAL_ITEM_ENTITY_TYPE_ID, id: Number(id), useOriginalUfNames: 'N' });
      // crm.item.get documents a missing item as HTTP 400 NOT_FOUND ("Element not found").
      const code = providerCodeOf(answer.body);
      if ((answer.status === 400 || answer.status === 404) && (code === 'NOT_FOUND' || isNotFound(answer))) return { kind: 'not_found' };
      if (answer.status !== 200 || !answer.body || 'error' in answer.body) throw classify(answer);
      const result = answer.body.result;
      const item = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).item : null;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BitrixClientError('provider_bad_response', answer.status);
      const record = item as Record<string, unknown>;
      if (String(record.id) !== id || !Object.prototype.hasOwnProperty.call(record, field)) {
        throw new BitrixClientError('provider_bad_response', answer.status);
      }
      return { kind: 'ok', value: record[field] };
    },

    async listDeals(params: {
      filter: Record<string, unknown>;
      select: string[];
      start: number;
      /** Default ID ascending. */
      order?: Record<string, 'ASC' | 'DESC'>;
    }): Promise<BitrixListPage<Record<string, unknown>>> {
      return list('crm.deal.list', params);
    },
  };
}

export type BitrixClient = ReturnType<typeof createBitrixClient>;
