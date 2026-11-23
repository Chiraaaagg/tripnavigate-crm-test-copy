import { POPUP_ASKED_KEY, POPUP_TITLE, type PopupDecision, type PopupPermission, shouldAskPermission } from './popup-policy';

/**
 * Browser adapter for desktop pop-ups (Accounts phase 2 contract 8.4). The
 * decisions are popup-policy.ts; this file only touches the Notification API
 * and localStorage, both feature-detected and wrapped in try/catch. Call
 * `showPopups` only from the sound leader tab (the provider passes the
 * leader flag to `decidePopup`). No service worker, no push subscription:
 * nothing is shown while the browser is closed. The Notification API is not
 * governed by the Content-Security-Policy, and the Permissions-Policy header
 * (crm/next.config.ts) names no `notifications` directive, so no header
 * changes.
 */

type NotificationCtor = {
  new (title: string, options?: { body?: string; tag?: string; silent?: boolean }): {
    onclick: ((this: unknown, ev: unknown) => unknown) | null;
    close(): void;
  };
  permission: string;
  requestPermission(): Promise<string>;
};

function api(): NotificationCtor | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  return (window as unknown as { Notification: NotificationCtor }).Notification;
}

/** Feature check: the Notification API exists in this browser. */
export function popupsSupported(): boolean {
  return api() !== null;
}

export function popupPermission(): PopupPermission {
  const N = api();
  if (!N) return 'unsupported';
  try {
    const p = N.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
  } catch {
    return 'unsupported';
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when this browser was already asked once (unreadable storage reads as not asked). */
export function popupAlreadyAsked(): boolean {
  try {
    return storage()?.getItem(POPUP_ASKED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberAsked(): void {
  try {
    storage()?.setItem(POPUP_ASKED_KEY, '1');
  } catch {
    // Private mode or blocked storage: the browser itself remembers a denial.
  }
}

/**
 * Asks the browser for permission. Call only from a pointerdown / keydown / click handler. Without `force` it asks
 * at most once per browser (and only when pop-ups are on); `force` is the bell's "Allow pop-ups" button. A denied
 * permission is never asked again.
 */
export async function askPopupPermission(force = false, popupsOn = true): Promise<PopupPermission> {
  const permission = popupPermission();
  const ask = shouldAskPermission({
    popupsOn,
    supported: permission !== 'unsupported',
    permission,
    alreadyAsked: popupAlreadyAsked(),
    force,
  });
  if (!ask) return permission;
  rememberAsked();
  try {
    const r = await api()!.requestPermission();
    return r === 'granted' || r === 'denied' ? r : 'default';
  } catch {
    return popupPermission();
  }
}

/**
 * Shows the decided pop-ups (silent: the sound path plays the tone). A click focuses the CRM tab, opens the
 * notice's page through `navigate` and closes the pop-up. Returns how many were shown.
 */
export function showPopups(decision: Extract<PopupDecision, { show: true }>, navigate: (href: string) => void): number {
  const N = api();
  if (!N) return 0;
  let shown = 0;
  for (const p of decision.popups) {
    try {
      const n = new N(POPUP_TITLE, { body: p.body, tag: p.tag, silent: true });
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          // Focus may be refused; the navigation still happens.
        }
        if (p.href) navigate(p.href);
        n.close();
      };
      shown += 1;
    } catch {
      // Some browsers (Android Chrome) allow only service-worker notifications: nothing is shown.
    }
  }
  return shown;
}
