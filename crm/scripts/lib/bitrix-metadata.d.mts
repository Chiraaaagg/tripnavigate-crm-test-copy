// Type declarations for bitrix-metadata.mjs (the project typechecks with allowJs=false).

export declare const METADATA_METHODS: readonly string[];

export declare class MetadataError extends Error {
  constructor(code: string);
  code: string;
}

export interface MetadataCategory {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface MetadataStage {
  statusId: string;
  name: string;
  sort: number;
  semantics: string | null;
}

export interface MetadataField {
  code: string;
  type: string;
  title: string;
  isRequired: boolean;
  isReadOnly: boolean;
  isMultiple: boolean;
}

export interface BitrixMetadata {
  categories: MetadataCategory[];
  stagesByCategory: Record<string, MetadataStage[]>;
  dealFields: MetadataField[];
}

export declare function resolveBaseUrl(raw: string | undefined, portalDomain: string | undefined, appEnv: string | undefined): string;
export declare function redact(text: string, secrets: Array<string | undefined>): string;
export declare function inspectMetadata(baseUrl: string, fetchImpl?: typeof fetch): Promise<BitrixMetadata>;
export declare function formatMetadata(metadata: BitrixMetadata): string;

export declare const USER_METHODS: readonly string[];
export interface MetadataUser {
  id: string;
  name: string;
  email: string;
  active: boolean;
}
export declare function inspectUsers(baseUrl: string, fetchImpl?: typeof fetch): Promise<MetadataUser[]>;
export declare function formatUsers(users: MetadataUser[]): string;
