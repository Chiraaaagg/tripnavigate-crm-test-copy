import { Tabs } from '@/components/ui/tabs';
import { SETTINGS_PATH } from '@/modules/settings/contracts';
import { SettingsSectionHeading } from './settings/settings-frame';
import type { BitrixUser } from '@/modules/integration/bitrix/directory';
import { AddStaffFromBitrixForm, BitrixLinkCell } from './bitrix-access-forms';
import type {
  RecoveryCase,
  StaffEmailDelivery,
  StaffSecurityInfo,
  VerificationMethodOption,
} from '@/modules/identity/contracts';
import { recoveryCleanupState } from '@/modules/identity/contracts';
import { GrantForm, InviteStaffForm, type Option, RevokeGrantForm, StaffMemberActions } from './admin-forms';
import { formatIst } from './deal-labels';

// Moved to the leaf module ./deal-labels (no view imports); re-exported so existing imports keep working.
export { BITRIX_OWNS_TEXT, formatIst, RELATION_LABEL, STALE_SYNC_TEXT, stageText } from './deal-labels';
// The deal page moved to ./deal-page-view (screen group 4); re-exported so existing imports keep working.
export { DealNotFoundView } from './deal-page-view';

export { HomeView } from './home-view';
export { dealsHref, type DealsPaging } from './deals-list-view';

export interface MembershipLine {
  branchName: string;
  isHeadOffice: boolean;
  roleName: string;
  legalEntityName: string;
}

export interface GrantLine {
  id: string;
  staffName: string;
  permissionLabel: string;
  scopeLabel: string;
  reason: string;
  grantedOn: string;
  expiresOn: string | null;
}

export function MyAccessView({ memberships, grants }: { memberships: MembershipLine[]; grants: GrantLine[] }) {
  return (
    <>
      <h1>My access</h1>
      <p>Your role gives access to deals you own or are assigned to. Anything wider must be granted explicitly.</p>
      <table>
        <caption>Branch memberships</caption>
        <thead>
          <tr>
            <th scope="col">Legal entity</th>
            <th scope="col">Branch</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {memberships.map((m) => (
            <tr key={`${m.legalEntityName}-${m.branchName}-${m.roleName}`}>
              <td>{m.legalEntityName}</td>
              <td>
                {m.branchName}
                {m.isHeadOffice ? ' (head office)' : ''}
              </td>
              <td>{m.roleName}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mt-2">Wider access grants</h2>
      {grants.length === 0 ? (
        <p role="status">You have no wider access grants.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Wider access grants</caption>
          <thead>
            <tr>
              <th scope="col">Access</th>
              <th scope="col">Scope</th>
              <th scope="col">Reason</th>
              <th scope="col">Expires</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.permissionLabel}</td>
                <td>{g.scopeLabel}</td>
                <td>{g.reason}</td>
                <td>{g.expiresOn ?? 'No expiry'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export interface StaffLine {
  userId: string;
  displayName: string;
  email: string;
  status: 'invited' | 'active' | 'inactive';
  access: string[];
  isYou: boolean;
}

const STATUS_BADGE: Record<StaffLine['status'], { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'ok' },
  invited: { label: 'Invited, setup not finished', tone: 'warn' },
  inactive: { label: 'Deactivated', tone: 'danger' },
};

const EMAIL_KIND_LABEL: Record<StaffEmailDelivery['kind'], string> = {
  invitation: 'Invitation',
  invitation_resend: 'Invitation (resent)',
  password_reset: 'Password reset',
};

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
        <span>
          {kind}
          {attempt}: <strong>Failed:</strong> {email.errorCode ?? 'the mail service refused the message'}
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

/** Recovery case status as text (colour is decoration only). */
export function RecoveryStatusText({ recovery }: { recovery: RecoveryCase | null | undefined }) {
  if (!recovery) return <span>No recovery in progress</span>;
  const opened = <p>Started {formatIst(recovery.openedAt)}. All earlier sessions are blocked.</p>;
  switch (recovery.status) {
    case 'provider_pending':
      return (
        <>
          <span className="badge warn">Resetting their authenticator app — step 1 of 3: removing the old app</span>
          <p>If this does not change after a reload, no result was recorded; check and finish it from Actions.</p>
          {opened}
        </>
      );
    case 'provider_failed':
      return (
        <>
          <span className="badge danger">Resetting their authenticator app — step 1 of 3: removing the old app failed</span>
          <p>
            Attempts: {recovery.providerAttempts}
            {recovery.lastProviderError ? `. Last error: ${recovery.lastProviderError}` : ''}. The person stays blocked
            until this succeeds. Retry from Actions.
          </p>
          {opened}
        </>
      );
    case 'awaiting_reenrollment':
      return (
        <>
          <span className="badge warn">Resetting their authenticator app — step 2 of 3: waiting for their new app</span>
          <p>The person must sign in with their password and set up a new authenticator app.</p>
          {opened}
        </>
      );
    case 'awaiting_admin_confirmation':
      return (
        <>
          <span className="badge warn">Resetting their authenticator app — step 3 of 3: waiting for your confirmation</span>
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
              <span className="badge ok">Authenticator app reset finished</span>
              {recovery.completedAt ? <p>Completed {formatIst(recovery.completedAt)}.</p> : null}
            </>
          );
        case 'failed':
          return (
            <>
              <span className="badge danger">Reset confirmed: removing their other authenticator apps failed</span>
              <p>
                Last error: {recovery.cleanupError}. The person stays blocked until this succeeds. Retry from Actions;
                do not start a new recovery.
              </p>
              {confirmed}
            </>
          );
        case 'stuck':
          return (
            <>
              <span className="badge danger">Reset confirmed: the clean-up cannot finish</span>
              <p>
                Last error: {recovery.cleanupError}. The new authenticator registered for this recovery is missing, or the
                case was replaced, so retrying cannot help. The person stays blocked. Start a new recovery from Actions.
              </p>
              {confirmed}
            </>
          );
        case 'pending':
          return (
            <>
              <span className="badge warn">Reset confirmed: removing their other authenticator apps is not finished</span>
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
  staff: boolean;
  access: boolean;
}

/**
 * People and access (DA-252, DA-263): the two sections Staff and Extra access
 * live at their own addresses (L1); these links move between them. Shown only
 * when the person may open both.
 */
function PeopleSectionNav({ links, current }: { links?: PeopleSectionLinks; current: 'staff' | 'access' }) {
  if (!links || !links.staff || !links.access) return null;
  const items = [
    { key: 'staff' as const, href: SETTINGS_PATH.staff, label: 'Staff' },
    { key: 'access' as const, href: SETTINGS_PATH.access, label: 'Extra access' },
  ];
  return <Tabs label="People and access sections" items={items.map((i) => ({ href: i.href, label: i.label, current: i.key === current }))} />;
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
}: {
  /** Settings · People and access sub-links (Staff · Extra access); absent: none. */
  sectionLinks?: PeopleSectionLinks;
  /** Bitrix access panel; null when the viewer cannot manage the Bitrix integration. */
  bitrix?: {
    users: BitrixUser[] | null;
    error: string | null;
    /** staff userId -> linked Bitrix user */
    links: Record<string, { id: string; name: string }>;
  } | null;
  staff: StaffLine[];
  branches: Option[];
  roles: Option[];
  inviteDomains: string[];
  /** Per userId; from loadStaffAdmin(staff).security. */
  security?: Record<string, StaffSecurityInfo>;
  /** Approved identity-verification methods; empty means recovery cannot be completed. */
  verificationMethods?: VerificationMethodOption[];
}) {
  return (
    <>
      <PeopleSectionNav links={sectionLinks} current="staff" />
      <SettingsSectionHeading>Staff</SettingsSectionHeading>
      <section className="panel" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite a staff member</h2>
        <p>
          The person receives an email to choose a password and must set up an authenticator before seeing any data.
          This environment can invite: <strong>{inviteDomains.join(', ')}</strong>.
        </p>
        <InviteStaffForm branches={branches} roles={roles} />
      </section>
      {bitrix ? (
        <section className="panel" aria-labelledby="bitrix-add-heading">
          <h2 id="bitrix-add-heading">Add staff from Bitrix</h2>
          <p>
            Pick a person from Bitrix. They get the normal invitation (password + authenticator) and are linked to their
            Bitrix user, so the Bitrix deals they are responsible for become theirs once they finish signing up.
          </p>
          {bitrix.error ? (
            <p className="message error" role="alert">
              <strong>Bitrix users could not be loaded: </strong>
              {bitrix.error}
            </p>
          ) : null}
          {bitrix.users ? <AddStaffFromBitrixForm users={bitrix.users} branches={branches} roles={roles} /> : null}
        </section>
      ) : null}
      {verificationMethods.length === 0 ? (
        <p className="message info" role="note">
          No identity-verification method has been approved yet; recovery cannot be completed in this environment.
        </p>
      ) : null}
      <table>
        <caption>Staff in your entities</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col">Branch and role</th>
            {bitrix ? <th scope="col">Bitrix user (deal access)</th> : null}
            <th scope="col">Sign-in security</th>
            <th scope="col">Last email</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.userId}>
              <td>
                {s.displayName}
                {s.isYou ? ' (you)' : ''}
              </td>
              <td>{s.email}</td>
              <td>
                <span className={`badge ${STATUS_BADGE[s.status].tone}`}>{STATUS_BADGE[s.status].label}</span>
              </td>
              <td>{s.access.join('; ')}</td>
              {bitrix ? (
                <td>
                  {s.status === 'inactive' ? (
                    <span className="hint">No access (deactivated)</span>
                  ) : (
                    <BitrixLinkCell
                      userId={s.userId}
                      name={s.displayName}
                      linked={bitrix.links[s.userId] ?? null}
                      users={bitrix.users}
                    />
                  )}
                </td>
              ) : null}
              <td className="security-cell">
                <RecoveryStatusText recovery={security[s.userId]?.recovery} />
              </td>
              <td className="security-cell">
                <EmailStatusText email={security[s.userId]?.lastEmail} />
              </td>
              <td>
                {s.isYou || s.status === 'inactive' ? (
                  <span className="brand-entity">None available</span>
                ) : (
                  <StaffMemberActions
                    userId={s.userId}
                    name={s.displayName}
                    status={s.status}
                    recoveryCase={security[s.userId]?.recovery ?? null}
                    verificationMethods={verificationMethods}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function AccessGrantsView({
  grants,
  staff,
  entities,
  branches,
  sectionLinks,
}: {
  /** Settings · People and access sub-links (Staff · Extra access); absent: none. */
  sectionLinks?: PeopleSectionLinks;
  grants: GrantLine[];
  staff: Option[];
  entities: Option[];
  branches: Option[];
}) {
  return (
    <>
      <PeopleSectionNav links={sectionLinks} current="access" />
      <SettingsSectionHeading description="Extra access lets someone see more deals. It needs a reason and cannot be given to yourself. Purchase staff can never get price access.">
        Extra access
      </SettingsSectionHeading>
      <section className="panel" aria-labelledby="grant-heading">
        <h2 id="grant-heading">Give extra access</h2>
        <GrantForm staff={staff} entities={entities} branches={branches} />
      </section>
      {grants.length === 0 ? (
        <p role="status">No one has extra access now.</p>
      ) : (
        <table>
          <caption>Extra access now</caption>
          <thead>
            <tr>
              <th scope="col">Staff member</th>
              <th scope="col">Access</th>
              <th scope="col">Scope</th>
              <th scope="col">Reason</th>
              <th scope="col">Expires</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.staffName}</td>
                <td>{g.permissionLabel}</td>
                <td>{g.scopeLabel}</td>
                <td>{g.reason}</td>
                <td>{g.expiresOn ?? 'No expiry'}</td>
                <td>
                  <RevokeGrantForm grantId={g.id} label={`${g.permissionLabel} for ${g.staffName}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
