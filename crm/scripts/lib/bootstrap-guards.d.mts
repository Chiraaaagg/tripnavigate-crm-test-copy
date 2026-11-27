// Type declarations for bootstrap-guards.mjs (the project typechecks with allowJs=false).

export declare const APP_ENVS: readonly string[];

export declare class BootstrapGuardError extends Error {
  constructor(errors: string[]);
  errors: string[];
}

export interface BootstrapArgs {
  email?: string;
  displayName?: string;
  branchCode?: string;
  confirmProjectRef?: string;
}

export interface BootstrapPlan {
  appEnv: string;
  supabaseUrl: string;
  projectRef: string;
  email: string;
  displayName: string;
  branchCode: string;
  operator: string;
  redirectTo: string;
}

export declare function parseBootstrapArgs(argv: string[]): BootstrapArgs;
export declare function projectRefFromUrl(url: string): string | null;
export declare function isReservedEmailDomain(email: string): boolean;
export declare function validateBootstrap(
  args: BootstrapArgs,
  env: Record<string, string | undefined>,
): BootstrapPlan;
export declare function redact(message: unknown, secrets: Array<string | undefined>): string;
export declare function decideBootstrap(
  existingAdminEmails: string[],
  email: string,
): 'create' | 'already_admin' | 'refuse';
