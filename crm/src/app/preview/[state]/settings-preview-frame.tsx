import type { ReactNode } from 'react';
import { settingsTabsFor } from '@/modules/settings/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { SettingsFrame } from '@/views/settings/settings-frame';

/*
 * Batch 4 preview helper: a Settings page as the admin layout renders it (the
 * staff frame, then the Settings frame with the tabs this viewer may open).
 * Synthetic viewers only.
 */

/** Super Admin with every Settings right (no Purchase role). */
export const settingsOwner: ShellViewer = {
  displayName: 'Synthetic Owner Jodhpur',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
  canManageIntegration: true,
  canOpenBitrixConnection: true,
  canManageFinancePolicy: true,
  canSeeLeads: true,
  canImport: true,
};

/** Bitrix connection manager only (integration.manage, no Purchase). */
export const settingsIntegrationOnly: ShellViewer = {
  displayName: 'Synthetic Integration Admin',
  primaryRole: 'Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canManageIntegration: true,
  canOpenBitrixConnection: true,
};

/** Staff admin only. */
export const settingsStaffOnly: ShellViewer = {
  displayName: 'Synthetic Staff Admin',
  primaryRole: 'Admin',
  primaryBranch: 'Delhi',
  canAdministerStaff: true,
  canManageGrants: false,
};

export function inSettings(viewer: ShellViewer, path: string, children: ReactNode): ReactNode {
  const tabs = settingsTabsFor({
    canAdministerStaff: viewer.canAdministerStaff,
    canManageGrants: viewer.canManageGrants,
    canManageIntegration: !!viewer.canManageIntegration,
    canOpenBitrixConnection: !!viewer.canOpenBitrixConnection,
    canManageFinancePolicy: !!viewer.canManageFinancePolicy,
    canImport: !!viewer.canImport,
  });
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      <SettingsFrame tabs={tabs} currentPath={path}>
        {children}
      </SettingsFrame>
    </StaffShell>
  );
}

/** Drop-in for StaffShell on a Settings address: the staff frame plus the Settings frame. */
export function SettingsShell({ viewer, currentPath, children }: { viewer: ShellViewer; currentPath: string; children: ReactNode }) {
  return inSettings(viewer, currentPath, children);
}
