// Type declarations for bitrix-lead-selection.mjs (the project typechecks with allowJs=false).
import type { ManifestFile, ManifestInterval } from './bitrix-lead-manifest.mjs';
import type { ReadOnlyCaller } from './bitrix-pilot-inspect.mjs';

export declare const SELECTION_REPORT_KIND: string;
export declare const SELECTION_REPORT_VERSION: number;
export declare const MAX_SELECTION_LEADS: number;
export declare const MAX_LEAD_PAGES: number;
export declare const MAX_ACTIVITY_PAGES: number;
export declare const WEBFORM_SOURCE: string;
export declare const WEBFORM_PROVIDER: string;
export declare const LEAD_OWNER_TYPE_ID: number;
export declare const DAY_LEAD_SELECT: readonly string[];
export declare const DAY_ACTIVITY_SELECT: readonly string[];
export declare const REQUIRED_ACTIVITY_FIELDS: readonly string[];
export declare const EXCLUSION_REASONS: readonly ExclusionReason[];
export declare const EVIDENCE_RULE: string;

export declare class SelectionError extends Error {
  constructor(code: string);
  code: string;
}

export type Caller = Pick<ReadOnlyCaller, 'call'>;
export type DayStatus = 'open' | 'closed';
export type ExclusionReason = 'source_not_webform' | 'no_crm_form_activity' | 'form_not_approved';

export interface DayLead {
  id: string;
  sourceId: string | null;
  created: string;
  statusId: string | null;
  assignedById: string | null;
}

export interface WebformActivity {
  id: string;
  form: string;
}

export interface SelectedLead {
  id: string;
  created: string;
  statusId: string | null;
  assignedById: string | null;
  form: string;
  activityIds: string[];
}

export interface ExcludedLead {
  id: string;
  reason: ExclusionReason;
  forms: string[];
}

export type Classification = ({ status: 'selected' } & SelectedLead) | ({ status: 'excluded' } & ExcludedLead);

export interface SelectionReport {
  kind: string;
  version: number;
  portalDomain: string;
  memberIdStatus: 'verified' | 'unverified' | 'provided_unverified';
  businessDate: string;
  timezone: string;
  interval: ManifestInterval & { bounds: '[)' };
  dayStatus: DayStatus;
  providerTime: string;
  selectionStartedAt: string;
  selectionFinishedAt: string;
  formsInScope: string[];
  evidenceRule: string;
  counts: {
    leadsInDay: number;
    selected: number;
    excluded: number;
    excludedByReason: Record<ExclusionReason, number>;
  };
  selected: SelectedLead[];
  excluded: ExcludedLead[];
  manifest: { fileName: string; sha256: string; expectedCount: number } | null;
}

export declare function parseForms(value: unknown): string[];
export declare function assertActivityMetadata(caller: Caller): Promise<void>;
export declare function readDayStatus(
  caller: Caller,
  interval: ManifestInterval,
): Promise<{ providerTime: string; dayStatus: DayStatus }>;
export declare function selectDayLeads(
  caller: Caller,
  options: { interval: ManifestInterval; maxPages?: number; maxLeads?: number },
): Promise<{ leads: DayLead[]; total: number; pages: number }>;
export declare function readLeadActivities(
  caller: Caller,
  leadId: string,
  options?: { maxPages?: number },
): Promise<WebformActivity[]>;
export declare function classifyLead(lead: DayLead, activities: WebformActivity[], formsInScope: string[]): Classification;
export declare function runSelection(
  caller: Caller,
  options: {
    portalDomain: string;
    memberId: string | null;
    businessDate: string;
    formsInScope: string[];
    now?: () => Date;
  },
): Promise<{ report: SelectionReport; manifest: ManifestFile | null; manifestSkipped: string | null }>;
export declare function buildSelectionReport(input: {
  portalDomain: string;
  memberId: string | null;
  businessDate: string;
  interval: ManifestInterval;
  dayStatus: DayStatus;
  providerTime: string;
  selectionStartedAt: string;
  selectionFinishedAt: string;
  formsInScope: string[];
  leadsInDay: number;
  selected: SelectedLead[];
  excluded: ExcludedLead[];
  manifest?: SelectionReport['manifest'];
}): SelectionReport;
export declare function sha256Hex(bytes: string | Uint8Array): string;
export declare function serializeManifest(manifest: ManifestFile): string;
export declare function writeSelectionOutputs(input: {
  reportPath: string;
  manifestPath: string | null;
  report: SelectionReport;
  manifest: ManifestFile | null;
}): SelectionReport;
export declare function formatSummary(report: SelectionReport, manifestSkipped: string | null): string;
