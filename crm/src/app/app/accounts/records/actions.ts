'use server';

import { recordsFilterFromParams } from '@/modules/accounts-desk/filters';
import { loadLinkTargets, loadRecords } from '@/modules/accounts-desk/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import type { RecordsPage } from '@/views/accounts-desk/types';

/**
 * "Show more" on Documents and money: the next keyset page for the filter in
 * the address (bound by the page). The same read and fence as the page.
 */
export async function loadMoreRecordsAction(query: string, after: string): Promise<RecordsPage | { error: string }> {
  const staff = await requireStaff();
  if (typeof query !== 'string' || typeof after !== 'string' || after.length > 200) return { error: 'The next rows could not be loaded. Reload the page.' };
  try {
    const r = await loadRecords(staff, recordsFilterFromParams(new URLSearchParams(query)), after);
    if (!r.ok) return { error: 'A filter in the address is not valid. Change the filters and try again.' };
    if (!r.data) return { error: 'This list is no longer available for your role. Reload the page.' };
    return r.data;
  } catch {
    return { error: 'The next rows could not be loaded. Try again.' };
  }
}

/**
 * "Link to another task": the tasks this supplier bill may be linked to (contract 7.3 S1, addendum B2),
 * read when the dialog opens. Tasks already linked are left out. null = not available to this viewer.
 */
export async function loadLinkTargetsAction(documentId: string): Promise<Array<{ taskId: string; label: string }> | null> {
  const staff = await requireStaff();
  if (typeof documentId !== 'string') return null;
  try {
    const view = await loadLinkTargets(staff, documentId);
    if (!view) return null;
    return view.items
      .filter((t) => !t.alreadyLinked)
      .map((t) => ({ taskId: t.taskId, label: `${t.dealReference} · ${t.serviceLabel ?? (t.department === 'flight' ? 'Flight' : 'Purchase')}` }));
  } catch {
    return null;
  }
}
