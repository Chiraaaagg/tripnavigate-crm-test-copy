import 'server-only';
import { cache } from 'react';
import type { StaffContext } from '@/modules/identity/server/session';
import { BitrixClientError, createBitrixClient, type BitrixClient } from '../bitrix/client';
import { BitrixConfigError, getIntegrationEnv, resolveBitrixRestTarget } from '../bitrix/config';
import { type BitrixPipeline, type BitrixUser, listBitrixUsers, listPipelines } from '../bitrix/directory';
import { dealListingStageIds, parseIntakeConfigRow, selectIntakeConfig, type IntakeConfig } from '../intake-config';

/**
 * Bitrix access for admin pages. The intake config is read under the staff
 * member's own session (RLS: integration.manage), so a caller without that
 * permission gets no client. The webhook URL never leaves the server and
 * errors are reported as fixed plain-language text.
 */

export type DirectoryError = string;

export async function readManagedConfig(staff: Pick<StaffContext, 'supabase'>): Promise<IntakeConfig | null> {
  return readManagedConfigOnce(staff.supabase);
}

/** Once per request and session client (speed plan C5): the sync page asks twice, in parallel. */
const readManagedConfigOnce = cache(async (supabase: StaffContext['supabase']): Promise<IntakeConfig | null> => {
  const { data, error } = await selectIntakeConfig((columns) =>
    supabase.from('integration_intake_config').select(columns).eq('source_system', 'bitrix'),
  );
  if (error || !data || data.length !== 1) return null;
  return parseIntakeConfigRow(data[0]);
});

export async function adminBitrixClient(
  staff: Pick<StaffContext, 'supabase'>,
): Promise<{ client: BitrixClient; config: IntakeConfig } | { error: DirectoryError }> {
  const config = await readManagedConfig(staff);
  if (!config) return { error: 'Bitrix intake is not configured, or you cannot manage it.' };
  try {
    const target = resolveBitrixRestTarget(getIntegrationEnv().bitrixWebhookBaseUrl, config.portalDomain, process.env.APP_ENV);
    return { client: createBitrixClient({ target }), config };
  } catch (error) {
    if (error instanceof BitrixConfigError && error.code === 'missing') {
      return { error: 'The Bitrix webhook is not configured on the server (BITRIX_WEBHOOK_BASE_URL).' };
    }
    return { error: 'The Bitrix webhook on the server does not match the configured portal.' };
  }
}

export function bitrixErrorText(error: unknown): DirectoryError {
  if (error instanceof BitrixClientError) {
    switch (error.code) {
      case 'provider_auth_failed':
        return 'Bitrix refused the webhook. For the user list it needs the "Users (user)" permission as well as CRM.';
      case 'provider_rate_limited':
        return 'Bitrix asked us to slow down. Try again in a minute.';
      case 'provider_timeout':
      case 'provider_unavailable':
        return 'Bitrix could not be reached. Try again in a minute.';
      default:
        return 'Bitrix sent an answer the CRM could not read.';
    }
  }
  return 'Bitrix could not be read.';
}

export interface BitrixDirectory {
  pipelines: BitrixPipeline[] | null;
  users: BitrixUser[] | null;
  error: DirectoryError | null;
}

export async function loadBitrixDirectory(
  staff: Pick<StaffContext, 'supabase'>,
  want: { pipelines?: boolean; users?: boolean },
): Promise<BitrixDirectory> {
  const got = await adminBitrixClient(staff);
  if ('error' in got) return { pipelines: null, users: null, error: got.error };
  const out: BitrixDirectory = { pipelines: null, users: null, error: null };
  // Pipelines and users are read at the same time (speed plan F1). The outcome
  // is the same as reading them one after the other: a pipelines failure
  // reports its error and shows no users (the users listing stops starting new
  // pages once the pipelines failed); a users failure keeps the pipelines.
  let pipelinesFailed = false;
  const [pipelines, users] = await Promise.allSettled([
    want.pipelines
      ? listPipelines(got.client).catch((error: unknown) => {
          pipelinesFailed = true;
          throw error;
        })
      : Promise.resolve(null),
    want.users ? listBitrixUsers(got.client, { stopped: () => pipelinesFailed }) : Promise.resolve(null),
  ]);
  if (pipelines.status === 'rejected') {
    out.error = bitrixErrorText(pipelines.reason);
    return out;
  }
  out.pipelines = pipelines.value;
  if (users.status === 'rejected') {
    out.error = bitrixErrorText(users.reason);
    return out;
  }
  out.users = users.value;
  return out;
}

/** One Bitrix user by id (name/email come from Bitrix, never from the form). */
export async function getBitrixUser(client: Pick<BitrixClient, 'call'>, id: string): Promise<BitrixUser | null> {
  if (!/^[1-9][0-9]{0,17}$/.test(id)) return null;
  const users = await listBitrixUsersById(client, id);
  return users[0] ?? null;
}

async function listBitrixUsersById(client: Pick<BitrixClient, 'call'>, id: string): Promise<BitrixUser[]> {
  const all = await listBitrixUsers({
    call: (method, params) => client.call(method, { ...(params ?? {}), FILTER: { ...((params?.FILTER as object) ?? {}), ID: id } }),
  } as Pick<BitrixClient, 'call'>);
  return all.filter((u) => u.id === id);
}

/**
 * Bitrix deals matching the CURRENT settings right now (ticked pipelines and
 * stages - the entry stages with Won-only intake on - created on/after the sync
 * date): one crm.deal.list call, IDs only, reading Bitrix's `total`. Null when
 * Bitrix cannot be read.
 */
export async function countBitrixEligible(staff: Pick<StaffContext, 'supabase'>): Promise<number | null> {
  const got = await adminBitrixClient(staff);
  if ('error' in got) return null;
  try {
    const page = await got.client.listDeals({
      filter: {
        '@CATEGORY_ID': got.config.categoryIds,
        '@STAGE_ID': dealListingStageIds(got.config),
        '>=DATE_CREATE': got.config.cutoffAt,
      },
      select: ['ID'],
      start: 0,
    });
    return page.total ?? page.items.length;
  } catch {
    return null;
  }
}
