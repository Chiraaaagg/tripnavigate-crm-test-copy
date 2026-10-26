import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getAppConfig } from '@/lib/config';
import { authCookieOptions } from './cookie-options';

/**
 * Supabase client bound to the signed-in staff member's session cookies. Every
 * Data API call made with it is subject to RLS as that user (including the
 * aal2 requirement). Use this for all ordinary reads and commands.
 */
export async function createSupabaseServerClient() {
  const config = getAppConfig();
  const cookieStore = await cookies();
  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookieOptions: authCookieOptions(config.siteUrl),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies; the proxy refreshes sessions.
        }
      },
    },
  });
}
