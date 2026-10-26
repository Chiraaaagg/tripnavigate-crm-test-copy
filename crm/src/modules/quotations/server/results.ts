import 'server-only';
import { type QuotationActionResult, type QuotationChecklistCode, type QuotationErrorCode, QUOTATION_ERROR_TEXT } from '../contracts';
import { issuesFromHint, QuotationCommandError } from '../commands';

/**
 * Result helpers for the quotation actions. Refusals carry the frozen
 * QUOTATION_ERROR_TEXT wording, the form fields named by the database hint
 * (input keys only, mapped to form names; never database text) and, for
 * not_ready, the blocking issue codes. A failure the database did not
 * explain is rethrown as a retry message, because the command may have run.
 */

// DA-288 (G-05)
export const UNKNOWN_QUOTATION_OUTCOME = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

export function qfail(code: QuotationErrorCode | 'session' | 'upload_failed', fields?: string[], message?: string): QuotationActionResult<never> {
  return { ok: false, code, message: message ?? QUOTATION_ERROR_TEXT[code], ...(fields && fields.length > 0 ? { fields: [...new Set(fields)] } : {}) };
}

/** "lines[2].unitKind" → "lineUnitKind[1]" style when the map names the base key; else the mapped base key. */
export function hintFields(keys: readonly string[], map: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const m = /^([A-Za-z]+)\[(\d+)\](?:\.([A-Za-z]+))?$/.exec(key);
    if (m) {
      const [, list, n, sub] = m;
      const mapped = map[`${list}.${sub ?? ''}`] ?? map[list!];
      if (mapped) {
        // Database list positions are 1-based; form inputs are 0-based.
        out.push(`${mapped}[${Math.max(0, Number(n) - 1)}]`);
        continue;
      }
      out.push(list!);
      continue;
    }
    const base = key.replace(/\..*$/, '');
    out.push(map[key] ?? map[base] ?? base);
  }
  return [...new Set(out)];
}

export function qfailFrom(error: unknown, hintMap?: Readonly<Record<string, string>>): QuotationActionResult<never> {
  if (error instanceof QuotationCommandError && error.code) {
    if (error.code === 'not_ready') {
      const issues: QuotationChecklistCode[] = issuesFromHint(error.hintKeys);
      return { ok: false, code: 'not_ready', message: QUOTATION_ERROR_TEXT.not_ready, ...(issues.length > 0 ? { issues } : {}) };
    }
    const fields = error.code === 'invalid_input' || error.code === 'internal_wording' || error.code === 'valid_until_past' ? hintFields(error.hintKeys, hintMap) : undefined;
    return qfail(error.code, fields);
  }
  throw new Error(UNKNOWN_QUOTATION_OUTCOME);
}
