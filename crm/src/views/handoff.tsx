import { Fragment, type ReactNode } from 'react';

/*
 * Who acts next, made scannable. Adapted from the 21st.dev "Vertical
 * Descriptive Stepper" (29866) and "Task Steps" (23569) patterns: a short
 * ordered list of hand-offs with done / now / later / blocked states. Rebuilt
 * as a plain <ol> with aria-current="step" (no tabs, no animation, no icons
 * font): the state is always written in words, glyphs are decoration only.
 * See docs/implementation/phase-3-5/design/21st-dev-log.md.
 */

/** The four staff roles that hand work to each other in the booking → Purchase flow. */
export type HandoffRole = 'Sales' | 'Sales Manager' | 'Purchase' | 'Admin';

const ROLE_CLASS: Record<HandoffRole, string> = {
  Sales: 'role-sales',
  'Sales Manager': 'role-manager',
  Purchase: 'role-purchase',
  Admin: 'role-admin',
};

/** Small role chip ("Sales", "Purchase" …) placed before the person who acts next. */
export function RoleTag({ role }: { role: HandoffRole }) {
  return <span className={`role-tag ${ROLE_CLASS[role]}`}>{role}</span>;
}

/** Role chips separated by spaces, so they read as separate words. */
function RoleTags({ roles }: { roles: HandoffRole[] }) {
  return (
    <>
      {roles.map((role, i) => (
        <Fragment key={role}>
          {i > 0 ? ' ' : null}
          <RoleTag role={role} />
        </Fragment>
      ))}
    </>
  );
}

/** "Who acts next" value: one or more role chips, then the plain-words person. */
export function WhoActs({ roles, children }: { roles: HandoffRole[]; children: ReactNode }) {
  return (
    <span className="who-acts">
      <RoleTags roles={roles} /> <span>{children}</span>
    </span>
  );
}

export type HandoffState = 'done' | 'now' | 'later' | 'blocked';

export interface HandoffStep {
  roles: HandoffRole[];
  label: string;
  state: HandoffState;
  /** Optional one-line detail, e.g. who is blocking or who took the task. */
  detail?: string;
}

const STATE_TEXT: Record<HandoffState, string> = {
  done: 'Done',
  now: 'Now',
  later: 'Later',
  blocked: 'Blocked',
};
const STATE_GLYPH: Record<HandoffState, string> = { done: '✓', now: '●', later: '○', blocked: '⏸' };

/** Ordered hand-off list. Exactly one step should be "now" or "blocked". */
export function HandoffTrack({ steps, label }: { steps: HandoffStep[]; label: string }) {
  return (
    <ol className="handoff" aria-label={label}>
      {steps.map((step) => (
        <li
          key={step.label}
          className={`handoff-step is-${step.state}`}
          aria-current={step.state === 'now' || step.state === 'blocked' ? 'step' : undefined}
        >
          <span className="handoff-dot" aria-hidden="true">
            {STATE_GLYPH[step.state]}
          </span>
          <span className="handoff-text">
            <span className="handoff-state">{STATE_TEXT[step.state]}:</span>{' '}
            <RoleTags roles={step.roles} /> <span className="handoff-label">{step.label}</span>
            {step.detail ? (
              <>
                {' '}
                <span className="handoff-detail">{step.detail}</span>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
