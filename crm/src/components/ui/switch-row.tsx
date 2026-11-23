import { ChevronRight, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn, focusRing } from './cn';
import { Status } from './status';

/*
 * C6: one Settings switch as a row (owner choice A: sean0205 Switch With
 * Description 29860, row layout only). Name, one-line effect (a "More" fold
 * for long text), the state in words with an icon, the last change, and the
 * page's own change control on the right. It is NOT an instant toggle: the
 * change control opens the confirm dialog (ConfirmChange, C7). Put the rows
 * in one card; each row ends with a hairline.
 *
 * Give the change control aria-describedby={switchRowDescribedBy(id)} so its
 * accessible description names the switch and its state.
 */

export type SwitchState = 'on' | 'off' | 'unknown';

const STATE_KIND = { on: 'on', off: 'off', unknown: 'not_known' } as const;

/** ids of the row's name and state, for the change control's aria-describedby. */
export function switchRowDescribedBy(id: string): string {
  return `${id}-name ${id}-state`;
}

export function SwitchRow({
  id,
  name,
  effect,
  more,
  state,
  last,
  change,
  disabledReason,
  className,
}: {
  /** Stable id of the switch (its setting key); used for the name and state ids. */
  id: string;
  name: ReactNode;
  /** One line: what On does. */
  effect?: ReactNode;
  /** Longer explanation, folded under "More". */
  more?: ReactNode;
  state: SwitchState;
  /** The last change; null = "Never changed"; absent = not shown. */
  last?: { who?: ReactNode; when?: ReactNode } | null;
  /** The page's own change control (usually a ConfirmChange). */
  change?: ReactNode;
  /** The person cannot change it: the reason, shown with a lock; the Change button is disabled. */
  disabledReason?: ReactNode;
  className?: string;
}) {
  return (
    <div
      id={`${id}-row`}
      className={cn(
        'flex flex-col gap-2.5 border-b border-line px-4.5 py-3.5 font-sans last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
      data-slot="switch-row"
    >
      <div className="min-w-0 flex-1">
        <p id={`${id}-name`} className="m-0 font-semibold text-ink">
          {name}
        </p>
        {effect ? <p className="m-0 text-sm text-copy">{effect}</p> : null}
        {more ? (
          <details className="group/more mt-1 text-sm">
            <summary
              className={cn(
                'inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-chip font-medium text-brand-strong [&::-webkit-details-marker]:hidden',
                focusRing,
              )}
            >
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 group-open/more:rotate-90" />
              More<span className="sr-only"> about {name}</span>
            </summary>
            <div className="mt-1 text-copy">{more}</div>
          </details>
        ) : null}
        {last === null ? (
          <p className="m-0 mt-1 text-xs text-quiet">Never changed</p>
        ) : last && (last.who || last.when) ? (
          <p className="m-0 mt-1 text-xs text-quiet">
            Last change:{' '}
            {last.who}
            {last.who && last.when ? ', ' : null}
            {last.when}
          </p>
        ) : null}
        {disabledReason ? (
          <p className="m-0 mt-1 flex items-start gap-1.5 text-sm text-quiet">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{disabledReason}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
        <span id={`${id}-state`}>
          <Status kind={STATE_KIND[state]} srPrefix="State: " />
        </span>
        {disabledReason ? (
          <Button size="sm" disabled aria-describedby={switchRowDescribedBy(id)}>
            Change
          </Button>
        ) : (
          change
        )}
      </div>
    </div>
  );
}
