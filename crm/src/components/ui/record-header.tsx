import { ChevronLeft, Eye, UserRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, buttonVariants } from './button';
import { cn, focusRing } from './cn';
import { Fold } from './fold';
import { JumpButton } from './jump-links';

/*
 * C4: the top of a record page (owner choice A: the existing CRM page header
 * with the layout of olewandowski1 Page Header with Breadcrumbs 18149,
 * pattern only). Three lines:
 *   1. back link · record ID
 *   2. title (the page's h1) · status · owner, with rare quiet actions at the right
 *   3. "Next: …" with the page's ONE primary button, or who acts next when the
 *      viewer cannot ("Next: Purchase confirms the hotel.")
 * then an optional read-only line and the folded system details.
 * ui/page-header.tsx stays as it is for list pages.
 */

export interface NextButton {
  label: ReactNode;
  /** Opens another page. */
  href?: string;
  /** The control lower on this page (its id): jumps there and focuses it. */
  jumpTo?: string;
  /** Posts the page's existing server action. */
  formAction?: (formData: FormData) => void | Promise<void>;
  /** Fields the action expects, sent unchanged (formAction only). */
  hiddenFields?: Readonly<Record<string, string>>;
  disabled?: boolean;
}

export interface RecordHeaderProps {
  back: { href: string; label: ReactNode };
  recordId?: ReactNode;
  title: ReactNode;
  /** Usually a <Status kind=… />. */
  status?: ReactNode;
  /** The owner's name. */
  owner?: ReactNode;
  /** Word before the owner's name (default "Owner"). */
  ownerLabel?: string;
  next?: { text: ReactNode; button?: NextButton } | null;
  /** When the viewer cannot act: who does ("Purchase confirms the hotel."). Shown when `next` is absent. */
  nextWho?: ReactNode;
  /** true = "You can view this."; or the full sentence ("You can view this. Accounts can change it."). */
  readOnly?: true | ReactNode;
  /** Folded system facts (IDs, created, synced). */
  details?: ReactNode;
  detailsLabel?: ReactNode;
  /** Rare quiet actions beside the title (one or two). */
  actions?: ReactNode;
  className?: string;
}

const primaryWrap = 'h-auto min-h-10 max-w-full py-2 text-left whitespace-normal';

function NextAction({ button }: { button: NextButton }) {
  if (button.jumpTo && !button.disabled) return <JumpButton targetId={button.jumpTo}>{button.label}</JumpButton>;
  if (button.href && !button.disabled) {
    return (
      <Link href={button.href} className={cn(buttonVariants({ variant: 'primary' }), primaryWrap)}>
        {button.label}
      </Link>
    );
  }
  if (button.formAction) {
    return (
      <form action={button.formAction}>
        {button.hiddenFields
          ? Object.entries(button.hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
          : null}
        <Button type="submit" variant="primary" disabled={button.disabled} className={primaryWrap}>
          {button.label}
        </Button>
      </form>
    );
  }
  return (
    <Button variant="primary" disabled className={primaryWrap}>
      {button.label}
    </Button>
  );
}

export function RecordHeader({
  back,
  recordId,
  title,
  status,
  owner,
  ownerLabel = 'Owner',
  next,
  nextWho,
  readOnly,
  details,
  detailsLabel = 'Details',
  actions,
  className,
}: RecordHeaderProps) {
  return (
    <header className={cn('mb-5 font-sans', className)} data-slot="record-header">
      <p className="m-0 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Link
          href={back.href}
          className={cn('inline-flex items-center gap-1 rounded-chip font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
        {recordId ? (
          <>
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
            <span className="font-medium text-quiet tabular-nums">{recordId}</span>
          </>
        ) : null}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="m-0 text-2xl leading-tight font-display tracking-heading wrap-break-word text-ink max-sm:text-xl">{title}</h1>
          {status || owner ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-quiet">
              {status}
              {owner ? (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 wrap-break-word text-copy">
                  <UserRound aria-hidden="true" className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0">
                    {ownerLabel}: <span className="font-semibold text-ink">{owner}</span>
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {next && (next.text || next.button) ? (
        <div
          className="mt-3 flex flex-col gap-2.5 rounded-control border border-line bg-card px-3.5 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
          data-slot="next-step"
        >
          {/* When the words and the button do not fit on one line (a long label, 200% zoom), the button moves under the words and wraps, never pushing the page sideways. */}
          <p className="m-0 text-base text-copy">
            <span className="font-semibold text-ink">Next: </span>
            {next.text}
          </p>
          {next.button ? (
            <div className="max-w-full max-sm:[&>*]:w-full max-sm:[&_button]:w-full">
              <NextAction button={next.button} />
            </div>
          ) : null}
        </div>
      ) : nextWho ? (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-line bg-card px-3.5 py-2.5 text-base text-copy" data-slot="next-step">
          <UserRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
          <p className="m-0">
            <span className="font-semibold text-ink">Next: </span>
            {nextWho}
          </p>
        </div>
      ) : null}
      {readOnly ? (
        <p className="m-0 mt-2.5 flex items-center gap-1.5 text-sm text-quiet" data-slot="read-only">
          <Eye aria-hidden="true" className="size-4 shrink-0" />
          <span>{readOnly === true ? 'You can view this.' : readOnly}</span>
        </p>
      ) : null}
      {details ? (
        <Fold summary={detailsLabel} className="mt-3 shadow-none">
          {details}
        </Fold>
      ) : null}
    </header>
  );
}
