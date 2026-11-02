/*
 * Two different kinds of "nothing to show", never mixed up:
 *   - not recorded: nobody has entered the value yet (someone can fix it);
 *   - hidden for your role: a value may exist, but this viewer may not see it.
 * Adapted from the 21st.dev "Label Disabled" (29340) pattern: a short status
 * word plus helper text saying who can change it. Text carries the meaning;
 * the glyph is decoration.
 */

export const NOT_RECORDED_TEXT = 'Not recorded yet';
export const HIDDEN_FOR_ROLE_TEXT = 'Hidden for your role';

export function NotRecorded({ hint }: { hint?: string }) {
  return (
    <span className="absent not-recorded">
      <span aria-hidden="true">– </span>
      {NOT_RECORDED_TEXT}
      {hint ? <span className="absent-hint"> · {hint}</span> : null}
    </span>
  );
}

export function HiddenForRole({ hint }: { hint?: string }) {
  return (
    <span className="absent hidden-for-role">
      <span aria-hidden="true">⊘ </span>
      {HIDDEN_FOR_ROLE_TEXT}
      {hint ? <span className="absent-hint"> · {hint}</span> : null}
    </span>
  );
}

/** A value, or "Not recorded yet" when it is null/empty. */
export function OrNotRecorded({ value, hint }: { value: string | number | null | undefined; hint?: string }) {
  return value === null || value === undefined || value === '' ? <NotRecorded hint={hint} /> : <>{value}</>;
}
