import { CUSTOMER_VIEW_FORBIDDEN_KEY } from './contracts';

/**
 * Leak guard: every key path (any depth) of a customer view or document input
 * whose key name is a forbidden commercial / internal word. Empty = clean. Pure.
 */
export function forbiddenKeyPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeyPaths(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [...(CUSTOMER_VIEW_FORBIDDEN_KEY.test(k) ? [here] : []), ...forbiddenKeyPaths(v, here)];
  });
}
