import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getAppConfig } from '@/lib/config';

/**
 * PRIVILEGED client using the Supabase secret (service-role) key. It bypasses
 * RLS. Rules:
 *   - Import only from src/modules/<module>/server/** (enforced by ESLint).
 *   - Call only AFTER the acting staff member's permission has been checked by a
 *     database command running under their own session.
 *   - Never pass its results to the browser without an explicit DTO.
 */
export function createSupabaseAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error('The privileged Supabase client cannot run in the browser.');
  }
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) {
    throw new Error('SUPABASE_SECRET_KEY is not configured.');
  }
  const config = getAppConfig();
  return createClient(config.supabaseUrl, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
