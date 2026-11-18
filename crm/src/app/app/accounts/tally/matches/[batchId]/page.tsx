import type { Metadata } from 'next';
import { applyTallyMatchAction, cancelTallyMatchAction } from '@/modules/accounts-desk/server/tally-file-actions';
import { loadTallyMatch } from '@/modules/accounts-desk/server/tally-file-queries';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { parseOutcome } from '@/views/tally-file/labels';
import { TallyMatchBatchView } from '@/views/tally-file/match-batch';
import { TallyFileNoAccess } from '@/views/tally-file/sections';

export const metadata: Metadata = { title: 'Tally vouchers' };

const UUID = /^[0-9a-f-]{36}$/i;
const act = (a: unknown) => a as DecisionAction;

/**
 * Accounts › Tally › one matching upload (Accounts phase 3 contract 7.4 R-C4,
 * C5, C6, screen 15.7): counts per outcome, the vouchers, "Apply matching"
 * (bound to the proposal hash shown) and "Cancel upload". Accounts only.
 */
export default async function TallyMatchRoute({ params, searchParams }: { params: Promise<{ batchId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const { batchId } = await params;
  const sp = await searchParams;
  const outcome = parseOutcome(sp.outcome);
  const after = typeof sp.after === 'string' && sp.after.length <= 200 ? sp.after : null;
  if (!UUID.test(batchId)) return <TallyFileNoAccess />;
  const res = await loadTallyMatch(staff, batchId, outcome, after).catch(() => ({ ok: false as const, invalid: null }));
  if (res.ok && res.data === null) return <TallyFileNoAccess />;
  return <TallyMatchBatchView page={res.ok && res.data ? res.data : 'error'} after={after} actions={{ apply: act(applyTallyMatchAction), cancel: act(cancelTallyMatchAction) }} />;
}
