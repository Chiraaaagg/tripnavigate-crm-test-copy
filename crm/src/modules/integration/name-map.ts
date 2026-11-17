import { z } from 'zod';

/**
 * Direction A Batch 1 B1-1: Bitrix stage, status and source NAMES
 * (migration 20261121000100_bitrix_name_map). Pure shapes and parsers shared
 * by the worker (bitrix/name-refresh.ts) and the staff read
 * (server/name-map.ts). Display text only: nothing here decides a gate.
 */

/** Bitrix list ids read through crm.status.list (DEAL_STAGE = pipeline 0). */
export const NAME_LIST_ENTITY = /^(DEAL_STAGE|DEAL_STAGE_[1-9][0-9]{0,9}|STATUS|SOURCE)$/;
/** Same pattern as the stored stage, status and source codes. */
export const NAME_CODE = /^[A-Za-z0-9_:.-]{1,50}$/;
/** Longest stored name (the database cuts longer names to this). */
export const NAME_MAX_LENGTH = 120;
/** Items per list the database accepts. */
export const NAME_LIST_MAX_ITEMS = 500;

export type NameKind = 'open' | 'won' | 'lost';

/** One item as sent to integration_apply_bitrix_names (only these four keys ever leave Bitrix's answer). */
export interface NameListItem {
  code: string;
  name: string;
  sort: number;
  kind: NameKind | null;
}

export interface NameList {
  entityId: string;
  items: NameListItem[];
}

/** The Bitrix list of a pipeline: 0 is DEAL_STAGE, n is DEAL_STAGE_n. */
export function stageEntityForPipeline(pipelineId: number): string {
  return pipelineId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${pipelineId}`;
}

/** Removes control characters, trims and bounds a Bitrix name (null when nothing is left). */
export function cleanBitrixName(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const cleaned = String(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, NAME_MAX_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Reduces one crm.status.list page to STATUS_ID, NAME, SORT and SEMANTICS.
 * Every other field of Bitrix's answer is dropped here. Bad codes, empty names
 * and duplicate codes are skipped. kind is kept for stage lists only
 * (SEMANTICS S = won, F = lost, otherwise open).
 */
export function parseStatusList(entityId: string, raw: unknown): NameListItem[] {
  const stage = entityId.startsWith('DEAL_STAGE');
  const out: NameListItem[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    const code = typeof s.STATUS_ID === 'string' || typeof s.STATUS_ID === 'number' ? String(s.STATUS_ID).trim() : '';
    if (!NAME_CODE.test(code) || seen.has(code)) continue;
    const name = cleanBitrixName(s.NAME);
    if (name === null) continue;
    const sortNumber = Number(s.SORT);
    const sort = Number.isFinite(sortNumber) ? Math.max(-2147483648, Math.min(2147483647, Math.trunc(sortNumber))) : 0;
    const kind: NameKind | null = stage ? (s.SEMANTICS === 'S' ? 'won' : s.SEMANTICS === 'F' ? 'lost' : 'open') : null;
    seen.add(code);
    out.push({ code, name, sort, kind });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Staff read: public.bitrix_name_map()
// ---------------------------------------------------------------------------

const NameRowSchema = z.object({
  entityId: z.string().regex(NAME_LIST_ENTITY),
  code: z.string().regex(NAME_CODE),
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  kind: z.enum(['open', 'won', 'lost']).nullable(),
  missing: z.boolean(),
});

const NameMapSchema = z.object({
  enabled: z.boolean(),
  readAt: z.string().nullable(),
  names: z.array(NameRowSchema),
});

export interface BitrixNameRow {
  entityId: string;
  code: string;
  name: string;
  kind: NameKind | null;
  /** The code is no longer in the Bitrix list; the name is the last one read. */
  missing: boolean;
}

/**
 * What the screens get. 'switched_off' also covers a database that answers
 * enabled:false; 'list_unreadable' is any failure (never shown as off, never
 * as an empty list); 'not_installed' is a database without the function.
 */
export type BitrixNameMapView =
  | { state: 'switched_off' }
  | { state: 'list_unreadable' }
  | { state: 'not_installed' }
  | { state: 'on'; readAt: string | null; names: BitrixNameRow[] };

/** Parses the read's reply into the view (allowlisted keys only). Malformed = list_unreadable. */
export function toBitrixNameMapView(data: unknown): BitrixNameMapView {
  const parsed = NameMapSchema.safeParse(data);
  if (!parsed.success) return { state: 'list_unreadable' };
  if (!parsed.data.enabled) return { state: 'switched_off' };
  return {
    state: 'on',
    readAt: parsed.data.readAt,
    names: parsed.data.names.map((n) => ({ entityId: n.entityId, code: n.code, name: n.name, kind: n.kind, missing: n.missing })),
  };
}

// ---------------------------------------------------------------------------
// Worker command replies
// ---------------------------------------------------------------------------

export const NamesDueSchema = z.union([
  z.object({
    due: z.literal(true),
    pipelineIds: z.array(z.number().int().min(0)),
    // Voice-note batch (20261128000100): answered only while the trip details
    // switch is on; absent = the stage / status / source lists only.
    statusLists: z.boolean().optional(),
    destinations: z.boolean().optional(),
  }),
  z.object({ due: z.literal(false), reason: z.enum(['switched_off', 'fresh', 'recently_attempted']) }),
]);
export type NamesDue = z.infer<typeof NamesDueSchema>;

export const NamesApplySchema = z.union([
  z.object({
    applied: z.literal(true),
    lists: z.number().int(),
    added: z.number().int(),
    renamed: z.number().int(),
    missing: z.number().int(),
    restored: z.number().int(),
    dropped: z.number().int(),
  }),
  z.object({ applied: z.literal(false), reason: z.literal('switched_off') }),
]);
export type NamesApply = z.infer<typeof NamesApplySchema>;

/** Switch command reply (integration_set_bitrix_name_read). */
export const NameReadSwitchSchema = z.object({ changed: z.boolean(), enabled: z.boolean() });
export type NameReadSwitchResult = z.infer<typeof NameReadSwitchSchema>;

// ---------------------------------------------------------------------------
// Switch state for the Bitrix sync page (DEC-55): public.bitrix_name_read_state()
// ---------------------------------------------------------------------------

export const NAME_READ_REASON = { min: 10, max: 500 } as const;

const LastChangeSchema = z.object({
  at: z.string().min(1),
  byName: z.string().min(1).max(200).nullable(),
  via: z.enum(['command', 'api', 'direct_sql']).nullable().catch(null),
  to: z.boolean().nullable().catch(null),
  reason: z.string().max(500).nullable(),
});
const StateSchema = z.object({
  enabled: z.boolean(),
  connectionEnabled: z.boolean(),
  effective: z.boolean(),
  canSwitch: z.boolean(),
  lastChange: LastChangeSchema.nullable(),
});

export interface NameReadLastChange {
  at: string;
  /** Display name of the person; null = a database-level change (no person). */
  byName: string | null;
  via: 'command' | 'api' | 'direct_sql' | null;
  /** The value set by that change. */
  to: boolean | null;
  reason: string | null;
}

/**
 * 'known': from the database. enabled = the switch; connectionEnabled = the
 * Bitrix connection; effective = both (names are shown on screens only then;
 * say "On, but the Bitrix connection is off: codes are shown" when enabled
 * and not effective). 'unknown': anything else (refused, failed, not
 * configured, older database): the screen says Unknown, never Off.
 */
export type NameReadStateView =
  | {
      state: 'known';
      enabled: boolean;
      connectionEnabled: boolean;
      effective: boolean;
      canSwitch: boolean;
      lastChange: NameReadLastChange | null;
    }
  | { state: 'unknown'; reason: 'not_authorized' | 'not_configured' | 'not_installed' | 'failed' };

export function toNameReadStateView(data: unknown): NameReadStateView {
  const parsed = StateSchema.safeParse(data);
  if (!parsed.success) return { state: 'unknown', reason: 'failed' };
  const { enabled, connectionEnabled, effective, canSwitch, lastChange } = parsed.data;
  return {
    state: 'known',
    enabled,
    connectionEnabled,
    effective,
    canSwitch,
    lastChange: lastChange
      ? { at: lastChange.at, byName: lastChange.byName, via: lastChange.via, to: lastChange.to, reason: lastChange.reason }
      : null,
  };
}

/** Normalises a typed reason (spaces collapsed); null when outside 10-500 characters. */
export function normaliseNameReadReason(raw: unknown): string | null {
  const reason = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return reason.length >= NAME_READ_REASON.min && reason.length <= NAME_READ_REASON.max ? reason : null;
}
