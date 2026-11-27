import { cn } from './cn';

/*
 * Save status pill of a card that saves itself (Book now v2, change 2).
 * Adapted from 21st.dev diceui "Status" (demo 25393): a pill with a dot and a
 * word, restyled to the CRM status tokens. The state is always a word, never
 * colour alone; the dot pulses only while saving and stops under reduced
 * motion. The reason for "Not saved · needs a fix" is shown under the card
 * (the pill's title repeats it for a pointer hover).
 */

export type SaveState = 'idle' | 'saving' | 'saved' | 'fix';

export const SAVE_STATE_TEXT: Record<SaveState, string> = {
  idle: 'Not started',
  saving: 'Saving…',
  saved: 'Saved',
  fix: 'Not saved · needs a fix',
};

const TONE: Record<SaveState, string> = {
  idle: 'border-line bg-wash text-quiet',
  saving: 'border-status-info-line bg-status-info-tint text-status-info',
  saved: 'border-status-success-line bg-status-success-tint text-status-success',
  fix: 'border-status-danger-line bg-status-danger-tint text-status-danger',
};

export function SaveStatus({ state, reason, id, label, text, className }: { state: SaveState; reason?: string | null; id?: string; label?: string; /** Another word for the state, e.g. "Stored" for a file. */ text?: string; className?: string }) {
  return (
    <span
      id={id}
      title={reason ?? undefined}
      data-slot="save-status"
      data-state={state}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.25 py-0.5 text-xs font-medium whitespace-nowrap', TONE[state], className)}
    >
      <span aria-hidden="true" className={cn('size-1.75 rounded-full bg-current', state === 'saving' && 'animate-ui-pulse motion-reduce:animate-none')} />
      {label ? <span className="sr-only">{label}: </span> : null}
      {text ?? SAVE_STATE_TEXT[state]}
    </span>
  );
}
