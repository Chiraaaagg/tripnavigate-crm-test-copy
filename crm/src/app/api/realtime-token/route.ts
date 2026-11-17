import { realtimeToken } from '@/modules/notices/server/realtime-token';

/**
 * Short-lived Realtime access token for the signed-in staff member (bell
 * connect / re-auth); see src/modules/notices/server/realtime-token.ts.
 * Never cached, never logged.
 */
export async function GET(): Promise<Response> {
  return realtimeToken();
}
