// Settings · People and access screens live in ./settings/people-views (R1); do not import them here
// (the frozen Purchase work tab imports this file, see the note there).

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
