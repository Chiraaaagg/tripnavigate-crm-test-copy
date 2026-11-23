import type { LeadHeaderField } from './client';

/**
 * Phase 6 (contract section 2.2): maps a crm.lead.get answer (already reduced to
 * LEAD_HEADER_FIELDS by the client) to the bounded snapshot passed to
 * integration_apply_bitrix_lead. Header only: no contact, phone, e-mail,
 * comment, amount or file field is ever read.
 *
 * The database command is authoritative for validation (title <= 200, source
 * code equal to the manifest's code, creation time inside the manifest
 * interval). This mapper only coerces to strings and caps lengths so an
 * oversized provider value cannot inflate the command payload; the title cap is
 * above the 200-character rule so over-long titles still reach the database
 * check and are reported, not silently truncated into validity.
 *
 * Lead-owned contracts.ts holds the Deal snapshot; this Lead snapshot lives
 * here until the lead promotes it.
 */
export interface BitrixLeadSnapshot {
  id: string;
  title: string;
  statusId: string;
  /** Bitrix SOURCE_ID (e.g. WEBFORM); null when absent (the database then refuses the manifest scope). */
  sourceId: string | null;
  assignedById: string;
  /** ISO 8601 with offset, as returned by Bitrix. */
  dateCreate: string;
  dateModify: string;
}

const MAX_TITLE_CHARS = 1_000;
const MAX_CODE_CHARS = 100;

function str(value: unknown, max: number): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  return '';
}

export function toLeadSnapshot(raw: Partial<Record<LeadHeaderField, unknown>>): BitrixLeadSnapshot {
  return {
    id: str(raw.ID, 20),
    title: str(raw.TITLE, MAX_TITLE_CHARS),
    statusId: str(raw.STATUS_ID, MAX_CODE_CHARS),
    sourceId: typeof raw.SOURCE_ID === 'string' && raw.SOURCE_ID.length > 0 ? raw.SOURCE_ID.slice(0, MAX_CODE_CHARS) : null,
    assignedById: str(raw.ASSIGNED_BY_ID, 20),
    dateCreate: str(raw.DATE_CREATE, 40),
    dateModify: str(raw.DATE_MODIFY, 40),
  };
}
