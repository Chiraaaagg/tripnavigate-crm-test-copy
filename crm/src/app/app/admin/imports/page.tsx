import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { IMPORT_KIND_LABEL, IMPORT_KINDS, type ImportKind } from '@/modules/parties/import-mapping';
import { applyImportAction, validateImportAction } from '@/modules/parties/server/import-actions';
import { loadImportPage } from '@/modules/parties/server/import-load';
import type { B11Action } from '@/views/b11/shapes';
import { ImportView } from '@/views/settings/import-view';

export const metadata: Metadata = { title: 'Imports' };

/**
 * Settings · Imports (voice-note batch, owner item 5): the hotel list (Super
 * Admin) and the customer list (Accounts) from a CSV saved in Excel. "Check
 * file" shows the read-only summary (mapping, counts, duplicates, invalid
 * rows, proposed changes); "Import" is a separate step with a reason. The
 * database decides every step; this page only says who may use it.
 * ?kind= is allowlisted (hotel | customer).
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  const staff = await requireStaff();
  const raw = (await searchParams).kind;
  const want = Array.isArray(raw) ? raw[0] : raw;
  const kind: ImportKind = (IMPORT_KINDS as readonly string[]).includes(want ?? '') ? (want as ImportKind) : 'hotel';
  const page = await loadImportPage(staff, kind);
  return (
    <ImportView
      kind={kind}
      kindLinks={IMPORT_KINDS.map((k) => ({ kind: k, label: IMPORT_KIND_LABEL[k], href: `/app/admin/imports?kind=${k}`, current: k === kind }))}
      canApply={page.allowed}
      summary={null}
      history={page.history}
      branchChoice={page.branchChoice}
      actions={{ validate: validateImportAction as unknown as B11Action, apply: applyImportAction as unknown as B11Action }}
    />
  );
}
