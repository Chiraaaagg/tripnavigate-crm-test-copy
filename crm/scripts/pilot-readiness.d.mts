// Type declarations for pilot-readiness.mjs (the project typechecks with allowJs=false).

export declare const SELECTION_REPORT_KIND: string;
export declare const SELECTION_REPORT_VERSION: number;
export declare const GATES: readonly GateName[];
export declare const STATUSES: readonly GateStatus[];
export declare const EXCLUSION_REASONS: readonly string[];
export declare const FOOTER: string;
export declare const APPROVED_BUSINESS_DATES: readonly string[];

export type GateName =
  | 'portal_identity'
  | 'form_evidence'
  | 'manifest'
  | 'staff_mapping'
  | 'destination'
  | 'recovery'
  | 'invitations'
  | 'release';

export type GateStatus = 'missing' | 'provided_unverified' | 'verified' | 'skipped_by_owner' | 'blocked';

export interface Gate {
  gate: GateName;
  status: GateStatus;
  reason: string;
}

export interface ReadinessResult {
  gates: Gate[];
  overall: 'ready' | 'not_ready';
}

export declare class ReadinessError extends Error {
  constructor(code: string);
  code: string;
}

export interface ParsedSelectionReport {
  portalDomain: string;
  memberIdStatus: 'verified' | 'unverified' | 'provided_unverified';
  businessDate: string;
  dayStatus: 'open' | 'closed';
  selected: Array<{ id: string; assignedById: string | null }>;
  manifest: { sha256: string; expectedCount: number } | null;
}

export declare function parseSelectionReport(value: unknown): ParsedSelectionReport;
export declare function parseStaffMapping(value: unknown): Set<string>;
export declare function sha256Hex(bytes: Uint8Array | string): string;

export declare function evaluateReadiness(input?: {
  reports?: unknown[];
  manifests?: Array<{ sha256: string; data: unknown }>;
  mapping?: unknown;
  env?: { PRODUCTION_SUPABASE_PROJECT_REF?: string | boolean | undefined };
  /** Requested IST business days; default (or empty) = APPROVED_BUSINESS_DATES. */
  days?: readonly string[];
}): ReadinessResult;

export declare function parseBusinessDates(days: readonly string[]): string[];

export declare function formatReadiness(
  result: ReadinessResult,
  options?: { reportCount?: number; manifestCount?: number; mappingGiven?: boolean; dayCount?: number },
): string;

export declare function parseArgs(argv: string[]): { reports: string[]; manifests: string[]; mapping: string | null; days: string[] };
export declare function runCli(argv: string[], processEnv: Record<string, string | undefined>): string;
