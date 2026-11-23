import type { PushServerActions } from '@/modules/notices/push-client';
import type { DeviceAlertsApi, DeviceAlertsPreview } from './device-alerts-types';
import type { NoticeActionResult, NoticeHistoryDTO, NoticeInboxDTO, NoticeItemDTO, NoticeMarkAction, NoticeMarkAllResult, NoticeMarkResult, NoticePreferencesDTO } from '@/modules/notices/contracts';

/*
 * Bell wiring (contract 8.4, 9.4). The shapes are track C's DTOs
 * (`@/modules/notices/contracts`); the bell's server calls are passed in as
 * props (the layout passes track C's actions from `notices/server/actions.ts`,
 * the preview gallery passes stubs), so the bell never imports server code.
 */

export type NoticeItem = NoticeItemDTO;
export type NoticeInbox = NoticeInboxDTO;
export type NoticeHistory = NoticeHistoryDTO;

export interface NoticeApi {
  /**
   * Optional override (tests, previews). In the app it is omitted: the provider
   * reads GET /api/notices (`@/modules/notices/feed-client`), never a Server
   * Action, so the poll never queues with the page's own actions.
   * null = the full first page (load, reconnect, focus); a seq = only newer rows.
   */
  inbox?: (afterSeq: number | null) => Promise<NoticeActionResult<NoticeInboxDTO>>;
  /** Optional override; default GET /api/notices?view=history (read, done and resolved rows of 30 days). */
  history?: (beforeSeq: number | null) => Promise<NoticeActionResult<NoticeHistoryDTO>>;
  mark: (noticeId: string, action: NoticeMarkAction) => Promise<NoticeActionResult<NoticeMarkResult>>;
  markAllRead: () => Promise<NoticeActionResult<NoticeMarkAllResult>>;
  setSound: (soundOn: boolean) => Promise<NoticeActionResult<NoticePreferencesDTO>>;
  /**
   * Accounts phase 2 (contract 8.5): the personal pop-up switch (track D's
   * notice_preferences_set accepts { popupsOn }). Optional until that action
   * exists; without it the switch says "Could not save — try again".
   */
  setPopups?: (popupsOn: boolean) => Promise<NoticeActionResult<NoticePreferencesDTO & { popupsOn?: boolean }>>;
  /**
   * Accounts phase 3 (contract 8.3–8.5): "Alerts on this device". Optional
   * until track D's push actions and browser adapter exist; without it the
   * section shows the state line and an unavailable button.
   */
  deviceAlerts?: DeviceAlertsApi;
  /**
   * The layout's way in: track D's push server actions and the public VAPID key.
   * The provider builds the browser adapter (`createDeviceAlertsClient`) from
   * them in the browser; `deviceAlerts` (tests, previews) wins when both are set.
   */
  push?: { actions: PushServerActions; vapidPublicKey: string };
}

/** Realtime connection for this person's notice rows; null = polling only. */
export interface NoticeRealtime {
  supabaseUrl: string;
  supabasePublishableKey: string;
  userId: string;
  /** Optional override; default GET /api/realtime-token (feed-client fetchRealtimeToken), never a Server Action. */
  getToken?: () => Promise<string | null>;
}

export interface NoticesConfig {
  api: NoticeApi;
  realtime: NoticeRealtime | null;
  /** Preview gallery only: start from this inbox and never call the network. */
  preview?: {
    inbox: NoticeInboxDTO;
    history?: NoticeHistoryDTO;
    outOfDate?: boolean;
    open?: boolean;
    view?: 'inbox' | 'history' | 'settings';
    audioLocked?: boolean;
    /** Phase 2: the pop-up preference and this browser's permission to show. */
    popupsOn?: boolean;
    popupPermission?: 'default' | 'granted' | 'denied' | 'unsupported';
    /** Phase 3: the "Alerts on this device" starting state. */
    deviceAlerts?: DeviceAlertsPreview;
  };
}
