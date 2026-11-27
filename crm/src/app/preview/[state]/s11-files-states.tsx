import type { ReactNode } from 'react';
import {
  fileMoveAlertsModel,
  fileMoveSectionModel,
  type FileMoveAlerts,
  type FileMoveLoad,
  type FileMoveSettings,
} from '@/modules/settings/file-move-rows';
import { FILE_MOVE_TEXT } from '@/modules/settings/text';
import { FileMoveAlertsCard, FileMoveSettingsSection, type FileMovePreview } from '@/views/files/file-move-settings';
import { SettingsSectionHeading } from '@/views/settings/settings-frame';
import {
  previewFileMoveAckAction,
  previewFileMoveBoxAction,
  previewFileMoveHoldAction,
  previewFileMoveLostAction,
  previewFileMovePilotAction,
  previewFileMoveRelocateAction,
  previewFileMoveRetryAction,
  previewFileMoveSwitchAction,
} from './s11-files-preview-actions';
import { inSettings, settingsOwner } from './settings-preview-frame';

/*
 * S11 "files to Bitrix" preview states (s11-files-*): Settings › Bitrix
 * connection, the "Files kept in Bitrix" section (Switches tab) and its
 * alerts (Clean-up tab), as the Super Admin sees them. Synthetic props and
 * stand-in actions only; rendered by the design-review gallery, a 404
 * outside local preview mode. Deal numbers and ids are made up.
 */

const BITRIX = '/app/admin/integration';
const REASON = 'Owner APPROVE 27 Nov 2026, step 3 part 1 (synthetic)';

const settings = (over: Partial<FileMoveSettings> = {}): FileMoveSettings => ({
  checkIdProofCopies: false,
  moveAccountsFiles: false,
  deleteAfterHold: false,
  deleteHoldMinutes: 15,
  accountsHoldDays: 90,
  accountsBox: null,
  pilotBitrixDealId: null,
  deleteEverOn: false,
  enqueueEnabled: true,
  openStops: 0,
  updatedAt: null,
  ...over,
});

const NO_ALERTS: FileMoveAlerts = { stops: [], items: [], counts: { noTarget: 0, missedEnqueue: 0, waitingAccounts: 0, soleCopies: 0, orphaned: 0 } };

const MOVE_LOST = 'a0011001-0000-4000-8000-000000011001';
const ALERTS: FileMoveAlerts = {
  stops: [
    { stopId: 'a0011101-0000-4000-8000-000000011101', moveId: MOVE_LOST, bitrixDealId: '90001', reasonCode: 'missing_in_bitrix', openedAt: '2026-11-27T05:10:00Z', acknowledgedAt: null },
    { stopId: 'a0011102-0000-4000-8000-000000011102', moveId: null, bitrixDealId: '90002', reasonCode: 'copy_mismatch', openedAt: '2026-11-25T08:00:00Z', acknowledgedAt: '2026-11-25T09:30:00Z' },
  ],
  items: [
    { moveId: MOVE_LOST, kind: 'lost_in_bitrix', fileClass: 'id_proof', sourceTable: 'traveller_id_proofs', state: 'lost_in_bitrix', lastErrorCode: 'not_in_box', bitrixDealId: '90001', updatedAt: '2026-11-27T05:12:00Z' },
    { moveId: 'a0011002-0000-4000-8000-000000011002', kind: 'blocked_by_lost_file', fileClass: 'id_proof', sourceTable: 'department_evidence', state: 'copy_pending', lastErrorCode: null, bitrixDealId: '90001', updatedAt: '2026-11-27T05:20:00Z' },
    { moveId: 'a0011003-0000-4000-8000-000000011003', kind: 'needs_manual_check', fileClass: 'accounts', sourceTable: 'supplier_money_evidence', state: 'needs_manual_check', lastErrorCode: 'bitrix_unavailable', bitrixDealId: '90003', updatedAt: '2026-11-26T11:00:00Z' },
    { moveId: 'a0011004-0000-4000-8000-000000011004', kind: 'deletion_waiting', fileClass: 'id_proof', sourceTable: 'traveller_id_proofs', state: 'verified', lastErrorCode: null, bitrixDealId: '90004', updatedAt: '2026-11-27T06:00:00Z' },
  ],
  counts: { noTarget: 4, missedEnqueue: 1, waitingAccounts: 12, soleCopies: 7, orphaned: 0 },
};

const settingsActions = {
  setSwitch: previewFileMoveSwitchAction,
  setHold: previewFileMoveHoldAction,
  setAccountsBox: previewFileMoveBoxAction,
  setPilot: previewFileMovePilotAction,
};
const alertActions = {
  acknowledge: previewFileMoveAckAction,
  retry: previewFileMoveRetryAction,
  relocate: previewFileMoveRelocateAction,
  acceptLost: previewFileMoveLostAction,
};

function switchesTab(load: FileMoveLoad, preview?: FileMovePreview): ReactNode {
  return inSettings(
    settingsOwner,
    BITRIX,
    <>
      <SettingsSectionHeading description="Preview: the Switches tab, “Files kept in Bitrix” only.">Bitrix connection</SettingsSectionHeading>
      <FileMoveSettingsSection model={fileMoveSectionModel(load)} actions={settingsActions} preview={preview} />
    </>,
  );
}

function cleanupTab(load: FileMoveLoad, preview?: FileMovePreview): ReactNode {
  return inSettings(
    settingsOwner,
    BITRIX,
    <>
      <SettingsSectionHeading description="Preview: the Clean-up tab, the file alerts only.">Bitrix connection</SettingsSectionHeading>
      <FileMoveAlertsCard model={fileMoveAlertsModel(load)} actions={alertActions} preview={preview} />
    </>,
  );
}

const ready = (s: Partial<FileMoveSettings> = {}, alerts: FileMoveAlerts | 'error' = NO_ALERTS): FileMoveLoad => ({ kind: 'ready', settings: settings(s), alerts });

const PILOT_ON = { checkIdProofCopies: true, deleteAfterHold: true, deleteEverOn: true, pilotBitrixDealId: '90001', updatedAt: '2026-11-27T04:30:00Z' };

const states: Record<string, () => ReactNode> = {
  // Installed, everything off (step 2).
  's11-files-installed-off': () => switchesTab(ready()),
  // Copy and check on, deleting on for one pilot deal (rehearsal).
  's11-files-pilot': () => switchesTab(ready(PILOT_ON)),
  // Company-wide: pilot cleared, Accounts box set, Accounts moving on, a longer hold.
  's11-files-company-wide': () =>
    switchesTab(ready({ ...PILOT_ON, pilotBitrixDealId: null, moveAccountsFiles: true, accountsBox: 'ufCrm_1790000000', deleteHoldMinutes: 30 })),
  // An open stop blocks deleting; the listing was stopped by the CRM team.
  's11-files-open-stop': () => switchesTab(ready({ ...PILOT_ON, deleteAfterHold: false, openStops: 1, enqueueEnabled: false })),
  's11-files-not-installed': () => switchesTab({ kind: 'not_installed' }),
  's11-files-read-failed': () => switchesTab({ kind: 'error' }),
  // Review steps (dialogs open).
  's11-files-review-check-on': () => switchesTab(ready(), { control: 'check_id_proof_copies', open: true, reason: REASON }),
  's11-files-review-delete-on': () =>
    switchesTab(ready({ checkIdProofCopies: true, pilotBitrixDealId: '90001' }), { control: 'delete_after_hold', open: true, reason: REASON }),
  's11-files-review-clear-pilot': () => switchesTab(ready(PILOT_ON), { control: 'pilot_clear', open: true, reason: REASON }),
  's11-files-review-hold': () => switchesTab(ready(PILOT_ON), { control: 'hold', open: true, reason: REASON }),
  // Turning deleting off: the dialog offers the ready-made emergency reason (one click fills the box).
  's11-files-review-delete-off': () => switchesTab(ready(PILOT_ON), { control: 'delete_after_hold', open: true }),
  // Refusals keep the dialog open with the typed reason and value.
  's11-files-refused-box': () =>
    switchesTab(ready(PILOT_ON), {
      control: 'accounts_box',
      open: true,
      reason: REASON,
      result: { ok: false, message: FILE_MOVE_TEXT.boxSameAsId, fields: ['itemKey'] },
    }),
  's11-files-refused-pilot-required': () =>
    switchesTab(ready({ checkIdProofCopies: true, pilotBitrixDealId: '90001' }), {
      control: 'delete_after_hold',
      open: true,
      reason: REASON,
      result: { ok: false, message: FILE_MOVE_TEXT.refusedPilotRequired },
    }),
  // Clean-up tab.
  's11-files-alerts': () => cleanupTab(ready(PILOT_ON, ALERTS)),
  's11-files-alerts-empty': () => cleanupTab(ready(PILOT_ON, NO_ALERTS)),
  's11-files-alerts-read-failed': () => cleanupTab(ready(PILOT_ON, 'error')),
  's11-files-alerts-review-lost': () => cleanupTab(ready(PILOT_ON, ALERTS), { control: `lost:${MOVE_LOST}`, open: true, reason: REASON }),
  's11-files-alerts-review-ack': () => cleanupTab(ready(PILOT_ON, ALERTS), { control: 'ack:a0011101-0000-4000-8000-000000011101', open: true }),
  's11-files-alerts-review-relocate': () => cleanupTab(ready(PILOT_ON, ALERTS), { control: `relocate:${MOVE_LOST}`, open: true }),
};

export const S11_FILES_STATES = Object.keys(states);

export function renderS11FilesState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
