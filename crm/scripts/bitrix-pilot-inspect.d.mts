// Type declarations for bitrix-pilot-inspect.mjs (the project typechecks with allowJs=false).

export declare const PILOT_READ_METHODS: readonly string[];
export declare const DEAL_SELECT: readonly string[];
export declare const USER_SELECT: readonly string[];
export declare const LEAD_SELECT: readonly string[];
export declare const ACTIVITY_SELECT: readonly string[];
export declare const ACTIVITY_FILTER_KEYS: readonly string[];
export declare const CONTRACT_DEAL_FIELDS: Readonly<Record<string, readonly string[]>>;

export declare class PilotInspectError extends Error {
  constructor(code: string);
  code: string;
}

export interface ReadOnlyCaller {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown> & { result?: unknown; next?: number; total?: number }>;
  calls: string[];
}

export declare function createReadOnlyCaller(
  baseUrl: string,
  options?: { fetchImpl?: typeof fetch; minIntervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; allowTitle?: boolean },
): ReadOnlyCaller;

export interface PilotCategoryReport {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Array<{ statusId: string; name: string; sort: number; semantics: string | null }>;
  dealTotal: number | null;
  recent: {
    count: number;
    truncated: boolean;
    createdRange: { oldest: string; newest: string } | null;
    byStage: Record<string, number>;
    byAssignee: Record<string, number>;
    newestDealIds: string[];
    newestDeals: Array<Record<string, unknown>>;
  };
}

export interface PilotReport {
  portalHost: string | undefined;
  sinceDays: number;
  since: string;
  memberId: { obtainable: boolean; note: string };
  webhook: { scope: string[] | null; license: string | null } | { error: string };
  webhookOwner: { id: string | null; admin: boolean } | { error: string };
  portalTime: string | null | { error: string };
  categories: PilotCategoryReport[];
  fieldCheck: Array<{ code: string; present: boolean; type: string | null; expected: readonly string[]; ok: boolean }>;
  dealFields: Array<{ code: string; type: string; isRequired: boolean; isMultiple: boolean; isReadOnly: boolean; label: string | null }>;
  dealFieldCount: number;
  customFieldCount: number;
  assignees: Array<{ id: string; active: boolean; departmentIds: string[] }> | { error: string; ids: string[] };
  departments: Array<{ id: string; name: string; parent: string | null }> | { error: string };
  /** Set when a required call failed; later sections are then absent. */
  aborted?: string;
  calls: string[];
}

export declare function inspectPilot(
  caller: ReadOnlyCaller,
  options?: { portalHost?: string; sinceDays?: number; maxPages?: number; now?: () => number },
): Promise<PilotReport>;

export interface WebhookShapeChecks {
  set: boolean;
  noSurroundingWhitespace: boolean;
  noQuotes: boolean;
  noInnerWhitespace: boolean;
  asciiOnly: boolean;
  parsesAsUrl: boolean;
  https: boolean;
  hostMatchesPortal: boolean;
  defaultPort: boolean;
  noUserinfoQueryHash: boolean;
  pathIsRestUserCode: boolean;
  userIdNumeric: boolean;
  codeAlphanumeric: boolean;
  codeLength16: boolean;
  trailingSlash: boolean;
}

export declare function checkWebhookShape(
  raw: string | null | undefined,
  portalDomain: string | null | undefined,
  appEnv?: string,
): { ok: boolean; checks: WebhookShapeChecks };

export declare const DIAGNOSIS: Readonly<Record<string, string>>;

export interface WebhookDiagnosis {
  calls: 1;
  method: 'server.time';
  form: 'post' | 'get';
  status: number | null;
  errorCode: string | null;
  verdict: string;
  explanation: string;
  redirectHost?: string | null;
  portalTime?: string | null;
}

export declare function diagnoseWebhook(
  baseUrl: string,
  options?: { fetchImpl?: typeof fetch; form?: 'post' | 'get' | string; timeoutMs?: number },
): Promise<WebhookDiagnosis>;
