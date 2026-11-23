// Type declarations for migration-history.mjs (the project typechecks with allowJs=false).

export declare function checkMigrationHistory(input: {
  files: string[];
  baseFiles?: string[];
  changes?: Array<{ status: string; path: string; from?: string }>;
  approvedRenames?: Array<{ from: string; to: string }>;
}): { errors: string[]; warnings: string[] };
