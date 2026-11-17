'use client';

import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';

/**
 * Confirmation before an irreversible action, on the native <dialog> element:
 * showModal() gives a real focus trap, an inert background and Escape to close.
 * Focus starts on the safe "cancel" button and returns to the trigger on close.
 * Adapted from the 21st.dev "Alert Dialog Layout" (horizontal) pattern; see
 * docs/implementation/phase-3/design/21st-dev-log.md.
 */
export function ConfirmDialog({
  triggerLabel,
  title,
  body,
  cancelLabel,
  renderActions,
  defaultOpen = false,
  triggerDescribedBy,
}: {
  /** id of a hint next to the trigger that explains the consequence (aria-describedby). */
  triggerDescribedBy?: string;
  triggerLabel: string;
  title: string;
  /** What will and will not happen. Announced as the dialog description. */
  body: ReactNode;
  cancelLabel: string;
  /** Renders the confirm form; it must place `cancel` next to its submit button. */
  renderActions: (cancel: ReactNode) => ReactNode;
  /** Preview gallery and returned errors: render already open. */
  defaultOpen?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    cancelRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  useEffect(() => {
    if (defaultOpen) open();
  }, [defaultOpen, open]);

  const cancel = (
    <button ref={cancelRef} type="button" className="button secondary" onClick={close}>
      {cancelLabel}
    </button>
  );

  return (
    <>
      <button ref={triggerRef} type="button" className="button" aria-haspopup="dialog" aria-describedby={triggerDescribedBy} onClick={open}>
        {triggerLabel}
      </button>
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClose={() => triggerRef.current?.focus()}
      >
        <div className="confirm-dialog-body">
          <h2 id={titleId}>{title}</h2>
          <div id={bodyId}>{body}</div>
          {renderActions(cancel)}
        </div>
      </dialog>
    </>
  );
}
