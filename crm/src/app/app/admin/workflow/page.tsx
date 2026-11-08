import type { Metadata } from 'next';
import { administeredEntityIds, holdsPurchaseAnywhere } from '@/modules/access/policy';
import { requireStaff } from '@/modules/identity/server/session';
import { SETTINGS_PATH } from '@/modules/settings/contracts';
import { changeSettingSwitchAction, previewVisaTasksAction } from '@/modules/settings/server/actions';
import { featuresPageModel, loadSettingsStates } from '@/modules/settings/server/queries';
import { FeaturesSettingsView, WorkflowNoPermissionView } from '@/views/workflow-views';
import { canOpenFeaturesSettings } from '../../shell-permissions';

export const metadata: Metadata = { title: 'Features' };

/**
 * Settings · Features (AD-05, R6, M5): the five workflow switches and the
 * read-only real booking and supplier confirmation rows, from one read of
 * settings_switch_states(). Unknown is never Off and has no form; every
 * change is choose → reason → review → confirm, checked again by the
 * database. The Bitrix switches, ID-proof copies and the Won-only rule are on
 * Bitrix connection (lead ruling D3). Address unchanged (L1).
 */
export default async function FeaturesRoute() {
  const staff = await requireStaff();
  // integration.manage, and no Purchase role anywhere unless a Super Admin (N1): the same
  // people settings_switch_states() gives the workflow section to. The database still decides.
  if (!canOpenFeaturesSettings(staff.access)) {
    // N1: an integration manager refused only because they also work in Purchase gets the Purchase reason.
    const purchaseOnly = holdsPurchaseAnywhere(staff.access) && administeredEntityIds(staff.access, 'integration.manage').length > 0;
    return <WorkflowNoPermissionView reason={purchaseOnly ? 'purchase' : 'role'} />;
  }
  const model = featuresPageModel(await loadSettingsStates(staff));
  const bitrixHref = holdsPurchaseAnywhere(staff.access) ? null : SETTINGS_PATH.bitrix;
  return <FeaturesSettingsView model={model} actions={{ change: changeSettingSwitchAction, previewVisa: previewVisaTasksAction }} bitrixHref={bitrixHref} />;
}
