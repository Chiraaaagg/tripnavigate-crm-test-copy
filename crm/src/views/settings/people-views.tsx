import { CircleCheck, CircleOff, CircleX, Hourglass, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { QueueToolbar } from '@/components/ui/queue-toolbar';
import { StateBlock } from '@/components/ui/state-block';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import type { FormState } from '@/lib/forms';
import {
  type PeopleSection,
  SETTINGS_PATH,
  SETTINGS_ROLES_PATH,
  STAFF_STATUS_FILTER_LABEL,
  STAFF_STATUS_FILTERS,
  STAFF_NO_METHOD_TEXT,
  staffFailureWords,
  staffQueue,
  type StaffStatusFilter,
} from '@/modules/settings/contracts';
import type { BitrixUser } from '@/modules/integration/bitrix/directory';
import { AddStaffFromBitrixForm, BitrixLinkCell } from '../bitrix-access-forms';
import type {
  RecoveryCase,
  StaffEmailDelivery,
  StaffSecurityInfo,
  VerificationMethodOption,
} from '@/modules/identity/contracts';
import { recoveryCleanupState } from '@/modules/identity/contracts';
import { FormDrawer, GrantForm, InviteStaffForm, type Option, PeopleResults, RevokeGrantForm, StaffMemberActions } from '../admin-forms';
import { formatIst } from '../deal-labels';
import type { GrantLine } from '../staff-views';

/*
 * Settings · People and access (R1, S1): the Staff list, Roles and branches,
 * Extra access and the no-permission view. Moved here from staff-views.tsx by
 * the R1 integration: the frozen Purchase work tab imports formatIst from
 * staff-views, so every part these screens import (QueueToolbar, StateBlock)
 * fell inside the approved forms' import closure (check-frozen-forms.test.ts).
 * staff-views.tsx keeps My access and its re-exports and must not import this file.
 */

export interface StaffLine {
  userId: string;
  displayName: string;
  email: string;
  status: 'invited' | 'active' | 'inactive';
  access: string[];
  isYou: boolean;
}

const STATUS_BADGE: Record<StaffLine['status'], { label: string; tone: StatusTone; icon: LucideIcon }> = {
  active: { label: 'Active', tone: 'success', icon: CircleCheck },
  invited: { label: 'Invited, setup not finished', tone: 'warning', icon: Hourglass },
  inactive: { label: 'Deactivated', tone: 'neutral', icon: CircleOff },
};

const EMAIL_KIND_LABEL: Record<StaffEmailDelivery['kind'], string> = {
  invitation: 'Invitation',
  invitation_resend: 'Invitation (resent)',
  password_reset: 'Password reset',
};

/** The stored code behind "Details", for the CRM team (audit S10). */
function CodeDetails({ code, what }: { code: string; what: string }) {
  return (
    <details className="mt-0.5 text-sm">
      <summary className={cn('w-fit cursor-pointer rounded-chip font-medium text-brand-strong', focusRing)}>
        Details<span className="sr-only"> of {what}</span>
      </summary>
      <p className="m-0 mt-1 text-quiet">
        Code for the CRM team: <span className="font-mono">{code}</span>
      </p>
    </details>
  );
}

/** Last admin-initiated email. Never says "delivered": we only know the mail service accepted it. */
export function EmailStatusText({ email }: { email: StaffEmailDelivery | null | undefined }) {
  if (!email) return <span>No email sent from this CRM yet</span>;
  const kind = EMAIL_KIND_LABEL[email.kind];
  const attempt = email.attemptNo > 1 ? ` (attempt ${email.attemptNo})` : '';
  switch (email.status) {
    case 'handed_to_provider':
      return (
        <span>
          {kind}
          {attempt}: Handed to the mail service at {formatIst(email.completedAt ?? email.createdAt)}
        </span>
      );
    case 'failed':
      return (
        <span className="flex flex-col">
          <span>
            {kind}
            {attempt}: <strong>Failed:</strong> {staffFailureWords(email.errorCode, 'mail')}
          </span>
          {email.errorCode ? <CodeDetails code={email.errorCode} what="the e-mail problem" /> : null}
        </span>
      );
    default:
      return (
        <span>
          {kind}
          {attempt}: Pending, requested at {formatIst(email.createdAt)}
        </span>
      );
  }
}

function RecoveryBadge({ tone, children }: { tone: 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const icon = tone === 'success' ? CircleCheck : tone === 'danger' ? CircleX : Hourglass;
  return (
    <StatusBadge tone={tone} icon={icon} wrap>
      {children}
    </StatusBadge>
  );
}

function LastError({ code }: { code: string }) {
  return (
    <>
      <p>Last error: {staffFailureWords(code, 'sign-in')}</p>
      <CodeDetails code={code} what="the authenticator problem" />
    </>
  );
}

/** Recovery case status as text (colour is decoration only). */
export function RecoveryStatusText({ recovery }: { recovery: RecoveryCase | null | undefined }) {
  if (!recovery) return <span>No recovery in progress</span>;
  const opened = <p>Started {formatIst(recovery.openedAt)}. All earlier sessions are blocked.</p>;
  switch (recovery.status) {
    case 'provider_pending':
      return (
        <>
          <RecoveryBadge tone="warning">Resetting their authenticator app — step 1 of 3: removing the old app</RecoveryBadge>
          <p>If this does not change after a reload, no result was recorded; check and finish it from Actions.</p>
          {opened}
        </>
      );
    case 'provider_failed':
      return (
        <>
          <RecoveryBadge tone="danger">Resetting their authenticator app — step 1 of 3: removing the old app failed</RecoveryBadge>
          <p>Attempts: {recovery.providerAttempts}. The person stays blocked until this succeeds. Retry from Actions.</p>
          {recovery.lastProviderError ? <LastError code={recovery.lastProviderError} /> : null}
          {opened}
        </>
      );
    case 'awaiting_reenrollment':
      return (
        <>
          <RecoveryBadge tone="warning">Resetting their authenticator app — step 2 of 3: waiting for their new app</RecoveryBadge>
          <p>The person must sign in with their password and set up a new authenticator app.</p>
          {opened}
        </>
      );
    case 'awaiting_admin_confirmation':
      return (
        <>
          <RecoveryBadge tone="warning">Resetting their authenticator app — step 3 of 3: waiting for your confirmation</RecoveryBadge>
          <p>Verify their identity, ask for the code on their screen, then confirm from Actions.</p>
          {opened}
        </>
      );
    case 'completed': {
      const confirmed = recovery.completedAt ? <p>Identity confirmed {formatIst(recovery.completedAt)}.</p> : null;
      switch (recoveryCleanupState(recovery)) {
        case 'done':
          return (
            <>
              <RecoveryBadge tone="success">Authenticator app reset finished</RecoveryBadge>
              {recovery.completedAt ? <p>Completed {formatIst(recovery.completedAt)}.</p> : null}
            </>
          );
        case 'failed':
          return (
            <>
              <RecoveryBadge tone="danger">Reset confirmed: removing their other authenticator apps failed</RecoveryBadge>
              <p>The person stays blocked until this succeeds. Retry from Actions; do not start a new recovery.</p>
              {recovery.cleanupError ? <LastError code={recovery.cleanupError} /> : null}
              {confirmed}
            </>
          );
        case 'stuck':
          return (
            <>
              <RecoveryBadge tone="danger">Reset confirmed: the clean-up cannot finish</RecoveryBadge>
              <p>
                The new authenticator registered for this recovery is missing, or the case was replaced, so retrying cannot
                help. The person stays blocked. Start a new recovery from Actions.
              </p>
              {recovery.cleanupError ? <LastError code={recovery.cleanupError} /> : null}
              {confirmed}
            </>
          );
        case 'pending':
          return (
            <>
              <RecoveryBadge tone="warning">Reset confirmed: removing their other authenticator apps is not finished</RecoveryBadge>
              <p>
                No cleanup result is recorded yet, so the outcome is unknown. The person stays blocked until cleanup is
                recorded. Retry from Actions; it only removes authenticators other than the new one.
              </p>
              {confirmed}
            </>
          );
      }
    }
  }
}

export interface PeopleSectionLinks {
  /** Staff and the read-only Roles and branches list (staff.manage). */
  staff: boolean;
  /** Extra access (access.grant). */
  access: boolean;
}

/**
 * People and access sub-sections (pill tabs, C5): Staff · Extra access ·
 * Roles and branches. Each is its own address (Staff and Extra access keep
 * theirs; Roles and branches is the Staff page's ?tab=roles). Shown only when
 * the person may open more than one.
 */
function PeopleSectionNav({ links, current }: { links?: PeopleSectionLinks; current: PeopleSection }) {
  if (!links) return null;
  const items = [
    ...(links.staff ? [{ key: 'staff' as const, href: SETTINGS_PATH.staff, label: 'Staff' }] : []),
    ...(links.access ? [{ key: 'access' as const, href: SETTINGS_PATH.access, label: 'Extra access' }] : []),
    ...(links.staff ? [{ key: 'roles' as const, href: SETTINGS_ROLES_PATH, label: 'Roles and branches' }] : []),
  ];
  if (items.length < 2) return null;
  return <Tabs variant="pill" label="People and access sections" items={items.map((i) => ({ href: i.href, label: i.label, current: i.key === current }))} />;
}

/** The sub-section tabs and the page's buttons on one row (wraps on phones). */
function PeopleBar({ links, current, actions }: { links?: PeopleSectionLinks; current: PeopleSection; actions?: ReactNode }) {
  const nav = <PeopleSectionNav links={links} current={current} />;
  if (!actions) return nav;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-slot="people-bar">
      {nav ?? <span />}
      <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1">{actions}</div>
    </div>
  );
}

export interface StaffQueueFilter {
  q?: string;
  status?: StaffStatusFilter;
}

function staffHref(filter: { q?: string; status?: StaffStatusFilter }): string {
  const qs = new URLSearchParams();
  if (filter.status && filter.status !== 'all') qs.set('status', filter.status);
  if (filter.q) qs.set('q', filter.q);
  const s = qs.toString();
  return s ? `${SETTINGS_PATH.staff}?${s}` : SETTINGS_PATH.staff;
}

type BitrixAccess = {
  users: BitrixUser[] | null;
  error: string | null;
  /** staff userId -> linked Bitrix user */
  links: Record<string, { id: string; name: string }>;
} | null;

function StaffRow({ s, bitrix, security, verificationMethods }: { s: StaffLine; bitrix: BitrixAccess; security?: StaffSecurityInfo; verificationMethods: VerificationMethodOption[] }) {
  const badge = STATUS_BADGE[s.status];
  return (
    <li className="m-0 flex flex-col gap-3 px-4.5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-5" data-slot="staff-row">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 font-semibold text-ink">
          {s.displayName}
          {s.isYou ? <span className="font-normal text-quiet"> (you)</span> : null}
        </p>
        <p className="m-0 text-sm wrap-anywhere text-quiet">{s.email}</p>
        <p className="m-0 text-sm text-copy">
          <span className="text-quiet">Roles and branches: </span>
          {s.access.length > 0 ? s.access.join('; ') : 'None'}
        </p>
        <div className="flex flex-col gap-1 text-sm text-copy [&_p]:m-0" data-slot="staff-security">
          <span className="text-quiet">Sign-in security:</span>
          <RecoveryStatusText recovery={security?.recovery} />
        </div>
        <div className="text-sm text-copy" data-slot="staff-email">
          <span className="text-quiet">Last email: </span>
          <EmailStatusText email={security?.lastEmail} />
        </div>
        {bitrix ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-copy" data-slot="staff-bitrix">
            <span className="text-quiet">Bitrix user (deal access):</span>
            {s.status === 'inactive' ? (
              <span>No access (deactivated)</span>
            ) : (
              <BitrixLinkCell userId={s.userId} name={s.displayName} linked={bitrix.links[s.userId] ?? null} users={bitrix.users} />
            )}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <StatusBadge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </StatusBadge>
        <StaffMemberActions
          userId={s.userId}
          name={s.displayName}
          status={s.status}
          isYou={s.isYou}
          recoveryCase={security?.recovery ?? null}
          verificationMethods={verificationMethods}
        />
      </div>
    </li>
  );
}

export function StaffAdminView({
  staff,
  branches,
  roles,
  inviteDomains,
  security = {},
  verificationMethods = [],
  bitrix = null,
  sectionLinks,
  filter = {},
  inviteOpen = false,
  inviteState,
}: {
  /** Settings · People and access sub-sections; absent: none. */
  sectionLinks?: PeopleSectionLinks;
  /** Bitrix access panel; null when the viewer cannot manage the Bitrix integration. */
  bitrix?: BitrixAccess;
  staff: StaffLine[];
  branches: Option[];
  roles: Option[];
  inviteDomains: string[];
  /** Per userId; from loadStaffAdmin(staff).security. */
  security?: Record<string, StaffSecurityInfo>;
  /** Approved identity-verification methods; empty means recovery cannot be completed. */
  verificationMethods?: VerificationMethodOption[];
  /** Search and status chip from the address (?q=, ?status=). */
  filter?: StaffQueueFilter;
  /** Preview gallery only: the invite drawer open, optionally with a reply on screen. */
  inviteOpen?: boolean;
  inviteState?: FormState;
}) {
  const status = filter.status ?? 'all';
  const { rows, counts } = staffQueue(staff, { q: filter.q, status });
  const chips = STAFF_STATUS_FILTERS.map((f) => ({ href: staffHref({ q: filter.q, status: f }), label: STAFF_STATUS_FILTER_LABEL[f], count: counts[f], current: f === status }));
  const filtered = Boolean(filter.q) || status !== 'all';
  const actions = (
    <>
      {bitrix ? (
        <FormDrawer
          label="Add from Bitrix"
          icon="person"
          title="Add staff from Bitrix"
          description="Pick a person from Bitrix. They get the normal invitation (password and authenticator) and are linked to their Bitrix user, so the Bitrix deals they are responsible for become theirs once they finish signing up."
        >
          {bitrix.error ? (
            <Notice tone="danger" role="alert" className="mb-4">
              <p>
                <strong>Bitrix users could not be loaded: </strong>
                {bitrix.error}
              </p>
            </Notice>
          ) : null}
          {bitrix.users ? <AddStaffFromBitrixForm users={bitrix.users} branches={branches} roles={roles} /> : null}
        </FormDrawer>
      ) : null}
      <FormDrawer
        label="Invite staff"
        variant="primary"
        title="Invite staff"
        initialOpen={inviteOpen}
        description={
          <>
            The person receives an email to choose a password and must set up an authenticator before seeing any data. This
            environment can invite: <strong className="text-copy">{inviteDomains.join(', ')}</strong>.
          </>
        }
      >
        <InviteStaffForm branches={branches} roles={roles} initialState={inviteState} />
      </FormDrawer>
    </>
  );
  return (
    <PeopleResults>
      <PeopleBar links={sectionLinks} current="staff" actions={actions} />
      <QueueToolbar
        action={SETTINGS_PATH.staff}
        label="Search and filter staff"
        chipsLabel="Staff by status"
        search={{ name: 'q', value: filter.q ?? '', label: 'Search staff', placeholder: 'Name or work email' }}
        chips={chips}
        keep={status !== 'all' ? { status } : undefined}
      />
      <Card>
        <CardHeader>
          <CardTitle>Staff</CardTitle>
          <CardDescription>
            {filtered ? `${rows.length} of ${staff.length} shown.` : `${staff.length} in your entities.`}
            {verificationMethods.length === 0 ? ` ${STAFF_NO_METHOD_TEXT}` : ''}
          </CardDescription>
        </CardHeader>
        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            card={false}
            title={filtered ? 'No staff match' : 'No staff yet'}
            text={filtered ? 'Nobody matches this search or status. Clear the search or choose All.' : 'Invite the first staff member with “Invite staff”.'}
            action={
              filtered ? (
                <Link href={SETTINGS_PATH.staff} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  Show all staff
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul aria-label="Staff in your entities" className="m-0 list-none divide-y divide-line border-t border-line p-0">
            {rows.map((s) => (
              <StaffRow key={s.userId} s={s} bitrix={bitrix} security={security[s.userId]} verificationMethods={verificationMethods} />
            ))}
          </ul>
        )}
      </Card>
    </PeopleResults>
  );
}

/**
 * Roles and branches (D8 deferred, build plan 2.1): read only, from the rows
 * the Staff page already loads. Changing roles comes in a later release with
 * its own database command; nothing on this page gives or removes a role.
 */
export function RolesAndBranchesView({ staff, sectionLinks }: { staff: StaffLine[]; sectionLinks?: PeopleSectionLinks }) {
  const people = staff.filter((s) => s.status !== 'inactive');
  return (
    <>
      <PeopleBar links={sectionLinks} current="roles" />
      <StateBlock kind="readOnly" text="You can view this. Changing roles and branches is coming in a later release." who="Until then, invite the person again for another role, or ask the CRM team." />
      <Card>
        <CardHeader>
          <CardTitle>Roles and branches</CardTitle>
          <CardDescription>Each active or invited staff member, with every role they hold and the branch it is for.</CardDescription>
        </CardHeader>
        {people.length === 0 ? (
          <StateBlock kind="empty" card={false} title="No staff yet" text="Nobody is active or invited in your entities." />
        ) : (
          <Table label="Roles and branches of each staff member" stackOnMobile>
            <TableCaption className="sr-only">Roles and branches of each staff member</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Staff member</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Roles and branches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map((s) => {
                const badge = STATUS_BADGE[s.status];
                return (
                  <TableRow key={s.userId}>
                    <TableCell>
                      <span className="font-semibold text-ink">{s.displayName}</span>
                      {s.isYou ? <span className="text-quiet"> (you)</span> : null}
                      <span className="block text-sm wrap-anywhere text-quiet">{s.email}</span>
                    </TableCell>
                    <TableCell label="Status">
                      <StatusBadge tone={badge.tone} icon={badge.icon}>
                        {badge.label}
                      </StatusBadge>
                    </TableCell>
                    <TableCell label="Roles and branches" className="max-sm:text-right">
                      {s.access.length > 0 ? (
                        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                          {s.access.map((a) => (
                            <li key={a} className="m-0">
                              {a}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-quiet">None</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}

export function AccessGrantsView({
  grants,
  staff,
  entities,
  branches,
  sectionLinks,
  grantOpen = false,
  grantState,
}: {
  /** Settings · People and access sub-sections; absent: none. */
  sectionLinks?: PeopleSectionLinks;
  grants: GrantLine[];
  staff: Option[];
  entities: Option[];
  branches: Option[];
  /** Preview gallery only: the grant drawer open, optionally with a reply on screen. */
  grantOpen?: boolean;
  grantState?: FormState;
}) {
  const action = (
    <FormDrawer label="Give extra access" variant="primary" icon="person" title="Give extra access" initialOpen={grantOpen} description="Lets someone see more deals. It needs a reason and cannot be given to yourself. Purchase staff can never get price access.">
      <GrantForm staff={staff} entities={entities} branches={branches} initialState={grantState} />
    </FormDrawer>
  );
  return (
    <PeopleResults>
      <PeopleBar links={sectionLinks} current="access" actions={action} />
      <Card>
        <CardHeader>
          <CardTitle>Extra access now</CardTitle>
          <CardDescription>Extra access lets someone see more deals. It needs a reason and cannot be given to yourself. Purchase staff can never get price access.</CardDescription>
        </CardHeader>
        {grants.length === 0 ? (
          <StateBlock kind="empty" card={false} title="No one has extra access now" text="Everyone sees only the deals their role and branch allow." />
        ) : (
          <Table label="Extra access now" stackOnMobile>
            <TableCaption className="sr-only">Extra access now</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Staff member</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>
                  <span className="sr-only">Next step</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="font-semibold text-ink">{g.staffName}</TableCell>
                  <TableCell label="Access">
                    {g.permissionLabel}
                    <span className="block text-sm text-quiet">{g.scopeLabel}</span>
                  </TableCell>
                  <TableCell label="Reason" className="text-sm">
                    {g.reason}
                  </TableCell>
                  <TableCell label="Expires">{g.expiresOn ?? 'No expiry'}</TableCell>
                  <TableCell label="Next step">
                    <RevokeGrantForm grantId={g.id} label={`${g.permissionLabel} for ${g.staffName}`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PeopleResults>
  );
}

/** Someone without the right opened Staff or Extra access (the page's own check): one heading (the frame) and the reason. */
export function PeopleNoPermissionView({ section }: { section: 'staff' | 'access' }) {
  return (
    <Notice tone="restricted" role="status">
      <p>{section === 'staff' ? 'You do not have permission to administer staff.' : 'You do not have permission to manage extra access.'}</p>
    </Notice>
  );
}
