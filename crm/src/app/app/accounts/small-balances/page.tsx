import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadSmallBalances } from '@/modules/write-offs/server/queries';
import { decideWriteOffAction, proposeWriteOffAction, undoWriteOffAction, withdrawWriteOffAction } from '@/modules/write-offs/server/actions';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { parseSmallBalancesQuery } from '@/views/write-offs/labels';
import { SmallBalancesNoAccess, SmallBalancesView } from '@/views/write-offs/small-balances';
import { deskViewerOf } from '../records/desk-glue';

export const metadata: Metadata = { title: 'Small balances' };

const act = (a: unknown) => a as DecisionAction;
const ACTIONS = { propose: act(proposeWriteOffAction), decide: act(decideWriteOffAction), withdraw: act(withdrawWriteOffAction), undo: act(undoWriteOffAction) };
const DEFAULT_LIMIT_PAISE = '500000';

/**
 * Accounts › Small balances (Accounts phase 3 contract 6.6 R-B1, screen 15.6).
 * small_balances_list decides who reads: Accounts of the company (propose)
 * and branch Managers (approve, return, undo); everyone else gets null. The
 * preset, branch and keyset cursor live in the address.
 */
export default async function SmallBalancesRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const { filter, after } = parseSmallBalancesQuery(await searchParams);
  const page = await loadSmallBalances(staff, filter, after).catch(() => 'error' as const);
  if (page === null) return <SmallBalancesNoAccess />;
  const mode = staff.memberships.some((m) => m.roleCode === 'accounts') ? 'accounts' : 'manager';
  const settings = page === 'error' ? undefined : page.settings;
  const items = page === 'error' ? [] : page.items;
  // small_balances_list carries the write-off switch and limit (track B, migration 0240); older replies fall back to the rows.
  const writeOffsOn = settings ? settings.enabled : items.length === 0 || !items.every((r) => r.blockedBy.includes('write_off_off'));
  const limitPaise = settings?.limitPaise ?? items[0]?.limitPaise ?? DEFAULT_LIMIT_PAISE;
  return (
    <SmallBalancesView
      viewer={deskViewerOf(staff, mode)}
      filter={filter}
      after={after}
      page={page === 'error' ? 'error' : { items: page.items, nextAfter: page.nextAfter, hasMore: page.hasMore ?? page.nextAfter !== null }}
      actions={ACTIONS}
      writeOffsOn={writeOffsOn}
      limitPaise={limitPaise}
    />
  );
}
