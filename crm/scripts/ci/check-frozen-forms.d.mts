// Type declarations for check-frozen-forms.mjs (the project typechecks with allowJs=false).

export interface FrozenFormsSlice {
  note?: string;
  allow?: string[];
  deletes?: string[];
}

export interface FrozenFormsConfig {
  currentSlice?: string;
  frozen: string[];
  importedByForms?: string[];
  guard?: string[];
  notFrozen?: string[];
  slices: Record<string, FrozenFormsSlice>;
}

export declare const CONFIG_PATH: string;
export declare function loadConfig(path?: string): FrozenFormsConfig;
export declare function globToRegExp(glob: string): RegExp;
export declare function normalisePath(path: string): string;
export declare function frozenPatterns(config: FrozenFormsConfig): string[];
export declare function isFrozen(path: string, config: FrozenFormsConfig): boolean;
export declare function checkFrozen(
  changedPaths: readonly string[],
  config: FrozenFormsConfig,
  slice: string,
  isDeleted?: (path: string) => boolean,
): string[];
export declare function sliceProblems(config: FrozenFormsConfig, slice: string, existsNow: (path: string) => boolean): string[];
export declare const CONFIG_REL: string;
export declare function configChangeProblems(baseConfig: FrozenFormsConfig, headConfig: FrozenFormsConfig): string[];
export declare function applyConfigRule(
  refused: readonly string[],
  changedPaths: readonly string[],
  baseConfig: FrozenFormsConfig | null,
  headConfig: FrozenFormsConfig,
): string[];
export declare function exceptionLines(config: FrozenFormsConfig, slice: string): string[];
export declare function repoRoot(cwd?: string): string;
export declare function defaultBase(cwd?: string): string;
export declare function diffRange(base: string, cwd?: string): string;
export declare function startCommit(base: string, cwd?: string): string;
export declare function changedFiles(base: string, cwd?: string): string[];
export declare function existsInCommit(commit: string, path: string, cwd?: string): boolean;
export declare function readInCommit(commit: string, path: string, cwd?: string): string | null;
export declare function existsNow(path: string): boolean;
export declare function parseArgs(argv: readonly string[]): { slice: string | null; base: string | null; files: string[] | null };
