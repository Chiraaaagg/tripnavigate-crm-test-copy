// Type declarations for bitrix-lead-manifest.mjs (the project typechecks with allowJs=false).
import type { ReadOnlyCaller } from './bitrix-pilot-inspect.mjs';

export declare const MANIFEST_KIND: string;
export declare const MANIFEST_VERSION: number;
export declare const MANIFEST_TIMEZONE: string;
export declare const MAX_MANIFEST_IDS: number;
export declare const MAX_SELECTION_PAGES: number;
export declare const SELECTION_SELECT: readonly string[];
export declare const REPOSITORY_ROOT: string;
export declare const SOURCE_CODE: RegExp;

export declare class ManifestError extends Error {
  constructor(code: string);
  code: string;
}

export interface ManifestInterval {
  from: string;
  to: string;
}

export declare function istInterval(businessDate: unknown): ManifestInterval;
export declare function parseSourceCode(value: unknown): string;
export declare function selectionFilter(interval: ManifestInterval, sourceCode: string): Record<string, string>;

export declare function selectLeadIds(
  caller: Pick<ReadOnlyCaller, 'call'>,
  options: { interval: ManifestInterval; sourceCode: string; maxPages?: number },
): Promise<{ ids: string[]; total: number; pages: number; filter: Record<string, string> }>;

export interface ManifestFile {
  kind: string;
  version: number;
  sourceSystem: 'bitrix';
  sourceObject: 'lead' | 'deal';
  portalDomain: string;
  memberId: string;
  selectedAt: string;
  businessDate: string;
  timezone: string;
  interval: ManifestInterval & { bounds: '[)' };
  sourceCode: string;
  filter: Record<string, string>;
  expectedCount: number;
  ids: string[];
}

export declare function buildManifest(input: {
  portalDomain: string;
  memberId: string;
  businessDate: string;
  sourceCode: string;
  interval: ManifestInterval;
  filter: Record<string, string>;
  ids: string[];
  selectedAt: string;
}): ManifestFile;

export interface ParsedManifest {
  sourceObject: 'lead' | 'deal';
  portalDomain: string;
  memberId: string;
  businessDate: string;
  interval: ManifestInterval;
  sourceCode: string;
  expectedCount: number;
  ids: string[];
}

export declare function parseManifest(value: unknown, options?: { sourceObject?: 'lead' | 'deal' }): ParsedManifest;
export declare function assertPrivateOutputPath(out: unknown, options?: { repositoryRoot?: string }): string;
export declare function writeManifest(path: string, manifest: ManifestFile): void;
