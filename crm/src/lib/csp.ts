/**
 * Nonce-based Content Security Policy (T14), following the Next.js 16.3 guide
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.
 *
 * Pure (no Node-only APIs) so it runs in the proxy and in unit tests.
 *
 * - Production: scripts and styles only from this origin or carrying the
 *   per-request nonce; no inline style ATTRIBUTES (views use CSS classes).
 * - Development (`next dev`): React needs 'unsafe-eval' for server error
 *   stacks, and the dev overlay injects styles without a nonce, so style-src
 *   uses 'unsafe-inline' (a nonce in the same list would make browsers ignore
 *   'unsafe-inline', so the nonce is left out of style-src in development).
 * - upgrade-insecure-requests only when the site itself is served over HTTPS,
 *   so local http://127.0.0.1 servers keep working.
 */

export const CSP_HEADER = 'Content-Security-Policy';
export const NONCE_HEADER = 'x-nonce';

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  upgradeInsecureRequests: boolean;
  /** Extra connect-src origins (the Supabase API and its Realtime websocket). */
  connectSources?: string[];
}

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** 128 random bits, base64. Unpredictable and fresh for every request. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function shouldUpgradeInsecureRequests(siteUrl: string): boolean {
  try {
    return new URL(siteUrl).protocol === 'https:';
  } catch {
    return true;
  }
}

/**
 * Origins the browser needs for Supabase Realtime (live deal refresh): the
 * Supabase API origin and the same host over ws/wss. Nothing else.
 */
export function supabaseConnectSources(supabaseUrl: string): string[] {
  try {
    const url = new URL(supabaseUrl);
    const ws = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return [url.origin, `${ws}//${url.host}`];
  } catch {
    return [];
  }
}

export function buildCspDirectives(options: CspOptions): Record<string, string[]> {
  const { nonce, isDev } = options;
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('CSP nonce must be a base64 value of at least 16 characters.');
  }
  const n = `'nonce-${nonce}'`;
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", n, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    'style-src': isDev ? ["'self'", "'unsafe-inline'"] : ["'self'", n],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(options.connectSources ?? [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  if (options.upgradeInsecureRequests) directives['upgrade-insecure-requests'] = [];
  return directives;
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  return Object.entries(buildCspDirectives(options))
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}
