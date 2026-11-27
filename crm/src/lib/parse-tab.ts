/**
 * One rule for reading a `?tab=` (or `?view=`, `?filter=`) value from the
 * address (CQ-10). Replaces the local parsers slice by slice.
 *
 * - An array (the value given twice) uses its first entry, as the browser does.
 * - A value that is not in `allowed` (unknown, misspelt, or a tab this viewer
 *   may not open) gives `fallback`. Matching is exact: no trimming or case change,
 *   so every address that works today keeps meaning the same tab.
 */
export function parseTab<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
