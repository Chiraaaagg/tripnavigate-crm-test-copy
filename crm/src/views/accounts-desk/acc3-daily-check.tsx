import Link from 'next/link';
import { cn, focusRing } from '@/components/ui/cn';
import { QUEUE_LATE_MINUTES, queueAgeText } from '@/views/customer-documents/acc3-pure';
import { BILLS_TO_CHECK_PATH } from '@/views/customer-documents/filter';

/*
 * Daily check, Accounts phase 3 additions (contract 6.5 accounts_daily_check
 * additive keys, screen 11): held bills, failed customer messages, Tally
 * file entries not matched, the age of the oldest waiting customer message
 * and write-offs to review. Each key shows only when the database sends it,
 * so the card reads exactly as Phase 2 until track B's read carries them.
 *
 * Slot: the `<li>` items go inside the "Daily check counts" list of
 * DailyCheckCard (views/accounts-desk/records.tsx), after the Phase 2
 * items and before "Urgent notices not opened…". Same look as its CheckItem.
 */

export interface Acc3DailyCheckExtra {
  billsHeldOverOneWorkingDay?: number;
  /** null = messages or the Tally file not installed (the tile is left out). */
  customerMessagesFailedOverOneWorkingDay?: number | null;
  tallyFileUnmatchedOverOneWorkingDay?: number | null;
  /** null or 0 = nothing waiting. */
  messageQueueOldestMinutes?: number | null;
  writeOffsToReview?: number;
}

const TILE = 'flex h-full flex-col rounded-control border border-line bg-canvas px-3 py-2';

function Item({ n, text, href, extra }: { n: number; text: string; href?: string; extra?: string }) {
  const body = (
    <>
      <span className="text-sm text-copy">{text}</span>
      <span className="text-lg font-semibold text-ink tabular-nums">
        {n}
        {extra ? <span className="ml-1.5 text-sm font-normal text-quiet">({extra})</span> : null}
      </span>
    </>
  );
  return (
    <li className="m-0">
      {href ? (
        <Link href={href} className={cn(TILE, 'no-underline hover:bg-wash', focusRing)}>
          {body}
        </Link>
      ) : (
        <div className={TILE}>{body}</div>
      )}
    </li>
  );
}

export function Acc3DailyCheckItems({ extra }: { extra: Acc3DailyCheckExtra | null | undefined }) {
  if (!extra) return null;
  const age = extra.messageQueueOldestMinutes;
  const late = typeof age === 'number' && age > QUEUE_LATE_MINUTES;
  return (
    <>
      {extra.billsHeldOverOneWorkingDay !== undefined ? <Item n={extra.billsHeldOverOneWorkingDay} text="Bills held for over one working day" href={BILLS_TO_CHECK_PATH} /> : null}
      {extra.customerMessagesFailedOverOneWorkingDay != null ? (
        <Item n={extra.customerMessagesFailedOverOneWorkingDay} text="Customer messages failed for over one working day (Sales owners are told on the Deal)" />
      ) : null}
      {extra.tallyFileUnmatchedOverOneWorkingDay != null ? <Item n={extra.tallyFileUnmatchedOverOneWorkingDay} text="Tally file entries not matched for over one working day" href="/app/accounts/tally" /> : null}
      {extra.writeOffsToReview !== undefined ? <Item n={extra.writeOffsToReview} text="Write-offs to review" href="/app/accounts/small-balances?preset=needs_review" /> : null}
      {age !== undefined ? (
        <li className="m-0">
          <div className={TILE}>
            <span className="text-sm text-copy">Oldest customer message waiting to send</span>
            <span className="text-lg font-semibold text-ink tabular-nums">
              {queueAgeText(age)}
              {late ? <span className="ml-1.5 text-sm font-semibold text-status-danger-strong">(late — background jobs may be stuck)</span> : null}
            </span>
          </div>
        </li>
      ) : null}
    </>
  );
}
