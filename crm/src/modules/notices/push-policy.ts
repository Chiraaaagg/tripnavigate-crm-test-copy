import type { PushState } from './contracts';

/**
 * Closed-browser alerts, pure rules (Accounts phase 3 contract 8.4, LD20).
 * No browser API here: push-client.ts reads the browser and passes the facts
 * in, so every rule is unit-tested.
 */

export interface PushFacts {
  /** serviceWorker, PushManager and Notification exist (and the page is a secure context). */
  supported: boolean;
  /** Notification.permission. */
  permission: 'default' | 'granted' | 'denied';
  /** An iPhone or iPad (iOS / iPadOS Safari). */
  iphone: boolean;
  /** Opened from the Home Screen (display-mode: standalone). */
  standalone: boolean;
  /** This browser has a push subscription. */
  subscribed: boolean;
}

/**
 * The state shown in "Alerts on this device":
 *   unsupported        the browser cannot receive alerts;
 *   needs_home_screen  iPhone / iPad Safari outside the Home Screen app (iOS 16.4+ allows push only there);
 *   blocked            the person or the browser denied notifications;
 *   on                 allowed and subscribed;
 *   off                anything else (the person has not turned alerts on here).
 */
export function pushPolicyState(f: PushFacts): PushState {
  if (!f.supported) return f.iphone && !f.standalone ? 'needs_home_screen' : 'unsupported';
  if (f.iphone && !f.standalone) return 'needs_home_screen';
  if (f.permission === 'denied') return 'blocked';
  if (f.permission === 'granted' && f.subscribed) return 'on';
  return 'off';
}

/** iPhone / iPad from the user agent (iPadOS 13+ says "Macintosh" with touch points). */
export function isIphoneLike(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/** The base64url VAPID public key as bytes (pushManager.subscribe applicationServerKey). Null when malformed. */
export function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> | null {
  const clean = base64url.trim();
  if (!/^[A-Za-z0-9_-]{40,200}={0,2}$/.test(clean)) return null;
  const padded = clean.replace(/=+$/, '') + '='.repeat((4 - (clean.replace(/=+$/, '').length % 4)) % 4);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  // An uncompressed P-256 public key: 65 bytes starting with 0x04.
  return out.length === 65 && out[0] === 4 ? out : null;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone|iPod/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** Words for the device list, e.g. "Chrome on Windows" (1..60 characters, never the raw user agent). */
export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? 'Browser';
  let system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1] ?? 'this computer';
  if (system === 'Mac' && maxTouchPoints > 1) system = 'iPad';
  return `${browser} on ${system}`;
}

/** True for a same-origin path the service worker may open (no scheme, no //host, no backslash). */
export function isSafeNoticePath(path: string): boolean {
  return /^\/(?![/\\])[^\s\\]*$/.test(path) && path.length <= 500;
}
