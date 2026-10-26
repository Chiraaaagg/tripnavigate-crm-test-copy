// Type declarations for test-env.mjs (the project typechecks with allowJs=false).

type Env = Record<string, string | undefined>;

export declare const LOOPBACK_HOSTS: ReadonlySet<string>;
export declare function isLoopbackUrl(value: string | undefined | null): boolean;
export declare function isLoopbackDatabaseUrl(value: string | undefined | null): boolean;
export declare const TEST_URL_VARIABLES: readonly string[];
export declare const LOOPBACK_DEFAULTS: Readonly<Record<string, string>>;
export declare class TestIsolationError extends Error {}
export declare function assertLoopbackTestEnv(env: Env): void;
export declare function loopbackTestEnv(env?: Env): Record<string, string>;
export declare function nextServerTestEnv(overrides: Record<string, string>, env?: Env): Record<string, string>;
