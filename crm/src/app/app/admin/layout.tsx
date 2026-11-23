import type { ReactNode } from 'react';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { SettingsFrame } from '@/views/settings/settings-frame';
import { settingsAreasFor } from '../shell-permissions';

/**
 * Settings frame (DA-250 to DA-252, lead decision L1; R1 area list): the
 * area list as links between today's /app/admin/* addresses. The
 * areas follow the same flags as the menu (settingsAreasFor: shellPermissions
 * → settingsTabsFor, Features per N1, Customer messages for a Super Admin), so
 * a person sees only the areas they may open. Convenience only: every
 * page and every database command still decides access on its own.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  // Request-cached: the staff layout already ran both reads.
  const financeEntities = await financeEnabledEntityIds(staff);
  const tabs = settingsAreasFor(staff, financeEntities);
  return <SettingsFrame tabs={tabs}>{children}</SettingsFrame>;
}
