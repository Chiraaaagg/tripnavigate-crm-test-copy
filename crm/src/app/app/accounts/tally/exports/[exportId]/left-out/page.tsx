import type { Metadata } from 'next';
import { loadTallyLeftOut } from '@/modules/accounts-desk/server/tally-file-queries';
import { requireStaff } from '@/modules/identity/server/session';
import { TallyLeftOutView } from '@/views/tally-file/files';
import { TallyFileNoAccess } from '@/views/tally-file/sections';

export const metadata: Metadata = { title: 'Left out of the Tally file' };

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Accounts › Tally › one file's left-out list (Accounts phase 3 contract 7.4
 * R-C3, screen 15.7): what did not go into the XML file and why, in keyset
 * pages. Accounts only; the read returns null for anyone else.
 */
export default async function TallyLeftOutRoute({ params, searchParams }: { params: Promise<{ exportId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const { exportId } = await params;
  const raw = (await searchParams).after;
  const after = typeof raw === 'string' && raw.length <= 200 ? raw : null;
  if (!UUID.test(exportId)) return <TallyFileNoAccess />;
  const res = await loadTallyLeftOut(staff, exportId, after).catch(() => ({ ok: false as const, invalid: null }));
  if (res.ok && res.data === null) return <TallyFileNoAccess />;
  return <TallyLeftOutView page={res.ok && res.data ? res.data : 'error'} after={after} />;
}
