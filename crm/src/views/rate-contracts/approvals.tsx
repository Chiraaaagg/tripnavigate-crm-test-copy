import { CircleCheck, FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Facts, ItemCard, ItemList, ListEmpty } from '@/views/accounts/supplier-kit';
import { rangeText } from './format';
import { ContractStatusBadge } from './list';
import type { RateContractRow } from './types';

/*
 * Approvals › Rate contracts (Accounts phase 3 contract §15 item 9, R-E1
 * preset `to_approve`). Tab content only: the Approvals page owns the tabs.
 * Each contract opens on its own page, where the Manager reads every rate
 * line before approving or returning it — the list never approves blind.
 * A contract the viewer entered says so and points to another Manager.
 * Redesign R3 (DM-7): the same card template as the other Approvals rows,
 * with the one action at the bottom-left under the facts.
 */

export function RateContractApprovalsTab({
  rows,
  enabled,
  basePath = '/app/purchase/rate-contracts',
  viewerEnteredIds = [],
  total,
  visibleHeading = false,
}: {
  /** On the Approvals page among other sections: show the heading (the tab hides it). */
  visibleHeading?: boolean;
  /** R-E1 rows of preset `to_approve`; 'error' = the read failed. */
  rows: RateContractRow[] | 'error';
  enabled: boolean;
  basePath?: string;
  /** Contracts this Manager entered (they cannot approve them). */
  viewerEnteredIds?: string[];
  /** Full count when the list is capped. */
  total?: number;
}) {
  if (rows === 'error') {
    return (
      <Notice tone="warning" role="status" title="The rate contracts could not be loaded">
        <p>Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
      </Notice>
    );
  }
  return (
    <section aria-labelledby="approvals-rc-heading" className="flex flex-col gap-4 font-sans text-base text-copy">
      <h2 id="approvals-rc-heading" className={visibleHeading ? 'm-0 scroll-mt-18 text-lg font-semibold text-ink' : 'sr-only'}>
        Rate contracts to approve
      </h2>
      {!enabled ? (
        <Notice tone="locked" role="status" title="Rate contracts are not switched on yet">
          <p>Nothing can be approved until a Super Admin switches rate contracts on.</p>
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <ListEmpty icon={CircleCheck} title="No rate contract is waiting for you" description="When Purchase sends a contract for approval, it shows here." />
      ) : (
        <>
          <p className="m-0 text-sm text-quiet">
            {total && total > rows.length ? `Showing ${rows.length} of ${total}. ` : ''}Open a contract to read its rate lines, then approve or return it.
          </p>
          <ItemList label="Rate contracts waiting for approval">
            {rows.map((r) => {
              const own = r.isMine === true || viewerEnteredIds.includes(r.contractId);
              const decide = !own && r.canApprove !== false;
              return (
                <ItemCard
                  key={r.contractId}
                  id={`rc-${r.contractId}`}
                  headingLevel={visibleHeading ? 3 : 2}
                  eyebrow={`${r.contractNo} · version ${r.versionNo}`}
                  title={r.hotelName}
                  status={<ContractStatusBadge status={r.status} />}
                >
                  <Facts
                    rows={[
                      ['Supplier', r.supplierName],
                      ['City', r.city ?? 'Not recorded'],
                      ['Rates apply', rangeText(r.validFrom, r.validTo)],
                      ['Rate lines', String(r.lineCount)],
                      ['Entered by', own ? 'You' : (r.enteredByName ?? 'A Purchase colleague')],
                    ]}
                  />
                  <div className="flex flex-col items-start gap-1.5">
                    <Link href={`${basePath}/${r.contractId}`} className={buttonVariants({ variant: decide ? 'primary' : 'secondary', size: 'sm' })} aria-label={`${decide ? 'Review' : 'Open'} ${r.contractNo} for ${r.hotelName}`}>
                      <FileSpreadsheet aria-hidden="true" />
                      {decide ? 'Review and decide' : 'Open'}
                    </Link>
                    {own ? <p className="m-0 text-sm text-quiet">You entered this contract. Another Manager approves it.</p> : null}
                  </div>
                </ItemCard>
              );
            })}
          </ItemList>
        </>
      )}
    </section>
  );
}
