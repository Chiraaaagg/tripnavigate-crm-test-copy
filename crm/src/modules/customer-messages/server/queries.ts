import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { MessageCommandError, adminCustomerMessages, dealCustomerMessages, dealMessagePrefs, taskCustomerFiles, taskCustomerMessageStatus } from '../commands';
import { LANGUAGES, MESSAGE_TYPES, PROVIDER_KEYS } from '../contracts';
import {
  AdminCustomerMessagesSchema,
  type AdminCustomerMessages,
  type DealCustomerMessages,
  type DealMessagePrefs,
  type TaskCustomerFiles,
  type TaskCustomerMessageStatus,
} from '../dto';
import { CUSTOMER_MESSAGE_TEMPLATES, PREVIEW_PARAMS, previewWhatsApp, renderEmail } from '../templates';

/**
 * Customer message reads for server components (contract 5.6 R-A3, 5.10),
 * under the staff member's own session. A refusal or a database without the
 * functions maps to null (the card is hidden); anything else throws a plain
 * retry message.
 */

type Staff = Pick<StaffContext, 'supabase'>;

function quiet(error: unknown): boolean {
  return error instanceof MessageCommandError && (error.code === 'not_authorized' || error.code === 'session' || error.sqlState === 'PGRST202');
}

export async function loadDealCustomerMessages(staff: Staff, dealId: string): Promise<DealCustomerMessages | null> {
  try {
    return await dealCustomerMessages(asRpcClient(staff.supabase), dealId);
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load the messages to the customer. Please retry.');
  }
}

export async function loadTaskCustomerMessageStatus(staff: Staff, taskId: string): Promise<TaskCustomerMessageStatus | null> {
  try {
    return await taskCustomerMessageStatus(asRpcClient(staff.supabase), taskId);
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load the send state. Please retry.');
  }
}

/** Provider settings saved in the environment: names only, a boolean each (never a value). */
export function providerConfigured(env: Record<string, string | undefined> = process.env): Array<{ key: (typeof PROVIDER_KEYS)[number]; configured: boolean }> {
  return PROVIDER_KEYS.map((key) => ({ key, configured: typeof env[key] === 'string' && env[key]!.length > 0 }));
}

/** Template previews in both languages with synthetic values. */
export function templatePreviews(): AdminCustomerMessages['previews'] {
  return MESSAGE_TYPES.flatMap((type) => LANGUAGES.map((language) => {
    const tpl = CUSTOMER_MESSAGE_TEMPLATES[type][language];
    return {
      type,
      language,
      templateCode: tpl.code,
      subject: renderEmail(type, language, PREVIEW_PARAMS).subject,
      whatsappText: previewWhatsApp(type, language),
      header: tpl.header,
    };
  }));
}

/** R-A2: Super Admin only (null otherwise). */
export async function loadAdminCustomerMessages(staff: Staff, entityId: string): Promise<AdminCustomerMessages | null> {
  try {
    const db = await adminCustomerMessages(asRpcClient(staff.supabase), entityId);
    if (!db) return null;
    return AdminCustomerMessagesSchema.parse({ ...db, providers: providerConfigured(), previews: templatePreviews() });
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load the customer message settings. Please retry.');
  }
}

/** Book now / Deal: the language and WhatsApp choice with its row version (null = not allowed). */
export async function loadDealMessagePrefs(staff: Staff, dealId: string): Promise<DealMessagePrefs | null> {
  try {
    return await dealMessagePrefs(asRpcClient(staff.supabase), dealId);
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load the message settings. Please retry.');
  }
}

/** Purchase task > Customer voucher, Flight task > Boarding pass (null = not this task's department reader). */
export async function loadTaskCustomerFiles(staff: Staff, taskId: string): Promise<TaskCustomerFiles | null> {
  try {
    return await taskCustomerFiles(asRpcClient(staff.supabase), taskId);
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load the customer files. Please retry.');
  }
}
