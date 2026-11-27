import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getIntegrationEnv, resolveBitrixRestTarget } from '../bitrix/config';
import { createBitrixFileReader, type BitrixFileReader } from '../bitrix/file-store';
import { selectActiveConfig, selectIntakeConfig } from '../intake-config';

/**
 * S11 view path: a read-only Bitrix file store for serving a file whose only
 * copy is in Bitrix. Uses the READ webhook (BITRIX_WEBHOOK_BASE_URL) on the
 * active intake configuration's portal. It can read a box and download an
 * entry; it cannot write.
 *
 * Call it only after file_view_begin allowed the view under the person's own
 * session (the privileged client reads the intake configuration here).
 *
 * One attempt per request (no rate-limit retry). `timeoutMs` applies to each
 * Bitrix request separately (the box read and the download); the default
 * keeps the two together within the 15 seconds the contract allows a view.
 */

export const VIEW_REQUEST_TIMEOUT_MS = 7_500;

/** null = not configured (no active intake configuration, or no valid read webhook). */
export async function openBitrixFileReader(options?: { timeoutMs?: number }): Promise<BitrixFileReader | null> {
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await selectIntakeConfig((columns) => admin.from('integration_intake_config').select(columns).eq('source_system', 'bitrix'));
    if (error) return null;
    const active = selectActiveConfig(data ?? []);
    if (!active.config) return null;
    const target = resolveBitrixRestTarget(getIntegrationEnv().bitrixWebhookBaseUrl, active.config.portalDomain, process.env.APP_ENV);
    const timeoutMs = options?.timeoutMs ?? VIEW_REQUEST_TIMEOUT_MS;
    return createBitrixFileReader({ target, readTimeoutMs: timeoutMs, downloadTimeoutMs: timeoutMs, maxRateLimitRetries: 0 });
  } catch {
    // Missing secret key, invalid webhook, unreachable database: not configured.
    return null;
  }
}
