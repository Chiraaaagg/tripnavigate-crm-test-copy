import type { Acc3AccountsSettingsEntity } from '@/views/accounts-desk/acc3-settings';
import type { Acc3DailyCheckExtra } from '@/views/accounts-desk/acc3-daily-check';
import type { DealDocs, DocListRow, DocRow } from '@/views/customer-documents/types';
import { ADV_DRAFT, ADV_RELEASED, DEAL_DOCS, DEAL_ID, INV_DRAFT, INV_RELEASED, LIST_ROWS, MANAGER_DOCS, SALES_DOCS } from './acc2-docs-fixtures';

/*
 * Synthetic fixtures for the Accounts phase 3 automatic bills states
 * (acc3-bills-): Phase 2 document rows from acc2-docs-fixtures with the
 * automatic keys of contract 6.5 added. Names, references and amounts are
 * invented; nothing here is real.
 */

export { DEAL_ID };

export const AUTO_ON = { drafts: true, release: true } as const;
export const AUTO_RELEASE_OFF = { drafts: true, release: false } as const;

/** Advance Invoice the CRM made and held: billing not verified and an open refund. */
export const ADV_HELD: DocRow = { ...ADV_DRAFT, autoRule: 'adv_on_receipt', autoState: 'held', holdReasons: ['billing_not_verified', 'refund_open'] };
/** Invoice the CRM made, every check passed (waits while automatic release is off). */
export const INV_READY: DocRow = { ...INV_DRAFT, autoRule: 'inv_on_approval', autoState: 'ready', holdReasons: [] };
/** Replacement Invoice held: a newer booking version waits and the company GST number is a placeholder. */
export const INV_HELD_MANY: DocRow = {
  ...INV_DRAFT,
  documentId: 'a0002207-0000-4000-8000-000000002207',
  replacesNumber: '10101-INV-2',
  autoRule: 'inv_replace_on_change',
  autoState: 'held',
  holdReasons: ['newer_version_waiting', 'company_identity_missing', 'amount_mismatch', 'some_new_code'],
};
/** Released by the CRM. */
export const ADV_BY_CRM: DocRow = { ...ADV_RELEASED, releasedByName: null, releasedByCrm: true, autoRule: 'adv_on_receipt' };
export const INV_BY_CRM: DocRow = { ...INV_RELEASED, releasedByName: null, releasedByCrm: true, autoRule: 'inv_on_approval' };

export const DEAL_AUTO: DealDocs = {
  ...DEAL_DOCS,
  billing: { verified: false, missing: false },
  candidates: { advances: [], invoice: null, creditNotes: [] },
  documents: [ADV_HELD, INV_BY_CRM, ADV_BY_CRM],
  autoBills: AUTO_ON,
};
export const DEAL_AUTO_READY: DealDocs = {
  ...DEAL_DOCS,
  candidates: { advances: [], invoice: null, creditNotes: [] },
  documents: [INV_READY, ADV_BY_CRM],
  autoBills: AUTO_RELEASE_OFF,
};
export const DEAL_AUTO_READY_RELEASE_ON: DealDocs = { ...DEAL_AUTO_READY, autoBills: AUTO_ON };
export const DEAL_AUTO_MANY: DealDocs = {
  ...DEAL_DOCS,
  candidates: { advances: [], invoice: null, creditNotes: [] },
  documents: [INV_HELD_MANY, INV_BY_CRM, ADV_BY_CRM],
  autoBills: AUTO_ON,
};
const strip = (d: DocRow): DocRow => ({ ...d, releasedByName: null, endReason: null });
export const SALES_AUTO: DealDocs = { ...SALES_DOCS, documents: [strip(INV_BY_CRM), strip(ADV_BY_CRM), ...SALES_DOCS.documents.slice(1, 2)], autoBills: AUTO_ON };
export const MANAGER_AUTO: DealDocs = { ...MANAGER_DOCS, documents: [INV_BY_CRM, ADV_BY_CRM], autoBills: AUTO_ON };

function listRow(d: DocRow, ref: string, branch = 'Jodhpur', id?: string): DocListRow {
  return { ...d, documentId: id ?? d.documentId, dealId: DEAL_ID, dealReference: ref, branchName: branch };
}
/** Bills to check: held automatic drafts, oldest first. */
export const TO_CHECK_ROWS: DocListRow[] = [
  listRow({ ...INV_HELD_MANY, createdAt: '2026-11-09T06:00:00Z' }, 'SYN-JOD-101'),
  listRow({ ...ADV_HELD, createdAt: '2026-11-11T09:30:00Z' }, 'SYN-DEL-044', 'Delhi', 'a0002281-0000-4000-8000-000000002281'),
  listRow({ ...ADV_HELD, holdReasons: ['number_conflict'], createdAt: '2026-11-12T11:15:00Z' }, 'BX-AHD-0031', 'Ahmedabad', 'a0002282-0000-4000-8000-000000002282'),
];
export const LIST_AUTO_ROWS: DocListRow[] = [
  listRow(INV_READY, 'SYN-JOD-117', 'Jodhpur', 'a0002283-0000-4000-8000-000000002283'),
  ...TO_CHECK_ROWS.slice(0, 1),
  listRow(INV_BY_CRM, 'SYN-JOD-101'),
  ...LIST_ROWS.slice(3),
];

export const SETTINGS_ENTITY: Acc3AccountsSettingsEntity = {
  entityId: 'a0000001-0000-4000-8000-000000000001',
  entityName: 'Holiday Chacha Pvt LTD',
  customerDocumentsEnabled: true,
  autoBillsEnabled: false,
  autoBillReleaseEnabled: true,
  writeOffEnabled: false,
  writeOffLimitPaise: '500000',
  tallyXmlEnabled: false,
  tallyCompanyName: null,
};
export const SETTINGS_ON: Acc3AccountsSettingsEntity = { ...SETTINGS_ENTITY, autoBillsEnabled: true, writeOffEnabled: true, writeOffLimitPaise: '250050', tallyXmlEnabled: true, tallyCompanyName: 'Holiday Chacha Pvt LTD (Copy 2026)' };
export const SETTINGS_DOCS_OFF: Acc3AccountsSettingsEntity = { ...SETTINGS_ENTITY, customerDocumentsEnabled: false, autoBillsEnabled: true };
export const SETTINGS_UNKNOWN: Acc3AccountsSettingsEntity = { ...SETTINGS_ENTITY, autoBillsEnabled: null, writeOffEnabled: null, writeOffLimitPaise: null, tallyXmlEnabled: null };

export const DAILY_EXTRA: Acc3DailyCheckExtra = {
  billsHeldOverOneWorkingDay: 2,
  customerMessagesFailedOverOneWorkingDay: 1,
  tallyFileUnmatchedOverOneWorkingDay: 14,
  messageQueueOldestMinutes: 4,
  writeOffsToReview: 1,
};
export const DAILY_EXTRA_LATE: Acc3DailyCheckExtra = { ...DAILY_EXTRA, messageQueueOldestMinutes: 135 };
export const DAILY_EXTRA_QUIET: Acc3DailyCheckExtra = {
  billsHeldOverOneWorkingDay: 0,
  customerMessagesFailedOverOneWorkingDay: 0,
  tallyFileUnmatchedOverOneWorkingDay: 0,
  messageQueueOldestMinutes: null,
  writeOffsToReview: 0,
};
