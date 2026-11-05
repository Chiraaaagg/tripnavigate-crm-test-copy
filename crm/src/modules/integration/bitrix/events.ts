import { z } from 'zod';
import type { SourceObject } from '../contracts';

/**
 * Parser for Bitrix24 outbound webhook / event handler deliveries.
 *
 * Verified provider contract (apidocs.bitrix24.com, local-webhooks and
 * crm/deals/events/on-crm-deal-add|update, crm/leads/events/on-crm-lead-add|update): POST
 * application/x-www-form-urlencoded with `event`, `event_handler_id`,
 * `data[FIELDS][ID]`, `ts` (unix seconds) and `auth[...]` (`domain`,
 * `member_id`, `application_token`; application handlers additionally send
 * `access_token`, `refresh_token`, `client_endpoint`, `server_endpoint`, ...).
 *
 * Only the bounded fields below are read. Everything else (including
 * `auth[client_endpoint]` / `auth[server_endpoint]` and OAuth tokens) is
 * ignored, never stored, never fetched. The payload is a notification only;
 * the worker re-reads the deal (crm.deal.get) or lead (crm.lead.get) from Bitrix.
 */

export const MAX_EVENT_BODY_BYTES = 16 * 1024;
export const MAX_EVENT_FIELDS = 64;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 2048;

export const BITRIX_DEAL_EVENTS = ['ONCRMDEALADD', 'ONCRMDEALUPDATE'] as const;
export type BitrixDealEvent = (typeof BITRIX_DEAL_EVENTS)[number];
/** Phase 6: Lead events (crm/leads/events/on-crm-lead-add|update). Never mixed with Deal events. */
export const BITRIX_LEAD_EVENTS = ['ONCRMLEADADD', 'ONCRMLEADUPDATE'] as const;
export type BitrixLeadEvent = (typeof BITRIX_LEAD_EVENTS)[number];
export const BITRIX_EVENTS = [...BITRIX_DEAL_EVENTS, ...BITRIX_LEAD_EVENTS] as const;
export type BitrixEvent = (typeof BITRIX_EVENTS)[number];

/** The source object an event names. The event type is the only authority. */
export function sourceObjectOfEvent(event: BitrixEvent): SourceObject {
  return (BITRIX_LEAD_EVENTS as readonly string[]).includes(event) ? 'lead' : 'deal';
}

export interface BitrixEventAuth {
  applicationToken: string | null;
  memberId: string | null;
  domain: string | null;
}

export interface BitrixDealEventInput {
  event: BitrixDealEvent;
  dealId: number;
  ts: number;
}

/** Phase 6: any accepted event; `sourceId` is a Deal ID or a Lead ID according to `sourceObject`. */
export interface BitrixEventInput {
  event: BitrixEvent;
  sourceObject: SourceObject;
  sourceId: number;
  ts: number;
}

export type FormParseResult =
  | { ok: true; fields: Map<string, string> }
  | { ok: false; reason: 'malformed' | 'too_many_fields' };

/** Bounded x-www-form-urlencoded parse. Duplicate keys are rejected (no parameter pollution). */
export function parseFormBody(body: string): FormParseResult {
  if (body.length === 0) return { ok: false, reason: 'malformed' };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const fields = new Map<string, string>();
  let count = 0;
  for (const [key, value] of params) {
    count += 1;
    if (count > MAX_EVENT_FIELDS) return { ok: false, reason: 'too_many_fields' };
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) {
      return { ok: false, reason: 'malformed' };
    }
    if (fields.has(key)) return { ok: false, reason: 'malformed' };
    fields.set(key, value);
  }
  return { ok: true, fields };
}

const authValue = z.string().trim().min(1).max(256);

export function readEventAuth(fields: Map<string, string>): BitrixEventAuth {
  const pick = (key: string) => {
    const parsed = authValue.safeParse(fields.get(key));
    return parsed.success ? parsed.data : null;
  };
  return {
    applicationToken: pick('auth[application_token]'),
    memberId: pick('auth[member_id]'),
    domain: pick('auth[domain]'),
  };
}

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

const EventSchema = z.object({
  event: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(BITRIX_EVENTS)),
  sourceId: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(MAX_SAFE_ID)),
  ts: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
});

/** Deal or Lead event; anything else (other entities, unknown names, bad IDs) is null. */
export function readBitrixEvent(fields: Map<string, string>): BitrixEventInput | null {
  const parsed = EventSchema.safeParse({
    event: fields.get('event'),
    sourceId: fields.get('data[FIELDS][ID]'),
    ts: fields.get('ts'),
  });
  if (!parsed.success) return null;
  const { event, sourceId, ts } = parsed.data;
  return { event, sourceObject: sourceObjectOfEvent(event), sourceId, ts };
}

/** Deal events only (Phase 2-5 shape). */
export function readDealEvent(fields: Map<string, string>): BitrixDealEventInput | null {
  const event = readBitrixEvent(fields);
  if (!event || event.sourceObject !== 'deal') return null;
  return { event: event.event as BitrixDealEvent, dealId: event.sourceId, ts: event.ts };
}
