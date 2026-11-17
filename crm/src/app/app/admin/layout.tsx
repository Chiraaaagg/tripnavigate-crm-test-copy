import type { ReactNode } from 'react';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { settingsTabsFor } from '@/modules/settings/contracts';
import { SettingsFrame } from '@/views/settings/settings-frame';
import { canOpenFeaturesSettings, shellPermissions } from '../shell-permissions';

/**
 * Settings frame (DA-250 to DA-252, lead decision L1): one "Settings" heading
 * and the category tabs as links between today's /app/admin/* addresses. The
 * tabs follow the same flags as the menu (shellPermissions → settingsTabsFor),
 * so a person sees only the categories they may open. Convenience only: every
 * page and every database command still decides access on its own.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  // Request-cached: the staff layout already ran both reads.
  const financeEntities = await financeEnabledEntityIds(staff);
  // N1: no Features tab for someone the page would refuse (see canOpenFeaturesSettings).
  const features = canOpenFeaturesSettings(staff.access);
  const tabs = settingsTabsFor(shellPermissions(staff, financeEntities)).filter((t) => t.category !== 'features' || features);
  return <SettingsFrame tabs={tabs}>{children}</SettingsFrame>;
}
