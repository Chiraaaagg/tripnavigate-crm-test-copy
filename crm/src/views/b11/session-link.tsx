import { cn, focusRing } from '@/components/ui/cn';
import { BOOK_RELIABILITY_TEXT, ERROR_TEXT } from '@/modules/fulfilment/contracts';
import { ROUTES } from '@/modules/identity/contracts';

/*
 * Booking reliability B1-8 (W8, visible change V6): the link shown with the
 * existing "You were signed out…" text (ERROR_TEXT.session). Sign-in opens in
 * a new tab, so this page and what was typed on it stay. The same markup as
 * the cards' and drawers' link (autosave-queue.tsx, service-editor.tsx); a
 * fixed address with no `next` value and no token. Server-safe.
 */

/** True when an action answered "the session has ended" (by code, or by its fixed text). */
export function isSessionEnded(result: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!result && (result.code === 'session' || result.message === ERROR_TEXT.session);
}

export function SignInNewTabLink({ className }: { className?: string }) {
  return (
    <a
      href={ROUTES.signIn}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex min-h-9 items-center self-start rounded-chip text-sm font-semibold text-brand-strong underline underline-offset-4', focusRing, className)}
    >
      {BOOK_RELIABILITY_TEXT.signInNewTab}
    </a>
  );
}
