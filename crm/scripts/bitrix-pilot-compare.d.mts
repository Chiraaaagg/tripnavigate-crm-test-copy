// Type declarations for bitrix-pilot-compare.mjs (the project typechecks with allowJs=false).
import type { ParsedManifest } from './bitrix-lead-manifest.mjs';

export interface CompareCrmInput {
  deals: Array<Record<string, unknown>>;
  mappings: Array<{ bitrix_user_id: number | string; staff_user_id: string; active: boolean }>;
  inbox: Array<{ source_deal_id?: number | string; source_id?: number | string; status: string; reason_code?: string | null; origin?: string | null }>;
  config: Record<string, unknown> & { eligible_stage_ids?: string[] };
}

export interface CompareLeadCrmInput extends Omit<CompareCrmInput, 'deals'> {
  leads: Array<Record<string, unknown>>;
  manifest: Pick<ParsedManifest, 'interval' | 'sourceCode'>;
}

export interface CompareRow {
  id: string;
  inBitrix: boolean;
  inCrm: boolean;
  /** Number of CRM rows for this Bitrix record (more than one = duplicate_in_crm). */
  crmRows: number;
  ownerMapped?: boolean;
  reviewReasons?: Array<string | null>;
  inbox: Array<{ status: string; reasonCode: string | null; origin: string | null }>;
  /** Deals: eligible by intake config. Leads: inside the manifest source code and interval. */
  eligibleByConfig?: boolean;
  checks?: Record<string, boolean>;
  crmBehindBitrix?: boolean;
  verdict:
    | 'match'
    | 'mismatch'
    | 'crm_behind_bitrix'
    | 'missing_in_bitrix'
    | 'expected_but_missing_in_crm'
    | 'not_imported_as_expected'
    | 'needs_review'
    | 'duplicate_in_crm';
  [key: string]: unknown;
}

export declare function compareDeals(ids: string[], bitrixRows: Array<Record<string, unknown>>, crm: CompareCrmInput): CompareRow[];
export declare function compareLeads(ids: string[], bitrixRows: Array<Record<string, unknown>>, crm: CompareLeadCrmInput): CompareRow[];

export interface CompareSummary {
  total: number;
  byVerdict: Partial<Record<CompareRow['verdict'], number>>;
  pass: boolean;
}

export interface CompareCoverage {
  pages: number;
  expected: number;
  compared: number;
  missing: number;
  repeated: number;
  unexpected: number;
  complete: boolean;
}

export declare class ComparatorError extends Error {
  constructor(code: string);
  code: string;
}

export declare function checkActiveManifest(
  fileManifest: ParsedManifest,
  active: unknown,
  config?: { id: string; portal_member_id: string; portal_domain: string },
): { manifestId: string | null };
export declare const COMPARE_PAGE_SIZE: number;
export declare const MAX_COMPARE_IDS: number;
export declare function parseApprovedIds(value: unknown): string[];
export declare function pageIds(ids: string[], size?: number): string[][];
export declare function summarize(rows: CompareRow[], approvedIds: string[]): CompareSummary;
export declare function coverage(pages: CompareRow[][], expectedIds: string[]): CompareCoverage;
export declare function loadExpected(input: {
  object: 'lead' | 'deal';
  approvedFile?: string;
  manifestFile?: string;
  readFile: (file: string) => string;
}): { ids: string[]; manifest: ParsedManifest | null };
