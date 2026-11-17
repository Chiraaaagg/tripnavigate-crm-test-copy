import { CircleOff, Eye, Inbox, Lock, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from './card';
import { cn } from './cn';
import { EmptyState } from './empty-state';
import { Notice } from './notice';

/*
 * C8: the six screen states in one place (owner choice A: the existing CRM
 * parts). Each says what happened, honestly, and what the person can do:
 *
 *   empty    icon, title, one sentence why, at most one action (in a card)
 *   error    what happened, whether anything was saved, who can fix it, one action
 *   blocked  the action (pass it disabled) with the reason and who unblocks it
 *   readOnly "You can view this. <who> can change it."
 *   off      "Switched off", where it is switched on (link for a Super Admin)
 *   unknown  inline "Not known" words, never 0
 */

export type StateKind = 'empty' | 'error' | 'blocked' | 'readOnly' | 'off' | 'unknown';

export interface StateBlockProps {
  kind: StateKind;
  title?: ReactNode;
  text?: ReactNode;
  /** Who can fix, change, unblock or switch it on: "Accounts can change it." */
  who?: ReactNode;
  /** At most one action (a button or a link). For blocked, pass it disabled. */
  action?: ReactNode;
  /** error only: true "Your work was saved.", false "Nothing was saved…". */
  saved?: boolean;
  icon?: LucideIcon;
  /** empty only: heading level of the title (default 3). */
  headingLevel?: 2 | 3 | 4;
  /** empty only: false = no card frame (already inside a card). */
  card?: boolean;
  className?: string;
}

export function StateBlock({ kind, title, text, who, action, saved, icon, headingLevel, card = true, className }: StateBlockProps) {
  switch (kind) {
    case 'empty': {
      const empty = (
        <EmptyState
          icon={icon ?? Inbox}
          title={title ?? 'Nothing waiting'}
          description={text ?? ''}
          action={action}
          headingLevel={headingLevel}
          className={card ? undefined : className}
        />
      );
      return card ? <Card className={className}>{empty}</Card> : empty;
    }
    case 'error':
      return (
        <Notice tone="danger" role="alert" title={title ?? 'Something went wrong'} icon={icon} className={className}>
          {text ? <p>{text}</p> : null}
          {saved === true ? <p>Your work was saved.</p> : saved === false ? <p>Nothing was saved. Your typed input is still on the page.</p> : null}
          {who ? <p>{who}</p> : null}
          {action ? <div className="mt-1.5">{action}</div> : null}
        </Notice>
      );
    case 'blocked': {
      const Icon = icon ?? Lock;
      return (
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 font-sans', className)} data-slot="blocked">
          {action}
          <p className="m-0 flex items-start gap-1.5 text-sm text-quiet">
            <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {text}
              {who ? <> {who}</> : null}
            </span>
          </p>
        </div>
      );
    }
    case 'readOnly': {
      const Icon = icon ?? Eye;
      return (
        <p className={cn('m-0 flex items-center gap-1.5 font-sans text-sm text-quiet', className)} data-slot="read-only">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span>
            {text ?? 'You can view this.'}
            {who ? <> {who}</> : null}
          </span>
        </p>
      );
    }
    case 'off':
      return (
        <Notice tone="locked" icon={icon ?? CircleOff} title={title ?? 'Switched off'} className={className}>
          {text ? <p>{text}</p> : null}
          {who ? <p>{who}</p> : null}
          {action ? <div className="mt-1.5">{action}</div> : null}
        </Notice>
      );
    case 'unknown':
      return <span className={cn('font-normal text-quiet italic', className)}>{text ?? 'Not known'}</span>;
    default:
      return null;
  }
}
