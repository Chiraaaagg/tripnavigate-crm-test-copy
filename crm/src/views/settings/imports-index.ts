import type { ViewerAccess } from '@/modules/access/policy';
import { IMPORT_ACCESS_TEXT, importEntity, rateSheetEntity } from '@/modules/parties/import-access';
import { IMPORT_KIND_LABEL, IMPORT_KINDS, type ImportKind } from '@/modules/parties/import-mapping';
import { SETTINGS_PATH } from '@/modules/settings/contracts';

/*
 * Settings › Imports index (UX redesign R1). Pure: which lists exist, what
 * each one does, and whether this person may import it (the same
 * application mirror the pages use; the database checks every step again).
 * Unit-tested in tests/unit/r1-imports-index.test.ts.
 */

export interface ImportIndexRow {
  kind: ImportKind | 'rate_sheet';
  label: string;
  line: string;
  href: string;
  /** null: this person may import it. */
  blockedText: string | null;
}

const LINE: Record<ImportKind | 'rate_sheet', string> = {
  hotel: 'Add or update the stored hotels.',
  customer: 'Add or update the stored customers, for one branch.',
  supplier: 'Add or update the stored suppliers.',
  rate_sheet: 'Rate contracts from a supplier’s rate sheet; each one starts as a draft for a Manager to approve.',
};

export const IMPORTS_INDEX_LABEL = 'All imports';

/** The address of one list's page (unchanged ?kind= addresses). */
export function importKindHref(kind: ImportKind | 'rate_sheet'): string {
  return `${SETTINGS_PATH.imports}?kind=${kind}`;
}

/**
 * One row per list. Hotels, customers and suppliers are always listed (their
 * pages open read only for others, as before); rate sheets only for people
 * who may use them (Purchase or a Super Admin), as the kind tabs did.
 */
export function importIndexRows(access: ViewerAccess): ImportIndexRow[] {
  const rows: ImportIndexRow[] = IMPORT_KINDS.map((kind) => {
    const choice = importEntity(access, kind);
    return {
      kind,
      label: IMPORT_KIND_LABEL[kind],
      line: LINE[kind],
      href: importKindHref(kind),
      blockedText: choice.ok ? null : choice.reason === 'several' ? IMPORT_ACCESS_TEXT.several : IMPORT_ACCESS_TEXT.no_access[kind],
    };
  });
  const sheet = rateSheetEntity(access);
  if (sheet.ok || sheet.reason === 'several') {
    rows.push({ kind: 'rate_sheet', label: 'Rate sheets', line: LINE.rate_sheet, href: importKindHref('rate_sheet'), blockedText: sheet.ok ? null : IMPORT_ACCESS_TEXT.several });
  }
  // Lists this person may import come first, in the usual order.
  return [...rows.filter((r) => r.blockedText === null), ...rows.filter((r) => r.blockedText !== null)];
}

/** The ?kind= of the Imports page: a list, or the index (no value, or a value that is not a list). */
export function parseImportKind(raw: unknown): ImportKind | 'rate_sheet' | 'index' {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'rate_sheet') return 'rate_sheet';
  return (IMPORT_KINDS as readonly string[]).includes(typeof value === 'string' ? value : '') ? (value as ImportKind) : 'index';
}
