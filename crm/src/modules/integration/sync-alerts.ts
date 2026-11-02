import 'server-only';
import { markSyncAlertSent, syncAlertCheck, type RpcClient, type SyncAlertItem } from './commands';

/**
 * "Sync stopped" email alerts (sync completion §4, §7).
 *
 * The database decides when an incident opens or recovers
 * (integration_sync_alert_check) and who receives it (active Super Admins).
 * This module only sends what the check returns, through the Resend HTTP API
 * (plain fetch, no SDK), and marks each email sent once Resend accepted it.
 * A failed send is not marked, so the next run retries it.
 *
 * Sending happens only when RESEND_API_KEY and SYNC_ALERT_FROM are both set.
 * The key and the recipient list are never logged or returned; log lines carry
 * fixed codes and an HTTP status only. Emails contain no customer data.
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const ADMIN_PAGE_PATH = '/app/admin/integration';
/** Resend accepts up to 50 recipients per email. */
const MAX_RECIPIENTS = 50;
const SEND_TIMEOUT_MS = 10_000;

export interface AlertEmailConfig {
  /** Secret: never log or return. */
  apiKey: string;
  from: string;
  /** Absolute admin page URL, or null when NEXT_PUBLIC_SITE_URL is missing or invalid. */
  adminUrl: string | null;
}

type Env = Record<string, string | undefined>;

/** Sender settings from the environment, or null when email alerts are not set up. */
export function alertEmailConfig(env: Env = process.env): AlertEmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.SYNC_ALERT_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from, adminUrl: adminPageUrl(env.NEXT_PUBLIC_SITE_URL) };
}

/** Presence only (for the admin page): true when both variables are set. */
export function isAlertEmailConfigured(env: Env = process.env): boolean {
  return alertEmailConfig(env) !== null;
}

function adminPageUrl(siteUrl: string | undefined): string | null {
  if (!siteUrl) return null;
  try {
    const url = new URL(siteUrl.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${ADMIN_PAGE_PATH}`;
  } catch {
    return null;
  }
}

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function istTime(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 'unknown time' : `${IST.format(new Date(ms))} IST`;
}

/** Plain subject and text (no HTML, no secrets, no customer data). */
export function buildAlertEmail(item: SyncAlertItem, adminUrl: string | null): { subject: string; text: string } {
  const link = adminUrl
    ? `Open the Bitrix sync page: ${adminUrl}`
    : 'Open the Bitrix sync page in the CRM (Admin, then Bitrix sync).';
  if (item.kind === 'stopped') {
    return {
      subject: 'TripNavigate CRM: Bitrix sync stopped',
      text: [
        `The automatic Bitrix sync stopped at about ${istTime(item.openedAt)}.`,
        'New and changed Deals and Leads are not reaching the CRM until it runs again.',
        '',
        link,
        '',
        'You get this email because you are a Super Admin. One more email follows when the sync works again.',
      ].join('\n'),
    };
  }
  return {
    subject: 'TripNavigate CRM: Bitrix sync working again',
    text: [
      `The automatic Bitrix sync is working again since about ${istTime(item.recoveredAt)}.`,
      `It had stopped at about ${istTime(item.openedAt)}. Changes made in Bitrix meanwhile are picked up by the sync.`,
      '',
      link,
    ].join('\n'),
  };
}

export type SendOutcome = { ok: true } | { ok: false; code: 'http_error' | 'network_error'; status: number | null };

/** One email through Resend. Never throws; never puts the key or recipients in its result. */
export async function sendAlertEmail(
  config: Pick<AlertEmailConfig, 'apiKey' | 'from'>,
  to: string[],
  email: { subject: string; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.from, to, subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Drain the body without reading it into a log.
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? { ok: true } : { ok: false, code: 'http_error', status: response.status };
  } catch {
    return { ok: false, code: 'network_error', status: null };
  }
}

export interface SyncAlertSummary {
  /** Emails the database still wanted sent. */
  pending: number;
  sent: number;
  failed: number;
  /** Skipped: email alerts not set up, or no recipients. */
  skipped: number;
  emailConfigured: boolean;
  /** The check itself failed (database unavailable or refused). */
  checkFailed: boolean;
}

export interface SyncAlertDeps {
  rpc: RpcClient;
  env?: Env;
  fetchImpl?: typeof fetch;
  /** Fixed-code log sink (default console.warn). */
  log?: (line: string) => void;
}

function logLine(log: (line: string) => void, code: string, extra: Record<string, unknown> = {}): void {
  log(JSON.stringify({ fn: 'sync-alert', code, ...extra }));
}

/**
 * Check, send, mark. Never throws: an alert problem must not change a worker
 * run's answer. Each incident/kind is marked only after Resend accepted it.
 */
export async function runSyncAlerts(deps: SyncAlertDeps): Promise<SyncAlertSummary> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const config = alertEmailConfig(deps.env ?? process.env);
  const summary: SyncAlertSummary = { pending: 0, sent: 0, failed: 0, skipped: 0, emailConfigured: config !== null, checkFailed: false };
  let check;
  try {
    check = await syncAlertCheck(deps.rpc);
  } catch {
    // Not logged (it would repeat every run while the database refuses); ?task=health reports it.
    summary.checkFailed = true;
    return summary;
  }
  summary.pending = check.send.length;
  for (const item of check.send) {
    const to = [...new Set(item.recipients)].slice(0, MAX_RECIPIENTS);
    // Not set up or nobody to tell: leave it unmarked so it is sent once that changes.
    if (!config || to.length === 0) {
      summary.skipped += 1;
      continue;
    }
    const result = await sendAlertEmail(config, to, buildAlertEmail(item, config.adminUrl), deps.fetchImpl);
    if (!result.ok) {
      summary.failed += 1;
      logLine(log, 'send_failed', { kind: item.kind, reason: result.code, status: result.status });
      continue;
    }
    try {
      await markSyncAlertSent(deps.rpc, item.incidentId, item.kind);
      summary.sent += 1;
    } catch {
      // Sent but not marked: the next run may send it again (at least once, never lost).
      summary.failed += 1;
      logLine(log, 'mark_failed', { kind: item.kind });
    }
  }
  return summary;
}
