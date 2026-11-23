import { handlePushRequest, productionPushRouteDeps } from '@/modules/notices/server/push-route';

/**
 * Closed-browser alerts kick (Accounts phase 3 contract 8.4, LD20). The
 * database (authz.push_kick, at most once per 5 seconds) posts here with
 * `Authorization: Bearer TIMER_SECRET` from Vault when a push job is queued;
 * the minute timer is the backstop. POST only (other methods answer 405).
 * Self-authenticating machine route outside the staff proxy; the response
 * carries counts only.
 */
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return handlePushRequest(request, productionPushRouteDeps());
}
