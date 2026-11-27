import type { Metadata } from 'next';
import { administeredEntityIds, holdsPurchaseAnywhere } from '@/modules/access/policy';
import { requireStaff } from '@/modules/identity/server/session';
import { LiveDealsRefresh } from '@/components/LiveDealsRefresh';
import { getAppConfig } from '@/lib/config';
import { countVisibleOutsideStages } from '@/modules/deals/server/queries';
import { loadIdProofCopyAlerts } from '@/modules/fulfilment/server/id-proofs';
import { retryIdProofCopyAction } from '@/modules/fulfilment/server/id-proof-actions';
import { countBitrixEligible, loadBitrixDirectory } from '@/modules/integration/server/bitrix-admin';
import { loadIntakeEntryRule, loadIntakeScope, loadIntegrationStatus } from '@/modules/integration/server/queries';
import { loadBitrixNameReadState } from '@/modules/integration/server/name-map';
import { setBitrixNameReadAction } from '@/modules/integration/server/name-map-actions';
import { setBitrixTripDetailsReadAction } from '@/modules/integration/server/trip-details-actions';
import { loadBitrixTripDetailsReadState } from '@/modules/integration/server/trip-details-state';
import { pruneDryRunAction, pruneRunAction, setDealEntryStagesAction } from '@/modules/integration/server/won-only-actions';
import { isAlertEmailConfigured } from '@/modules/integration/sync-alerts';
import { fileMoveAlertsModel, fileMoveSectionModel } from '@/modules/settings/file-move-rows';
import { applySyncScopeAction, changeSettingSwitchAction, previewSyncScopeAction } from '@/modules/settings/server/actions';
import { bitrixPageModel, loadSettingsStates } from '@/modules/settings/server/queries';
import { WonOnlyCard } from '@/views/b11/won-only-card';
import { BitrixNamesCard, BitrixTripDetailsCard } from '@/views/bitrix-names-card';
import { IntegrationAdminView, IntegrationNoPermissionView, parseBitrixTab } from '@/views/integration-views';
import { IdProofCopyAlertsCard } from '@/views/workflow-views';
import { FileMoveAlertsCard, FileMoveSettingsSection } from '@/views/files/file-move-settings';
import { DestinationClassesCard } from '@/views/settings/destination-classes';
import type { B11Action } from '@/views/b11/shapes';
import { setDestinationScopeAction } from './destination-actions';
import { loadDestinationClasses } from './destination-load';

/** Request-time clock for the stale check only (the staff layout is force-dynamic, so nothing is cached). */
function requestTime(): number {
  return Date.now();
}

export const metadata: Metadata = { title: 'Bitrix connection' };

/**
 * Settings · Bitrix connection (AD-03; address unchanged, L1). UX redesign R1:
 * four sub-tabs on the same address (?tab=, parseBitrixTab; the old address
 * opens Status). Status: what needs fixing, the connection, Check Bitrix now.
 * Which deals come in: preview then apply with a reason (M1, enforced in the
 * database; there is no one-step save), the Lead import list and the Won-only
 * rule (moved from Features, lead ruling D3). Switches: the Bitrix switches
 * (one change flow, DA-256), Bitrix names, trip details and destinations.
 * Clean-up: ID-proof copies, open sync work, rows that need a person.
 * S11 "files to Bitrix" (Super Admin only; nothing for anyone else): its
 * switches, hold, Accounts box and pilot deal on Switches, its alerts on Clean-up.
 * Purchase holders get nothing here (review M2; same rule as authz.can_read_lead).
 * The reads are the same on every tab, so each tab shows the same facts as before.
 */
export default async function IntegrationAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const tab = parseBitrixTab((await searchParams).tab);
  const staff = await requireStaff();
  if (administeredEntityIds(staff.access, 'integration.manage').length === 0 || holdsPurchaseAnywhere(staff.access)) {
    return <IntegrationNoPermissionView />;
  }
  // The import-scope read refuses unless the caller administers integration.manage (contract §3).
  // A refused or failed read shows "could not be read", never a healthy or empty list.
  const [status, scope, directory, bitrixNow, nameRead, tripDetailsRead, states, copyAlerts, fileMove] = await Promise.all([
    loadIntegrationStatus(staff),
    loadIntakeScope(staff).catch(() => null),
    loadBitrixDirectory(staff, { pipelines: true, users: true }),
    countBitrixEligible(staff),
    // DEC-55: a failed read is Unknown, never Off.
    loadBitrixNameReadState(staff).catch(() => ({ state: 'unknown' as const, reason: 'failed' as const })),
    // Voice-note batch: same rule for the trip-details switch.
    loadBitrixTripDetailsReadState(staff),
    loadSettingsStates(staff),
    // DEC-43 Super Admin alerts (null for everyone else: no card; a failed read says so).
    loadIdProofCopyAlerts(staff).catch(() => 'error' as const),
    // S11: null from the database (not the Super Admin) shows nothing; never throws.
    loadFileMoveAdmin(staff, { superAdminSomewhere: staff.access.memberships.some((m) => m.roleCode === 'super_admin') }),
  ]);
  // Voice-note batch: trip type of each Bitrix destination (Super Admin edits; a failed read says so).
  const destinations = await loadDestinationClasses(staff);
  // B1.1d: with Won-only intake on, Deals outside the entry stages are the kept ones.
  const keptOutsideStages = await countVisibleOutsideStages(staff, status.dealEntryStageIds ?? status.stageIds ?? []).catch(() => 0);
  // The Won-only card: a failed read shows "unknown", never "off".
  const rule = await loadIntakeEntryRule(staff, directory.pipelines).catch(() => null);
  const stageOptions = (directory.pipelines ?? []).flatMap((p) => p.stages.map((s) => ({ id: s.id, label: s.name, pipelineName: p.name })));
  const openStops = copyAlerts && copyAlerts !== 'error' ? copyAlerts.stops.filter((s) => s.open).length : undefined;
  const page = bitrixPageModel(states, { openStops });
  const config = getAppConfig();
  return (
    <>
      {/* Available deals and the sync status refresh live after each sync. */}
      <LiveDealsRefresh supabaseUrl={config.supabaseUrl} supabasePublishableKey={config.supabasePublishableKey} />
      <IntegrationAdminView
        status={{ ...status, bitrixNow, keptOutsideStages }}
        scope={scope}
        now={requestTime()}
        pipelines={directory.pipelines}
        bitrixUsers={directory.users}
        directoryError={directory.error}
        emailAlertsConfigured={isAlertEmailConfigured()}
        switches={page.switches}
        switchActions={{ change: changeSettingSwitchAction }}
        sync={{ model: page.sync, text: page.syncText, preview: previewSyncScopeAction, apply: applySyncScopeAction }}
        tab={tab}
        slots={{
          switches: (
            <>
              {/* S11: right after the Bitrix switches (the DEC-43 copy row), so the file switches sit together. */}
              <FileMoveSettingsSection
                model={fileMoveSectionModel(fileMove)}
                actions={{ setSwitch: setFileMoveSwitchAction, setHold: setFileMoveHoldAction, setAccountsBox: setFileMoveAccountsBoxAction, setPilot: setFileMovePilotAction }}
              />
              <BitrixNamesCard state={nameRead} action={setBitrixNameReadAction} />
              <BitrixTripDetailsCard state={tripDetailsRead} action={setBitrixTripDetailsReadAction} />
              <DestinationClassesCard rows={destinations.rows} canEdit={destinations.canEdit} action={setDestinationScopeAction as unknown as B11Action} />
            </>
          ),
          deals: <WonOnlyCard rule={rule} stageOptions={stageOptions} setAction={setDealEntryStagesAction} dryRunAction={pruneDryRunAction} runAction={pruneRunAction} />,
          cleanup: (
            <>
              {copyAlerts !== null ? <IdProofCopyAlertsCard alerts={copyAlerts} retryAction={retryIdProofCopyAction} /> : null}
              <FileMoveAlertsCard
                model={fileMoveAlertsModel(fileMove)}
                actions={{ acknowledge: acknowledgeFileMoveStopAction, retry: retryFileMoveAction, relocate: relocateFileMoveAction, acceptLost: acceptFileMoveLostAction }}
              />
            </>
          ),
        }}
      />
    </>
  );
}
