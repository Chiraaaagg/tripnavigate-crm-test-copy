'use client';

import { ChevronDown, KeyRound, MailPlus, ShieldCheck, UserPlus, UserX, type LucideIcon } from 'lucide-react';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FormMessage } from '@/components/FormMessage';
import { HandForm, useHandFormStatus } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { initialFormState, type FormState } from '@/lib/forms';
import {
  deactivateStaffAction,
  grantScopeAction,
  inviteStaffAction,
  revokeGrantAction,
  sendStaffEmailAction,
} from '@/modules/access/server/staff-actions';
import { type RecoveryCase, recoveryCleanupState, type VerificationMethodOption } from '@/modules/identity/contracts';
import { STAFF_NO_METHOD_TEXT } from '@/modules/settings/contracts';
import {
  beginMfaRecoveryAction,
  confirmMfaRecoveryAction,
  resumeMfaRecoveryProviderAction,
  retryMfaRecoveryCleanupAction,
} from '@/modules/identity/server/recovery-actions';
import { useFormStateSavedKey, useKeepValuesOnFailure } from './keep-form-values';

/*
 * Settings · People and access forms (R1, audit S9 and S10; design plan 1.4).
 * Every form posts the same fields to the same server action as before; only
 * where the form sits changed:
 *
 *   - "Invite staff" and "Give extra access" open their form in a drawer
 *     (the list comes first). A refusal keeps every typed value and choice
 *     and stays in the drawer; a save closes it, says so once on the page
 *     (polite status), and focus goes back to the button that opened it.
 *   - Each staff row has one "Actions" menu (shadcn DropdownMenu, already in
 *     the CRM). Each item opens one drawer with that action's form.
 *   - Revoke opens a dialog with the required reason (a live rule, not a
 *     Settings switch, so D9 does not apply).
 *
 * The server actions and the database decide every step.
 */

export interface Option {
  value: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Page result line and drawer wiring
// ---------------------------------------------------------------------------

type Announce = (text: string) => void;
const AnnounceContext = createContext<Announce | null>(null);
/** Inside an action drawer: a form calls this after a save to close the drawer and say so on the page. */
const DrawerDoneContext = createContext<Announce | null>(null);

/**
 * The one result line of a People and access page: a polite status region
 * that is always in the page (empty until a save), so the words are read out
 * once even when the drawer that saved has closed or its row has changed.
 */
export function PeopleResults({ children, initialText = null }: { children: ReactNode; /** Preview gallery only. */ initialText?: string | null }) {
  const [text, setText] = useState<string | null>(initialText);
  const region = useRef<HTMLDivElement>(null);
  const announce = useCallback<Announce>((next) => {
    setText(next);
    // When the control that opened the drawer is gone (a deactivated person, a revoked grant), focus the result.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) region.current?.focus();
    });
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      <div ref={region} tabIndex={-1} role="status" aria-live="polite" className="outline-none empty:hidden" data-slot="people-result">
        {text ? (
          <Notice tone="success" role="none">
            <p>
              <strong>Done: </strong>
              {text}
            </p>
          </Notice>
        ) : null}
      </div>
      {children}
    </AnnounceContext.Provider>
  );
}

/** Calls the drawer's "done" once per successful reply (nothing happens outside a drawer). */
function useDoneOnSuccess(state: FormState) {
  const done = useContext(DrawerDoneContext);
  useEffect(() => {
    if (state.status === 'success' && done) done(state.message ?? 'Saved.');
  }, [state, done]);
}

function ActionDrawer({
  open,
  onOpenChange,
  title,
  description,
  returnFocus,
  onDone,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** The control that opened the drawer (a menu trigger): focus returns there on close. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Called by a form after a save; omitted = the drawer stays open (the recovery steps). */
  onDone?: Announce;
  children: ReactNode;
}) {
  const descId = useId();
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        aria-describedby={descId}
        className="w-[min(28rem,calc(100vw-1rem))]"
        onCloseAutoFocus={(e) => {
          if (returnFocus?.current && returnFocus.current.isConnected) {
            e.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
          <DrawerDescription id={descId} className="m-0 text-sm text-quiet">
            {description}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <DrawerDoneContext.Provider value={onDone ?? null}>{children}</DrawerDoneContext.Provider>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * A page button that opens one form in a drawer ("Invite staff", "Give extra
 * access", "Add from Bitrix"). A form that supports it closes the drawer after
 * a save; otherwise its own message shows in the drawer.
 */
export function FormDrawer({
  label,
  variant = 'secondary',
  icon = 'mail',
  title,
  description,
  initialOpen = false,
  children,
}: {
  label: string;
  variant?: 'primary' | 'secondary';
  icon?: 'mail' | 'person';
  title: string;
  description: ReactNode;
  /** Preview gallery only. */
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  const announce = useContext(AnnounceContext);
  const done = useCallback<Announce>(
    (text) => {
      setOpen(false);
      announce?.(text);
    },
    [announce],
  );
  const descId = useId();
  const Icon: LucideIcon = icon === 'person' ? UserPlus : MailPlus;
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant={variant}>
          <Icon aria-hidden="true" />
          {label}
        </Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={descId} className="w-[min(30rem,calc(100vw-1rem))]">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
          <DrawerDescription id={descId} className="m-0 text-sm text-quiet">
            {description}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <DrawerDoneContext.Provider value={done}>{children}</DrawerDoneContext.Provider>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

function Submit({ children, pendingLabel, variant = 'primary', describedBy }: { children: ReactNode; pendingLabel: string; variant?: 'primary' | 'secondary' | 'danger'; describedBy?: string }) {
  const { pending } = useHandFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      aria-disabled={pending || undefined}
      aria-describedby={describedBy}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Invite staff (same fields: displayName, email, branchId, roleCode)
// ---------------------------------------------------------------------------

export function InviteStaffForm({ branches, roles, initialState }: { branches: Option[]; roles: Option[]; /** Preview gallery only. */ initialState?: FormState }) {
  const [state, action] = useActionState(inviteStaffAction, initialState ?? initialFormState);
  // Batch 4: submitted by hand so a refusal keeps the chosen branch and role; empty again after a save.
  const savedKey = useFormStateSavedKey(state);
  useDoneOnSuccess(state);
  return (
    <HandForm key={savedKey} action={action} noValidate className="flex flex-col gap-4">
      <FormMessage state={state} />
      <Field htmlFor="invite-name" label="Full name">
        <Input id="invite-name" name="displayName" required maxLength={120} autoComplete="off" />
      </Field>
      <Field htmlFor="invite-email" label="Work email">
        <Input id="invite-email" name="email" type="email" required autoComplete="off" />
      </Field>
      <Field htmlFor="invite-branch" label="Branch">
        <Select id="invite-branch" name="branchId" required defaultValue="">
          <option value="" disabled>
            Choose a branch
          </option>
          {branches.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor="invite-role" label="Role">
        <Select id="invite-role" name="roleCode" required defaultValue="">
          <option value="" disabled>
            Choose a role
          </option>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <div>
        <Submit pendingLabel="Sending invitation…">Send invitation</Submit>
      </div>
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Staff row menu: e-mail, authenticator recovery, deactivate
// ---------------------------------------------------------------------------

/** Resend invitation (invited staff) or send a password reset email (active staff). Same fields: userId, kind. */
function StaffEmailForm({ userId, status }: { userId: string; status: 'invited' | 'active' }) {
  const [state, action] = useActionState(sendStaffEmailAction, initialFormState);
  useDoneOnSuccess(state);
  const kind = status === 'invited' ? 'invitation_resend' : 'password_reset';
  const helpId = `email-help-${userId}`;
  return (
    <form action={action} noValidate className="flex flex-col gap-3">
      <FormMessage state={state} />
      <p id={helpId} className="m-0 text-copy">
        {status === 'invited'
          ? 'Sends a new link to finish setup. The person still has to set up an authenticator app.'
          : 'Sends a link to choose a new password. Their authenticator app is still required to sign in.'}
      </p>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="kind" value={kind} />
      <div>
        <Submit pendingLabel="Sending…" describedBy={helpId}>
          {status === 'invited' ? 'Resend invitation' : 'Send password reset email'}
        </Submit>
      </div>
    </form>
  );
}

type FormAction = (payload: FormData) => void;
type SubmitHandler = (event: FormEvent<HTMLFormElement>) => void;

/**
 * Starts a NEW administrator-assisted authenticator recovery. The form state
 * lives in RecoverySection so the server's result stays visible after the
 * page re-renders with the new case status.
 */
function BeginRecoveryForm({
  userId,
  name,
  action,
  invalid,
  onSubmit,
}: {
  userId: string;
  name: string;
  action: FormAction;
  invalid: boolean;
  onSubmit: SubmitHandler;
}) {
  const warnId = `recovery-warn-${userId}`;
  const reasonId = `recovery-reason-${userId}`;
  return (
    <form action={action} noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
      <Notice tone="warning" id={warnId}>
        <p>
          Warning: starting recovery immediately blocks every current session of {name}, on all devices. They cannot see
          CRM data until they set up a new authenticator and you confirm their identity.
        </p>
      </Notice>
      <input type="hidden" name="userId" value={userId} />
      <Field htmlFor={reasonId} label="Reason for recovery" hint="10 to 500 characters.">
        <Input
          id={reasonId}
          name="reason"
          required
          minLength={10}
          maxLength={500}
          aria-describedby={`${warnId} ${fieldDescribedBy(reasonId, { hint: true })}`}
          invalid={invalid}
        />
      </Field>
      <div>
        <Submit pendingLabel="Starting…" variant="danger" describedBy={warnId}>
          Start authenticator recovery
        </Submit>
      </div>
    </form>
  );
}

/**
 * Retries (`failed`) or reconciles (`pending`, result unknown) the provider
 * step of the exact case shown. The database refuses if that case moved on,
 * so a stale page never opens a new case or removes a new authenticator.
 */
function ResumeProviderForm({
  recoveryCase,
  name,
  mode,
  action,
  onSubmit,
}: {
  recoveryCase: RecoveryCase;
  name: string;
  mode: 'failed' | 'pending';
  action: FormAction;
  onSubmit: SubmitHandler;
}) {
  const helpId = `recovery-retry-help-${recoveryCase.caseId}`;
  return (
    <form action={action} noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="caseId" value={recoveryCase.caseId} />
      <p id={helpId} className="m-0 text-copy">
        {mode === 'pending'
          ? 'No result is recorded for removing the old authenticator, so the outcome is unknown. Checking continues the same recovery case; it does not start a new one, and the person stays blocked.'
          : 'Retrying continues the same recovery case; it does not start a new one, and the person stays blocked.'}
      </p>
      <div>
        <Submit pendingLabel={mode === 'pending' ? 'Checking…' : 'Retrying…'} variant="secondary" describedBy={helpId}>
          {mode === 'pending' ? 'Check and finish removing the old authenticator' : 'Retry removing the old authenticator'}
          <span className="sr-only"> for {name}</span>
        </Submit>
      </div>
    </form>
  );
}

/**
 * Identity is confirmed but removing the person's other authenticators has no
 * successful result. Retries cleanup on the same completed case; the consumed
 * confirmation code is never asked for again and no new recovery starts.
 */
function RetryCleanupForm({
  recoveryCase,
  name,
  action,
  onSubmit,
}: {
  recoveryCase: RecoveryCase;
  name: string;
  action: FormAction;
  onSubmit: SubmitHandler;
}) {
  const helpId = `recovery-cleanup-help-${recoveryCase.caseId}`;
  return (
    <form action={action} noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="caseId" value={recoveryCase.caseId} />
      <p id={helpId} className="m-0 text-copy">
        {name} stays blocked until this succeeds. Retrying keeps their new authenticator and removes only the others. You
        do not need a new confirmation code.
      </p>
      <div>
        <Submit pendingLabel="Retrying…" variant="secondary" describedBy={helpId}>
          Retry removing other authenticators<span className="sr-only"> for {name}</span>
        </Submit>
      </div>
    </form>
  );
}


/** Administrator confirms recovery with an approved method and the code read out by the staff member. */
function ConfirmRecoveryForm({
  recoveryCase,
  methods,
  action,
  invalid,
  onSubmit,
}: {
  recoveryCase: RecoveryCase;
  methods: VerificationMethodOption[];
  action: FormAction;
  invalid: boolean;
  onSubmit: SubmitHandler;
}) {
  const id = recoveryCase.caseId;
  if (methods.length === 0) {
    return (
      <Notice tone="info">
        <p>{STAFF_NO_METHOD_TEXT}</p>
      </Notice>
    );
  }
  return (
    <form action={action} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="caseId" value={id} />
      <Field htmlFor={`confirm-method-${id}`} label="How you verified their identity">
        <Select id={`confirm-method-${id}`} name="method" required defaultValue="" invalid={invalid}>
          <option value="" disabled>
            Choose an approved method
          </option>
          {methods.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor={`confirm-code-${id}`} label="Confirmation code" hint="6 characters, read to you by the staff member from their own screen over the agreed channel.">
        <Input
          id={`confirm-code-${id}`}
          name="confirmationCode"
          className="font-mono tracking-[0.2em] uppercase"
          required
          minLength={6}
          maxLength={6}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={fieldDescribedBy(`confirm-code-${id}`, { hint: true })}
          invalid={invalid}
        />
      </Field>
      <Field htmlFor={`confirm-note-${id}`} label="Note" optional>
        <Input id={`confirm-note-${id}`} name="note" maxLength={500} invalid={invalid} />
      </Field>
      <div>
        <Submit pendingLabel="Confirming…">Confirm and restore access</Submit>
      </div>
    </form>
  );
}

const RECOVERY_HEADING: Record<RecoveryCase['status'] | 'none' | 'cleanup', string> = {
  none: 'Authenticator recovery',
  completed: 'Authenticator recovery',
  cleanup: 'Authenticator recovery: removing other authenticators',
  provider_pending: 'Authenticator recovery: removing old authenticator',
  provider_failed: 'Authenticator recovery: removing old authenticator failed',
  awaiting_reenrollment: 'Authenticator recovery: waiting for new authenticator',
  awaiting_admin_confirmation: 'Authenticator recovery: confirm identity',
};

type RecoveryStep = keyof typeof RECOVERY_HEADING;

function recoveryStep(recoveryCase: RecoveryCase | null): { step: RecoveryStep; cleanup: ReturnType<typeof recoveryCleanupState> } {
  const cleanup = recoveryCase?.status === 'completed' ? recoveryCleanupState(recoveryCase) : 'done';
  const step: RecoveryStep = cleanup === 'failed' || cleanup === 'pending' ? 'cleanup' : (recoveryCase?.status ?? 'none');
  return { step, cleanup };
}

/** The row menu item that opens the recovery drawer, named for the next step. */
export const RECOVERY_MENU_LABEL: Record<RecoveryStep, string> = {
  none: 'Start authenticator recovery',
  completed: 'Start authenticator recovery',
  cleanup: 'Retry removing other authenticators',
  provider_pending: 'Check the authenticator recovery',
  provider_failed: 'Retry the authenticator recovery',
  awaiting_reenrollment: 'See the authenticator recovery',
  awaiting_admin_confirmation: 'Confirm identity and restore access',
};

/** Recovery section of a staff member's actions, by case status. */
function RecoverySection({
  userId,
  name,
  recoveryCase,
  methods,
}: {
  userId: string;
  name: string;
  recoveryCase: RecoveryCase | null;
  methods: VerificationMethodOption[];
}) {
  const [beginState, begin] = useActionState(beginMfaRecoveryAction, initialFormState);
  const [confirmState, confirm] = useActionState(confirmMfaRecoveryAction, initialFormState);
  const [cleanupState, retryCleanup] = useActionState(retryMfaRecoveryCleanupAction, initialFormState);
  const [resumeState, resume] = useActionState(resumeMfaRecoveryProviderAction, initialFormState);
  // One message for the most recent submission, focused when it arrives:
  // the submitted form often unmounts because the case moved on.
  const [last, setLast] = useState<'begin' | 'confirm' | 'cleanup' | 'resume' | null>(null);
  const shown = last === 'begin' ? beginState : last === 'confirm' ? confirmState : last === 'cleanup' ? cleanupState
    : last === 'resume' ? resumeState : initialFormState;
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown.status !== 'idle') messageRef.current?.focus();
  }, [shown]);
  // Typed reason, method and note survive a refusal.
  const keepBegin = useKeepValuesOnFailure(useMemo(() => (beginState.status === 'idle' ? null : { ok: beginState.status === 'success' }), [beginState]));
  const keepConfirm = useKeepValuesOnFailure(useMemo(() => (confirmState.status === 'idle' ? null : { ok: confirmState.status === 'success' }), [confirmState]));
  const submitted = (which: NonNullable<typeof last>, keep?: SubmitHandler): SubmitHandler => (event) => {
    setLast(which);
    keep?.(event);
  };
  const { step: status, cleanup } = recoveryStep(recoveryCase);
  let body: ReactNode = null;
  switch (status) {
    case 'none':
    case 'completed':
      body = (
        <>
          {cleanup === 'stuck' ? (
            <Notice tone="info">
              <p>
                Cleanup of the last recovery cannot finish: the new authenticator registered for it is missing, or the case
                was replaced. {name} stays blocked. Start a new recovery to restore access.
              </p>
            </Notice>
          ) : null}
          <BeginRecoveryForm userId={userId} name={name} action={begin} invalid={beginState.status === 'error'} onSubmit={submitted('begin', keepBegin)} />
        </>
      );
      break;
    case 'cleanup':
      body = <RetryCleanupForm recoveryCase={recoveryCase!} name={name} action={retryCleanup} onSubmit={submitted('cleanup')} />;
      break;
    case 'provider_failed':
      body = <ResumeProviderForm recoveryCase={recoveryCase!} name={name} mode="failed" action={resume} onSubmit={submitted('resume')} />;
      break;
    case 'provider_pending':
      body = <ResumeProviderForm recoveryCase={recoveryCase!} name={name} mode="pending" action={resume} onSubmit={submitted('resume')} />;
      break;
    case 'awaiting_reenrollment':
      body = (
        <p className="m-0 text-copy">
          Waiting for {name} to sign in with their password and set up a new authenticator app. Their sessions stay
          blocked.
        </p>
      );
      break;
    case 'awaiting_admin_confirmation':
      body = (
        <ConfirmRecoveryForm
          recoveryCase={recoveryCase!}
          methods={methods}
          action={confirm}
          invalid={confirmState.status === 'error'}
          onSubmit={submitted('confirm', keepConfirm)}
        />
      );
      break;
  }
  return (
    <div className="flex flex-col gap-3" data-slot="recovery-section">
      <h3 className="m-0 text-base font-semibold text-ink">{RECOVERY_HEADING[status]}</h3>
      <div ref={messageRef} tabIndex={-1} className="outline-none">
        <FormMessage state={shown} />
      </div>
      {body}
    </div>
  );
}

function DeactivateForm({ userId }: { userId: string }) {
  const [state, action] = useActionState(deactivateStaffAction, initialFormState);
  useDoneOnSuccess(state);
  const keep = useKeepValuesOnFailure(useMemo(() => (state.status === 'idle' ? null : { ok: state.status === 'success' }), [state]));
  const helpId = `deactivate-help-${userId}`;
  const reasonId = `deactivate-${userId}`;
  return (
    <form action={action} noValidate onSubmit={keep} className="flex flex-col gap-3">
      <FormMessage state={state} />
      <Notice tone="danger" id={helpId}>
        <p>Ends access at once: open sessions lose access to CRM data at their next request. Their records and history stay.</p>
      </Notice>
      <input type="hidden" name="userId" value={userId} />
      <Field htmlFor={reasonId} label="Reason for deactivation" hint="At least 10 characters.">
        <Input
          id={reasonId}
          name="reason"
          required
          minLength={10}
          aria-describedby={`${helpId} ${fieldDescribedBy(reasonId, { hint: true })}`}
          invalid={state.status === 'error'}
        />
      </Field>
      <div>
        <Submit pendingLabel="Deactivating…" variant="danger">
          Deactivate staff member
        </Submit>
      </div>
    </form>
  );
}

export type StaffDrawer = 'email' | 'recovery' | 'deactivate';

/**
 * The row menu of one staff member (audit S9: actions in a row menu so the
 * list never grows wider than the page). Each item opens one drawer with
 * that action's form; the forms and fields are the ones the page always had.
 * Your own row and a deactivated person have no actions.
 */
export function StaffMemberActions({
  userId,
  name,
  status,
  isYou = false,
  recoveryCase = null,
  verificationMethods = [],
  initialOpen = null,
}: {
  userId: string;
  name: string;
  status: 'invited' | 'active' | 'inactive';
  isYou?: boolean;
  recoveryCase?: RecoveryCase | null;
  verificationMethods?: VerificationMethodOption[];
  /** Preview gallery only. */
  initialOpen?: StaffDrawer | null;
}) {
  const [open, setOpen] = useState<StaffDrawer | null>(initialOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const announce = useContext(AnnounceContext);
  const done = useCallback<Announce>(
    (text) => {
      setOpen(null);
      announce?.(text);
    },
    [announce],
  );
  const close = (o: boolean) => {
    if (!o) setOpen(null);
  };
  const usable = !isYou && status !== 'inactive';
  if (!usable && open === null) return <span className="text-sm text-quiet">No actions</span>;
  const { step } = recoveryStep(recoveryCase);
  return (
    <>
      {usable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={trigger} variant="secondary" size="sm">
              Actions<span className="sr-only"> for {name}</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-72">
            <DropdownMenuItem onSelect={() => setOpen('email')}>
              {status === 'invited' ? <MailPlus aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
              {status === 'invited' ? 'Resend invitation' : 'Send password reset email'}
            </DropdownMenuItem>
            {status === 'active' ? (
              <DropdownMenuItem onSelect={() => setOpen('recovery')}>
                <ShieldCheck aria-hidden="true" />
                {RECOVERY_MENU_LABEL[step]}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onSelect={() => setOpen('deactivate')}>
              <UserX aria-hidden="true" />
              Deactivate
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {open === 'email' && status !== 'inactive' ? (
        <ActionDrawer
          open
          onOpenChange={close}
          returnFocus={trigger}
          onDone={done}
          title={status === 'invited' ? `Resend the invitation to ${name}` : `Send ${name} a password reset email`}
          description="It goes to their work e-mail address. Delivery is not confirmed: the Staff list shows what the mail service said."
        >
          <StaffEmailForm userId={userId} status={status} />
        </ActionDrawer>
      ) : null}
      {open === 'recovery' ? (
        <ActionDrawer
          open
          onOpenChange={close}
          returnFocus={trigger}
          title={`Authenticator recovery for ${name}`}
          description="For a lost or replaced phone. Each step is recorded with your name and the time."
        >
          <RecoverySection userId={userId} name={name} recoveryCase={recoveryCase} methods={verificationMethods} />
        </ActionDrawer>
      ) : null}
      {open === 'deactivate' ? (
        <ActionDrawer open onOpenChange={close} returnFocus={trigger} onDone={done} title={`Deactivate ${name}?`} description="Needs a reason. It is recorded with your name and the time.">
          <DeactivateForm userId={userId} />
        </ActionDrawer>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Extra access (same fields: userId, permission, legalEntityId, branchId, expiresAt, reason; grantId, reason)
// ---------------------------------------------------------------------------

export function GrantForm({
  staff,
  entities,
  branches,
  initialState,
}: {
  staff: Option[];
  entities: Option[];
  branches: Option[];
  /** Preview gallery only. */
  initialState?: FormState;
}) {
  const [state, action] = useActionState(grantScopeAction, initialState ?? initialFormState);
  // Batch 4 (T-B4-18): submitted by hand so a refusal keeps the person, access, scope and reason; empty again after a save.
  const savedKey = useFormStateSavedKey(state);
  useDoneOnSuccess(state);
  return (
    <HandForm key={savedKey} action={action} noValidate className="flex flex-col gap-4">
      <FormMessage state={state} />
      <Field htmlFor="grant-user" label="Staff member">
        <Select id="grant-user" name="userId" required defaultValue="">
          <option value="" disabled>
            Choose a staff member
          </option>
          {staff.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor="grant-permission" label="Access">
        <Select id="grant-permission" name="permission" required defaultValue="deal.read">
          <option value="deal.read">View deals</option>
          <option value="deal.read_commercial">See prices and margin</option>
        </Select>
      </Field>
      <Field htmlFor="grant-entity" label="Legal entity">
        <Select id="grant-entity" name="legalEntityId" required>
          {entities.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor="grant-branch" label="Branch" hint="Leave as “Whole entity” only when the person needs every branch.">
        <Select id="grant-branch" name="branchId" aria-describedby={fieldDescribedBy('grant-branch', { hint: true })} defaultValue="">
          <option value="">Whole entity</option>
          {branches.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor="grant-expiry" label="Expires on (optional)">
        <Input id="grant-expiry" name="expiresAt" type="date" />
      </Field>
      <Field htmlFor="grant-reason" label="Business reason" hint="10 to 500 characters.">
        <Input id="grant-reason" name="reason" required minLength={10} maxLength={500} aria-describedby={fieldDescribedBy('grant-reason', { hint: true })} />
      </Field>
      <div>
        <Submit pendingLabel="Saving…">Record grant</Submit>
      </div>
    </HandForm>
  );
}

function RevokeForm({ grantId, onSaved }: { grantId: string; onSaved: Announce }) {
  const [state, action] = useActionState(revokeGrantAction, initialFormState);
  useEffect(() => {
    if (state.status === 'success') onSaved(state.message ?? 'Grant revoked.');
  }, [state, onSaved]);
  const keep = useKeepValuesOnFailure(useMemo(() => (state.status === 'idle' ? null : { ok: state.status === 'success' }), [state]));
  const reasonId = `revoke-${grantId}`;
  return (
    <form action={action} noValidate onSubmit={keep} className="flex flex-col">
      <DialogBody className="flex flex-col gap-3">
        <FormMessage state={state} />
        <input type="hidden" name="grantId" value={grantId} />
        <Field htmlFor={reasonId} label="Reason" hint="At least 10 characters.">
          <Input id={reasonId} name="reason" required minLength={10} aria-describedby={fieldDescribedBy(reasonId, { hint: true })} invalid={state.status === 'error'} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Submit pendingLabel="Revoking…" variant="danger">
          Revoke grant
        </Submit>
      </DialogFooter>
    </form>
  );
}

/** Revoke one grant: a dialog with the required reason (same fields: grantId, reason). */
export function RevokeGrantForm({ grantId, label, initialOpen = false }: { grantId: string; label: string; /** Preview gallery only. */ initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const announce = useContext(AnnounceContext);
  const descId = useId();
  const saved = useCallback<Announce>(
    (text) => {
      setOpen(false);
      announce?.(text);
    },
    [announce],
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          Revoke<span className="sr-only"> {label}</span>
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={descId}>
        <DialogHeader>
          <DialogTitle>Revoke {label}?</DialogTitle>
          <DialogDescription id={descId}>The person loses this access at their next page. The grant and its reason stay in the history.</DialogDescription>
        </DialogHeader>
        <RevokeForm grantId={grantId} onSaved={saved} />
      </DialogContent>
    </Dialog>
  );
}
