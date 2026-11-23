import {
  PUSH_ERROR_TEXT,
  PUSH_OK_TEXT,
  PUSH_SIGNOUT_FIELD,
  type PushDevicesListDTO,
  type PushState,
} from './contracts';
import { deviceLabel, isIphoneLike, pushPolicyState, vapidKeyBytes } from './push-policy';

/**
 * Browser adapter for "Alerts on this device" (Accounts phase 3 contract 8.4,
 * screen 15.8). No server code here: the server actions are passed in by the
 * layout (`server/push-actions.ts`), so the bell bundle never imports them
 * directly and the preview gallery can pass stubs.
 *
 * Opt-in only: nothing is registered, and the browser is never asked, until
 * the person presses "Turn on alerts on this device". Only then is
 * `/sw.js` registered and `pushManager.subscribe({userVisibleOnly: true})`
 * called. `detect()` and `list()` only look.
 *
 * The returned object has exactly the shape of the bell's DeviceAlertsApi
 * (S/views/notices/device-alerts-types.ts).
 */

export type PushResult<T = undefined> = { ok: true; data: T; message?: string } | { ok: false; code: string; message: string };

/** The server actions of server/push-actions.ts (same signatures). */
export interface PushServerActions {
  list(endpoint: string | null): Promise<PushResult<PushDevicesListDTO>>;
  register(input: { endpoint: string; p256dh: string; authKey: string; label: string }): Promise<PushResult<unknown>>;
  remove(deviceId: string): Promise<PushResult<unknown>>;
  removeCurrent(endpoint: string): Promise<PushResult<unknown>>;
  test(deviceId: string): Promise<PushResult<unknown>>;
}

export interface DeviceAlertsClient {
  detect(): Promise<PushState>;
  list(): Promise<PushResult<PushDevicesListDTO>>;
  turnOn(): Promise<PushResult<PushState>>;
  turnOff(): Promise<PushResult<PushState>>;
  remove(deviceId: string): Promise<PushResult>;
  test(deviceId: string): Promise<PushResult>;
}

const SW_URL = '/sw.js';

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function iphone(): boolean {
  return typeof navigator !== 'undefined' && isIphoneLike(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

function standalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

/** The existing registration and subscription, without registering anything. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration ? await registration.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

/** This browser's state; never asks the browser for permission. */
export async function detectPushState(): Promise<PushState> {
  const supported = pushSupported();
  const permission = supported ? (Notification.permission as 'default' | 'granted' | 'denied') : 'default';
  const subscribed = supported ? (await currentSubscription()) !== null : false;
  return pushPolicyState({ supported, permission, iphone: iphone(), standalone: standalone(), subscribed });
}

/** This browser's endpoint for the sign-out form field, or null. */
export async function pushEndpointForSignOut(): Promise<string | null> {
  return (await currentSubscription())?.endpoint ?? null;
}

/**
 * Fills (or adds) the hidden `pushEndpoint` field of a sign-out form so the
 * sign-out action removes this browser's device. Call before submitting.
 */
export async function fillPushSignOutField(form: HTMLFormElement): Promise<void> {
  const endpoint = await pushEndpointForSignOut();
  let input = form.querySelector<HTMLInputElement>(`input[name="${PUSH_SIGNOUT_FIELD}"]`);
  if (!input) {
    input = document.createElement('input');
    input.type = 'hidden';
    input.name = PUSH_SIGNOUT_FIELD;
    form.appendChild(input);
  }
  input.value = endpoint ?? '';
}

function fail(code: keyof typeof PUSH_ERROR_TEXT): { ok: false; code: string; message: string } {
  return { ok: false, code, message: PUSH_ERROR_TEXT[code] };
}

/**
 * The bell's "Alerts on this device" API. `vapidPublicKey` =
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY (public by design); missing = not configured.
 */
export function createDeviceAlertsClient(actions: PushServerActions, vapidPublicKey: string | undefined): DeviceAlertsClient {
  return {
    detect: detectPushState,

    async list() {
      const sub = await currentSubscription();
      return actions.list(sub?.endpoint ?? null);
    },

    async turnOn() {
      // iPhone / iPad: only the Home Screen app may receive alerts (the state line says how).
      if (!pushSupported() || (iphone() && !standalone())) return fail('unsupported');
      const key = vapidKeyBytes(vapidPublicKey ?? '');
      if (!key) return fail('not_configured');
      let registration: ServiceWorkerRegistration;
      try {
        await navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });
        registration = await navigator.serviceWorker.ready;
      } catch {
        return fail('failed');
      }
      let permission: NotificationPermission;
      try {
        permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      } catch {
        return fail('blocked');
      }
      if (permission !== 'granted') return fail('blocked');
      let sub = await registration.pushManager.getSubscription();
      const created = sub === null;
      try {
        sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        return fail('failed');
      }
      const json = sub.toJSON();
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!json.endpoint || !p256dh || !auth) return fail('failed');
      const result = await actions.register({
        endpoint: json.endpoint,
        p256dh,
        authKey: auth,
        label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0),
      });
      if (!result.ok) {
        // Refused (switch off, 10 devices): leave this browser as it was.
        if (created) await sub.unsubscribe().catch(() => false);
        return result;
      }
      return { ok: true, data: 'on', message: result.message ?? PUSH_OK_TEXT.turnedOn };
    },

    async turnOff() {
      const sub = await currentSubscription();
      if (!sub) return { ok: true, data: await detectPushState(), message: PUSH_OK_TEXT.turnedOff };
      const result = await actions.removeCurrent(sub.endpoint);
      if (!result.ok) return result;
      await sub.unsubscribe().catch(() => false);
      return { ok: true, data: await detectPushState(), message: result.message ?? PUSH_OK_TEXT.turnedOff };
    },

    async remove(deviceId) {
      const result = await actions.remove(deviceId);
      if (!result.ok) return result;
      // UI review finding 5: removing THIS browser's device also ends its browser subscription, so the
      // state flips to Off (a subscription with no device row would otherwise still read as "on").
      const sub = await currentSubscription();
      if (sub) {
        const after = await actions.list(sub.endpoint).catch(() => null);
        const stillMine = after?.ok ? after.data.devices.some((d) => d.thisDevice) : true;
        if (!stillMine) await sub.unsubscribe().catch(() => false);
      }
      return { ok: true, data: undefined, message: result.message };
    },

    async test(deviceId) {
      const result = await actions.test(deviceId);
      return result.ok ? { ok: true, data: undefined, message: result.message } : result;
    },
  };
}
