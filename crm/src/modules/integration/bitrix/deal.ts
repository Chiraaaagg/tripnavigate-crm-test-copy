import type { BitrixDealSnapshot } from '../contracts';

/**
 * Phase 6: the Deal snapshot sent to integration_apply_bitrix_deal also carries
 * Bitrix SOURCE_ID (string, or null when absent) so the database can check the
 * manifest's verified source code. Kept here until the lead-owned
 * BitrixDealSnapshot gains the field.
 */
export type BitrixDealApplySnapshot = BitrixDealSnapshot & { sourceId: string | null; leadId: string };

/**
 * Sync completion (contract §3, §7): Bitrix LEAD_ID as digits, or '' when
 * Bitrix sends nothing, '0' or anything that is not a positive whole number.
 * The Deal apply stores it as deals.source_lead_id (empty clears it).
 */
export function toLeadIdText(value: unknown): string {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[1-9][0-9]{0,15}$/.test(text) ? text : '';
}

/**
 * Maps a crm.deal.get `result` object to the bounded BitrixDealSnapshot passed
 * to integration_apply_bitrix_deal. Only the fields Bitrix owns in Phase 2 are
 * read (contract §4): no amounts, contacts, comments or custom fields.
 *
 * The database command is authoritative for validation (§3, invalid_source_data
 * -> needs_review). This mapper only coerces to strings and caps lengths so that
 * an oversized provider value cannot inflate the command payload; the cap is
 * above the 300-character TITLE rule so over-long titles still reach the
 * database check and are reported, not silently truncated into validity.
 */

const MAX_TITLE_CHARS = 1_000;
const MAX_CODE_CHARS = 100;

function str(value: unknown, max: number): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  return '';
}

export function toDealSnapshot(raw: Record<string, unknown>): BitrixDealApplySnapshot {
  return {
    id: str(raw.ID, 20),
    sourceId: typeof raw.SOURCE_ID === 'string' && raw.SOURCE_ID.length > 0 ? raw.SOURCE_ID.slice(0, MAX_CODE_CHARS) : null,
    leadId: toLeadIdText(raw.LEAD_ID),
    title: str(raw.TITLE, MAX_TITLE_CHARS),
    stageId: str(raw.STAGE_ID, MAX_CODE_CHARS),
    categoryId: str(raw.CATEGORY_ID, 20),
    assignedById: str(raw.ASSIGNED_BY_ID, 20),
    dateCreate: str(raw.DATE_CREATE, 40),
    dateModify: str(raw.DATE_MODIFY, 40),
  };
}

const NUMERIC_ID = /^[0-9]{1,16}$/;
// Bitrix returns ISO 8601 with offset, e.g. 2026-10-01T12:30:00+05:30.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

/** Mirror of the database's shape rules, for tests and early diagnostics only. */
export function isWellFormedSnapshot(s: BitrixDealSnapshot): boolean {
  return (
    NUMERIC_ID.test(s.id) &&
    s.title.trim().length > 0 &&
    s.title.length <= 300 &&
    s.stageId.length > 0 &&
    NUMERIC_ID.test(s.categoryId) &&
    NUMERIC_ID.test(s.assignedById) &&
    ISO_WITH_OFFSET.test(s.dateCreate) &&
    ISO_WITH_OFFSET.test(s.dateModify)
  );
}

/** DATE_MODIFY as unix seconds (for integration_enqueue_reconcile), or null. */
export function toUnixSeconds(iso: unknown): number | null {
  if (typeof iso !== 'string' || !ISO_WITH_OFFSET.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
